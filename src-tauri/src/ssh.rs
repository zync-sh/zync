use anyhow::{anyhow, Result};
use log::error;
use russh::keys::{self, HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKey, PublicKeyBase64};
use russh::*;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
#[cfg(all(test, target_os = "linux"))]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tauri::Emitter;

use crate::tunnels::TunnelManager;
use crate::types::{AgentForwardingConfig, AuthMethod, ConnectionConfig, HostKeyApproval};
use russh::client::Msg;
use tokio::net::TcpStream;

const MAX_FORWARDED_AGENT_PACKET_SIZE: usize = 256 * 1024;
const AGENT_CONFIRMATION_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_AUTH_BANNER_CHARS: usize = 16 * 1024;

/// Connect only to an owned loopback test server with an exact generated key, without touching durable trust.
#[cfg(test)]
pub(crate) async fn connect_runtime_fixture(port:u16,expected:PublicKey,username:&str,password:&str)->Result<client::Handle<Client>> {
    if port==0 || username.is_empty() {return Err(anyhow!("Invalid disposable SSH fixture endpoint"));}
    let (failure_tx,_failure_rx)=tokio::sync::mpsc::unbounded_channel::<String>();
    let handler=Client {
        tunnel_manager:Arc::new(TunnelManager::new(failure_tx)),connection_id:"security-qualification".into(),
        kept_alive_session:None,forwarded_agent:None,host:"127.0.0.1".into(),port,host_key_approval:None,
        auth_banner:Arc::new(Mutex::new(String::new())),presented_key:Arc::new(Mutex::new(None)),fixture_key:Some(expected),
    };
    let mut session=tokio::time::timeout(Duration::from_secs(10),client::connect(Arc::new(client::Config::default()),("127.0.0.1",port),handler)).await??;
    let authenticated=tokio::time::timeout(Duration::from_secs(10),session.authenticate_password(username,password)).await??;
    if !authenticated.success() {return Err(anyhow!("Disposable SSH fixture authentication failed"));}
    Ok(session)
}

/// Exercise the production SSH handler over an in-memory protocol transport.
#[cfg(test)]
pub(crate) async fn connect_runtime_stream_fixture(
    stream: tokio::io::DuplexStream,
    expected: PublicKey,
    username: &str,
    password: &str,
) -> Result<client::Handle<Client>> {
    let (failure_tx, _failure_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let handler = Client {
        tunnel_manager: Arc::new(TunnelManager::new(failure_tx)),
        connection_id: "command-qualification".into(),
        kept_alive_session: None,
        forwarded_agent: None,
        host: "memory.fixture.invalid".into(),
        port: 0,
        host_key_approval: None,
        auth_banner: Arc::new(Mutex::new(String::new())),
        presented_key: Arc::new(Mutex::new(None)),
        fixture_key: Some(expected),
    };
    let mut session = tokio::time::timeout(
        Duration::from_secs(10),
        client::connect_stream(Arc::new(client::Config::default()), stream, handler),
    )
    .await??;
    let authenticated = tokio::time::timeout(
        Duration::from_secs(10),
        session.authenticate_password(username, password),
    )
    .await??;
    if !authenticated.success() {
        return Err(anyhow!("In-memory SSH fixture authentication failed"));
    }
    Ok(session)
}

#[derive(Clone, Copy)]
enum AgentSignatureDecision {
    Deny,
    AllowOnce,
    AllowSession,
    Expired,
}

impl AgentSignatureDecision {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "deny" => Some(Self::Deny),
            "allowOnce" => Some(Self::AllowOnce),
            "allowSession" => Some(Self::AllowSession),
            _ => None,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentSignatureRequestEvent<'a> {
    request_id: &'a str,
    connection_id: &'a str,
    host: &'a str,
    requested_username: &'a str,
    key_fingerprint: &'a str,
}

#[derive(Clone)]
struct AgentConsentBroker {
    app: Option<tauri::AppHandle>,
    pending: Arc<
        tokio::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<AgentSignatureDecision>>>,
    >,
    prompt_gate: Arc<tokio::sync::Mutex<()>>,
    #[cfg(all(test, target_os = "linux"))]
    test_decisions:
        Option<Arc<tokio::sync::Mutex<std::collections::VecDeque<AgentSignatureDecision>>>>,
    #[cfg(all(test, target_os = "linux"))]
    test_prompt_count: Option<Arc<AtomicUsize>>,
}

impl AgentConsentBroker {
    fn new(app: tauri::AppHandle) -> Self {
        Self {
            app: Some(app),
            pending: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            prompt_gate: Arc::new(tokio::sync::Mutex::new(())),
            #[cfg(all(test, target_os = "linux"))]
            test_decisions: None,
            #[cfg(all(test, target_os = "linux"))]
            test_prompt_count: None,
        }
    }

    #[cfg(all(test, target_os = "linux"))]
    fn for_test(
        decisions: impl IntoIterator<Item = AgentSignatureDecision>,
    ) -> (Self, Arc<AtomicUsize>) {
        let prompt_count = Arc::new(AtomicUsize::new(0));
        (
            Self {
                app: None,
                pending: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
                prompt_gate: Arc::new(tokio::sync::Mutex::new(())),
                test_decisions: Some(Arc::new(tokio::sync::Mutex::new(
                    decisions.into_iter().collect(),
                ))),
                test_prompt_count: Some(prompt_count.clone()),
            },
            prompt_count,
        )
    }

    async fn confirm(
        &self,
        connection_id: &str,
        host: &str,
        requested_username: &str,
        key_fingerprint: &str,
        allow_session: &AtomicBool,
    ) -> AgentSignatureDecision {
        let _prompt_guard = self.prompt_gate.lock().await;
        if allow_session.load(Ordering::Acquire) {
            return AgentSignatureDecision::AllowSession;
        }
        #[cfg(all(test, target_os = "linux"))]
        if let Some(decisions) = &self.test_decisions {
            if let Some(prompt_count) = &self.test_prompt_count {
                prompt_count.fetch_add(1, Ordering::Relaxed);
            }
            return decisions
                .lock()
                .await
                .pop_front()
                .unwrap_or(AgentSignatureDecision::Deny);
        }
        let Some(app) = self.app.as_ref() else {
            return AgentSignatureDecision::Expired;
        };
        let request_id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        self.pending.lock().await.insert(request_id.clone(), sender);

        if app
            .emit_to(
                "main",
                "ssh:agent-signature-request",
                AgentSignatureRequestEvent {
                    request_id: &request_id,
                    connection_id,
                    host,
                    requested_username,
                    key_fingerprint,
                },
            )
            .is_err()
        {
            self.pending.lock().await.remove(&request_id);
            return AgentSignatureDecision::Expired;
        }

        let decision = tokio::time::timeout(AGENT_CONFIRMATION_TIMEOUT, receiver)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or(AgentSignatureDecision::Expired);
        self.pending.lock().await.remove(&request_id);
        if matches!(decision, AgentSignatureDecision::Expired) {
            let _ = app.emit_to("main", "ssh:agent-signature-expired", request_id);
        }
        decision
    }

    async fn respond(&self, request_id: &str, decision: AgentSignatureDecision) {
        if let Some(sender) = self.pending.lock().await.remove(request_id) {
            let _ = sender.send(decision);
        }
    }
}

struct ForwardedAgent {
    key: Arc<PrivateKey>,
    broker: AgentConsentBroker,
    connection_id: String,
    host: String,
    fingerprint: String,
    allow_session: AtomicBool,
}

#[derive(Clone)]
pub struct Client {
    pub tunnel_manager: Arc<TunnelManager>,
    /// Zync connection id for scoping remote forward map lookups.
    pub connection_id: String,
    pub kept_alive_session: Option<Arc<Box<client::Handle<Client>>>>,
    forwarded_agent: Option<Arc<ForwardedAgent>>,
    pub host: String,
    pub port: u16,
    pub host_key_approval: Option<HostKeyApproval>,
    auth_banner: Arc<Mutex<String>>,
    presented_key: Arc<Mutex<Option<String>>>,
    #[cfg(test)]
    fixture_key:Option<PublicKey>,
}

impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Client")
            .field("tunnel_manager", &"TunnelManager")
            .field("connection_id", &self.connection_id)
            .field("kept_alive_session", &self.kept_alive_session.is_some())
            .field("agent_forwarding", &self.forwarded_agent.is_some())
            .field("host", &self.host)
            .field("port", &self.port)
            .finish()
    }
}

impl client::Handler for Client {
    type Error = anyhow::Error;

    /// Capture a bounded, sanitized authentication banner for the connection UI.
    async fn auth_banner(
        &mut self,
        banner: &str,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let mut captured = self
            .auth_banner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let remaining = MAX_AUTH_BANNER_CHARS.saturating_sub(captured.chars().count());
        captured.extend(
            banner
                .chars()
                .filter(|ch| matches!(ch, '\r' | '\n' | '\t') || !ch.is_control())
                .take(remaining),
        );
        Ok(())
    }

    /// Require the same explicit known-host approval after transport upgrades.
    async fn check_server_key(
        &mut self,
        server_public_key: &keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let keys::PublicKeyOrCertificate::PublicKey { key, .. } = server_public_key else {
            return Err(anyhow!(
                "SSH host certificates are not configured for this connection"
            ));
        };
        #[cfg(test)]
        if let Some(expected)=self.fixture_key.as_ref() {
            if key.key_data()!=expected.key_data() {return Err(anyhow!("Disposable SSH fixture key mismatch"));}
            *self.presented_key.lock().unwrap_or_else(|poisoned|poisoned.into_inner())=Some(key.fingerprint(HashAlg::Sha256).to_string());
            return Ok(true);
        }
        let accepted=verify_server_key(
            &self.connection_id,
            &self.host,
            self.port,
            key,
            self.host_key_approval.as_ref(),
        )?;
        if accepted {
            *self.presented_key.lock().unwrap_or_else(|poisoned|poisoned.into_inner())=Some(key.fingerprint(HashAlg::Sha256).to_string());
        }
        Ok(accepted)
    }

    /// Accept forwarded-agent channels only for the explicitly selected key.
    async fn server_channel_open_agent_forward(
        &mut self,
        channel: Channel<Msg>,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let Some(agent) = self.forwarded_agent.clone() else {
            reply
                .reject(ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        };
        reply.accept().await;
        let mut stream = channel.into_stream();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};

            loop {
                let mut length = [0; 4];
                if stream.read_exact(&mut length).await.is_err() {
                    break;
                }
                let length = u32::from_be_bytes(length) as usize;
                if length == 0 || length > MAX_FORWARDED_AGENT_PACKET_SIZE {
                    break;
                }
                let mut payload = vec![0; length];
                if stream.read_exact(&mut payload).await.is_err() {
                    break;
                }
                let Some(response) = handle_agent_request(&agent, &payload).await else {
                    break;
                };
                if stream
                    .write_all(&(response.len() as u32).to_be_bytes())
                    .await
                    .is_err()
                    || stream.write_all(&response).await.is_err()
                {
                    break;
                }
            }
        });
        Ok(())
    }

    /// Accept only registered remote forwards and relay outside the SSH actor.
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        // ... (existing implementation) ...
        println!(
            "[TUNNEL] Incoming forwarded connection on {}:{}",
            connected_address, connected_port
        );

        let map_key =
            crate::tunnels::remote_forward_map_key(&self.connection_id, connected_port as u16);
        let target = {
            let map = self.tunnel_manager.remote_forwards.lock().await;
            map.get(&map_key).cloned()
        };

        if let Some((target_host, target_port, _bind_addr)) = target {
            reply.accept().await;
            println!("[TUNNEL] Forwarding to {}:{}", target_host, target_port);

            let target_addr = format!("{}:{}", target_host, target_port);

            tokio::spawn(async move {
                match TcpStream::connect(&target_addr).await {
                    Ok(mut local_stream) => {
                        let mut channel_stream = channel.into_stream();
                        if let Err(e) =
                            tokio::io::copy_bidirectional(&mut channel_stream, &mut local_stream)
                                .await
                        {
                            error!(
                                "[TUNNEL] copy_bidirectional error between channel_stream and local_stream: {:?}",
                                e
                            );
                        }
                    }
                    Err(e) => eprintln!(
                        "[TUNNEL] Failed to connect to local target {}: {}",
                        target_addr, e
                    ),
                }
            });

            Ok(())
        } else {
            reply
                .reject(ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            eprintln!("[TUNNEL] No tunnel found for port {}", connected_port);
            Ok(())
        }
    }
}

fn read_u32(cursor: &mut &[u8]) -> Option<u32> {
    let (value, rest) = cursor.split_at_checked(4)?;
    *cursor = rest;
    Some(u32::from_be_bytes(value.try_into().ok()?))
}

fn read_string<'a>(cursor: &mut &'a [u8]) -> Option<&'a [u8]> {
    let length = read_u32(cursor)? as usize;
    let (value, rest) = cursor.split_at_checked(length)?;
    *cursor = rest;
    Some(value)
}

fn write_string(buffer: &mut Vec<u8>, value: &[u8]) {
    buffer.extend_from_slice(&(value.len() as u32).to_be_bytes());
    buffer.extend_from_slice(value);
}

fn parse_userauth_signature_request(
    data: &[u8],
    expected_key: &[u8],
    expected_algorithm: &[u8],
) -> Option<String> {
    let mut cursor = data;
    let _session_id = read_string(&mut cursor)?;
    if cursor.first().copied()? != 50 {
        return None;
    }
    cursor = &cursor[1..];
    let username = std::str::from_utf8(read_string(&mut cursor)?).ok()?;
    if read_string(&mut cursor)? != b"ssh-connection" {
        return None;
    }
    let method = read_string(&mut cursor)?;
    if cursor.first().copied()? != 1 {
        return None;
    }
    cursor = &cursor[1..];
    if read_string(&mut cursor)? != expected_algorithm {
        return None;
    }
    if read_string(&mut cursor)? != expected_key {
        return None;
    }
    match method {
        b"publickey" if cursor.is_empty() => {}
        b"publickey-hostbound-v00@openssh.com" => {
            let _server_host_key = read_string(&mut cursor)?;
            if !cursor.is_empty() {
                return None;
            }
        }
        _ => return None,
    }
    Some(username.to_string())
}

/// Restrict agent signature requests to the existing SHA-2 RSA policy.
fn key_for_signature_flags(key: &Arc<PrivateKey>, flags: u32) -> Option<PrivateKeyWithHashAlg> {
    let hash = match key.algorithm() {
        keys::Algorithm::Rsa { .. } => match flags {
            0 | 2 => Some(HashAlg::Sha256),
            4 => Some(HashAlg::Sha512),
            _ => return None,
        },
        _ if flags == 0 => None,
        _ => return None,
    };
    Some(PrivateKeyWithHashAlg::new(key.clone(), hash))
}

/// Encode the upstream signature representation inside an agent SIGN_RESPONSE.
fn serialize_signature(signature: keys::ssh_key::Signature) -> Result<Vec<u8>> {
    use keys::ssh_encoding::Encode;
    let mut signature_blob = Vec::new();
    signature.encode(&mut signature_blob)?;
    let mut response = vec![14];
    write_string(&mut response, &signature_blob);
    Ok(response)
}

/// Sign only the selected algorithm; RSA must retain its requested SHA-2 hash.
fn sign_agent_request(key: &PrivateKeyWithHashAlg, data: &[u8]) -> Result<Vec<u8>> {
    serialize_signature(sign_key_data(key, data)?)
}

/// Share private-key signature encoding between forwarded-agent and local certificate auth.
fn sign_key_data(key: &PrivateKeyWithHashAlg, data: &[u8]) -> Result<keys::ssh_key::Signature> {
    use keys::signature::Signer;
    let signature = match key.key_data() {
        keys::ssh_key::private::KeypairData::Rsa(keypair) => {
            (keypair, key.hash_alg()).try_sign(data)?
        }
        keypair => keypair.try_sign(data)?,
    };
    Ok(signature)
}

/// Connection-local signer using an already unlocked key; never opens a system SSH agent.
struct CertificateSigner(PrivateKeyWithHashAlg);

impl russh::Signer for CertificateSigner {
    type Error = anyhow::Error;

    /// Append the SSH signature to upstream's exact auth payload, preserving RSA SHA-2.
    async fn auth_sign(
        &mut self,
        _: &keys::agent::AgentIdentity,
        hash: Option<HashAlg>,
        mut data: Vec<u8>,
    ) -> Result<Vec<u8>> {
        use keys::ssh_encoding::Encode;
        if hash != self.0.hash_alg() {
            return Err(anyhow!(
                "Certificate signing algorithm changed unexpectedly"
            ));
        }
        let signature = sign_key_data(&self.0, &data)?;
        let mut encoded = Vec::new();
        signature.encode(&mut encoded)?;
        write_string(&mut data, &encoded);
        Ok(data)
    }
}

/// Enforce key, user-auth payload, algorithm and consent checks before signing.
async fn handle_agent_request(agent: &ForwardedAgent, payload: &[u8]) -> Option<Vec<u8>> {
    let Some((&message_type, mut cursor)) = payload.split_first() else {
        return Some(vec![5]);
    };
    let public_key = agent.key.public_key_bytes();
    match message_type {
        11 => {
            let mut response = vec![12];
            response.extend_from_slice(&1u32.to_be_bytes());
            write_string(&mut response, &public_key);
            write_string(&mut response, b"zync-forwarded-key");
            Some(response)
        }
        13 => {
            let Some(requested_key) = read_string(&mut cursor) else {
                return Some(vec![5]);
            };
            let Some(data) = read_string(&mut cursor) else {
                return Some(vec![5]);
            };
            let Some(flags) = read_u32(&mut cursor) else {
                return Some(vec![5]);
            };
            if !cursor.is_empty() || requested_key != public_key {
                return Some(vec![5]);
            }
            let Some(signing_key) = key_for_signature_flags(&agent.key, flags) else {
                return Some(vec![5]);
            };
            let Some(username) = parse_userauth_signature_request(
                data,
                &public_key,
                signing_key.algorithm().as_str().as_bytes(),
            ) else {
                return Some(vec![5]);
            };
            if !agent.allow_session.load(Ordering::Acquire) {
                match agent
                    .broker
                    .confirm(
                        &agent.connection_id,
                        &agent.host,
                        &username,
                        &agent.fingerprint,
                        &agent.allow_session,
                    )
                    .await
                {
                    AgentSignatureDecision::Deny => return Some(vec![5]),
                    AgentSignatureDecision::AllowOnce => {}
                    AgentSignatureDecision::AllowSession => {
                        agent.allow_session.store(true, Ordering::Release)
                    }
                    AgentSignatureDecision::Expired => return None,
                }
            }
            Some(sign_agent_request(&signing_key, data).unwrap_or_else(|_| vec![5]))
        }
        _ => Some(vec![5]),
    }
}

const HOST_KEY_CHALLENGE_PREFIX: &str = "ZYNC_HOST_KEY:";
static KNOWN_HOSTS_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostKeyChallenge<'a> {
    kind: &'a str,
    connection_id: &'a str,
    host: &'a str,
    port: u16,
    algorithm: &'a str,
    fingerprint: String,
}

fn known_hosts_path() -> Result<PathBuf> {
    dirs::home_dir()
        .map(|home| home.join(".ssh").join("known_hosts"))
        .ok_or_else(|| anyhow!("No home directory found for SSH known_hosts"))
}

/// Verify the presented host key against the user's durable known-host store.
fn verify_server_key(
    connection_id: &str,
    host: &str,
    port: u16,
    server_public_key: &PublicKey,
    approval: Option<&HostKeyApproval>,
) -> Result<bool> {
    let path = known_hosts_path()?;
    let _guard = KNOWN_HOSTS_LOCK
        .lock()
        .map_err(|_| anyhow!("SSH known_hosts lock was poisoned"))?;
    verify_server_key_at_path(
        connection_id,
        host,
        port,
        server_public_key,
        approval,
        &path,
    )
}

/// Match SHA-256 approval fingerprints without changing their persisted format.
fn verify_server_key_at_path(
    connection_id: &str,
    host: &str,
    port: u16,
    server_public_key: &PublicKey,
    approval: Option<&HostKeyApproval>,
    path: &Path,
) -> Result<bool> {
    let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();
    let changed_lines =
        match keys::known_hosts::check_known_hosts_path(host, port, server_public_key, &path) {
            Ok(true) => return Ok(true),
            Ok(false) => None,
            Err(keys::Error::KeyChanged { .. }) => Some(
                keys::known_hosts::known_host_keys_path(host, port, &path)?
                    .into_iter()
                    .collect::<HashMap<_, _>>(),
            ),
            Err(error) => return Err(error.into()),
        };

    let is_changed = changed_lines.is_some();
    if approval.is_some_and(|value| value.fingerprint == fingerprint && value.replace == is_changed)
    {
        if let Some(keys) = changed_lines {
            replace_known_host_keys(&path, &keys, host, port, server_public_key)?;
        } else {
            keys::known_hosts::learn_known_hosts_path(host, port, server_public_key, &path)?;
        }
        return Ok(true);
    }

    let algorithm = server_public_key.algorithm();
    let challenge = HostKeyChallenge {
        kind: if is_changed { "changed" } else { "unknown" },
        connection_id,
        host,
        port,
        algorithm: algorithm.as_str(),
        fingerprint,
    };
    Err(anyhow!(
        "{}{}",
        HOST_KEY_CHALLENGE_PREFIX,
        serde_json::to_string(&challenge)?
    ))
}

/// Replace approved stale host-key lines while retaining unrelated records.
fn replace_known_host_keys(
    path: &Path,
    keys: &HashMap<usize, PublicKey>,
    host: &str,
    port: u16,
    server_public_key: &PublicKey,
) -> Result<()> {
    let content = std::fs::read_to_string(path)?;
    let permissions = std::fs::metadata(path)?.permissions();
    let mut logical_line = 1;
    let mut kept = content
        .lines()
        .filter_map(|line| {
            if line.as_bytes().first() == Some(&b'#') {
                return Some(line);
            }
            let remove = keys.get(&logical_line).is_some_and(|expected| {
                let encoded_key = line.split(' ').nth(2);
                encoded_key
                    .and_then(|key| keys::parse_public_key_base64(key).ok())
                    .is_some_and(|key| key == *expected)
            });
            logical_line += 1;
            (!remove).then_some(line)
        })
        .collect::<Vec<_>>()
        .join("\n");
    if !kept.is_empty() {
        kept.push('\n');
    }
    kept.push_str(&if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    });
    kept.push(' ');
    kept.push_str(server_public_key.algorithm().as_str());
    kept.push(' ');
    kept.push_str(&server_public_key.public_key_base64());
    kept.push('\n');
    crate::atomic_io::durable_replace(path, kept.as_bytes())?;
    std::fs::set_permissions(path, permissions)?;
    Ok(())
}

pub struct SshManager {
    consent_broker: Option<AgentConsentBroker>,
}

impl SshManager {
    #[cfg(all(test, target_os = "linux"))]
    pub fn new() -> Self {
        Self {
            consent_broker: None,
        }
    }

    #[cfg(all(test, target_os = "linux"))]
    fn with_test_consent(
        decisions: impl IntoIterator<Item = AgentSignatureDecision>,
    ) -> (Self, Arc<AtomicUsize>) {
        let (broker, prompt_count) = AgentConsentBroker::for_test(decisions);
        (
            Self {
                consent_broker: Some(broker),
            },
            prompt_count,
        )
    }

    pub fn with_app(app: tauri::AppHandle) -> Self {
        Self {
            consent_broker: Some(AgentConsentBroker::new(app)),
        }
    }

    pub async fn respond_agent_signature(&self, request_id: &str, decision: &str) -> Result<()> {
        let decision = AgentSignatureDecision::parse(decision)
            .ok_or_else(|| anyhow!("Invalid SSH agent signature decision"))?;
        let broker = self
            .consent_broker
            .as_ref()
            .ok_or_else(|| anyhow!("SSH agent confirmation is unavailable"))?;
        broker.respond(request_id, decision).await;
        Ok(())
    }

    pub async fn connect(
        &self,
        config: ConnectionConfig,
        tunnel_manager: Arc<crate::tunnels::TunnelManager>,
    ) -> Result<client::Handle<Client>> {
        self.connect_with_banner(config, tunnel_manager)
            .await
            .map(|(session, _)| session)
    }

    /// Establish the configured hop chain with explicit egress, host trust and authentication.
    pub async fn connect_with_banner(
        &self,
        config: ConnectionConfig,
        tunnel_manager: Arc<crate::tunnels::TunnelManager>,
    ) -> Result<(client::Handle<Client>, Option<String>)> {
        self.connect_with_identity(config,tunnel_manager).await.map(|(session,banner,_)|(session,banner))
    }

    /// Capture the key accepted for this exact transport, separately from persisted host approvals.
    pub async fn connect_with_identity(
        &self,
        config: ConnectionConfig,
        tunnel_manager: Arc<crate::tunnels::TunnelManager>,
    )->Result<(client::Handle<Client>,Option<String>,String)> {
        // Keep-alive: send a heartbeat every 60s to prevent NAT/firewall timeouts on idle sessions
        let client_config = client::Config {
            keepalive_interval: Some(std::time::Duration::from_secs(60)),
            keepalive_max: 3,
            ..Default::default()
        };
        let client_config = Arc::new(client_config);
        let forwarded_agent = self.load_forwarded_agent(&config).await?;
        let auth_banner = Arc::new(Mutex::new(String::new()));
        let presented_key=Arc::new(Mutex::new(None));

        // Recursive Jump Host Logic
        if let Some(ref jump_host_config) = config.jump_host {
            if config.network_interface_id.is_some() {
                return Err(anyhow!(
                    "Select the network interface on the first jump host, not the remote target"
                ));
            }
            // 1. Connect to Jump Host (Recursive)
            let jump_session =
                Box::pin(self.connect((**jump_host_config).clone(), tunnel_manager.clone()))
                    .await
                    .map_err(|e| anyhow!("Failed to connect to jump host: {}", e))?;

            // 2. Open Direct TCP/IP Channel through Jump Host
            let channel = jump_session
                .channel_open_direct_tcpip(
                    config.host.clone(),
                    config.port as u32,
                    "0.0.0.0", // Originator IP (dummy)
                    0,         // Originator port (dummy)
                )
                .await
                .map_err(|e| anyhow!("Failed to open direct-tcpip channel on jump host: {}", e))?;

            // 3. Establish SSH Session over the Channel
            let stream = channel.into_stream();

            // 4. Create handler with agent keys
            let client_handler = Client {
                tunnel_manager: tunnel_manager.clone(),
                connection_id: config.id.clone(),
                kept_alive_session: Some(Arc::new(Box::new(jump_session))),
                forwarded_agent,
                host: config.host.clone(),
                port: config.port,
                host_key_approval: config.host_key_approval.clone(),
                auth_banner: auth_banner.clone(),
                presented_key:presented_key.clone(),
                #[cfg(test)]
                fixture_key:None,
            };

            // russh::client::connect_stream takes stream and handler
            let mut session =
                russh::client::connect_stream(client_config, stream, client_handler).await?;

            // 5. Authenticate (Target)
            self.authenticate_session(&mut session, &config).await?;
            let banner = auth_banner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            let key=presented_key.lock().unwrap_or_else(|poisoned|poisoned.into_inner()).clone().ok_or_else(||anyhow!("The authenticated SSH server key was not recorded"))?;
            return Ok((session, (!banner.is_empty()).then_some(banner),key));
        }

        // Direct Connection Logic
        let client_handler = Client {
            tunnel_manager: tunnel_manager.clone(),
            connection_id: config.id.clone(),
            kept_alive_session: None,
            forwarded_agent,
            host: config.host.clone(),
            port: config.port,
            host_key_approval: config.host_key_approval.clone(),
            auth_banner: auth_banner.clone(),
            presented_key:presented_key.clone(),
            #[cfg(test)]
            fixture_key:None,
        };

        let stream = crate::network_interfaces::connect(
            &config.host,
            config.port,
            config.network_interface_id.as_deref(),
        )
        .await?;
        // Preserve russh's normal low-latency TCP policy when supplying our own stream.
        if client_config.nodelay {
            stream.set_nodelay(true)?;
        }
        let mut session = client::connect_stream(client_config, stream, client_handler).await?;

        self.authenticate_session(&mut session, &config).await?;
        let banner = auth_banner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let key=presented_key.lock().unwrap_or_else(|poisoned|poisoned.into_inner()).clone().ok_or_else(||anyhow!("The authenticated SSH server key was not recorded"))?;
        Ok((session, (!banner.is_empty()).then_some(banner),key))
    }

    /// Authenticate only the configured credential and require complete success.
    async fn authenticate_session(
        &self,
        session: &mut client::Handle<Client>,
        config: &ConnectionConfig,
    ) -> Result<()> {
        if config.certificate_path.is_some()
            && matches!(config.auth_method, AuthMethod::Password { .. })
        {
            return Err(anyhow!(
                "SSH user certificates require private-key authentication"
            ));
        }
        let auth_res = match &config.auth_method {
            AuthMethod::Password { password } => {
                if password.trim().is_empty() {
                    return Err(anyhow!(
                        "No SSH authentication configured for {}@{}. Add a password, private key, or vault credential before connecting.",
                        config.username,
                        config.host
                    ));
                }

                session
                    .authenticate_password(&config.username, password.clone())
                    .await?
                    .success()
            }
            AuthMethod::PrivateKey {
                key_path,
                passphrase,
            } => {
                let mut expanded = key_path.clone();
                if expanded.starts_with("~") {
                    if let Some(home) = dirs::home_dir() {
                        expanded = expanded.replacen("~", &home.to_string_lossy(), 1);
                    }
                }
                let key_data = tokio::fs::read_to_string(&expanded)
                    .await
                    .map_err(|e| anyhow!("Failed to read private key file: {}", e))?;
                Self::auth_with_key_data(
                    session,
                    &config.username,
                    &key_data,
                    passphrase.as_deref(),
                    config.certificate_path.as_deref(),
                    None,
                )
                .await?
            }
            AuthMethod::PrivateKeyData {
                key_data,
                passphrase,
                certificate,
            } => {
                Self::auth_with_key_data(
                    session,
                    &config.username,
                    key_data,
                    passphrase.as_deref(),
                    config.certificate_path.as_deref(),
                    certificate.as_deref(),
                )
                .await?
            }
            AuthMethod::VaultRef { item_id, .. } => {
                return Err(anyhow!(
                    "VaultRef({}) was not resolved before authentication — call resolve_vault_refs first",
                    item_id
                ));
            }
        };

        if !auth_res {
            return Err(anyhow!("Authentication failed"));
        }
        Ok(())
    }

    /// Load a single connection-scoped forwarding identity without persisting it.
    async fn load_forwarded_agent(
        &self,
        config: &ConnectionConfig,
    ) -> Result<Option<Arc<ForwardedAgent>>> {
        let Some(AgentForwardingConfig { auth_method, .. }) = &config.agent_forwarding else {
            return Ok(None);
        };
        let broker = self
            .consent_broker
            .clone()
            .ok_or_else(|| anyhow!("SSH agent confirmation is unavailable"))?;
        let key = Arc::new(Self::load_private_key(auth_method).await?);
        let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        Ok(Some(Arc::new(ForwardedAgent {
            key,
            broker,
            connection_id: config.id.clone(),
            host: config.host.clone(),
            fingerprint,
            allow_session: AtomicBool::new(false),
        })))
    }

    /// Decode a resolved file or in-memory key, keeping passphrases backend-only.
    async fn load_private_key(auth_method: &AuthMethod) -> Result<PrivateKey> {
        let (key_data, passphrase) = match auth_method {
            AuthMethod::PrivateKey {
                key_path,
                passphrase,
            } => {
                let mut expanded = key_path.clone();
                if expanded.starts_with('~') {
                    if let Some(home) = dirs::home_dir() {
                        expanded = expanded.replacen('~', &home.to_string_lossy(), 1);
                    }
                }
                (
                    tokio::fs::read_to_string(&expanded)
                        .await
                        .map_err(|error| {
                            anyhow!("Failed to read forwarded private key: {error}")
                        })?,
                    passphrase.as_deref(),
                )
            }
            AuthMethod::PrivateKeyData {
                key_data,
                passphrase,
                ..
            } => (key_data.clone(), passphrase.as_deref()),
            AuthMethod::Password { .. } => {
                return Err(anyhow!("Agent forwarding requires a private key"))
            }
            AuthMethod::VaultRef { item_id, .. } => {
                return Err(anyhow!(
                    "Forwarded VaultRef({item_id}) was not resolved before connection"
                ))
            }
        };
        keys::decode_secret_key(&key_data, passphrase)
            .map_err(|error| anyhow!("Failed to decode forwarded private key: {error}"))
    }

    /// Authenticate a configured key/certificate while preserving the shared RSA SHA-2 policy.
    async fn auth_with_key_data<H: client::Handler>(
        session: &mut client::Handle<H>,
        username: &str,
        key_data: &str,
        passphrase: Option<&str>,
        certificate_path: Option<&str>,
        certificate_data: Option<&str>,
    ) -> Result<bool> {
        let privkey = keys::decode_secret_key(key_data, passphrase)
            .map_err(|e| anyhow!("Failed to decode private key: {}", e))?;
        let hash = if privkey.algorithm().is_rsa() {
            Some(rsa_auth_hash(session.best_supported_rsa_hash().await?)?)
        } else {
            None
        };
        let privkey = Arc::new(privkey);
        // A per-host file explicitly overrides the vault attachment (including on read failure).
        let certificate = if let Some(path) = certificate_path {
            Some(crate::ssh_certificate::load(path, &privkey).await?)
        } else {
            certificate_data
                .map(|text| crate::ssh_certificate::from_text(text, &privkey))
                .transpose()?
        };
        if let Some(cert) = certificate {
            let mut signer = CertificateSigner(PrivateKeyWithHashAlg::new(privkey, hash));
            return Ok(session
                .authenticate_certificate_with(username, cert, hash, &mut signer)
                .await?
                .success());
        }
        Ok(session
            .authenticate_publickey(username, PrivateKeyWithHashAlg::new(privkey, hash))
            .await?
            .success())
    }
}

/// Preserve SHA-2 for old servers lacking EXT_INFO and reject explicit SHA-1-only offers.
fn rsa_auth_hash(supported: Option<Option<HashAlg>>) -> Result<HashAlg> {
    match supported {
        Some(Some(hash @ (HashAlg::Sha256 | HashAlg::Sha512))) => Ok(hash),
        None => Ok(HashAlg::Sha512),
        _ => Err(anyhow!(
            "SSH server does not support RSA SHA-2 authentication"
        )),
    }
}

#[cfg(test)]
#[path = "ssh/transport_tests.rs"]
mod transport_tests;

#[cfg(test)]
mod tests {
    use super::{
        parse_userauth_signature_request, verify_server_key_at_path, write_string,
        HOST_KEY_CHALLENGE_PREFIX,
    };
    use crate::types::HostKeyApproval;
    #[cfg(target_os = "linux")]
    use russh::keys::PublicKey;
    use russh::keys::{self, HashAlg, PrivateKey};
    use std::time::{SystemTime, UNIX_EPOCH};
    #[cfg(target_os = "linux")]
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    #[cfg(target_os = "linux")]
    use tokio::sync::oneshot;
    #[cfg(target_os = "linux")]
    use {
        super::{AgentSignatureDecision, SshManager},
        crate::types::{AgentForwardingConfig, AuthMethod, ConnectionConfig},
        crate::TunnelManager,
        russh::{server, Channel},
        std::{net::SocketAddr, sync::Arc},
    };

    #[test]
    fn rsa_authentication_keeps_sha2_and_rejects_explicit_legacy_only_servers() {
        assert_eq!(super::rsa_auth_hash(None).unwrap(), HashAlg::Sha512);
        for hash in [HashAlg::Sha256, HashAlg::Sha512] {
            assert_eq!(super::rsa_auth_hash(Some(Some(hash))).unwrap(), hash);
        }
        assert!(super::rsa_auth_hash(Some(None)).is_err());
    }

    #[test]
    fn forwarded_signatures_preserve_algorithms_and_encode_valid_agent_responses() {
        use keys::{signature::Verifier, ssh_encoding::Decode};
        for algorithm in [
            keys::Algorithm::Ed25519,
            keys::Algorithm::Ecdsa {
                curve: keys::EcdsaCurve::NistP256,
            },
            keys::Algorithm::Rsa { hash: None },
        ] {
            let key = std::sync::Arc::new(
                PrivateKey::random(&mut keys::key::safe_rng(), algorithm.clone())
                    .expect("generate signing fixture"),
            );
            let is_rsa = algorithm.is_rsa();
            let flags: &[u32] = if is_rsa { &[0, 2, 4] } else { &[0] };
            for &flag in flags {
                let signing = super::key_for_signature_flags(&key, flag).unwrap();
                let response = super::sign_agent_request(&signing, b"fixture payload").unwrap();
                assert_eq!(response[0], 14);
                let mut cursor = &response[1..];
                let mut encoded = super::read_string(&mut cursor).unwrap();
                assert!(cursor.is_empty());
                let signature = keys::ssh_key::Signature::decode(&mut encoded).unwrap();
                assert!(encoded.is_empty());
                assert_eq!(signature.algorithm(), signing.algorithm());
                Verifier::verify(key.public_key(), b"fixture payload", &signature).unwrap();
                assert!(
                    Verifier::verify(key.public_key(), b"different payload", &signature).is_err()
                );
            }
            for flag in [1, 3, 5, u32::MAX] {
                assert!(super::key_for_signature_flags(&key, flag).is_none());
            }
            if !is_rsa {
                assert!(super::key_for_signature_flags(&key, 2).is_none());
                assert!(super::key_for_signature_flags(&key, 4).is_none());
            }
        }
    }

    #[test]
    fn agent_signing_accepts_only_complete_ssh_userauth_payloads_for_the_selected_key() {
        let selected_key = b"selected-public-key-blob";
        let mut payload = Vec::new();
        write_string(&mut payload, b"session-id");
        payload.push(50);
        write_string(&mut payload, b"deploy");
        write_string(&mut payload, b"ssh-connection");
        write_string(&mut payload, b"publickey");
        payload.push(1);
        write_string(&mut payload, b"ssh-ed25519");
        write_string(&mut payload, selected_key);

        assert_eq!(
            parse_userauth_signature_request(&payload, selected_key, b"ssh-ed25519").as_deref(),
            Some("deploy")
        );
        assert!(parse_userauth_signature_request(
            b"arbitrary challenge",
            selected_key,
            b"ssh-ed25519"
        )
        .is_none());
        assert!(
            parse_userauth_signature_request(&payload, b"another-key", b"ssh-ed25519").is_none()
        );
        assert!(
            parse_userauth_signature_request(&payload, selected_key, b"rsa-sha2-256").is_none()
        );

        payload.push(0);
        assert!(parse_userauth_signature_request(&payload, selected_key, b"ssh-ed25519").is_none());
    }

    #[cfg(target_os = "linux")]
    struct AgentProbeServer {
        result: Option<oneshot::Sender<Option<u32>>>,
    }

    #[cfg(target_os = "linux")]
    struct ConsentProbeServer {
        result: Option<oneshot::Sender<Option<(u32, bool, bool, bool)>>>,
    }

    #[cfg(target_os = "linux")]
    impl server::Handler for AgentProbeServer {
        type Error = anyhow::Error;

        async fn auth_password(
            &mut self,
            _user: &str,
            _password: &str,
        ) -> Result<server::Auth, Self::Error> {
            Ok(server::Auth::Accept)
        }

        async fn auth_publickey(
            &mut self,
            _user: &str,
            _public_key: &PublicKey,
        ) -> Result<server::Auth, Self::Error> {
            Ok(server::Auth::Accept)
        }

        async fn channel_open_session(
            &mut self,
            _channel: Channel<server::Msg>,
            reply: server::ChannelOpenHandle,
            session: &mut server::Session,
        ) -> Result<(), Self::Error> {
            reply.accept().await;
            if let Some(result) = self.result.take() {
                let handle = session.handle();
                tokio::spawn(async move {
                    let count = async {
                        let channel = handle.channel_open_agent().await.ok()?;
                        let mut stream = channel.into_stream();
                        stream.write_all(&[0, 0, 0, 1, 11]).await.ok()?;
                        let mut length = [0; 4];
                        stream.read_exact(&mut length).await.ok()?;
                        let mut response = vec![0; u32::from_be_bytes(length) as usize];
                        stream.read_exact(&mut response).await.ok()?;
                        (response.len() >= 5 && response[0] == 12)
                            .then(|| u32::from_be_bytes(response[1..5].try_into().unwrap()))
                    }
                    .await;
                    let _ = result.send(count);
                });
            }
            Ok(())
        }
    }

    #[cfg(target_os = "linux")]
    impl server::Handler for ConsentProbeServer {
        type Error = anyhow::Error;

        async fn auth_password(
            &mut self,
            _user: &str,
            _password: &str,
        ) -> Result<server::Auth, Self::Error> {
            Ok(server::Auth::Accept)
        }

        async fn channel_open_session(
            &mut self,
            _channel: Channel<server::Msg>,
            reply: server::ChannelOpenHandle,
            session: &mut server::Session,
        ) -> Result<(), Self::Error> {
            reply.accept().await;
            if let Some(result) = self.result.take() {
                let handle = session.handle();
                tokio::spawn(async move {
                    let probe = async {
                        let channel = handle.channel_open_agent().await.ok()?;
                        let mut stream = channel.into_stream();
                        stream.write_all(&[0, 0, 0, 1, 11]).await.ok()?;
                        let mut length = [0; 4];
                        stream.read_exact(&mut length).await.ok()?;
                        let mut identities = vec![0; u32::from_be_bytes(length) as usize];
                        stream.read_exact(&mut identities).await.ok()?;
                        if identities.first().copied()? != 12 {
                            return None;
                        }
                        let mut identity_cursor = &identities[1..];
                        let count = super::read_u32(&mut identity_cursor)?;
                        let key_blob = super::read_string(&mut identity_cursor)?.to_vec();
                        let _comment = super::read_string(&mut identity_cursor)?;
                        if !identity_cursor.is_empty() {
                            return None;
                        }
                        let mut key_cursor = key_blob.as_slice();
                        let algorithm = super::read_string(&mut key_cursor)?.to_vec();
                        let mut signed = [false; 3];
                        for signature_index in 0..3 {
                            let mut data = Vec::new();
                            write_string(&mut data, b"test-session-id");
                            data.push(50);
                            write_string(&mut data, b"deploy");
                            write_string(&mut data, b"ssh-connection");
                            write_string(&mut data, b"publickey");
                            data.push(1);
                            write_string(&mut data, &algorithm);
                            write_string(&mut data, &key_blob);

                            let mut request = vec![13];
                            write_string(&mut request, &key_blob);
                            write_string(&mut request, &data);
                            request.extend_from_slice(&0u32.to_be_bytes());
                            stream
                                .write_all(&(request.len() as u32).to_be_bytes())
                                .await
                                .ok()?;
                            stream.write_all(&request).await.ok()?;
                            stream.read_exact(&mut length).await.ok()?;
                            let mut response = vec![0; u32::from_be_bytes(length) as usize];
                            stream.read_exact(&mut response).await.ok()?;
                            signed[signature_index] = response.first().copied() == Some(14);
                        }
                        Some((count, signed[0], signed[1], signed[2]))
                    }
                    .await;
                    let _ = result.send(probe);
                });
            }
            Ok(())
        }
    }

    #[cfg(target_os = "linux")]
    async fn spawn_agent_probe_server(
        result: Option<oneshot::Sender<Option<u32>>>,
    ) -> (SocketAddr, HostKeyApproval) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind SSH test server");
        let address = listener.local_addr().expect("SSH test server address");
        let host_key = PrivateKey::random(&mut keys::key::safe_rng(), keys::Algorithm::Ed25519)
            .expect("generate host key");
        let approval = HostKeyApproval {
            fingerprint: host_key
                .public_key()
                .fingerprint(HashAlg::Sha256)
                .to_string(),
            replace: false,
        };
        let config = Arc::new(server::Config {
            auth_rejection_time: std::time::Duration::ZERO,
            auth_rejection_time_initial: Some(std::time::Duration::ZERO),
            keys: vec![host_key],
            ..Default::default()
        });
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept SSH test client");
            let running = server::run_stream(config, stream, AgentProbeServer { result })
                .await
                .expect("start SSH test session");
            let _ = running.await;
        });
        (address, approval)
    }

    #[cfg(target_os = "linux")]
    async fn spawn_consent_probe_server(
        result: oneshot::Sender<Option<(u32, bool, bool, bool)>>,
    ) -> (SocketAddr, HostKeyApproval) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind consent probe server");
        let address = listener.local_addr().expect("consent probe server address");
        let host_key = PrivateKey::random(&mut keys::key::safe_rng(), keys::Algorithm::Ed25519)
            .expect("generate host key");
        let approval = HostKeyApproval {
            fingerprint: host_key
                .public_key()
                .fingerprint(HashAlg::Sha256)
                .to_string(),
            replace: false,
        };
        let config = Arc::new(server::Config {
            auth_rejection_time: std::time::Duration::ZERO,
            auth_rejection_time_initial: Some(std::time::Duration::ZERO),
            keys: vec![host_key],
            ..Default::default()
        });
        tokio::spawn(async move {
            let (stream, _) = listener
                .accept()
                .await
                .expect("accept consent probe client");
            let running = server::run_stream(
                config,
                stream,
                ConsentProbeServer {
                    result: Some(result),
                },
            )
            .await
            .expect("start consent probe session");
            let _ = running.await;
        });
        (address, approval)
    }

    #[test]
    fn unknown_and_changed_host_keys_require_matching_approval() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("zync-known-hosts-{suffix}"));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join("known_hosts");
        let first_encoded = "AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ";
        let second_encoded = "AAAAC3NzaC1lZDI1NTE5AAAAILIG2T/B0l0gaqj3puu510tu9N1OkQ4znY3LYuEm5zCF";
        let first = keys::parse_public_key_base64(first_encoded).expect("first public key");
        let second = keys::parse_public_key_base64(second_encoded).expect("second public key");

        let unknown = verify_server_key_at_path("server", "example.com", 22, &first, None, &path)
            .expect_err("unknown host must be rejected")
            .to_string();
        assert!(unknown.starts_with(HOST_KEY_CHALLENGE_PREFIX));
        assert!(unknown.contains("\"kind\":\"unknown\""));
        let wrong_approval = HostKeyApproval {
            fingerprint: "SHA256:not-the-presented-key".to_string(),
            replace: false,
        };
        assert!(verify_server_key_at_path(
            "server",
            "example.com",
            22,
            &first,
            Some(&wrong_approval),
            &path,
        )
        .is_err());
        let first_approval = HostKeyApproval {
            fingerprint: first.fingerprint(HashAlg::Sha256).to_string(),
            replace: false,
        };
        assert!(verify_server_key_at_path(
            "server",
            "example.com",
            22,
            &first,
            Some(&first_approval),
            &path,
        )
        .expect("approve unknown host"));

        let fixture = format!(
            "# managed known hosts\nbefore.example ssh-ed25519 {second_encoded}\n# stale target follows\nexample.com ssh-ed25519 {first_encoded}\n# unrelated entry reuses the stale key\nafter.example ssh-ed25519 {first_encoded}\n"
        );
        std::fs::write(&path, &fixture).expect("write replacement fixture");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                .expect("restrict known_hosts permissions");
        }

        let changed = verify_server_key_at_path("server", "example.com", 22, &second, None, &path)
            .expect_err("changed host must be rejected")
            .to_string();
        assert!(changed.contains("\"kind\":\"changed\""));
        let unsafe_approval = HostKeyApproval {
            fingerprint: second.fingerprint(HashAlg::Sha256).to_string(),
            replace: false,
        };
        assert!(verify_server_key_at_path(
            "server",
            "example.com",
            22,
            &second,
            Some(&unsafe_approval),
            &path,
        )
        .is_err());
        let second_approval = HostKeyApproval {
            fingerprint: second.fingerprint(HashAlg::Sha256).to_string(),
            replace: true,
        };
        assert!(verify_server_key_at_path(
            "server",
            "example.com",
            22,
            &second,
            Some(&second_approval),
            &path,
        )
        .expect("replace changed host key"));

        let updated = std::fs::read_to_string(&path).expect("read known_hosts");
        assert!(updated.contains("# managed known hosts"));
        assert!(updated.contains(&format!("before.example ssh-ed25519 {second_encoded}")));
        assert!(updated.contains("# stale target follows"));
        assert!(updated.contains("# unrelated entry reuses the stale key"));
        assert!(updated.contains(&format!("after.example ssh-ed25519 {first_encoded}")));
        assert!(!updated.contains(&format!("example.com ssh-ed25519 {first_encoded}")));
        assert!(updated.contains(&format!("example.com ssh-ed25519 {second_encoded}")));
        assert_eq!(
            updated
                .lines()
                .filter(|line| line.starts_with("example.com "))
                .count(),
            1
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path)
                    .expect("known_hosts metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        assert!(
            keys::known_hosts::check_known_hosts_path("example.com", 22, &second, &path)
                .expect("check replacement")
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[ignore = "Docker end-to-end security regression"]
    async fn selected_key_consent_distinguishes_once_from_connection() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let home = std::env::temp_dir().join(format!("zync-agent-consent-{suffix}"));
        std::fs::create_dir_all(home.join(".ssh")).expect("create isolated SSH home");
        std::env::set_var("HOME", &home);

        let (result_tx, result_rx) = oneshot::channel();
        let (address, approval) = spawn_consent_probe_server(result_tx).await;
        let forwarded_key =
            PrivateKey::random(&mut keys::key::safe_rng(), keys::Algorithm::Ed25519)
                .expect("generate forwarded key");
        let mut forwarded_key_data = Vec::new();
        keys::encode_pkcs8_pem(&forwarded_key, &mut forwarded_key_data)
            .expect("encode forwarded key");
        let forwarded_key_data = String::from_utf8(forwarded_key_data).expect("forwarded key PEM");

        let (manager, prompt_count) = SshManager::with_test_consent([
            AgentSignatureDecision::AllowOnce,
            AgentSignatureDecision::AllowSession,
        ]);
        let (failure_tx, _failure_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let tunnels = Arc::new(TunnelManager::new(failure_tx));
        let session = manager
            .connect(
                ConnectionConfig {
                    id: "password-host".into(),
                    name: "password-host".into(),
                    host: address.ip().to_string(),
                    port: address.port(),
                    username: "test".into(),
                    auth_method: AuthMethod::Password {
                        password: "password".into(),
                    },
                    agent_forwarding: Some(AgentForwardingConfig {
                        source_connection_id: "selected-key".into(),
                        auth_method: AuthMethod::PrivateKeyData {
                            key_data: forwarded_key_data,
                            passphrase: None,
                            certificate: None,
                        },
                    }),
                    jump_host: None,
                    host_key_approval: Some(approval),
                    connect_attempt_id: None,
                    certificate_path: None,
                    network_interface_id: None,
                },
                tunnels,
            )
            .await
            .expect("connect password host with selected forwarded key");

        let channel = session
            .channel_open_session()
            .await
            .expect("open password host session");
        channel
            .agent_forward(true)
            .await
            .expect("request agent forwarding");
        let (identity_count, first_signed, second_signed, third_signed) =
            tokio::time::timeout(std::time::Duration::from_secs(5), result_rx)
                .await
                .expect("consent probe timed out")
                .expect("consent probe stopped")
                .expect("consent probe failed");

        assert_eq!(identity_count, 1, "more than the selected key was exposed");
        assert!(
            first_signed && second_signed && third_signed,
            "approved userauth requests failed"
        );
        assert_eq!(
            prompt_count.load(std::sync::atomic::Ordering::Relaxed),
            2,
            "allow-once must prompt again; allow-for-connection must suppress later prompts"
        );

        channel.close().await.expect("close password host channel");
        drop(session);
        let _ = std::fs::remove_dir_all(home);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[ignore = "Docker end-to-end security regression"]
    async fn authenticated_key_is_not_forwarded_to_a_password_session() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let home = std::env::temp_dir().join(format!("zync-agent-forward-{suffix}"));
        std::fs::create_dir_all(home.join(".ssh")).expect("create isolated SSH home");
        std::env::set_var("HOME", &home);

        let (address_a, approval_a) = spawn_agent_probe_server(None).await;
        let (result_tx, result_rx) = oneshot::channel();
        let (address_b, approval_b) = spawn_agent_probe_server(Some(result_tx)).await;
        let key_a = PrivateKey::random(&mut keys::key::safe_rng(), keys::Algorithm::Ed25519)
            .expect("generate client key");
        let mut key_data = Vec::new();
        keys::encode_pkcs8_pem(&key_a, &mut key_data).expect("encode client key");
        let key_data = String::from_utf8(key_data).expect("private key PEM");

        let manager = SshManager::new();
        let (failure_tx, _failure_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let tunnels = Arc::new(TunnelManager::new(failure_tx));
        let session_a = manager
            .connect(
                ConnectionConfig {
                    id: "host-a".into(),
                    name: "host-a".into(),
                    host: address_a.ip().to_string(),
                    port: address_a.port(),
                    username: "test".into(),
                    auth_method: AuthMethod::PrivateKeyData {
                        key_data,
                        passphrase: None,
                        certificate: None,
                    },
                    agent_forwarding: None,
                    jump_host: None,
                    host_key_approval: Some(approval_a),
                    connect_attempt_id: None,
                    certificate_path: None,
                    network_interface_id: None,
                },
                tunnels.clone(),
            )
            .await
            .expect("authenticate to host A with key A");
        let session_b = manager
            .connect(
                ConnectionConfig {
                    id: "host-b".into(),
                    name: "host-b".into(),
                    host: address_b.ip().to_string(),
                    port: address_b.port(),
                    username: "test".into(),
                    auth_method: AuthMethod::Password {
                        password: "password".into(),
                    },
                    agent_forwarding: None,
                    jump_host: None,
                    host_key_approval: Some(approval_b),
                    connect_attempt_id: None,
                    certificate_path: None,
                    network_interface_id: None,
                },
                tunnels,
            )
            .await
            .expect("authenticate to host B with password");

        let channel = session_b
            .channel_open_session()
            .await
            .expect("open host B session");
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), result_rx)
            .await
            .expect("host B agent probe timed out")
            .expect("host B agent probe stopped");
        assert_eq!(result, None, "host B received a forwarded agent response");

        channel.close().await.expect("close host B channel");
        drop((session_a, session_b));
        let _ = std::fs::remove_dir_all(home);
    }
}
