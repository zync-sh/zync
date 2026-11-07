//! Opaque, one-use approvals and document leases. Reservations remain counted
//! until the native task drops its SSH channel, including canceled starts.
use super::policy::{Launch, Size, MAX_DOCUMENTS, MAX_PER_RUNTIME, MAX_TERMINALS, OFFER_LIFETIME};
use crate::commands::AppState;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, Weak,
};
use std::time::Instant;
use tokio::sync::{mpsc, watch};

pub type SshHandle = tokio::sync::Mutex<Arc<russh::client::Handle<crate::ssh::Client>>>;

pub struct Owner {
    pub runtime: String,
    pub pane: String,
    pub connection: String,
    pub token: String,
    pub generation: u64,
    pub session: Weak<SshHandle>,
    pub binding_active: Arc<AtomicBool>,
    pub document_active: Arc<AtomicBool>,
}

impl Owner {
    pub fn live(&self) -> bool {
        self.binding_active.load(Ordering::Acquire) && self.document_active.load(Ordering::Acquire)
    }

    pub async fn connected(&self, state: &AppState) -> bool {
        let connections = state.connections.lock().await;
        self.live()
            && connections.get(&self.connection).is_some_and(|connection| {
                connection.reconnect_generation == self.generation
                    && connection.session.as_ref().is_some_and(|session| {
                        Weak::ptr_eq(&Arc::downgrade(session), &self.session)
                    })
            })
    }
}

#[derive(Clone)]
pub struct Controls {
    pub input: mpsc::Sender<Vec<u8>>,
    pub size: watch::Sender<Size>,
    pub ack: mpsc::Sender<u32>,
    pub cancel: watch::Sender<bool>,
    pub done: watch::Receiver<bool>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Offered,
    Approved,
    Starting,
    Running,
}

struct Entry {
    document: String,
    owner: Arc<Owner>,
    launch: Launch,
    phase: Phase,
    approval: Option<String>,
    expires: Instant,
    controls: Option<Controls>,
}

#[derive(Default)]
pub struct Registry {
    documents: HashMap<String, Arc<Owner>>,
    entries: HashMap<String, Entry>,
    registrations: HashMap<(String, String), String>,
    pub epoch: u64,
}

impl Registry {
    pub fn document(&self, id: &str) -> Result<Arc<Owner>, String> {
        self.documents
            .get(id)
            .filter(|owner| owner.live())
            .cloned()
            .ok_or("Terminal document is no longer active".into())
    }

    pub fn register(&mut self, owner: Arc<Owner>, epoch: u64) -> Result<String, String> {
        if self.epoch != epoch || !owner.live() {
            return Err("Terminal document changed during registration".into());
        }
        self.sweep(Instant::now());
        let old: Vec<_> = self
            .documents
            .iter()
            .filter(|(_, value)| value.runtime == owner.runtime && value.pane == owner.pane)
            .map(|(id, _)| id.clone())
            .collect();
        for id in old {
            self.dispose_document(&id);
        }
        if self.documents.len() >= MAX_DOCUMENTS {
            return Err("Terminal document limit reached".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.documents.insert(id.clone(), owner);
        Ok(id)
    }

    pub fn offer(
        &mut self,
        document: &str,
        launch: Launch,
        now: Instant,
    ) -> Result<String, String> {
        self.sweep(now);
        let owner = self.document(document)?;
        if launch.expected_connection_token != owner.token {
            return Err("Terminal connection changed".into());
        }
        if self.entries.len() >= MAX_TERMINALS
            || self
                .entries
                .values()
                .filter(|entry| entry.owner.runtime == owner.runtime)
                .count()
                >= MAX_PER_RUNTIME
            || self
                .entries
                .values()
                .any(|entry| entry.owner.runtime == owner.runtime && entry.owner.pane == owner.pane)
        {
            return Err("Terminal capacity reached for this pane or runtime".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.entries.insert(
            id.clone(),
            Entry {
                document: document.into(),
                owner,
                launch,
                phase: Phase::Offered,
                approval: None,
                expires: now + OFFER_LIFETIME,
                controls: None,
            },
        );
        Ok(id)
    }

    fn entry(&mut self, document: &str, id: &str, now: Instant) -> Result<&mut Entry, String> {
        self.sweep(now);
        self.document(document)?;
        self.entries
            .get_mut(id)
            .filter(|entry| entry.document == document && entry.owner.live())
            .ok_or("Terminal reservation is no longer active".into())
    }

    pub fn approve(&mut self, document: &str, id: &str, now: Instant) -> Result<String, String> {
        let entry = self.entry(document, id, now)?;
        if entry.phase != Phase::Offered {
            return Err("Terminal offer was already approved or consumed".into());
        }
        let token = uuid::Uuid::new_v4().to_string();
        entry.approval = Some(token.clone());
        entry.phase = Phase::Approved;
        // Confirmation must not extend the offer's lifetime indefinitely.
        Ok(token)
    }

    pub fn begin(
        &mut self,
        document: &str,
        id: &str,
        approval: &str,
        controls: Controls,
        now: Instant,
    ) -> Result<(Arc<Owner>, Launch), String> {
        let entry = self.entry(document, id, now)?;
        if entry.phase != Phase::Approved || entry.approval.as_deref() != Some(approval) {
            return Err("Terminal approval is invalid or already consumed".into());
        }
        entry.approval = None;
        entry.phase = Phase::Starting;
        entry.controls = Some(controls);
        Ok((entry.owner.clone(), entry.launch.clone()))
    }

    pub fn running(&mut self, id: &str) -> Result<(), String> {
        let entry = self.entries.get_mut(id).ok_or("Terminal was canceled")?;
        if !entry.owner.live()
            || entry
                .controls
                .as_ref()
                .is_some_and(|controls| *controls.cancel.borrow())
        {
            return Err("Terminal was canceled".into());
        }
        entry.phase = Phase::Running;
        Ok(())
    }

    pub fn controls(&self, document: &str, id: &str) -> Result<(Arc<Owner>, Controls), String> {
        self.document(document)?;
        let entry = self
            .entries
            .get(id)
            .filter(|entry| {
                entry.document == document && entry.phase == Phase::Running && entry.owner.live()
            })
            .ok_or("Terminal is not running".to_string())?;
        let controls = entry
            .controls
            .clone()
            .ok_or("Terminal controls unavailable")?;
        if *controls.cancel.borrow() {
            return Err("Terminal is closing".into());
        }
        Ok((entry.owner.clone(), controls))
    }

    /// Also closes pending offers. Close is idempotent, but foreign document IDs
    /// cannot close a replacement session, even if an old UI retained its ID.
    pub fn close(
        &mut self,
        document: &str,
        id: &str,
    ) -> Result<Option<watch::Receiver<bool>>, String> {
        let Some(entry) = self.entries.get(id) else {
            return Ok(None);
        };
        if entry.document != document {
            return Err("Terminal belongs to another document".into());
        }
        if let Some(controls) = &entry.controls {
            controls.cancel.send_replace(true);
            Ok(Some(controls.done.clone()))
        } else {
            self.entries.remove(id);
            Ok(None)
        }
    }

    pub fn finish(&mut self, id: &str) {
        self.entries.remove(id);
    }

    pub fn dispose_document(&mut self, id: &str) {
        if let Some(owner) = self.documents.remove(id) {
            owner.document_active.store(false, Ordering::Release);
        }
        self.sweep(Instant::now());
    }

    pub fn reset(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        for owner in self.documents.values() {
            owner.document_active.store(false, Ordering::Release);
        }
        self.documents.clear();
        self.registrations.clear();
        self.sweep(Instant::now());
    }

    pub fn sweep(&mut self, now: Instant) {
        self.documents.retain(|_, owner| owner.live());
        self.entries.retain(|_, entry| {
            let expired =
                matches!(entry.phase, Phase::Offered | Phase::Approved) && now >= entry.expires;
            if !entry.owner.live() || expired {
                if let Some(controls) = &entry.controls {
                    controls.cancel.send_replace(true);
                    true
                } else {
                    false
                }
            } else {
                true
            }
        });
    }
}

/// One registry for host surfaces, never a workspace PTY or plugin-owned xterm.
#[derive(Clone, Default)]
pub struct PluginTerminals(pub Arc<Mutex<Registry>>);

impl PluginTerminals {
    pub fn with<T>(
        &self,
        action: impl FnOnce(&mut Registry) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut registry = self.0.lock().map_err(|_| "Terminal service unavailable")?;
        action(&mut registry)
    }
    pub fn reset(&self) {
        let _ = self.with(|registry| {
            registry.reset();
            Ok(())
        });
    }
}

/// Reserve registration order before async disk work. An older iframe's delayed
/// registration can never replace the newer document that already registered.
pub struct DocumentRegistration {
    registry: PluginTerminals,
    key: (String, String),
    ticket: String,
    epoch: u64,
}

impl DocumentRegistration {
    pub fn reserve(registry: PluginTerminals, runtime: &str, pane: &str) -> Result<Self, String> {
        let key = (runtime.to_string(), pane.to_string());
        let ticket = uuid::Uuid::new_v4().to_string();
        let epoch = registry.with(|registry| {
            if !registry.registrations.contains_key(&key)
                && registry.registrations.len() >= MAX_DOCUMENTS
            {
                return Err("Pending terminal document limit reached".into());
            }
            registry.registrations.insert(key.clone(), ticket.clone());
            Ok(registry.epoch)
        })?;
        Ok(Self {
            registry,
            key,
            ticket,
            epoch,
        })
    }

    pub fn complete(self, owner: Arc<Owner>) -> Result<String, String> {
        self.registry.with(|registry| {
            if registry.registrations.get(&self.key) != Some(&self.ticket) {
                return Err("A newer terminal document replaced this registration".into());
            }
            registry.register(owner, self.epoch)
        })
    }
}

impl Drop for DocumentRegistration {
    fn drop(&mut self) {
        let _ = self.registry.with(|registry| {
            if registry.registrations.get(&self.key) == Some(&self.ticket) {
                registry.registrations.remove(&self.key);
            }
            Ok(())
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner(runtime: &str, pane: &str) -> Arc<Owner> {
        Arc::new(Owner {
            runtime: runtime.into(),
            pane: pane.into(),
            connection: "ssh".into(),
            token: "binding:1".into(),
            generation: 1,
            session: Weak::new(),
            binding_active: Arc::new(AtomicBool::new(true)),
            document_active: Arc::new(AtomicBool::new(true)),
        })
    }
    fn launch() -> Launch {
        Launch {
            program: "sh".into(),
            args: vec![],
            expected_connection_token: "binding:1".into(),
        }
    }
    fn controls() -> Controls {
        let (input, _input) = mpsc::channel(1);
        let (size, _) = watch::channel(Size { cols: 80, rows: 24 });
        let (ack, _ack) = mpsc::channel(1);
        let (cancel, _) = watch::channel(false);
        let (_done, done) = watch::channel(false);
        Controls {
            input,
            size,
            ack,
            cancel,
            done,
        }
    }

    #[test]
    fn approval_is_one_use_scoped_and_expiring() {
        let mut registry = Registry::default();
        let now = Instant::now();
        let document = registry.register(owner("runtime", "pane"), 0).unwrap();
        let other = registry.register(owner("runtime", "other"), 0).unwrap();
        let offer = registry.offer(&document, launch(), now).unwrap();
        assert!(registry
            .begin(&document, &offer, "invented", controls(), now)
            .is_err());
        assert!(registry.approve(&other, &offer, now).is_err());
        let approval = registry.approve(&document, &offer, now).unwrap();
        assert!(registry.approve(&document, &offer, now).is_err());
        assert!(registry
            .begin(&other, &offer, &approval, controls(), now)
            .is_err());
        registry
            .begin(&document, &offer, &approval, controls(), now)
            .unwrap();
        assert!(registry
            .begin(&document, &offer, &approval, controls(), now)
            .is_err());
        registry.finish(&offer);
        let expired = registry.offer(&document, launch(), now).unwrap();
        assert!(registry
            .approve(&document, &expired, now + OFFER_LIFETIME)
            .is_err());
        assert!(registry.entries.is_empty());
    }

    #[test]
    fn replacement_cancels_start_but_keeps_quota_until_cleanup() {
        let mut registry = Registry::default();
        let now = Instant::now();
        let old = registry.register(owner("runtime", "pane"), 0).unwrap();
        let offer = registry.offer(&old, launch(), now).unwrap();
        let approval = registry.approve(&old, &offer, now).unwrap();
        let controls = controls();
        registry
            .begin(&old, &offer, &approval, controls.clone(), now)
            .unwrap();
        let new = registry.register(owner("runtime", "pane"), 0).unwrap();
        assert!(*controls.cancel.borrow());
        assert!(registry.running(&offer).is_err());
        assert!(registry.offer(&new, launch(), now).is_err());
        assert!(registry.close(&new, &offer).is_err());
        registry.close(&old, &offer).unwrap();
        registry.finish(&offer);
        assert!(registry.offer(&new, launch(), now).is_ok());
    }

    #[test]
    fn binding_revocation_and_reload_invalidate_authority() {
        let mut registry = Registry::default();
        let owner = owner("runtime", "pane");
        let document = registry.register(owner.clone(), 0).unwrap();
        let offer = registry.offer(&document, launch(), Instant::now()).unwrap();
        owner.binding_active.store(false, Ordering::Release);
        registry.sweep(Instant::now());
        assert!(registry.document(&document).is_err());
        assert!(!registry.entries.contains_key(&offer));
        registry.reset();
        assert!(registry
            .register(super::tests::owner("runtime", "pane"), 0)
            .is_err());
        assert!(registry
            .register(super::tests::owner("runtime", "pane"), 1)
            .is_ok());
    }

    #[test]
    fn reservations_obey_total_runtime_and_pane_limits() {
        let mut registry = Registry::default();
        let now = Instant::now();
        let mut first = String::new();
        for index in 0..MAX_PER_RUNTIME {
            let document = registry
                .register(owner("a", &index.to_string()), 0)
                .unwrap();
            registry.offer(&document, launch(), now).unwrap();
            first = document;
        }
        assert!(registry.offer(&first, launch(), now).is_err());
        let extra = registry.register(owner("a", "extra"), 0).unwrap();
        assert!(registry.offer(&extra, launch(), now).is_err());
        for index in 0..MAX_PER_RUNTIME {
            let document = registry
                .register(owner("b", &index.to_string()), 0)
                .unwrap();
            registry.offer(&document, launch(), now).unwrap();
        }
        let extra = registry.register(owner("c", "extra"), 0).unwrap();
        assert!(registry.offer(&extra, launch(), now).is_err());
        registry.sweep(now + OFFER_LIFETIME);
        assert!(registry
            .offer(&extra, launch(), now + OFFER_LIFETIME)
            .is_ok());
    }

    #[test]
    fn canceled_running_session_rejects_controls_and_close_is_idempotent() {
        let mut registry = Registry::default();
        let now = Instant::now();
        let document = registry.register(owner("r", "p"), 0).unwrap();
        let offer = registry.offer(&document, launch(), now).unwrap();
        let approval = registry.approve(&document, &offer, now).unwrap();
        registry
            .begin(&document, &offer, &approval, controls(), now)
            .unwrap();
        registry.running(&offer).unwrap();
        assert!(registry.controls(&document, &offer).is_ok());
        registry.close(&document, &offer).unwrap();
        registry.close(&document, &offer).unwrap();
        assert!(registry.controls(&document, &offer).is_err());
        assert_eq!(registry.entries.len(), 1);
        registry.finish(&offer);
        assert!(registry.close(&document, &offer).unwrap().is_none());
    }

    #[test]
    fn document_store_and_connection_token_are_bounded() {
        let mut registry = Registry::default();
        for index in 0..MAX_DOCUMENTS {
            registry
                .register(owner("r", &index.to_string()), 0)
                .unwrap();
        }
        assert!(registry.register(owner("r", "excess"), 0).is_err());
        let document = registry.register(owner("r", "0"), 0).unwrap();
        assert!(registry
            .offer(
                &document,
                Launch {
                    expected_connection_token: "changed".into(),
                    ..launch()
                },
                Instant::now()
            )
            .is_err());
    }

    #[test]
    fn delayed_registration_cannot_replace_a_new_frame_or_survive_reload() {
        let registry = PluginTerminals::default();
        let old = DocumentRegistration::reserve(registry.clone(), "r", "p").unwrap();
        let new = DocumentRegistration::reserve(registry.clone(), "r", "p").unwrap();
        let document = new.complete(owner("r", "p")).unwrap();
        assert!(old.complete(owner("r", "p")).is_err());
        assert!(registry
            .with(|registry| registry.document(&document))
            .is_ok());
        let pending = DocumentRegistration::reserve(registry.clone(), "r", "p").unwrap();
        registry.reset();
        assert!(pending.complete(owner("r", "p")).is_err());
        assert!(registry
            .with(|registry| Ok(registry.registrations.is_empty()))
            .unwrap());
    }
}
