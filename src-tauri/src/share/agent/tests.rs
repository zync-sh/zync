use super::super::protocol::encode_data_frame;
use super::*;
use serde_json::{json, Value};
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::protocol::{frame::coding::CloseCode, CloseFrame, Role};
use tokio_tungstenite::WebSocketStream;

const TEST_TIMEOUT: Duration = Duration::from_secs(5);
type Relay = WebSocketStream<DuplexStream>;

// In-memory relay transport with an independently failing outbound half.
struct AgentTransport {
    inner: DuplexStream,
    fail_writes: Arc<AtomicBool>,
    pause: Arc<std::sync::Mutex<WritePause>>,
}

#[derive(Default)]
struct WritePause {
    paused: bool,
    waker: Option<std::task::Waker>,
    blocked: Option<oneshot::Sender<()>>,
}

impl AsyncRead for AgentTransport {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for AgentTransport {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.fail_writes.load(Ordering::Relaxed) {
            return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
        }
        {
            let mut pause = self.pause.lock().unwrap();
            if pause.paused {
                pause.waker = Some(cx.waker().clone());
                if let Some(blocked) = pause.blocked.take() {
                    let _ = blocked.send(());
                }
                return Poll::Pending;
            }
        }
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[derive(Clone, Copy, Debug)]
enum Exit {
    Disconnect,
    Cancel,
    ShareStopped,
    AuthFailed,
    WriterFailed,
    Stop,
    DropOwner,
}

struct Session {
    relay: Option<Relay>,
    slot: Option<AgentSlot>,
    outcome: oneshot::Receiver<SessionResult>,
    fail_writes: Arc<AtomicBool>,
    pause: Arc<std::sync::Mutex<WritePause>>,
}

impl Session {
    async fn start(target: String, version: i32) -> Self {
        Self::with_online(target, version, std::future::ready(())).await
    }

    async fn with_online(
        target: String,
        version: i32,
        on_online: impl Future<Output = ()> + Send + 'static,
    ) -> Self {
        let (client, server) = tokio::io::duplex(65536);
        let fail_writes = Arc::new(AtomicBool::new(false));
        let pause = Arc::new(std::sync::Mutex::new(WritePause::default()));
        let ws = WebSocketStream::from_raw_socket(
            AgentTransport {
                inner: client,
                fail_writes: fail_writes.clone(),
                pause: pause.clone(),
            },
            Role::Client,
            None,
        )
        .await;
        let mut relay = WebSocketStream::from_raw_socket(server, Role::Server, None).await;
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_task = cancel.clone();
        let (sent, outcome) = oneshot::channel();
        let handle = tokio::spawn(async move {
            let result =
                run_connected_session(ws, None, None, None, &target, cancel_task, on_online).await;
            let _ = sent.send(result);
        });
        // Keep the real owner guard alive during setup, including assertion failures.
        let slot = AgentSlot { cancel, handle };
        let hello = timeout(TEST_TIMEOUT, relay.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(hello.to_text().unwrap()).unwrap()["type"],
            "hello"
        );
        relay
            .send(Message::Text(
                json!({
                    "type": "ok", "slug": "fixture", "session_id": "fixture-session",
                    "resume_token": "fixture-resume", "v": version,
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
        Self {
            relay: Some(relay),
            slot: Some(slot),
            outcome,
            fail_writes,
            pause,
        }
    }

    fn pause_writer(&self) -> oneshot::Receiver<()> {
        let (blocked, waiting) = oneshot::channel();
        let mut pause = self.pause.lock().unwrap();
        pause.paused = true;
        pause.blocked = Some(blocked);
        waiting
    }

    fn resume_writer(&self) {
        let waker = {
            let mut pause = self.pause.lock().unwrap();
            pause.paused = false;
            pause.waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
    }

    async fn send(&mut self, value: Value) {
        self.relay
            .as_mut()
            .unwrap()
            .send(Message::Text(value.to_string().into()))
            .await
            .unwrap();
    }

    async fn next_frame(&mut self) -> Message {
        timeout(TEST_TIMEOUT, self.relay.as_mut().unwrap().next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
    }

    async fn open(&mut self, id: i64, mode: &str, method: &str) {
        self.send(json!({ "type": "open", "stream_id": id, "mode": mode,
            "method": method, "path": "/fixture" }))
            .await;
    }

    async fn request_data(&mut self, version: i32, id: i64, bytes: &[u8]) {
        if version == 2 {
            self.relay
                .as_mut()
                .unwrap()
                .send(Message::Binary(encode_data_frame(id, bytes).into()))
                .await
                .unwrap();
        } else {
            self.send(json!({
                "type": "data", "stream_id": id,
                "chunk": base64::engine::general_purpose::STANDARD.encode(bytes),
            }))
            .await;
        }
    }

    async fn frame(&mut self, kind: &str) -> Value {
        timeout(TEST_TIMEOUT, async {
            loop {
                let msg = self.relay.as_mut().unwrap().next().await.unwrap().unwrap();
                if let Message::Text(text) = msg {
                    let value: Value = serde_json::from_str(&text).unwrap();
                    if value["type"] == kind {
                        return value;
                    }
                }
            }
        })
        .await
        .expect("expected relay frame")
    }

    async fn finish(mut self, exit: Exit) {
        match exit {
            Exit::Stop => self.slot.take().unwrap().stop().await,
            Exit::DropOwner => drop(self.slot.take()),
            Exit::Disconnect => drop(self.relay.take()),
            Exit::Cancel => self
                .slot
                .as_ref()
                .unwrap()
                .cancel
                .store(true, Ordering::Relaxed),
            Exit::WriterFailed => {
                self.fail_writes.store(true, Ordering::Relaxed);
                self.send(json!({ "type": "ping" })).await;
            }
            Exit::ShareStopped | Exit::AuthFailed => {
                let reason = if matches!(exit, Exit::ShareStopped) {
                    "share_stopped"
                } else {
                    "auth_failed"
                };
                self.relay
                    .as_mut()
                    .unwrap()
                    .close(Some(CloseFrame {
                        code: CloseCode::Policy,
                        reason: reason.into(),
                    }))
                    .await
                    .unwrap();
            }
        }
        let outcome = timeout(TEST_TIMEOUT, &mut self.outcome)
            .await
            .expect("session ended");
        match exit {
            Exit::Stop | Exit::DropOwner => assert!(outcome.is_err()),
            Exit::ShareStopped => assert!(matches!(outcome, Ok(SessionResult::ShareStopped))),
            Exit::AuthFailed => assert!(matches!(outcome, Ok(SessionResult::AuthFailed))),
            Exit::WriterFailed => {
                assert!(matches!(outcome, Ok(SessionResult::Err(msg)) if msg == "writer ended"))
            }
            Exit::Disconnect | Exit::Cancel => {
                assert!(matches!(outcome, Ok(SessionResult::Ok(ok))
                    if ok.session_id.as_deref() == Some("fixture-session")
                    && ok.resume_token.as_deref() == Some("fixture-resume")));
            }
        }
        if let Some(slot) = self.slot.as_mut() {
            let joined = timeout(TEST_TIMEOUT, &mut slot.handle).await.unwrap();
            if !matches!(exit, Exit::DropOwner) {
                joined.unwrap();
            }
        }
    }
}

async fn listener() -> (TcpListener, String) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let target = format!("http://{}", listener.local_addr().unwrap());
    (listener, target)
}

async fn accept_http(listener: &TcpListener) -> (TcpStream, Vec<u8>) {
    timeout(TEST_TIMEOUT, async {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut buf = [0; 1024];
                let n = socket.read(&mut buf).await.unwrap();
                // HTTP loopback discovery can connect and close before the request.
                if n == 0 {
                    break;
                }
                bytes.extend_from_slice(&buf[..n]);
                if bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                    return (socket, bytes);
                }
            }
        }
    })
    .await
    .expect("local HTTP request")
}

async fn assert_closed(socket: &mut TcpStream) {
    timeout(TEST_TIMEOUT, async {
        let mut buf = [0; 1024];
        loop {
            match socket.read(&mut buf).await {
                Ok(0) => break,
                Ok(_) => continue,
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted
                    ) =>
                {
                    break
                }
                Err(e) => panic!("unexpected local read error: {e}"),
            }
        }
    })
    .await
    .expect("session shutdown must close the local proxy socket");
}

#[test]
fn accepts_loopback_only() {
    assert!(is_loopback_host("127.0.0.1"));
    assert!(is_loopback_host("localhost"));
    assert!(is_loopback_host("::1"));
    assert!(is_loopback_host("[::1]"));
    assert!(!is_loopback_host("example.com"));
    assert!(!is_loopback_host("8.8.8.8"));
}

#[tokio::test]
async fn idle_tcp_closes_on_every_session_exit() {
    for exit in [
        Exit::Disconnect,
        Exit::Cancel,
        Exit::ShareStopped,
        Exit::AuthFailed,
        Exit::WriterFailed,
        Exit::Stop,
        Exit::DropOwner,
    ] {
        let (listener, target) = listener().await;
        let mut session = Session::start(target, 1).await;
        session.open(1, protocol::MODE_TCP, "").await;
        let (mut socket, _) = timeout(TEST_TIMEOUT, listener.accept())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(session.frame("end").await["status"], 200);
        session.finish(exit).await;
        assert_closed(&mut socket).await;
    }
}

#[tokio::test]
async fn pending_http_headers_close_before_reconnect() {
    let (listener, target) = listener().await;
    // Reuse the target and stream ID across relay sessions; no old request survives.
    for _ in 0..4 {
        let mut session = Session::start(target.clone(), 1).await;
        session.open(1, "", "GET").await;
        let (mut socket, request) = accept_http(&listener).await;
        assert!(request.starts_with(b"GET /fixture HTTP/1.1"));
        session.finish(Exit::Disconnect).await;
        assert_closed(&mut socket).await;
    }
}

#[tokio::test]
async fn pending_http_upload_closes_on_stop() {
    let (listener, target) = listener().await;
    let mut session = Session::start(target, 1).await;
    session.open(1, "", "POST").await;
    session
        .send(json!({ "type": "data", "stream_id": 1, "chunk": "YWJj" }))
        .await;
    let (mut socket, request) = accept_http(&listener).await;
    assert!(request.starts_with(b"POST /fixture HTTP/1.1"));
    // No request-body close and no local response: both directions are pending.
    session.finish(Exit::Stop).await;
    assert_closed(&mut socket).await;
}

#[tokio::test]
async fn idle_http_response_body_closes_on_stop() {
    let (listener, target) = listener().await;
    let mut session = Session::start(target, 1).await;
    session.open(1, "", "GET").await;
    let (mut socket, _) = accept_http(&listener).await;
    socket
        .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n")
        .await
        .unwrap();
    assert_eq!(session.frame("end").await["status"], 200);
    assert_eq!(session.frame("data").await["chunk"], "YWJj");
    session.finish(Exit::Stop).await;
    assert_closed(&mut socket).await;
}

#[tokio::test]
async fn pending_and_upgraded_websockets_close_with_session() {
    for upgraded in [false, true] {
        let (listener, target) = listener().await;
        let mut session = Session::start(target, 1).await;
        session.open(1, protocol::MODE_STREAM, "GET").await;
        let (mut socket, request) = accept_http(&listener).await;
        assert!(String::from_utf8_lossy(&request).contains("Upgrade: websocket"));
        if upgraded {
            socket.write_all(b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n").await.unwrap();
            assert_eq!(session.frame("end").await["status"], 101);
        }
        session.finish(Exit::ShareStopped).await;
        assert_closed(&mut socket).await;
    }
}

#[tokio::test]
async fn completed_http_streams_keep_relay_live() {
    let (listener, target) = listener().await;
    let mut session = Session::start(target, 1).await;
    for id in 1..=3 {
        session.open(id, "", "GET").await;
        let (mut socket, _) = accept_http(&listener).await;
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc")
            .await
            .unwrap();
        assert_eq!(session.frame("end").await["stream_id"], id);
        assert_eq!(session.frame("data").await["chunk"], "YWJj");
        assert_eq!(session.frame("close").await["stream_id"], id);
        session.send(json!({ "type": "ping" })).await;
        session.frame("pong").await;
    }
    session.finish(Exit::Stop).await;
}

#[tokio::test]
async fn binary_streams_still_forward_both_directions_and_close() {
    let (listener, target) = listener().await;
    let mut session = Session::start(target, 2).await;
    session.open(1, protocol::MODE_TCP, "").await;
    let (mut socket, _) = timeout(TEST_TIMEOUT, listener.accept())
        .await
        .unwrap()
        .unwrap();
    session.frame("end").await;
    session
        .relay
        .as_mut()
        .unwrap()
        .send(Message::Binary(encode_data_frame(1, b"up").into()))
        .await
        .unwrap();
    let mut uplink = [0; 2];
    timeout(TEST_TIMEOUT, socket.read_exact(&mut uplink))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&uplink, b"up");
    socket.write_all(b"down").await.unwrap();
    let data = timeout(TEST_TIMEOUT, session.relay.as_mut().unwrap().next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(
        decode_data_frame(&data.into_data()),
        Some((1, &b"down"[..]))
    );
    session.finish(Exit::Cancel).await;
    assert_closed(&mut socket).await;
}

#[tokio::test]
async fn stop_cancels_pending_online_status_in_the_agent_owner() {
    let (started, waiting) = oneshot::channel();
    let (finished, completed) = oneshot::channel::<()>();
    let session = Session::with_online("http://localhost:1".into(), 1, async move {
        let _ = started.send(());
        std::future::pending::<()>().await;
        let _ = finished.send(());
    })
    .await;
    timeout(TEST_TIMEOUT, waiting).await.unwrap().unwrap();
    session.finish(Exit::Stop).await;
    assert!(
        completed.await.is_err(),
        "Online update must not survive Stop"
    );
}

// Keep task destruction pending without timing assumptions, exposing the window
// between aborting the old owner and completing its join.
struct HoldTaskDrop {
    entered: Option<oneshot::Sender<()>>,
    release: std::sync::mpsc::Receiver<()>,
}

impl Drop for HoldTaskDrop {
    fn drop(&mut self) {
        let _ = self.entered.take().unwrap().send(());
        let _ = self.release.recv();
    }
}

fn snapshot(id: &str, slug: &str) -> AgentSnapshot {
    AgentSnapshot {
        share_id: id.into(),
        slug: slug.into(),
        status: AgentConnState::Connecting,
        target_port: 1,
        error: None,
    }
}

async fn assert_start_shutdown_overlap(stop_all: bool, cancel_shutdown: bool, cancel_start: bool) {
    let statuses = Arc::new(Mutex::new(HashMap::new()));
    let lifecycle = Arc::new(Mutex::new(AgentLifecycle {
        statuses: statuses.clone(),
        slots: HashMap::new(),
    }));
    let (entered, dropping) = oneshot::channel();
    let (release, gate) = std::sync::mpsc::channel();
    let hold = HoldTaskDrop {
        entered: Some(entered),
        release: gate,
    };
    let (running, started) = oneshot::channel();
    lifecycle
        .lock()
        .await
        .start(
            snapshot("share", "old"),
            Arc::new(AtomicBool::new(false)),
            async move {
                let _hold = hold;
                let _ = running.send(());
                std::future::pending::<()>().await;
            },
        )
        .await;
    timeout(TEST_TIMEOUT, started).await.unwrap().unwrap();

    let mut shutdown = tokio::spawn({
        let lifecycle = lifecycle.clone();
        async move {
            let mut lifecycle = lifecycle.lock().await;
            if stop_all {
                lifecycle.stop_all().await;
            } else {
                lifecycle.stop("share").await;
            }
        }
    });
    timeout(TEST_TIMEOUT, dropping).await.unwrap().unwrap();
    if cancel_shutdown {
        shutdown.abort();
        assert!(timeout(TEST_TIMEOUT, &mut shutdown)
            .await
            .unwrap()
            .unwrap_err()
            .is_cancelled());
    }

    // Stop All must also preserve a newly started, unrelated share.
    let new_id = if stop_all && !cancel_shutdown {
        "replacement"
    } else {
        "share"
    };
    let (new_running, new_started) = oneshot::channel();
    let (new_finished, new_dropped) = oneshot::channel::<()>();
    let mut start = Box::pin(async {
        lifecycle
            .lock()
            .await
            .start(
                snapshot(new_id, "new"),
                Arc::new(AtomicBool::new(false)),
                async move {
                    let _ = new_running.send(());
                    std::future::pending::<()>().await;
                    let _ = new_finished.send(());
                },
            )
            .await;
    });
    assert!(futures_util::poll!(&mut start).is_pending());
    assert_eq!(statuses.lock().await.get("share").unwrap().slug, "old");

    if cancel_start {
        drop(start);
        assert!(timeout(TEST_TIMEOUT, new_started).await.unwrap().is_err());
        assert!(timeout(TEST_TIMEOUT, new_dropped).await.unwrap().is_err());
        release.send(()).unwrap();
        timeout(TEST_TIMEOUT, shutdown).await.unwrap().unwrap();
        assert!(lifecycle.lock().await.slots.is_empty());
        assert!(statuses.lock().await.is_empty());
    } else {
        release.send(()).unwrap();
        if !cancel_shutdown {
            timeout(TEST_TIMEOUT, shutdown).await.unwrap().unwrap();
        }
        timeout(TEST_TIMEOUT, start).await.unwrap();
        timeout(TEST_TIMEOUT, new_started).await.unwrap().unwrap();
        assert_eq!(statuses.lock().await.len(), 1);
        assert_eq!(statuses.lock().await.get(new_id).unwrap().slug, "new");
        let mut lifecycle = lifecycle.lock().await;
        assert_eq!(lifecycle.slots.len(), 1);
        assert!(!lifecycle.slots.get(new_id).unwrap().handle.is_finished());
        lifecycle.stop_all().await;
        assert!(lifecycle.slots.is_empty());
        assert!(statuses.lock().await.is_empty());
        assert!(timeout(TEST_TIMEOUT, new_dropped).await.unwrap().is_err());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replacement_start_waits_for_stop_and_keeps_its_status() {
    assert_start_shutdown_overlap(false, false, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unrelated_start_waits_for_stop_all_and_keeps_its_status() {
    assert_start_shutdown_overlap(true, false, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_shutdown_still_joins_old_owner_before_start() {
    for stop_all in [false, true] {
        assert_start_shutdown_overlap(stop_all, true, false).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_start_waiting_for_shutdown_never_spawns_an_agent() {
    for stop_all in [false, true] {
        assert_start_shutdown_overlap(stop_all, false, true).await;
    }
}

#[tokio::test]
async fn active_stream_limit_rejects_without_dialing_and_recovers_after_close() {
    assert_eq!(
        MAX_ACTIVE_STREAMS, 256,
        "match the existing relay admission limit"
    );
    let (listener, target) = listener().await;
    let mut session = Session::start(target, 2).await;
    let mut sockets = Vec::new();
    for id in 1..=MAX_ACTIVE_STREAMS as i64 {
        session.open(id, protocol::MODE_TCP, "").await;
        let (socket, _) = timeout(TEST_TIMEOUT, listener.accept())
            .await
            .unwrap()
            .unwrap();
        sockets.push(socket);
        let end = session.frame("end").await;
        assert_eq!(end["stream_id"], id);
        assert_eq!(end["status"], 200);
    }
    session.open(1000, protocol::MODE_TCP, "").await;
    let refused = session.frame("end").await;
    assert_eq!(refused["stream_id"], 1000);
    assert_eq!(refused["status"], 503);
    assert_eq!(session.frame("close").await["stream_id"], 1000);
    let mut extra_dial = Box::pin(listener.accept());
    assert!(futures_util::poll!(&mut extra_dial).is_pending());
    drop(extra_dial);
    session.send(json!({ "type": "ping" })).await;
    session.frame("pong").await;

    session
        .send(json!({ "type": "close", "stream_id": 1 }))
        .await;
    assert_eq!(session.frame("close").await["stream_id"], 1);
    assert_closed(&mut sockets[0]).await;
    session.open(1001, protocol::MODE_TCP, "").await;
    let (socket, _) = timeout(TEST_TIMEOUT, listener.accept())
        .await
        .unwrap()
        .unwrap();
    sockets.push(socket);
    let end = session.frame("end").await;
    assert_eq!(end["stream_id"], 1001);
    assert_eq!(end["status"], 200);
    session.finish(Exit::Stop).await;
    for socket in &mut sockets {
        assert_closed(socket).await;
    }
}

#[tokio::test]
async fn duplicate_active_ids_end_the_session_without_replacing_the_owner() {
    let (listener, target) = listener().await;
    let mut session = Session::start(target, 2).await;
    session.open(1, protocol::MODE_TCP, "").await;
    let (mut socket, _) = timeout(TEST_TIMEOUT, listener.accept())
        .await
        .unwrap()
        .unwrap();
    session.frame("end").await;
    session.open(1, protocol::MODE_TCP, "").await;
    let outcome = timeout(TEST_TIMEOUT, &mut session.outcome)
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(outcome, SessionResult::Err(message) if message == "duplicate active stream id")
    );
    session.slot.take().unwrap().stop().await;
    assert_closed(&mut socket).await;
}

#[tokio::test]
async fn second_http_close_cancels_idle_body_without_stopping_the_relay() {
    let (listener, target) = listener().await;
    let mut session = Session::start(target, 1).await;
    session.open(1, "", "GET").await;
    let (mut socket, _) = accept_http(&listener).await;
    session
        .send(json!({ "type": "close", "stream_id": 1 }))
        .await;
    session.send(json!({ "type": "ping" })).await;
    session.frame("pong").await;
    socket
        .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n")
        .await
        .unwrap();
    assert_eq!(session.frame("end").await["status"], 200);
    assert_eq!(session.frame("data").await["chunk"], "YWJj");
    session
        .send(json!({ "type": "close", "stream_id": 1 }))
        .await;
    assert_eq!(session.frame("close").await["stream_id"], 1);
    assert_closed(&mut socket).await;
    session.send(json!({ "type": "ping" })).await;
    session.frame("pong").await;
    session.finish(Exit::Stop).await;
}

#[tokio::test]
async fn closed_request_input_does_not_cancel_http_response() {
    for version in [1, 2] {
        let (listener, target) = listener().await;
        let mut session = Session::start(target, version).await;
        session.open(1, "", "GET").await;
        let (mut socket, _) = accept_http(&listener).await;
        // GET deliberately drops its body receiver before sending local headers.
        session.request_data(version, 1, b"discarded input").await;
        session.send(json!({ "type": "ping" })).await;
        let pong = timeout(TEST_TIMEOUT, session.relay.as_mut().unwrap().next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let pong: Value = serde_json::from_str(pong.to_text().unwrap()).unwrap();
        assert_eq!(
            pong["type"], "pong",
            "closed input must keep the response alive"
        );

        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc")
            .await
            .unwrap();
        let end = timeout(TEST_TIMEOUT, session.relay.as_mut().unwrap().next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let end: Value = serde_json::from_str(end.to_text().unwrap()).unwrap();
        assert_eq!(
            end["type"], "end",
            "closed input must not terminate the response"
        );
        assert_eq!(end["status"], 200);
        let data = timeout(TEST_TIMEOUT, session.relay.as_mut().unwrap().next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        if version == 2 {
            assert_eq!(decode_data_frame(&data.into_data()), Some((1, &b"abc"[..])));
        } else {
            let data: Value = serde_json::from_str(data.to_text().unwrap()).unwrap();
            assert_eq!(data["type"], "data");
            assert_eq!(data["chunk"], "YWJj");
        }
        assert_eq!(session.frame("close").await["stream_id"], 1);
        session.send(json!({ "type": "ping" })).await;
        session.frame("pong").await;
        session.finish(Exit::Stop).await;
    }
}

#[tokio::test]
async fn full_request_input_still_cancels_only_the_overloaded_stream() {
    for version in [1, 2] {
        let (listener, target) = listener().await;
        let mut session = Session::start(target, version).await;
        session.open(1, protocol::MODE_STREAM, "GET").await;
        let (mut socket, _) = accept_http(&listener).await;
        // Uplink is not consumed while the local upgrade response is pending.
        // More than the input queue can hold must still cancel this stream.
        for _ in 0..64 {
            session.request_data(version, 1, b"x").await;
        }
        assert_eq!(session.frame("close").await["stream_id"], 1);
        assert_closed(&mut socket).await;
        session.send(json!({ "type": "ping" })).await;
        session.frame("pong").await;
        session.finish(Exit::Stop).await;
    }
}

#[tokio::test]
async fn stalled_relay_writer_does_not_block_session_shutdown() {
    for exit in [Exit::Cancel, Exit::ShareStopped, Exit::Stop] {
        let (listener, target) = listener().await;
        let mut session = Session::start(target, 2).await;
        session.open(1, protocol::MODE_TCP, "").await;
        let (mut socket, _) = timeout(TEST_TIMEOUT, listener.accept())
            .await
            .unwrap()
            .unwrap();
        session.frame("end").await;
        let blocked = session.pause_writer();
        socket.write_all(b"response data").await.unwrap();
        timeout(TEST_TIMEOUT, blocked).await.unwrap().unwrap();
        session.finish(exit).await;
        assert_closed(&mut socket).await;
    }
}

async fn assert_coalesced_pings(version: i32, stall_pong: bool) {
    use crate::share::outbound::CONTROL_QUEUE_MESSAGES;
    let (listener, target) = listener().await;
    let mut session = Session::start(target, version).await;
    session.open(1, protocol::MODE_TCP, "").await;
    let (mut socket, _) = timeout(TEST_TIMEOUT, listener.accept())
        .await
        .unwrap()
        .unwrap();
    session.frame("end").await;
    let blocked = session.pause_writer();
    if stall_pong {
        session.send(json!({ "type": "ping" })).await;
    } else {
        socket.write_all(b"response data").await.unwrap();
    }
    timeout(TEST_TIMEOUT, blocked).await.unwrap().unwrap();
    for _ in 0..CONTROL_QUEUE_MESSAGES * 4 {
        session.send(json!({ "type": "ping" })).await;
    }
    // Uplink receipt is a barrier: the reader processed every preceding Ping
    // while the relay writer was still parked.
    session.request_data(version, 1, b"barrier").await;
    let mut barrier = [0; 7];
    timeout(TEST_TIMEOUT, socket.read_exact(&mut barrier))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&barrier, b"barrier");
    assert!(matches!(
        session.outcome.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    session.resume_writer();

    if stall_pong {
        // One reply was in flight; the entire later burst needs one further reply.
        for _ in 0..2 {
            let frame = session.next_frame().await;
            let value: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
            assert_eq!(value["type"], "pong");
        }
    } else {
        let mut pongs = 0;
        let mut got_data = false;
        while pongs == 0 || !got_data {
            match session.next_frame().await {
                Message::Binary(raw) => {
                    assert_eq!(version, 2);
                    assert_eq!(decode_data_frame(&raw), Some((1, &b"response data"[..])));
                    assert!(!got_data);
                    got_data = true;
                }
                Message::Text(text) => {
                    let value: Value = serde_json::from_str(&text).unwrap();
                    if value["type"] == "pong" {
                        pongs += 1;
                        assert_eq!(pongs, 1, "the parked burst must be coalesced");
                    } else {
                        assert_eq!(version, 1);
                        assert_eq!(value["type"], "data");
                        assert_eq!(value["chunk"], "cmVzcG9uc2UgZGF0YQ==");
                        assert!(!got_data);
                        got_data = true;
                    }
                }
                other => panic!("unexpected relay frame {other:?}"),
            }
        }
    }
    session.send(json!({ "type": "ping" })).await;
    let frame = session.next_frame().await;
    let value: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
    assert_eq!(
        value["type"], "pong",
        "later Pings must still receive a reply"
    );
    session.finish(Exit::Stop).await;
    assert_closed(&mut socket).await;
}

#[tokio::test]
async fn ping_burst_during_stalled_data_coalesces_without_disconnect() {
    for version in [1, 2] {
        assert_coalesced_pings(version, false).await;
    }
}

#[tokio::test]
async fn pings_during_stalled_pong_keep_one_further_reply_pending() {
    for version in [1, 2] {
        assert_coalesced_pings(version, true).await;
    }
}

#[tokio::test]
async fn http_asset_burst_above_old_limit_completes_without_rejection() {
    use std::collections::HashSet;
    const REQUESTS: i64 = 96;
    for version in [1, 2] {
        let (listener, target) = listener().await;
        let mut session = Session::start(target, version).await;
        // Resolve the loopback family once, then retain all requests simultaneously.
        session.open(1, "", "GET").await;
        let (socket, _) = accept_http(&listener).await;
        let mut sockets = vec![socket];
        for id in 2..=REQUESTS {
            session.open(id, "", "GET").await;
        }
        for _ in 2..=REQUESTS {
            sockets.push(accept_http(&listener).await.0);
        }
        for mut socket in sockets {
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc")
                .await
                .unwrap();
        }
        timeout(TEST_TIMEOUT, async {
            let mut headers = HashSet::new();
            let mut bodies = HashMap::<i64, Vec<u8>>::new();
            let mut closed = HashSet::new();
            while closed.len() < REQUESTS as usize {
                match session.next_frame().await {
                    Message::Binary(raw) => {
                        assert_eq!(version, 2);
                        let (id, bytes) = decode_data_frame(&raw).unwrap();
                        assert!(headers.contains(&id));
                        assert!(!closed.contains(&id));
                        bodies.entry(id).or_default().extend_from_slice(bytes);
                    }
                    Message::Text(text) => {
                        let value: Value = serde_json::from_str(&text).unwrap();
                        let id = value["stream_id"].as_i64().unwrap();
                        assert!((1..=REQUESTS).contains(&id));
                        match value["type"].as_str().unwrap() {
                            "end" => {
                                assert_eq!(value["status"], 200);
                                assert!(headers.insert(id));
                            }
                            "data" => {
                                assert_eq!(version, 1);
                                assert!(headers.contains(&id));
                                assert!(!closed.contains(&id));
                                let bytes = base64::engine::general_purpose::STANDARD
                                    .decode(value["chunk"].as_str().unwrap())
                                    .unwrap();
                                bodies.entry(id).or_default().extend_from_slice(&bytes);
                            }
                            "close" => {
                                assert!(headers.contains(&id));
                                assert_eq!(bodies.get(&id).unwrap(), b"abc");
                                assert!(closed.insert(id));
                            }
                            other => panic!("unexpected relay frame {other}"),
                        }
                    }
                    other => panic!("unexpected relay frame {other:?}"),
                }
            }
            assert_eq!(headers.len(), REQUESTS as usize);
        })
        .await
        .expect("asset request burst completed");
        session.send(json!({ "type": "ping" })).await;
        session.frame("pong").await;
        session.finish(Exit::Stop).await;
    }
}

#[tokio::test]
async fn slow_relay_resumes_large_transfers_without_losing_or_reordering_bytes() {
    use crate::share::outbound::{DATA_CHUNK_BYTES, DATA_QUEUE_BYTES};
    for version in [1, 2] {
        let (listener, target) = listener().await;
        let mut session = Session::start(target, version).await;
        session.open(1, protocol::MODE_TCP, "").await;
        let (mut socket, _) = timeout(TEST_TIMEOUT, listener.accept())
            .await
            .unwrap()
            .unwrap();
        session.frame("end").await;
        let blocked = session.pause_writer();
        let total = DATA_QUEUE_BYTES * 2 + 123;
        let producer = tokio::spawn(async move {
            let mut sent = 0;
            let mut block = vec![0; DATA_CHUNK_BYTES];
            while sent < total {
                let length = block.len().min(total - sent);
                for (i, byte) in block[..length].iter_mut().enumerate() {
                    *byte = ((sent + i) % 251) as u8;
                }
                socket.write_all(&block[..length]).await.unwrap();
                sent += length;
            }
            socket
        });
        timeout(TEST_TIMEOUT, blocked).await.unwrap().unwrap();
        session.resume_writer();
        timeout(TEST_TIMEOUT, async {
            let mut received = 0;
            while received < total {
                let frame = session
                    .relay
                    .as_mut()
                    .unwrap()
                    .next()
                    .await
                    .unwrap()
                    .unwrap();
                let data = match frame {
                    Message::Binary(raw) => {
                        let (id, bytes) = decode_data_frame(&raw).unwrap();
                        assert_eq!(id, 1);
                        bytes.to_vec()
                    }
                    Message::Text(text) => {
                        let value: Value = serde_json::from_str(&text).unwrap();
                        assert_eq!(value["type"], "data");
                        assert_eq!(value["stream_id"], 1);
                        base64::engine::general_purpose::STANDARD
                            .decode(value["chunk"].as_str().unwrap())
                            .unwrap()
                    }
                    other => panic!("unexpected relay frame {other:?}"),
                };
                for (i, byte) in data.iter().enumerate() {
                    assert_eq!(*byte, ((received + i) % 251) as u8);
                }
                received += data.len();
                tokio::task::yield_now().await;
            }
            assert_eq!(received, total);
        })
        .await
        .expect("large transfer resumed after relay stall");
        let mut socket = timeout(TEST_TIMEOUT, producer).await.unwrap().unwrap();
        session.send(json!({ "type": "ping" })).await;
        session.frame("pong").await;
        session.finish(Exit::Stop).await;
        assert_closed(&mut socket).await;
    }
}
