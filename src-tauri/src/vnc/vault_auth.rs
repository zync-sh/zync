//! Optional native RFB 3.8 authentication for a Vault-linked standalone profile.

use super::{
    bridge::{close_with_reason, relay, Viewer},
    rfb::{finish_viewer_auth, read_viewer, send_viewer, RFB_38},
    SshRoute, SSH_LOOPBACK,
};
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
use serde::Deserialize;
use serde_json::Value;
use std::{future::Future, time::Duration};
use tauri::{AppHandle, Manager};
use tokio::{
    io::{self, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::Mutex,
    time::timeout,
};
use zeroize::Zeroizing;

#[cfg(test)]
mod tests;

const SECURITY_VNC: u8 = 2;
const AUTH_TIMEOUT: Duration = Duration::from_secs(8);
const VAULT_WAIT: Duration = Duration::from_secs(1);

type VncKey = Zeroizing<[u8; 8]>;

/// Bind the selected endpoint to an exact saved profile and stable Vault identity.
pub(super) struct VaultLink {
    app: AppHandle,
    profile_id: String,
    credential_id: String,
    host: String,
    port: u16,
    ssh: Option<SshRoute>,
    tls_username: Option<String>,
}

impl VaultLink {
    /// Capture only the persisted reference at admission, before opening any remote socket.
    pub(super) fn bind(
        app: AppHandle,
        profile_id: String,
        host: &str,
        port: u16,
        tls_username: Option<&str>,
    ) -> Option<Self> {
        let settings = tokio::task::block_in_place(|| read_effective_settings(&app)).ok()?;
        let profile = saved_profile(&settings, &profile_id, host, port, None, tls_username)?;
        let credential_id = saved_credential_id(profile)?.into();
        Some(Self {
            app,
            profile_id,
            credential_id,
            host: host.into(),
            port,
            ssh: None,
            tls_username: tls_username.map(str::to_owned),
        })
    }

    /// Require the saved route even for a manual password attempt.
    pub(super) fn bind_ssh(
        app: AppHandle,
        profile_id: String,
        port: u16,
        route: &SshRoute,
        use_vault: bool,
    ) -> Result<Option<Self>, &'static str> {
        let settings = tokio::task::block_in_place(|| read_effective_settings(&app))
            .map_err(|_| "Could not read the saved VNC profile.")?;
        let profile = saved_profile(
            &settings,
            &profile_id,
            SSH_LOOPBACK,
            port,
            Some(route),
            None,
        )
        .ok_or("The saved VNC route changed. Review the profile and try again.")?;
        if !use_vault {
            return Ok(None);
        }
        let credential_id = saved_credential_id(profile)
            .ok_or("The saved VNC password link changed. Review the profile and try again.")?;
        Ok(Some(Self {
            app,
            profile_id,
            credential_id: credential_id.into(),
            host: SSH_LOOPBACK.into(),
            port,
            ssh: Some(route.clone()),
            tls_username: None,
        }))
    }

    /// Recheck the route and return the password only to the selected native auth path.
    pub(super) async fn credential<T>(self, prepare: impl FnOnce(&str) -> T) -> Option<T> {
        let vault = self.app.try_state::<Mutex<VaultService>>()?;
        let vault = timeout(VAULT_WAIT, vault.lock()).await.ok()?;
        tokio::task::block_in_place(|| {
            let settings = read_effective_settings(&self.app).ok()?;
            let profile = saved_profile(
                &settings,
                &self.profile_id,
                &self.host,
                self.port,
                self.ssh.as_ref(),
                self.tls_username.as_deref(),
            )?;
            let credential_id = saved_credential_id(profile)?;
            if credential_id != self.credential_id {
                return None;
            }
            linked_password(&vault, credential_id, prepare)
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

/// Match a unique persisted profile to the exact endpoint and transport.
fn saved_profile<'a>(
    settings: &'a Value,
    profile_id: &str,
    host: &str,
    port: u16,
    ssh: Option<&SshRoute>,
    tls_username: Option<&str>,
) -> Option<&'a Value> {
    if !profile_id_is_valid(profile_id) {
        return None;
    }
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
    match (profile.get("tlsUsername"), tls_username) {
        (None, None) => {}
        (Some(saved), Some(username)) if saved.as_str() == Some(username) => {}
        _ => return None,
    }
    match (profile.get("ssh"), ssh) {
        (None, None) => Some(profile),
        (Some(saved), Some(route)) => {
            let saved = SshRoute::deserialize(saved).ok()?;
            (&saved == route).then_some(profile)
        }
        _ => None,
    }
}

/// Accept only the bounded logical ID of a stored password.
fn saved_credential_id(profile: &Value) -> Option<&str> {
    let id = profile["credentialId"].as_str()?;
    let (first, rest) = id.as_bytes().split_first()?;
    (id.len() <= 128
        && first.is_ascii_alphanumeric()
        && rest
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')))
    .then_some(id)
}

/// Complete optional native password authentication before relaying either transport.
pub(super) async fn relay_with_vault<S>(
    viewer: &mut Viewer,
    mut stream: S,
    link: Option<VaultLink>,
) -> Result<(), &'static str>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    if let Some(link) = link {
        if let Err(failure) = negotiate(viewer, &mut stream, link.credential(password_key)).await {
            return Err(close_with_reason(viewer, failure.reason()).await);
        }
    }
    relay(viewer, stream).await
}

/// Prepare the authentication value from the linked password while the Vault record is in scope.
fn linked_password<T>(
    vault: &VaultService,
    credential_id: &str,
    prepare: impl FnOnce(&str) -> T,
) -> Option<T> {
    let record = vault.item_get_by_logical_id(credential_id).ok()?;
    if record.kind != PASSWORD_STORAGE_KIND {
        return None;
    }
    let password = record.secret_values.get(PASSWORD_FIELD)?;
    (!password.is_empty()).then(|| prepare(password))
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
        return send_viewer(viewer, offer).await.map_err(Failure::from);
    }
    let Some(key) = key.await else {
        return send_viewer(viewer, offer).await.map_err(Failure::from);
    };

    authenticate_remote(remote, key).await?;
    // Only the authorized local WebSocket gets this synthetic result after real remote auth.
    finish_viewer_auth(viewer, &mut pending, remote).await?;
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
