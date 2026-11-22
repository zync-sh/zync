//! Display-only provenance for identities returned by a specific agent connection.
//! Identification is never used to authorize a key or select a different agent.

use serde::Serialize;
#[cfg(any(unix, test))]
use std::path::Path;
use std::path::PathBuf;

#[cfg(windows)]
mod windows;

/// Cold Windows trust initialization can exceed one second; discovery still has a finite budget.
#[cfg(windows)]
const PROVIDER_LOOKUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// A timed-out blocking trust call retains its permit until it finishes, preventing a refresh backlog.
#[cfg(windows)]
static PROVIDER_INSPECTION: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderId {
    Bitwarden,
    OnePassword,
    #[cfg(any(windows, test))]
    OpenSsh,
    #[cfg(windows)]
    Pageant,
}

/// A signed process is stronger evidence than a conventional socket name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderEvidence {
    #[cfg(any(windows, test))]
    SignedProcess,
    #[cfg(any(unix, test))]
    SocketHint,
    #[cfg(windows)]
    Transport,
}

/// Public UI metadata only; never expose process paths or operating-system identities.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProvider {
    pub id: ProviderId,
    pub evidence: ProviderEvidence,
}

/// Captured from the exact stream before russh erases its platform-specific type.
pub(super) enum AgentOrigin {
    #[cfg(windows)]
    WindowsProcess(Option<PathBuf>),
    #[cfg(unix)]
    UnixSocket(PathBuf),
    #[cfg(windows)]
    Pageant,
}

/// Enrich discovery without letting optional process inspection block or fail key listing.
pub(super) async fn identify(origin: AgentOrigin) -> Option<AgentProvider> {
    match origin {
        #[cfg(windows)]
        AgentOrigin::WindowsProcess(path) => {
            let path = path?;
            let permit = PROVIDER_INSPECTION.try_acquire().ok()?;
            let lookup = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                windows::identify(&path)
            });
            tokio::time::timeout(PROVIDER_LOOKUP_TIMEOUT, lookup)
                .await
                .ok()?
                .ok()?
        }
        #[cfg(unix)]
        AgentOrigin::UnixSocket(path) => socket_hint(&path),
        #[cfg(windows)]
        AgentOrigin::Pageant => Some(AgentProvider {
            id: ProviderId::Pageant,
            evidence: ProviderEvidence::Transport,
        }),
    }
}

#[cfg(windows)]
pub(super) fn windows_origin(
    pipe: &tokio::net::windows::named_pipe::NamedPipeClient,
) -> AgentOrigin {
    windows::origin(pipe)
}

/// Recognized socket names are user-controlled hints, never verified process identities.
#[cfg(any(unix, test))]
fn socket_hint(path: &Path) -> Option<AgentProvider> {
    let name = path.file_name()?.to_str()?;
    let id = if name == ".bitwarden-ssh-agent.sock" {
        ProviderId::Bitwarden
    } else if name == "agent.sock"
        && path.components().any(|part| {
            part.as_os_str() == ".1password" || part.as_os_str() == "2BUA8C4S2C.com.1password"
        })
    {
        ProviderId::OnePassword
    } else {
        return None;
    };
    Some(AgentProvider {
        id,
        evidence: ProviderEvidence::SocketHint,
    })
}

/// Both a successful trust check and a recognized executable/publisher pair are required.
#[cfg(any(windows, test))]
fn signed_provider(executable: &str, publisher: &str, trusted: bool) -> Option<AgentProvider> {
    if !trusted {
        return None;
    }
    let candidates: &[(&str, &[&str], ProviderId)] = &[
        ("Bitwarden.exe", &["Bitwarden Inc."], ProviderId::Bitwarden),
        (
            "1Password.exe",
            &["Agilebits", "AgileBits Inc.", "1Password Inc."],
            ProviderId::OnePassword,
        ),
        (
            "ssh-agent.exe",
            &["Microsoft Windows", "Microsoft Corporation"],
            ProviderId::OpenSsh,
        ),
    ];
    let id = candidates
        .iter()
        .find(|(name, publishers, _)| {
            executable.eq_ignore_ascii_case(name)
                && publishers
                    .iter()
                    .any(|name| publisher.eq_ignore_ascii_case(name))
        })?
        .2;
    Some(AgentProvider {
        id,
        evidence: ProviderEvidence::SignedProcess,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_names_alone_never_identify_a_provider() {
        assert!(signed_provider("Bitwarden.exe", "Bitwarden Inc.", false).is_none());
        assert!(signed_provider("Bitwarden.exe", "Unrelated Publisher", true).is_none());
        assert!(signed_provider("renamed.exe", "Bitwarden Inc.", true).is_none());
        assert_eq!(
            signed_provider("bitwarden.EXE", "Bitwarden Inc.", true)
                .unwrap()
                .id,
            ProviderId::Bitwarden
        );
        assert_eq!(
            signed_provider("1Password.exe", "Agilebits", true)
                .unwrap()
                .id,
            ProviderId::OnePassword
        );
        assert_eq!(
            signed_provider("ssh-agent.exe", "Microsoft Windows", true)
                .unwrap()
                .id,
            ProviderId::OpenSsh
        );
    }

    #[test]
    fn unix_paths_supply_hints_without_claiming_verified_identity() {
        for (path, id) in [
            (
                "/home/user/.bitwarden-ssh-agent.sock",
                ProviderId::Bitwarden,
            ),
            ("/home/user/.1password/agent.sock", ProviderId::OnePassword),
            (
                "/Users/user/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock",
                ProviderId::OnePassword,
            ),
        ] {
            let provider = socket_hint(Path::new(path)).unwrap();
            assert_eq!(provider.id, id);
            assert_eq!(provider.evidence, ProviderEvidence::SocketHint);
        }
        for path in [
            "/tmp/ssh-random/agent.123",
            "/tmp/bitwarden-agent.sock",
            "/tmp/not.1password/agent.sock",
            "/tmp/agent.sock",
        ] {
            assert!(socket_hint(Path::new(path)).is_none());
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "read-only check against the user's active Windows agent, run explicitly"]
    async fn live_agent_owner_has_a_verified_publisher() {
        let connection = super::super::connect_agent().await.unwrap();
        let provider = identify(connection.origin)
            .await
            .expect("recognized signed provider");
        assert_eq!(provider.evidence, ProviderEvidence::SignedProcess);
        println!(
            "Agent provider: {}",
            serde_json::to_string(&provider).unwrap()
        );
    }
}
