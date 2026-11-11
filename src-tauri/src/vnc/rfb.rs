//! Shared framing for native RFB authentication and the authorized local viewer.

use super::bridge::Viewer;
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio::io::{self, AsyncWrite, AsyncWriteExt};
use tokio_tungstenite::tungstenite::protocol::Message;

pub(super) const RFB_38: [u8; 12] = *b"RFB 003.008\n";
const SECURITY_NONE: u8 = 1;

/// Read a handshake field across WebSocket messages while preserving the binary tail.
pub(super) async fn read_viewer<const N: usize>(
    viewer: &mut Viewer,
    pending: &mut Bytes,
) -> io::Result<[u8; N]> {
    let mut bytes = [0; N];
    let mut written = 0;
    while written < N {
        if pending.is_empty() {
            match viewer.next().await {
                Some(Ok(Message::Binary(chunk))) => *pending = chunk,
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                _ => return Err(io::ErrorKind::InvalidData.into()),
            }
        }
        let count = pending.len().min(N - written);
        bytes[written..written + count].copy_from_slice(&pending.split_to(count));
        written += count;
    }
    Ok(bytes)
}

/// Send staged RFB bytes over the authorized local WebSocket.
pub(super) async fn send_viewer(viewer: &mut Viewer, bytes: &[u8]) -> io::Result<()> {
    viewer
        .send(Message::binary(bytes.to_vec()))
        .await
        .map_err(|_| io::ErrorKind::BrokenPipe.into())
}

/// Signal local success after the native bridge has authenticated to the remote server.
pub(super) async fn finish_viewer_auth(
    viewer: &mut Viewer,
    pending: &mut Bytes,
    remote: &mut (impl AsyncWrite + Unpin),
) -> io::Result<()> {
    send_viewer(viewer, &[1, SECURITY_NONE]).await?;
    if read_viewer::<1>(viewer, pending).await? != [SECURITY_NONE] {
        return Err(io::ErrorKind::InvalidData.into());
    }
    send_viewer(viewer, &[0; 4]).await?;
    remote.write_all(pending).await
}
