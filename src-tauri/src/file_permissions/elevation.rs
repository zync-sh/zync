//! Ephemeral, one-target SSH sudo review. No root SFTP, shell interpolation of
//! paths/passwords, installed helper, credential persistence or mutation replay.
//! The verified SSH owner supplies a live-session guard and existing file lease.

use super::{Binding, Metadata, Model, Outcome, OutcomeStatus, PermissionSnapshot};
use crate::file_transfers::{endpoint::Snapshot, DestinationLease};
use futures_util::future::BoxFuture;
use russh::{
    client::{Handle, Msg},
    Channel, ChannelMsg,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc, Mutex, Weak,
    },
};
use tokio::{
    sync::{mpsc, oneshot, watch, Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore},
    time::{timeout, timeout_at, Duration, Instant},
};
use zeroize::Zeroizing;

const MAX_FRAME: usize = 65_536;
const LIFETIME: Duration = Duration::from_secs(90);
const STARTING: u8 = 0;
const PASSWORD: u8 = 1;
const PREPARED: u8 = 2;
const BUSY: u8 = 3;
type LiveSession = Arc<AsyncMutex<Arc<Handle<crate::ssh::Client>>>>;
pub type Guard = Arc<dyn Fn() -> BoxFuture<'static, Result<(), String>> + Send + Sync>;
type Answer = oneshot::Sender<Result<Reply, String>>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    challenge_id: String,
    review_token: Option<String>,
    status: &'static str,
    metadata: Option<Metadata>,
    outcome: Option<Outcome>,
}

// Intentionally no Debug: secrets never belong in diagnostics.
enum Action {
    Authenticate(Zeroizing<String>, Answer),
    Apply(u32, u32, String, Answer),
}

struct Pending {
    connection: String,
    actions: mpsc::Sender<Action>,
    cancel: watch::Sender<bool>,
    phase: Arc<AtomicU8>,
    review_token: String,
    deadline: Instant,
}

pub struct Service {
    pending: Mutex<HashMap<String, Pending>>,
    opening: Arc<Opens<crate::ssh::Client>>,
}

impl Default for Service {
    fn default() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            opening: Arc::new(Opens::default()),
        }
    }
}

impl Service {
    /// At most two live requests globally and one per connection. The root
    /// descriptor and destination lease live only until completion/cancel/expiry.
    pub async fn start(
        self: &Arc<Self>,
        connection: String,
        binding: Binding,
        path: String,
        session: LiveSession,
        guard: Guard,
        lease: DestinationLease,
    ) -> Result<Reply, String> {
        let opening = self.opening.acquire(&session)?;
        let id = uuid::Uuid::new_v4().simple().to_string();
        let review_token = uuid::Uuid::new_v4().simple().to_string();
        let (actions, receiver) = mpsc::channel(1);
        let (cancel, cancelled) = watch::channel(false);
        let phase = Arc::new(AtomicU8::new(STARTING));
        let deadline = Instant::now() + LIFETIME;
        {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| "Administrator edit unavailable")?;
            if pending.len() >= 2 || pending.values().any(|entry| entry.connection == connection) {
                return Err(
                    "An administrator review is already open. Close it before starting another."
                        .into(),
                );
            }
            pending.insert(
                id.clone(),
                Pending {
                    connection,
                    actions,
                    cancel,
                    phase: phase.clone(),
                    review_token: review_token.clone(),
                    deadline,
                },
            );
        }
        let (sender, answer) = oneshot::channel();
        let owner = self.clone();
        tokio::spawn(async move {
            let _lease = lease;
            // Keep the channel outside the timed future: russh does not close it
            // on Drop, including while sudo waits before Python's alarm starts.
            let mut wire = None;
            // Also bound non-I/O waits (e.g. connection-owner lock contention).
            let _ = timeout_at(
                deadline,
                run(
                    &id,
                    binding,
                    path,
                    session,
                    guard,
                    receiver,
                    cancelled,
                    phase,
                    &review_token,
                    sender,
                    deadline,
                    &mut wire,
                    opening,
                ),
            )
            .await;
            if let Some(wire) = wire {
                let _ = timeout(Duration::from_secs(1), async {
                    let _ = wire.channel.eof().await;
                    wire.channel.close().await
                })
                .await;
            }
            if let Ok(mut pending) = owner.pending.lock() {
                pending.remove(&id);
            }
        });
        answer
            .await
            .map_err(|_| "Administrator review ended before it was ready".to_string())?
    }

    async fn send(
        &self,
        id: &str,
        action: Action,
        answer: oneshot::Receiver<Result<Reply, String>>,
    ) -> Result<Reply, String> {
        {
            let pending = self
                .pending
                .lock()
                .map_err(|_| "Administrator edit unavailable")?;
            let entry = pending
                .get(id)
                .ok_or("Administrator review expired. Refresh permissions before trying again.")?;
            if *entry.cancel.borrow() || Instant::now() >= entry.deadline {
                return Err("Administrator review was cancelled or expired".into());
            }
            if let Action::Apply(_, _, token, _) = &action {
                if token != &entry.review_token {
                    return Err("Apply requires the returned administrator review token".into());
                }
            }
            claim_action(&entry.phase, &action)?;
            entry
                .actions
                .try_send(action)
                .map_err(|_| "Administrator review is busy or expired")?;
        }
        answer.await.map_err(|_| "Administrator review ended. Refresh permissions; do not assume a submitted change failed.".to_string())?
    }

    pub async fn authenticate(
        &self,
        id: &str,
        password: Zeroizing<String>,
    ) -> Result<Reply, String> {
        if password.is_empty() || password.len() > 4096 || password.contains(['\r', '\n', '\0']) {
            return Err("Enter one bounded password without line breaks.".into());
        }
        let (sender, answer) = oneshot::channel();
        self.send(id, Action::Authenticate(password, sender), answer)
            .await
    }

    pub async fn apply(
        &self,
        id: &str,
        review_token: String,
        set: u32,
        clear: u32,
    ) -> Result<Reply, String> {
        super::changed_mode(0, set, clear)?;
        let (sender, answer) = oneshot::channel();
        self.send(id, Action::Apply(set, clear, review_token, sender), answer)
            .await
    }

    /// Closing review is safe before Apply. After dispatch it is not rollback;
    /// the actor finishes its bounded acknowledgement/readback independently.
    pub fn cancel(&self, id: &str) {
        if let Ok(pending) = self.pending.lock() {
            if let Some(entry) = pending.get(id) {
                entry.cancel.send_replace(true);
            }
        }
    }
}

fn claim_action(phase: &AtomicU8, action: &Action) -> Result<(), String> {
    let expected = match action {
        Action::Authenticate(..) => PASSWORD,
        Action::Apply(..) => PREPARED,
    };
    phase
        .compare_exchange(expected, BUSY, Ordering::AcqRel, Ordering::Acquire)
        .map(|_| ())
        .map_err(|_| "Administrator review is busy, expired, or not ready for this action".into())
}

/// Static program and random native nonce only. User paths/modes go in JSON on
/// stdin; a password is sent once, only after the exact sudo stderr prompt.
fn command(nonce: &str) -> String {
    let code = include_str!("privileged_linux.py").replace('\'', "'\\''");
    format!("/usr/bin/sudo -S -u root -p 'ZYNC-SUDO-{nonce}:' -- /usr/bin/python3 -I -S -c '{code}' {nonce}")
}

struct Wire {
    channel: Channel<Msg>,
    output: Output,
    deadline: Instant,
}

struct Output {
    nonce: String,
    stdout: Zeroizing<Vec<u8>>,
    stderr: Zeroizing<Vec<u8>>,
    total: usize,
    prompts: usize,
}

enum Event {
    Prompt,
    Frame(serde_json::Value),
}

impl Output {
    fn new(nonce: &str) -> Self {
        Self {
            nonce: nonce.into(),
            stdout: Zeroizing::new(Vec::new()),
            stderr: Zeroizing::new(Vec::new()),
            total: 0,
            prompts: 0,
        }
    }

    fn feed(&mut self, stderr: bool, data: &[u8]) -> Result<(), String> {
        let buffer = if stderr {
            &mut self.stderr
        } else {
            &mut self.stdout
        };
        if data.len() > MAX_FRAME.saturating_sub(buffer.len())
            || data.len() > (MAX_FRAME * 4).saturating_sub(self.total)
        {
            return Err("Administrator output exceeded its safety limit".into());
        }
        self.total += data.len();
        buffer.extend_from_slice(data);
        Ok(())
    }

    fn event(&mut self) -> Result<Option<Event>, String> {
        if let Some(end) = self.stdout.iter().position(|byte| *byte == b'\n') {
            let line = Zeroizing::new(self.stdout.drain(..=end).collect::<Vec<_>>());
            let frame: serde_json::Value =
                serde_json::from_slice(&line).map_err(|_| "Unsupported administrator protocol")?;
            if frame.get("protocol").and_then(|v| v.as_u64()) != Some(1)
                || frame.get("nonce").and_then(|v| v.as_str()) != Some(self.nonce.as_str())
            {
                return Err("Unsupported administrator protocol".into());
            }
            return Ok(Some(Event::Frame(frame)));
        }
        let prompt = format!("ZYNC-SUDO-{}:", self.nonce);
        if let Some(start) = self
            .stderr
            .windows(prompt.len())
            .position(|bytes| bytes == prompt.as_bytes())
        {
            self.stderr.drain(..start + prompt.len());
            self.prompts += 1;
            if self.prompts > 1 {
                return Err("Sudo authentication was not accepted. No password was replayed. MFA/TTY prompts are not supported.".into());
            }
            return Ok(Some(Event::Prompt));
        }
        Ok(None)
    }
}

impl Wire {
    async fn send(&self, value: serde_json::Value) -> Result<(), String> {
        let mut data = serde_json::to_vec(&value).map_err(|_| "Invalid administrator request")?;
        data.push(b'\n');
        if data.len() > MAX_FRAME {
            return Err("Administrator request is too large".into());
        }
        if Instant::now() >= self.deadline {
            return Err("Administrator review expired".into());
        }
        timeout_at(self.deadline, self.channel.data(data.as_slice()))
            .await
            .map_err(|_| "Administrator review expired")?
            .map_err(|_| "Administrator channel closed".to_string())
    }

    /// No raw stderr/stdout leaves this owner. Even a hostile server cannot
    /// reflect a submitted password into a toast, history entry or error log.
    async fn next(&mut self) -> Result<Event, String> {
        loop {
            if let Some(event) = self.output.event()? {
                return Ok(event);
            }
            let message = timeout_at(self.deadline, self.channel.wait())
                .await
                .map_err(|_| "Administrator review expired")?
                .ok_or("Administrator channel closed")?;
            match message {
                ChannelMsg::Data { data } => {
                    self.output.feed(false, &data)?;
                }
                ChannelMsg::ExtendedData { data, .. } => {
                    self.output.feed(true, &data)?;
                }
                ChannelMsg::Eof | ChannelMsg::Close | ChannelMsg::ExitStatus { .. } => {
                    return Err("Sudo/Python operation unavailable or authentication denied. Requires existing Python 3, Linux 6.6+, a supported local filesystem and sudo policy permitting this operation; MFA/TTY workflows are unsupported.".into());
                }
                _ => continue,
            }
        }
    }

    async fn frame(&mut self, kind: &str) -> Result<serde_json::Value, String> {
        match self.next().await? {
            Event::Frame(value) if value.get("type").and_then(|v| v.as_str()) == Some(kind) => Ok(value),
            _ => Err("Administrator operation refused or returned an unsupported response. Refresh before retrying.".into()),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RootMetadata {
    path: String,
    canonical_parent: String,
    #[serde(with = "PermissionSnapshot")]
    snapshot: Snapshot,
    uid: u32,
    gid: u32,
    link_count: u64,
    object_identity: String,
}

#[derive(Clone)]
struct Prepared {
    data: Metadata,
    identity: String,
}

fn metadata(value: serde_json::Value, path: &str, binding: &Binding) -> Result<Prepared, String> {
    let root: RootMetadata =
        serde_json::from_value(value).map_err(|_| "Invalid administrator metadata")?;
    use crate::file_transfers::endpoint::EntryKind;
    if root.path != path
        || root.object_identity.is_empty()
        || root.object_identity.len() > 512
        || !matches!(root.snapshot.kind, EntryKind::File | EntryKind::Directory)
        || root.snapshot.mode.is_none()
        || root.canonical_parent
            != path
                .rsplit_once('/')
                .map(|v| if v.0.is_empty() { "/" } else { v.0 })
                .unwrap_or("")
    {
        return Err("Administrator target did not match the requested host path".into());
    }
    Ok(Prepared {
        identity: root.object_identity,
        data: Metadata {
            binding: Binding {
                model: Model::Posix,
                ..binding.clone()
            },
            path: root.path,
            canonical_parent: root.canonical_parent,
            snapshot: root.snapshot,
            uid: Some(root.uid),
            gid: Some(root.gid),
            link_count: Some(root.link_count),
            read_only: None,
            write_access: None,
            system_editor: false,
            local_identity: None,
            edit_unavailable: None,
        },
    })
}

async fn prepare(wire: &mut Wire, path: &str, binding: &Binding) -> Result<Prepared, String> {
    wire.send(serde_json::json!({ "protocol": 1, "nonce": wire.output.nonce, "type": "prepare", "path": path })).await?;
    let value = wire.frame("prepared").await?;
    metadata(
        value.get("metadata").cloned().unwrap_or_default(),
        path,
        binding,
    )
}

async fn wait_action(
    receiver: &mut mpsc::Receiver<Action>,
    cancel: &mut watch::Receiver<bool>,
    deadline: Instant,
) -> Option<Action> {
    if *cancel.borrow() || Instant::now() >= deadline {
        return None;
    }
    let action = tokio::select! {
        action = receiver.recv() => action,
        _ = cancel.changed() => None,
        _ = tokio::time::sleep_until(deadline) => None,
    };
    if *cancel.borrow() || Instant::now() >= deadline {
        None
    } else {
        action
    }
}

async fn run(
    id: &str,
    binding: Binding,
    path: String,
    session: LiveSession,
    guard: Guard,
    mut receiver: mpsc::Receiver<Action>,
    mut cancel: watch::Receiver<bool>,
    phase: Arc<AtomicU8>,
    review_token: &str,
    initial: Answer,
    deadline: Instant,
    slot: &mut Option<Wire>,
    opening: Opening<crate::ssh::Client>,
) {
    let opened = timeout(Duration::from_secs(10), async {
        guard().await?;
        let channel =
            open_channel(session, opening, Instant::now() + Duration::from_secs(12)).await?;
        Ok::<_, String>(channel)
    })
    .await;
    let channel = match opened {
        Ok(Ok(channel)) => channel,
        _ => {
            let _ = initial.send(Err(
                "Administrator channel could not be started on this session".into(),
            ));
            return;
        }
    };
    *slot = Some(Wire {
        channel,
        output: Output::new(id),
        deadline,
    });
    let wire = slot.as_mut().expect("channel owner was just installed");
    if !matches!(
        timeout(
            Duration::from_secs(10),
            wire.channel.exec(true, command(id))
        )
        .await,
        Ok(Ok(()))
    ) {
        let _ = initial.send(Err("Sudo could not be started on this SSH channel".into()));
        return;
    }
    let reply = |status, metadata, outcome| Reply {
        challenge_id: id.into(),
        review_token: if status == "prepared" {
            Some(review_token.into())
        } else {
            None
        },
        status,
        metadata,
        outcome,
    };
    let first = tokio::select! {
        event = timeout(Duration::from_secs(10), wire.next()) => event.unwrap_or_else(|_| Err("Sudo did not become ready".into())),
        _ = cancel.changed() => Err("Administrator review cancelled".into())
    };
    let prepared = match first {
        Ok(Event::Prompt) => {
            phase.store(PASSWORD, Ordering::Release);
            if initial.send(Ok(reply("password", None, None))).is_err() {
                None
            } else if let Some(Action::Authenticate(password, answer)) =
                wait_action(&mut receiver, &mut cancel, deadline).await
            {
                let result = async {
                    guard().await?;
                    pre_dispatch(deadline, &cancel)?;
                    let mut bytes = Zeroizing::new(password.as_bytes().to_vec());
                    bytes.push(b'\n');
                    // Never send JSON until the root program, not sudo, owns stdin.
                    timeout_at(deadline, wire.channel.data(bytes.as_slice()))
                        .await
                        .map_err(|_| "Administrator authentication expired")?
                        .map_err(|_| "Administrator channel closed")?;
                    drop(bytes);
                    drop(password);
                    wire.frame("ready").await?;
                    guard().await?;
                    pre_dispatch(deadline, &cancel)?;
                    prepare(wire, &path, &binding).await
                }
                .await;
                let success = result.is_ok();
                let value = result.as_ref().ok().cloned();
                if success {
                    phase.store(PREPARED, Ordering::Release);
                }
                let _ = answer
                    .send(result.map(|prepared| reply("prepared", Some(prepared.data), None)));
                if success {
                    value
                } else {
                    None
                }
            } else {
                None
            }
        }
        Ok(Event::Frame(frame)) if frame.get("type").and_then(|v| v.as_str()) == Some("ready") => {
            let result = async {
                guard().await?;
                pre_dispatch(deadline, &cancel)?;
                prepare(wire, &path, &binding).await
            }
            .await;
            let value = result.as_ref().ok().cloned();
            if value.is_some() {
                phase.store(PREPARED, Ordering::Release);
            }
            if initial
                .send(result.map(|prepared| reply("prepared", Some(prepared.data), None)))
                .is_err()
            {
                None
            } else {
                value
            }
        }
        _ => {
            let _ = initial.send(Err("Sudo/Python is unavailable or authentication was refused. Requires existing Python 3, Linux 6.6+ and compatible sudo policy.".into()));
            None
        }
    };
    if let Some(before) = prepared {
        if let Some(Action::Apply(set, clear, _, answer)) =
            wait_action(&mut receiver, &mut cancel, deadline).await
        {
            let result = async {
                guard().await?;
                pre_dispatch(deadline, &cancel)
            }
            .await;
            if let Err(error) = result {
                let _ = answer.send(Err(error));
            } else {
                // From dispatch onwards all transport/protocol failures are unknown.
                // Cancelling/closing the UI cannot claim rollback or replay chmod.
                let outcome = async {
                    wire.send(serde_json::json!({ "protocol": 1, "nonce": id, "type": "apply", "setBits": set, "clearBits": clear })).await?;
                    let value = wire.frame("result").await?;
                    guard().await?;
                    let status = match value.get("status").and_then(|v| v.as_str()) {
                        Some("verified") => OutcomeStatus::Verified,
                        Some("adjusted") => OutcomeStatus::Adjusted,
                        Some("appliedUnverified") => OutcomeStatus::AppliedUnverified,
                        Some("rejected") => OutcomeStatus::Rejected,
                        Some("unknown") => OutcomeStatus::Unknown,
                        _ => return Err("Invalid administrator result".into()),
                    };
                    let data = if matches!(status, OutcomeStatus::Verified | OutcomeStatus::Adjusted) {
                        let after = metadata(value.get("metadata").cloned().unwrap_or_default(), &path, &binding)?;
                        validate_result(&before, &after, set, clear, &status)?;
                        Some(after.data)
                    } else { None };
                    let message = match status {
                        OutcomeStatus::Verified => "Administrator mode change verified. Refresh to return to ordinary-account permissions.",
                        OutcomeStatus::Adjusted => "The filesystem adjusted the requested administrator mode. Review the reported mode, then Refresh.",
                        OutcomeStatus::Rejected => "The filesystem refused the administrator mode change. Refresh before another attempt.",
                        OutcomeStatus::AppliedUnverified => "Administrator change was acknowledged, but current mode could not be verified. Inspect the host path before retrying.",
                        OutcomeStatus::Unknown => "Administrator outcome is unknown. Inspect the host path before retrying; no change was replayed.",
                    };
                    Ok::<_, String>(Outcome { status, metadata: data, message: message.into() })
                }.await.unwrap_or_else(|_| Outcome { status: OutcomeStatus::Unknown, metadata: None,
                    message: "The administrator result could not be verified. Refresh and inspect the host path before retrying. No change was replayed or rolled back.".into() });
                let _ = answer.send(Ok(reply("finished", None, Some(outcome))));
            }
        }
    }
}

/// russh cannot close an unconfirmed channel. Keep a finite late-confirmation
/// grace, then free the shared mutex/capacity and disable only administrator
/// retries on this exact transport. A pre-exec idle channel may remain until the
/// transport closes; never strand a root process, replay or disconnect a healthy
/// shared transport to hide that underlying library limitation.
async fn open_channel<H: russh::client::Handler + 'static>(
    session: Arc<AsyncMutex<Arc<Handle<H>>>>,
    opening: Opening<H>,
    deadline: Instant,
) -> Result<Channel<Msg>, String> {
    let (sender, answer) = oneshot::channel();
    tokio::spawn(async move {
        let _opening = opening;
        let result = match timeout_at(deadline, session.lock()).await {
            Err(_) => Err("SSH connection is busy; no administrator channel was requested".into()),
            Ok(_) if Instant::now() >= deadline => {
                Err("SSH connection is busy; no administrator channel was requested".into())
            }
            Ok(handle) => {
                // A preceding opener may have disabled this transport while we
                // waited for its mutex. Recheck before sending another request.
                if let Err(error) = _opening.gate.allowed(&session) {
                    Err(error)
                } else {
                    match timeout_at(deadline, handle.channel_open_session()).await {
                        Ok(result) => {
                            result.map_err(|_| "Could not open administrator channel".to_string())
                        }
                        Err(_) => {
                            _opening.gate.block(&session);
                            Err("SSH did not confirm a command channel. Administrator edits are disabled on this transport; reconnect before trying again. No sudo command was sent.".into())
                        }
                    }
                }
            }
        };
        // The queued reply owns cleanup too: send can succeed just before the
        // caller drops an unpolled oneshot receiver on timeout.
        let _ = sender.send(result.map(|channel| Opened {
            channel: Some(channel),
            opening: Some(_opening),
        }));
    });
    answer
        .await
        .map_err(|_| "Administrator channel owner ended".to_string())?
        .map(Opened::take)
}

struct Opened<H: russh::client::Handler + 'static> {
    channel: Option<Channel<Msg>>,
    opening: Option<Opening<H>>,
}

impl<H: russh::client::Handler + 'static> Opened<H> {
    fn take(mut self) -> Channel<Msg> {
        self.channel
            .take()
            .expect("confirmed channel is consumed once")
    }
}

impl<H: russh::client::Handler + 'static> Drop for Opened<H> {
    fn drop(&mut self) {
        if let Some(channel) = self.channel.take() {
            let opening = self.opening.take();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _opening = opening;
                    let _ = timeout(Duration::from_secs(1), async {
                        let _ = channel.eof().await;
                        channel.close().await
                    })
                    .await;
                });
            }
        }
    }
}

struct Opens<H: russh::client::Handler> {
    capacity: Arc<Semaphore>,
    blocked: Mutex<Vec<Weak<AsyncMutex<Arc<Handle<H>>>>>>,
}

impl<H: russh::client::Handler> Default for Opens<H> {
    fn default() -> Self {
        Self {
            capacity: Arc::new(Semaphore::new(2)),
            blocked: Mutex::new(Vec::new()),
        }
    }
}

struct Opening<H: russh::client::Handler> {
    gate: Arc<Opens<H>>,
    _permit: OwnedSemaphorePermit,
}

impl<H: russh::client::Handler> Opens<H> {
    fn acquire(
        self: &Arc<Self>,
        session: &Arc<AsyncMutex<Arc<Handle<H>>>>,
    ) -> Result<Opening<H>, String> {
        self.allowed(session)?;
        let permit = self.capacity.clone().try_acquire_owned().map_err(|_| {
            "Administrator channels are still opening or closing. Wait before retrying."
        })?;
        Ok(Opening {
            gate: self.clone(),
            _permit: permit,
        })
    }

    fn allowed(&self, session: &Arc<AsyncMutex<Arc<Handle<H>>>>) -> Result<(), String> {
        let mut blocked = self
            .blocked
            .lock()
            .map_err(|_| "Administrator channel admission unavailable")?;
        blocked.retain(|entry| entry.strong_count() > 0);
        if blocked
            .iter()
            .any(|entry| std::ptr::eq(entry.as_ptr(), Arc::as_ptr(session)))
        {
            return Err("Administrator edits are disabled after an unconfirmed channel open. Reconnect this SSH transport before retrying; refreshing SFTP alone is not enough.".into());
        }
        Ok(())
    }

    fn block(&self, session: &Arc<AsyncMutex<Arc<Handle<H>>>>) {
        if let Ok(mut blocked) = self.blocked.lock() {
            blocked.push(Arc::downgrade(session));
        }
    }
}

fn pre_dispatch(deadline: Instant, cancel: &watch::Receiver<bool>) -> Result<(), String> {
    if *cancel.borrow() || Instant::now() >= deadline {
        Err("Administrator review was cancelled or expired".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
#[path = "elevation_tests.rs"]
mod tests;

fn validate_result(
    before: &Prepared,
    after: &Prepared,
    set: u32,
    clear: u32,
    status: &OutcomeStatus,
) -> Result<(), String> {
    let requested = super::changed_mode(
        before.data.snapshot.mode.ok_or("Missing reviewed mode")?,
        set,
        clear,
    )?;
    let observed = after.data.snapshot.mode.ok_or("Missing reported mode")?;
    if before.identity != after.identity
        || before.data.snapshot.kind != after.data.snapshot.kind
        || before.data.snapshot.size != after.data.snapshot.size
        || before.data.snapshot.modified != after.data.snapshot.modified
        || before.data.uid != after.data.uid
        || before.data.gid != after.data.gid
        || before.data.link_count != after.data.link_count
        || before.data.snapshot.mode.unwrap() & !0o7777 != observed & !0o7777
        || ((*status == OutcomeStatus::Verified) != (observed & 0o7777 == requested))
    {
        return Err("Administrator result did not match reviewed object and requested mode".into());
    }
    Ok(())
}
