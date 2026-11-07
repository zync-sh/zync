//! Binary WebSocket transport for the bundled VNC renderer.

use futures_util::{SinkExt, StreamExt};
use std::{net::SocketAddr, time::Duration};
use tokio::{
    io::{self, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::{timeout, timeout_at, Instant},
};
use tokio_tungstenite::{
    accept_hdr_async_with_config,
    tungstenite::{
        handshake::server::{ErrorResponse, Request, Response},
        http::{header, HeaderMap, HeaderName, StatusCode},
        protocol::{Message, WebSocketConfig},
    },
    WebSocketStream,
};
use uuid::Uuid;

const OFFER_LIFETIME: Duration = Duration::from_secs(15);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_HANDSHAKES: usize = 8;
const CHUNK_BYTES: usize = 16 * 1024;
pub(super) const MAX_VIEWER_MESSAGE_BYTES: usize = 64 * 1024;
pub(super) const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) type Viewer = WebSocketStream<TcpStream>;

/// A per-listener capability that authorizes exactly one upgrade from the app origin.
pub(super) struct Offer {
    host: String,
    origin: String,
    path: String,
    expires: Instant,
}

impl Offer {
    /// Mint a token separate from the IPC session identifier and tie it to the bound authority.
    pub(super) fn new(address: SocketAddr, origin: String) -> Self {
        Self {
            host: address.to_string(),
            origin,
            path: format!("/vnc/{}", Uuid::new_v4().simple()),
            expires: Instant::now() + OFFER_LIFETIME,
        }
    }

    /// Return the local URL to the requesting renderer as a short-lived capability.
    pub(super) fn websocket_url(&self) -> String {
        format!("ws://{}{}", self.host, self.path)
    }

    /// Reject cross-origin or replayed requests before any remote channel is opened.
    fn authorize(&self, request: &Request, response: Response) -> Result<Response, ErrorResponse> {
        if Instant::now() >= self.expires
            || request.uri().authority().is_some()
            || request.uri().path_and_query().map(|route| route.as_str())
                != Some(self.path.as_str())
            || !header_is(request.headers(), header::ORIGIN, &self.origin)
            || !header_is(request.headers(), header::HOST, &self.host)
        {
            let mut response = ErrorResponse::new(None);
            *response.status_mut() = StatusCode::FORBIDDEN;
            return Err(response);
        }
        Ok(response)
    }
}

/// Duplicate Origin or Host headers are ambiguous even when their first value matches.
fn header_is(headers: &HeaderMap, name: HeaderName, expected: &str) -> bool {
    let all = headers.get_all(name);
    let mut values = all.iter();
    values
        .next()
        .is_some_and(|value| value.as_bytes() == expected.as_bytes())
        && values.next().is_none()
}

/// Own the listener until the first authorized upgrade. Dropping it consumes the offer.
pub(super) async fn accept_viewer(
    listener: TcpListener,
    offer: Offer,
) -> Result<Viewer, &'static str> {
    let handshake = async {
        let config = WebSocketConfig::default()
            .read_buffer_size(CHUNK_BYTES)
            .write_buffer_size(0)
            .max_write_buffer_size(CHUNK_BYTES * 2)
            .max_message_size(Some(MAX_VIEWER_MESSAGE_BYTES))
            .max_frame_size(Some(MAX_VIEWER_MESSAGE_BYTES));
        for _ in 0..MAX_HANDSHAKES {
            let (socket, _) = listener
                .accept()
                .await
                .map_err(|_| "VNC listener failed.")?;
            let _ = socket.set_nodelay(true);
            let upgraded = timeout(
                HANDSHAKE_TIMEOUT,
                accept_hdr_async_with_config(
                    socket,
                    |request: &Request, response| offer.authorize(request, response),
                    Some(config),
                ),
            )
            .await;
            if let Ok(Ok(viewer)) = upgraded {
                return Ok(viewer);
            }
        }
        Err("VNC viewer authorization failed.")
    };
    timeout_at(offer.expires, handshake)
        .await
        .map_err(|_| "VNC viewer authorization expired.")?
}

/// Relay both directions independently with backpressure and no application message queue.
pub(super) async fn relay<S>(viewer: &mut Viewer, stream: S) -> Result<(), &'static str>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (mut viewer_write, mut viewer_read) = viewer.split();
    let (mut remote_read, mut remote_write) = io::split(stream);
    let to_remote = async {
        while let Some(message) = viewer_read.next().await {
            match message.map_err(|_| "Invalid VNC viewer frame.")? {
                Message::Binary(bytes) => {
                    timeout(WRITE_TIMEOUT, remote_write.write_all(&bytes))
                        .await
                        .map_err(|_| "Timed out sending VNC input to the server.")?
                        .map_err(|_| "Could not send VNC input to the server.")?;
                }
                Message::Close(_) => break,
                Message::Ping(_) | Message::Pong(_) => {}
                _ => return Err("VNC viewer messages must be binary."),
            }
        }
        Ok(())
    };
    let to_viewer = async {
        let mut buffer = [0; CHUNK_BYTES];
        loop {
            let count = remote_read
                .read(&mut buffer)
                .await
                .map_err(|_| "Could not read VNC data from the server.")?;
            if count == 0 {
                return Ok(());
            }
            timeout(
                WRITE_TIMEOUT,
                viewer_write.send(Message::binary(buffer[..count].to_vec())),
            )
            .await
            .map_err(|_| "VNC viewer stopped reading.")?
            .map_err(|_| "Could not deliver VNC data to the viewer.")?;
        }
    };
    tokio::select! {
        result = to_remote => result,
        result = to_viewer => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn expired_offer_rejects_an_otherwise_valid_viewer() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut offer = Offer::new(address, "http://tauri.localhost".into());
        offer.expires = Instant::now();
        let request = Request::builder()
            .uri(&offer.path)
            .header(header::ORIGIN, &offer.origin)
            .header(header::HOST, &offer.host)
            .body(())
            .unwrap();
        assert_eq!(
            offer
                .authorize(&request, Response::new(()))
                .unwrap_err()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert!(matches!(
            accept_viewer(listener, offer).await,
            Err("VNC viewer authorization expired.")
        ));
        assert!(TcpStream::connect(address).await.is_err());
    }
}
