//! Encrypted in-memory upgrade checks: authentication, SFTP and forwarding.
//! Fixtures never read credentials, connect sockets or mutate real files.

use super::{keyboard_interactive, keys, SshManager};
use crate::types::{AuthMethod, ConnectionConfig};
use russh::{client, server, Channel, ChannelId, ChannelOpenFailure, MethodKind, MethodSet};
use russh_sftp::protocol::{Attrs, Data, FileAttributes, Handle, OpenFlags, Status, StatusCode};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const CONTENT: &[u8] = b"encrypted SSH to SFTP fixture bytes\0\xff\r\n";
const DEADLINE: Duration = Duration::from_secs(20);
const OUTPUT_CHUNKS: usize = 256;
const OUTPUT_CHUNK_BYTES: usize = 16 * 1024;

/// Pin the generated fixture key; certificates and unrelated keys fail closed.
struct Client(keys::PublicKey);

impl client::Handler for Client {
    type Error = anyhow::Error;
    async fn check_server_key(
        &mut self,
        key: &keys::PublicKeyOrCertificate,
    ) -> anyhow::Result<bool> {
        Ok(matches!(key, keys::PublicKeyOrCertificate::PublicKey { key, .. } if *key == self.0))
    }
}

/// Serve only a fixed byte slice; no filesystem or ambient account access exists.
struct MemoryFile;

impl russh_sftp::server::Handler for MemoryFile {
    type Error = StatusCode;
    fn unimplemented(&self) -> StatusCode {
        StatusCode::OpUnsupported
    }
    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, StatusCode> {
        if path != "/fixture" {
            return Err(StatusCode::NoSuchFile);
        }
        let mut attrs = FileAttributes::empty();
        attrs.size = Some(CONTENT.len() as u64);
        attrs.permissions = Some(0o100400);
        Ok(Attrs { id, attrs })
    }
    async fn open(
        &mut self,
        id: u32,
        path: String,
        flags: OpenFlags,
        _: FileAttributes,
    ) -> Result<Handle, StatusCode> {
        if path != "/fixture" || flags.bits() != OpenFlags::READ.bits() {
            return Err(StatusCode::PermissionDenied);
        }
        Ok(Handle { id, handle: path })
    }
    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, StatusCode> {
        if handle != "/fixture" {
            return Err(StatusCode::NoSuchFile);
        }
        let offset = usize::try_from(offset).map_err(|_| StatusCode::Eof)?;
        if offset >= CONTENT.len() {
            return Err(StatusCode::Eof);
        }
        Ok(Data {
            id,
            data: CONTENT[offset..CONTENT.len().min(offset.saturating_add(len as usize))].to_vec(),
        })
    }
    async fn close(&mut self, id: u32, _: String) -> Result<Status, StatusCode> {
        Ok(Status {
            id,
            status_code: StatusCode::Ok,
            error_message: String::new(),
            language_tag: String::new(),
        })
    }
}

/// Authenticate explicit fixture credentials and accept SFTP or echo-forward channels.
struct Server {
    key: keys::PublicKey,
    certificate: Option<keys::Certificate>,
    verification_round: Option<usize>,
    sessions: HashMap<ChannelId, Channel<server::Msg>>,
    output_tasks: tokio::task::JoinSet<anyhow::Result<()>>,
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
    async fn auth_publickey(
        &mut self,
        user: &str,
        key: server::VerifiedPublicKey<'_>,
    ) -> anyhow::Result<server::Auth> {
        Ok(
            if self.certificate.is_none() && user == "fixture" && key.public_key == &self.key {
                if self.verification_round.is_some() {
                    return Ok(server::Auth::Reject {
                        proceed_with_methods: Some(MethodSet::from(
                            &[MethodKind::KeyboardInteractive][..],
                        )),
                        partial_success: true,
                    });
                }
                server::Auth::Accept
            } else {
                server::Auth::reject()
            },
        )
    }
    /// Exercise an empty round, a mixed-echo round, and a second masked round.
    async fn auth_keyboard_interactive(
        &mut self,
        user: &str,
        _: &str,
        mut response: Option<server::Response<'_>>,
    ) -> anyhow::Result<server::Auth> {
        let Some(round) = self
            .verification_round
            .as_mut()
            .filter(|_| user == "fixture")
        else {
            return Ok(server::Auth::reject());
        };
        let answers: Vec<_> = response.iter_mut().flatten().collect();
        let prompts = match (*round, answers.as_slice()) {
            (0, []) if response.is_none() => vec![],
            (1, []) if response.is_some() => {
                vec![("Account".into(), true), ("OTP".into(), false)]
            }
            (2, [name, code]) if name.as_ref() == b"fixture" && code.as_ref() == b"012345" => {
                vec![("Backup verification".into(), false)]
            }
            (3, [code]) if code.as_ref() == b"final" => return Ok(server::Auth::Accept),
            (3, [code]) if code.as_ref() == b"more" => {
                return Ok(server::Auth::Reject {
                    proceed_with_methods: Some(MethodSet::from(&[MethodKind::Password][..])),
                    partial_success: true,
                });
            }
            _ => return Ok(server::Auth::reject()),
        };
        *round += 1;
        Ok(server::Auth::Partial {
            name: "".into(),
            instructions: "".into(),
            prompts: prompts.into(),
        })
    }
    async fn auth_openssh_certificate(
        &mut self,
        user: &str,
        certificate: &keys::Certificate,
    ) -> anyhow::Result<server::Auth> {
        Ok(
            if user == "fixture" && self.certificate.as_ref() == Some(certificate) {
                server::Auth::Accept
            } else {
                server::Auth::reject()
            },
        )
    }
    async fn channel_open_session(
        &mut self,
        channel: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> anyhow::Result<()> {
        self.sessions.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }
    async fn subsystem_request(
        &mut self,
        id: ChannelId,
        name: &str,
        session: &mut server::Session,
    ) -> anyhow::Result<()> {
        if name != "sftp" {
            session.channel_failure(id)?;
            return Ok(());
        }
        let channel = self.sessions.remove(&id).expect("known fixture channel");
        session.channel_success(id)?;
        tokio::spawn(russh_sftp::server::run(channel.into_stream(), MemoryFile));
        Ok(())
    }
    /// Generate bounded chunks through the published channel API, including stderr and exit tail.
    async fn exec_request(
        &mut self,
        id: ChannelId,
        command: &[u8],
        session: &mut server::Session,
    ) -> anyhow::Result<()> {
        if command != b"fixture-output" {
            session.channel_failure(id)?;
            return Ok(());
        }
        let channel = self.sessions.remove(&id).expect("known fixture channel");
        session.channel_success(id)?;
        // The server owns this task, so failed/timeout fixtures also cancel its producer.
        self.output_tasks.spawn(async move {
            for index in 0..OUTPUT_CHUNKS {
                let marker = (index % 251) as u8;
                channel.data_bytes(vec![marker; OUTPUT_CHUNK_BYTES]).await?;
                channel.extended_data(1, &[marker][..]).await?;
            }
            channel.exit_status(17).await?;
            channel.eof().await?;
            channel.close().await?;
            Ok(())
        });
        Ok(())
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
    ) -> anyhow::Result<()> {
        if host != "fixture.invalid" || port != 4242 {
            reply
                .reject(ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        }
        reply.accept().await;
        tokio::spawn(async move {
            let (mut read, mut write) = tokio::io::split(channel.into_stream());
            let _ = tokio::io::copy(&mut read, &mut write).await;
            let _ = write.shutdown().await;
        });
        Ok(())
    }
}

/// Abort fixture transport on success, assertion failure or the enclosing timeout.
struct Transport {
    client: client::Handle<Client>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Transport {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Exercise production encryption and channel framing over a bounded memory pipe.
async fn transport(user_key: &keys::PublicKey) -> Transport {
    transport_with_certificate(user_key, None).await
}

/// Reuse the bounded encrypted fixture with an optional certificate-only authentication policy.
async fn transport_with_certificate(
    user_key: &keys::PublicKey,
    certificate: Option<keys::Certificate>,
) -> Transport {
    transport_with_auth(user_key, certificate, false).await
}

/// Build an encrypted fixture with optional certificate or challenge authentication.
async fn transport_with_auth(
    user_key: &keys::PublicKey,
    certificate: Option<keys::Certificate>,
    require_verification: bool,
) -> Transport {
    let host_key =
        keys::PrivateKey::random(&mut keys::key::safe_rng(), keys::Algorithm::Ed25519).unwrap();
    let expected_host_key = host_key.public_key().clone();
    let config = Arc::new(server::Config {
        keys: vec![host_key],
        auth_rejection_time: Duration::ZERO,
        auth_rejection_time_initial: Some(Duration::ZERO),
        ..Default::default()
    });
    let server = Server {
        key: user_key.clone(),
        certificate,
        verification_round: require_verification.then_some(0),
        sessions: HashMap::new(),
        output_tasks: tokio::task::JoinSet::new(),
    };
    let (local, remote) = tokio::io::duplex(64 * 1024);
    let task = tokio::spawn(async move {
        let session = server::run_stream(config, remote, server).await.unwrap();
        let _ = session.await;
    });
    let client = client::connect_stream(
        Arc::new(client::Config::default()),
        local,
        Client(expected_host_key),
    )
    .await
    .unwrap();
    Transport { client, task }
}

/// Produce a real primary-factor partial success using a generated fixture key.
async fn begin_verification() -> (Transport, client::AuthResult, ConnectionConfig) {
    let key =
        keys::PrivateKey::random(&mut keys::key::safe_rng(), keys::Algorithm::Ed25519).unwrap();
    let mut encoded = Vec::new();
    keys::encode_pkcs8_pem(&key, &mut encoded).unwrap();
    let mut fixture = transport_with_auth(key.public_key(), None, true).await;
    let result = SshManager::auth_with_key_data(
        &mut fixture.client,
        "fixture",
        std::str::from_utf8(&encoded).unwrap(),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    let config = ConnectionConfig {
        id: "fixture-hop".into(),
        name: "Fixture hop".into(),
        host: "jump.fixture.invalid".into(),
        port: 2222,
        username: "fixture".into(),
        auth_method: AuthMethod::Password {
            password: String::new(),
        },
        certificate_path: None,
        network_interface_id: None,
        agent_forwarding: None,
        jump_host: None,
        host_key_approval: None,
        connect_attempt_id: None,
    };
    (fixture, result, config)
}

/// Use the same serialized challenge that the desktop renderer receives.
fn verification_channel() -> (
    keyboard_interactive::Attempt,
    tokio::sync::mpsc::UnboundedReceiver<serde_json::Value>,
) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let channel = tauri::ipc::Channel::new(move |payload| {
        let tauri::ipc::InvokeResponseBody::Json(value) = payload else {
            panic!("expected a JSON challenge")
        };
        tx.send(serde_json::from_str(&value).unwrap()).unwrap();
        Ok(())
    });
    (
        keyboard_interactive::Attempt::for_test("attempt", "main", channel),
        rx,
    )
}

/// Keep challenge replies isolated while exercising accept, reject and cancel.
#[tokio::test]
async fn keyboard_interactive_keeps_rounds_scoped_after_public_key_success() {
    tokio::time::timeout(DEADLINE, async {
        for (last_answer, expected_failure) in [
            (Some("final"), None),
            (Some("expired"), Some("SSH verification was rejected")),
            (
                Some("more"),
                Some("The SSH server requires an additional authentication method that Zync does not support"),
            ),
            (None, Some("SSH verification cancelled")),
        ] {
            let (mut fixture, primary, config) = begin_verification().await;
            let broker = keyboard_interactive::PromptBroker::default();
            let (attempt, mut messages) = verification_channel();
            let exchange = broker.complete(&mut fixture.client, &config, primary, Some(&attempt));
            let renderer = async {
                let first = messages.recv().await.unwrap();
                let first_id = first["requestId"].as_str().unwrap();
                assert_eq!(first["attemptId"], "attempt");
                assert_eq!(first["host"], "jump.fixture.invalid");
                assert_eq!(first["port"], 2222);
                assert_eq!(first["prompts"][0]["echo"], true);
                assert_eq!(first["prompts"][1]["echo"], false);
                assert!(broker
                    .reply("other-window", "attempt", first_id, None)
                    .is_err());
                assert!(broker
                    .reply("main", "wrong-attempt", first_id, None)
                    .is_err());
                assert!(broker
                    .reply("main", "attempt", first_id, Some(vec![]))
                    .is_err());
                broker
                    .reply(
                        "main",
                        "attempt",
                        first_id,
                        Some(vec!["fixture".into(), "012345".into()]),
                    )
                    .unwrap();
                let next = messages.recv().await.unwrap();
                let next_id = next["requestId"].as_str().unwrap();
                assert_ne!(next_id, first_id);
                assert!(broker.reply("main", "attempt", first_id, None).is_err());
                broker
                    .reply(
                        "main",
                        "attempt",
                        next_id,
                        last_answer.map(|code| vec![code.into()]),
                    )
                    .unwrap();
            };
            let (result, ()) = tokio::join!(exchange, renderer);
            match expected_failure {
                Some(message) => assert_eq!(result.unwrap_err().to_string(), message),
                None => assert!(result.is_ok()),
            }
        }
    })
    .await
    .expect("keyboard-interactive transport timed out");
}

/// Headless calls skip prompts and cancelled foreground futures release their round.
#[tokio::test]
async fn keyboard_interactive_background_and_aborted_attempts_leave_no_reply_owner() {
    tokio::time::timeout(DEADLINE, async {
        let (mut fixture, primary, config) = begin_verification().await;
        let broker = keyboard_interactive::PromptBroker::default();
        let background = broker
            .complete(&mut fixture.client, &config, primary.clone(), None)
            .await;
        assert!(background
            .unwrap_err()
            .to_string()
            .starts_with("SSH verification required"));
        let (attempt, mut messages) = verification_channel();
        let mut exchange =
            Box::pin(broker.complete(&mut fixture.client, &config, primary, Some(&attempt)));
        let first = tokio::select! {
            result = &mut exchange => panic!("exchange ended before prompting: {result:?}"),
            first = messages.recv() => first.unwrap(),
        };
        drop(exchange);
        assert!(broker
            .reply(
                "main",
                "attempt",
                first["requestId"].as_str().unwrap(),
                None
            )
            .is_err());
    })
    .await
    .expect("keyboard-interactive cancellation timed out");
}

#[tokio::test]
async fn user_certificate_authentication_uses_certificate_without_bare_key_fallback() {
    // RSA generation must not consume the encrypted-transport deadline under parallel CI load.
    for algorithm in [
        keys::Algorithm::Ed25519,
        keys::Algorithm::Rsa { hash: None },
    ] {
        let key = keys::PrivateKey::random(&mut keys::key::safe_rng(), algorithm).unwrap();
        tokio::time::timeout(DEADLINE, async {
            let ca = keys::PrivateKey::random(&mut keys::key::safe_rng(), keys::Algorithm::Ed25519)
                .unwrap();
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs();
            let mut builder = keys::ssh_key::certificate::Builder::new(
                vec![7; 32],
                key.public_key().key_data().clone(),
                now - 1,
                now + 300,
            )
            .unwrap();
            builder.valid_principal("fixture").unwrap();
            let cert = builder.sign(&ca).unwrap();
            let certificate_text = cert.to_openssh().unwrap();
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("user-cert.pub");
            std::fs::write(&path, cert.to_openssh().unwrap()).unwrap();
            let mut encoded = Vec::new();
            keys::encode_pkcs8_pem(&key, &mut encoded).unwrap();
            let encoded = String::from_utf8(encoded).unwrap();
            let mut fixture =
                transport_with_certificate(key.public_key(), Some(cert.clone())).await;
            assert!(!SshManager::auth_with_key_data(
                &mut fixture.client,
                "fixture",
                &encoded,
                None,
                None,
                None
            )
            .await
            .unwrap()
            .success());
            assert!(SshManager::auth_with_key_data(
                &mut fixture.client,
                "fixture",
                &encoded,
                None,
                path.to_str(),
                None,
            )
            .await
            .unwrap()
            .success());
            // The backend-only vault attachment uses the identical SSH certificate exchange.
            let mut fixture = transport_with_certificate(key.public_key(), Some(cert)).await;
            assert!(SshManager::auth_with_key_data(
                &mut fixture.client,
                "fixture",
                &encoded,
                None,
                None,
                Some(&certificate_text),
            )
            .await
            .unwrap()
            .success());
            // A bad configured certificate must fail even when the server accepts the bare key.
            let mut fixture = transport(key.public_key()).await;
            std::fs::write(&path, "invalid certificate").unwrap();
            assert!(SshManager::auth_with_key_data(
                &mut fixture.client,
                "fixture",
                &encoded,
                None,
                path.to_str(),
                Some(&certificate_text),
            )
            .await
            .is_err());
            assert!(SshManager::auth_with_key_data(
                &mut fixture.client,
                "fixture",
                &encoded,
                None,
                None,
                Some("invalid certificate"),
            )
            .await
            .is_err());
        })
        .await
        .expect("certificate transport timed out");
    }
}

#[tokio::test]
async fn published_session_channel_preserves_stdout_stderr_and_exit_tail() {
    tokio::time::timeout(DEADLINE, async {
        let key =
            keys::PrivateKey::random(&mut keys::key::safe_rng(), keys::Algorithm::Ed25519).unwrap();
        let mut fixture = transport(key.public_key()).await;
        assert!(fixture
            .client
            .authenticate_password("fixture", "fixture-only-secret")
            .await
            .unwrap()
            .success());
        let mut channel = fixture.client.channel_open_session().await.unwrap();
        channel.exec(true, "fixture-output").await.unwrap();
        let (mut stdout, mut stderr) = (0, 0);
        let (mut status, mut eof, mut closed) = (None, false, false);
        while let Some(message) = channel.wait().await {
            match message {
                russh::ChannelMsg::Data { data } => {
                    for byte in data {
                        assert_eq!(byte, ((stdout / OUTPUT_CHUNK_BYTES) % 251) as u8);
                        stdout += 1;
                    }
                }
                russh::ChannelMsg::ExtendedData { ext, data } => {
                    assert_eq!(ext, 1);
                    for byte in data {
                        assert_eq!(byte, (stderr % 251) as u8);
                        stderr += 1;
                    }
                }
                russh::ChannelMsg::ExitStatus { exit_status } => {
                    assert_eq!(stdout, OUTPUT_CHUNKS * OUTPUT_CHUNK_BYTES);
                    assert_eq!(stderr, OUTPUT_CHUNKS);
                    status = Some(exit_status);
                }
                russh::ChannelMsg::Eof => eof = true,
                russh::ChannelMsg::Close => {
                    closed = true;
                    break;
                }
                _ => {}
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(stdout, OUTPUT_CHUNKS * OUTPUT_CHUNK_BYTES);
        assert_eq!(stderr, OUTPUT_CHUNKS);
        assert_eq!(status, Some(17));
        assert!(eof && closed);
    })
    .await
    .expect("published SSH session output check timed out");
}

#[tokio::test]
async fn encrypted_password_sftp_and_direct_forwarding_remain_compatible() {
    tokio::time::timeout(DEADLINE, async {
        let key =
            keys::PrivateKey::random(&mut keys::key::safe_rng(), keys::Algorithm::Ed25519).unwrap();
        let mut fixture = transport(key.public_key()).await;
        assert!(!fixture
            .client
            .authenticate_password("fixture", "wrong")
            .await
            .unwrap()
            .success());
        assert!(fixture
            .client
            .authenticate_password("fixture", "fixture-only-secret")
            .await
            .unwrap()
            .success());

        let channel = fixture.client.channel_open_session().await.unwrap();
        channel.request_subsystem(true, "sftp").await.unwrap();
        let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .unwrap();
        assert_eq!(
            sftp.symlink_metadata("/fixture").await.unwrap().size,
            Some(CONTENT.len() as u64)
        );
        let mut file = sftp.open("/fixture").await.unwrap();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(bytes, CONTENT);
        file.shutdown().await.unwrap();
        sftp.close().await.unwrap();

        assert!(fixture
            .client
            .channel_open_direct_tcpip("wrong.invalid", 4242, "127.0.0.1", 0)
            .await
            .is_err());
        let channel = fixture
            .client
            .channel_open_direct_tcpip("fixture.invalid", 4242, "127.0.0.1", 0)
            .await
            .unwrap();
        let mut stream = channel.into_stream();
        stream.write_all(CONTENT).await.unwrap();
        let mut echoed = vec![0; CONTENT.len()];
        stream.read_exact(&mut echoed).await.unwrap();
        assert_eq!(echoed, CONTENT);
        stream.shutdown().await.unwrap();
    })
    .await
    .expect("in-memory SSH/SFTP/forward compatibility check timed out");
}

#[tokio::test]
async fn encrypted_private_key_authentication_uses_the_production_decoder_and_hash_policy() {
    for algorithm in [
        keys::Algorithm::Ed25519,
        keys::Algorithm::Rsa { hash: None },
    ] {
        let key = keys::PrivateKey::random(&mut keys::key::safe_rng(), algorithm).unwrap();
        // Test-only low-cost KDF: this checks wire compatibility, not KDF throughput.
        let openssh = key
            .encrypt_with(
                keys::ssh_key::Cipher::Aes256Ctr,
                keys::ssh_key::Kdf::Bcrypt {
                    salt: vec![17; 16],
                    rounds: 1,
                },
                0x1234_5678,
                b"fixture passphrase",
            )
            .unwrap()
            .to_openssh(keys::ssh_key::LineEnding::LF)
            .unwrap();
        assert!(matches!(
            keys::decode_secret_key(&openssh, None),
            Err(keys::Error::KeyIsEncrypted)
        ));
        assert!(keys::decode_secret_key(&openssh, Some("wrong")).is_err());
        assert_eq!(
            keys::decode_secret_key(&openssh, Some("fixture passphrase"))
                .unwrap()
                .public_key(),
            key.public_key(),
        );
        let mut encoded = Vec::new();
        keys::encode_pkcs8_pem_encrypted(&key, b"fixture passphrase", 2, &mut encoded).unwrap();
        let encoded = String::from_utf8(encoded).unwrap();
        // CPU-bound RSA generation/KDF checks above must not consume the
        // transport deadline under the full suite's parallel crypto load.
        let mut fixture = tokio::time::timeout(DEADLINE, transport(key.public_key()))
            .await
            .expect("in-memory private-key transport handshake timed out");
        assert!(tokio::time::timeout(
            DEADLINE,
            SshManager::auth_with_key_data(
                &mut fixture.client,
                "fixture",
                &encoded,
                Some("wrong"),
                None,
                None
            )
        )
        .await
        .expect("rejected private-key authentication timed out")
        .is_err());
        assert!(tokio::time::timeout(
            DEADLINE,
            SshManager::auth_with_key_data(
                &mut fixture.client,
                "fixture",
                &encoded,
                Some("fixture passphrase"),
                None,
                None,
            )
        )
        .await
        .expect("accepted private-key authentication timed out")
        .unwrap()
        .success());
    }
}
