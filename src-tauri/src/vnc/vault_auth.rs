//! Optional native RFB 3.8 authentication for a Vault-linked standalone profile.

use super::bridge::Viewer;
use crate::{
    commands::read_effective_settings,
    vault::{
        credential::{PASSWORD_FIELD, PASSWORD_STORAGE_KIND},
        store::VaultService,
    },
};
use bytes::Bytes;
use des::{
    cipher::{BlockCipherEncrypt, KeyInit},
    Des,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::{future::Future, time::Duration};
use tauri::{AppHandle, Manager};
use tokio::{
    io::{self, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::Mutex,
    time::timeout,
};
use tokio_tungstenite::tungstenite::protocol::Message;
use zeroize::Zeroizing;

#[cfg(test)]
mod tests;

const RFB_38: [u8; 12] = *b"RFB 003.008\n";
const SECURITY_NONE: u8 = 1;
const SECURITY_VNC: u8 = 2;
const AUTH_TIMEOUT: Duration = Duration::from_secs(8);
const VAULT_WAIT: Duration = Duration::from_secs(1);

type VncKey = Zeroizing<[u8; 8]>;

/// Bind the selected endpoint to an exact saved profile and stable Vault identity.
pub(super) struct VaultLink {
    app: AppHandle,
    profile_id: String,
    credential_id: String,
}

impl VaultLink {
    /// Capture only the persisted reference at admission, before opening any remote socket.
    pub(super) fn bind(app: AppHandle, profile_id: String, host: &str, port: u16) -> Option<Self> {
        if !profile_id_is_valid(&profile_id) {
            return None;
        }
        let settings = tokio::task::block_in_place(|| read_effective_settings(&app)).ok()?;
        let credential_id = saved_credential_id(&settings, &profile_id, host, port)?.into();
        Some(Self {
            app,
            profile_id,
            credential_id,
        })
    }

    /// Recheck the endpoint and reference when the server actually selects the Vault path.
    pub(super) async fn key(self, host: &str, port: u16) -> Option<VncKey> {
        let vault = self.app.try_state::<Mutex<VaultService>>()?;
        let vault = timeout(VAULT_WAIT, vault.lock()).await.ok()?;
        tokio::task::block_in_place(|| {
            let settings = read_effective_settings(&self.app).ok()?;
            let credential_id = saved_credential_id(&settings, &self.profile_id, host, port)?;
            if credential_id != self.credential_id {
                return None;
            }
            linked_key(&vault, credential_id)
        })
    }
}

/// Match the renderer's bounded saved-profile token grammar.
fn profile_id_is_valid(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

/// Reject ambiguous profile IDs, nonexact destinations, and invalid Vault references.
fn saved_credential_id<'a>(
    settings: &'a Value,
    profile_id: &str,
    host: &str,
    port: u16,
) -> Option<&'a str> {
    let mut profiles = settings["vncProfiles"]
        .as_array()?
        .iter()
        .filter(|profile| profile["id"].as_str() == Some(profile_id));
    let profile = profiles.next()?;
    if profiles.next().is_some()
        || profile["host"].as_str() != Some(host)
        || profile["port"].as_u64() != Some(u64::from(port))
    {
        return None;
    }
    let id = profile["credentialId"].as_str()?;
    let (first, rest) = id.as_bytes().split_first()?;
    (id.len() <= 128
        && first.is_ascii_alphanumeric()
        && rest
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')))
    .then_some(id)
}

/// Decrypt only the linked password and drop its plaintext before waiting for a challenge.
fn linked_key(vault: &VaultService, credential_id: &str) -> Option<VncKey> {
    let record = vault.item_get_by_logical_id(credential_id).ok()?;
    if record.kind != PASSWORD_STORAGE_KIND {
        return None;
    }
    let password = record.secret_values.get(PASSWORD_FIELD)?;
    (!password.is_empty()).then(|| password_key(password))
}

/// Match the bundled viewer's first eight UTF-16 code units, low byte and reversed bits.
fn password_key(password: &str) -> VncKey {
    let mut key = Zeroizing::new([0; 8]);
    for (slot, unit) in key.iter_mut().zip(password.encode_utf16()) {
        *slot = (unit as u8).reverse_bits();
    }
    key
}

/// Remote failures cross IPC only as fixed, application-owned close reasons.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Failure {
    Rejected,
    Protocol,
}

impl Failure {
    /// Distinguish a rejected password from a failed native handshake.
    pub(super) fn reason(self) -> &'static str {
        match self {
            Self::Rejected => "vnc-vault-auth-rejected",
            Self::Protocol => "vnc-vault-auth-failed",
        }
    }
}

impl From<io::Error> for Failure {
    fn from(_: io::Error) -> Self {
        Self::Protocol
    }
}

/// Resolve the key only for the preferred classic scheme and bound the whole staged exchange.
pub(super) async fn negotiate<S>(
    viewer: &mut Viewer,
    remote: &mut S,
    key: impl Future<Output = Option<VncKey>>,
) -> Result<(), Failure>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    timeout(AUTH_TIMEOUT, handshake(viewer, remote, key))
        .await
        .unwrap_or(Err(Failure::Protocol))
}

/// Hand off both streams at the ordinary auth boundary or after native auth succeeds.
async fn handshake<S>(
    viewer: &mut Viewer,
    remote: &mut S,
    key: impl Future<Output = Option<VncKey>>,
) -> Result<(), Failure>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut greeting = [0; RFB_38.len()];
    remote.read_exact(&mut greeting).await?;
    send_viewer(viewer, &greeting).await?;
    if greeting != RFB_38 {
        return Ok(());
    }

    let mut pending = Bytes::new();
    let version = read_viewer::<{ RFB_38.len() }>(viewer, &mut pending).await?;
    remote.write_all(&version).await?;
    // A different version or a pipelined security selection belongs to the normal relay.
    if version != RFB_38 || !pending.is_empty() {
        remote.write_all(&pending).await?;
        return Ok(());
    }

    // The count is one byte. Preserve even zero-offer failure responses for the ordinary viewer.
    let mut security = [0; 256];
    let count = remote.read_u8().await?;
    security[0] = count;
    let offer = &mut security[..=usize::from(count)];
    remote.read_exact(&mut offer[1..]).await?;
    if offer.get(1) != Some(&SECURITY_VNC) {
        return send_viewer(viewer, offer).await;
    }
    let Some(key) = key.await else {
        return send_viewer(viewer, offer).await;
    };

    authenticate_remote(remote, key).await?;
    // Only the authorized local WebSocket gets this synthetic result after real remote auth.
    send_viewer(viewer, &[1, SECURITY_NONE]).await?;
    if read_viewer::<1>(viewer, &mut pending).await? != [SECURITY_NONE] {
        return Err(Failure::Protocol);
    }
    send_viewer(viewer, &[0; 4]).await?;
    remote.write_all(&pending).await?;
    Ok(())
}

/// Answer the legacy two-block DES challenge, then discard the key and response buffers.
async fn authenticate_remote<S: AsyncRead + AsyncWrite + Unpin>(
    remote: &mut S,
    key: VncKey,
) -> Result<(), Failure> {
    remote.write_u8(SECURITY_VNC).await?;
    {
        let mut response = Zeroizing::new([0; 16]);
        remote.read_exact(response.as_mut()).await?;
        encrypt_challenge(key, &mut response);
        remote.write_all(response.as_ref()).await?;
    }
    if remote.read_u32().await? != 0 {
        return Err(Failure::Rejected);
    }
    Ok(())
}

/// Use the standard DES primitive for RFB's required two independent eight-byte blocks.
fn encrypt_challenge(key: VncKey, challenge: &mut [u8; 16]) {
    let cipher = Des::new((&*key).into());
    for block in challenge.as_chunks_mut::<8>().0 {
        cipher.encrypt_block(block.into());
    }
}

/// Read a small handshake field across WebSocket messages, preserving any binary tail.
async fn read_viewer<const N: usize>(
    viewer: &mut Viewer,
    pending: &mut Bytes,
) -> Result<[u8; N], Failure> {
    let mut bytes = [0; N];
    let mut written = 0;
    while written < N {
        if pending.is_empty() {
            match viewer.next().await {
                Some(Ok(Message::Binary(chunk))) => *pending = chunk,
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                _ => return Err(Failure::Protocol),
            }
        }
        let count = pending.len().min(N - written);
        bytes[written..written + count].copy_from_slice(&pending.split_to(count));
        written += count;
    }
    Ok(bytes)
}

/// Send staged protocol bytes over the same authorized binary WebSocket.
async fn send_viewer(viewer: &mut Viewer, bytes: &[u8]) -> Result<(), Failure> {
    viewer
        .send(Message::binary(bytes.to_vec()))
        .await
        .map_err(|_| Failure::Protocol)
}
