//! Offline protocol/admission regressions: never opens an SSH connection or sudo.
use super::*;

const NONCE: &str = "0123456789abcdef0123456789abcdef";

#[test]
fn password_prompt_is_exact_stderr_only_split_safe_and_single_use() {
    let mut output = Output::new(NONCE);
    output.feed(true, b"ZYNC-SUDO-wrong:").unwrap();
    assert!(output.event().unwrap().is_none());
    let marker = format!("ZYNC-SUDO-{NONCE}:");
    for byte in marker.as_bytes().split_last().unwrap().1 {
        output.feed(true, &[*byte]).unwrap();
        assert!(output.event().unwrap().is_none());
    }
    output.feed(true, b":").unwrap();
    assert!(matches!(output.event().unwrap(), Some(Event::Prompt)));
    output.feed(true, marker.as_bytes()).unwrap();
    assert!(
        output.event().is_err(),
        "a second sudo prompt cannot obtain a replay"
    );
    let mut stdout = Output::new(NONCE);
    stdout.feed(false, marker.as_bytes()).unwrap();
    assert!(
        stdout.event().unwrap().is_none(),
        "stdout can never request a password"
    );
}

#[test]
fn cached_auth_can_start_with_ready_without_a_password() {
    let mut output = Output::new(NONCE);
    let frame = format!("{{\"protocol\":1,\"nonce\":\"{NONCE}\",\"type\":\"ready\"}}\n");
    for part in frame.as_bytes().chunks(5) {
        output.feed(false, part).unwrap();
    }
    assert!(
        matches!(output.event().unwrap(), Some(Event::Frame(value)) if value["type"] == "ready")
    );
    assert_eq!(output.prompts, 0);
}

#[test]
fn malformed_untrusted_output_is_bounded_and_never_reflected() {
    for frame in [
        "secret-reflection-marker\n",
        "{\"nonce\":\"wrong\",\"protocol\":1}\n",
        "[]\n",
    ] {
        let mut output = Output::new(NONCE);
        output.feed(false, frame.as_bytes()).unwrap();
        let error = output.event().err().unwrap();
        assert!(!error.contains("secret-reflection-marker"));
    }
    let mut output = Output::new(NONCE);
    assert!(output.feed(true, &vec![0; MAX_FRAME + 1]).is_err());
    assert!(
        output.stderr.is_empty(),
        "reject before allocating an oversized reply"
    );
}

#[test]
fn native_phase_not_client_flags_gates_authentication_and_apply() {
    let phase = AtomicU8::new(STARTING);
    let auth = || Action::Authenticate(Zeroizing::new("fixture-only".into()), oneshot::channel().0);
    let apply = || Action::Apply(0o200, 0, "review-only-token".into(), oneshot::channel().0);
    assert!(claim_action(&phase, &apply()).is_err());
    assert!(claim_action(&phase, &auth()).is_err());
    phase.store(PASSWORD, Ordering::Release);
    assert!(claim_action(&phase, &apply()).is_err());
    assert!(claim_action(&phase, &auth()).is_ok());
    assert!(claim_action(&phase, &auth()).is_err());
    phase.store(PREPARED, Ordering::Release);
    assert!(claim_action(&phase, &auth()).is_err());
    assert!(claim_action(&phase, &apply()).is_ok());
    assert!(
        claim_action(&phase, &apply()).is_err(),
        "duplicate Apply is not queued"
    );
}

#[tokio::test]
async fn cancelled_or_expired_reviews_cannot_yield_a_queued_change() {
    let (sender, mut receiver) = mpsc::channel(1);
    sender
        .send(Action::Apply(
            0o200,
            0,
            "review-only-token".into(),
            oneshot::channel().0,
        ))
        .await
        .unwrap_or_else(|_| panic!("fixture channel"));
    let (cancel, mut cancelled) = watch::channel(false);
    cancel.send(true).unwrap();
    assert!(
        wait_action(&mut receiver, &mut cancelled, Instant::now() + LIFETIME)
            .await
            .is_none()
    );
    let (_sender, mut receiver) = mpsc::channel(1);
    let (_cancel, mut cancelled) = watch::channel(false);
    assert!(wait_action(&mut receiver, &mut cancelled, Instant::now())
        .await
        .is_none());
    let (sender, mut receiver) = mpsc::channel(1);
    sender
        .send(Action::Apply(
            0o200,
            0,
            "expired-token".into(),
            oneshot::channel().0,
        ))
        .await
        .unwrap_or_else(|_| panic!("fixture channel"));
    assert!(
        wait_action(&mut receiver, &mut cancelled, Instant::now())
            .await
            .is_none(),
        "a queued Apply cannot win an expired timer"
    );
}

#[tokio::test]
async fn password_validation_never_echoes_or_persists_input() {
    let service = Service::default();
    for value in [
        "",
        "secret-reflection-marker\n",
        "secret-reflection-marker\0",
    ] {
        let error = service
            .authenticate(NONCE, Zeroizing::new(value.into()))
            .await
            .err()
            .unwrap();
        assert!(!error.contains("secret-reflection-marker"));
        assert!(service.pending.lock().unwrap().is_empty());
    }
}

#[test]
fn administrator_metadata_is_exact_host_path_and_lossless_evidence() {
    let binding = Binding {
        identity: "account".into(),
        session: "transport".into(),
        model: Model::Posix,
    };
    let value = serde_json::json!({ "path": "/tmp/literal'\nfile", "canonicalParent": "/tmp",
        "snapshot": { "kind": "File", "size": "9007199254740993", "modified": "1700000000123456789", "mode": 0o100400 },
        "uid": 0, "gid": 0, "linkCount": 1, "objectIdentity": "opaque-native-object" });
    let result = metadata(value.clone(), "/tmp/literal'\nfile", &binding).unwrap();
    assert_eq!(result.data.snapshot.size, 9_007_199_254_740_993);
    assert_eq!(result.data.binding, binding);
    assert!(metadata(value, "/different/sftp/path", &binding).is_err());
}

#[test]
fn command_has_only_static_runtime_code_and_native_nonce_not_user_arguments() {
    let invocation = command(NONCE);
    assert!(invocation.starts_with("/usr/bin/sudo -S -u root -p 'ZYNC-SUDO-"));
    assert!(invocation.contains("-- /usr/bin/python3 -I -S -c '"));
    assert!(invocation.ends_with(NONCE));
    assert!(!invocation.contains("sudo -s"));
    assert!(!invocation.contains("sftp-server"));
}

#[test]
fn verified_result_must_match_prepared_object_facts_and_requested_mode() {
    let binding = Binding {
        identity: "account".into(),
        session: "transport".into(),
        model: Model::Posix,
    };
    let value = serde_json::json!({ "path": "/tmp/file", "canonicalParent": "/tmp",
        "snapshot": { "kind": "File", "size": "42", "modified": "1700000000123456789", "mode": 0o100400 },
        "uid": 0, "gid": 0, "linkCount": 1, "objectIdentity": "42:123" });
    let before = metadata(value, "/tmp/file", &binding).unwrap();
    let mut after = before.clone();
    after.data.snapshot.mode = Some(0o100600);
    assert!(validate_result(&before, &after, 0o200, 0, &OutcomeStatus::Verified).is_ok());
    assert!(validate_result(&before, &after, 0o200, 0, &OutcomeStatus::Adjusted).is_err());
    after.data.snapshot.mode = Some(0o100400);
    assert!(validate_result(&before, &after, 0o200, 0, &OutcomeStatus::Verified).is_err());
    assert!(validate_result(&before, &after, 0o200, 0, &OutcomeStatus::Adjusted).is_ok());
    after.identity = "42:999".into();
    assert!(validate_result(&before, &after, 0o200, 0, &OutcomeStatus::Adjusted).is_err());
}

#[tokio::test]
async fn prepared_only_token_is_required_before_native_phase_is_claimed() {
    let service = Service::default();
    let (actions, mut receiver) = mpsc::channel(1);
    let (cancel, _cancelled) = watch::channel(false);
    let phase = Arc::new(AtomicU8::new(PREPARED));
    service.pending.lock().unwrap().insert(
        NONCE.into(),
        Pending {
            connection: "fixture".into(),
            actions,
            cancel,
            phase: phase.clone(),
            review_token: "prepared-reply-only".into(),
            deadline: Instant::now() + LIFETIME,
        },
    );
    assert!(service
        .apply(
            NONCE,
            "password-stage-id-is-not-a-review-token".into(),
            0o200,
            0
        )
        .await
        .is_err());
    assert_eq!(phase.load(Ordering::Acquire), PREPARED);
    assert!(receiver.try_recv().is_err());
    service.cancel(NONCE);
    assert!(timeout(
        Duration::from_secs(1),
        service.apply(NONCE, "prepared-reply-only".into(), 0o200, 0)
    )
    .await
    .expect("cancel must reject immediately")
    .is_err());
    assert!(receiver.try_recv().is_err());
}

/// Real SSH framing over memory only. Never connects a socket, executes a
/// command, or uses the application's host-key, account or credential storage.
struct Client;
impl russh::client::Handler for Client {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        _: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}
struct Server {
    opened: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
    closed: Arc<tokio::sync::Notify>,
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
        self.opened.notify_one();
        self.release.notified().await;
        reply.accept().await;
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
struct TransportFixture {
    session: Arc<AsyncMutex<Arc<Handle<Client>>>>,
    opened: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
    closed: Arc<tokio::sync::Notify>,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for TransportFixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn transport() -> TransportFixture {
    use russh::{client, server};
    use tokio::sync::Notify;
    let (local, remote) = tokio::io::duplex(256 * 1024);
    let opened = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let closed = Arc::new(Notify::new());
    let config = Arc::new(server::Config {
        keys: vec![russh::keys::PrivateKey::random(
            &mut russh::keys::key::safe_rng(),
            russh::keys::Algorithm::Ed25519,
        )
        .expect("generate fixture key")],
        ..Default::default()
    });
    let fixture = Server {
        opened: opened.clone(),
        release: release.clone(),
        closed: closed.clone(),
    };
    let server = tokio::spawn(async move {
        let session = server::run_stream(config, remote, fixture).await.unwrap();
        let _ = session.await;
    });
    let mut handle = client::connect_stream(Arc::new(client::Config::default()), local, Client)
        .await
        .unwrap();
    assert!(handle.authenticate_none("fixture").await.unwrap().success());
    let session = Arc::new(AsyncMutex::new(Arc::new(handle)));
    TransportFixture {
        session,
        opened,
        release,
        closed,
        server,
    }
}

#[tokio::test]
async fn late_channel_confirmation_is_owned_bounded_and_explicitly_closed() {
    let fixture = transport().await;
    let gate = Arc::new(Opens::default());
    let permit = gate.acquire(&fixture.session).unwrap();
    let session = fixture.session.clone();
    let request = tokio::spawn(async move {
        timeout(
            Duration::from_millis(50),
            open_channel(session, permit, Instant::now() + Duration::from_secs(2)),
        )
        .await
    });
    timeout(Duration::from_secs(3), fixture.opened.notified())
        .await
        .unwrap();
    assert!(
        request.await.unwrap().is_err(),
        "caller stopped waiting before confirmation"
    );
    assert_eq!(
        gate.capacity.available_permits(),
        1,
        "the abandoned open still has a bounded owner"
    );
    fixture.release.notify_one();
    timeout(Duration::from_secs(3), fixture.closed.notified())
        .await
        .unwrap();
    timeout(Duration::from_secs(3), async {
        while gate.capacity.available_permits() != 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(
        gate.acquire(&fixture.session).is_ok(),
        "a late confirmed-and-closed channel does not disable the host"
    );
}

#[tokio::test]
async fn never_confirmed_open_releases_shared_lock_capacity_and_only_blocks_exact_transport() {
    let fixture = transport().await;
    let gate = Arc::new(Opens::default());
    let permit = gate.acquire(&fixture.session).unwrap();
    assert!(open_channel(
        fixture.session.clone(),
        permit,
        Instant::now() + Duration::from_millis(80)
    )
    .await
    .is_err());
    assert!(
        fixture.session.try_lock().is_ok(),
        "ordinary actions regain the shared handle"
    );
    assert_eq!(gate.capacity.available_permits(), 2);
    assert!(
        gate.acquire(&fixture.session).is_err(),
        "SFTP generation changes cannot bypass exact transport admission"
    );
    let fresh = transport().await;
    assert!(
        gate.acquire(&fresh.session).is_ok(),
        "an unrelated/reconnected native transport remains available"
    );
    drop(fixture);
    assert!(gate.acquire(&fresh.session).is_ok());
    assert!(
        gate.blocked.lock().unwrap().is_empty(),
        "dead weak entries are pruned, not retained history"
    );
}

#[tokio::test]
async fn shared_lock_wait_timeout_never_disables_a_transport_without_a_request() {
    let fixture = transport().await;
    let gate = Arc::new(Opens::default());
    let held = fixture.session.lock().await;
    let permit = gate.acquire(&fixture.session).unwrap();
    assert!(open_channel(
        fixture.session.clone(),
        permit,
        Instant::now() + Duration::from_millis(50)
    )
    .await
    .is_err());
    drop(held);
    assert!(gate.acquire(&fixture.session).is_ok());
    assert_eq!(gate.capacity.available_permits(), 2);
    assert!(gate.blocked.lock().unwrap().is_empty());
}

#[tokio::test]
async fn retry_waiting_during_grace_cannot_open_after_a_transport_is_disabled() {
    let fixture = transport().await;
    let gate = Arc::new(Opens::default());
    let first_permit = gate.acquire(&fixture.session).unwrap();
    let first_session = fixture.session.clone();
    let first = tokio::spawn(async move {
        open_channel(
            first_session,
            first_permit,
            Instant::now() + Duration::from_millis(150),
        )
        .await
    });
    timeout(Duration::from_secs(3), fixture.opened.notified())
        .await
        .unwrap();
    let second_permit = gate.acquire(&fixture.session).unwrap();
    let second_session = fixture.session.clone();
    let second = tokio::spawn(async move {
        open_channel(
            second_session,
            second_permit,
            Instant::now() + Duration::from_secs(2),
        )
        .await
    });
    assert!(first.await.unwrap().is_err());
    let error = timeout(Duration::from_secs(1), second)
        .await
        .unwrap()
        .unwrap()
        .err()
        .unwrap();
    assert!(
        error.starts_with("Administrator edits are disabled after"),
        "queued retry must refuse at the post-lock gate, not send another SSH request"
    );
    assert!(fixture.session.try_lock().is_ok());
    assert_eq!(gate.capacity.available_permits(), 2);
}

#[tokio::test]
async fn successful_but_unconsumed_channel_reply_still_closes_on_caller_cancellation() {
    let fixture = transport().await;
    let gate = Arc::new(Opens::default());
    let opening = gate.acquire(&fixture.session).unwrap();
    fixture.release.notify_one();
    let channel = fixture
        .session
        .lock()
        .await
        .channel_open_session()
        .await
        .unwrap();
    let (sender, unpolled) = oneshot::channel();
    assert!(sender
        .send(Opened {
            channel: Some(channel),
            opening: Some(opening)
        })
        .is_ok());
    assert_eq!(gate.capacity.available_permits(), 1);
    drop(unpolled);
    timeout(Duration::from_secs(3), fixture.closed.notified())
        .await
        .unwrap();
    timeout(Duration::from_secs(3), async {
        while gate.capacity.available_permits() != 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}
