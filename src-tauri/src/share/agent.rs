use super::api::{ApiClient, ShareRecord};
use super::auth::AuthStore;
use super::config::{to_ws_url, ShareConfig};
use super::protocol::{
    self, decode_data_frame, encode_data_frame, AgentOut, DataMsg, Envelope, ErrorMsg, Hello,
    OkMsg, Open, TYPE_CLOSE, TYPE_DATA, TYPE_ERROR, TYPE_OPEN, TYPE_PING,
};
use super::proxy::handle_open;
use super::stream::Stream;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

const WS_MAX_MESSAGE_BYTES: usize = 1 << 20;
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

pub struct AgentManager {
    app: AppHandle,
    data_dir: PathBuf,
    config: ShareConfig,
    auth: Arc<AuthStore>,
    statuses: Arc<Mutex<HashMap<String, AgentSnapshot>>>,
    slots: Mutex<HashMap<String, AgentSlot>>,
}

impl AgentManager {
    pub fn new(
        app: AppHandle,
        data_dir: PathBuf,
        config: ShareConfig,
        auth: Arc<AuthStore>,
    ) -> Self {
        Self {
            app,
            data_dir,
            config,
            auth,
            statuses: Arc::new(Mutex::new(HashMap::new())),
            slots: Mutex::new(HashMap::new()),
        }
    }

    pub async fn snapshots(&self) -> Vec<AgentSnapshot> {
        self.statuses.lock().await.values().cloned().collect()
    }

    pub async fn start(&self, share: ShareRecord) {
        self.stop(&share.id).await;
        let cancel = Arc::new(AtomicBool::new(false));
        let snapshot = AgentSnapshot {
            share_id: share.id.clone(),
            slug: share.slug.clone(),
            status: AgentConnState::Connecting,
            target_port: share.target_port,
            error: None,
        };
        self.statuses
            .lock()
            .await
            .insert(share.id.clone(), snapshot.clone());
        let app = self.app.clone();
        let data_dir = self.data_dir.clone();
        let config = self.config.clone();
        let auth = self.auth.clone();
        let statuses = self.statuses.clone();
        let cancel_task = cancel.clone();
        let share_id = share.id.clone();
        let handle = tokio::spawn(async move {
            run_agent_loop(app, data_dir, config, auth, statuses, share, cancel_task).await;
        });
        self.slots
            .lock()
            .await
            .insert(share_id, AgentSlot { cancel, handle });
        self.emit().await;
    }

    pub async fn stop(&self, share_id: &str) {
        let slot = self.slots.lock().await.remove(share_id);
        if let Some(slot) = slot {
            slot.cancel.store(true, Ordering::Relaxed);
            slot.handle.abort();
        }
        self.statuses.lock().await.remove(share_id);
        self.emit().await;
    }

    pub async fn stop_all(&self) {
        let mut slots = self.slots.lock().await;
        for (_, slot) in slots.drain() {
            slot.cancel.store(true, Ordering::Relaxed);
            slot.handle.abort();
        }
        self.statuses.lock().await.clear();
        drop(slots);
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
        let on_online = {
            let app = app.clone();
            let statuses = statuses.clone();
            let share = share.clone();
            move || {
                let app = app.clone();
                let statuses = statuses.clone();
                let share = share.clone();
                tokio::spawn(async move {
                    emit_status(&app, &statuses, &share, AgentConnState::Online, None).await;
                });
            }
        };
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

async fn run_session(
    relay_url: &str,
    ticket: Option<String>,
    resume_token: Option<String>,
    session_id: Option<String>,
    target: &str,
    cancel: Arc<AtomicBool>,
    on_online: impl FnOnce(),
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
    ws_config.max_message_size = Some(WS_MAX_MESSAGE_BYTES);
    ws_config.max_frame_size = Some(WS_MAX_MESSAGE_BYTES);

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
    on_online();
    let binary_data = negotiated == 2;

    let (tx, mut rx) = mpsc::unbounded_channel::<AgentOut>();
    let write = {
        let tx = tx.clone();
        move |v: AgentOut| tx.send(v).map_err(|_| "agent write closed".to_string())
    };
    let streams = Arc::new(Mutex::new(HashMap::<i64, Stream>::new()));
    let target = target.to_string();

    let writer_task = async {
        while let Some(out) = rx.recv().await {
            let sent = match out {
                AgentOut::Json(value) => {
                    let Ok(payload) = serde_json::to_string(&value) else {
                        continue;
                    };
                    sink.send(Message::Text(payload.into())).await
                }
                AgentOut::Data { stream_id, chunk } if binary_data => {
                    sink.send(Message::Binary(encode_data_frame(stream_id, &chunk).into()))
                        .await
                }
                AgentOut::Data { stream_id, chunk } => {
                    use base64::Engine;
                    let payload = serde_json::json!({
                        "type": "data",
                        "stream_id": stream_id,
                        "chunk": base64::engine::general_purpose::STANDARD.encode(chunk),
                    });
                    let Ok(text) = serde_json::to_string(&payload) else {
                        continue;
                    };
                    sink.send(Message::Text(text.into())).await
                }
            };
            if sent.is_err() {
                break;
            }
        }
    };

    let reader_task = async {
        while let Some(msg) = stream.next().await {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            if let Ok(Message::Binary(b)) = &msg {
                if let Some((stream_id, chunk)) = decode_data_frame(b) {
                    let sender = {
                        let guard = streams.lock().await;
                        guard.get(&stream_id).map(|st| st.data_sender())
                    };
                    if let Some(tx) = sender {
                        match tx.try_send(bytes::Bytes::copy_from_slice(chunk)) {
                            Ok(()) => {}
                            Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                                if let Some(st) = streams.lock().await.remove(&stream_id) {
                                    st.cancel();
                                }
                            }
                            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                                streams.lock().await.remove(&stream_id);
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
                    let _ = tx.send(AgentOut::Json(serde_json::json!({ "type": "pong" })));
                }
                TYPE_OPEN => {
                    let open: Open = match serde_json::from_str(&data) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    let (st, readers) = Stream::new(open.stream_id);
                    streams.lock().await.insert(open.stream_id, st);
                    let write = write.clone();
                    let target = target.clone();
                    let streams = streams.clone();
                    let stream_id = open.stream_id;
                    tokio::spawn(async move {
                        handle_open(&target, open, readers, write).await;
                        streams.lock().await.remove(&stream_id);
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
                    let sender = {
                        let guard = streams.lock().await;
                        guard.get(&msg.stream_id).map(|st| st.data_sender())
                    };
                    if let Some(tx) = sender {
                        match tx.try_send(bytes::Bytes::from(raw)) {
                            Ok(()) => {}
                            Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                                // Slow/local stream backlog — drop only this stream so
                                // the session keeps handling other streams and pings.
                                if let Some(st) = streams.lock().await.remove(&msg.stream_id) {
                                    st.cancel();
                                }
                            }
                            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                                streams.lock().await.remove(&msg.stream_id);
                            }
                        }
                    }
                }
                TYPE_CLOSE => {
                    let msg: protocol::Close = match serde_json::from_str(&data) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    if let Some(st) = streams.lock().await.get_mut(&msg.stream_id) {
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
mod loopback_tests {
    use super::is_loopback_host;

    #[test]
    fn accepts_loopback_only() {
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("localhost"));
        assert!(is_loopback_host("::1"));
        assert!(is_loopback_host("[::1]"));
        assert!(!is_loopback_host("example.com"));
        assert!(!is_loopback_host("8.8.8.8"));
    }
}
