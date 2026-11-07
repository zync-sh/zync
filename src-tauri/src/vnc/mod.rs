//! Main-window VNC sessions with one local viewer over SSH or direct TCP.

mod bridge;
mod direct;
mod vault_auth;

#[cfg(test)]
mod tests;

use crate::commands::{AppState, ConnectionHandle};
use bridge::{accept_viewer, relay, Offer};
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    net::Ipv4Addr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, Weak,
    },
    time::{Duration, Instant},
};
use tauri::{Manager, State, WebviewWindow};
use tokio::{
    net::TcpListener,
    sync::{watch, Mutex as AsyncMutex},
    time::{interval, sleep, timeout, MissedTickBehavior},
};
use uuid::Uuid;

const MAX_SESSIONS: usize = 4;
const MAX_EARLY_STOPS: usize = 32;
const EARLY_STOP_LIFETIME: Duration = Duration::from_secs(30);
const OPEN_TIMEOUT: Duration = Duration::from_secs(5);
const BINDING_CHECK_INTERVAL: Duration = Duration::from_secs(1);
const NOT_CONNECTED: &str = "Connect to this SSH host before opening VNC.";
const CANCELLED: &str = "VNC start was cancelled.";
const OPEN_TIMED_OUT: &str = "Timed out opening the VNC port through SSH.";

type SshHandle = AsyncMutex<Arc<russh::client::Handle<crate::ssh::Client>>>;
type Connections = AsyncMutex<HashMap<String, ConnectionHandle>>;

#[derive(Default)]
struct Registry {
    active: HashMap<Uuid, watch::Sender<bool>>,
    early_stops: VecDeque<(Uuid, Instant)>,
}

/// Owns pending and live viewer sessions across Tauri command calls.
#[derive(Clone, Default)]
pub struct VncSessions(Arc<Mutex<Registry>>);

impl VncSessions {
    /// Reserve a slot before awaiting admission so a concurrent stop can cancel the start.
    fn reserve(&self, id: Uuid) -> Result<Lease, &'static str> {
        let mut registry = self.0.lock().unwrap();
        registry
            .early_stops
            .retain(|(_, stopped)| stopped.elapsed() < EARLY_STOP_LIFETIME);
        if registry
            .early_stops
            .iter()
            .any(|(stopped, _)| *stopped == id)
        {
            return Err(CANCELLED);
        }
        if registry.active.len() >= MAX_SESSIONS || registry.active.contains_key(&id) {
            return Err("VNC viewer limit reached or the attempt is already active.");
        }
        let (cancel, cancelled) = watch::channel(false);
        registry.active.insert(id, cancel);
        Ok(Lease {
            id,
            sessions: self.clone(),
            cancelled,
        })
    }

    /// Stop a live session or remember a stop that overtook the asynchronous start command.
    fn stop(&self, id: Uuid) {
        let mut registry = self.0.lock().unwrap();
        if let Some(cancel) = registry.active.get(&id) {
            cancel.send_replace(true);
        }
        registry
            .early_stops
            .retain(|(stopped, since)| *stopped != id && since.elapsed() < EARLY_STOP_LIFETIME);
        if registry.early_stops.len() == MAX_EARLY_STOPS {
            registry.early_stops.pop_front();
        }
        registry.early_stops.push_back((id, Instant::now()));
    }

    /// Retire every viewer and its transport when the main renderer reloads or closes.
    pub fn cancel_all(&self) {
        for cancel in self.0.lock().unwrap().active.values() {
            cancel.send_replace(true);
        }
    }
}

struct Lease {
    id: Uuid,
    sessions: VncSessions,
    cancelled: watch::Receiver<bool>,
}

impl Lease {
    /// A stop sent before this wait begins remains observable.
    async fn wait_cancelled(&mut self) {
        let _ = self.cancelled.wait_for(|cancelled| *cancelled).await;
    }
}

impl Drop for Lease {
    /// Release capacity after the listener and any established transport are dropped.
    fn drop(&mut self) {
        self.sessions.0.lock().unwrap().active.remove(&self.id);
    }
}

struct Binding {
    connection_id: String,
    generation: u64,
    session: Weak<SshHandle>,
}

impl Binding {
    /// A saved host alone is insufficient. Capture the exact live transport and its generation.
    async fn capture(
        connections: &Connections,
        connection_id: String,
    ) -> Result<Self, &'static str> {
        let connections = connections.lock().await;
        let connection = connections.get(&connection_id).ok_or(NOT_CONNECTED)?;
        let session = connection.session.as_ref().ok_or(NOT_CONNECTED)?;
        if session.try_lock().is_ok_and(|handle| handle.is_closed()) {
            return Err(NOT_CONNECTED);
        }
        Ok(Self {
            connection_id,
            generation: connection.reconnect_generation,
            session: Arc::downgrade(session),
        })
    }

    /// Require both the captured generation and the original allocation, even if an ID is reused.
    async fn current(&self, connections: &Connections) -> bool {
        let connections = connections.lock().await;
        connections
            .get(&self.connection_id)
            .is_some_and(|connection| {
                connection.reconnect_generation == self.generation
                    && connection.session.as_ref().is_some_and(|session| {
                        self.session.ptr_eq(&Arc::downgrade(session))
                            && !session.try_lock().is_ok_and(|handle| handle.is_closed())
                    })
            })
    }

    /// An idle desktop has no socket activity to detect a removed or replaced SSH binding.
    async fn wait_invalid(&self, connections: &Connections) {
        let mut checks = interval(BINDING_CHECK_INTERVAL);
        checks.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            checks.tick().await;
            if !self.current(connections).await {
                return;
            }
        }
    }

    /// Open only remote loopback; retain the reply without holding the shared session mutex.
    async fn open(
        &self,
        port: u16,
        requested: &AtomicBool,
    ) -> Result<russh::ChannelStream<russh::client::Msg>, &'static str> {
        let session = self.session.upgrade().ok_or(NOT_CONNECTED)?;
        let handle = session.lock().await.clone();
        requested.store(true, Ordering::Relaxed);
        handle
            .channel_open_direct_tcpip("127.0.0.1", port.into(), "127.0.0.1", 0)
            .await
            .map(|channel| channel.into_stream())
            .map_err(|_| "Could not open the VNC port through SSH.")
    }
}

/// Browser Origin serializations for the packaged app and the configured development app.
fn trusted_origin(url: &url::Url, dev_url: Option<&url::Url>) -> Option<String> {
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    if url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none() {
        return Some("tauri://localhost".into());
    }
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let origin = url.origin();
    let serialized = origin.ascii_serialization();
    if matches!(
        serialized.as_str(),
        "http://tauri.localhost" | "https://tauri.localhost"
    ) || dev_url.is_some_and(|expected| expected.origin() == origin && origin.is_tuple())
    {
        return Some(serialized);
    }
    None
}

/// Restrict bridge lifecycle controls to the primary desktop webview.
fn main_window(window: &WebviewWindow) -> Result<(), &'static str> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("VNC is available only in the main window.")
    }
}

/// One attempt's ephemeral browser endpoint. The URL must not be saved or logged.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VncAdmission {
    session_id: String,
    websocket_url: String,
}

enum Target {
    Ssh {
        connections: Arc<Connections>,
        binding: Binding,
        port: u16,
    },
    Direct {
        endpoint: direct::Endpoint,
        vault_link: Option<vault_auth::VaultLink>,
    },
}

/// Reject port zero before reserving a viewer or opening a socket.
fn validate_port(port: u16) -> Result<(), &'static str> {
    if port == 0 {
        return Err("Enter a VNC port between 1 and 65535.");
    }
    Ok(())
}

/// Admit one short-lived local viewer offer without connecting to the VNC server yet.
#[tauri::command]
pub async fn vnc_start(
    window: WebviewWindow,
    state: State<'_, AppState>,
    sessions: State<'_, VncSessions>,
    session_id: String,
    connection_id: String,
    port: u16,
) -> Result<VncAdmission, String> {
    main_window(&window)?;
    if connection_id == "local" {
        return Err(NOT_CONNECTED.into());
    }
    validate_port(port)?;
    let connections = state.connections.clone();
    admit(&window, &sessions, session_id, async move {
        let binding = Binding::capture(&connections, connection_id).await?;
        Ok(Target::Ssh {
            connections,
            binding,
            port,
        })
    })
    .await
}

/// Admit a standalone viewer. Only the authorized local upgrade can trigger a direct TCP dial.
#[tauri::command]
pub async fn vnc_start_direct(
    window: WebviewWindow,
    sessions: State<'_, VncSessions>,
    session_id: String,
    host: String,
    port: u16,
    profile_id: Option<String>,
) -> Result<VncAdmission, String> {
    main_window(&window)?;
    validate_port(port)?;
    let endpoint = direct::Endpoint::parse(&host, port)?;
    let app = window.app_handle().clone();
    admit(&window, &sessions, session_id, async move {
        let vault_link = profile_id.and_then(|id| endpoint.vault_link(app, id));
        Ok(Target::Direct {
            endpoint,
            vault_link,
        })
    })
    .await
}

/// Share the trusted origin, one-use offer, and admission limits across both transports.
async fn admit(
    window: &WebviewWindow,
    sessions: &VncSessions,
    session_id: String,
    prepare: impl Future<Output = Result<Target, &'static str>>,
) -> Result<VncAdmission, String> {
    let id = Uuid::parse_str(&session_id).map_err(|_| "Invalid VNC session ID.")?;
    let mut lease = sessions.reserve(id)?;
    let url = window
        .url()
        .map_err(|_| "Could not verify the VNC viewer origin.")?;
    let dev_url = if tauri::is_dev() {
        window.app_handle().config().build.dev_url.as_ref()
    } else {
        None
    };
    let origin = trusted_origin(&url, dev_url).ok_or("Untrusted VNC viewer origin.")?;
    let (target, listener) = tokio::select! {
        biased;
        _ = lease.wait_cancelled() => return Err(CANCELLED.into()),
        result = timeout(OPEN_TIMEOUT, async {
            let target = prepare.await?;
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
                .await
                .map_err(|_| "Could not create the local VNC listener.")?;
            Ok::<_, &'static str>((target, listener))
        }) => result.map_err(|_| "Timed out starting the local VNC viewer.")??,
    };
    let address = listener
        .local_addr()
        .map_err(|_| "Could not read the local VNC listener address.")?;
    let offer = Offer::new(address, origin);
    let websocket_url = offer.websocket_url();
    tauri::async_runtime::spawn(async move {
        let result = match target {
            Target::Ssh {
                connections,
                binding,
                port,
            } => run(listener, offer, &connections, binding, lease, port).await,
            Target::Direct {
                endpoint,
                vault_link,
            } => direct::run(listener, offer, endpoint, vault_link, lease).await,
        };
        if let Err(reason) = result {
            // Never log peer frames, HTTP paths, tokens, or VNC credentials.
            log::debug!("VNC viewer ended: {reason}");
        }
    });
    Ok(VncAdmission {
        session_id,
        websocket_url,
    })
}

/// Cancel only the identified attempt. Repeated stops and stops before admission are safe.
#[tauri::command]
pub fn vnc_stop(
    window: WebviewWindow,
    sessions: State<'_, VncSessions>,
    session_id: String,
) -> Result<(), String> {
    main_window(&window)?;
    let id = Uuid::parse_str(&session_id).map_err(|_| "Invalid VNC session ID.")?;
    sessions.stop(id);
    Ok(())
}

/// Drop the listener on its first valid upgrade and always release the SSH stream before admission.
async fn run(
    listener: TcpListener,
    offer: Offer,
    connections: &Connections,
    binding: Binding,
    mut lease: Lease,
    port: u16,
) -> Result<(), &'static str> {
    let mut viewer = tokio::select! {
        biased;
        _ = lease.wait_cancelled() => return Ok(()),
        _ = binding.wait_invalid(connections) => return Err(NOT_CONNECTED),
        result = accept_viewer(listener, offer) => result?,
    };
    if !binding.current(connections).await || *lease.cancelled.borrow() {
        return Ok(());
    }

    // Once requested, retain both the open and its admission slot through confirmation or transport
    // loss. A late stream closes on drop. The viewer deadline never abandons a remote channel, and
    // a silent peer can retain at most MAX_SESSIONS pending opens without locking other SSH work.
    let requested = AtomicBool::new(false);
    let open = binding.open(port, &requested);
    tokio::pin!(open);
    let stream = tokio::select! {
        biased;
        _ = lease.wait_cancelled() => {
            drop(viewer);
            if requested.load(Ordering::Relaxed) {
                let _ = open.await;
            }
            return Ok(());
        }
        _ = binding.wait_invalid(connections) => {
            drop(viewer);
            if requested.load(Ordering::Relaxed) {
                let _ = open.await;
            }
            return Err(NOT_CONNECTED);
        }
        _ = sleep(OPEN_TIMEOUT) => {
            drop(viewer);
            if requested.load(Ordering::Relaxed) {
                let _ = open.await;
            }
            return Err(OPEN_TIMED_OUT);
        }
        result = &mut open => result?,
    };
    tokio::select! {
        biased;
        _ = lease.wait_cancelled() => Ok(()),
        _ = binding.wait_invalid(connections) => Err(NOT_CONNECTED),
        result = relay(&mut viewer, stream) => result,
    }
}
