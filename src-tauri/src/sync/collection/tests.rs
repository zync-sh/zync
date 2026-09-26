use super::super::profiles::now_secs;
use super::super::types::{SyncCollectionManifest, SyncKeyPolicyMode, SyncProviderKind};
use super::keyring::{
    collection_key_account, is_collection_key_cached, key_store, load_collection_key,
    load_collection_key_secret, save_collection_key_secret, SYNC_COLLECTION_KEY_CACHE_TTL_SECS,
};
use super::lifecycle::{
    setup_manifest, unlock_collection_key_with_passphrase, unlock_collection_key_with_recovery_key,
};
use super::manifest::{load_manifest, save_manifest, SYNC_COLLECTION_VERSION};
use super::wrap::{
    apply_remote_key_wrap_to_manifest, parse_recovery_key, remote_key_wrap_from_manifest,
    unwrap_collection_key, RemoteCollectionKeyWrapV1, REMOTE_KEY_WRAP_VERSION,
    SYNC_RECOVERY_KEY_PREFIX,
};
use base64::Engine;
use uuid::Uuid;

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
fn setup_manifest_relink_preserves_recovery_slot_unless_rotated() {
    let unique = format!(
        "zync-sync-collection-relink-recovery-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let source_dir = std::env::temp_dir().join(format!("{unique}-src"));
    let dest_dir = std::env::temp_dir().join(format!("{unique}-dst"));
    std::fs::create_dir_all(&source_dir).expect("create source dir");
    std::fs::create_dir_all(&dest_dir).expect("create dest dir");

    let passphrase = "provider-sync-passphrase-v1";
    let created = setup_manifest(
        &source_dir,
        SyncProviderKind::Google,
        SyncKeyPolicyMode::CustomPassphrase,
        passphrase,
        true,
        None,
        None,
        None,
    )
    .expect("create with recovery");
    let wrap = remote_key_wrap_from_manifest(&created.manifest).expect("remote wrap");
    let recovery_salt = created.manifest.recovery_key_wrap_salt.clone();

    let relinked = setup_manifest(
        &dest_dir,
        SyncProviderKind::Google,
        SyncKeyPolicyMode::CustomPassphrase,
        passphrase,
        false,
        Some(created.manifest.sync_collection_id.clone()),
        Some(wrap),
        None,
    )
    .expect("relink without rotating recovery");
    assert!(relinked.recovery_key.is_none());
    assert!(relinked.manifest.has_recovery_key);
    assert_eq!(relinked.manifest.recovery_key_wrap_salt, recovery_salt);
    assert_eq!(
        relinked.manifest.sync_collection_id,
        created.manifest.sync_collection_id
    );

    let _ = std::fs::remove_dir_all(&source_dir);
    let _ = std::fs::remove_dir_all(&dest_dir);
}

#[test]
fn setup_manifest_rejects_wrong_passphrase_even_when_keyring_cached() {
    let unique = format!(
        "zync-sync-collection-wrong-pass-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let data_dir_path = std::env::temp_dir().join(&unique);
    std::fs::create_dir_all(&data_dir_path).expect("create temp test dir");

    let passphrase = "provider-sync-passphrase-v1";
    let created = setup_manifest(
        &data_dir_path,
        SyncProviderKind::Google,
        SyncKeyPolicyMode::CustomPassphrase,
        passphrase,
        false,
        None,
        None,
        None,
    )
    .expect("create manifest");
    let wrap = remote_key_wrap_from_manifest(&created.manifest).expect("remote wrap");

    let dest_dir = std::env::temp_dir().join(format!("{unique}-dst"));
    std::fs::create_dir_all(&dest_dir).expect("create dest dir");
    let error = setup_manifest(
        &dest_dir,
        SyncProviderKind::Google,
        SyncKeyPolicyMode::CustomPassphrase,
        "definitely-not-the-pass",
        false,
        Some(created.manifest.sync_collection_id.clone()),
        Some(wrap),
        None,
    )
    .expect_err("wrong passphrase must not relink");
    assert_eq!(error.code, "sync_collection_passphrase_mismatch");

    let _ = std::fs::remove_dir_all(&data_dir_path);
    let _ = std::fs::remove_dir_all(&dest_dir);
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
        None,
    )
    .expect("setup manifest");

    assert_eq!(
        outcome.manifest.sync_collection_id,
        "collection-from-provider"
    );

    let _ = std::fs::remove_dir_all(&data_dir_path);
}

#[test]
fn setup_manifest_recovery_key_preserves_passphrase_wrap_when_passphrase_empty() {
    let unique = format!(
        "zync-sync-collection-recovery-preserve-{}",
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
        SyncKeyPolicyMode::CustomPassphrase,
        "custom-passphrase-for-sync",
        true,
        None,
        None,
        None,
    )
    .expect("create with recovery");
    let recovery_key = created.recovery_key.expect("recovery key issued");
    let original_salt = created.manifest.key_wrap_salt.clone();
    let original_nonce = created.manifest.key_wrap_nonce.clone();
    let original_ciphertext = created.manifest.key_wrap_ciphertext.clone();

    let account = collection_key_account(&created.manifest);
    {
        let store = key_store();
        let mut lock = store.lock().expect("key store lock");
        lock.remove(&account);
    }

    let relinked = setup_manifest(
        &data_dir_path,
        SyncProviderKind::Google,
        SyncKeyPolicyMode::CustomPassphrase,
        "",
        true,
        None,
        None,
        Some(recovery_key.as_str()),
    )
    .expect("unlock with recovery key only");

    assert_eq!(relinked.manifest.key_wrap_salt, original_salt);
    assert_eq!(relinked.manifest.key_wrap_nonce, original_nonce);
    assert_eq!(relinked.manifest.key_wrap_ciphertext, original_ciphertext);

    let _ = std::fs::remove_dir_all(&data_dir_path);
}

#[test]
fn setup_manifest_recovery_key_rejects_missing_recovery_slot() {
    let unique = format!(
        "zync-sync-collection-recovery-missing-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let data_dir_path = std::env::temp_dir().join(unique);
    std::fs::create_dir_all(&data_dir_path).expect("create temp test dir");

    setup_manifest(
        &data_dir_path,
        SyncProviderKind::Google,
        SyncKeyPolicyMode::CustomPassphrase,
        "custom-passphrase-for-sync",
        false,
        None,
        None,
        None,
    )
    .expect("create without recovery");

    let error = setup_manifest(
        &data_dir_path,
        SyncProviderKind::Google,
        SyncKeyPolicyMode::CustomPassphrase,
        "",
        false,
        None,
        None,
        Some("zync-rk-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH"),
    )
    .expect_err("missing recovery slot");
    assert_eq!(error.code, "sync_collection_key_unrecoverable");

    let _ = std::fs::remove_dir_all(&data_dir_path);
}

#[test]
fn setup_manifest_rejects_malformed_recovery_key() {
    let unique = format!(
        "zync-sync-collection-recovery-bad-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let data_dir_path = std::env::temp_dir().join(unique);
    std::fs::create_dir_all(&data_dir_path).expect("create temp test dir");

    setup_manifest(
        &data_dir_path,
        SyncProviderKind::Google,
        SyncKeyPolicyMode::CustomPassphrase,
        "custom-passphrase-for-sync",
        true,
        None,
        None,
        None,
    )
    .expect("create with recovery");

    let error = setup_manifest(
        &data_dir_path,
        SyncProviderKind::Google,
        SyncKeyPolicyMode::CustomPassphrase,
        "",
        true,
        None,
        None,
        Some("not-a-valid-recovery-key"),
    )
    .expect_err("malformed recovery key");
    assert_eq!(error.code, "sync_collection_recovery_key_invalid");

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
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(data_dir_path.clone());
    let passphrase = "provider-sync-passphrase-v1";
    let outcome = setup_manifest(
        &data_dir_path,
        SyncProviderKind::Google,
        SyncKeyPolicyMode::CustomPassphrase,
        passphrase,
        false,
        None,
        None,
        None,
    )
    .expect("setup manifest");
    let mut manifest = outcome.manifest;
    let account = collection_key_account(&manifest);
    save_collection_key_secret(&account, "previous-cached-secret")
        .expect("seed previous cached secret");

    std::fs::remove_dir_all(&data_dir_path).expect("remove manifest directory");
    std::fs::write(&data_dir_path, "blocks directory creation").expect("create blocking file");

    let error = unlock_collection_key_with_passphrase(&data_dir_path, &mut manifest, passphrase)
        .expect_err("manifest save should fail");

    assert_eq!(error.code, "sync_collection_write_failed");
    assert_eq!(
        load_collection_key_secret(&account).expect("cached secret"),
        "previous-cached-secret"
    );
}

#[test]
fn apply_remote_key_wrap_rejects_partial_recovery_slot_atomically() {
    let mut manifest = SyncCollectionManifest {
        version: SYNC_COLLECTION_VERSION,
        provider: "google".to_string(),
        sync_collection_id: "col-123".to_string(),
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
        created_at: 100,
        updated_at: 100,
    };
    let initial_manifest = manifest.clone();

    // Valid base64 strings for key wrap: 32 bytes for salt/ciphertext, 24 bytes for nonces
    let valid_b64 = base64::engine::general_purpose::STANDARD.encode([1u8; 32]);
    let valid_nonce_b64 = base64::engine::general_purpose::STANDARD.encode([1u8; 24]);

    let partial_wrap = RemoteCollectionKeyWrapV1 {
        version: REMOTE_KEY_WRAP_VERSION,
        provider: "google".to_string(),
        sync_collection_id: "col-123".to_string(),
        key_policy_mode: SyncKeyPolicyMode::CustomPassphrase,
        key_wrap_salt: valid_b64.clone(),
        key_wrap_nonce: valid_nonce_b64.clone(),
        key_wrap_ciphertext: valid_b64.clone(),
        recovery_key_wrap_salt: Some(valid_b64.clone()),
        recovery_key_wrap_nonce: None, // Missing nonce
        recovery_key_wrap_ciphertext: Some(valid_b64.clone()),
    };

    let err = apply_remote_key_wrap_to_manifest(&mut manifest, &partial_wrap)
        .expect_err("partial recovery slot must be rejected");

    assert_eq!(err.code, "sync_collection_key_wrap_invalid");
    // Manifest must remain unmodified on error
    assert_eq!(manifest.key_policy_mode, initial_manifest.key_policy_mode);
    assert_eq!(manifest.key_wrap_salt, initial_manifest.key_wrap_salt);
    assert_eq!(manifest.key_wrap_nonce, initial_manifest.key_wrap_nonce);
    assert_eq!(
        manifest.key_wrap_ciphertext,
        initial_manifest.key_wrap_ciphertext
    );
    assert_eq!(manifest.has_recovery_key, initial_manifest.has_recovery_key);
}

#[test]
fn apply_remote_key_wrap_rejects_invalid_base64_atomically() {
    let mut manifest = SyncCollectionManifest {
        version: SYNC_COLLECTION_VERSION,
        provider: "google".to_string(),
        sync_collection_id: "col-123".to_string(),
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
        created_at: 100,
        updated_at: 100,
    };
    let initial_manifest = manifest.clone();

    let valid_b64 = base64::engine::general_purpose::STANDARD.encode([1u8; 32]);
    let valid_nonce_b64 = base64::engine::general_purpose::STANDARD.encode([1u8; 24]);

    let invalid_wrap = RemoteCollectionKeyWrapV1 {
        version: REMOTE_KEY_WRAP_VERSION,
        provider: "google".to_string(),
        sync_collection_id: "col-123".to_string(),
        key_policy_mode: SyncKeyPolicyMode::CustomPassphrase,
        key_wrap_salt: valid_b64.clone(),
        key_wrap_nonce: valid_nonce_b64.clone(),
        key_wrap_ciphertext: "not-valid-base64!!!".to_string(),
        recovery_key_wrap_salt: None,
        recovery_key_wrap_nonce: None,
        recovery_key_wrap_ciphertext: None,
    };

    let err = apply_remote_key_wrap_to_manifest(&mut manifest, &invalid_wrap)
        .expect_err("invalid base64 must fail");

    assert_eq!(err.code, "sync_collection_write_failed");
    // Manifest must not be partially mutated
    assert_eq!(manifest.key_policy_mode, initial_manifest.key_policy_mode);
    assert_eq!(manifest.key_wrap_salt, initial_manifest.key_wrap_salt);
}

#[test]
fn apply_remote_key_wrap_rejects_invalid_nonce_length_atomically() {
    let mut manifest = SyncCollectionManifest {
        version: SYNC_COLLECTION_VERSION,
        provider: "google".to_string(),
        sync_collection_id: "col-123".to_string(),
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
        created_at: 100,
        updated_at: 100,
    };
    let initial_manifest = manifest.clone();

    let valid_b64 = base64::engine::general_purpose::STANDARD.encode([1u8; 32]);
    let invalid_nonce_32b = base64::engine::general_purpose::STANDARD.encode([1u8; 32]);

    let invalid_wrap = RemoteCollectionKeyWrapV1 {
        version: REMOTE_KEY_WRAP_VERSION,
        provider: "google".to_string(),
        sync_collection_id: "col-123".to_string(),
        key_policy_mode: SyncKeyPolicyMode::CustomPassphrase,
        key_wrap_salt: valid_b64.clone(),
        key_wrap_nonce: invalid_nonce_32b,
        key_wrap_ciphertext: valid_b64.clone(),
        recovery_key_wrap_salt: None,
        recovery_key_wrap_nonce: None,
        recovery_key_wrap_ciphertext: None,
    };

    let err = apply_remote_key_wrap_to_manifest(&mut manifest, &invalid_wrap)
        .expect_err("32-byte nonce must fail (expected 24 bytes)");

    assert_eq!(err.code, "sync_collection_key_wrap_invalid");
    // Manifest must not be partially mutated
    assert_eq!(manifest.key_policy_mode, initial_manifest.key_policy_mode);
    assert_eq!(manifest.key_wrap_salt, initial_manifest.key_wrap_salt);
    assert_eq!(manifest.key_wrap_nonce, initial_manifest.key_wrap_nonce);
}

#[test]
fn apply_remote_key_wrap_applies_and_clears_recovery_slot_correctly() {
    let mut manifest = SyncCollectionManifest {
        version: SYNC_COLLECTION_VERSION,
        provider: "google".to_string(),
        sync_collection_id: "col-123".to_string(),
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
        created_at: 100,
        updated_at: 100,
    };

    let valid_b64 = base64::engine::general_purpose::STANDARD.encode([1u8; 32]);
    let valid_nonce_b64 = base64::engine::general_purpose::STANDARD.encode([1u8; 24]);

    let wrap_with_recovery = RemoteCollectionKeyWrapV1 {
        version: REMOTE_KEY_WRAP_VERSION,
        provider: "google".to_string(),
        sync_collection_id: "col-123".to_string(),
        key_policy_mode: SyncKeyPolicyMode::CustomPassphrase,
        key_wrap_salt: valid_b64.clone(),
        key_wrap_nonce: valid_nonce_b64.clone(),
        key_wrap_ciphertext: valid_b64.clone(),
        recovery_key_wrap_salt: Some(valid_b64.clone()),
        recovery_key_wrap_nonce: Some(valid_nonce_b64.clone()),
        recovery_key_wrap_ciphertext: Some(valid_b64.clone()),
    };

    apply_remote_key_wrap_to_manifest(&mut manifest, &wrap_with_recovery)
        .expect("wrap with recovery should apply");

    assert_eq!(
        manifest.key_policy_mode,
        SyncKeyPolicyMode::CustomPassphrase
    );
    assert!(manifest.has_recovery_key);
    assert!(manifest.recovery_key_wrap_salt.is_some());
    assert!(manifest.recovery_key_wrap_nonce.is_some());
    assert!(manifest.recovery_key_wrap_ciphertext.is_some());

    // Apply wrap without recovery -> should clear recovery slot
    let wrap_without_recovery = RemoteCollectionKeyWrapV1 {
        version: REMOTE_KEY_WRAP_VERSION,
        provider: "google".to_string(),
        sync_collection_id: "col-123".to_string(),
        key_policy_mode: SyncKeyPolicyMode::LocalPassphrase,
        key_wrap_salt: valid_b64.clone(),
        key_wrap_nonce: valid_nonce_b64.clone(),
        key_wrap_ciphertext: valid_b64.clone(),
        recovery_key_wrap_salt: None,
        recovery_key_wrap_nonce: None,
        recovery_key_wrap_ciphertext: None,
    };

    apply_remote_key_wrap_to_manifest(&mut manifest, &wrap_without_recovery)
        .expect("wrap without recovery should apply");

    assert_eq!(manifest.key_policy_mode, SyncKeyPolicyMode::LocalPassphrase);
    assert!(!manifest.has_recovery_key);
    assert!(manifest.recovery_key_wrap_salt.is_none());
    assert!(manifest.recovery_key_wrap_nonce.is_none());
    assert!(manifest.recovery_key_wrap_ciphertext.is_none());
}
