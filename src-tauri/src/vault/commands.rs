use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::Mutex;
use zeroize::Zeroize;

use crate::types::SavedData;
use crate::vault::error::VaultError;
use crate::vault::secure_to_vault::{SecureToVaultPreview, SecureToVaultResult};
use crate::vault::store::VaultService;
use crate::vault::types::{PlaintextRecord, RevisionMeta, VaultItemMeta, VaultStatus};

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
            VaultError::Locked => ("locked", e.to_string()),
            VaultError::WrongPassphrase => ("wrong_passphrase", e.to_string()),
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

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn vault_status(vault: State<'_, Mutex<VaultService>>) -> VaultResult<VaultStatus> {
    vault.lock().await.status().map_err(Into::into)
}

#[derive(Deserialize)]
pub struct InitializeArgs {
    pub passphrase: SecretString,
}

#[tauri::command]
pub async fn vault_initialize(
    vault: State<'_, Mutex<VaultService>>,
    args: InitializeArgs,
) -> VaultResult<VaultStatus> {
    vault
        .lock()
        .await
        .initialize(args.passphrase.expose_secret())
        .map_err(Into::into)
}

#[derive(Deserialize)]
pub struct UnlockArgs {
    pub passphrase: SecretString,
}

#[tauri::command]
pub async fn vault_unlock(
    vault: State<'_, Mutex<VaultService>>,
    args: UnlockArgs,
) -> VaultResult<VaultStatus> {
    vault
        .lock()
        .await
        .unlock(args.passphrase.expose_secret())
        .map_err(Into::into)
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
    pub secret: SecretString,
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

#[tauri::command]
pub async fn vault_item_create(
    vault: State<'_, Mutex<VaultService>>,
    args: ItemCreateArgs,
) -> VaultResult<VaultItemMeta> {
    let vault = vault.lock().await;
    let record = if let Some(credential_id) = args.credential_id.as_deref() {
        vault
            .item_create_with_logical_id(
                &args.label,
                &args.kind,
                args.secret.expose_secret(),
                args.notes.as_deref(),
                Some(credential_id),
            )
            .map_err(VaultCommandError::from)?
    } else {
        vault
            .item_create(
                &args.label,
                &args.kind,
                args.secret.expose_secret(),
                args.notes.as_deref(),
            )
            .map_err(VaultCommandError::from)?
    };
    vault.item_meta(&record).map_err(Into::into)
}

#[tauri::command]
pub async fn vault_item_list(
    vault: State<'_, Mutex<VaultService>>,
) -> VaultResult<Vec<VaultItemMeta>> {
    let vault = vault.lock().await;
    let items = vault.item_list().map_err(VaultCommandError::from)?;
    items
        .into_iter()
        .map(|record| vault.item_meta(&record).map_err(Into::into))
        .collect()
}

#[derive(Deserialize)]
pub struct ItemGetArgs {
    pub item_id: String,
}

#[tauri::command]
pub async fn vault_item_get(
    vault: State<'_, Mutex<VaultService>>,
    args: ItemGetArgs,
) -> VaultResult<PlaintextRecord> {
    vault
        .lock()
        .await
        .item_get(&args.item_id)
        .map_err(Into::into)
}

#[derive(Deserialize)]
pub struct ItemDeleteArgs {
    pub item_id: String,
}

#[tauri::command]
pub async fn vault_item_delete(
    vault: State<'_, Mutex<VaultService>>,
    args: ItemDeleteArgs,
) -> VaultResult<()> {
    vault
        .lock()
        .await
        .item_delete(&args.item_id)
        .map_err(Into::into)
}

#[derive(Deserialize)]
pub struct ItemUpdateArgs {
    pub item_id: String,
    pub label: String,
    pub kind: String,
    pub secret: SecretString,
    pub notes: Option<String>,
}

impl Drop for ItemUpdateArgs {
    fn drop(&mut self) {
        if let Some(notes) = &mut self.notes {
            notes.zeroize();
        }
    }
}

#[tauri::command]
pub async fn vault_item_update(
    vault: State<'_, Mutex<VaultService>>,
    args: ItemUpdateArgs,
) -> VaultResult<VaultItemMeta> {
    let vault = vault.lock().await;
    let record = vault
        .item_update(
            &args.item_id,
            &args.label,
            &args.kind,
            args.secret.expose_secret(),
            args.notes.as_deref(),
        )
        .map_err(VaultCommandError::from)?;
    vault.item_meta(&record).map_err(Into::into)
}

// ── Revision history commands ─────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ItemRevisionHistoryArgs {
    pub item_id: String,
}

#[tauri::command]
pub async fn vault_item_revision_history(
    vault: State<'_, Mutex<VaultService>>,
    args: ItemRevisionHistoryArgs,
) -> VaultResult<Vec<RevisionMeta>> {
    vault
        .lock()
        .await
        .item_revision_history(&args.item_id)
        .map_err(Into::into)
}

#[derive(Deserialize)]
pub struct ItemRestoreRevisionArgs {
    pub item_id: String,
    pub revision: u64,
}

#[tauri::command]
pub async fn vault_item_restore_revision(
    vault: State<'_, Mutex<VaultService>>,
    args: ItemRestoreRevisionArgs,
) -> VaultResult<VaultItemMeta> {
    let vault = vault.lock().await;
    let record = vault
        .item_restore_revision(&args.item_id, args.revision)
        .map_err(VaultCommandError::from)?;
    vault.item_meta(&record).map_err(Into::into)
}

// ── Recovery key commands ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn vault_generate_recovery_key(
    vault: State<'_, Mutex<VaultService>>,
) -> VaultResult<String> {
    vault
        .lock()
        .await
        .generate_recovery_key()
        .map_err(Into::into)
}

#[tauri::command]
pub async fn vault_has_recovery_key(vault: State<'_, Mutex<VaultService>>) -> VaultResult<bool> {
    vault.lock().await.has_recovery_key().map_err(Into::into)
}

#[derive(Deserialize)]
pub struct UnlockWithRecoveryKeyArgs {
    pub recovery_key: SecretString,
}

#[tauri::command]
pub async fn vault_unlock_with_recovery_key(
    vault: State<'_, Mutex<VaultService>>,
    args: UnlockWithRecoveryKeyArgs,
) -> VaultResult<VaultStatus> {
    vault
        .lock()
        .await
        .unlock_with_recovery_key(args.recovery_key.expose_secret())
        .map_err(Into::into)
}

// ── Export / Import commands ──────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ExportArgs {
    pub dest_path: String,
}

#[tauri::command]
pub async fn vault_export(
    vault: State<'_, Mutex<VaultService>>,
    args: ExportArgs,
) -> VaultResult<()> {
    let dest_path = validate_export_path(&args.dest_path)?;
    vault
        .lock()
        .await
        .export_vault(&dest_path)
        .map_err(Into::into)
}

#[derive(Deserialize)]
pub struct ImportArgs {
    pub src_path: String,
}

#[tauri::command]
pub async fn vault_import(
    vault: State<'_, Mutex<VaultService>>,
    args: ImportArgs,
) -> VaultResult<VaultStatus> {
    let src_path = validate_import_path(&args.src_path)?;
    vault
        .lock()
        .await
        .import_vault(&src_path)
        .map_err(Into::into)
}

// ── Secure-to-vault commands ──────────────────────────────────────────────────

#[tauri::command]
pub async fn vault_secure_to_vault_preview(
    app: tauri::AppHandle,
) -> VaultResult<SecureToVaultPreview> {
    let data_dir = crate::commands::get_data_dir(&app);
    crate::vault::secure_to_vault::preview(&data_dir).map_err(Into::into)
}

#[tauri::command]
pub async fn vault_secure_to_vault(
    app: tauri::AppHandle,
    vault: State<'_, Mutex<VaultService>>,
) -> VaultResult<SecureToVaultResult> {
    let data_dir = crate::commands::get_data_dir(&app);
    let guard = vault.lock().await;
    crate::vault::secure_to_vault::secure(&data_dir, &guard).map_err(Into::into)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultBackfillResult {
    pub updated: u32,
    pub relinked_item_ids: u32,
    pub skipped_missing_items: u32,
}

#[tauri::command]
pub async fn vault_backfill_connection_refs(
    app: tauri::AppHandle,
    vault: State<'_, Mutex<VaultService>>,
) -> VaultResult<VaultBackfillResult> {
    let data_dir = crate::commands::get_data_dir(&app);
    let guard = vault.lock().await;
    repair_connection_refs(&data_dir, &guard).map_err(Into::into)
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
    std::fs::rename(&tmp, path)
        .map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            VaultError::InvalidData(format!("connections atomic rename: {e}"))
        })
}

pub fn repair_connection_refs(
    data_dir: &std::path::Path,
    vault: &VaultService,
) -> Result<VaultBackfillResult, VaultError> {
    // Lock ordering invariant: callers must hold the vault-level Mutex<VaultService>
    // BEFORE acquiring CONNECTIONS_MUTATION_LOCK. Reversing this order risks deadlock
    // because other code paths (e.g. ssh_connect relink persistence) acquire the
    // connections lock first and then call vault methods. Always: vault lock → connections lock.
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
        if auth_ref.vault_id != active_vault_id {
            skipped_missing_items = skipped_missing_items.saturating_add(1);
            continue;
        }

        match vault.item_get(&auth_ref.item_id) {
            Ok(record) => {
                let logical_id = VaultService::record_logical_id(&record);
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
