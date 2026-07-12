use super::profiles::now_secs;
use super::types::{
    Base64EncodedData, SyncCollectionManifest, SyncError, SyncKeyPolicyMode, SyncProviderKind,
    SyncResult,
};
use crate::vault::crypto::{
    decrypt_record, derive_kek, encrypt_record, generate_salt, EncryptedEnvelope, KdfParams,
};
use base64::Engine;
use rand_core::RngCore;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const SYNC_COLLECTION_VERSION: u32 = 1;
const SYNC_COLLECTION_KEY_WRAP_AAD_VERSION: u32 = 1;
#[cfg(not(test))]
const SYNC_COLLECTION_KEYRING_SERVICE: &str = "Zync Sync Collection Keys";
const SYNC_COLLECTION_KEY_BYTES: usize = 32;
const SYNC_RECOVERY_KEY_PREFIX: &str = "zync-sync-rk1";
pub const SYNC_COLLECTION_KEY_CACHE_TTL_SECS: u64 = 12 * 60 * 60;

#[derive(Debug, Clone)]
pub struct SyncCollectionSetupOutcome {
    pub manifest: SyncCollectionManifest,
    pub recovery_key: Option<String>,
}

fn manifest_path(data_dir: &Path, provider: SyncProviderKind) -> PathBuf {
    data_dir.join(format!("sync-collection-{}.json", provider.as_str()))
}

pub fn load_manifest(
    data_dir: &Path,
    provider: SyncProviderKind,
) -> SyncResult<Option<SyncCollectionManifest>> {
    let path = manifest_path(data_dir, provider);
    if !path.exists() {
        return Ok(None);
    }

    let raw = std::fs::read_to_string(&path).map_err(|e| {
        SyncError::new(
            "sync_collection_read_failed",
            format!("Failed to read sync collection manifest: {e}"),
        )
    })?;

    let mut manifest = serde_json::from_str::<SyncCollectionManifest>(&raw).map_err(|e| {
        SyncError::new(
            "sync_collection_parse_failed",
            format!("Failed to parse sync collection manifest: {e}"),
        )
    })?;

    if manifest.provider.is_empty() {
        manifest.provider = provider.as_str().to_string();
    }

    Ok(Some(manifest))
}

pub fn save_manifest(data_dir: &Path, manifest: &SyncCollectionManifest) -> SyncResult<()> {
    std::fs::create_dir_all(data_dir).map_err(|e| {
        SyncError::new(
            "sync_collection_write_failed",
            format!("Failed to create sync collection dir: {e}"),
        )
    })?;

    let payload = serde_json::to_string_pretty(manifest).map_err(|e| {
        SyncError::new(
            "sync_collection_write_failed",
            format!("Failed to serialize sync collection manifest: {e}"),
        )
    })?;

    let final_path = manifest_path(data_dir, provider_from_str(&manifest.provider)?);
    crate::atomic_io::durable_replace(&final_path, payload.as_bytes()).map_err(|e| {
        SyncError::new(
            "sync_collection_write_failed",
            format!("Failed to write sync collection manifest: {e}"),
        )
    })
}

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

pub fn remote_key_wrap_from_manifest(manifest: &SyncCollectionManifest) -> Option<RemoteCollectionKeyWrapV1> {
    Some(RemoteCollectionKeyWrapV1 {
        version: REMOTE_KEY_WRAP_VERSION,
        provider: manifest.provider.clone(),
        sync_collection_id: manifest.sync_collection_id.clone(),
        key_policy_mode: manifest.key_policy_mode,
        key_wrap_salt: manifest.key_wrap_salt.as_ref()?.as_str().to_string(),
        key_wrap_nonce: manifest.key_wrap_nonce.as_ref()?.as_str().to_string(),
        key_wrap_ciphertext: manifest.key_wrap_ciphertext.as_ref()?.as_str().to_string(),
        recovery_key_wrap_salt: manifest
            .recovery_key_wrap_salt
            .as_ref()
            .map(|v| v.as_str().to_string()),
        recovery_key_wrap_nonce: manifest
            .recovery_key_wrap_nonce
            .as_ref()
            .map(|v| v.as_str().to_string()),
        recovery_key_wrap_ciphertext: manifest
            .recovery_key_wrap_ciphertext
            .as_ref()
            .map(|v| v.as_str().to_string()),
    })
}

pub fn apply_remote_key_wrap_to_manifest(
    manifest: &mut SyncCollectionManifest,
    wrap: &RemoteCollectionKeyWrapV1,
) -> SyncResult<()> {
    if wrap.sync_collection_id != manifest.sync_collection_id {
        return Err(SyncError::new(
            "sync_collection_key_wrap_mismatch",
            "Remote key wrap belongs to a different sync collection.",
        ));
    }
    manifest.key_policy_mode = wrap.key_policy_mode;
    manifest.key_wrap_salt = Some(base64_data(wrap.key_wrap_salt.clone())?);
    manifest.key_wrap_nonce = Some(base64_data(wrap.key_wrap_nonce.clone())?);
    manifest.key_wrap_ciphertext = Some(base64_data(wrap.key_wrap_ciphertext.clone())?);
    if wrap.recovery_key_wrap_salt.is_some()
        && wrap.recovery_key_wrap_nonce.is_some()
        && wrap.recovery_key_wrap_ciphertext.is_some()
    {
        manifest.recovery_key_wrap_salt =
            Some(base64_data(wrap.recovery_key_wrap_salt.clone().unwrap_or_default())?);
        manifest.recovery_key_wrap_nonce =
            Some(base64_data(wrap.recovery_key_wrap_nonce.clone().unwrap_or_default())?);
        manifest.recovery_key_wrap_ciphertext =
            Some(base64_data(wrap.recovery_key_wrap_ciphertext.clone().unwrap_or_default())?);
        manifest.has_recovery_key = true;
    }
    Ok(())
}

pub fn setup_manifest(
    data_dir: &Path,
    provider: SyncProviderKind,
    key_policy_mode: SyncKeyPolicyMode,
    passphrase: &str,
    has_recovery_key: bool,
    preferred_sync_collection_id: Option<String>,
    // When re-linking an existing Drive collection after local wipe, pass the
    // key-wrap blob downloaded from the provider so the passphrase can recover
    // the original collection key.
    remote_key_wrap: Option<RemoteCollectionKeyWrapV1>,
) -> SyncResult<SyncCollectionSetupOutcome> {
    let current = load_manifest(data_dir, provider)?;
    let existing_manifest = current.is_some();
    let original_key_policy_mode = current.as_ref().map(|m| m.key_policy_mode);
    let now = now_secs();

    let mut manifest = match current {
        Some(mut existing) => {
            existing.has_recovery_key = has_recovery_key;
            existing.updated_at = now;
            existing.key_policy_mode = key_policy_mode;
            existing
        }
        None => SyncCollectionManifest {
            version: SYNC_COLLECTION_VERSION,
            provider: provider.as_str().to_string(),
            sync_collection_id: preferred_sync_collection_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| Uuid::new_v4().to_string()),
            key_policy_mode,
            key_wrap_salt: None,
            key_wrap_nonce: None,
            key_wrap_ciphertext: None,
            recovery_key_wrap_salt: None,
            recovery_key_wrap_nonce: None,
            recovery_key_wrap_ciphertext: None,
            key_cache_unlocked_at: None,
            key_cache_ttl_secs: Some(SYNC_COLLECTION_KEY_CACHE_TTL_SECS),
            has_recovery_key,
            created_at: now,
            updated_at: now,
        },
    };

    // Prefer remote wrap (from Drive) when local wrap is missing — this is how
    // passphrase recovery works after a full local reset.
    if manifest.key_wrap_salt.is_none() {
        if let Some(wrap) = remote_key_wrap.as_ref() {
            apply_remote_key_wrap_to_manifest(&mut manifest, wrap)?;
        }
    }

    let account = collection_key_account(&manifest);
    // Linking an existing Drive collection id after local wipe (no wrap metadata yet).
    let linking_existing_remote = !existing_manifest
        && preferred_sync_collection_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some();

    let collection_key = match load_collection_key_secret(&account) {
        Ok(encoded) => decode_collection_key(&encoded)?,
        Err(_) => {
            if manifest.key_wrap_salt.is_some()
                && manifest.key_wrap_nonce.is_some()
                && manifest.key_wrap_ciphertext.is_some()
            {
                let mut unwrap_manifest = manifest.clone();
                if let Some(original_mode) = original_key_policy_mode {
                    // Prefer mode stored in wrap (may differ from UI selection).
                    unwrap_manifest.key_policy_mode = original_mode;
                }
                // Remote wrap already applied its key_policy_mode onto manifest.
                if remote_key_wrap.is_some() {
                    unwrap_manifest.key_policy_mode = manifest.key_policy_mode;
                }
                match unwrap_collection_key(&unwrap_manifest, passphrase) {
                    Ok(key) => key,
                    Err(_) => {
                        return Err(SyncError::new(
                            "sync_collection_passphrase_mismatch",
                            "That passphrase did not unlock this Google encryption backup. \
Use the same passphrase that was used when these Drive records were created.",
                        ));
                    }
                }
            } else if existing_manifest || linking_existing_remote {
                return Err(SyncError::new(
                    "sync_collection_key_unrecoverable",
                    "No encryption key wrap was found for this Drive backup on this device or on Drive. \
Older backups created before key-wrap cloud backup cannot be recovered with the passphrase alone after a full local reset. \
Start a new empty collection and re-upload hosts, or recover from a machine that still has the original key.",
                ));
            } else {
                // Brand-new collection id — safe to generate a new key.
                generate_collection_key()
            }
        }
    };

    let (key_wrap_salt, key_wrap_nonce, key_wrap_ciphertext) =
        wrap_collection_key(&manifest, &collection_key, passphrase)?;
    manifest.key_wrap_salt = Some(base64_data(key_wrap_salt)?);
    manifest.key_wrap_nonce = Some(base64_data(key_wrap_nonce)?);
    manifest.key_wrap_ciphertext = Some(base64_data(key_wrap_ciphertext)?);

    let recovery_key = if has_recovery_key {
        let (recovery_key, recovery_key_bytes) = generate_recovery_key();
        let (salt, nonce, ciphertext) =
            wrap_collection_key_with_secret(
                &collection_key,
                &recovery_key_bytes,
                &recovery_key_wrap_aad(&manifest),
            )?;
        manifest.recovery_key_wrap_salt = Some(base64_data(salt)?);
        manifest.recovery_key_wrap_nonce = Some(base64_data(nonce)?);
        manifest.recovery_key_wrap_ciphertext = Some(base64_data(ciphertext)?);
        manifest.has_recovery_key = true;
        Some(recovery_key)
    } else {
        manifest.recovery_key_wrap_salt = None;
        manifest.recovery_key_wrap_nonce = None;
        manifest.recovery_key_wrap_ciphertext = None;
        manifest.has_recovery_key = false;
        None
    };

    manifest.key_cache_unlocked_at = Some(now_secs());
    persist_collection_key_and_manifest(data_dir, &manifest, &collection_key)?;
    Ok(SyncCollectionSetupOutcome {
        manifest,
        recovery_key,
    })
}

pub fn regenerate_recovery_key(
    data_dir: &Path,
    provider: SyncProviderKind,
) -> SyncResult<SyncCollectionSetupOutcome> {
    let mut manifest = load_manifest(data_dir, provider)?.ok_or_else(|| {
        SyncError::new(
            "sync_collection_not_configured",
            "Sync collection is not configured. Set up sync key first.",
        )
    })?;

    let collection_key = load_collection_key(&manifest).map_err(|_| {
        SyncError::new(
            "sync_collection_key_missing",
            "Sync key cache is locked on this device. Unlock Sync Key first, then regenerate recovery key.",
        )
    })?;

    let (recovery_key, recovery_key_bytes) = generate_recovery_key();
    let (salt, nonce, ciphertext) = wrap_collection_key_with_secret(
        &collection_key,
        &recovery_key_bytes,
        &recovery_key_wrap_aad(&manifest),
    )?;

    manifest.recovery_key_wrap_salt = Some(base64_data(salt)?);
    manifest.recovery_key_wrap_nonce = Some(base64_data(nonce)?);
    manifest.recovery_key_wrap_ciphertext = Some(base64_data(ciphertext)?);
    manifest.has_recovery_key = true;
    manifest.updated_at = now_secs();

    save_manifest(data_dir, &manifest)?;

    Ok(SyncCollectionSetupOutcome {
        manifest,
        recovery_key: Some(recovery_key),
    })
}

pub fn set_collection_key_cache_ttl(
    data_dir: &Path,
    provider: SyncProviderKind,
    ttl_secs: u64,
) -> SyncResult<SyncCollectionManifest> {
    let mut manifest = load_manifest(data_dir, provider)?.ok_or_else(|| {
        SyncError::new(
            "sync_collection_not_configured",
            "Sync collection is not configured. Set up sync key first.",
        )
    })?;
    manifest.key_cache_ttl_secs = Some(ttl_secs);
    manifest.updated_at = now_secs();
    save_manifest(data_dir, &manifest)?;
    Ok(manifest)
}

pub fn load_collection_key(manifest: &SyncCollectionManifest) -> SyncResult<[u8; 32]> {
    let account = collection_key_account(manifest);
    let encoded = load_collection_key_secret(&account)?;
    decode_collection_key(&encoded)
}

pub fn is_collection_key_cached(manifest: &SyncCollectionManifest) -> bool {
    let account = collection_key_account(manifest);
    load_collection_key_secret(&account).is_ok()
}

pub fn clear_collection_key_cache(manifest: &SyncCollectionManifest) -> SyncResult<()> {
    let account = collection_key_account(manifest);
    delete_collection_key_secret(&account)
}

pub fn enforce_collection_key_cache_ttl(
    data_dir: &Path,
    manifest: &mut SyncCollectionManifest,
) -> SyncResult<bool> {
    if !is_collection_key_cached(manifest) {
        return Ok(false);
    }
    let anchor = manifest.key_cache_unlocked_at.unwrap_or(manifest.updated_at);
    let now = now_secs();
    let ttl = manifest
        .key_cache_ttl_secs
        .unwrap_or(SYNC_COLLECTION_KEY_CACHE_TTL_SECS);
    if now.saturating_sub(anchor) < ttl {
        return Ok(false);
    }

    clear_collection_key_cache(manifest)?;
    manifest.key_cache_unlocked_at = None;
    manifest.updated_at = now;
    save_manifest(data_dir, manifest)?;
    Ok(true)
}

pub fn has_recovery_key_slot(manifest: &SyncCollectionManifest) -> bool {
    manifest.has_recovery_key
        && manifest.recovery_key_wrap_salt.is_some()
        && manifest.recovery_key_wrap_nonce.is_some()
        && manifest.recovery_key_wrap_ciphertext.is_some()
}

pub fn unlock_collection_key_with_passphrase(
    data_dir: &Path,
    manifest: &mut SyncCollectionManifest,
    passphrase: &str,
) -> SyncResult<()> {
    let key = unwrap_collection_key(manifest, passphrase)?;
    let previous_cache_unlocked_at = manifest.key_cache_unlocked_at;
    let previous_updated_at = manifest.updated_at;
    let ts = now_secs();
    manifest.key_cache_unlocked_at = Some(ts);
    manifest.updated_at = ts;
    if let Err(error) = persist_collection_key_and_manifest(data_dir, manifest, &key) {
        manifest.key_cache_unlocked_at = previous_cache_unlocked_at;
        manifest.updated_at = previous_updated_at;
        return Err(error);
    }
    Ok(())
}

pub fn unlock_collection_key_with_recovery_key(
    data_dir: &Path,
    manifest: &mut SyncCollectionManifest,
    recovery_key: &str,
) -> SyncResult<()> {
    let key = unwrap_collection_key_with_recovery_key(manifest, recovery_key)?;
    let previous_cache_unlocked_at = manifest.key_cache_unlocked_at;
    let previous_updated_at = manifest.updated_at;
    let ts = now_secs();
    manifest.key_cache_unlocked_at = Some(ts);
    manifest.updated_at = ts;
    if let Err(error) = persist_collection_key_and_manifest(data_dir, manifest, &key) {
        manifest.key_cache_unlocked_at = previous_cache_unlocked_at;
        manifest.updated_at = previous_updated_at;
        return Err(error);
    }
    Ok(())
}

fn generate_collection_key() -> [u8; 32] {
    let mut key = [0u8; SYNC_COLLECTION_KEY_BYTES];
    rand_core::OsRng.fill_bytes(&mut key);
    key
}

fn persist_collection_key(manifest: &SyncCollectionManifest, key: &[u8; 32]) -> SyncResult<()> {
    let account = collection_key_account(manifest);
    let encoded = base64::engine::general_purpose::STANDARD.encode(key);
    save_collection_key_secret(&account, &encoded)?;
    Ok(())
}

fn persist_collection_key_and_manifest(
    data_dir: &Path,
    manifest: &SyncCollectionManifest,
    key: &[u8; 32],
) -> SyncResult<()> {
    let account = collection_key_account(manifest);
    let previous_secret = load_optional_collection_key_secret(&account)?;
    persist_collection_key(manifest, key)?;
    if let Err(error) = save_manifest(data_dir, manifest) {
        let rollback_result = match previous_secret {
            Some(secret) => {
                save_collection_key_secret(&account, &secret)
            }
            None => {
                delete_collection_key_secret(&account)
            }
        };
        if let Err(rollback_error) = rollback_result {
            return Err(SyncError::new(
                "sync_collection_keyring_rollback_failed",
                format!(
                    "{}; additionally failed to restore the previous cached sync key: {}",
                    error.message, rollback_error.message
                ),
            ));
        }
        return Err(error);
    }
    Ok(())
}

fn decode_collection_key(encoded: &str) -> SyncResult<[u8; 32]> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| {
            SyncError::new(
                "sync_collection_key_decode_failed",
                format!("Failed to decode sync collection key: {e}"),
            )
        })?;
    let key: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| SyncError::new("sync_collection_key_decode_failed", "Invalid key size"))?;
    Ok(key)
}

fn collection_key_account(manifest: &SyncCollectionManifest) -> String {
    format!(
        "{}:{}",
        manifest.provider.to_ascii_lowercase(),
        manifest.sync_collection_id
    )
}

fn key_policy_mode_tag(mode: SyncKeyPolicyMode) -> &'static str {
    match mode {
        SyncKeyPolicyMode::LocalPassphrase => "local-passphrase",
        SyncKeyPolicyMode::CustomPassphrase => "custom-passphrase",
    }
}

fn base64_data(value: String) -> SyncResult<Base64EncodedData> {
    Base64EncodedData::try_from(value).map_err(|e| {
        SyncError::new(
            "sync_collection_write_failed",
            format!("Invalid base64 payload produced for sync collection manifest: {e}"),
        )
    })
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

fn recovery_key_wrap_aad(manifest: &SyncCollectionManifest) -> String {
    format!(
        "zync:sync-collection-key:v{}|provider:{}|collection:{}|slot:recovery",
        SYNC_COLLECTION_KEY_WRAP_AAD_VERSION,
        manifest.provider.to_ascii_lowercase(),
        manifest.sync_collection_id
    )
}

fn wrap_collection_key(
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

fn wrap_collection_key_with_secret(
    collection_key: &[u8; 32],
    secret: &[u8],
    aad: &str,
) -> SyncResult<(String, String, String)> {
    let salt = generate_salt();
    let kek = derive_kek(secret, &salt, &KdfParams::default_production()).map_err(
        |e| {
            SyncError::new(
                "sync_collection_key_wrap_failed",
                format!("Failed to derive sync key wrap key: {e}"),
            )
        },
    )?;
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

fn unwrap_collection_key(
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
    let kek =
        derive_kek(passphrase.as_bytes(), &salt_bytes, &KdfParams::default_production()).map_err(
            |e| {
                SyncError::new(
                    "sync_collection_key_unwrap_failed",
                    format!("Failed to derive wrapped-key KEK: {e}"),
                )
            },
        )?;

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

fn unwrap_collection_key_with_recovery_key(
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

fn generate_recovery_key() -> (String, [u8; 32]) {
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

fn parse_recovery_key(value: &str) -> Option<[u8; 32]> {
    let normalized = value.trim();
    let prefix = format!("{SYNC_RECOVERY_KEY_PREFIX}-");
    if let Some(grouped) = normalized.strip_prefix(&prefix) {
        return decode_grouped_recovery_key(grouped);
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

#[cfg(not(test))]
fn load_collection_key_secret(account: &str) -> SyncResult<String> {
    let entry = keyring::Entry::new(SYNC_COLLECTION_KEYRING_SERVICE, account)
        .map_err(|e| SyncError::new("sync_collection_keyring_failed", e.to_string()))?;
    entry
        .get_password()
        .map_err(|e| SyncError::new("sync_collection_keyring_failed", e.to_string()))
}

#[cfg(not(test))]
fn load_optional_collection_key_secret(account: &str) -> SyncResult<Option<String>> {
    let entry = keyring::Entry::new(SYNC_COLLECTION_KEYRING_SERVICE, account)
        .map_err(|e| SyncError::new("sync_collection_keyring_failed", e.to_string()))?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(SyncError::new(
            "sync_collection_keyring_failed",
            error.to_string(),
        )),
    }
}

#[cfg(not(test))]
fn save_collection_key_secret(account: &str, value: &str) -> SyncResult<()> {
    let entry = keyring::Entry::new(SYNC_COLLECTION_KEYRING_SERVICE, account)
        .map_err(|e| SyncError::new("sync_collection_keyring_failed", e.to_string()))?;
    entry
        .set_password(value)
        .map_err(|e| SyncError::new("sync_collection_keyring_failed", e.to_string()))
}

#[cfg(not(test))]
fn delete_collection_key_secret(account: &str) -> SyncResult<()> {
    let entry = keyring::Entry::new(SYNC_COLLECTION_KEYRING_SERVICE, account)
        .map_err(|e| SyncError::new("sync_collection_keyring_failed", e.to_string()))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(SyncError::new("sync_collection_keyring_failed", error.to_string())),
    }
}

#[cfg(test)]
fn load_collection_key_secret(account: &str) -> SyncResult<String> {
    let store = key_store();
    let lock = store
        .lock()
        .map_err(|_| {
            SyncError::new(
                "sync_collection_keyring_failed",
                "test key store lock poisoned",
            )
        })?;
    lock.get(account)
        .cloned()
        .ok_or_else(|| SyncError::new("sync_collection_keyring_failed", "key not found"))
}

#[cfg(test)]
fn load_optional_collection_key_secret(account: &str) -> SyncResult<Option<String>> {
    let store = key_store();
    let lock = store
        .lock()
        .map_err(|_| {
            SyncError::new(
                "sync_collection_keyring_failed",
                "test key store lock poisoned",
            )
        })?;
    Ok(lock.get(account).cloned())
}

#[cfg(test)]
fn save_collection_key_secret(account: &str, value: &str) -> SyncResult<()> {
    let store = key_store();
    let mut lock = store
        .lock()
        .map_err(|_| {
            SyncError::new(
                "sync_collection_keyring_failed",
                "test key store lock poisoned",
            )
        })?;
    lock.insert(account.to_string(), value.to_string());
    Ok(())
}

#[cfg(test)]
fn delete_collection_key_secret(account: &str) -> SyncResult<()> {
    let store = key_store();
    let mut lock = store
        .lock()
        .map_err(|_| {
            SyncError::new(
                "sync_collection_keyring_failed",
                "test key store lock poisoned",
            )
        })?;
    lock.remove(account);
    Ok(())
}

#[cfg(test)]
fn key_store() -> &'static std::sync::Mutex<std::collections::HashMap<String, String>> {
    static STORE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, String>>> =
        std::sync::OnceLock::new();
    STORE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn provider_from_str(value: &str) -> SyncResult<SyncProviderKind> {
    SyncProviderKind::parse(value).ok_or_else(|| {
        SyncError::new(
            "sync_collection_invalid_provider",
            format!("Invalid provider in sync collection manifest: {value}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_key_parser_preserves_url_safe_hyphens_inside_groups() {
        let bytes = [0xfbu8; 32];
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
        assert!(encoded.contains('-'));
        let grouped = encoded
            .as_bytes()
            .chunks(4)
            .map(|chunk| std::str::from_utf8(chunk).expect("base64 is utf8"))
            .collect::<Vec<_>>()
            .join("-");
        let formatted = format!("{SYNC_RECOVERY_KEY_PREFIX}-{grouped}");

        assert_eq!(parse_recovery_key(&formatted), Some(bytes));
        assert_eq!(parse_recovery_key(&encoded), Some(bytes));
    }

    #[test]
    fn setup_manifest_creates_and_updates_sync_collection() {
        let unique = format!(
            "zync-sync-collection-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let data_dir_path = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&data_dir_path).expect("create temp test dir");

        let created = setup_manifest(
            &data_dir_path,
            SyncProviderKind::Google,
            SyncKeyPolicyMode::LocalPassphrase,
            "local-passphrase-for-sync",
            false,
            None,
            None,
        )
        .expect("create manifest");
        let created = created.manifest;

        assert_eq!(created.provider, "google");
        assert_eq!(created.key_policy_mode, SyncKeyPolicyMode::LocalPassphrase);
        assert!(!created.sync_collection_id.is_empty());

        let updated = setup_manifest(
            &data_dir_path,
            SyncProviderKind::Google,
            SyncKeyPolicyMode::CustomPassphrase,
            "custom-passphrase-for-sync",
            true,
            None,
            None,
        )
        .expect("update manifest");
        assert!(updated.recovery_key.is_some());
        let updated = updated.manifest;

        assert_eq!(updated.sync_collection_id, created.sync_collection_id);
        assert_eq!(updated.key_policy_mode, SyncKeyPolicyMode::CustomPassphrase);
        assert!(updated.has_recovery_key);
        assert!(updated.recovery_key_wrap_salt.is_some());
        assert!(updated.recovery_key_wrap_nonce.is_some());
        assert!(updated.recovery_key_wrap_ciphertext.is_some());

        let loaded = load_manifest(&data_dir_path, SyncProviderKind::Google)
            .expect("load manifest")
            .expect("manifest exists");

        assert_eq!(loaded.sync_collection_id, created.sync_collection_id);
        assert_eq!(loaded.key_policy_mode, SyncKeyPolicyMode::CustomPassphrase);
        assert!(loaded.key_wrap_salt.is_some());
        assert!(loaded.key_wrap_nonce.is_some());
        assert!(loaded.key_wrap_ciphertext.is_some());

        let key = load_collection_key(&loaded).expect("collection key should load");
        assert_ne!(key, [0u8; 32]);

        let _ = std::fs::remove_dir_all(&data_dir_path);
    }

    #[test]
    fn setup_manifest_reuses_wrapped_key_when_keyring_missing() {
        let unique = format!(
            "zync-sync-collection-rewrap-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let data_dir_path = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&data_dir_path).expect("create temp test dir");

        let passphrase = "provider-sync-passphrase-v1";
        let manifest = setup_manifest(
            &data_dir_path,
            SyncProviderKind::Google,
            SyncKeyPolicyMode::CustomPassphrase,
            passphrase,
            false,
            None,
            None,
        )
        .expect("setup manifest");
        let manifest = manifest.manifest;

        let key_before = load_collection_key(&manifest).expect("key before");
        let account = collection_key_account(&manifest);
        {
            let store = key_store();
            let mut lock = store.lock().expect("key store lock");
            lock.remove(&account);
        }

        let loaded = load_manifest(&data_dir_path, SyncProviderKind::Google)
            .expect("load manifest")
            .expect("manifest exists");
        let key_unwrapped = unwrap_collection_key(&loaded, passphrase).expect("unwrap key");
        assert_eq!(key_unwrapped, key_before);

        let _ = std::fs::remove_dir_all(&data_dir_path);
    }

    #[test]
    fn recovery_key_can_restore_missing_keyring_cache() {
        let unique = format!(
            "zync-sync-collection-recovery-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let data_dir_path = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&data_dir_path).expect("create temp test dir");

        let outcome = setup_manifest(
            &data_dir_path,
            SyncProviderKind::Google,
            SyncKeyPolicyMode::CustomPassphrase,
            "provider-sync-passphrase-v1",
            true,
            None,
            None,
        )
        .expect("setup manifest with recovery");
        let recovery_key = outcome.recovery_key.expect("recovery key is generated");
        let manifest = outcome.manifest;
        let key_before = load_collection_key(&manifest).expect("key before");
        let account = collection_key_account(&manifest);
        {
            let store = key_store();
            let mut lock = store.lock().expect("key store lock");
            lock.remove(&account);
        }
        assert!(!is_collection_key_cached(&manifest));

        let mut manifest_after_unlock = manifest.clone();
        unlock_collection_key_with_recovery_key(
            &data_dir_path,
            &mut manifest_after_unlock,
            &recovery_key,
        )
            .expect("recovery key should restore key cache");

        let key_after = load_collection_key(&manifest_after_unlock).expect("key after");
        assert_eq!(key_after, key_before);

        let _ = std::fs::remove_dir_all(&data_dir_path);
    }

    #[test]
    fn setup_manifest_rejects_existing_collection_without_any_key_material() {
        let unique = format!(
            "zync-sync-collection-missing-key-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let data_dir_path = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&data_dir_path).expect("create temp test dir");

        let now = now_secs();
        let legacy_manifest = SyncCollectionManifest {
            version: SYNC_COLLECTION_VERSION,
            provider: "google".to_string(),
            sync_collection_id: Uuid::new_v4().to_string(),
            key_policy_mode: SyncKeyPolicyMode::LocalPassphrase,
            key_wrap_salt: None,
            key_wrap_nonce: None,
            key_wrap_ciphertext: None,
            recovery_key_wrap_salt: None,
            recovery_key_wrap_nonce: None,
            recovery_key_wrap_ciphertext: None,
            key_cache_unlocked_at: None,
            key_cache_ttl_secs: Some(SYNC_COLLECTION_KEY_CACHE_TTL_SECS),
            has_recovery_key: false,
            created_at: now,
            updated_at: now,
        };
        save_manifest(&data_dir_path, &legacy_manifest).expect("write legacy manifest");

        let err = setup_manifest(
            &data_dir_path,
            SyncProviderKind::Google,
            SyncKeyPolicyMode::LocalPassphrase,
            "local-passphrase-for-sync",
            false,
            None,
            None,
        )
        .expect_err("missing key material should fail");

        assert_eq!(err.code, "sync_collection_key_missing");
        let _ = std::fs::remove_dir_all(&data_dir_path);
    }

    #[test]
    fn setup_manifest_uses_preferred_collection_id_on_first_setup() {
        let unique = format!(
            "zync-sync-collection-preferred-id-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let data_dir_path = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&data_dir_path).expect("create temp test dir");

        let outcome = setup_manifest(
            &data_dir_path,
            SyncProviderKind::Google,
            SyncKeyPolicyMode::CustomPassphrase,
            "provider-sync-passphrase-v1",
            false,
            Some("collection-from-provider".to_string()),
            None,
        )
        .expect("setup manifest");

        assert_eq!(outcome.manifest.sync_collection_id, "collection-from-provider");

        let _ = std::fs::remove_dir_all(&data_dir_path);
    }

    #[test]
    fn unlock_rolls_back_cached_key_when_manifest_save_fails() {
        let unique = format!(
            "zync-sync-collection-rollback-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let data_dir_path = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&data_dir_path).expect("create temp test dir");
        let passphrase = "provider-sync-passphrase-v1";
        let outcome = setup_manifest(
            &data_dir_path,
            SyncProviderKind::Google,
            SyncKeyPolicyMode::CustomPassphrase,
            passphrase,
            false,
            None,
            None,
        )
        .expect("setup manifest");
        let mut manifest = outcome.manifest;
        let account = collection_key_account(&manifest);
        save_collection_key_secret(&account, "previous-cached-secret")
            .expect("seed previous cached secret");

        std::fs::remove_dir_all(&data_dir_path).expect("remove manifest directory");
        std::fs::write(&data_dir_path, "blocks directory creation")
            .expect("create blocking file");

        let error =
            unlock_collection_key_with_passphrase(&data_dir_path, &mut manifest, passphrase)
                .expect_err("manifest save should fail");

        assert_eq!(error.code, "sync_collection_write_failed");
        assert_eq!(
            load_collection_key_secret(&account).expect("cached secret"),
            "previous-cached-secret"
        );
        std::fs::remove_file(&data_dir_path).expect("cleanup blocking file");
    }
}
