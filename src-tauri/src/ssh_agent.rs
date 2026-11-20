//! Local SSH-agent integration.
//!
//! Lets connections authenticate through an agent process instead of stored
//! private-key material. Bitwarden desktop (including compatible Vaultwarden
//! accounts) serves SSH keys through its "SSH agent" feature, as do 1Password,
//! the Windows OpenSSH agent service, Pageant and any Unix `SSH_AUTH_SOCK`
//! agent. The private key never leaves the agent; Zync only asks it to sign.

use anyhow::{anyhow, Result};
use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::agent::{AgentIdentity, AgentSessionBinding};
use russh::keys::{self, HashAlg, PublicKeyBase64};
use serde::Serialize;
use std::time::Duration;

mod discovery;
pub use discovery::{DiscoveryCode, DiscoveryError};
mod provider;
pub use provider::AgentProvider;

struct ConnectedAgent {
    client: DynamicAgentClient,
    origin: provider::AgentOrigin,
}

/// Named pipe of the Windows OpenSSH agent service. Bitwarden/Vaultwarden and
/// 1Password serve their SSH-agent keys through this same pipe when enabled.
#[cfg(windows)]
const WINDOWS_OPENSSH_AGENT_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";

/// Upper bound on one pipe connection attempt: russh retries `ERROR_PIPE_BUSY`
/// forever, which must not stall the fallback to Pageant (or the UI) forever.
#[cfg(windows)]
const PIPE_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

/// Discovery and metadata exchanges must finish without waiting for user signing consent.
/// Signing itself has no short metadata deadline: hardware and password-manager approvals
/// can legitimately take longer.
const AGENT_METADATA_TIMEOUT: Duration = Duration::from_secs(5);

/// Agent client with the backend stream erased, so named-pipe, Pageant and
/// Unix-socket agents all share one type.
pub type DynamicAgentClient = AgentClient<Box<dyn AgentStream + Send + Unpin>>;

/// One identity currently served by the local SSH agent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentKeyInfo {
    /// Canonical selector used to pick this identity again — `algorithm base64`
    /// for plain keys, the full OpenSSH certificate line for certificates.
    pub public_key: String,
    /// SHA-256 fingerprint, as `SHA256:...`.
    pub fingerprint: String,
    /// SSH key algorithm name, e.g. `ssh-ed25519` or `rsa-sha2-512`.
    pub algorithm: String,
    pub comment: Option<String>,
    /// True when the identity is an OpenSSH user certificate.
    pub is_certificate: bool,
    /// Agent serving this discovery connection; not the key's original creator.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<AgentProvider>,
}

/// Connect to the local SSH agent, trying each backend available for the
/// platform in turn.
pub async fn connect() -> Result<DynamicAgentClient> {
    Ok(connect_agent().await?.client)
}

async fn connect_agent() -> Result<ConnectedAgent> {
    tokio::time::timeout(AGENT_METADATA_TIMEOUT, connect_platform())
        .await
        .map_err(|_| {
            DiscoveryError::new(DiscoveryCode::Timeout, "Timed out connecting to the agent.")
        })?
}

/// List the identities the local agent currently serves. Errors when no agent
/// is reachable, which the UI treats as "SSH agent unavailable".
pub async fn list_keys() -> Result<Vec<AgentKeyInfo>, DiscoveryError> {
    let ConnectedAgent { mut client, origin } =
        connect_agent().await.map_err(DiscoveryError::from)?;
    let (identities, provider) = tokio::join!(
        tokio::time::timeout(AGENT_METADATA_TIMEOUT, request_identities(&mut client)),
        provider::identify(origin),
    );
    let identities = identities
        .map_err(|_| {
            DiscoveryError::new(
                DiscoveryCode::Timeout,
                "Timed out reading SSH agent identities.",
            )
        })?
        .map_err(DiscoveryError::from)?;
    Ok(identities
        .iter()
        .map(|identity| {
            let mut info = identity_key_info(identity);
            info.provider = provider;
            info
        })
        .collect())
}

/// Connect to the agent and select one identity: the requested public key when
/// given, otherwise the agent's first key. Returns the client together with
/// the identity because the client must stay alive to answer sign requests.
///
/// `session_binding` is the current SSH session's verified binding, used to
/// support OpenSSH destination-constrained identities. Best effort: agents
/// without the `session-bind@openssh.com` extension ignore the request.
pub async fn select_identity(
    requested: Option<&str>,
    session_binding: Option<&AgentSessionBinding>,
) -> Result<(DynamicAgentClient, AgentIdentity)> {
    select_identity_with_client(
        connect().await?,
        requested,
        session_binding,
        AGENT_METADATA_TIMEOUT,
    )
    .await
}

/// Own the client during metadata requests so a timeout drops any partially read protocol frame.
async fn select_identity_with_client(
    mut client: DynamicAgentClient,
    requested: Option<&str>,
    session_binding: Option<&AgentSessionBinding>,
    timeout: Duration,
) -> Result<(DynamicAgentClient, AgentIdentity)> {
    let identities = tokio::time::timeout(timeout, async {
        if let Some(binding) = session_binding {
            match client.bind_session(binding, false).await {
                Ok(()) | Err(keys::Error::AgentFailure) => {}
                Err(error) => return Err(anyhow!("Failed to bind the SSH agent session: {error}")),
            }
        }
        request_identities(&mut client).await
    })
    .await
    .map_err(|_| {
        DiscoveryError::new(
            DiscoveryCode::Timeout,
            "Timed out reading SSH agent identities.",
        )
    })??;
    choose_identity(client, identities, requested)
}

/// Select without changing agent order or silently substituting another requested identity.
fn choose_identity(
    client: DynamicAgentClient,
    mut identities: Vec<AgentIdentity>,
    requested: Option<&str>,
) -> Result<(DynamicAgentClient, AgentIdentity)> {
    let identity = match requested.map(canonicalize_requested_key).transpose()? {
        None => identities
            .into_iter()
            .next()
            .ok_or_else(|| anyhow!("The SSH agent currently holds no keys."))?,
        Some(selector) => {
            let matches: Vec<usize> = identities
                .iter()
                .enumerate()
                .filter(|(_, identity)| identity_selector(identity) == selector)
                .map(|(index, _)| index)
                .collect();
            match matches.as_slice() {
                [] => anyhow::bail!("The SSH agent does not hold the selected key."),
                [index] => identities.swap_remove(*index),
                _ => anyhow::bail!(
                    "Multiple SSH agent keys match the selected public key; remove the duplicate key from the agent."
                ),
            }
        }
    };
    Ok((client, identity))
}

/// Preserve the agent's error context while metadata callers supply their own deadline.
async fn request_identities(client: &mut DynamicAgentClient) -> Result<Vec<AgentIdentity>> {
    client
        .request_identities()
        .await
        .map_err(|error| DiscoveryError::from(error).into())
}

#[cfg(windows)]
async fn connect_platform() -> Result<ConnectedAgent> {
    let pipe_error = match tokio::time::timeout(PIPE_CONNECT_TIMEOUT, open_windows_pipe()).await {
        Ok(Ok(pipe)) => {
            let origin = provider::windows_origin(&pipe);
            return Ok(ConnectedAgent {
                client: AgentClient::connect(pipe).dynamic(),
                origin,
            });
        }
        Ok(Err(error)) => DiscoveryError::from(keys::Error::IO(error)),
        Err(_) => DiscoveryError::new(
            DiscoveryCode::Timeout,
            "Timed out opening the standard Windows agent pipe.",
        ),
    };
    match AgentClient::connect_pageant().await {
        Ok(client) => Ok(ConnectedAgent {
            client: client.dynamic(),
            origin: provider::AgentOrigin::Pageant,
        }),
        Err(error) => Err(pipe_error.with_pageant_failure(error).into()),
    }
}

#[cfg(not(windows))]
async fn connect_platform() -> Result<ConnectedAgent> {
    let socket = std::env::var_os("SSH_AUTH_SOCK")
        .ok_or_else(|| DiscoveryError::from(keys::Error::EnvVar("SSH_AUTH_SOCK")))?;
    let client = AgentClient::connect_uds(&socket)
        .await
        .map_err(DiscoveryError::from)?;
    Ok(ConnectedAgent {
        client: client.dynamic(),
        origin: provider::AgentOrigin::UnixSocket(socket.into()),
    })
}

/// Retain the native stream until ownership is captured. The caller bounds busy-pipe retries.
#[cfg(windows)]
async fn open_windows_pipe() -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
    loop {
        match tokio::net::windows::named_pipe::ClientOptions::new().open(WINDOWS_OPENSSH_AGENT_PIPE)
        {
            Ok(pipe) => return Ok(pipe),
            Err(error)
                if error.raw_os_error()
                    == Some(windows_sys::Win32::Foundation::ERROR_PIPE_BUSY as i32) =>
            {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(error) => return Err(error),
        }
    }
}

/// Authenticate either agent identity using the existing RSA policy and upstream signer.
/// User-mediated signature approval intentionally outlives the metadata timeout.
pub(crate) async fn authenticate_identity<H: russh::client::Handler>(
    session: &mut russh::client::Handle<H>,
    username: &str,
    mut agent: DynamicAgentClient,
    identity: AgentIdentity,
) -> Result<russh::client::AuthResult> {
    let pubkey = identity.public_key().into_owned();
    let hash = if pubkey.algorithm().is_rsa() {
        Some(crate::ssh::rsa_auth_hash(
            session.best_supported_rsa_hash().await?,
        )?)
    } else {
        None
    };
    match identity {
        AgentIdentity::Certificate { certificate, .. } => {
            session
                .authenticate_certificate_with(username, certificate, hash, &mut agent)
                .await
        }
        AgentIdentity::PublicKey { .. } => {
            session
                .authenticate_publickey_with(username, pubkey, hash, &mut agent)
                .await
        }
    }
    .map_err(|error| anyhow!("SSH agent authentication failed: {error}"))
}

fn identity_key_info(identity: &AgentIdentity) -> AgentKeyInfo {
    let key = identity.public_key().into_owned();
    AgentKeyInfo {
        public_key: identity_selector(identity),
        fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
        algorithm: key.algorithm().as_str().to_string(),
        comment: non_empty_comment(identity.comment()),
        is_certificate: matches!(identity, AgentIdentity::Certificate { .. }),
        provider: None,
    }
}

/// Canonical selector for one agent identity. Plain keys keep the historical
/// `algorithm base64` form; certificates get their full OpenSSH line so a
/// certificate and its underlying key (or another certificate of the same key)
/// never share one selector.
fn identity_selector(identity: &AgentIdentity) -> String {
    match identity {
        AgentIdentity::PublicKey { key, .. } => canonical_public_key_string(key),
        AgentIdentity::Certificate { certificate, .. } => certificate
            .to_openssh()
            .map(|line| normalize_openssh_line(&line))
            .unwrap_or_else(|_| canonical_public_key_string(&identity.public_key())),
    }
}

fn canonical_public_key_string(key: &keys::PublicKey) -> String {
    format!("{} {}", key.algorithm().as_str(), key.public_key_base64())
}

/// Keep only `algorithm blob`, dropping any trailing comment.
fn normalize_openssh_line(line: &str) -> String {
    let mut parts = line.split_whitespace();
    match (parts.next(), parts.next()) {
        (Some(algorithm), Some(blob)) => format!("{algorithm} {blob}"),
        _ => String::new(),
    }
}

/// Accept a full `algorithm base64 comment` line, a bare base64 blob, or an
/// OpenSSH certificate line, and return the canonical selector for
/// comparisons.
fn canonicalize_requested_key(requested: &str) -> Result<String> {
    let trimmed = requested.trim();
    anyhow::ensure!(!trimmed.is_empty(), "SSH agent key selector is empty");
    let first_token = trimmed.split_whitespace().next().unwrap_or("");
    if first_token.ends_with("-cert-v01@openssh.com") {
        let certificate = keys::Certificate::from_openssh(trimmed)
            .map_err(|error| anyhow!("Invalid SSH agent certificate selector: {error}"))?;
        let line = certificate
            .to_openssh()
            .map_err(|error| anyhow!("Invalid SSH agent certificate selector: {error}"))?;
        let normalized = normalize_openssh_line(&line);
        anyhow::ensure!(
            !normalized.is_empty(),
            "Invalid SSH agent certificate selector"
        );
        return Ok(normalized);
    }
    let base64_part = trimmed.split_whitespace().nth(1).unwrap_or(trimmed);
    let key = keys::parse_public_key_base64(base64_part)
        .map_err(|error| anyhow!("Invalid SSH agent key selector: {error}"))?;
    Ok(canonical_public_key_string(&key))
}

fn non_empty_comment(comment: &str) -> Option<String> {
    let trimmed = comment.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[cfg(test)]
#[path = "ssh_agent/tests.rs"]
mod tests;
