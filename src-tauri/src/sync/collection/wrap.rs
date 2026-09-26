use super::super::types::{
    Base64EncodedData, SyncCollectionManifest, SyncError, SyncKeyPolicyMode, SyncResult,
};
use crate::vault::crypto::{
    decrypt_record, derive_kek, encrypt_record, generate_salt, EncryptedEnvelope, KdfParams,
};
use base64::Engine;
use rand_core::RngCore;

const SYNC_COLLECTION_KEY_WRAP_AAD_VERSION: u32 = 1;
const SYNC_COLLECTION_KEY_BYTES: usize = 32;
pub(super) const SYNC_RECOVERY_KEY_PREFIX: &str = "zync-sync-rk1";

/// Remote-recoverable key wrap blob stored on the provider (Drive).
/// Lets the user re-enter their passphrase after a local wipe and recover the
/// same collection key that encrypted host files — without needing OS keychain.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCollectionKeyWrapV1 {
    pub version: u32,
    pub provider: String,
    pub sync_collection_id: String,
    pub key_policy_mode: SyncKeyPolicyMode,
    pub key_wrap_salt: String,
    pub key_wrap_nonce: String,
    pub key_wrap_ciphertext: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_key_wrap_salt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_key_wrap_nonce: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_key_wrap_ciphertext: Option<String>,
}

pub const REMOTE_KEY_WRAP_VERSION: u32 = 1;

pub fn collection_key_wrap_object_name(sync_collection_id: &str) -> String {
    format!("zync-sync-{sync_collection_id}-collection-keywrap.zkey")
}

pub fn remote_key_wrap_from_manifest(
    manifest: &SyncCollectionManifest,
) -> Option<RemoteCollectionKeyWrapV1> {
    let (recovery_salt, recovery_nonce, recovery_ciphertext) = if has_recovery_key_slot(manifest) {
        (
            manifest
                .recovery_key_wrap_salt
                .as_ref()
                .map(|v| v.as_str().to_string()),
            manifest
                .recovery_key_wrap_nonce
                .as_ref()
                .map(|v| v.as_str().to_string()),
            manifest
                .recovery_key_wrap_ciphertext
                .as_ref()
                .map(|v| v.as_str().to_string()),
        )
    } else {
        (None, None, None)
    };

    Some(RemoteCollectionKeyWrapV1 {
        version: REMOTE_KEY_WRAP_VERSION,
        provider: manifest.provider.clone(),
        sync_collection_id: manifest.sync_collection_id.clone(),
        key_policy_mode: manifest.key_policy_mode,
        key_wrap_salt: manifest.key_wrap_salt.as_ref()?.as_str().to_string(),
        key_wrap_nonce: manifest.key_wrap_nonce.as_ref()?.as_str().to_string(),
        key_wrap_ciphertext: manifest.key_wrap_ciphertext.as_ref()?.as_str().to_string(),
        recovery_key_wrap_salt: recovery_salt,
        recovery_key_wrap_nonce: recovery_nonce,
        recovery_key_wrap_ciphertext: recovery_ciphertext,
    })
}

pub fn apply_remote_key_wrap_to_manifest(
    manifest: &mut SyncCollectionManifest,
    wrap: &RemoteCollectionKeyWrapV1,
) -> SyncResult<()> {
    if wrap.version != REMOTE_KEY_WRAP_VERSION {
        return Err(SyncError::new(
            "sync_collection_key_wrap_version_unsupported",
            format!(
                "Remote key wrap version {} is not supported (expected {}).",
                wrap.version, REMOTE_KEY_WRAP_VERSION
            ),
        ));
    }
    if wrap.provider != manifest.provider {
        return Err(SyncError::new(
            "sync_collection_key_wrap_mismatch",
            "Remote key wrap belongs to a different provider.",
        ));
    }
    if wrap.sync_collection_id != manifest.sync_collection_id {
        return Err(SyncError::new(
            "sync_collection_key_wrap_mismatch",
            "Remote key wrap belongs to a different sync collection.",
        ));
    }

    let key_wrap_salt = base64_data(wrap.key_wrap_salt.clone())?;
    let key_wrap_nonce = base64_nonce_data(wrap.key_wrap_nonce.clone(), "key wrap nonce")?;
    let key_wrap_ciphertext = base64_data(wrap.key_wrap_ciphertext.clone())?;

    let recovery_slot = match (
        wrap.recovery_key_wrap_salt.clone(),
        wrap.recovery_key_wrap_nonce.clone(),
        wrap.recovery_key_wrap_ciphertext.clone(),
    ) {
        (Some(salt), Some(nonce), Some(ciphertext)) => {
            let r_salt = base64_data(salt)?;
            let r_nonce = base64_nonce_data(nonce, "recovery key wrap nonce")?;
            let r_ciphertext = base64_data(ciphertext)?;
            Some((r_salt, r_nonce, r_ciphertext))
        }
        (None, None, None) => None,
        _ => {
            return Err(SyncError::new(
                "sync_collection_key_wrap_invalid",
                "Remote key wrap contains an incomplete recovery key wrap slot.",
            ));
        }
    };

    manifest.key_policy_mode = wrap.key_policy_mode;
    manifest.key_wrap_salt = Some(key_wrap_salt);
    manifest.key_wrap_nonce = Some(key_wrap_nonce);
    manifest.key_wrap_ciphertext = Some(key_wrap_ciphertext);

    if let Some((salt, nonce, ciphertext)) = recovery_slot {
        manifest.recovery_key_wrap_salt = Some(salt);
        manifest.recovery_key_wrap_nonce = Some(nonce);
        manifest.recovery_key_wrap_ciphertext = Some(ciphertext);
        manifest.has_recovery_key = true;
    } else {
        manifest.recovery_key_wrap_salt = None;
        manifest.recovery_key_wrap_nonce = None;
        manifest.recovery_key_wrap_ciphertext = None;
        manifest.has_recovery_key = false;
    }

    Ok(())
}

pub fn has_recovery_key_slot(manifest: &SyncCollectionManifest) -> bool {
    manifest.has_recovery_key
        && manifest.recovery_key_wrap_salt.is_some()
        && manifest.recovery_key_wrap_nonce.is_some()
        && manifest.recovery_key_wrap_ciphertext.is_some()
}

pub(super) fn generate_collection_key() -> [u8; 32] {
    let mut key = [0u8; SYNC_COLLECTION_KEY_BYTES];
    rand_core::OsRng.fill_bytes(&mut key);
    key
}

pub(super) fn base64_data(value: String) -> SyncResult<Base64EncodedData> {
    Base64EncodedData::try_from(value).map_err(|e| {
        SyncError::new(
            "sync_collection_write_failed",
            format!("Invalid base64 payload produced for sync collection manifest: {e}"),
        )
    })
}

pub(super) fn base64_nonce_data(value: String, field_name: &str) -> SyncResult<Base64EncodedData> {
    let data = base64_data(value)?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(data.as_str())
        .map_err(|e| {
            SyncError::new(
                "sync_collection_write_failed",
                format!("Invalid base64 payload produced for sync collection manifest: {e}"),
            )
        })?;
    if decoded.len() != 24 {
        return Err(SyncError::new(
            "sync_collection_key_wrap_invalid",
            format!(
                "Remote key wrap contains an invalid {field_name} length (expected 24 bytes, got {}).",
                decoded.len()
            ),
        ));
    }
    Ok(data)
}

fn key_policy_mode_tag(mode: SyncKeyPolicyMode) -> &'static str {
    match mode {
        SyncKeyPolicyMode::LocalPassphrase => "local-passphrase",
        SyncKeyPolicyMode::CustomPassphrase => "custom-passphrase",
    }
}

fn key_wrap_aad(manifest: &SyncCollectionManifest) -> String {
    format!(
        "zync:sync-collection-key:v{}|provider:{}|collection:{}|mode:{}",
        SYNC_COLLECTION_KEY_WRAP_AAD_VERSION,
        manifest.provider.to_ascii_lowercase(),
        manifest.sync_collection_id,
        key_policy_mode_tag(manifest.key_policy_mode)
    )
}

pub(super) fn recovery_key_wrap_aad(manifest: &SyncCollectionManifest) -> String {
    format!(
        "zync:sync-collection-key:v{}|provider:{}|collection:{}|slot:recovery",
        SYNC_COLLECTION_KEY_WRAP_AAD_VERSION,
        manifest.provider.to_ascii_lowercase(),
        manifest.sync_collection_id
    )
}

pub(super) fn wrap_collection_key(
    manifest: &SyncCollectionManifest,
    collection_key: &[u8; 32],
    passphrase: &str,
) -> SyncResult<(String, String, String)> {
    wrap_collection_key_with_secret(
        collection_key,
        passphrase.as_bytes(),
        &key_wrap_aad(manifest),
    )
}

pub(super) fn wrap_collection_key_with_secret(
    collection_key: &[u8; 32],
    secret: &[u8],
    aad: &str,
) -> SyncResult<(String, String, String)> {
    let salt = generate_salt();
    let kek = derive_kek(secret, &salt, &KdfParams::default_production()).map_err(|e| {
        SyncError::new(
            "sync_collection_key_wrap_failed",
            format!("Failed to derive sync key wrap key: {e}"),
        )
    })?;
    let envelope = encrypt_record(&kek, collection_key, aad.as_bytes()).map_err(|e| {
        SyncError::new(
            "sync_collection_key_wrap_failed",
            format!("Failed to encrypt sync collection key: {e}"),
        )
    })?;

    Ok((
        base64::engine::general_purpose::STANDARD.encode(salt),
        base64::engine::general_purpose::STANDARD.encode(envelope.nonce),
        base64::engine::general_purpose::STANDARD.encode(envelope.ciphertext),
    ))
}

pub(super) fn unwrap_collection_key_trying_modes(
    manifest: &SyncCollectionManifest,
    passphrase: &str,
) -> SyncResult<[u8; 32]> {
    match unwrap_collection_key(manifest, passphrase) {
        Ok(key) => Ok(key),
        Err(first_error) => {
            let other_mode = match manifest.key_policy_mode {
                SyncKeyPolicyMode::LocalPassphrase => SyncKeyPolicyMode::CustomPassphrase,
                SyncKeyPolicyMode::CustomPassphrase => SyncKeyPolicyMode::LocalPassphrase,
            };
            let mut alt = manifest.clone();
            alt.key_policy_mode = other_mode;
            unwrap_collection_key(&alt, passphrase).or(Err(first_error))
        }
    }
}

pub(super) fn unwrap_collection_key(
    manifest: &SyncCollectionManifest,
    passphrase: &str,
) -> SyncResult<[u8; 32]> {
    let salt = manifest
        .key_wrap_salt
        .as_ref()
        .map(Base64EncodedData::as_str)
        .ok_or_else(|| {
            SyncError::new(
                "sync_collection_key_unwrap_failed",
                "Missing wrapped key salt",
            )
        })?;
    let nonce = manifest
        .key_wrap_nonce
        .as_ref()
        .map(Base64EncodedData::as_str)
        .ok_or_else(|| {
            SyncError::new(
                "sync_collection_key_unwrap_failed",
                "Missing wrapped key nonce",
            )
        })?;
    let ciphertext = manifest
        .key_wrap_ciphertext
        .as_ref()
        .map(Base64EncodedData::as_str)
        .ok_or_else(|| {
            SyncError::new(
                "sync_collection_key_unwrap_failed",
                "Missing wrapped key ciphertext",
            )
        })?;

    let salt_bytes = base64::engine::general_purpose::STANDARD
        .decode(salt)
        .map_err(|e| {
            SyncError::new(
                "sync_collection_key_unwrap_failed",
                format!("Invalid wrapped key salt: {e}"),
            )
        })?;
    let kek = derive_kek(
        passphrase.as_bytes(),
        &salt_bytes,
        &KdfParams::default_production(),
    )
    .map_err(|e| {
        SyncError::new(
            "sync_collection_key_unwrap_failed",
            format!("Failed to derive wrapped-key KEK: {e}"),
        )
    })?;

    let nonce_bytes = base64::engine::general_purpose::STANDARD
        .decode(nonce)
        .map_err(|e| {
            SyncError::new(
                "sync_collection_key_unwrap_failed",
                format!("Invalid wrapped key nonce: {e}"),
            )
        })?;
    let nonce_arr: [u8; 24] = nonce_bytes.as_slice().try_into().map_err(|_| {
        SyncError::new(
            "sync_collection_key_unwrap_failed",
            "Invalid wrapped key nonce size",
        )
    })?;

    let ciphertext_bytes = base64::engine::general_purpose::STANDARD
        .decode(ciphertext)
        .map_err(|e| {
            SyncError::new(
                "sync_collection_key_unwrap_failed",
                format!("Invalid wrapped key ciphertext: {e}"),
            )
        })?;

    let envelope = EncryptedEnvelope {
        nonce: nonce_arr,
        ciphertext: ciphertext_bytes,
    };
    let aad = key_wrap_aad(manifest);
    let key_bytes = decrypt_record(&kek, &envelope, aad.as_bytes()).map_err(|_| {
        SyncError::new(
            "sync_collection_key_unwrap_failed",
            "Sync passphrase is incorrect for this provider sync key.",
        )
    })?;

    let key: [u8; 32] = key_bytes.as_slice().try_into().map_err(|_| {
        SyncError::new(
            "sync_collection_key_unwrap_failed",
            "Invalid decrypted sync collection key length",
        )
    })?;
    Ok(key)
}

pub(super) fn unwrap_collection_key_with_recovery_key(
    manifest: &SyncCollectionManifest,
    recovery_key: &str,
) -> SyncResult<[u8; 32]> {
    let recovery_key_bytes = parse_recovery_key(recovery_key).ok_or_else(|| {
        SyncError::new(
            "sync_collection_recovery_key_invalid",
            "Provider sync recovery key is not in a valid Zync format.",
        )
    })?;
    let salt = manifest
        .recovery_key_wrap_salt
        .as_ref()
        .map(Base64EncodedData::as_str)
        .ok_or_else(|| {
            SyncError::new(
                "sync_collection_recovery_key_missing",
                "This provider sync collection has no recovery key slot.",
            )
        })?;
    let nonce = manifest
        .recovery_key_wrap_nonce
        .as_ref()
        .map(Base64EncodedData::as_str)
        .ok_or_else(|| {
            SyncError::new(
                "sync_collection_recovery_key_missing",
                "This provider sync collection has no recovery key nonce.",
            )
        })?;
    let ciphertext = manifest
        .recovery_key_wrap_ciphertext
        .as_ref()
        .map(Base64EncodedData::as_str)
        .ok_or_else(|| {
            SyncError::new(
                "sync_collection_recovery_key_missing",
                "This provider sync collection has no recovery key ciphertext.",
            )
        })?;

    let salt_bytes = base64::engine::general_purpose::STANDARD
        .decode(salt)
        .map_err(|e| {
            SyncError::new(
                "sync_collection_recovery_key_unwrap_failed",
                format!("Invalid recovery key salt: {e}"),
            )
        })?;
    let kek = derive_kek(
        &recovery_key_bytes,
        &salt_bytes,
        &KdfParams::default_production(),
    )
    .map_err(|e| {
        SyncError::new(
            "sync_collection_recovery_key_unwrap_failed",
            format!("Failed to derive recovery-key KEK: {e}"),
        )
    })?;

    let nonce_bytes = base64::engine::general_purpose::STANDARD
        .decode(nonce)
        .map_err(|e| {
            SyncError::new(
                "sync_collection_recovery_key_unwrap_failed",
                format!("Invalid recovery key nonce: {e}"),
            )
        })?;
    let nonce_arr: [u8; 24] = nonce_bytes.as_slice().try_into().map_err(|_| {
        SyncError::new(
            "sync_collection_recovery_key_unwrap_failed",
            "Invalid recovery key nonce size",
        )
    })?;
    let ciphertext_bytes = base64::engine::general_purpose::STANDARD
        .decode(ciphertext)
        .map_err(|e| {
            SyncError::new(
                "sync_collection_recovery_key_unwrap_failed",
                format!("Invalid recovery key ciphertext: {e}"),
            )
        })?;
    let envelope = EncryptedEnvelope {
        nonce: nonce_arr,
        ciphertext: ciphertext_bytes,
    };
    let aad = recovery_key_wrap_aad(manifest);
    let key_bytes = decrypt_record(&kek, &envelope, aad.as_bytes()).map_err(|_| {
        SyncError::new(
            "sync_collection_recovery_key_unwrap_failed",
            "Provider sync recovery key is incorrect for this collection.",
        )
    })?;
    let key: [u8; 32] = key_bytes.as_slice().try_into().map_err(|_| {
        SyncError::new(
            "sync_collection_recovery_key_unwrap_failed",
            "Invalid decrypted sync collection key length",
        )
    })?;
    Ok(key)
}

pub(super) fn generate_recovery_key() -> (String, [u8; 32]) {
    let mut bytes = [0u8; 32];
    rand_core::OsRng.fill_bytes(&mut bytes);
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    let grouped = encoded
        .as_bytes()
        .chunks(4)
        .map(|chunk| std::str::from_utf8(chunk).unwrap_or_default())
        .collect::<Vec<_>>()
        .join("-");
    (format!("{SYNC_RECOVERY_KEY_PREFIX}-{grouped}"), bytes)
}

pub(super) fn parse_recovery_key(value: &str) -> Option<[u8; 32]> {
    let normalized = value.trim();
    let prefix = format!("{SYNC_RECOVERY_KEY_PREFIX}-");
    if let Some(body) = normalized.strip_prefix(&prefix) {
        return decode_grouped_recovery_key(body).or_else(|| decode_recovery_key_bytes(body));
    }

    decode_recovery_key_bytes(normalized).or_else(|| decode_grouped_recovery_key(normalized))
}

fn decode_grouped_recovery_key(grouped: &str) -> Option<[u8; 32]> {
    let chars: Vec<char> = grouped.chars().collect();
    let mut encoded = String::with_capacity(chars.len());
    let mut index = 0usize;
    while index < chars.len() {
        let remaining = chars.len().saturating_sub(index);
        let group_len = remaining.min(4);
        encoded.extend(chars[index..index + group_len].iter());
        index += group_len;
        if index < chars.len() {
            if chars[index] != '-' {
                return None;
            }
            index += 1;
        }
    }
    decode_recovery_key_bytes(&encoded)
}

fn decode_recovery_key_bytes(encoded: &str) -> Option<[u8; 32]> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .ok()?;
    bytes.as_slice().try_into().ok()
}
