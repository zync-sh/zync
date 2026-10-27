//! Protocol-level isolation checks over encrypted memory SSH and memory SFTP.
//! No fixture executes a command, reads an account or touches a real file.

use super::run;
use crate::commands::{ssh_exec_remote, ConnectionHandle};
use crate::types::{AuthMethod, ConnectionConfig};
use russh::{client, server, Channel, ChannelId};
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::sync::{Mutex, Notify};

const DEADLINE: Duration = Duration::from_secs(10);
const ACCESS_DEADLINE: Duration = Duration::from_secs(1);
const STDOUT: &[u8] = b"fixture stdout\n";
const STDERR: &[u8] = b"fixture stderr\n";
type Session = Arc<Mutex<client::Handle<crate::ssh::Client>>>;
type Connections = Arc<Mutex<HashMap<String, ConnectionHandle>>>;

struct Task<T>(tokio::task::JoinHandle<T>);
impl<T> Task<T> {
    async fn result(&mut self) -> T {
        tokio::time::timeout(DEADLINE, &mut self.0)
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

#[derive(Clone, Copy)]
enum Behavior {
    Immediate(u32),
    GateFirstExec,
    GateFirstOpen,
    RejectExec,
    EchoInput,
    WriteStatuses {
        mkdir: Option<u32>,
        write: Option<u32>,
    },
    ExitStreamingWriteEarly(u32),
}

#[derive(Default)]
struct Observed {
    commands: StdMutex<Vec<Vec<u8>>>,
    input: StdMutex<Vec<u8>>,
    opening: Notify,
    started: Notify,
    release: Notify,
    closed: Notify,
}

struct Server {
    behavior: Behavior,
    observed: Arc<Observed>,
    channels: HashMap<ChannelId, Channel<server::Msg>>,
    pending_write_statuses: HashMap<ChannelId, Option<u32>>,
    tasks: tokio::task::JoinSet<()>,
    opens: usize,
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
        self.opens += 1;
        if matches!(self.behavior, Behavior::GateFirstOpen) && self.opens == 1 {
            self.observed.opening.notify_one();
            self.observed.release.notified().await;
        }
        self.channels.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        id: ChannelId,
        command: &[u8],
        session: &mut server::Session,
    ) -> anyhow::Result<()> {
        let first = {
            let mut commands = self.observed.commands.lock().unwrap();
            commands.push(command.to_vec());
            commands.len() == 1
        };
        self.observed.started.notify_one();
        if matches!(self.behavior, Behavior::RejectExec) {
            session.channel_failure(id)?;
            return Ok(());
        }
        session.channel_success(id)?;
        if matches!(self.behavior, Behavior::EchoInput) {
            return Ok(());
        }
        if let Behavior::ExitStreamingWriteEarly(code) = self.behavior {
            if command.starts_with(b"base64 -d > ") {
                // A shell can reject its output redirection before reading stdin.
                session.extended_data(id, 1, STDERR)?;
                session.exit_status_request(id, code)?;
                session.eof(id)?;
                session.close(id)?;
            } else {
                assert!(command.starts_with(b"mkdir -p "));
                let channel = self.channels.remove(&id).expect("known mkdir channel");
                self.tasks.spawn(send_write_result(channel, Some(0)));
            }
            return Ok(());
        }
        if let Behavior::WriteStatuses { mkdir, write } = self.behavior {
            let status = if command.starts_with(b"mkdir -p ") {
                mkdir
            } else {
                write
            };
            if command.starts_with(b"base64 -d > ") {
                // Large-write status is sent only after all stdin and EOF arrive.
                self.pending_write_statuses.insert(id, status);
            } else {
                let channel = self.channels.remove(&id).expect("known write channel");
                self.tasks.spawn(send_write_result(channel, status));
            }
            return Ok(());
        }
        let channel = self.channels.remove(&id).expect("known fixture channel");
        let observed = self.observed.clone();
        let wait = first && matches!(self.behavior, Behavior::GateFirstExec);
        let exit_status = match self.behavior {
            Behavior::Immediate(code) => code,
            _ => 0,
        };
        self.tasks.spawn(async move {
            if wait {
                observed.release.notified().await;
            }
            let _ = channel.data(STDOUT).await;
            let _ = channel.extended_data(1, STDERR).await;
            let _ = channel.exit_status(exit_status).await;
            let _ = channel.eof().await;
            let _ = channel.close().await;
        });
        Ok(())
    }

    async fn data(
        &mut self,
        _: ChannelId,
        bytes: &[u8],
        _: &mut server::Session,
    ) -> anyhow::Result<()> {
        self.observed.input.lock().unwrap().extend_from_slice(bytes);
        Ok(())
    }

    async fn channel_eof(&mut self, id: ChannelId, _: &mut server::Session) -> anyhow::Result<()> {
        if let Some(status) = self.pending_write_statuses.remove(&id) {
            let channel = self.channels.remove(&id).expect("known streaming write");
            self.tasks.spawn(send_write_result(channel, status));
        } else if matches!(self.behavior, Behavior::EchoInput) {
            let channel = self.channels.remove(&id).expect("known stdin channel");
            let input = self.observed.input.lock().unwrap().clone();
            self.tasks.spawn(async move {
                let _ = channel.data(&input[..]).await;
                let _ = channel.exit_status(0).await;
                let _ = channel.eof().await;
                let _ = channel.close().await;
            });
        }
        Ok(())
    }

    async fn channel_close(
        &mut self,
        id: ChannelId,
        _: &mut server::Session,
    ) -> anyhow::Result<()> {
        self.channels.remove(&id);
        self.pending_write_statuses.remove(&id);
        self.observed.closed.notify_one();
        Ok(())
    }
}

async fn send_write_result(channel: Channel<server::Msg>, status: Option<u32>) {
    // Success-looking output must never override a failed or missing exit status.
    let _ = channel.data(&b"Written successfully\n"[..]).await;
    let _ = channel.extended_data(1, STDERR).await;
    if let Some(status) = status {
        let _ = channel.exit_status(status).await;
    }
    let _ = channel.eof().await;
    let _ = channel.close().await;
}

struct Fixture {
    session: Session,
    observed: Arc<Observed>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn fixture(behavior: Behavior) -> Fixture {
    let (local, remote) = tokio::io::duplex(256 * 1024);
    let key = russh::keys::PrivateKey::random(
        &mut russh::keys::key::safe_rng(),
        russh::keys::Algorithm::Ed25519,
    )
    .unwrap();
    let public = key.public_key().clone();
    let mut config = server::Config {
        keys: vec![key],
        auth_rejection_time: Duration::ZERO,
        auth_rejection_time_initial: Some(Duration::ZERO),
        ..Default::default()
    };
    if matches!(behavior, Behavior::ExitStreamingWriteEarly(_)) {
        // The payload cannot all be sent before the early rejection arrives.
        config.window_size = 1024;
    }
    let config = Arc::new(config);
    let observed = Arc::new(Observed::default());
    let handler = Server {
        behavior,
        observed: observed.clone(),
        channels: HashMap::new(),
        pending_write_statuses: HashMap::new(),
        tasks: tokio::task::JoinSet::new(),
        opens: 0,
    };
    let task = tokio::spawn(async move {
        let running = server::run_stream(config, remote, handler).await.unwrap();
        let _ = running.await;
    });
    let session =
        crate::ssh::connect_runtime_stream_fixture(local, public, "fixture", "fixture-only-secret")
            .await
            .expect("authenticate against pinned disposable fixture");
    Fixture {
        session: Arc::new(Mutex::new(session)),
        observed,
        task,
    }
}

fn connection(
    session: Option<Session>,
    sftp_session: Option<Arc<russh_sftp::client::SftpSession>>,
) -> ConnectionHandle {
    ConnectionHandle {
        config: ConnectionConfig {
            id: "fixture".into(),
            name: "Disposable fixture".into(),
            host: "fixture.invalid".into(),
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
        session,
        sftp_session,
        file_permission_session: "fixture".into(),
        sftp_identity_maps: Arc::new(tokio::sync::OnceCell::new()),
        detected_os: None,
        detected_kernel_os: None,
        detected_shell: None,
        auth_banner: None,
        host_key_fingerprint: "fixture-only".into(),
        uses_vault_auth: false,
        reconnect_generation: 1,
        reconnect_lock: Arc::new(Mutex::new(())),
    }
}

async fn notified(notify: &Notify) {
    tokio::time::timeout(DEADLINE, notify.notified())
        .await
        .expect("fixture event deadline");
}

#[tokio::test]
async fn runner_preserves_stdout_stderr_and_exit_status() {
    let fixture = fixture(Behavior::Immediate(17)).await;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let status = run(
        fixture.session.clone(),
        "fixture-output",
        None,
        DEADLINE,
        |stream, bytes| {
            if stream == 0 {
                stdout.extend_from_slice(bytes);
            } else {
                stderr.extend_from_slice(bytes);
            }
        },
    )
    .await
    .unwrap();
    assert_eq!(status, Some(17));
    assert_eq!(stdout, STDOUT);
    assert_eq!(stderr, STDERR);
}

#[tokio::test]
async fn runner_delivers_stdin_and_eof_before_collecting_output() {
    let fixture = fixture(Behavior::EchoInput).await;
    let input = b"fixture stdin\0\xff\n";
    let mut output = Vec::new();
    assert_eq!(
        run(
            fixture.session.clone(),
            "fixture-input",
            Some(input),
            DEADLINE,
            |stream, data| {
                if stream == 0 {
                    output.extend_from_slice(data);
                }
            }
        )
        .await
        .unwrap(),
        Some(0)
    );
    assert_eq!(output, input);
    assert_eq!(&*fixture.observed.input.lock().unwrap(), input);
}

#[tokio::test]
async fn exec_releases_registry_and_session_while_waiting_for_output() {
    let original = fixture(Behavior::GateFirstExec).await;
    let replacement = fixture(Behavior::Immediate(0)).await;
    let connections: Connections = Arc::new(Mutex::new(HashMap::from([(
        "fixture".into(),
        connection(Some(original.session.clone()), None),
    )])));
    let registry = connections.clone();
    let mut work = Task(tokio::spawn(async move {
        ssh_exec_remote(&registry, "fixture", "fixture-waits").await
    }));
    notified(&original.observed.started).await;
    assert!(!work.0.is_finished(), "output remains parked by the server");
    {
        let mut registry = tokio::time::timeout(ACCESS_DEADLINE, connections.lock())
            .await
            .expect("pending exec must not retain the global registry");
        registry.remove("fixture");
        registry.insert(
            "fixture".into(),
            connection(Some(replacement.session.clone()), None),
        );
        registry.insert("another-host".into(), connection(None, None));
    }
    drop(
        tokio::time::timeout(ACCESS_DEADLINE, original.session.lock())
            .await
            .expect("pending command output must not retain the session guard"),
    );
    original.observed.release.notify_one();
    assert_eq!(work.result().await.unwrap().as_bytes(), STDOUT);
    assert!(
        replacement.observed.commands.lock().unwrap().is_empty(),
        "an accepted command must never retarget a replacement transport"
    );
}

#[tokio::test]
async fn exec_reports_remote_failure_with_stderr() {
    let fixture = fixture(Behavior::Immediate(9)).await;
    let connections = Mutex::new(HashMap::from([(
        "fixture".into(),
        connection(Some(fixture.session.clone()), None),
    )]));
    let error = ssh_exec_remote(&connections, "fixture", "fixture-fails")
        .await
        .unwrap_err();
    assert!(error.contains('9'));
    assert!(error.contains("fixture stderr"));
}

#[tokio::test]
async fn timed_out_command_closes_its_channel_and_preserves_shared_transport() {
    let fixture = fixture(Behavior::GateFirstExec).await;
    let session = fixture.session.clone();
    let mut work = Task(tokio::spawn(async move {
        run(
            session,
            "fixture-timeout",
            None,
            Duration::from_secs(1),
            |_, _| {},
        )
        .await
    }));
    notified(&fixture.observed.started).await;
    let error = work.result().await.unwrap_err();
    assert!(error.to_lowercase().contains("timed out"), "{error}");
    notified(&fixture.observed.closed).await;
    fixture.observed.release.notify_one();
    assert_eq!(
        run(
            fixture.session.clone(),
            "fixture-after-timeout",
            None,
            DEADLINE,
            |_, _| {}
        )
        .await
        .unwrap(),
        Some(0)
    );
}

#[tokio::test]
async fn canceled_command_closes_its_channel() {
    let fixture = fixture(Behavior::GateFirstExec).await;
    let session = fixture.session.clone();
    let mut work = Task(tokio::spawn(async move {
        run(session, "fixture-cancel", None, DEADLINE, |_, _| {}).await
    }));
    notified(&fixture.observed.started).await;
    work.0.abort();
    assert!(tokio::time::timeout(DEADLINE, &mut work.0)
        .await
        .unwrap()
        .unwrap_err()
        .is_cancelled());
    notified(&fixture.observed.closed).await;
}

#[tokio::test]
async fn canceled_channel_open_closes_a_late_accepted_channel() {
    let fixture = fixture(Behavior::GateFirstOpen).await;
    let session = fixture.session.clone();
    let mut work = Task(tokio::spawn(async move {
        run(session, "must-never-execute", None, DEADLINE, |_, _| {}).await
    }));
    notified(&fixture.observed.opening).await;
    work.0.abort();
    assert!(tokio::time::timeout(DEADLINE, &mut work.0)
        .await
        .unwrap()
        .unwrap_err()
        .is_cancelled());
    fixture.observed.release.notify_one();
    notified(&fixture.observed.closed).await;
    assert!(fixture.observed.commands.lock().unwrap().is_empty());
    drop(
        tokio::time::timeout(ACCESS_DEADLINE, fixture.session.lock())
            .await
            .unwrap(),
    );
}

#[tokio::test]
async fn rejected_exec_fails_promptly_and_closes_its_channel() {
    let fixture = fixture(Behavior::RejectExec).await;
    assert!(tokio::time::timeout(
        ACCESS_DEADLINE,
        run(
            fixture.session.clone(),
            "fixture-refused",
            None,
            DEADLINE,
            |_, _| {}
        )
    )
    .await
    .expect("exec rejection must not wait for the command deadline")
    .is_err());
    notified(&fixture.observed.closed).await;
}

#[tokio::test]
async fn ai_write_keeps_one_transport_snapshot_and_releases_registry_during_mkdir() {
    let original = fixture(Behavior::GateFirstExec).await;
    let replacement = fixture(Behavior::Immediate(0)).await;
    let connections: Connections = Arc::new(Mutex::new(HashMap::from([(
        "fixture".into(),
        connection(Some(original.session.clone()), None),
    )])));
    let registry = connections.clone();
    let mut work = Task(tokio::spawn(async move {
        crate::ai::write_remote_file(&registry, "fixture", "/memory/file.txt", "test bytes").await
    }));
    notified(&original.observed.started).await;
    {
        let mut registry = tokio::time::timeout(ACCESS_DEADLINE, connections.lock())
            .await
            .expect("AI mkdir must not retain the global registry");
        registry.insert(
            "fixture".into(),
            connection(Some(replacement.session.clone()), None),
        );
    }
    drop(
        tokio::time::timeout(ACCESS_DEADLINE, original.session.lock())
            .await
            .expect("AI mkdir output must not retain the session guard"),
    );
    original.observed.release.notify_one();
    work.result().await.unwrap();
    let commands = original.observed.commands.lock().unwrap();
    assert_eq!(
        commands.len(),
        2,
        "mkdir and write use the original transport"
    );
    assert!(commands[0].starts_with(b"mkdir -p "));
    assert!(commands[1]
        .windows(b"base64 -d".len())
        .any(|w| w == b"base64 -d"));
    assert!(replacement.observed.commands.lock().unwrap().is_empty());
}

fn assert_write_status_error(error: &str, status: Option<u32>) {
    assert!(error.contains("fixture stderr"), "stderr was lost: {error}");
    match status {
        Some(code) => assert!(
            error.contains(&code.to_string()),
            "exit code was lost: {error}"
        ),
        None => assert!(
            error.contains("exit status"),
            "missing-status reason was lost: {error}"
        ),
    }
}

#[tokio::test]
async fn ai_write_stops_after_failed_or_unconfirmed_parent_mkdir() {
    for status in [Some(13), None] {
        let fixture = fixture(Behavior::WriteStatuses {
            mkdir: status,
            write: Some(0),
        })
        .await;
        let connections = Mutex::new(HashMap::from([(
            "fixture".into(),
            connection(Some(fixture.session.clone()), None),
        )]));
        let error = tokio::time::timeout(
            DEADLINE,
            crate::ai::write_remote_file(&connections, "fixture", "/memory/file.txt", "test bytes"),
        )
        .await
        .expect("mkdir result deadline")
        .expect_err("failed or unconfirmed mkdir must stop the write");
        assert_write_status_error(&error, status);
        let commands = fixture.observed.commands.lock().unwrap();
        assert_eq!(commands.len(), 1, "write ran after mkdir failed");
        assert!(commands[0].starts_with(b"mkdir -p "));
    }
}

#[tokio::test]
async fn ai_inline_and_streaming_writes_reject_nonzero_or_missing_exit_status() {
    use base64::Engine as _;

    for length in [9, 100 * 1024 + 1] {
        for status in [Some(23), None] {
            let fixture = fixture(Behavior::WriteStatuses {
                mkdir: Some(0),
                write: status,
            })
            .await;
            let connections = Mutex::new(HashMap::from([(
                "fixture".into(),
                connection(Some(fixture.session.clone()), None),
            )]));
            let content = "w".repeat(length);
            let error = tokio::time::timeout(
                DEADLINE,
                crate::ai::write_remote_file(&connections, "fixture", "/memory/file.txt", &content),
            )
            .await
            .expect("write result deadline")
            .expect_err("success-looking stdout cannot confirm a failed or unconfirmed write");
            assert_write_status_error(&error, status);
            let commands = fixture.observed.commands.lock().unwrap();
            assert_eq!(commands.len(), 2, "successful mkdir must precede write");
            if length > 100 * 1024 {
                assert!(commands[1].starts_with(b"base64 -d > "));
                assert_eq!(
                    &*fixture.observed.input.lock().unwrap(),
                    base64::engine::general_purpose::STANDARD
                        .encode(content.as_bytes())
                        .as_bytes(),
                    "streaming fixture must consume complete stdin before sending failure",
                );
            } else {
                assert!(commands[1].starts_with(b"printf '%s' "));
            }
        }
    }
}

#[tokio::test]
async fn ai_inline_and_streaming_writes_accept_explicit_zero_status_with_stderr() {
    for length in [9, 100 * 1024 + 1] {
        let fixture = fixture(Behavior::WriteStatuses {
            mkdir: Some(0),
            write: Some(0),
        })
        .await;
        let connections = Mutex::new(HashMap::from([(
            "fixture".into(),
            connection(Some(fixture.session.clone()), None),
        )]));
        let content = "w".repeat(length);
        tokio::time::timeout(
            DEADLINE,
            crate::ai::write_remote_file(&connections, "fixture", "/memory/file.txt", &content),
        )
        .await
        .expect("successful write deadline")
        .expect("explicit zero status must succeed even when stderr contains a warning");
        assert_eq!(fixture.observed.commands.lock().unwrap().len(), 2);
    }
}

#[tokio::test]
async fn ai_streaming_write_preserves_early_failure_without_waiting_for_stdin() {
    for status in [23, 0] {
        let fixture = fixture(Behavior::ExitStreamingWriteEarly(status)).await;
        let connections = Mutex::new(HashMap::from([(
            "fixture".into(),
            connection(Some(fixture.session.clone()), None),
        )]));
        let content = "w".repeat(100 * 1024 + 1);
        let error = tokio::time::timeout(
            DEADLINE,
            crate::ai::write_remote_file(&connections, "fixture", "/memory/file.txt", &content),
        )
        .await
        .expect("early write rejection must return before the command timeout")
        .expect_err("early channel closure cannot confirm complete input delivery");
        if status == 0 {
            assert!(
                error.contains("stdin"),
                "incomplete-input reason was lost: {error}"
            );
            assert!(error.contains(std::str::from_utf8(STDERR).unwrap()));
        } else {
            assert_write_status_error(&error, Some(status));
        }
        let commands = fixture.observed.commands.lock().unwrap();
        assert_eq!(commands.len(), 2, "successful mkdir must precede write");
        assert!(commands[1].starts_with(b"base64 -d > "));
        assert!(
            fixture.observed.input.lock().unwrap().len() < content.len(),
            "remote rejection must happen before the complete stdin is consumed"
        );
    }
}

struct MemorySftp {
    opened: Arc<Notify>,
    release: Arc<Notify>,
    bytes: Arc<StdMutex<Vec<u8>>>,
}

impl russh_sftp::server::Handler for MemorySftp {
    type Error = russh_sftp::protocol::StatusCode;

    fn unimplemented(&self) -> Self::Error {
        russh_sftp::protocol::StatusCode::OpUnsupported
    }

    async fn open(
        &mut self,
        id: u32,
        path: String,
        flags: russh_sftp::protocol::OpenFlags,
        _: russh_sftp::protocol::FileAttributes,
    ) -> Result<russh_sftp::protocol::Handle, Self::Error> {
        assert_eq!(path, "memory.txt");
        assert!(flags.contains(russh_sftp::protocol::OpenFlags::WRITE));
        self.opened.notify_one();
        self.release.notified().await;
        Ok(russh_sftp::protocol::Handle { id, handle: path })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<russh_sftp::protocol::Status, Self::Error> {
        assert_eq!(handle, "memory.txt");
        let mut bytes = self.bytes.lock().unwrap();
        let offset = usize::try_from(offset).unwrap();
        let length = bytes.len().max(offset + data.len());
        bytes.resize(length, 0);
        bytes[offset..offset + data.len()].copy_from_slice(&data);
        Ok(sftp_ok(id))
    }

    async fn close(
        &mut self,
        id: u32,
        _: String,
    ) -> Result<russh_sftp::protocol::Status, Self::Error> {
        Ok(sftp_ok(id))
    }
}

fn sftp_ok(id: u32) -> russh_sftp::protocol::Status {
    russh_sftp::protocol::Status {
        id,
        status_code: russh_sftp::protocol::StatusCode::Ok,
        error_message: String::new(),
        language_tag: String::new(),
    }
}

#[tokio::test]
async fn ai_sftp_write_releases_registry_during_create_and_keeps_captured_sftp() {
    let (local, remote) = tokio::io::duplex(32 * 1024);
    let opened = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let bytes = Arc::new(StdMutex::new(Vec::new()));
    russh_sftp::server::run(
        remote,
        MemorySftp {
            opened: opened.clone(),
            release: release.clone(),
            bytes: bytes.clone(),
        },
    )
    .await;
    let sftp = Arc::new(russh_sftp::client::SftpSession::new(local).await.unwrap());
    let connections: Connections = Arc::new(Mutex::new(HashMap::from([(
        "fixture".into(),
        connection(None, Some(sftp.clone())),
    )])));
    let registry = connections.clone();
    let mut work = Task(tokio::spawn(async move {
        crate::ai::write_remote_file(&registry, "fixture", "memory.txt", "preserved bytes").await
    }));
    notified(&opened).await;
    {
        let mut registry = tokio::time::timeout(ACCESS_DEADLINE, connections.lock())
            .await
            .expect("pending SFTP create must not retain the registry");
        registry.insert("fixture".into(), connection(None, None));
        registry.insert("another-host".into(), connection(None, None));
    }
    release.notify_one();
    work.result().await.unwrap();
    assert_eq!(&*bytes.lock().unwrap(), b"preserved bytes");
    sftp.close().await.unwrap();
}
