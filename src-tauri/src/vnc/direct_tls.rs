//! Native VeNCrypt X509Plain over verified TLS, with the existing local viewer bridge.

use super::{
    bridge::{close_with_reason, relay, Viewer},
    rfb::{finish_viewer_auth, read_viewer, send_viewer, RFB_38},
    vault_auth::VaultLink,
};
use bytes::Bytes;
use native_tls::{Protocol, TlsConnector, TlsConnectorBuilder};
use std::{future::Future, time::Duration};
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
    let password = async move {
        let link = vault_link?;
        link.credential(|value| Zeroizing::new(value.to_owned()))
            .await
    };
    let result = timeout(
        NEGOTIATION_TIMEOUT,
        prepare(
            viewer,
            stream,
            host,
            username,
            tls_connector_builder(),
            password,
        ),
    )
    .await
    .unwrap_or(Err(Failure::TimedOut));
    match result {
        Ok(stream) => relay(viewer, stream).await,
        Err(failure) => Err(close_with_reason(viewer, failure.reason()).await),
    }
}

/// Use the platform trust store and require TLS 1.2 or newer.
fn tls_connector_builder() -> TlsConnectorBuilder {
    let mut builder = TlsConnector::builder();
    builder.min_protocol_version(Some(Protocol::Tlsv12));
    builder
}

/// Resolve the linked credential and expose local authentication only after TLS verification.
async fn prepare(
    viewer: &mut Viewer,
    mut stream: TcpStream,
    host: &str,
    username: &str,
    connector: TlsConnectorBuilder,
    password: impl Future<Output = Option<Zeroizing<String>>>,
) -> Result<TlsStream<TcpStream>, Failure> {
    select_x509_plain(&mut stream).await?;
    let connector = tokio::task::spawn_blocking(move || connector.build())
        .await
        .map_err(|_| Failure::Tls)?
        .map_err(|_| Failure::Tls)?;
    let host = host.strip_suffix('.').unwrap_or(host);
    let mut remote = tokio_native_tls::TlsConnector::from(connector)
        .connect(host, stream)
        .await
        .map_err(|_| Failure::Tls)?;

    let mut pending = begin_viewer_auth(viewer).await?;
    if let Some(password) = password.await {
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
    use crate::vnc::{
        bridge::accept_viewer,
        tests::{connect, offer, viewer_data},
    };
    use futures_util::{SinkExt, StreamExt};
    use rcgen::{
        BasicConstraints, CertificateParams, CertifiedIssuer, DnType, ExtendedKeyUsagePurpose,
        IsCa, KeyPair, KeyUsagePurpose,
    };
    use std::{cell::Cell, net::Ipv4Addr, sync::Arc};
    use tokio::{io::duplex, net::TcpListener};
    use tokio_rustls::{rustls, TlsAcceptor};
    use tokio_tungstenite::tungstenite::Message;
    use uuid::Uuid;

    /// Send the RFB security list after checking the client's version.
    async fn send_rfb_offer(
        server: &mut (impl AsyncRead + AsyncWrite + Unpin),
        security_types: &[u8],
    ) {
        server.write_all(&RFB_38).await.unwrap();
        let mut version = [0; RFB_38.len()];
        server.read_exact(&mut version).await.unwrap();
        assert_eq!(version, RFB_38);
        server.write_u8(security_types.len() as u8).await.unwrap();
        server.write_all(security_types).await.unwrap();
    }

    /// Offer the same VeNCrypt subtypes on both the in-memory and TLS peers.
    async fn send_vencrypt_offer(
        server: &mut (impl AsyncRead + AsyncWrite + Unpin),
        subtypes: &[u32],
        tls_ready: u8,
    ) {
        send_rfb_offer(server, &[2, VENCRYPT]).await;
        assert_eq!(server.read_u8().await.unwrap(), VENCRYPT);
        server.write_all(&VENCRYPT_VERSION).await.unwrap();
        assert_eq!(
            server.read_u16().await.unwrap(),
            u16::from_be_bytes(VENCRYPT_VERSION)
        );
        server.write_u8(0).await.unwrap();
        server.write_u8(subtypes.len() as u8).await.unwrap();
        for subtype in subtypes {
            server.write_u32(*subtype).await.unwrap();
        }
        if subtypes.contains(&X509_PLAIN) {
            assert_eq!(server.read_u32().await.unwrap(), X509_PLAIN);
            server.write_u8(tls_ready).await.unwrap();
        }
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
                send_vencrypt_offer(&mut server, &offer, ack).await;
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

    /// Generate a CA and a TLS 1.2 server certificate with the given DNS identity.
    fn tls_peer(host: &str) -> (native_tls::Certificate, TlsAcceptor) {
        let now = time::OffsetDateTime::now_utc();
        let validity = time::Duration::days(1);
        let mut ca = CertificateParams::default();
        ca.distinguished_name
            .push(DnType::CommonName, "Zync VNC test CA");
        ca.not_before = now - validity;
        ca.not_after = now + validity;
        ca.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        ca.key_usages = vec![KeyUsagePurpose::KeyCertSign];
        let issuer = CertifiedIssuer::self_signed(ca, KeyPair::generate().unwrap()).unwrap();
        let mut leaf = CertificateParams::new(vec![host.to_owned()]).unwrap();
        leaf.distinguished_name.push(DnType::CommonName, host);
        leaf.not_before = now - validity;
        leaf.not_after = now + validity;
        leaf.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        let key = KeyPair::generate().unwrap();
        let certificate = leaf.signed_by(&key, &issuer).unwrap();
        let config =
            rustls::ServerConfig::builder_with_protocol_versions(&[&rustls::version::TLS12])
                .with_no_client_auth()
                .with_single_cert(
                    vec![certificate.der().clone()],
                    rustls::pki_types::PrivatePkcs8KeyDer::from(key.serialize_der()).into(),
                )
                .unwrap();
        (
            native_tls::Certificate::from_der(issuer.der().as_ref()).unwrap(),
            TlsAcceptor::from(Arc::new(config)),
        )
    }

    #[tokio::test]
    async fn direct_tls_verifies_the_peer_before_requesting_or_sending_plain_credentials() {
        let certificate_host = "desktop.example.test";
        let (ca, acceptor) = tls_peer(certificate_host);
        let username = "desktop-user";
        let password = Uuid::new_v4().to_string();
        for (host, trust_ca, expected) in [
            (certificate_host, false, Err(Failure::Tls)),
            ("other.example.test", true, Err(Failure::Tls)),
            (certificate_host, true, Ok(())),
        ] {
            let expect_success = expected.is_ok();
            let peer_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let peer_address = peer_listener.local_addr().unwrap();
            let (listener, offer, url) = offer().await;
            let credential_requested = Cell::new(false);
            let mut connector = tls_connector_builder();
            if trust_ca {
                connector.add_root_certificate(ca.clone());
            }

            let peer = async {
                let (mut stream, _) = peer_listener.accept().await.unwrap();
                send_vencrypt_offer(&mut stream, &[PLAIN, X509_PLAIN], 1).await;
                let result = acceptor.accept(stream).await;
                if !expect_success {
                    if let Ok(mut stream) = result {
                        assert!(matches!(stream.read(&mut [0u8; 1]).await, Ok(0) | Err(_)));
                    }
                    return;
                }
                let mut stream = result.unwrap();
                assert_eq!(stream.read_u32().await.unwrap() as usize, username.len());
                assert_eq!(stream.read_u32().await.unwrap() as usize, password.len());
                let mut credentials = vec![0; username.len() + password.len()];
                stream.read_exact(&mut credentials).await.unwrap();
                assert_eq!(&credentials[..username.len()], username.as_bytes());
                assert_eq!(&credentials[username.len()..], password.as_bytes());
                stream.write_u32(0).await.unwrap();
                stream.flush().await.unwrap();
            };
            let bridge = async {
                let mut viewer = accept_viewer(listener, offer).await.unwrap();
                let stream = TcpStream::connect(peer_address).await.unwrap();
                let linked_password = async {
                    credential_requested.set(true);
                    Some(Zeroizing::new(password.clone()))
                };
                let result = prepare(
                    &mut viewer,
                    stream,
                    host,
                    username,
                    connector,
                    linked_password,
                )
                .await;
                assert_eq!(
                    result.map(|_| ()),
                    expected,
                    "host {host}, trusted {trust_ca}"
                );
            };
            let viewer = async {
                let mut viewer = connect(&url).await;
                if !expect_success {
                    assert!(!matches!(viewer.next().await, Some(Ok(Message::Binary(_)))));
                    return;
                }
                assert_eq!(viewer_data(&mut viewer).await, RFB_38);
                viewer.send(Message::binary(RFB_38.to_vec())).await.unwrap();
                assert_eq!(viewer_data(&mut viewer).await, [1, 1]);
                viewer.send(Message::binary(vec![1])).await.unwrap();
                assert_eq!(viewer_data(&mut viewer).await, [0; 4]);
            };
            timeout(NEGOTIATION_TIMEOUT, async {
                tokio::join!(peer, bridge, viewer);
            })
            .await
            .expect("loopback TLS fixture did not finish");
            assert_eq!(credential_requested.get(), expect_success);
        }
    }
}
