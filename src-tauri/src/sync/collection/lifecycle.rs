use super::super::profiles::now_secs;
use super::super::types::{
    SyncCollectionManifest, SyncError, SyncKeyPolicyMode, SyncProviderKind, SyncResult,
};
use super::keyring::{
    collection_key_account, decode_collection_key, load_collection_key, load_collection_key_secret,
    persist_collection_key_and_manifest, SYNC_COLLECTION_KEY_CACHE_TTL_SECS,
};
use super::manifest::{load_manifest, save_manifest, SYNC_COLLECTION_VERSION};
use super::wrap::{
    apply_remote_key_wrap_to_manifest, base64_data, generate_collection_key, generate_recovery_key,
    has_recovery_key_slot, recovery_key_wrap_aad, unwrap_collection_key_trying_modes,
    unwrap_collection_key_with_recovery_key, wrap_collection_key, wrap_collection_key_with_secret,
    RemoteCollectionKeyWrapV1,
};
use std::path::Path;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct SyncCollectionSetupOutcome {
    pub manifest: SyncCollectionManifest,
    pub recovery_key: Option<String>,
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
    recovery_key: Option<&str>,
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
    let wrap_present = manifest.key_wrap_salt.is_some()
        && manifest.key_wrap_nonce.is_some()
        && manifest.key_wrap_ciphertext.is_some();
    let mut unwrap_manifest = manifest.clone();
    if let Some(original_mode) = original_key_policy_mode {
        // Prefer mode stored in wrap (may differ from UI selection).
        unwrap_manifest.key_policy_mode = original_mode;
    }
    // Remote wrap already applied its key_policy_mode onto manifest.
    if remote_key_wrap.is_some() {
        unwrap_manifest.key_policy_mode = manifest.key_policy_mode;
    }
    let passphrase_mismatch = || {
        SyncError::new(
            "sync_collection_passphrase_mismatch",
            "That passphrase did not unlock this Google encryption backup. \
Use the same passphrase that was used when these Drive records were created. \
If a previous attempt on this PC was accepted by mistake, try that password instead.",
        )
    };
    let recovery_secret = recovery_key
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let collection_key = if let Some(recovery_secret) = recovery_secret {
        if !has_recovery_key_slot(&unwrap_manifest) {
            return Err(SyncError::new(
                "sync_collection_key_unrecoverable",
                "This Drive backup has no recovery key slot to unlock.",
            ));
        }
        unwrap_collection_key_with_recovery_key(&unwrap_manifest, recovery_secret)?
    } else {
        match load_collection_key_secret(&account) {
            Ok(encoded) => {
                let cached = decode_collection_key(&encoded)?;
                if !wrap_present {
                    cached
                } else if unwrap_collection_key_trying_modes(&unwrap_manifest, passphrase).is_ok() {
                    cached
                } else if existing_manifest && remote_key_wrap.is_none() {
                    // Same device: key is already cached, allow wrapping with a new passphrase.
                    cached
                } else {
                    // Relink / Drive wrap present: leftover keychain cannot skip backup unlock.
                    return Err(passphrase_mismatch());
                }
            }
            Err(_) => {
                if wrap_present {
                    unwrap_collection_key_trying_modes(&unwrap_manifest, passphrase)
                        .map_err(|_| passphrase_mismatch())?
                } else if existing_manifest {
                    return Err(SyncError::new(
                        "sync_collection_key_missing",
                        "No cached sync collection key or key wrap was found for this local collection.",
                    ));
                } else if remote_key_wrap.is_some() {
                    return Err(SyncError::new(
                        "sync_collection_key_unrecoverable",
                        "This Drive backup cannot be unlocked with a new encryption key. \
Enter the original passphrase, or recover from a device that still has the key.",
                    ));
                } else {
                    // Brand-new collection id — safe to generate a new key.
                    generate_collection_key()
                }
            }
        }
    };

    let linking_existing_backup = remote_key_wrap.is_some();
    let preserve_existing_passphrase_wrap =
        recovery_secret.is_some() && passphrase.trim().is_empty() && wrap_present;
    if !linking_existing_backup && !preserve_existing_passphrase_wrap {
        let (key_wrap_salt, key_wrap_nonce, key_wrap_ciphertext) =
            wrap_collection_key(&manifest, &collection_key, passphrase)?;
        manifest.key_wrap_salt = Some(base64_data(key_wrap_salt)?);
        manifest.key_wrap_nonce = Some(base64_data(key_wrap_nonce)?);
        manifest.key_wrap_ciphertext = Some(base64_data(key_wrap_ciphertext)?);
    }
    let unlocked_with_existing_recovery = recovery_secret.is_some();
    let recovery_slot_present = manifest.recovery_key_wrap_salt.is_some()
        && manifest.recovery_key_wrap_nonce.is_some()
        && manifest.recovery_key_wrap_ciphertext.is_some();
    let recovery_key = if has_recovery_key {
        // Explicit rotation / first-time recovery generation.
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
        Some(recovery_key)
    } else if recovery_slot_present && (linking_existing_backup || unlocked_with_existing_recovery)
    {
        // Keep the existing recovery slot unless the user asked to rotate it.
        // This covers Drive relink and recovery-key unlock even when the UI
        // did not pass has_recovery_key=true.
        manifest.has_recovery_key = true;
        None
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

    // Do not save here — caller must upload the remote wrap first, then persist.
    // That way a failed Drive upload leaves the previous local recovery slot intact.
    let _ = data_dir;
    Ok(SyncCollectionSetupOutcome {
        manifest,
        recovery_key: Some(recovery_key),
    })
}

/// Minimum retained cache TTL (1 minute). Zero would expire immediately.
pub const SYNC_COLLECTION_KEY_CACHE_TTL_MIN_SECS: u64 = 60;
/// Maximum retained cache TTL (7 days).
pub const SYNC_COLLECTION_KEY_CACHE_TTL_MAX_SECS: u64 = 7 * 24 * 60 * 60;

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
    let ttl_secs = ttl_secs.clamp(
        SYNC_COLLECTION_KEY_CACHE_TTL_MIN_SECS,
        SYNC_COLLECTION_KEY_CACHE_TTL_MAX_SECS,
    );
    manifest.key_cache_ttl_secs = Some(ttl_secs);
    manifest.updated_at = now_secs();
    save_manifest(data_dir, &manifest)?;
    Ok(manifest)
}

pub fn unlock_collection_key_with_passphrase(
    data_dir: &Path,
    manifest: &mut SyncCollectionManifest,
    passphrase: &str,
) -> SyncResult<()> {
    let key = unwrap_collection_key_trying_modes(manifest, passphrase)?;
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
