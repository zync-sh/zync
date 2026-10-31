use super::api::{ApiClient, ShareRecord};
use super::auth::AuthStore;
use super::config::{to_ws_url, ShareConfig};
use super::outbound::OutboundSender;
use super::protocol::{
    self, decode_data_frame, DataMsg, Envelope, ErrorMsg, Hello, OkMsg, Open, MAX_MESSAGE_BYTES,
    TYPE_CLOSE, TYPE_DATA, TYPE_ERROR, TYPE_OPEN, TYPE_PING,
};
use super::proxy::handle_open;
use super::stream::Stream;
use base64::Engine;
use futures_util::stream::FuturesUnordered;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::{watch, Mutex};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

// Match the relay's existing per-share admission limit.
const MAX_ACTIVE_STREAMS: usize = 256;
const INITIAL_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
const STABLE_SESSION: Duration = Duration::from_secs(30);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentConnState {
    Offline,
    Connecting,
    Online,
    Reconnecting,
    AuthFailed,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentSnapshot {
    pub share_id: String,
    pub slug: String,
    pub status: AgentConnState,
    pub target_port: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct AgentSlot {
    cancel: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}

impl AgentSlot {
    /// Wait for the agent future and its owned proxies to be dropped before returning.
    async fn stop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
        self.handle.abort();
        let _ = (&mut self.handle).await;
    }
}

impl Drop for AgentSlot {
    /// Dropping an owner must cancel its agent rather than detach the join handle.
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
        self.handle.abort();
    }
}

// Mutations require exclusive access for their entire lifetime, including joins.
// Agent tasks only use `statuses`, so joining cannot wait for this lifecycle lock.
struct AgentLifecycle {
    statuses: Arc<Mutex<HashMap<String, AgentSnapshot>>>,
    slots: HashMap<String, AgentSlot>,
}

impl AgentLifecycle {
    /// Join the previous owner before publishing and spawning its replacement.
    async fn start(
        &mut self,
        snapshot: AgentSnapshot,
        cancel: Arc<AtomicBool>,
        task: impl Future<Output = ()> + Send + 'static,
    ) {
        let share_id = snapshot.share_id.clone();
        self.stop(&share_id).await;
        self.statuses
            .lock()
            .await
            .insert(share_id.clone(), snapshot);
        self.slots.insert(
            share_id,
            AgentSlot {
                cancel,
                handle: tokio::spawn(task),
            },
        );
    }

    /// Join the captured agent before removing its status under exclusive ownership.
    async fn stop(&mut self, share_id: &str) {
        // Retain the handle until joined. If the caller is cancelled, the next
        // lifecycle operation must still join this owner before replacing it.
        if let Some(slot) = self.slots.get_mut(share_id) {
            slot.stop().await;
        }
        self.slots.remove(share_id);
        self.statuses.lock().await.remove(share_id);
    }

    /// Abort every captured agent before joining them and clearing their statuses.
    async fn stop_all(&mut self) {
        for slot in self.slots.values() {
            slot.cancel.store(true, Ordering::Relaxed);
            slot.handle.abort();
        }
        while let Some(share_id) = self.slots.keys().next().cloned() {
            self.stop(&share_id).await;
        }
        self.statuses.lock().await.clear();
    }
}

pub struct AgentManager {
    app: AppHandle,
    data_dir: PathBuf,
    config: ShareConfig,
    auth: Arc<AuthStore>,
    statuses: Arc<Mutex<HashMap<String, AgentSnapshot>>>,
    lifecycle: Mutex<AgentLifecycle>,
}

impl AgentManager {
    /// Share status reads independently from serialized lifecycle mutations.
    pub fn new(
        app: AppHandle,
        data_dir: PathBuf,
        config: ShareConfig,
        auth: Arc<AuthStore>,
    ) -> Self {
        let statuses = Arc::new(Mutex::new(HashMap::new()));
        Self {
            app,
            data_dir,
            config,
            auth,
            statuses: statuses.clone(),
            lifecycle: Mutex::new(AgentLifecycle {
                statuses,
                slots: HashMap::new(),
            }),
        }
    }

    pub async fn snapshots(&self) -> Vec<AgentSnapshot> {
        self.statuses.lock().await.values().cloned().collect()
    }

    /// Serialize replacement with shutdown; start network work only after admission.
    pub async fn start(&self, share: ShareRecord) {
        let cancel = Arc::new(AtomicBool::new(false));
        let snapshot = AgentSnapshot {
            share_id: share.id.clone(),
            slug: share.slug.clone(),
            status: AgentConnState::Connecting,
            target_port: share.target_port,
            error: None,
        };
        let task = run_agent_loop(
            self.app.clone(),
            self.data_dir.clone(),
            self.config.clone(),
            self.auth.clone(),
            self.statuses.clone(),
            share,
            cancel.clone(),
        );
        let mut lifecycle = self.lifecycle.lock().await;
        lifecycle.start(snapshot, cancel, task).await;
        self.emit().await;
    }

    /// Cancel and join the share's agent before removing its visible status.
    pub async fn stop(&self, share_id: &str) {
        let mut lifecycle = self.lifecycle.lock().await;
        lifecycle.stop(share_id).await;
        self.emit().await;
    }

    /// Serialize global shutdown with starts and stops through the final status event.
    pub async fn stop_all(&self) {
        let mut lifecycle = self.lifecycle.lock().await;
        lifecycle.stop_all().await;
        self.emit().await;
    }

    async fn emit(&self) {
        let agents = self.snapshots().await;
        let _ = self.app.emit("share://agent-status", agents);
    }
}

#[derive(Serialize, Deserialize)]
struct ResumeFile {
    relay_url: String,
    slug: String,
    session_id: Option<String>,
    resume_token: Option<String>,
}

use serde::Deserialize;

/// Reconnect one share only after the previous session has released its proxies.
async fn run_agent_loop(
    app: AppHandle,
    data_dir: PathBuf,
    config: ShareConfig,
    auth: Arc<AuthStore>,
    statuses: Arc<Mutex<HashMap<String, AgentSnapshot>>>,
    share: ShareRecord,
    cancel: Arc<AtomicBool>,
) {
    let resume_path = resume_path(&data_dir, &share.id);
    let mut saved = load_resume(&resume_path);
    let mut backoff = INITIAL_BACKOFF;
    if !is_loopback_host(&share.target_host) {
        emit_status(
            &app,
            &statuses,
            &share,
            AgentConnState::Offline,
            Some("only localhost targets are allowed from this device".into()),
        )
        .await;
        return;
    }
    // ngrok / cloudflared / the browser all dial `localhost`, not `127.0.0.1`.
    // Node/Vite/Astro on Windows often bind `[::1]` only; `localhost` resolves to both.
    let target = format!("http://localhost:{}", share.target_port);
    let mut ticket: Option<String> = None;

    while !cancel.load(Ordering::Relaxed) {
        emit_status(
            &app,
            &statuses,
            &share,
            if saved
                .as_ref()
                .and_then(|s| s.resume_token.as_ref())
                .is_some()
            {
                AgentConnState::Reconnecting
            } else {
                AgentConnState::Connecting
            },
            None,
        )
        .await;
        if ticket.is_none() {
            match mint_ticket(&config, &auth, &share.id).await {
                Ok(t) => ticket = Some(t),
                Err(e) => {
                    if saved
                        .as_ref()
                        .and_then(|s| s.resume_token.as_ref())
                        .is_none()
                    {
                        emit_status(&app, &statuses, &share, AgentConnState::AuthFailed, Some(e))
                            .await;
                        return;
                    }
                }
            }
        }

        let started = Instant::now();
        let on_online = emit_status(&app, &statuses, &share, AgentConnState::Online, None);
        let result = run_session(
            &config.relay_url,
            ticket.clone(),
            saved.as_ref().and_then(|s| s.resume_token.clone()),
            saved.as_ref().and_then(|s| s.session_id.clone()),
            &target,
            cancel.clone(),
            on_online,
        )
        .await;

        match result {
            SessionResult::Ok(ok) => {
                saved = Some(ResumeFile {
                    relay_url: config.relay_url.clone(),
                    slug: ok.slug,
                    session_id: ok.session_id,
                    resume_token: ok.resume_token,
                });
                save_resume(&resume_path, saved.as_ref().unwrap());
            }
            SessionResult::ShareStopped => {
                clear_resume(&resume_path);
                emit_status(
                    &app,
                    &statuses,
                    &share,
                    AgentConnState::Offline,
                    Some("stopped".into()),
                )
                .await;
                return;
            }
            SessionResult::AuthFailed => {
                if saved
                    .as_ref()
                    .and_then(|s| s.resume_token.as_ref())
                    .is_some()
                {
                    saved = None;
                    clear_resume(&resume_path);
                    ticket = None;
                    // Fall through to backoff before retrying with the API ticket.
                } else {
                    match mint_ticket(&config, &auth, &share.id).await {
                        Ok(t) => {
                            ticket = Some(t);
                            // Fall through to backoff so auth failures are rate-limited.
                        }
                        Err(e) => {
                            emit_status(
                                &app,
                                &statuses,
                                &share,
                                AgentConnState::AuthFailed,
                                Some(e),
                            )
                            .await;
                            return;
                        }
                    }
                }
            }
            SessionResult::Err(msg) => {
                log::warn!(
                    "share agent session error share={} slug={}: {msg}",
                    share.id,
                    share.slug
                );
            }
        }

        if cancel.load(Ordering::Relaxed) {
            break;
        }
        if started.elapsed() >= STABLE_SESSION {
            backoff = INITIAL_BACKOFF;
        } else {
            backoff = (backoff * 2).min(MAX_BACKOFF);
        }
        emit_status(&app, &statuses, &share, AgentConnState::Reconnecting, None).await;
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            _ = wait_cancel(&cancel) => break,
        }
    }
    emit_status(&app, &statuses, &share, AgentConnState::Offline, None).await;
}

async fn emit_status(
    app: &AppHandle,
    statuses: &Mutex<HashMap<String, AgentSnapshot>>,
    share: &ShareRecord,
    status: AgentConnState,
    error: Option<String>,
) {
    let snap = AgentSnapshot {
        share_id: share.id.clone(),
        slug: share.slug.clone(),
        status,
        target_port: share.target_port,
        error,
    };
    statuses.lock().await.insert(share.id.clone(), snap.clone());
    let all: Vec<AgentSnapshot> = statuses.lock().await.values().cloned().collect();
    let _ = app.emit("share://agent-status", all);
    let _ = snap;
}

async fn wait_cancel(cancel: &Arc<AtomicBool>) {
    while !cancel.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn mint_ticket(
    config: &ShareConfig,
    auth: &AuthStore,
    share_id: &str,
) -> Result<String, String> {
    let access = auth.ensure_access_token(config).await?;
    let client = ApiClient::new(config.clone());
    let ticket = client.create_ticket(&access, share_id).await?;
    Ok(ticket.token)
}

enum SessionResult {
    Ok(OkMsg),
    ShareStopped,
    AuthFailed,
    Err(String),
}

/// Connect to the relay and keep its handshake, status update and proxies owned.
async fn run_session(
    relay_url: &str,
    ticket: Option<String>,
    resume_token: Option<String>,
    session_id: Option<String>,
    target: &str,
    cancel: Arc<AtomicBool>,
    on_online: impl Future<Output = ()>,
) -> SessionResult {
    let ws_url = match to_ws_url(&format!("{relay_url}/agent")) {
        Ok(u) => u,
        Err(e) => return SessionResult::Err(e),
    };
    let mut request = match ws_url.into_client_request() {
        Ok(r) => r,
        Err(e) => return SessionResult::Err(e.to_string()),
    };
    if let Some(t) = &ticket {
        if let Ok(value) = format!("Bearer {t}").parse() {
            request.headers_mut().insert("Authorization", value);
        }
    }
    let mut ws_config = WebSocketConfig::default();
    ws_config.max_message_size = Some(MAX_MESSAGE_BYTES);
    ws_config.max_frame_size = Some(MAX_MESSAGE_BYTES);
    ws_config.max_write_buffer_size = 2 * MAX_MESSAGE_BYTES;

    let connect = tokio_tungstenite::connect_async_with_config(request, Some(ws_config), false);
    let (ws, _) = match tokio::time::timeout(HANDSHAKE_TIMEOUT, connect).await {
        Ok(Ok(pair)) => pair,
        Ok(Err(e)) => {
            let msg = e.to_string();
            if is_auth_failed(&msg) {
                return SessionResult::AuthFailed;
            }
            if is_share_stopped(&msg) {
                return SessionResult::ShareStopped;
            }
            return SessionResult::Err(msg);
        }
        Err(_) => return SessionResult::Err("handshake timeout".into()),
    };

    run_connected_session(
        ws,
        ticket,
        resume_token,
        session_id,
        target,
        cancel,
        on_online,
    )
    .await
}

/// Own all proxy futures inside the relay session so every exit drops pending I/O.
async fn run_connected_session<S>(
    ws: tokio_tungstenite::WebSocketStream<S>,
    ticket: Option<String>,
    resume_token: Option<String>,
    session_id: Option<String>,
    target: &str,
    cancel: Arc<AtomicBool>,
    on_online: impl Future<Output = ()>,
) -> SessionResult
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut sink, mut stream) = ws.split();
    let hello = Hello::new(ticket, resume_token, session_id);
    let hello_json = match serde_json::to_string(&hello) {
        Ok(s) => s,
        Err(e) => return SessionResult::Err(e.to_string()),
    };
    if sink.send(Message::Text(hello_json.into())).await.is_err() {
        return SessionResult::Err("hello send failed".into());
    }

    let first = match tokio::time::timeout(HANDSHAKE_TIMEOUT, stream.next()).await {
        Ok(Some(Ok(Message::Text(t)))) => t.to_string(),
        Ok(Some(Ok(Message::Binary(b)))) => String::from_utf8_lossy(&b).into_owned(),
        Ok(Some(Ok(Message::Close(frame)))) => {
            let msg = frame
                .as_ref()
                .map(|f| f.reason.to_string())
                .unwrap_or_default();
            if is_share_stopped(&msg) {
                return SessionResult::ShareStopped;
            }
            if is_auth_failed(&msg) {
                return SessionResult::AuthFailed;
            }
            return SessionResult::Err(msg);
        }
        Ok(Some(Err(e))) => {
            let msg = e.to_string();
            if is_share_stopped(&msg) {
                return SessionResult::ShareStopped;
            }
            if is_auth_failed(&msg) {
                return SessionResult::AuthFailed;
            }
            return SessionResult::Err(msg);
        }
        _ => return SessionResult::Err("handshake failed".into()),
    };

    let env: Envelope = match serde_json::from_str(&first) {
        Ok(v) => v,
        Err(e) => return SessionResult::Err(e.to_string()),
    };
    if env.kind == TYPE_ERROR {
        let er: ErrorMsg = serde_json::from_str(&first).unwrap_or(ErrorMsg {
            code: String::new(),
            message: first.clone(),
        });
        if er.code == "share_stopped" || is_share_stopped(&er.message) {
            return SessionResult::ShareStopped;
        }
        if er.code == "auth_failed" || is_auth_failed(&er.message) {
            return SessionResult::AuthFailed;
        }
        return SessionResult::Err(format!("{} {}", er.code, er.message));
    }
    if env.kind != protocol::TYPE_OK {
        return SessionResult::Err(format!("expected ok, got {}", env.kind));
    }
    let ok: OkMsg = match serde_json::from_str(&first) {
        Ok(v) => v,
        Err(e) => return SessionResult::Err(e.to_string()),
    };
    let negotiated = if ok.v == 0 { 1 } else { ok.v };
    if negotiated > protocol::PROTOCOL_MAX_VERSION {
        return SessionResult::Err(format!("unsupported protocol version {negotiated}"));
    }
    on_online.await;
    let binary_data = negotiated == 2;

    let (write, mut rx) = OutboundSender::data_channel(binary_data);
    let (control, mut control_rx) = OutboundSender::control_channel();
    // A watch version coalesces a burst into one pending reply. Pings received
    // during a Pong flush leave one further notification for the next iteration.
    let (pong_tx, mut pong_rx) = watch::channel(());
    let target = target.to_string();

    let writer_task = async {
        loop {
            let frame = tokio::select! {
                changed = pong_rx.changed() => {
                    if changed.is_err()
                        || sink.send(Message::Text(r#"{"type":"pong"}"#.into())).await.is_err()
                    {
                        break;
                    }
                    continue;
                }
                Some(frame) = control_rx.recv() => frame,
                Some(frame) = rx.recv() => frame,
                else => break,
            };
            if frame.write_to(&mut sink).await.is_err() {
                break;
            }
        }
    };

    let reader_task = async {
        let mut streams = HashMap::<i64, Stream>::new();
        // These futures are polled here, never spawned: dropping the reader also
        // drops HTTP sends/bodies, local sockets and their channel receivers.
        let mut proxies = FuturesUnordered::new();
        loop {
            let msg = tokio::select! {
                biased;
                Some(stream_id) = proxies.next(), if !proxies.is_empty() => {
                    streams.remove(&stream_id);
                    continue;
                }
                msg = stream.next() => match msg {
                    Some(msg) => msg,
                    None => break,
                },
            };
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            if let Ok(Message::Binary(b)) = &msg {
                if let Some((stream_id, chunk)) = decode_data_frame(b) {
                    let sender = streams.get(&stream_id).map(|st| st.data_sender());
                    if let Some(tx) = sender {
                        match tx.try_send(bytes::Bytes::copy_from_slice(chunk)) {
                            Ok(()) => {}
                            Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                                if let Some(st) = streams.get(&stream_id) {
                                    st.cancel();
                                }
                            }
                            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                                // HTTP can discard body input while its response is pending.
                            }
                        }
                    }
                    continue;
                }
            }
            let data = match msg {
                Ok(Message::Text(t)) => t.to_string(),
                Ok(Message::Binary(b)) => String::from_utf8_lossy(&b).into_owned(),
                Ok(Message::Ping(_)) | Ok(Message::Pong(_)) | Ok(Message::Frame(_)) => continue,
                Ok(Message::Close(frame)) => {
                    let reason = frame
                        .as_ref()
                        .map(|f| f.reason.to_string())
                        .unwrap_or_default();
                    if is_share_stopped(&reason) {
                        return SessionResult::ShareStopped;
                    }
                    if is_auth_failed(&reason) {
                        return SessionResult::AuthFailed;
                    }
                    break;
                }
                Err(e) => {
                    let msg = e.to_string();
                    if is_share_stopped(&msg) {
                        return SessionResult::ShareStopped;
                    }
                    if is_auth_failed(&msg) {
                        return SessionResult::AuthFailed;
                    }
                    break;
                }
            };
            let env: Envelope = match serde_json::from_str(&data) {
                Ok(v) => v,
                Err(_) => continue,
            };
            match env.kind.as_str() {
                TYPE_PING => {
                    pong_tx.send_replace(());
                }
                TYPE_OPEN => {
                    let open: Open = match serde_json::from_str(&data) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    if streams.contains_key(&open.stream_id) {
                        return SessionResult::Err("duplicate active stream id".into());
                    }
                    // Count cancelled/output-blocked proxies until they finish.
                    if proxies.len() >= MAX_ACTIVE_STREAMS {
                        if let Err(e) = reject_open(&control, open.stream_id) {
                            return SessionResult::Err(e);
                        }
                        continue;
                    }
                    let (st, readers) = Stream::new(open.stream_id);
                    streams.insert(open.stream_id, st);
                    let write = write.clone();
                    let target = target.clone();
                    let stream_id = open.stream_id;
                    proxies.push(async move {
                        handle_open(&target, open, readers, write).await;
                        stream_id
                    });
                }
                TYPE_DATA => {
                    let msg: DataMsg = match serde_json::from_str(&data) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    let raw = match base64::engine::general_purpose::STANDARD.decode(&msg.chunk) {
                        Ok(b) => b,
                        Err(_) => continue,
                    };
                    let sender = streams.get(&msg.stream_id).map(|st| st.data_sender());
                    if let Some(tx) = sender {
                        match tx.try_send(bytes::Bytes::from(raw)) {
                            Ok(()) => {}
                            Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                                // Slow/local stream backlog — cancel only this stream so
                                // the session keeps handling other streams and pings.
                                if let Some(st) = streams.get(&msg.stream_id) {
                                    st.cancel();
                                }
                            }
                            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                                // HTTP can discard body input while its response is pending.
                            }
                        }
                    }
                }
                TYPE_CLOSE => {
                    let msg: protocol::Close = match serde_json::from_str(&data) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    if let Some(st) = streams.get_mut(&msg.stream_id) {
                        let _ = st.finish_request_body();
                    }
                }
                _ => {}
            }
        }
        SessionResult::Ok(OkMsg {
            slug: String::new(),
            session_id: None,
            resume_token: None,
            v: 0,
        })
    };

    tokio::select! {
        _ = writer_task => SessionResult::Err("writer ended".into()),
        result = reader_task => {
            if let SessionResult::Ok(_) = &result {
                SessionResult::Ok(ok)
            } else {
                result
            }
        }
        _ = wait_cancel(&cancel) => SessionResult::Ok(ok),
    }
}

/// Refuse excess work using existing protocol frames without blocking the reader.
fn reject_open(control: &OutboundSender, stream_id: i64) -> Result<(), String> {
    control.try_json(serde_json::json!({
        "type": "end", "stream_id": stream_id, "status": 503,
        "headers": { "Content-Length": ["0"], "X-Zync-Error": ["overloaded"] },
    }))?;
    control.try_json(serde_json::json!({ "type": "close", "stream_id": stream_id }))
}

fn resume_path(data_dir: &Path, share_id: &str) -> PathBuf {
    data_dir
        .join("share-agent")
        .join(format!("{share_id}.json"))
}

fn load_resume(path: &Path) -> Option<ResumeFile> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn save_resume(path: &Path, file: &ResumeFile) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(raw) = serde_json::to_string_pretty(file) {
        let _ = std::fs::write(path, raw);
    }
}

fn clear_resume(path: &Path) {
    let _ = std::fs::remove_file(path);
}

fn is_auth_failed(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    m.contains("auth_failed") || m.contains("auth failed")
}

fn is_share_stopped(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    m.contains("share_stopped") || m.contains("share stopped")
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.trim().trim_matches(|c| c == '[' || c == ']');
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) => ip.is_loopback(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests;
