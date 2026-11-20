//! Disposable agent and encrypted SSH fixtures; no device keys or external services.

use super::*;
use russh::keys::{
    key::safe_rng, signature::Signer, ssh_encoding::Encode, Algorithm, Certificate, PrivateKey,
    PublicKey,
};
use russh::{client, server};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

const TEST_DEADLINE: Duration = Duration::from_secs(10);
const SHORT_DEADLINE: Duration = Duration::from_millis(30);

#[derive(Clone, Copy, PartialEq)]
enum AgentBehavior {
    Sign,
    Refuse,
    StallIdentities,
    StallBinding,
    UnsupportedBinding,
}

/// Abort the owned in-memory peer even when a failed assertion unwinds the test.
struct AgentFixture {
    task: tokio::task::JoinHandle<()>,
    signatures: Arc<AtomicUsize>,
}

impl AgentFixture {
    /// Surface peer assertions instead of silently discarding a spawned-task panic.
    async fn finish(&mut self) {
        (&mut self.task)
            .await
            .expect("disposable agent completed without protocol failures");
    }
}

impl Drop for AgentFixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Encode an SSH string inside the test-only agent wire protocol.
fn put_string(output: &mut Vec<u8>, bytes: &[u8]) {
    output.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    output.extend_from_slice(bytes);
}

/// Decode only bounded fixture strings; malformed requests fail the test.
fn take_string<'a>(input: &mut &'a [u8]) -> &'a [u8] {
    let length = u32::from_be_bytes(input[..4].try_into().unwrap()) as usize;
    let result = &input[4..4 + length];
    *input = &input[4 + length..];
    result
}

fn identity_blob(identity: &AgentIdentity) -> Vec<u8> {
    match identity {
        AgentIdentity::Certificate { certificate, .. } => certificate.to_bytes().unwrap(),
        AgentIdentity::PublicKey { key, .. } => key.to_bytes().unwrap(),
    }
}

/// Expose real ephemeral public identities and signatures through a bounded memory pipe.
fn agent_fixture(
    identities: Vec<AgentIdentity>,
    key: PrivateKey,
    behavior: AgentBehavior,
) -> (DynamicAgentClient, AgentFixture) {
    let (local, mut remote) = tokio::io::duplex(64 * 1024);
    let signatures = Arc::new(AtomicUsize::new(0));
    let count = signatures.clone();
    let task = tokio::spawn(async move {
        while let Ok(length) = remote.read_u32().await {
            assert!(length > 0 && length <= 64 * 1024);
            let mut frame = vec![0; length as usize];
            remote.read_exact(&mut frame).await.unwrap();
            if (frame[0] == 27 && behavior == AgentBehavior::StallBinding)
                || (frame[0] == 11 && behavior == AgentBehavior::StallIdentities)
            {
                // A metadata timeout must drop the client, not reuse a half-read frame.
                let mut byte = [0];
                assert_eq!(remote.read(&mut byte).await.unwrap(), 0);
                break;
            }
            let response = match frame[0] {
                27 => {
                    vec![if behavior == AgentBehavior::UnsupportedBinding {
                        5
                    } else {
                        6
                    }]
                }
                11 => {
                    let mut response = vec![12];
                    response.extend_from_slice(&(identities.len() as u32).to_be_bytes());
                    for identity in &identities {
                        put_string(&mut response, &identity_blob(identity));
                        put_string(&mut response, b"disposable-fixture");
                    }
                    response
                }
                13 => {
                    count.fetch_add(1, Ordering::SeqCst);
                    let mut input = &frame[1..];
                    let requested = take_string(&mut input);
                    assert!(identities
                        .iter()
                        .any(|identity| identity_blob(identity) == requested
                            && identity.public_key().as_ref() == key.public_key()));
                    let data = take_string(&mut input);
                    assert_eq!(input, &[0, 0, 0, 0], "Ed25519 needs no RSA flags");
                    if behavior == AgentBehavior::Refuse {
                        vec![5]
                    } else {
                        let signature = key.key_data().try_sign(data).unwrap();
                        let mut encoded = Vec::new();
                        signature.encode(&mut encoded).unwrap();
                        let mut response = vec![14];
                        put_string(&mut response, &encoded);
                        response
                    }
                }
                other => panic!("Unexpected agent fixture request {other}"),
            };
            if remote.write_u32(response.len() as u32).await.is_err() {
                break;
            }
            if remote.write_all(&response).await.is_err() {
                break;
            }
        }
    });
    (
        AgentClient::connect(local).dynamic(),
        AgentFixture { task, signatures },
    )
}

/// Pin the generated server key, without consulting or changing known_hosts.
struct TestClient(PublicKey);
impl client::Handler for TestClient {
    type Error = anyhow::Error;
    async fn check_server_key(&mut self, key: &keys::PublicKeyOrCertificate) -> Result<bool> {
        Ok(matches!(key, keys::PublicKeyOrCertificate::PublicKey {key, ..} if *key == self.0))
    }
}

/// Accept only the fixture identity after russh has verified its signature.
struct TestServer {
    key: PublicKey,
    certificate: Option<Certificate>,
}
impl server::Handler for TestServer {
    type Error = anyhow::Error;
    async fn auth_publickey(
        &mut self,
        user: &str,
        key: server::VerifiedPublicKey<'_>,
    ) -> Result<server::Auth> {
        Ok(
            if user == "fixture" && self.certificate.is_none() && key.public_key == &self.key {
                server::Auth::Accept
            } else {
                server::Auth::reject()
            },
        )
    }
    async fn auth_openssh_certificate(
        &mut self,
        user: &str,
        cert: &Certificate,
    ) -> Result<server::Auth> {
        Ok(
            if user == "fixture" && self.certificate.as_ref() == Some(cert) {
                server::Auth::Accept
            } else {
                server::Auth::reject()
            },
        )
    }
}

/// Keep the SSH server task scoped to the test, including early failure paths.
struct SshFixture(tokio::task::JoinHandle<()>);
impl Drop for SshFixture {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn ssh_fixture(
    key: &PublicKey,
    certificate: Option<Certificate>,
) -> (client::Handle<TestClient>, SshFixture) {
    let host_key = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519).unwrap();
    let expected = host_key.public_key().clone();
    let config = Arc::new(server::Config {
        keys: vec![host_key],
        auth_rejection_time: Duration::ZERO,
        auth_rejection_time_initial: Some(Duration::ZERO),
        ..Default::default()
    });
    let (local, remote): (DuplexStream, DuplexStream) = tokio::io::duplex(64 * 1024);
    let handler = TestServer {
        key: key.clone(),
        certificate,
    };
    let task = tokio::spawn(async move {
        let session = server::run_stream(config, remote, handler).await.unwrap();
        let _ = session.await;
    });
    let session = client::connect_stream(
        Arc::new(client::Config::default()),
        local,
        TestClient(expected),
    )
    .await
    .unwrap();
    (session, SshFixture(task))
}

fn plain_identity(key: &PrivateKey) -> AgentIdentity {
    AgentIdentity::PublicKey {
        key: key.public_key().clone(),
        comment: "fixture".into(),
    }
}

/// Issue a real disposable user certificate without machine keys, files or wall-clock assumptions.
fn certificate_identity(key: &PrivateKey) -> AgentIdentity {
    let ca = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519).unwrap();
    let mut builder = keys::ssh_key::certificate::Builder::new(
        vec![1; 32],
        key.public_key().key_data().clone(),
        0,
        u64::MAX,
    )
    .unwrap();
    builder
        .cert_type(keys::ssh_key::certificate::CertType::User)
        .unwrap();
    builder.valid_principal("fixture").unwrap();
    AgentIdentity::Certificate {
        certificate: builder.sign(&ca).unwrap(),
        comment: "fixture certificate".into(),
    }
}

#[tokio::test]
async fn selected_plain_and_certificate_identities_authenticate_over_encrypted_ssh() {
    tokio::time::timeout(TEST_DEADLINE, async {
        for certificate in [false, true] {
            let key = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519).unwrap();
            let decoy = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519).unwrap();
            let identity = if certificate {
                certificate_identity(&key)
            } else {
                plain_identity(&key)
            };
            let selector = identity_selector(&identity);
            let cert = match &identity {
                AgentIdentity::Certificate { certificate, .. } => Some(certificate.clone()),
                _ => None,
            };
            let (mut session, _server) = ssh_fixture(key.public_key(), cert).await;
            let (agent, mut fixture) = agent_fixture(
                vec![plain_identity(&decoy), identity],
                key,
                AgentBehavior::Sign,
            );
            let (agent, selected) = select_identity_with_client(
                agent,
                Some(&selector),
                session.agent_session_binding(),
                TEST_DEADLINE,
            )
            .await
            .unwrap();
            assert_eq!(identity_selector(&selected), selector);
            let result = authenticate_identity(&mut session, "fixture", agent, selected)
                .await
                .unwrap();
            assert!(result.success());
            assert_eq!(fixture.signatures.load(Ordering::SeqCst), 1);
            fixture.finish().await;
        }
    })
    .await
    .expect("agent SSH authentication is bounded");
}

#[tokio::test]
async fn signature_refusal_never_authenticates() {
    tokio::time::timeout(TEST_DEADLINE, async {
        let key = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519).unwrap();
        let (mut session, _server) = ssh_fixture(key.public_key(), None).await;
        let (agent, mut fixture) =
            agent_fixture(vec![plain_identity(&key)], key, AgentBehavior::Refuse);
        let (agent, identity) = select_identity_with_client(
            agent,
            None,
            session.agent_session_binding(),
            TEST_DEADLINE,
        )
        .await
        .unwrap();
        assert!(
            authenticate_identity(&mut session, "fixture", agent, identity)
                .await
                .is_err()
        );
        assert_eq!(fixture.signatures.load(Ordering::SeqCst), 1);
        fixture.finish().await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn missing_selected_key_and_empty_agent_do_not_fall_back() {
    for empty in [false, true] {
        let key = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519).unwrap();
        let absent = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519).unwrap();
        let identities = if empty {
            vec![]
        } else {
            vec![plain_identity(&key)]
        };
        let (agent, mut fixture) = agent_fixture(identities, key, AgentBehavior::Sign);
        let selector = identity_selector(&plain_identity(&absent));
        let error = select_identity_with_client(
            agent,
            if empty { None } else { Some(&selector) },
            None,
            TEST_DEADLINE,
        )
        .await
        .err()
        .expect("missing identity must fail");
        assert!(error
            .to_string()
            .contains(if empty { "no keys" } else { "selected key" }));
        assert_eq!(fixture.signatures.load(Ordering::SeqCst), 0);
        fixture.finish().await;
    }
}

#[tokio::test]
async fn first_key_order_is_preserved_and_duplicate_explicit_selectors_fail() {
    let first = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519).unwrap();
    let second = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519).unwrap();
    let selector = identity_selector(&plain_identity(&first));
    for duplicate in [false, true] {
        let identities = vec![
            plain_identity(&first),
            plain_identity(if duplicate { &first } else { &second }),
        ];
        let (agent, mut fixture) = agent_fixture(identities, first.clone(), AgentBehavior::Sign);
        let result = select_identity_with_client(
            agent,
            if duplicate { Some(&selector) } else { None },
            None,
            TEST_DEADLINE,
        )
        .await;
        if duplicate {
            assert!(result
                .err()
                .unwrap()
                .to_string()
                .contains("Multiple SSH agent keys"));
        } else {
            let (agent, selected) = result.unwrap();
            assert_eq!(identity_selector(&selected), selector);
            drop(agent);
        }
        assert_eq!(fixture.signatures.load(Ordering::SeqCst), 0);
        fixture.finish().await;
    }
}

#[tokio::test]
async fn stalled_metadata_times_out_and_unsupported_binding_remains_compatible() {
    tokio::time::timeout(TEST_DEADLINE, async {
        let key = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519).unwrap();
        let (session, _server) = ssh_fixture(key.public_key(), None).await;
        assert!(session.agent_session_binding().is_some());
        for behavior in [
            AgentBehavior::StallBinding,
            AgentBehavior::StallIdentities,
            AgentBehavior::UnsupportedBinding,
        ] {
            let (agent, mut fixture) =
                agent_fixture(vec![plain_identity(&key)], key.clone(), behavior);
            let result = select_identity_with_client(
                agent,
                None,
                session.agent_session_binding(),
                if behavior == AgentBehavior::UnsupportedBinding {
                    TEST_DEADLINE
                } else {
                    SHORT_DEADLINE
                },
            )
            .await;
            if behavior == AgentBehavior::UnsupportedBinding {
                assert!(result.is_ok());
                drop(result);
            } else {
                assert!(result.err().unwrap().to_string().contains("Timed out"));
            }
            fixture.finish().await;
        }
    })
    .await
    .unwrap();
}

/// A real ed25519 public key in OpenSSH wire format, base64-encoded.
const ED25519_BASE64: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIEutQa3U2JY/LeFkCo9yOuA7J5Q95r3zrtXr85oPplLX";

#[test]
fn canonicalizes_full_line_and_bare_base64() {
    let line = format!("ssh-ed25519 {ED25519_BASE64} user@example");
    let from_line = canonicalize_requested_key(&line).expect("full line parses");
    let from_bare = canonicalize_requested_key(ED25519_BASE64).expect("bare base64 parses");
    assert_eq!(from_line, from_bare);
    assert!(from_line.starts_with("ssh-ed25519 "));
    assert!(!from_line.contains("user@example"));
}

#[test]
fn canonicalizes_authorized_keys_options_without_reading_keys_from_quoted_commands() {
    let expected = canonicalize_requested_key(ED25519_BASE64).unwrap();
    for options in [
        "no-agent-forwarding",
        "restrict,no-pty",
        r#"from="192.0.2.0/24",command="echo hello world""#,
        r#"command="echo \"quoted text\"""#,
        r#"command="echo ssh-ed25519 not-the-key""#,
    ] {
        for separator in [" ", "\t"] {
            let line = format!("{options}{separator}ssh-ed25519 {ED25519_BASE64} fixture");
            assert_eq!(canonicalize_requested_key(&line).unwrap(), expected);
        }
    }
    assert!(canonicalize_requested_key(&format!(
        "command=\"unterminated ssh-ed25519 {ED25519_BASE64}"
    ))
    .is_err());
    assert!(canonicalize_requested_key(&format!("ssh-rsa {ED25519_BASE64}")).is_err());
}

#[test]
fn canonicalizes_authorized_keys_certificate_options_without_losing_certificate_identity() {
    let key = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519).unwrap();
    let selector = identity_selector(&certificate_identity(&key));
    let line = format!(r#"command="echo hello world",no-pty {selector} fixture"#);
    assert_eq!(canonicalize_requested_key(&line).unwrap(), selector);
    assert!(canonicalize_requested_key(&format!(
        "restrict ssh-ed25519-cert-v01@openssh.com {ED25519_BASE64}"
    ))
    .is_err());
}

#[test]
fn rejects_empty_and_garbage_selectors() {
    assert!(canonicalize_requested_key("").is_err());
    assert!(canonicalize_requested_key("   ").is_err());
    assert!(canonicalize_requested_key("not-a-key").is_err());
}

#[test]
fn routes_certificate_lines_to_the_certificate_parser() {
    // A cert-algorithm line must not fall through to plain-key parsing.
    let line = format!("ssh-ed25519-cert-v01@openssh.com {ED25519_BASE64} user@example");
    assert!(canonicalize_requested_key(&line).is_err());
}
