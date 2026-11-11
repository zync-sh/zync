//! Local bridge, direct TCP, and encrypted SSH tests. The mock SSH peer never dials a destination.

use super::bridge::relay;
use super::*;
use crate::types::{AuthMethod, ConnectionConfig};
use futures_util::{SinkExt, StreamExt};
use russh::{keys, server, Channel};
use tokio::{
    io::{self, AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::oneshot,
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest,
        http::{header, HeaderValue, StatusCode},
        protocol::{
            frame::{
                coding::{CloseCode, Data, OpCode},
                Frame,
            },
            Message,
        },
        Error,
    },
    MaybeTlsStream, WebSocketStream,
};

const ORIGIN: &str = "http://tauri.localhost";
const HOST_ID: &str = "vnc-fixture";
const VNC_PORT: u16 = 5901;

type Viewer = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn offer() -> (TcpListener, Offer, String) {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let offer = Offer::new(listener.local_addr().unwrap(), ORIGIN.into());
    let url = offer.websocket_url();
    (listener, offer, url)
}

fn request(url: &str, origin: &'static str) -> tokio_tungstenite::tungstenite::http::Request<()> {
    let mut request = url.into_client_request().unwrap();
    request
        .headers_mut()
        .insert(header::ORIGIN, HeaderValue::from_static(origin));
    request
}

async fn connect(url: &str) -> Viewer {
    connect_async(request(url, ORIGIN)).await.unwrap().0
}

async fn staged_vault_bridge(
    key: impl Future<Output = Option<zeroize::Zeroizing<[u8; 8]>>> + Send + 'static,
) -> (
    Viewer,
    io::DuplexStream,
    tokio::task::JoinHandle<Result<(), vault_auth::Failure>>,
) {
    let (listener, offer, url) = offer().await;
    let (remote, mut stream) = io::duplex(1024);
    let bridge = tokio::spawn(async move {
        let mut viewer = accept_viewer(listener, offer).await.unwrap();
        vault_auth::negotiate(&mut viewer, &mut stream, key).await?;
        relay(&mut viewer, stream).await.unwrap();
        Ok(())
    });
    (connect(&url).await, remote, bridge)
}

async fn viewer_data(viewer: &mut Viewer) -> Vec<u8> {
    timeout(Duration::from_secs(3), viewer.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .into_data()
        .to_vec()
}

const RFB_VERSION: &[u8; 12] = b"RFB 003.008\n";
const VNC_CHALLENGE: [u8; 16] = 0x00112233445566778899aabbccddeeff_u128.to_be_bytes();
const VNC_RESPONSE: [u8; 16] = 0x80e8c0a9d42904a7bc348b1be27369e8_u128.to_be_bytes();

fn vnc_fixture_key() -> zeroize::Zeroizing<[u8; 8]> {
    zeroize::Zeroizing::new(b"zyncpass".map(u8::reverse_bits))
}

#[tokio::test]
async fn vault_authenticates_the_server_and_relays_client_init_without_viewer_password() {
    let (mut viewer, mut remote, bridge) =
        staged_vault_bridge(std::future::ready(Some(vnc_fixture_key()))).await;
    let server = tokio::spawn(async move {
        remote.write_all(&RFB_VERSION[..4]).await.unwrap();
        remote.write_all(&RFB_VERSION[4..]).await.unwrap();
        let mut version = [0; RFB_VERSION.len()];
        remote.read_exact(&mut version).await.unwrap();
        assert_eq!(&version, RFB_VERSION);
        remote.write_all(&[2, 2, 19]).await.unwrap();
        assert_eq!(remote.read_u8().await.unwrap(), 2);
        remote.write_all(&VNC_CHALLENGE).await.unwrap();
        let mut response = [0; 16];
        remote.read_exact(&mut response).await.unwrap();
        assert_eq!(response, VNC_RESPONSE);
        remote.write_u32(0).await.unwrap();
        assert_eq!(
            remote.read_u8().await.unwrap(),
            1,
            "ClientInit remains intact"
        );
        remote.write_all(b"server-init").await.unwrap();
    });

    assert_eq!(viewer_data(&mut viewer).await, RFB_VERSION);
    viewer
        .send(Message::binary(RFB_VERSION[..4].to_vec()))
        .await
        .unwrap();
    viewer
        .send(Message::binary(RFB_VERSION[4..].to_vec()))
        .await
        .unwrap();
    assert_eq!(viewer_data(&mut viewer).await, [1, 1]);
    // The local security choice and ClientInit may arrive in the same binary message.
    viewer.send(Message::binary(vec![1, 1])).await.unwrap();
    assert_eq!(viewer_data(&mut viewer).await, [0; 4]);
    assert_eq!(viewer_data(&mut viewer).await, b"server-init");
    server.await.unwrap();
    assert_eq!(bridge.await.unwrap(), Ok(()));
}

#[tokio::test]
async fn vault_preserves_manual_security_offers_and_only_reads_eligible_credentials() {
    for (security, lookup, selected) in [
        ([2, 19, 2], false, 19),
        ([2, 1, 2], false, 1),
        ([2, 2, 1], true, 2),
    ] {
        let looked_up = Arc::new(AtomicBool::new(false));
        let (mut viewer, mut remote, bridge) = staged_vault_bridge({
            let looked_up = looked_up.clone();
            async move {
                looked_up.store(true, Ordering::Relaxed);
                None
            }
        })
        .await;
        remote.write_all(RFB_VERSION).await.unwrap();
        assert_eq!(viewer_data(&mut viewer).await, RFB_VERSION);
        viewer
            .send(Message::binary(RFB_VERSION.to_vec()))
            .await
            .unwrap();
        let mut version = [0; RFB_VERSION.len()];
        remote.read_exact(&mut version).await.unwrap();
        assert_eq!(&version, RFB_VERSION);
        remote.write_all(&security).await.unwrap();
        assert_eq!(viewer_data(&mut viewer).await, security);
        assert_eq!(looked_up.load(Ordering::Relaxed), lookup);
        viewer.send(Message::binary(vec![selected])).await.unwrap();
        assert_eq!(remote.read_u8().await.unwrap(), selected);
        drop(remote);
        assert_eq!(bridge.await.unwrap(), Ok(()));
    }
}

#[tokio::test]
async fn vault_leaves_older_rfb_versions_on_the_original_stream() {
    let (mut viewer, mut remote, bridge) =
        staged_vault_bridge(async { panic!("An older server must not use the Vault key") }).await;
    let version = b"RFB 003.003\n";
    remote.write_all(version).await.unwrap();
    assert_eq!(viewer_data(&mut viewer).await, version);
    viewer
        .send(Message::binary(version.to_vec()))
        .await
        .unwrap();
    let mut selected = [0; 12];
    remote.read_exact(&mut selected).await.unwrap();
    assert_eq!(&selected, version);
    remote.write_u32(2).await.unwrap();
    assert_eq!(viewer_data(&mut viewer).await, [0, 0, 0, 2]);
    drop(remote);
    assert_eq!(bridge.await.unwrap(), Ok(()));
}

#[tokio::test]
async fn vault_rejection_never_exposes_remote_failure_text_or_emits_local_success() {
    let (mut viewer, mut remote, bridge) =
        staged_vault_bridge(std::future::ready(Some(vnc_fixture_key()))).await;
    remote.write_all(RFB_VERSION).await.unwrap();
    assert_eq!(viewer_data(&mut viewer).await, RFB_VERSION);
    viewer
        .send(Message::binary(RFB_VERSION.to_vec()))
        .await
        .unwrap();
    let mut version = [0; RFB_VERSION.len()];
    remote.read_exact(&mut version).await.unwrap();
    remote.write_all(&[1, 2]).await.unwrap();
    assert_eq!(remote.read_u8().await.unwrap(), 2);
    remote.write_all(&VNC_CHALLENGE).await.unwrap();
    let mut response = [0; 16];
    remote.read_exact(&mut response).await.unwrap();
    remote
        .write_all(b"\0\0\0\x01\0\0\0\x07private")
        .await
        .unwrap();
    assert_eq!(
        bridge.await.unwrap().unwrap_err().reason(),
        "vnc-vault-auth-rejected"
    );
    assert!(!matches!(viewer.next().await, Some(Ok(Message::Binary(_)))));
}

#[test]
fn stops_cannot_be_overtaken_and_cancelled_admission_remains_counted_until_drop() {
    let sessions = VncSessions::default();
    let stopped = Uuid::new_v4();
    sessions.stop(stopped);
    assert!(matches!(sessions.reserve(stopped), Err(CANCELLED)));

    let active: Vec<_> = (0..MAX_SESSIONS)
        .map(|_| sessions.reserve(Uuid::new_v4()).unwrap())
        .collect();
    assert!(sessions.reserve(active[0].id).is_err());
    sessions.stop(active[0].id);
    assert!(*active[0].cancelled.borrow());
    assert!(sessions.reserve(Uuid::new_v4()).is_err());
    sessions.cancel_all();
    assert!(active.iter().all(|lease| *lease.cancelled.borrow()));
    drop(active);
    assert!(sessions.reserve(Uuid::new_v4()).is_ok());
}

#[test]
fn trusted_origin_is_exact_and_development_is_explicit() {
    let dev = url::Url::parse("http://localhost:1420").unwrap();
    for (url, expected) in [
        ("tauri://localhost/", Some("tauri://localhost")),
        ("http://tauri.localhost/settings", Some(ORIGIN)),
        ("https://tauri.localhost/", Some("https://tauri.localhost")),
        ("http://localhost:1420/", Some("http://localhost:1420")),
        ("http://localhost:1421/", None),
        ("http://tauri.localhost:1420/", None),
        ("http://tauri.localhost.invalid/", None),
        ("blob:http://tauri.localhost/fixture", None),
        ("tauri://plugin.localhost/", None),
        ("file:///viewer.html", None),
    ] {
        assert_eq!(
            trusted_origin(&url::Url::parse(url).unwrap(), Some(&dev)).as_deref(),
            expected
        );
    }
    assert!(trusted_origin(&dev, None).is_none());
}

#[tokio::test]
async fn viewer_requires_exact_origin_host_and_one_use_token() {
    let (listener, offer, url) = offer().await;
    let address = listener.local_addr().unwrap();
    let serving = tokio::spawn(accept_viewer(listener, offer));

    let mut bad_host = request(&url, ORIGIN);
    bad_host
        .headers_mut()
        .insert(header::HOST, HeaderValue::from_static("untrusted.invalid"));
    let mut duplicate = request(&url, ORIGIN);
    duplicate
        .headers_mut()
        .append(header::ORIGIN, HeaderValue::from_static(ORIGIN));
    for unauthorized in [
        request(&url, "null"),
        request(&url, "https://untrusted.invalid"),
        request(&format!("ws://{address}/vnc/incorrect"), ORIGIN),
        request(&format!("{url}?target=other"), ORIGIN),
        bad_host,
        duplicate,
    ] {
        assert!(
            matches!(connect_async(unauthorized).await, Err(Error::Http(response)) if response.status() == StatusCode::FORBIDDEN)
        );
    }

    let _viewer = connect(&url).await;
    let _server = serving.await.unwrap().unwrap();
    assert!(TcpStream::connect(address).await.is_err());
}

#[test]
fn direct_vnc_accepts_host_only_endpoints() {
    for host in [
        "localhost",
        "vnc-host.example.",
        "127.0.0.1",
        "::1",
        "[::1]",
    ] {
        assert!(direct::Endpoint::parse(host, VNC_PORT).is_ok(), "{host}");
    }
    for host in [
        "",
        "host name",
        "vnc.example:5901",
        "[::1]:5901",
        "vnc://host",
        "127.1",
        "127.000.0.1",
        "256.0.0.1",
        "host/path",
        "user@host",
        "host?x",
        "host#x",
        "host\\path",
        "fe80::1%lo",
        "-host",
        "host..local",
    ] {
        assert!(direct::Endpoint::parse(host, VNC_PORT).is_err(), "{host}");
    }
    assert!(validate_port(0).is_err());
}

#[tokio::test]
async fn direct_vnc_dials_only_after_authorization_and_closes_on_stop() {
    let remote_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let endpoint =
        direct::Endpoint::parse("127.0.0.1", remote_listener.local_addr().unwrap().port()).unwrap();
    let (listener, offer, url) = offer().await;
    let sessions = VncSessions::default();
    let id = Uuid::new_v4();
    let lease = sessions.reserve(id).unwrap();
    let task = tokio::spawn(direct::run(listener, offer, endpoint, None, lease));

    assert!(matches!(
        connect_async(request(&url, "https://untrusted.invalid")).await,
        Err(Error::Http(response)) if response.status() == StatusCode::FORBIDDEN
    ));
    assert!(
        timeout(Duration::from_millis(100), remote_listener.accept())
            .await
            .is_err()
    );

    let mut viewer = connect(&url).await;
    let (mut remote, _) = timeout(Duration::from_secs(2), remote_listener.accept())
        .await
        .unwrap()
        .unwrap();
    remote.write_all(b"RFB 003.008\n").await.unwrap();
    let version = timeout(Duration::from_secs(2), viewer.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(version.into_data().as_ref(), b"RFB 003.008\n");
    viewer
        .send(Message::binary(b"\x01".as_slice()))
        .await
        .unwrap();
    let mut reply = [0];
    timeout(Duration::from_secs(2), remote.read_exact(&mut reply))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reply, [1]);

    sessions.stop(id);
    assert_eq!(
        timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap(),
        Ok(())
    );
    assert_eq!(remote.read(&mut reply).await.unwrap(), 0);
    assert!(sessions.0.lock().unwrap().active.is_empty());
}

#[tokio::test]
async fn direct_tls_never_exposes_a_legacy_offer_to_the_viewer() {
    let remote_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let mut endpoint =
        direct::Endpoint::parse("127.0.0.1", remote_listener.local_addr().unwrap().port()).unwrap();
    endpoint.require_tls("desktop-user".into()).unwrap();
    let (listener, offer, url) = offer().await;
    let sessions = VncSessions::default();
    let lease = sessions.reserve(Uuid::new_v4()).unwrap();
    let task = tokio::spawn(direct::run(listener, offer, endpoint, None, lease));
    let server = tokio::spawn(async move {
        let (mut remote, _) = remote_listener.accept().await.unwrap();
        remote.write_all(RFB_VERSION).await.unwrap();
        let mut version = [0; RFB_VERSION.len()];
        remote.read_exact(&mut version).await.unwrap();
        assert_eq!(&version, RFB_VERSION);
        remote.write_all(&[1, 2]).await.unwrap();
        let mut byte = [0u8; 1];
        let count = timeout(Duration::from_secs(3), remote.read(&mut byte))
            .await
            .expect("Direct TLS did not close the legacy VNC connection")
            .unwrap();
        assert_eq!(count, 0);
    });
    let mut viewer = connect(&url).await;
    let message = timeout(Duration::from_secs(3), viewer.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(matches!(message, Message::Close(Some(close))
        if close.code == CloseCode::Error && close.reason.as_str() == "vnc-tls-unsupported"));
    assert_eq!(task.await.unwrap(), Err("vnc-tls-unsupported"));
    server.await.unwrap();
    assert!(sessions.0.lock().unwrap().active.is_empty());
}

#[tokio::test]
async fn refused_direct_connection_reports_an_authorized_close_reason() {
    let remote = tokio::net::TcpSocket::new_v4().unwrap();
    // Keep this port reserved without listening so the dial cannot reach another service.
    remote.bind((Ipv4Addr::LOCALHOST, 0).into()).unwrap();
    let endpoint =
        direct::Endpoint::parse("127.0.0.1", remote.local_addr().unwrap().port()).unwrap();
    let (listener, offer, url) = offer().await;
    let sessions = VncSessions::default();
    let lease = sessions.reserve(Uuid::new_v4()).unwrap();
    let task = tokio::spawn(direct::run(listener, offer, endpoint, None, lease));
    let mut viewer = connect(&url).await;

    let message = timeout(OPEN_TIMEOUT + Duration::from_secs(2), viewer.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(matches!(message, Message::Close(Some(close))
        if close.code == CloseCode::Error && close.reason.as_str() == "vnc-endpoint-refused"));
    assert_eq!(task.await.unwrap(), Err("vnc-endpoint-refused"));
    assert!(sessions.0.lock().unwrap().active.is_empty());
}

#[tokio::test]
async fn stopping_a_direct_offer_retires_its_listener_without_dialing() {
    let remote_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let endpoint =
        direct::Endpoint::parse("127.0.0.1", remote_listener.local_addr().unwrap().port()).unwrap();
    let (listener, offer, _) = offer().await;
    let address = listener.local_addr().unwrap();
    let sessions = VncSessions::default();
    let id = Uuid::new_v4();
    let lease = sessions.reserve(id).unwrap();
    sessions.stop(id);
    assert_eq!(
        direct::run(listener, offer, endpoint, None, lease).await,
        Ok(())
    );
    assert!(TcpStream::connect(address).await.is_err());
    assert!(
        timeout(Duration::from_millis(100), remote_listener.accept())
            .await
            .is_err()
    );
}

/// Accept one authorized local WebSocket and use a small in-memory remote stream.
async fn local_relay() -> (
    Viewer,
    io::DuplexStream,
    tokio::task::JoinHandle<Result<(), &'static str>>,
) {
    let (listener, offer, url) = offer().await;
    let (remote, stream) = io::duplex(1024);
    let task = tokio::spawn(async move {
        let mut viewer = accept_viewer(listener, offer).await?;
        relay(&mut viewer, stream).await
    });
    (connect(&url).await, remote, task)
}

#[tokio::test]
async fn binary_relay_preserves_fragmented_messages_and_remote_bytes() {
    let (mut viewer, mut remote, task) = local_relay().await;
    viewer
        .send(Message::Frame(Frame::message(
            b"RFB ".as_slice(),
            OpCode::Data(Data::Binary),
            false,
        )))
        .await
        .unwrap();
    viewer
        .send(Message::Frame(Frame::message(
            b"003.008\n".as_slice(),
            OpCode::Data(Data::Continue),
            true,
        )))
        .await
        .unwrap();
    let mut received = [0; 12];
    timeout(Duration::from_secs(2), remote.read_exact(&mut received))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&received, b"RFB 003.008\n");
    remote.write_all(&received).await.unwrap();
    let response = timeout(Duration::from_secs(2), viewer.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(response.into_data().as_ref(), &received);
    drop(remote);
    assert_eq!(
        timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap(),
        Ok(())
    );
}

#[tokio::test]
async fn viewer_text_and_over_limit_input_are_rejected() {
    for (message, error) in [
        (
            Message::text("not RFB"),
            "VNC viewer messages must be binary.",
        ),
        (
            Message::binary(vec![0; bridge::MAX_VIEWER_MESSAGE_BYTES + 1]),
            "Invalid VNC viewer frame.",
        ),
    ] {
        let (mut viewer, mut remote, task) = local_relay().await;
        viewer.send(message).await.unwrap();
        assert_eq!(
            timeout(Duration::from_secs(2), task)
                .await
                .unwrap()
                .unwrap(),
            Err(error)
        );
        assert_eq!(remote.read(&mut [0]).await.unwrap(), 0);
    }
}

#[tokio::test]
async fn a_stalled_remote_writer_times_out_without_blocking_reverse_traffic() {
    let (mut viewer, mut remote, task) = local_relay().await;
    viewer.send(Message::binary(vec![0; 2048])).await.unwrap();
    remote.write_all(b"remote still responds").await.unwrap();
    let response = timeout(Duration::from_secs(2), viewer.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(response.into_data().as_ref(), b"remote still responds");
    assert_eq!(
        timeout(Duration::from_secs(7), task)
            .await
            .unwrap()
            .unwrap(),
        Err("Timed out sending VNC input to the server."),
    );
}

#[tokio::test]
async fn a_slow_viewer_does_not_accumulate_an_unbounded_frame_queue() {
    let (viewer, mut remote, task) = local_relay().await;
    let producer = tokio::spawn(async move {
        let pixels = [0; 16 * 1024];
        while remote.write_all(&pixels).await.is_ok() {}
    });
    assert_eq!(
        timeout(Duration::from_secs(9), task)
            .await
            .unwrap()
            .unwrap(),
        Err("VNC viewer stopped reading."),
    );
    timeout(Duration::from_secs(2), producer)
        .await
        .unwrap()
        .unwrap();
    drop(viewer);
}

struct SshPeer {
    target: Option<oneshot::Sender<(String, u32)>>,
    release_open: Option<oneshot::Receiver<()>>,
    closed: Option<oneshot::Sender<()>>,
    channels: tokio::task::JoinSet<()>,
}

impl server::Handler for SshPeer {
    type Error = anyhow::Error;

    async fn auth_password(&mut self, _: &str, _: &str) -> Result<server::Auth, Self::Error> {
        Ok(server::Auth::Accept)
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<server::Msg>,
        host: &str,
        port: u32,
        _: &str,
        _: u32,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        let _ = self.target.take().unwrap().send((host.into(), port));
        let release = self.release_open.take();
        self.channels.spawn(async move {
            if let Some(release) = release {
                let _ = release.await;
            }
            reply.accept().await;
            let (mut read, mut write) = io::split(channel.into_stream());
            let _ = io::copy(&mut read, &mut write).await;
        });
        Ok(())
    }

    async fn channel_close(
        &mut self,
        _: russh::ChannelId,
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if let Some(closed) = self.closed.take() {
            let _ = closed.send(());
        }
        Ok(())
    }
}

struct SshFixture {
    session: Arc<SshHandle>,
    target: oneshot::Receiver<(String, u32)>,
    closed: oneshot::Receiver<()>,
}

/// Build an authenticated in-memory SSH connection using the production client handler.
async fn ssh_peer(release_open: Option<oneshot::Receiver<()>>) -> SshFixture {
    let key =
        keys::PrivateKey::random(&mut keys::key::safe_rng(), keys::Algorithm::Ed25519).unwrap();
    let expected = key.public_key().clone();
    let config = Arc::new(server::Config {
        keys: vec![key],
        auth_rejection_time: Duration::ZERO,
        auth_rejection_time_initial: Some(Duration::ZERO),
        ..Default::default()
    });
    let (target, observed) = oneshot::channel();
    let (closed, close_notice) = oneshot::channel();
    let (local, remote) = io::duplex(64 * 1024);
    tokio::spawn(async move {
        let handler = SshPeer {
            target: Some(target),
            release_open,
            closed: Some(closed),
            channels: tokio::task::JoinSet::new(),
        };
        let running = server::run_stream(config, remote, handler).await.unwrap();
        let _ = running.await;
    });
    let session = crate::ssh::connect_runtime_stream_fixture(
        local,
        expected,
        "fixture",
        "fixture-only-secret",
    )
    .await
    .unwrap();
    SshFixture {
        session: Arc::new(AsyncMutex::new(Arc::new(session))),
        target: observed,
        closed: close_notice,
    }
}

fn connection(session: Arc<SshHandle>) -> ConnectionHandle {
    ConnectionHandle {
        config: ConnectionConfig {
            id: HOST_ID.into(),
            name: "VNC fixture".into(),
            host: "memory.fixture.invalid".into(),
            port: 22,
            username: "fixture".into(),
            auth_method: AuthMethod::Password {
                password: "fixture-only-secret".into(),
            },
            certificate_path: None,
            network_interface_id: None,
            agent_forwarding: None,
            jump_host: None,
            host_key_approval: None,
            connect_attempt_id: None,
        },
        session: Some(session),
        sftp_session: None,
        file_permission_session: String::new(),
        sftp_identity_maps: Default::default(),
        detected_os: None,
        detected_kernel_os: None,
        detected_shell: None,
        auth_banner: None,
        host_key_fingerprint: String::new(),
        uses_vault_auth: false,
        reconnect_generation: 7,
        reconnect_lock: Default::default(),
    }
}

#[tokio::test]
async fn vnc_stays_on_remote_loopback_and_ends_when_ssh_binding_is_replaced() {
    let SshFixture {
        session,
        target: mut observed,
        ..
    } = ssh_peer(None).await;
    let connections = Arc::new(Connections::new(HashMap::from([(
        HOST_ID.into(),
        connection(session),
    )])));
    let binding = Binding::capture(&connections, HOST_ID.into())
        .await
        .unwrap();
    let (listener, offer, url) = offer().await;
    let sessions = VncSessions::default();
    let lease = sessions.reserve(Uuid::new_v4()).unwrap();
    let task = tokio::spawn({
        let connections = connections.clone();
        async move {
            run(
                listener,
                offer,
                &connections,
                binding,
                lease,
                VNC_PORT,
                None,
            )
            .await
        }
    });
    assert!(matches!(
        observed.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));

    let mut viewer = connect(&url).await;
    assert_eq!(
        timeout(Duration::from_secs(2), observed)
            .await
            .unwrap()
            .unwrap(),
        ("127.0.0.1".into(), u32::from(VNC_PORT))
    );
    viewer
        .send(Message::binary(b"over SSH".as_slice()))
        .await
        .unwrap();
    let response = timeout(Duration::from_secs(2), viewer.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(response.into_data().as_ref(), b"over SSH");

    let SshFixture {
        session: replacement,
        target: mut replacement_target,
        ..
    } = ssh_peer(None).await;
    connections
        .lock()
        .await
        .insert(HOST_ID.into(), connection(replacement));
    assert_eq!(
        timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap(),
        Err(NOT_CONNECTED)
    );
    assert!(timeout(Duration::from_secs(2), viewer.next())
        .await
        .unwrap()
        .is_none_or(|message| message.is_err()));
    assert!(matches!(
        replacement_target.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    assert!(sessions.0.lock().unwrap().active.is_empty());
}

#[tokio::test]
async fn stopping_pending_offer_drops_its_listener_before_ssh_open() {
    let SshFixture {
        session,
        target: mut observed,
        ..
    } = ssh_peer(None).await;
    let connections = Arc::new(Connections::new(HashMap::from([(
        HOST_ID.into(),
        connection(session),
    )])));
    let binding = Binding::capture(&connections, HOST_ID.into())
        .await
        .unwrap();
    let (listener, offer, _) = offer().await;
    let address = listener.local_addr().unwrap();
    let sessions = VncSessions::default();
    let id = Uuid::new_v4();
    let lease = sessions.reserve(id).unwrap();
    let task = tokio::spawn(async move {
        run(
            listener,
            offer,
            &connections,
            binding,
            lease,
            VNC_PORT,
            None,
        )
        .await
    });

    sessions.stop(id);
    assert_eq!(
        timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap(),
        Ok(())
    );
    assert!(TcpStream::connect(address).await.is_err());
    assert!(matches!(
        observed.try_recv(),
        Err(oneshot::error::TryRecvError::Empty | oneshot::error::TryRecvError::Closed)
    ));
}

#[tokio::test]
async fn timed_out_ssh_open_retains_admission_and_closes_confirmation_after_the_deadline() {
    let (release, release_open) = oneshot::channel();
    let SshFixture {
        session,
        target,
        closed,
    } = ssh_peer(Some(release_open)).await;
    let connections = Arc::new(Connections::new(HashMap::from([(
        HOST_ID.into(),
        connection(session.clone()),
    )])));
    let binding = Binding::capture(&connections, HOST_ID.into())
        .await
        .unwrap();
    let (listener, offer, url) = offer().await;
    let sessions = VncSessions::default();
    let id = Uuid::new_v4();
    let lease = sessions.reserve(id).unwrap();
    let task = tokio::spawn({
        let connections = connections.clone();
        async move {
            run(
                listener,
                offer,
                &connections,
                binding,
                lease,
                VNC_PORT,
                None,
            )
            .await
        }
    });
    let mut viewer = connect(&url).await;
    timeout(Duration::from_secs(2), target)
        .await
        .unwrap()
        .unwrap();

    assert!(
        timeout(OPEN_TIMEOUT + Duration::from_secs(2), viewer.next())
            .await
            .unwrap()
            .is_none_or(|message| message.is_err())
    );
    assert!(!task.is_finished(), "Late confirmation must still be owned");
    timeout(Duration::from_secs(2), async {
        session.lock().await.send_ping().await.unwrap();
    })
    .await
    .expect("Pending VNC cleanup must not block the shared SSH handle");
    let _other_slots: Vec<_> = (1..MAX_SESSIONS)
        .map(|_| sessions.reserve(Uuid::new_v4()).unwrap())
        .collect();
    assert!(sessions.reserve(Uuid::new_v4()).is_err());

    release.send(()).unwrap();
    assert_eq!(
        timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap(),
        Err(OPEN_TIMED_OUT)
    );
    timeout(Duration::from_secs(2), closed)
        .await
        .unwrap()
        .expect("A successful late confirmation must receive CHANNEL_CLOSE");
    assert!(sessions.reserve(Uuid::new_v4()).is_ok());
    assert!(!session.lock().await.is_closed());
}

#[tokio::test]
async fn cancelled_ssh_open_survives_the_deadline_until_transport_loss_releases_admission() {
    let (_release, release_open) = oneshot::channel();
    let SshFixture {
        session, target, ..
    } = ssh_peer(Some(release_open)).await;
    let connections = Arc::new(Connections::new(HashMap::from([(
        HOST_ID.into(),
        connection(session.clone()),
    )])));
    let binding = Binding::capture(&connections, HOST_ID.into())
        .await
        .unwrap();
    let (listener, offer, url) = offer().await;
    let sessions = VncSessions::default();
    let id = Uuid::new_v4();
    let lease = sessions.reserve(id).unwrap();
    let task = tokio::spawn({
        let connections = connections.clone();
        async move {
            run(
                listener,
                offer,
                &connections,
                binding,
                lease,
                VNC_PORT,
                None,
            )
            .await
        }
    });
    let mut viewer = connect(&url).await;
    timeout(Duration::from_secs(2), target)
        .await
        .unwrap()
        .unwrap();
    sessions.stop(id);
    assert!(timeout(Duration::from_secs(2), viewer.next())
        .await
        .unwrap()
        .is_none_or(|message| message.is_err()));
    sleep(OPEN_TIMEOUT + Duration::from_millis(100)).await;
    assert!(
        !task.is_finished(),
        "Cancellation must retain the pending open"
    );
    assert!(sessions.0.lock().unwrap().active.contains_key(&id));
    timeout(Duration::from_secs(2), async {
        let handle = session.lock().await;
        handle.send_ping().await.unwrap();
        handle
            .disconnect(russh::Disconnect::ByApplication, "fixture finished", "")
            .await
            .unwrap();
    })
    .await
    .expect("Pending VNC cleanup must allow explicit SSH disconnection");
    assert_eq!(
        timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap(),
        Ok(())
    );
    assert!(!sessions.0.lock().unwrap().active.contains_key(&id));
}

#[tokio::test]
async fn stopping_during_ssh_open_closes_the_viewer_and_drains_the_late_channel() {
    let (release, release_open) = oneshot::channel();
    let SshFixture {
        session,
        target,
        closed,
    } = ssh_peer(Some(release_open)).await;
    let connections = Arc::new(Connections::new(HashMap::from([(
        HOST_ID.into(),
        connection(session),
    )])));
    let binding = Binding::capture(&connections, HOST_ID.into())
        .await
        .unwrap();
    let (listener, offer, url) = offer().await;
    let sessions = VncSessions::default();
    let id = Uuid::new_v4();
    let lease = sessions.reserve(id).unwrap();
    let task = tokio::spawn({
        let connections = connections.clone();
        async move {
            run(
                listener,
                offer,
                &connections,
                binding,
                lease,
                VNC_PORT,
                None,
            )
            .await
        }
    });
    let mut viewer = connect(&url).await;
    timeout(Duration::from_secs(2), target)
        .await
        .unwrap()
        .unwrap();
    sessions.stop(id);
    assert!(timeout(Duration::from_secs(2), viewer.next())
        .await
        .unwrap()
        .is_none_or(|message| message.is_err()));

    release.send(()).unwrap();
    assert_eq!(
        timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap(),
        Ok(())
    );
    timeout(Duration::from_secs(2), closed)
        .await
        .unwrap()
        .unwrap();
    assert!(Binding::capture(&connections, HOST_ID.into()).await.is_ok());
}
