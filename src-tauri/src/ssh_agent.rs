//! Local SSH-agent integration.
//!
//! Lets connections authenticate through an agent process instead of stored
//! private-key material. This is how the Bitwarden/Vaultwarden desktop apps
//! serve SSH keys (their "SSH agent" feature), and it also covers 1Password,
//! the Windows OpenSSH agent service, Pageant and any Unix `SSH_AUTH_SOCK`
//! agent. The private key never leaves the agent; Zync only asks it to sign.

use anyhow::{anyhow, Result};
use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::agent::{AgentIdentity, AgentSessionBinding};
use russh::keys::{self, HashAlg, PublicKeyBase64};
use serde::Serialize;
use std::future::Future;
use std::time::Duration;

/// Named pipe of the Windows OpenSSH agent service. Bitwarden/Vaultwarden and
/// 1Password serve their SSH-agent keys through this same pipe when enabled.
#[cfg(windows)]
const WINDOWS_OPENSSH_AGENT_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";

/// Upper bound on one pipe connection attempt: russh retries `ERROR_PIPE_BUSY`
/// forever, which must not stall the fallback to Pageant (or the UI) forever.
#[cfg(windows)]
const PIPE_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

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
}

/// Connect to the local SSH agent, trying each backend available for the
/// platform in turn.
pub async fn connect() -> Result<DynamicAgentClient> {
    connect_platform().await
}

/// List the identities the local agent currently serves. Errors when no agent
/// is reachable, which the UI treats as "SSH agent unavailable".
pub async fn list_keys() -> Result<Vec<AgentKeyInfo>> {
    Ok(list_identities()
        .await?
        .iter()
        .map(identity_key_info)
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
    let mut client = connect().await?;
    if let Some(binding) = session_binding {
        let _ = client.bind_session(binding, false).await;
    }
    let mut identities = request_identities(&mut client).await?;
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

async fn request_identities(client: &mut DynamicAgentClient) -> Result<Vec<AgentIdentity>> {
    client
        .request_identities()
        .await
        .map_err(|error| anyhow!("Failed to list SSH agent keys: {error}"))
}

#[cfg(windows)]
async fn connect_platform() -> Result<DynamicAgentClient> {
    let pipe_attempt =
        tokio::time::timeout(PIPE_CONNECT_TIMEOUT, AgentClient::connect_named_pipe(
            WINDOWS_OPENSSH_AGENT_PIPE,
        ))
        .await;
    if let Ok(Ok(client)) = pipe_attempt {
        return Ok(client.dynamic());
    }
    if let Ok(client) = AgentClient::connect_pageant().await {
        return Ok(client.dynamic());
    }
    Err(anyhow!(
        "No SSH agent found. Start the OpenSSH Agent service, or enable the SSH agent in \
         Bitwarden/Vaultwarden (Settings > SSH agent) or 1Password, then retry."
    ))
}

#[cfg(not(windows))]
async fn connect_platform() -> Result<DynamicAgentClient> {
    AgentClient::connect_env()
        .await
        .map(|client| client.dynamic())
        .map_err(|_| {
            anyhow!(
                "No SSH agent found. Set SSH_AUTH_SOCK to an ssh-agent socket, or enable the \
                 SSH agent in Bitwarden/Vaultwarden (or 1Password), then retry."
            )
        })
}

fn list_identities() -> impl Future<Output = Result<Vec<AgentIdentity>>> {
    async move {
        let mut client = connect().await?;
        request_identities(&mut client).await
    }
}

fn identity_key_info(identity: &AgentIdentity) -> AgentKeyInfo {
    let key = identity.public_key().into_owned();
    AgentKeyInfo {
        public_key: identity_selector(identity),
        fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
        algorithm: key.algorithm().as_str().to_string(),
        comment: non_empty_comment(identity.comment()),
        is_certificate: matches!(identity, AgentIdentity::Certificate { .. }),
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
mod tests {
    use super::*;

    /// A real ed25519 public key in OpenSSH wire format, base64-encoded.
    const ED25519_BASE64: &str =
        "AAAAC3NzaC1lZDI1NTE5AAAAIEutQa3U2JY/LeFkCo9yOuA7J5Q95r3zrtXr85oPplLX";

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
}
