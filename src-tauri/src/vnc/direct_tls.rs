//! Native VeNCrypt X509Plain over verified TLS, with the existing local viewer bridge.

use super::{
    bridge::{close_with_reason, relay, Viewer},
    rfb::{finish_viewer_auth, read_viewer, send_viewer, RFB_38},
    vault_auth::VaultLink,
};
use bytes::Bytes;
use native_tls::{Protocol, TlsConnector};
use std::time::Duration;
use tokio::{
    io::{self, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpStream,
    time::timeout,
};
use tokio_native_tls::TlsStream;
use zeroize::Zeroizing;

const VENCRYPT: u8 = 19;
const VENCRYPT_VERSION: [u8; 2] = [0, 2];
const PLAIN: u32 = 256;
const X509_PLAIN: u32 = 262;
const NEGOTIATION_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, PartialEq, Eq)]
enum Failure {
    Unsupported,
    Tls,
    Protocol,
    TimedOut,
    VaultRejected,
}

impl Failure {
    /// Keep peer-controlled handshake details out of the renderer and logs.
    fn reason(self) -> &'static str {
        match self {
            Self::Unsupported => "vnc-tls-unsupported",
            Self::Tls => "vnc-tls-verification-failed",
            Self::Protocol => "vnc-tls-handshake-failed",
            Self::TimedOut => "vnc-tls-timeout",
            Self::VaultRejected => "vnc-vault-auth-rejected",
        }
    }
}

impl From<io::Error> for Failure {
    fn from(_: io::Error) -> Self {
        Self::Protocol
    }
}

/// Prepare the remote and local handshakes before relaying the established TLS stream.
pub(super) async fn run(
    viewer: &mut Viewer,
    stream: TcpStream,
    host: &str,
    username: &str,
    vault_link: Option<VaultLink>,
) -> Result<(), &'static str> {
    let result = timeout(
        NEGOTIATION_TIMEOUT,
        prepare(viewer, stream, host, username, vault_link),
    )
    .await
    .unwrap_or(Err(Failure::TimedOut));
    match result {
        Ok(stream) => relay(viewer, stream).await,
        Err(failure) => Err(close_with_reason(viewer, failure.reason()).await),
    }
}

/// Resolve the linked credential and expose local authentication only after TLS verification.
async fn prepare(
    viewer: &mut Viewer,
    mut stream: TcpStream,
    host: &str,
    username: &str,
    vault_link: Option<VaultLink>,
) -> Result<TlsStream<TcpStream>, Failure> {
    select_x509_plain(&mut stream).await?;
    let connector = tokio::task::spawn_blocking(|| {
        TlsConnector::builder()
            .min_protocol_version(Some(Protocol::Tlsv12))
            .build()
    })
    .await
    .map_err(|_| Failure::Tls)?
    .map_err(|_| Failure::Tls)?;
    let host = host.strip_suffix('.').unwrap_or(host);
    let mut remote = tokio_native_tls::TlsConnector::from(connector)
        .connect(host, stream)
        .await
        .map_err(|_| Failure::Tls)?;

    let mut pending = begin_viewer_auth(viewer).await?;
    let password = match vault_link {
        Some(link) => {
            link.credential(|value| Zeroizing::new(value.to_owned()))
                .await
        }
        None => None,
    };
    if let Some(password) = password {
        authenticate(&mut remote, username, password).await?;
        finish_viewer_auth(viewer, &mut pending, &mut remote).await?;
    } else {
        offer_viewer_plain(viewer, &mut pending).await?;
        // The viewer's Plain credentials and the server result now travel only over verified TLS.
        remote.write_all(&pending).await?;
    }
    Ok(remote)
}

/// Require RFB 3.8 and VeNCrypt 0.2 with the certificate-authenticated Plain subtype.
async fn select_x509_plain<S: AsyncRead + AsyncWrite + Unpin>(
    remote: &mut S,
) -> Result<(), Failure> {
    let mut greeting = [0; RFB_38.len()];
    remote.read_exact(&mut greeting).await?;
    if greeting != RFB_38 {
        return Err(Failure::Unsupported);
    }
    remote.write_all(&RFB_38).await?;
    let count = usize::from(remote.read_u8().await?);
    let mut types = [0; u8::MAX as usize];
    remote.read_exact(&mut types[..count]).await?;
    if !types[..count].contains(&VENCRYPT) {
        return Err(Failure::Unsupported);
    }
    remote.write_u8(VENCRYPT).await?;

    let mut version = [0; VENCRYPT_VERSION.len()];
    remote.read_exact(&mut version).await?;
    if version != VENCRYPT_VERSION {
        return Err(Failure::Unsupported);
    }
    remote.write_all(&VENCRYPT_VERSION).await?;
    if remote.read_u8().await? != 0 {
        return Err(Failure::Unsupported);
    }
    let mut supported = false;
    for _ in 0..remote.read_u8().await? {
        supported |= remote.read_u32().await? == X509_PLAIN;
    }
    if !supported {
        return Err(Failure::Unsupported);
    }
    remote.write_u32(X509_PLAIN).await?;
    if remote.read_u8().await? != 1 {
        return Err(Failure::Tls);
    }
    Ok(())
}

/// Send the full saved password over TLS and clear the plaintext before waiting for the result.
async fn authenticate<S: AsyncRead + AsyncWrite + Unpin>(
    remote: &mut S,
    username: &str,
    password: Zeroizing<String>,
) -> Result<(), Failure> {
    let user_len = u32::try_from(username.len()).map_err(|_| Failure::Protocol)?;
    let pass_len = u32::try_from(password.len()).map_err(|_| Failure::Protocol)?;
    remote.write_u32(user_len).await?;
    remote.write_u32(pass_len).await?;
    remote.write_all(username.as_bytes()).await?;
    remote.write_all(password.as_bytes()).await?;
    drop(password);
    remote.flush().await?;
    if remote.read_u32().await? == 0 {
        Ok(())
    } else {
        Err(Failure::VaultRejected)
    }
}

/// Start an independent RFB handshake with the authorized local viewer.
async fn begin_viewer_auth(viewer: &mut Viewer) -> Result<Bytes, Failure> {
    send_viewer(viewer, &RFB_38).await?;
    let mut pending = Bytes::new();
    if read_viewer::<{ RFB_38.len() }>(viewer, &mut pending).await? != RFB_38 {
        return Err(Failure::Protocol);
    }
    Ok(pending)
}

/// Ask noVNC for credentials on loopback, then leave the manual prompt to the viewer.
async fn offer_viewer_plain(viewer: &mut Viewer, pending: &mut Bytes) -> Result<(), Failure> {
    send_viewer(viewer, &[1, VENCRYPT]).await?;
    if read_viewer::<1>(viewer, pending).await? != [VENCRYPT] {
        return Err(Failure::Protocol);
    }
    send_viewer(viewer, &VENCRYPT_VERSION).await?;
    if read_viewer::<2>(viewer, pending).await? != VENCRYPT_VERSION {
        return Err(Failure::Protocol);
    }
    send_viewer(viewer, &[0, 1]).await?;
    send_viewer(viewer, &PLAIN.to_be_bytes()).await?;
    if u32::from_be_bytes(read_viewer::<4>(viewer, pending).await?) != PLAIN {
        return Err(Failure::Protocol);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, DuplexStream};

    /// Exercise the real pre-TLS negotiation against a bounded in-memory RFB server.
    async fn send_rfb_offer(server: &mut DuplexStream, security_types: &[u8]) {
        server.write_all(&RFB_38).await.unwrap();
        let mut version = [0; RFB_38.len()];
        server.read_exact(&mut version).await.unwrap();
        assert_eq!(version, RFB_38);
        server.write_u8(security_types.len() as u8).await.unwrap();
        server.write_all(security_types).await.unwrap();
    }

    #[tokio::test]
    async fn direct_tls_closes_without_selecting_legacy_vnc_auth() {
        let (mut client, mut server) = duplex(64);
        let remote = async move {
            send_rfb_offer(&mut server, &[2]).await;
            assert_eq!(server.read(&mut [0]).await.unwrap(), 0);
        };
        let local = async move {
            assert_eq!(
                select_x509_plain(&mut client).await,
                Err(Failure::Unsupported)
            );
        };
        timeout(Duration::from_secs(1), async {
            tokio::join!(remote, local)
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn direct_tls_selects_only_x509_plain_and_waits_for_tls_ready() {
        for (offer, ack, expected) in [
            (vec![PLAIN, X509_PLAIN], 1, Ok(())),
            (vec![PLAIN, X509_PLAIN], 0, Err(Failure::Tls)),
            (vec![PLAIN], 1, Err(Failure::Unsupported)),
        ] {
            let (mut client, mut server) = duplex(64);
            let remote = async move {
                send_rfb_offer(&mut server, &[2, VENCRYPT]).await;
                assert_eq!(server.read_u8().await.unwrap(), VENCRYPT);
                server.write_all(&VENCRYPT_VERSION).await.unwrap();
                assert_eq!(server.read_u16().await.unwrap(), 2);
                server.write_u8(0).await.unwrap();
                server.write_u8(offer.len() as u8).await.unwrap();
                for subtype in &offer {
                    server.write_u32(*subtype).await.unwrap();
                }
                if offer.contains(&X509_PLAIN) {
                    assert_eq!(server.read_u32().await.unwrap(), X509_PLAIN);
                    server.write_u8(ack).await.unwrap();
                }
                assert_eq!(server.read(&mut [0]).await.unwrap(), 0);
            };
            let local = async move {
                assert_eq!(select_x509_plain(&mut client).await, expected);
            };
            timeout(Duration::from_secs(1), async {
                tokio::join!(remote, local)
            })
            .await
            .unwrap();
        }
    }
}
