//! Stable discovery diagnostics for the UI, independent of provider names and OS error text.

use russh::keys;
use serde::Serialize;
use std::{fmt, io::ErrorKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiscoveryCode {
    Unavailable,
    AccessDenied,
    Refused,
    Timeout,
    Failed,
}

/// Discovery never claims that an agent is disabled or locked without protocol evidence.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryError {
    pub code: DiscoveryCode,
    pub message: &'static str,
    pub details: String,
}

impl DiscoveryError {
    pub fn new(code: DiscoveryCode, details: impl Into<String>) -> Self {
        let message = match code {
            DiscoveryCode::Unavailable => "No local SSH agent is reachable.",
            DiscoveryCode::AccessDenied => "Zync cannot access the local SSH agent.",
            DiscoveryCode::Refused => "The SSH agent refused to list keys.",
            DiscoveryCode::Timeout => "The local SSH agent did not respond in time.",
            DiscoveryCode::Failed => "Could not read keys from the local SSH agent.",
        };
        Self {
            code,
            message,
            details: details.into(),
        }
    }

    /// Preserve the primary pipe diagnosis when the optional Pageant fallback also fails.
    #[cfg(any(windows, test))]
    pub(super) fn with_pageant_failure(mut self, error: keys::Error) -> Self {
        self.details = format!("Standard Windows agent: {} Pageant: {error}", self.details);
        self
    }
}

impl fmt::Display for DiscoveryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} {}", self.message, self.details)
    }
}

impl std::error::Error for DiscoveryError {}

impl From<keys::Error> for DiscoveryError {
    fn from(error: keys::Error) -> Self {
        let code = match &error {
            keys::Error::EnvVar(_) | keys::Error::BadAuthSock => DiscoveryCode::Unavailable,
            keys::Error::AgentFailure => DiscoveryCode::Refused,
            keys::Error::IO(error) => match error.kind() {
                ErrorKind::PermissionDenied => DiscoveryCode::AccessDenied,
                ErrorKind::TimedOut => DiscoveryCode::Timeout,
                ErrorKind::NotFound
                | ErrorKind::UnexpectedEof
                | ErrorKind::BrokenPipe
                | ErrorKind::ConnectionReset
                | ErrorKind::ConnectionRefused
                | ErrorKind::ConnectionAborted
                | ErrorKind::NotConnected => DiscoveryCode::Unavailable,
                _ => DiscoveryCode::Failed,
            },
            _ => DiscoveryCode::Failed,
        };
        Self::new(code, error.to_string())
    }
}

impl From<anyhow::Error> for DiscoveryError {
    fn from(error: anyhow::Error) -> Self {
        error
            .downcast::<Self>()
            .unwrap_or_else(|error| Self::new(DiscoveryCode::Failed, error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_transport_failures_without_guessing_provider_state() {
        for (kind, code) in [
            (ErrorKind::UnexpectedEof, DiscoveryCode::Unavailable),
            (ErrorKind::NotFound, DiscoveryCode::Unavailable),
            (ErrorKind::ConnectionRefused, DiscoveryCode::Unavailable),
            (ErrorKind::PermissionDenied, DiscoveryCode::AccessDenied),
            (ErrorKind::TimedOut, DiscoveryCode::Timeout),
            (ErrorKind::InvalidData, DiscoveryCode::Failed),
        ] {
            let issue = DiscoveryError::from(keys::Error::IO(std::io::Error::new(
                kind,
                "fixture transport error",
            )));
            assert_eq!(issue.code, code);
            assert!(issue.details.contains("fixture transport error"));
            assert!(!issue.message.contains("locked"));
            assert!(!issue.message.contains("disabled"));
        }
        assert_eq!(
            DiscoveryError::from(keys::Error::AgentFailure).code,
            DiscoveryCode::Refused
        );
        assert_eq!(
            DiscoveryError::from(keys::Error::EnvVar("SSH_AUTH_SOCK")).code,
            DiscoveryCode::Unavailable
        );
        assert_eq!(
            DiscoveryError::from(keys::Error::BadAuthSock).code,
            DiscoveryCode::Unavailable
        );
    }

    #[test]
    fn preserves_codes_through_context_and_serializes_the_ipc_contract() {
        let error = anyhow::Error::from(DiscoveryError::new(
            DiscoveryCode::AccessDenied,
            "fixture details",
        ))
        .context("agent discovery");
        let issue = DiscoveryError::from(error);
        let json = serde_json::to_value(issue).unwrap();
        assert_eq!(json["code"], "accessDenied");
        assert_eq!(json["message"], "Zync cannot access the local SSH agent.");
        assert_eq!(json["details"], "fixture details");
        let unknown = DiscoveryError::from(anyhow::anyhow!("unrecognized fixture error"));
        assert_eq!(unknown.code, DiscoveryCode::Failed);
        assert_eq!(unknown.details, "unrecognized fixture error");
    }

    #[test]
    fn pageant_fallback_failure_preserves_primary_transport_diagnostics() {
        for (kind, code) in [
            (ErrorKind::PermissionDenied, DiscoveryCode::AccessDenied),
            (ErrorKind::TimedOut, DiscoveryCode::Timeout),
            (ErrorKind::NotFound, DiscoveryCode::Unavailable),
        ] {
            let issue = DiscoveryError::from(keys::Error::IO(std::io::Error::new(
                kind,
                "fixture pipe failure",
            )))
            .with_pageant_failure(keys::Error::IO(std::io::Error::new(
                ErrorKind::NotFound,
                "fixture Pageant missing",
            )));
            assert_eq!(issue.code, code);
            assert!(issue.details.contains("fixture pipe failure"));
            assert!(issue.details.contains("fixture Pageant missing"));
        }
    }
}
