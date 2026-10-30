//! Archive reconnect and queued local-copy checks over owned memory/temp-directory fixtures.

use super::*;
use russh::{server, ChannelOpenFailure};
use tokio::sync::Notify;

const DEADLINE: Duration = Duration::from_secs(10);

struct Task<T>(tokio::task::JoinHandle<T>);
impl<T> Drop for Task<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[derive(Clone, Copy)]
enum Behavior {
    Accept,
    Reject,
    FailGated,
    AcceptGated,
}

#[derive(Default)]
struct Observed {
    opening: Notify,
    release: Notify,
    subsystems: AtomicU64,
}

struct Server {
    behavior: Behavior,
    observed: Arc<Observed>,
    channels: Vec<Channel<server::Msg>>,
}

impl server::Handler for Server {
    type Error = anyhow::Error;
    async fn auth_password(&mut self, user: &str, password: &str) -> anyhow::Result<server::Auth> {
        Ok(if user == "fixture" && password == "fixture-only-secret" {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }
    async fn channel_open_session(
        &mut self,
        channel: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> anyhow::Result<()> {
        self.observed.opening.notify_one();
        if matches!(self.behavior, Behavior::FailGated | Behavior::AcceptGated) {
            self.observed.release.notified().await;
        }
        match self.behavior {
            Behavior::FailGated => return Err(anyhow::anyhow!("fixture transport failure")),
            Behavior::Reject => {
                reply
                    .reject(ChannelOpenFailure::AdministrativelyProhibited)
                    .await
            }
            _ => {
                reply.accept().await;
                self.channels.push(channel);
            }
        }
        Ok(())
    }
    async fn subsystem_request(
        &mut self,
        _: russh::ChannelId,
        _: &str,
        _: &mut server::Session,
    ) -> anyhow::Result<()> {
        self.observed.subsystems.fetch_add(1, Ordering::SeqCst);
        Err(anyhow::anyhow!("archive must not initialize SFTP"))
    }
}

struct Fixture {
    session: crate::ssh_command::SshSession,
    observed: Arc<Observed>,
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
            channels: Vec::new(),
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
        Self {
            session: Arc::new(Mutex::new(session)),
            observed,
            _server: server,
        }
    }
}

fn connection(
    session: Option<crate::ssh_command::SshSession>,
    owner: Arc<Mutex<()>>,
    generation: u64,
) -> ConnectionHandle {
    ConnectionHandle {
        config: serde_json::from_value(serde_json::json!({
            "id":"fixture", "name":"Archive fixture", "host":"memory.fixture.invalid", "port":22,
            "username":"fixture", "auth_method":{"type":"Password", "password":"fixture-only-secret"}
        })).unwrap(),
        session, sftp_session: None, file_permission_session: "fixture".into(),
        sftp_identity_maps: Arc::new(tokio::sync::OnceCell::new()), detected_os: None, detected_kernel_os: None,
        detected_shell: None, auth_banner: None, host_key_fingerprint:"fixture-only".into(), uses_vault_auth:false,
        reconnect_generation:generation, reconnect_lock:owner,
    }
}

#[tokio::test]
async fn archives_reconnect_missing_or_dead_transports_without_starting_sftp() {
    for missing in [true, false] {
        let replacement = Fixture::new(Behavior::Accept).await;
        let old = Fixture::new(Behavior::Accept).await;
        if !missing {
            old.session
                .lock()
                .await
                .disconnect(russh::Disconnect::ByApplication, "fixture closed", "")
                .await
                .unwrap();
            tokio::time::timeout(DEADLINE, async {
                while !old.session.lock().await.is_closed() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
        }
        let owner = Arc::new(Mutex::new(()));
        let connections = Mutex::new(HashMap::from([(
            "fixture".into(),
            connection((!missing).then(|| old.session.clone()), owner.clone(), 4),
        )]));
        let registry = &connections;
        let expected_owner = &owner;
        let replacement_session = &replacement.session;
        let channel = tokio::time::timeout(
            DEADLINE,
            archive_ssh_channel(&connections, "fixture", |captured, generation| async move {
                assert!(Arc::ptr_eq(&captured, expected_owner));
                assert_eq!(generation, 4);
                let mut connections = registry.lock().await;
                let current = connections.get_mut("fixture").unwrap();
                assert!(current.session.is_none());
                current.session = Some(replacement_session.clone());
                current.reconnect_generation = 5;
                Ok(())
            }),
        )
        .await
        .unwrap()
        .unwrap();
        channel.close().await.unwrap();
        assert_eq!(replacement.observed.subsystems.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn archive_channel_results_never_clear_or_retarget_a_replacement_owner() {
    for behavior in [Behavior::FailGated, Behavior::AcceptGated] {
        let old = Fixture::new(behavior).await;
        let replacement = Fixture::new(Behavior::Accept).await;
        let owner = Arc::new(Mutex::new(()));
        let connections = Mutex::new(HashMap::from([(
            "fixture".into(),
            connection(Some(old.session.clone()), owner, 4),
        )]));
        let request = archive_ssh_channel(&connections, "fixture", |_, _| async {
            panic!("replacement must not be reconnected by old work")
        });
        tokio::pin!(request);
        assert!(futures_util::poll!(&mut request).is_pending());
        tokio::time::timeout(DEADLINE, old.observed.opening.notified())
            .await
            .unwrap();
        let replacement_owner = Arc::new(Mutex::new(()));
        connections.lock().await.insert(
            "fixture".into(),
            connection(
                Some(replacement.session.clone()),
                replacement_owner.clone(),
                4,
            ),
        );
        old.observed.release.notify_one();
        assert!(tokio::time::timeout(DEADLINE, request)
            .await
            .unwrap()
            .is_err());
        let connections = connections.lock().await;
        let current = connections.get("fixture").unwrap();
        assert!(Arc::ptr_eq(&current.reconnect_lock, &replacement_owner));
        assert!(crate::sftp_read::is_current_session(
            &current.session,
            &replacement.session
        ));
    }
}

#[tokio::test]
async fn server_archive_channel_rejection_does_not_reconnect_a_healthy_transport() {
    let fixture = Fixture::new(Behavior::Reject).await;
    let connections = Mutex::new(HashMap::from([(
        "fixture".into(),
        connection(Some(fixture.session.clone()), Arc::new(Mutex::new(())), 0),
    )]));
    assert!(archive_ssh_channel(&connections, "fixture", |_, _| async {
        panic!("channel rejection is not transport loss")
    })
    .await
    .is_err());
    assert!(crate::sftp_read::is_current_session(
        &connections.lock().await.get("fixture").unwrap().session,
        &fixture.session
    ));
}

#[tokio::test]
async fn queued_local_upload_rechecks_cancel_before_overwriting_destination() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source");
    let destination = directory.path().join("destination");
    std::fs::write(&source, b"new contents").unwrap();
    std::fs::write(&destination, b"preserved").unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    crate::transfers::check_cancelled(&cancel).unwrap();
    let worker_cancel = cancel.clone();
    let queued = crate::fs::run_local_bulk_io(move || {
        copy_legacy_local_upload(&source, &destination, &worker_cancel)
    });
    cancel.store(true, Ordering::Relaxed);
    assert_eq!(queued.await.unwrap_err().to_string(), "Cancelled");
    assert_eq!(
        std::fs::read(directory.path().join("destination")).unwrap(),
        b"preserved"
    );
}
