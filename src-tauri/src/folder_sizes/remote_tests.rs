//! Fixed protocol over in-memory SSH only: no hosts, credentials or remote exec.
use super::*;
use tokio::sync::Notify;

const NONCE: &str = "0123456789abcdef0123456789abcdef";

fn frame() -> serde_json::Value {
    serde_json::json!({ "protocol": 1, "nonce": NONCE, "status": "report",
        "report": { "bytes": "9007199254740993", "entries": 4, "files": 2,
            "folders": 1, "skipped": 1, "errors": 0, "complete": true, "reason": "finished" } })
}

#[test]
fn exec_requires_a_canonical_linux_kernel_not_a_distribution_or_unknown_os() {
    assert!(supports_kernel(Some("linux")));
    for kernel in [
        None,
        Some(""),
        Some("ubuntu"),
        Some("debian"),
        Some("darwin"),
        Some("freebsd"),
        Some("windows"),
    ] {
        assert!(!supports_kernel(kernel));
    }
}

#[test]
fn aggregate_is_lossless_and_rejects_untrusted_or_inconsistent_output() {
    let valid = frame();
    assert_eq!(
        decode(&serde_json::to_vec(&valid).unwrap(), NONCE)
            .unwrap()
            .unwrap()
            .bytes,
        "9007199254740993"
    );
    for (key, value) in [
        ("bytes", serde_json::json!("18446744073709551616")),
        ("entries", serde_json::json!(100001)),
        ("files", serde_json::json!(10)),
        ("errors", serde_json::json!(1)),
        (
            "reason",
            serde_json::json!("server reflected a private path"),
        ),
        ("complete", serde_json::json!(false)),
    ] {
        let mut invalid = valid.clone();
        invalid["report"][key] = value;
        assert!(
            decode(&serde_json::to_vec(&invalid).unwrap(), NONCE).is_err(),
            "{key}"
        );
    }
    assert!(decode(&serde_json::to_vec(&valid).unwrap(), "other").is_err());
    assert!(decode(b"login banner\n{}", NONCE).is_err());
    assert!(bounded_total(MAX_OUTPUT, 1).is_err());
    assert!(bounded_total(0, usize::MAX).is_err());
    assert_eq!(bounded_total(0, MAX_OUTPUT).unwrap(), MAX_OUTPUT);
    let mismatch = serde_json::json!({"protocol": 1, "nonce": NONCE, "status": "mismatch"});
    assert!(decode(&serde_json::to_vec(&mismatch).unwrap(), NONCE)
        .unwrap()
        .is_none());
}

#[test]
fn partial_results_keep_fixed_native_reasons_and_never_claim_complete() {
    for reason in [
        "entries", "depth", "pending", "memory", "path", "bytes", "time", "errors",
    ] {
        let mut value = frame();
        value["report"]["complete"] = false.into();
        value["report"]["reason"] = reason.into();
        value["report"]["errors"] = 1.into();
        let report = decode(&serde_json::to_vec(&value).unwrap(), NONCE)
            .unwrap()
            .unwrap();
        assert!(!report.complete);
        assert_eq!(report.bytes, "9007199254740993");
    }
}

struct Client;
impl client::Handler for Client {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        _: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

#[derive(Clone, Copy)]
enum Behavior {
    Good,
    Missing,
    Refused,
    Mismatch,
    Malformed,
    MalformedFailure,
    InvalidReport,
    WrongNonce,
    Unconfirmed,
    Flood,
    Hang,
}
struct Server {
    behavior: Behavior,
    started: Arc<Notify>,
    closed: Arc<Notify>,
}
impl russh::server::Handler for Server {
    type Error = russh::Error;
    async fn auth_none(&mut self, _: &str) -> Result<russh::server::Auth, Self::Error> {
        Ok(russh::server::Auth::Accept)
    }
    async fn channel_open_session(
        &mut self,
        _: Channel<russh::server::Msg>,
        reply: russh::server::ChannelOpenHandle,
        _: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }
    async fn exec_request(
        &mut self,
        channel: russh::ChannelId,
        data: &[u8],
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        assert_eq!(
            data,
            command().as_bytes(),
            "no target is interpolated into shell source"
        );
        if matches!(self.behavior, Behavior::Refused) {
            session.channel_failure(channel)?;
        } else {
            session.channel_success(channel)?;
        }
        Ok(())
    }
    async fn data(
        &mut self,
        channel: russh::ChannelId,
        _: &[u8],
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        self.started.notify_one();
        let output = match self.behavior {
            Behavior::Good | Behavior::Unconfirmed => serde_json::to_vec(&frame()).unwrap(),
            Behavior::Malformed | Behavior::MalformedFailure => b"login banner\n{}".to_vec(),
            Behavior::InvalidReport => {
                let mut value = frame();
                value["report"]["files"] = 10.into();
                serde_json::to_vec(&value).unwrap()
            }
            Behavior::WrongNonce => {
                let mut value = frame();
                value["nonce"] = "other".into();
                serde_json::to_vec(&value).unwrap()
            }
            Behavior::Mismatch => serde_json::to_vec(
                &serde_json::json!({"protocol":1,"nonce":NONCE,"status":"mismatch"}),
            )
            .unwrap(),
            Behavior::Flood => vec![b'x'; MAX_OUTPUT + 1],
            Behavior::Missing | Behavior::Refused => Vec::new(),
            Behavior::Hang => return Ok(()),
        };
        for chunk in output.chunks(7) {
            session.data(channel, chunk.to_vec())?;
        }
        if !matches!(self.behavior, Behavior::Unconfirmed) {
            session.exit_status_request(
                channel,
                if matches!(self.behavior, Behavior::Missing) {
                    127
                } else if matches!(self.behavior, Behavior::MalformedFailure) {
                    1
                } else {
                    0
                },
            )?;
        }
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }
    async fn channel_eof(
        &mut self,
        _: russh::ChannelId,
        _: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        self.closed.notify_one();
        Ok(())
    }
    async fn channel_close(
        &mut self,
        _: russh::ChannelId,
        _: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        self.closed.notify_one();
        Ok(())
    }
}

struct Transport {
    session: Session<Client>,
    started: Arc<Notify>,
    closed: Arc<Notify>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Transport {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn transport(behavior: Behavior) -> Transport {
    let (local, remote) = tokio::io::duplex(256 * 1024);
    let started = Arc::new(Notify::new());
    let closed = Arc::new(Notify::new());
    let config = Arc::new(russh::server::Config {
        keys: vec![russh::keys::PrivateKey::random(
            &mut russh::keys::key::safe_rng(),
            russh::keys::Algorithm::Ed25519,
        )
        .unwrap()],
        ..Default::default()
    });
    let server = Server {
        behavior,
        started: started.clone(),
        closed: closed.clone(),
    };
    let task = tokio::spawn(async move {
        let session = russh::server::run_stream(config, remote, server)
            .await
            .unwrap();
        let _ = session.await;
    });
    let mut handle = client::connect_stream(Arc::new(client::Config::default()), local, Client)
        .await
        .unwrap();
    assert!(handle.authenticate_none("fixture").await.unwrap().success());
    Transport {
        session: Arc::new(AsyncMutex::new(handle)),
        started,
        closed,
        task,
    }
}

#[tokio::test]
async fn ssh_aggregate_handles_fragmentation_unsupported_output_and_unconfirmed_exit() {
    for behavior in [
        Behavior::Good,
        Behavior::Missing,
        Behavior::Refused,
        Behavior::Mismatch,
        Behavior::Malformed,
        Behavior::MalformedFailure,
        Behavior::InvalidReport,
        Behavior::WrongNonce,
        Behavior::Unconfirmed,
        Behavior::Flood,
    ] {
        let fixture = transport(behavior).await;
        let mut channel = None;
        let result = timeout(
            Duration::from_secs(3),
            calculate(&fixture.session, b"{}\n", NONCE, &mut channel),
        )
        .await
        .unwrap();
        match behavior {
            Behavior::Good => assert!(result.unwrap().unwrap().complete),
            Behavior::Flood => assert!(result.unwrap_err().contains("safety limit")),
            Behavior::Unconfirmed | Behavior::MalformedFailure => {
                assert!(result.unwrap_err().contains("completion was not confirmed"))
            }
            _ => assert!(result.unwrap().is_none()),
        }
        close(channel).await;
    }
}

#[tokio::test]
async fn cancellation_closes_only_owned_exec_and_keeps_permits_through_cleanup() {
    let fixture = transport(Behavior::Hang).await;
    let service = super::super::Service::default();
    service.begin("exec".into(), "ssh".into()).unwrap();
    let lease = service.claim("exec", "ssh").unwrap();
    let permits = lease.permits().await.unwrap();
    let mut channel = None;
    let work = lease.run(async { calculate(&fixture.session, b"{}\n", NONCE, &mut channel).await });
    let cancel = async {
        fixture.started.notified().await;
        service.cancel("exec");
    };
    let (result, ()) = timeout(Duration::from_secs(3), async { tokio::join!(work, cancel) })
        .await
        .unwrap();
    assert!(result.unwrap_err().contains("cancelled"));
    close(channel).await;
    assert_eq!(service.capacity.available_permits(), 1);
    timeout(Duration::from_secs(3), fixture.closed.notified())
        .await
        .unwrap();
    drop(permits);
    assert_eq!(service.capacity.available_permits(), 2);
    assert!(
        fixture
            .session
            .lock()
            .await
            .channel_open_session()
            .await
            .is_ok(),
        "the shared SSH connection survives cancellation"
    );
}

#[tokio::test]
async fn unsupported_cache_is_bounded_and_does_not_cross_reconnects() {
    let first = transport(Behavior::Good).await;
    let second = transport(Behavior::Good).await;
    let support = SupportCache::default();
    assert!(support.block(&first.session));
    assert!(
        !support.block(&first.session),
        "a provisional block is claimed only once"
    );
    assert!(!support.allows(&first.session));
    assert!(support.allows(&second.session));
    assert_eq!(support.blocked.lock().unwrap().len(), 1);
    support.allow(&first.session);
    assert!(support.allows(&first.session));
    support.block(&first.session);
    drop(first);
    assert!(support.allows(&second.session));
    assert!(support.blocked.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_full_cache_never_evicts_a_live_unconfirmed_transport() {
    let support = SupportCache::default();
    let mut fixtures = Vec::new();
    for _ in 0..MAX_CACHED {
        let fixture = transport(Behavior::Good).await;
        assert!(support.block(&fixture.session));
        fixtures.push(fixture);
    }
    let extra = transport(Behavior::Good).await;
    assert!(!support.allows(&extra.session));
    assert!(!support.block(&extra.session));
    assert_eq!(support.blocked.lock().unwrap().len(), MAX_CACHED);
    assert!(!support.allows(&fixtures[0].session));
    drop(fixtures);
    assert!(support.allows(&extra.session));
}

#[cfg(target_os = "linux")]
#[test]
fn server_program_matches_metadata_semantics_and_enforces_budgets() {
    let status = std::process::Command::new("/usr/bin/python3")
        .args(["-I", "-B"])
        .arg(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../tests/files/folderSizeRemote.test.py"),
        )
        .status()
        .expect("Linux qualification requires the existing Python 3 runtime");
    assert!(status.success());
}
