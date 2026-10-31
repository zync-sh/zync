//! SOCKS timeout/cancellation checks against an encrypted in-memory SSH echo peer.
//! Only the disposable SOCKS client uses loopback sockets; no destination is dialed.

use super::*;
use russh::{server, Channel, ChannelOpenFailure};
use std::sync::Mutex as StdMutex;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Notify};
use tokio::time::{sleep, timeout};

const DEADLINE: Duration = Duration::from_secs(10);
const PORT: u16 = 4242;

struct Task<T>(tokio::task::JoinHandle<T>);

impl<T> Task<T> {
    async fn result(&mut self) -> T {
        timeout(DEADLINE, &mut self.0)
            .await
            .expect("fixture task deadline")
            .expect("fixture task failed")
    }
}

impl<T> Drop for Task<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Behavior {
    Echo,
    HoldFirstOpen,
    Refuse,
}

#[derive(Default)]
struct Observed {
    targets: StdMutex<Vec<(String, u32, String, u32)>>,
    opening: Notify,
    release: Notify,
}

struct Server {
    behavior: Behavior,
    observed: Arc<Observed>,
    tasks: tokio::task::JoinSet<()>,
}

impl server::Handler for Server {
    type Error = anyhow::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<server::Auth> {
        Ok(if user == "fixture" && password == "fixture-only-secret" {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<server::Msg>,
        host: &str,
        port: u32,
        origin: &str,
        origin_port: u32,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> Result<()> {
        let count = {
            let mut targets = self.observed.targets.lock().unwrap();
            targets.push((host.into(), port, origin.into(), origin_port));
            targets.len()
        };
        self.observed.opening.notify_one();
        if self.behavior == Behavior::HoldFirstOpen && count == 1 {
            self.observed.release.notified().await;
            reply.reject(ChannelOpenFailure::ConnectFailed).await;
        } else if self.behavior == Behavior::Refuse {
            reply.reject(ChannelOpenFailure::ConnectFailed).await;
        } else {
            reply.accept().await;
            self.tasks.spawn(async move {
                let (mut read, mut write) = tokio::io::split(channel.into_stream());
                let _ = tokio::io::copy(&mut read, &mut write).await;
                let _ = write.shutdown().await;
            });
        }
        Ok(())
    }
}

struct Fixture {
    session: Arc<Mutex<Handle<Client>>>,
    observed: Arc<Observed>,
    stop: broadcast::Sender<()>,
    failure: SessionFailureSender,
    failures: mpsc::UnboundedReceiver<String>,
    _server: Task<()>,
}

impl Fixture {
    async fn new(behavior: Behavior) -> Self {
        let key = russh::keys::PrivateKey::random(
            &mut russh::keys::key::safe_rng(),
            russh::keys::Algorithm::Ed25519,
        )
        .unwrap();
        let public = key.public_key().clone();
        let config = Arc::new(server::Config {
            keys: vec![key],
            auth_rejection_time: Duration::ZERO,
            auth_rejection_time_initial: Some(Duration::ZERO),
            ..Default::default()
        });
        let observed = Arc::new(Observed::default());
        let handler = Server {
            behavior,
            observed: observed.clone(),
            tasks: tokio::task::JoinSet::new(),
        };
        let (local, remote) = tokio::io::duplex(64 * 1024);
        let server = Task(tokio::spawn(async move {
            let running = server::run_stream(config, remote, handler).await.unwrap();
            let _ = running.await;
        }));
        let session = crate::ssh::connect_runtime_stream_fixture(
            local,
            public,
            "fixture",
            "fixture-only-secret",
        )
        .await
        .unwrap();
        let (stop, _) = broadcast::channel(4);
        let (failure, failures) = mpsc::unbounded_channel();
        Self {
            session: Arc::new(Mutex::new(session)),
            observed,
            stop,
            failure,
            failures,
            _server: server,
        }
    }

    async fn client(&self) -> (TcpStream, Task<Result<()>>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (mut proxy, _) = listener.accept().await.unwrap();
        let session = self.session.clone();
        let failure = self.failure.clone();
        let stop = self.stop.clone();
        let mut cancel = stop.subscribe();
        let task = Task(tokio::spawn(async move {
            run_socks5_client(
                &mut proxy,
                session,
                "socks-fixture",
                &failure,
                &stop,
                &mut cancel,
            )
            .await
        }));
        (client, task)
    }

    async fn connect(&self, request: &[u8]) -> (TcpStream, Task<Result<()>>) {
        let (mut client, task) = self.client().await;
        greeting(&mut client).await;
        client.write_all(request).await.unwrap();
        let mut reply = [0; 10];
        timeout(DEADLINE, client.read_exact(&mut reply))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reply, connect_success_reply());
        (client, task)
    }

    fn assert_no_failure(&mut self) {
        assert!(matches!(
            self.failures.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
    }
}

fn requests() -> Vec<(Vec<u8>, &'static str)> {
    let mut ipv4 = vec![VERSION, CMD_CONNECT, 0, ATYP_IPV4, 127, 0, 0, 1];
    ipv4.extend_from_slice(&PORT.to_be_bytes());
    let mut domain = vec![VERSION, CMD_CONNECT, 0, ATYP_DOMAIN, 15];
    domain.extend_from_slice(b"fixture.invalid");
    domain.extend_from_slice(&PORT.to_be_bytes());
    let mut ipv6 = vec![VERSION, CMD_CONNECT, 0, ATYP_IPV6];
    ipv6.extend_from_slice(&std::net::Ipv6Addr::LOCALHOST.octets());
    ipv6.extend_from_slice(&PORT.to_be_bytes());
    vec![
        (ipv4, "127.0.0.1"),
        (domain, "fixture.invalid"),
        (ipv6, "0:0:0:0:0:0:0:1"),
    ]
}

async fn greeting(client: &mut TcpStream) {
    client
        .write_all(&[VERSION, 1, socks5::METHOD_NO_AUTH])
        .await
        .unwrap();
    let mut reply = [0; 2];
    timeout(DEADLINE, client.read_exact(&mut reply))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reply, method_selection_reply());
}

async fn echo(client: &mut TcpStream, bytes: &[u8]) {
    timeout(DEADLINE, async {
        client.write_all(bytes).await.unwrap();
        let mut received = vec![0; bytes.len()];
        client.read_exact(&mut received).await.unwrap();
        assert_eq!(received, bytes);
    })
    .await
    .unwrap();
}

async fn closed(client: &mut TcpStream) -> Vec<u8> {
    timeout(DEADLINE, async {
        let mut bytes = Vec::new();
        match client.read_to_end(&mut bytes).await {
            Ok(_) => {}
            // Windows can reset a cancelled socket with an unread request.
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
            Err(error) => panic!("unexpected SOCKS close error: {error}"),
        }
        bytes
    })
    .await
    .expect("SOCKS client must close")
}

#[tokio::test]
async fn established_socks_connections_relay_after_handshake_deadline() {
    let mut fixture = Fixture::new(Behavior::Echo).await;
    let mut clients = Vec::new();
    for (request, _) in requests() {
        let (mut client, task) = fixture.connect(&request).await;
        echo(&mut client, b"before deadline\0\xff").await;
        clients.push((client, task));
    }
    sleep(SOCKS_HANDSHAKE_TIMEOUT + Duration::from_millis(250)).await;
    for (client, task) in &mut clients {
        assert!(
            !task.0.is_finished(),
            "handshake timeout must not bound an established relay"
        );
        echo(client, b"after deadline\xff\0").await;
    }
    let targets = fixture.observed.targets.lock().unwrap().clone();
    for (_, host) in requests() {
        assert!(targets.contains(&(host.into(), PORT as u32, "127.0.0.1".into(), 0)));
    }
    let (mut finishing, mut finishing_task) = fixture.connect(&requests()[0].0).await;
    echo(&mut finishing, b"normal client completion").await;
    finishing.shutdown().await.unwrap();
    assert!(closed(&mut finishing).await.is_empty());
    finishing_task.result().await.unwrap();
    fixture.stop.send(()).unwrap();
    for (client, task) in &mut clients {
        task.result().await.unwrap();
        assert!(closed(client).await.is_empty());
    }
    fixture.assert_no_failure();
}

#[tokio::test]
async fn incomplete_setup_and_session_lock_wait_keep_the_handshake_deadline() {
    let mut fixture = Fixture::new(Behavior::Echo).await;
    let guard = fixture.session.lock().await;
    let (mut greeting_client, mut greeting_task) = fixture.client().await;
    greeting_client.write_all(&[VERSION]).await.unwrap();
    let (mut target_client, mut target_task) = fixture.client().await;
    greeting(&mut target_client).await;
    target_client
        .write_all(&[VERSION, CMD_CONNECT, 0, ATYP_DOMAIN, 15])
        .await
        .unwrap();
    let (mut lock_client, mut lock_task) = fixture.client().await;
    greeting(&mut lock_client).await;
    lock_client.write_all(&requests()[0].0).await.unwrap();
    let mut stopped = fixture.stop.subscribe();
    greeting_task.result().await.unwrap();
    target_task.result().await.unwrap();
    lock_task.result().await.unwrap();
    assert!(closed(&mut greeting_client).await.is_empty());
    assert!(closed(&mut target_client).await.is_empty());
    assert!(closed(&mut lock_client).await.is_empty());
    assert!(fixture.observed.targets.lock().unwrap().is_empty());
    assert!(matches!(
        stopped.try_recv(),
        Err(broadcast::error::TryRecvError::Empty)
    ));
    drop(guard);
    let (mut client, mut task) = fixture.connect(&requests()[0].0).await;
    echo(&mut client, b"session still usable").await;
    fixture.stop.send(()).unwrap();
    task.result().await.unwrap();
    fixture.assert_no_failure();
}

#[tokio::test]
async fn pending_ssh_open_keeps_the_deadline_and_releases_the_session_lock() {
    let mut fixture = Fixture::new(Behavior::HoldFirstOpen).await;
    let (mut client, mut task) = fixture.client().await;
    greeting(&mut client).await;
    client.write_all(&requests()[0].0).await.unwrap();
    timeout(DEADLINE, fixture.observed.opening.notified())
        .await
        .unwrap();
    task.result().await.unwrap();
    assert!(closed(&mut client).await.is_empty());
    assert!(fixture.session.try_lock().is_ok());
    fixture.observed.release.notify_one();
    let (mut next, mut task) = fixture.connect(&requests()[0].0).await;
    echo(&mut next, b"reuse after setup timeout").await;
    fixture.stop.send(()).unwrap();
    task.result().await.unwrap();
    fixture.assert_no_failure();
}

#[tokio::test]
async fn stop_interrupts_greeting_request_and_pending_channel_setup() {
    for behavior in [Behavior::Echo, Behavior::HoldFirstOpen] {
        let mut fixture = Fixture::new(behavior).await;
        let mut clients = Vec::new();
        let (client, task) = fixture.client().await;
        clients.push((client, task));
        let (mut client, task) = fixture.client().await;
        greeting(&mut client).await;
        clients.push((client, task));
        let lock = if behavior == Behavior::Echo {
            Some(fixture.session.lock().await)
        } else {
            None
        };
        let (mut client, task) = fixture.client().await;
        greeting(&mut client).await;
        client.write_all(&requests()[0].0).await.unwrap();
        clients.push((client, task));
        if behavior == Behavior::HoldFirstOpen {
            timeout(DEADLINE, fixture.observed.opening.notified())
                .await
                .unwrap();
        }
        fixture.stop.send(()).unwrap();
        timeout(SOCKS_HANDSHAKE_TIMEOUT / 2, async {
            for (client, task) in &mut clients {
                let _ = task.result().await;
                let _ = closed(client).await;
            }
        })
        .await
        .expect("stop must interrupt setup before its deadline");
        drop(lock);
        assert!(fixture.session.try_lock().is_ok());
        fixture.assert_no_failure();
    }
}

#[tokio::test]
async fn rejected_connect_and_invalid_requests_preserve_socks_error_replies() {
    let mut fixture = Fixture::new(Behavior::Refuse).await;
    let mut stopped = fixture.stop.subscribe();
    for (request, expected) in [
        (requests()[0].0.clone(), socks5::REP_GENERAL_FAILURE),
        (
            vec![VERSION, 3, 0, ATYP_IPV4],
            socks5::REP_CMD_NOT_SUPPORTED,
        ),
        (
            vec![VERSION, CMD_CONNECT, 0, 0x7f],
            socks5::REP_ATYP_NOT_SUPPORTED,
        ),
    ] {
        let (mut client, mut task) = fixture.client().await;
        greeting(&mut client).await;
        client.write_all(&request).await.unwrap();
        let mut reply = [0; 10];
        timeout(DEADLINE, client.read_exact(&mut reply))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reply, error_reply(expected));
        assert!(task.result().await.is_err());
        assert!(closed(&mut client).await.is_empty());
    }
    assert_eq!(fixture.observed.targets.lock().unwrap().len(), 1);
    fixture.assert_no_failure();
    assert!(matches!(
        stopped.try_recv(),
        Err(broadcast::error::TryRecvError::Empty)
    ));
}

#[tokio::test]
async fn fatal_session_loss_still_reports_and_stops_the_tunnel() {
    let mut fixture = Fixture::new(Behavior::Echo).await;
    fixture
        .session
        .lock()
        .await
        .disconnect(russh::Disconnect::ByApplication, "fixture done", "")
        .await
        .unwrap();
    timeout(DEADLINE, async {
        while !fixture.session.lock().await.is_closed() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let mut stopped = fixture.stop.subscribe();
    let (mut client, mut task) = fixture.client().await;
    greeting(&mut client).await;
    client.write_all(&requests()[0].0).await.unwrap();
    let mut reply = [0; 10];
    timeout(DEADLINE, client.read_exact(&mut reply))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reply, error_reply(socks5::REP_GENERAL_FAILURE));
    assert!(task.result().await.is_err());
    assert_eq!(
        timeout(DEADLINE, fixture.failures.recv())
            .await
            .unwrap()
            .unwrap(),
        "socks-fixture"
    );
    timeout(DEADLINE, stopped.recv()).await.unwrap().unwrap();
}
