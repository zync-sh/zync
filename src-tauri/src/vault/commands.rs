use std::collections::BTreeMap;

use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::Mutex;
use zeroize::Zeroize;

use crate::types::SavedData;
use crate::vault::credential::validate_secret_values_for_kind;
use crate::vault::error::VaultError;
use crate::vault::secure_to_vault::{SecureToVaultPreview, SecureToVaultResult};
use crate::vault::store::VaultService;
use crate::vault::types::{RevisionMeta, VaultItemDetail, VaultItemMeta, VaultStatus};

// ── Error wrapper (serializable for IPC) ─────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct VaultCommandError {
    pub code: String,
    pub message: String,
}

impl From<VaultError> for VaultCommandError {
    fn from(e: VaultError) -> Self {
        let (code, message) = match &e {
            VaultError::NotInitialized => ("not_initialized", e.to_string()),
            VaultError::AlreadyInitialized => ("already_initialized", e.to_string()),
            VaultError::InUseByAnotherInstance => ("vault_in_use", e.to_string()),
            VaultError::Locked => ("locked", e.to_string()),
            VaultError::WrongPassphrase => ("wrong_passphrase", e.to_string()),
            VaultError::RecoveryAuthorizationRequired => {
                ("recovery_authorization_required", e.to_string())
            }
            VaultError::InvalidPassphraseLength { .. } => {
                ("invalid_passphrase_length", e.to_string())
            }
            VaultError::RecordNotFound(_) => ("not_found", e.to_string()),
            _ => ("error", e.to_string()),
        };
        Self {
            code: code.to_string(),
            message,
        }
    }
}

type VaultResult<T> = Result<T, VaultCommandError>;

/// Marks synchronous vault work as blocking while preserving its already-acquired mutex guard.
/// Requires Tauri's multi-thread Tokio runtime; `block_in_place` cannot run on a current-thread
/// runtime. The vault mutex bounds operations to one owner and retains FIFO acquisition order.
/// The closure and borrowed secrets stay on this call stack; no detached mutation is created.
fn run_vault_blocking<T>(operation: impl FnOnce() -> T) -> T {
    tokio::task::block_in_place(operation)
}

#[cfg(test)]
mod runtime_tests;

// ── Commands ──────────────────────────────────────────────────────────────────

/// Loads database/session-cache status under the existing vault lock on a blocking boundary.
#[tauri::command]
pub async fn vault_status(vault: State<'_, Mutex<VaultService>>) -> VaultResult<VaultStatus> {
    let mut vault = vault.lock().await;
    run_vault_blocking(|| vault.status().map_err(Into::into))
}

fn migrate_legacy_api_keys(app: &tauri::AppHandle, vault: &VaultService) -> VaultResult<()> {
    crate::ai::migrate_legacy_api_keys(app, vault).map_err(|message| VaultCommandError {
        code: "migration_failed".into(),
        message,
    })
}

#[derive(Deserialize)]
pub struct InitializeArgs {
    pub passphrase: SecretString,
    #[serde(default)]
    pub remember_on_device: bool,
}

/// Initializes the encrypted vault and migrates API keys under one serialized blocking owner.
#[tauri::command]
pub async fn vault_initialize(
    app: tauri::AppHandle,
    vault: State<'_, Mutex<VaultService>>,
    args: InitializeArgs,
) -> VaultResult<VaultStatus> {
    let mut vault = vault.lock().await;
    run_vault_blocking(|| {
        let status = vault
            .initialize(args.passphrase.expose_secret(), args.remember_on_device)
            .map_err(VaultCommandError::from)?;
        migrate_legacy_api_keys(&app, &vault)?;
        Ok(status)
    })
}

#[derive(Deserialize)]
pub struct UnlockArgs {
    pub passphrase: SecretString,
    #[serde(default)]
    pub remember_on_device: bool,
}

/// Unlocks and migrates the vault without occupying an async worker with KDF/database work.
#[tauri::command]
pub async fn vault_unlock(
    app: tauri::AppHandle,
    vault: State<'_, Mutex<VaultService>>,
    args: UnlockArgs,
) -> VaultResult<VaultStatus> {
    let mut vault = vault.lock().await;
    run_vault_blocking(|| {
        let status = vault
            .unlock(args.passphrase.expose_secret(), args.remember_on_device)
            .map_err(VaultCommandError::from)?;
        migrate_legacy_api_keys(&app, &vault)?;
        Ok(status)
    })
}

/// Clears remembered-device storage while retaining vault serialization.
#[tauri::command]
pub async fn vault_forget_device(vault: State<'_, Mutex<VaultService>>) -> VaultResult<()> {
    let mut vault = vault.lock().await;
    run_vault_blocking(|| vault.forget_device_session().map_err(Into::into))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultResetLocalResult {
    pub status: VaultStatus,
    pub cleared_auth_refs: u32,
}

/// Destructive local reset when the user lost passphrase and recovery key.
/// Wipes vault files + local sync-collection cache, clears remember-device,
/// and strips host `authRef` links. Does not delete remote provider data.
#[tauri::command]
pub async fn vault_reset_local(
    app: tauri::AppHandle,
    vault: State<'_, Mutex<VaultService>>,
) -> VaultResult<VaultResetLocalResult> {
    // Lock order: vault mutex, then CONNECTIONS_MUTATION_LOCK. Hold both across
    // strip + wipe so connections_save / secure_to_vault cannot write authRef
    // data into the gap. If wipe fails after strip, credentials remain and
    // hosts can be re-linked; the reverse order can leave dangling authRefs.
    let mut vault = vault.lock().await;
    let (cleared_auth_refs, status) = run_vault_blocking(|| {
        let data_dir = crate::commands::get_data_dir(&app);
        let _connections_guard = crate::commands::CONNECTIONS_MUTATION_LOCK
            .lock()
            .map_err(|error| VaultError::InvalidData(format!("lock connections file: {error}")))?;
        let cleared_auth_refs = strip_connection_auth_refs_locked(&data_dir)?;
        let status = vault.reset_local()?;
        Ok::<_, VaultError>((cleared_auth_refs, status))
    })
    .map_err(VaultCommandError::from)?;
    Ok(VaultResetLocalResult {
        status,
        cleared_auth_refs,
    })
}

#[tauri::command]
pub async fn vault_lock(vault: State<'_, Mutex<VaultService>>) -> VaultResult<()> {
    vault.lock().await.lock();
    Ok(())
}

#[derive(Deserialize)]
pub struct ItemCreateArgs {
    pub label: String,
    pub kind: String,
    #[serde(default)]
    pub secret: Option<SecretString>,
    #[serde(default)]
    pub secret_values: Option<BTreeMap<String, SecretString>>,
    pub notes: Option<String>,
    pub credential_id: Option<String>,
}

impl Drop for ItemCreateArgs {
    fn drop(&mut self) {
        if let Some(notes) = &mut self.notes {
            notes.zeroize();
        }
    }
}

/// Creates and projects a credential under the existing lock on the blocking boundary.
#[tauri::command]
pub async fn vault_item_create(
    vault: State<'_, Mutex<VaultService>>,
    args: ItemCreateArgs,
) -> VaultResult<VaultItemMeta> {
    let vault = vault.lock().await;
    run_vault_blocking(|| {
        let record =
            if let Some(secret_values) = args.secret_values.as_ref().filter(|v| !v.is_empty()) {
                let mut sanitized = sanitize_secret_values(&args.kind, secret_values)?;
                let result = vault.item_create_with_secret_values(
                    &args.label,
                    &args.kind,
                    &sanitized,
                    args.notes.as_deref(),
                    args.credential_id.as_deref(),
                );
                zeroize_secret_values(&mut sanitized);
                result.map_err(VaultCommandError::from)?
            } else {
                let secret = args
                    .secret
                    .as_ref()
                    .filter(|secret| !secret.expose_secret().trim().is_empty())
                    .ok_or_else(|| VaultCommandError {
                        code: "invalid_secret_values".into(),
                        message: "Credential requires at least one non-empty secret value".into(),
                    })?;
                vault
                    .item_create_with_logical_id(
                        &args.label,
                        &args.kind,
                        secret.expose_secret(),
                        args.notes.as_deref(),
                        args.credential_id.as_deref(),
                    )
                    .map_err(VaultCommandError::from)?
            };
        vault.item_meta(&record).map_err(Into::into)
    })
}

/// Loads credential metadata under the existing lock without blocking an async worker.
#[tauri::command]
pub async fn vault_item_list(
    vault: State<'_, Mutex<VaultService>>,
) -> VaultResult<Vec<VaultItemMeta>> {
    let vault = vault.lock().await;
    run_vault_blocking(|| {
        let items = vault.item_list().map_err(VaultCommandError::from)?;
        items
            .into_iter()
            .map(|record| vault.item_meta(&record).map_err(Into::into))
            .collect()
    })
}

#[derive(Deserialize)]
pub struct ItemGetArgs {
    pub item_id: String,
}

/// Reads credential details and fingerprints atomically on the blocking boundary.
#[tauri::command]
pub async fn vault_item_get(
    vault: State<'_, Mutex<VaultService>>,
    args: ItemGetArgs,
) -> VaultResult<VaultItemDetail> {
    let vault = vault.lock().await;
    run_vault_blocking(|| {
        let record = vault
            .item_get(&args.item_id)
            .map_err(VaultCommandError::from)?;
        Ok(VaultItemDetail {
            logical_id: VaultService::record_logical_id(&record),
            secret_fingerprint: vault
                .record_secret_fingerprint(&record)
                .map_err(VaultCommandError::from)?,
            id: record.id.clone(),
            kind: record.kind.clone(),
            label: record.label.clone(),
            notes: record.notes.clone(),
            credential: record.credential.clone(),
            revision: record.revision,
            created_at: record.created_at,
            updated_at: record.updated_at,
        })
    })
}

#[derive(Deserialize)]
pub struct ItemDeleteArgs {
    pub item_id: String,
}

/// Deletes a credential with the existing serialized database semantics.
#[tauri::command]
pub async fn vault_item_delete(
    vault: State<'_, Mutex<VaultService>>,
    args: ItemDeleteArgs,
) -> VaultResult<()> {
    let vault = vault.lock().await;
    run_vault_blocking(|| vault.item_delete(&args.item_id).map_err(Into::into))
}

#[derive(Deserialize)]
pub struct ItemUpdateArgs {
    pub item_id: String,
    pub label: String,
    pub kind: String,
    #[serde(default)]
    pub secret: Option<SecretString>,
    #[serde(default)]
    pub secret_values: Option<BTreeMap<String, SecretString>>,
    pub notes: Option<String>,
}

impl Drop for ItemUpdateArgs {
    fn drop(&mut self) {
        if let Some(notes) = &mut self.notes {
            notes.zeroize();
        }
    }
}

/// Updates and projects a credential under one serialized blocking operation.
#[tauri::command]
pub async fn vault_item_update(
    vault: State<'_, Mutex<VaultService>>,
    args: ItemUpdateArgs,
) -> VaultResult<VaultItemMeta> {
    let vault = vault.lock().await;
    run_vault_blocking(|| {
        let record =
            if let Some(secret_values) = args.secret_values.as_ref().filter(|v| !v.is_empty()) {
                let mut sanitized = sanitize_secret_values(&args.kind, secret_values)?;
                let result = vault.item_update_with_secret_values(
                    &args.item_id,
                    &args.label,
                    &args.kind,
                    &sanitized,
                    args.notes.as_deref(),
                    None,
                );
                zeroize_secret_values(&mut sanitized);
                result.map_err(VaultCommandError::from)?
            } else {
                let secret = args
                    .secret
                    .as_ref()
                    .filter(|secret| !secret.expose_secret().trim().is_empty())
                    .ok_or_else(|| VaultCommandError {
                        code: "invalid_secret_values".into(),
                        message: "Credential requires at least one non-empty secret value".into(),
                    })?;
                vault
                    .item_update(
                        &args.item_id,
                        &args.label,
                        &args.kind,
                        secret.expose_secret(),
                        args.notes.as_deref(),
                    )
                    .map_err(VaultCommandError::from)?
            };
        vault.item_meta(&record).map_err(Into::into)
    })
}

#[derive(Deserialize)]
pub struct SetSshCertificateArgs {
    pub item_id: String,
    pub expected_revision: u64,
    pub expected_secret_fingerprint: String,
    pub certificate: Option<SecretString>,
}

/// Renew/remove a certificate without returning or resubmitting the private key through IPC.
#[tauri::command]
pub async fn vault_item_set_ssh_certificate(
    vault: State<'_, Mutex<VaultService>>,
    args: SetSshCertificateArgs,
) -> VaultResult<VaultItemMeta> {
    let vault = vault.lock().await;
    run_vault_blocking(|| {
        let record = vault
            .item_set_ssh_certificate(
                &args.item_id,
                args.expected_revision,
                &args.expected_secret_fingerprint,
                args.certificate.as_ref().map(|value| value.expose_secret()),
            )
            .map_err(VaultCommandError::from)?;
        vault.item_meta(&record).map_err(Into::into)
    })
}

/// Trim pasted key/certificate text, preserving passphrase bytes required to decrypt a key.
fn sanitize_secret_values(
    kind: &str,
    values: &BTreeMap<String, SecretString>,
) -> Result<BTreeMap<String, String>, VaultCommandError> {
    let mut sanitized = BTreeMap::new();
    for (name, value) in values {
        let trimmed = value.expose_secret().trim();
        let sanitized_value = if name == crate::vault::credential::PASSPHRASE_FIELD {
            value.expose_secret()
        } else {
            trimmed
        };
        if !sanitized_value.is_empty() {
            sanitized.insert(name.clone(), sanitized_value.to_string());
        }
    }
    validate_secret_values_for_kind(kind, &sanitized).map_err(|message| VaultCommandError {
        code: "invalid_secret_values".into(),
        message,
    })?;
    Ok(sanitized)
}

fn zeroize_secret_values(values: &mut BTreeMap<String, String>) {
    for value in values.values_mut() {
        value.zeroize();
    }
    values.clear();
}

#[cfg(test)]
mod ssh_certificate_secret_tests {
    use super::*;

    #[test]
    fn certificate_input_trims_public_text_without_changing_passphrase_bytes() {
        for passphrase in [" fixture ", "   "] {
            let values = BTreeMap::from([
                (
                    "privateKey".into(),
                    SecretString::from(" key text ".to_string()),
                ),
                (
                    "passphrase".into(),
                    SecretString::from(passphrase.to_string()),
                ),
                (
                    "sshCertificate".into(),
                    SecretString::from(" certificate text \n".to_string()),
                ),
            ]);
            let mut result = sanitize_secret_values("ssh-private-key", &values).unwrap();
            assert_eq!(result["privateKey"], "key text");
            assert_eq!(result["passphrase"], passphrase);
            assert_eq!(result["sshCertificate"], "certificate text");
            zeroize_secret_values(&mut result);
        }
    }
}

// ── Revision history commands ─────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ItemRevisionHistoryArgs {
    pub item_id: String,
}

/// Reads credential revision history on the blocking boundary.
#[tauri::command]
pub async fn vault_item_revision_history(
    vault: State<'_, Mutex<VaultService>>,
    args: ItemRevisionHistoryArgs,
) -> VaultResult<Vec<RevisionMeta>> {
    let vault = vault.lock().await;
    run_vault_blocking(|| {
        vault
            .item_revision_history(&args.item_id)
            .map_err(Into::into)
    })
}

#[derive(Deserialize)]
pub struct ItemRestoreRevisionArgs {
    pub item_id: String,
    pub revision: u64,
}

/// Restores and projects a revision under one serialized blocking operation.
#[tauri::command]
pub async fn vault_item_restore_revision(
    vault: State<'_, Mutex<VaultService>>,
    args: ItemRestoreRevisionArgs,
) -> VaultResult<VaultItemMeta> {
    let vault = vault.lock().await;
    run_vault_blocking(|| {
        let record = vault
            .item_restore_revision(&args.item_id, args.revision)
            .map_err(VaultCommandError::from)?;
        vault.item_meta(&record).map_err(Into::into)
    })
}

// ── Recovery key commands ─────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ChangePassphraseArgs {
    #[serde(default)]
    pub current_passphrase: Option<SecretString>,
    pub new_passphrase: SecretString,
    #[serde(default)]
    pub remember_on_device: bool,
}

/// Change or set the vault passphrase without deleting credentials.
#[tauri::command]
pub async fn vault_change_passphrase(
    vault: State<'_, Mutex<VaultService>>,
    args: ChangePassphraseArgs,
) -> VaultResult<VaultStatus> {
    let mut vault = vault.lock().await;
    run_vault_blocking(|| {
        vault
            .change_passphrase(
                args.current_passphrase
                    .as_ref()
                    .map(|value| value.expose_secret()),
                args.new_passphrase.expose_secret(),
                args.remember_on_device,
            )
            .map_err(Into::into)
    })
}

/// Generates and persists a recovery slot under the existing vault lock.
#[tauri::command]
pub async fn vault_generate_recovery_key(
    vault: State<'_, Mutex<VaultService>>,
) -> VaultResult<String> {
    let mut vault = vault.lock().await;
    run_vault_blocking(|| vault.generate_recovery_key().map_err(Into::into))
}

/// Checks the recovery slot on the blocking boundary under the existing lock.
#[tauri::command]
pub async fn vault_has_recovery_key(vault: State<'_, Mutex<VaultService>>) -> VaultResult<bool> {
    let mut vault = vault.lock().await;
    run_vault_blocking(|| vault.has_recovery_key().map_err(Into::into))
}

#[derive(Deserialize)]
pub struct UnlockWithRecoveryKeyArgs {
    pub recovery_key: SecretString,
    #[serde(default)]
    pub remember_on_device: bool,
}

/// Restores and migrates the vault under one serialized blocking operation.
#[tauri::command]
pub async fn vault_unlock_with_recovery_key(
    app: tauri::AppHandle,
    vault: State<'_, Mutex<VaultService>>,
    args: UnlockWithRecoveryKeyArgs,
) -> VaultResult<VaultStatus> {
    let mut vault = vault.lock().await;
    run_vault_blocking(|| {
        let status = vault
            .unlock_with_recovery_key(args.recovery_key.expose_secret(), args.remember_on_device)
            .map_err(VaultCommandError::from)?;
        migrate_legacy_api_keys(&app, &vault)?;
        Ok(status)
    })
}

// ── Export / Import commands ──────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ExportArgs {
    pub dest_path: String,
}

/// Validates and exports the encrypted vault under the existing serialized owner.
#[tauri::command]
pub async fn vault_export(
    vault: State<'_, Mutex<VaultService>>,
    args: ExportArgs,
) -> VaultResult<()> {
    let mut vault = vault.lock().await;
    run_vault_blocking(|| {
        let dest_path = validate_export_path(&args.dest_path)?;
        vault.export_vault(&dest_path).map_err(Into::into)
    })
}

#[derive(Deserialize)]
pub struct ImportArgs {
    pub src_path: String,
}

/// Validates and imports an encrypted vault under the existing serialized owner.
#[tauri::command]
pub async fn vault_import(
    vault: State<'_, Mutex<VaultService>>,
    args: ImportArgs,
) -> VaultResult<VaultStatus> {
    let mut vault = vault.lock().await;
    run_vault_blocking(|| {
        let src_path = validate_import_path(&args.src_path)?;
        vault.import_vault(&src_path).map_err(Into::into)
    })
}

// ── Secure-to-vault commands ──────────────────────────────────────────────────

/// Reads the local migration preview on a blocking boundary without mutating credentials.
#[tauri::command]
pub async fn vault_secure_to_vault_preview(
    app: tauri::AppHandle,
) -> VaultResult<SecureToVaultPreview> {
    run_vault_blocking(|| {
        let data_dir = crate::commands::get_data_dir(&app);
        crate::vault::secure_to_vault::preview(&data_dir).map_err(Into::into)
    })
}

/// Migrates local credentials on the blocking boundary while preserving vault-first lock order.
#[tauri::command]
pub async fn vault_secure_to_vault(
    app: tauri::AppHandle,
    vault: State<'_, Mutex<VaultService>>,
) -> VaultResult<SecureToVaultResult> {
    let guard = vault.lock().await;
    run_vault_blocking(|| {
        let data_dir = crate::commands::get_data_dir(&app);
        crate::vault::secure_to_vault::secure(&data_dir, &guard).map_err(Into::into)
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultBackfillResult {
    pub updated: u32,
    pub relinked_item_ids: u32,
    pub skipped_missing_items: u32,
}

/// Repairs credential references under the existing vault-first blocking boundary.
#[tauri::command]
pub async fn vault_backfill_connection_refs(
    app: tauri::AppHandle,
    vault: State<'_, Mutex<VaultService>>,
) -> VaultResult<VaultBackfillResult> {
    let guard = vault.lock().await;
    run_vault_blocking(|| {
        let data_dir = crate::commands::get_data_dir(&app);
        repair_connection_refs(&data_dir, &guard).map_err(Into::into)
    })
}

fn validate_export_path(path: &str) -> VaultResult<std::path::PathBuf> {
    let path = std::path::PathBuf::from(path);
    let parent = path.parent().ok_or_else(|| VaultCommandError {
        code: "invalid_path".into(),
        message: "Export path must have a parent directory".into(),
    })?;
    let canonical_parent = std::fs::canonicalize(parent).map_err(|e| VaultCommandError {
        code: "invalid_path".into(),
        message: format!("Export parent does not exist or is not accessible: {e}"),
    })?;
    let file_name = path.file_name().ok_or_else(|| VaultCommandError {
        code: "invalid_path".into(),
        message: "Export path must include a file name".into(),
    })?;
    Ok(canonical_parent.join(file_name))
}

fn validate_import_path(path: &str) -> VaultResult<std::path::PathBuf> {
    let path_buf = std::fs::canonicalize(path).map_err(|e| VaultCommandError {
        code: "invalid_path".into(),
        message: format!("Import file does not exist or is not accessible: {e}"),
    })?;
    if !path_buf.is_file() {
        return Err(VaultCommandError {
            code: "invalid_path".into(),
            message: format!(
                "Import file does not exist or is not accessible: {}",
                path_buf.display()
            ),
        });
    }
    Ok(path_buf)
}

fn load_saved_connections(path: &std::path::Path) -> Result<SavedData, VaultError> {
    if !path.exists() {
        return Ok(SavedData {
            connections: vec![],
            folders: vec![],
        });
    }
    let raw = std::fs::read_to_string(path)
        .map_err(|e| VaultError::InvalidData(format!("read connections file: {e}")))?;
    serde_json::from_str(&raw).map_err(VaultError::Serde)
}

/// Strip vault `authRef` links from local hosts after a vault wipe.
/// Leaves `privateKeyPath` and non-vault passwords intact.
/// Caller must already hold `CONNECTIONS_MUTATION_LOCK`.
fn strip_connection_auth_refs_locked(data_dir: &std::path::Path) -> Result<u32, VaultError> {
    let path = data_dir.join("connections.json");
    let mut saved = load_saved_connections(&path)?;
    let mut cleared = 0u32;
    let mut changed = false;
    for connection in &mut saved.connections {
        if connection.auth_ref.take().is_some() {
            cleared = cleared.saturating_add(1);
            changed = true;
        }
    }
    if changed {
        save_saved_connections(&path, &saved)?;
    }
    Ok(cleared)
}

fn save_saved_connections(path: &std::path::Path, saved: &SavedData) -> Result<(), VaultError> {
    use std::io::Write;
    let json = serde_json::to_string_pretty(saved).map_err(VaultError::Serde)?;
    let unique_suffix = uuid::Uuid::new_v4();
    let tmp = path.with_extension(format!("json.tmp.{unique_suffix}"));
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&tmp)
        .map_err(|e| VaultError::InvalidData(format!("connections tmp write open: {e}")))?;
    f.write_all(json.as_bytes())
        .map_err(|e| VaultError::InvalidData(format!("connections tmp write: {e}")))?;
    f.sync_all()
        .map_err(|e| VaultError::InvalidData(format!("connections tmp sync: {e}")))?;
    drop(f);
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            let kind = error.kind();
            #[cfg(windows)]
            let raw = error.raw_os_error();
            #[cfg(not(windows))]
            let raw: Option<i32> = error.raw_os_error();

            if kind == std::io::ErrorKind::PermissionDenied {
                let _ = std::fs::remove_file(&tmp);
                return Err(VaultError::InvalidData(format!(
                    "connections file is locked or permission denied during replace: {error}"
                )));
            }
            if path.is_dir() {
                let _ = std::fs::remove_file(&tmp);
                return Err(VaultError::InvalidData(
                    "connections save target is a directory, not a file".into(),
                ));
            }
            if raw == Some(18) {
                std::fs::copy(&tmp, path).map_err(|copy_error| {
                    let _ = std::fs::remove_file(&tmp);
                    VaultError::InvalidData(format!(
                        "connections save cross-device fallback copy failed: {copy_error}"
                    ))
                })?;
                std::fs::remove_file(&tmp).map_err(|cleanup_error| {
                    VaultError::InvalidData(format!(
                        "connections save fallback cleanup failed: {cleanup_error}"
                    ))
                })?;
                return Ok(());
            }
            if path.is_file() {
                let backup = path.with_extension(format!("json.bak.{unique_suffix}"));
                if let Err(backup_error) = std::fs::rename(path, &backup) {
                    let _ = std::fs::remove_file(&tmp);
                    return Err(VaultError::InvalidData(format!(
                        "connections atomic rename failed and destination could not be staged: {backup_error}"
                    )));
                }
                match std::fs::rename(&tmp, path) {
                    Ok(()) => {
                        let _ = std::fs::remove_file(&backup);
                        return Ok(());
                    }
                    Err(retry_error) => {
                        let restore_error = std::fs::rename(&backup, path).err();
                        let _ = std::fs::remove_file(&tmp);
                        return Err(VaultError::InvalidData(format!(
                            "connections atomic replace retry failed: {retry_error}; backup restore: {}",
                            restore_error
                                .map(|error| error.to_string())
                                .unwrap_or_else(|| "succeeded".to_string())
                        )));
                    }
                }
            }
            let _ = std::fs::remove_file(&tmp);
            Err(VaultError::InvalidData(format!(
                "connections atomic rename failed: {error}"
            )))
        }
    }
}

pub fn repair_connection_refs(
    data_dir: &std::path::Path,
    vault: &VaultService,
) -> Result<VaultBackfillResult, VaultError> {
    // Lock ordering invariant: hold the vault-level Mutex<VaultService> before
    // taking CONNECTIONS_MUTATION_LOCK so vault-backed connection repair and
    // persistence paths do not invert file/vault mutation order in the future.
    let path = data_dir.join("connections.json");
    let _connections_guard = crate::commands::CONNECTIONS_MUTATION_LOCK
        .lock()
        .map_err(|e| VaultError::InvalidData(format!("lock connections file: {e}")))?;
    let mut saved = load_saved_connections(&path)?;
    let mut updated = 0u32;
    let mut relinked_item_ids = 0u32;
    let mut skipped_missing_items = 0u32;
    let mut changed = false;
    let active_vault_id = vault.vault_id().ok_or(VaultError::Locked)?;

    for connection in &mut saved.connections {
        let Some(auth_ref) = connection.auth_ref.as_mut() else {
            continue;
        };

        let item_lookup = vault.item_get(&auth_ref.item_id);

        match item_lookup {
            Ok(record) => {
                let logical_id = VaultService::record_logical_id(&record);
                if auth_ref.vault_id != active_vault_id {
                    auth_ref.vault_id = active_vault_id.clone();
                    updated = updated.saturating_add(1);
                    changed = true;
                }
                if auth_ref.credential_id.as_deref() != Some(logical_id.as_str()) {
                    auth_ref.credential_id = Some(logical_id);
                    updated = updated.saturating_add(1);
                    changed = true;
                }
            }
            Err(VaultError::RecordNotFound(_)) => {
                let Some(credential_id) = auth_ref.credential_id.as_deref() else {
                    skipped_missing_items = skipped_missing_items.saturating_add(1);
                    continue;
                };
                match vault.item_get_by_logical_id(credential_id) {
                    Ok(record) => {
                        if auth_ref.vault_id != active_vault_id {
                            auth_ref.vault_id = active_vault_id.clone();
                            updated = updated.saturating_add(1);
                            changed = true;
                        }
                        if auth_ref.item_id != record.id {
                            auth_ref.item_id = record.id.clone();
                            relinked_item_ids = relinked_item_ids.saturating_add(1);
                            changed = true;
                        }
                    }
                    Err(VaultError::RecordNotFound(_)) => {
                        skipped_missing_items = skipped_missing_items.saturating_add(1);
                    }
                    Err(error) => return Err(error),
                }
            }
            Err(error) => return Err(error),
        }
    }

    if changed {
        save_saved_connections(&path, &saved)?;
    }

    Ok(VaultBackfillResult {
        updated,
        relinked_item_ids,
        skipped_missing_items,
    })
}
