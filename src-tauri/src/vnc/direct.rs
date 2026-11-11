//! Direct TCP transport for a standalone VNC viewer.

use super::{
    accept_viewer,
    bridge::close_with_reason,
    direct_tls,
    vault_auth::{self, VaultLink},
    Lease, Offer, OPEN_TIMEOUT,
};
use std::{
    io,
    net::{IpAddr, Ipv6Addr},
};
use tokio::{
    net::{TcpListener, TcpStream},
    time::timeout,
};

const INVALID_HOST: &str = "Enter a VNC hostname or IP address without a port or URL.";

enum ConnectFailure {
    Refused,
    TimedOut,
    Unreachable,
}

impl ConnectFailure {
    /// Classify the socket error without forwarding system details to the renderer.
    fn from_io(error: io::Error) -> Self {
        match error.kind() {
            io::ErrorKind::ConnectionRefused => Self::Refused,
            io::ErrorKind::TimedOut => Self::TimedOut,
            _ => Self::Unreachable,
        }
    }

    /// The renderer maps these stable close reasons to user-facing guidance.
    fn reason(&self) -> &'static str {
        match self {
            Self::Refused => "vnc-endpoint-refused",
            Self::TimedOut => "vnc-endpoint-timeout",
            Self::Unreachable => "vnc-endpoint-unreachable",
        }
    }
}

#[derive(Debug)]
pub(super) struct Endpoint {
    host: String,
    port: u16,
    tls_username: Option<String>,
}

impl Endpoint {
    /// Accept DNS and IP literals while keeping address and port as distinct inputs.
    pub(super) fn parse(host: &str, port: u16) -> Result<Self, &'static str> {
        let host = host.trim();
        let host = if let Some(ip) = host
            .strip_prefix('[')
            .and_then(|host| host.strip_suffix(']'))
        {
            ip.parse::<Ipv6Addr>().map_err(|_| INVALID_HOST)?;
            ip
        } else if host.parse::<IpAddr>().is_ok() || is_dns_name(host) {
            host
        } else {
            return Err(INVALID_HOST);
        };
        Ok(Self {
            host: host.into(),
            port,
            tls_username: None,
        })
    }

    /// A TLS route requires an account name for X509Plain authentication.
    pub(super) fn require_tls(&mut self, username: String) -> Result<(), &'static str> {
        if username.trim().is_empty()
            || username.len() > 255
            || username.bytes().any(|byte| byte.is_ascii_control())
        {
            return Err("Enter a VNC username using 1 to 255 bytes.");
        }
        self.tls_username = Some(username);
        Ok(())
    }

    /// Admit a Vault link only for the saved standalone endpoint identified by the renderer.
    pub(super) fn vault_link(
        &self,
        app: tauri::AppHandle,
        profile_id: String,
    ) -> Option<VaultLink> {
        VaultLink::bind(
            app,
            profile_id,
            &self.host,
            self.port,
            self.tls_username.as_deref(),
        )
    }

    /// Bound DNS lookup and all address attempts by one deadline.
    async fn connect(&self) -> Result<TcpStream, ConnectFailure> {
        let stream = timeout(
            OPEN_TIMEOUT,
            TcpStream::connect((self.host.as_str(), self.port)),
        )
        .await
        .map_err(|_| ConnectFailure::TimedOut)?
        .map_err(ConnectFailure::from_io)?;
        let _ = stream.set_nodelay(true);
        Ok(stream)
    }
}

/// Check DNS labels without interpreting URL syntax or changing the saved name.
fn is_dns_name(host: &str) -> bool {
    let name = host.strip_suffix('.').unwrap_or(host);
    name.len() <= 253
        // The IP parser owns numeric forms. Do not let the system resolver reinterpret them.
        && !name.bytes().all(|byte| byte.is_ascii_digit() || byte == b'.')
        && name.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

/// Wait for viewer authorization before dialing and cancel every phase under one lease.
pub(super) async fn run(
    listener: TcpListener,
    offer: Offer,
    endpoint: Endpoint,
    vault_link: Option<VaultLink>,
    mut lease: Lease,
) -> Result<(), &'static str> {
    let connect_and_relay = async move {
        let mut viewer = accept_viewer(listener, offer).await?;
        let stream = match endpoint.connect().await {
            Ok(stream) => stream,
            Err(failure) => return Err(close_with_reason(&mut viewer, failure.reason()).await),
        };
        if let Some(username) = endpoint.tls_username {
            direct_tls::run(&mut viewer, stream, &endpoint.host, &username, vault_link).await
        } else {
            vault_auth::relay_with_vault(&mut viewer, stream, vault_link).await
        }
    };
    tokio::select! {
        biased;
        _ = lease.wait_cancelled() => Ok(()),
        result = connect_and_relay => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dial_failures_emit_only_static_renderer_codes() {
        for (kind, expected) in [
            (io::ErrorKind::ConnectionRefused, "vnc-endpoint-refused"),
            (io::ErrorKind::TimedOut, "vnc-endpoint-timeout"),
            (io::ErrorKind::NotFound, "vnc-endpoint-unreachable"),
        ] {
            let error = io::Error::new(kind, "private system details");
            assert_eq!(ConnectFailure::from_io(error).reason(), expected);
        }
    }
}
