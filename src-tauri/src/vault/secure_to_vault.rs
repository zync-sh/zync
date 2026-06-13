use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::types::{CredentialItemKind, CredentialPurpose, CredentialRef, SavedData};
use crate::vault::credential::secret_values_from_legacy;
use crate::vault::error::VaultError;
use crate::vault::store::VaultService;
use crate::vault::types::PlaintextRecord;

// ── Preview ───────────────────────────────────────────────────────────────────

/// One connection whose stored auth can be secured into the vault.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecureToVaultCandidate {
    pub connection_id: String,
    pub connection_name: String,
    pub host: String,
    pub secure_kind: SecureKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SecureKind {
    SshPassword,
    SshPrivateKey,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecureToVaultPreview {
    pub candidates: Vec<SecureToVaultCandidate>,
    pub already_secured: u32,
    /// Key files referenced in connections but not found on disk — cannot secure.
    pub skipped_no_file: u32,
}

/// Read connections.json and return what can be secured into the vault.
/// Does not require vault unlock.
pub fn preview(data_dir: &Path) -> Result<SecureToVaultPreview, VaultError> {
    let saved = load_connections(data_dir)?;

    let mut candidates = Vec::new();
    let mut already_secured = 0u32;
    let mut skipped_no_file = 0u32;

    for conn in &saved.connections {
        if conn.auth_ref.is_some() {
            already_secured += 1;
            continue;
        }
        if let Some(key_path) = &conn.private_key_path {
            if key_path.is_empty() {
                continue;
            }
            if !std::path::Path::new(key_path).exists() {
                skipped_no_file += 1;
                continue;
            }
            candidates.push(SecureToVaultCandidate {
                connection_id: conn.id.clone(),
                connection_name: conn.name.clone(),
                host: conn.host.clone(),
                secure_kind: SecureKind::SshPrivateKey,
            });
            continue;
        }
        if conn
            .password
            .as_deref()
            .is_some_and(|password| !password.trim().is_empty())
        {
            candidates.push(SecureToVaultCandidate {
                connection_id: conn.id.clone(),
                connection_name: conn.name.clone(),
                host: conn.host.clone(),
                secure_kind: SecureKind::SshPassword,
            });
        }
    }

    Ok(SecureToVaultPreview {
        candidates,
        already_secured,
        skipped_no_file,
    })
}

// ── Secure ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecureToVaultResult {
    pub secured: u32,
    pub skipped: u32,
    pub already_done: u32,
    pub backup_path: Option<String>,
}

/// Secure all eligible connections into vault items and rewrite connections.json.
///
/// Handles password auth (ssh-password) and key file auth (ssh-private-key).
/// Key files are read and stored in vault; original files are left untouched.
/// A backup is written to `connections.json.pre-secure-to-vault` before any change.
pub fn secure(data_dir: &Path, vault: &VaultService) -> Result<SecureToVaultResult, VaultError> {
    let connections_path = data_dir.join("connections.json");
    let backup_path = data_dir.join("connections.json.pre-secure-to-vault");
    let legacy_backup_path = data_dir.join("connections.json.pre-vault-migration");

    let mut saved = load_connections(data_dir)?;

    let mut skipped = 0u32;
    let mut already_done = 0u32;
    let vault_id = vault.vault_id().ok_or(VaultError::Locked)?;
    let mut prepared = Vec::new();

    for (index, conn) in saved.connections.iter().enumerate() {
        if conn.auth_ref.is_some() {
            already_done += 1;
            continue;
        }

        // ── Key-based auth ────────────────────────────────────────────────────
        if let Some(ref key_path) = conn.private_key_path {
            if key_path.is_empty() {
                skipped += 1;
                continue;
            }
            let key_content = match std::fs::read_to_string(key_path) {
                Ok(c) => c,
                Err(_) => {
                    skipped += 1;
                    continue;
                }
            };
            let label = format!("{} key ({}@{})", conn.name, conn.username, conn.host);
            let passphrase = conn
                .password
                .as_deref()
                .filter(|p| !p.is_empty())
                .map(|p| p.to_string());
            let secret =
                serde_json::json!({ "key": key_content, "passphrase": passphrase }).to_string();
            prepared.push(PreparedSecureItem {
                index,
                label,
                kind: CredentialItemKind::SshPrivateKey,
                secret,
            });
            continue;
        }

        // ── Password auth ─────────────────────────────────────────────────────
        let Some(password) = conn.password.clone() else {
            continue;
        };
        if password.trim().is_empty() {
            skipped = skipped.saturating_add(1);
            continue;
        }
        let label = format!("{} ({}@{})", conn.name, conn.username, conn.host);
        prepared.push(PreparedSecureItem {
            index,
            label,
            kind: CredentialItemKind::SshPassword,
            secret: password,
        });
    }

    if prepared.is_empty() {
        return Ok(SecureToVaultResult {
            secured: 0,
            skipped,
            already_done,
            backup_path: None,
        });
    }

    let original_json = std::fs::read_to_string(&connections_path).map_err(|e| {
        VaultError::InvalidData(format!("backup read failed ({connections_path:?}): {e}"))
    })?;
    if !backup_path.exists() {
        std::fs::write(&backup_path, &original_json).map_err(|e| {
            VaultError::InvalidData(format!("backup write failed ({backup_path:?}): {e}"))
        })?;
    }
    if !legacy_backup_path.exists() {
        let _ = std::fs::write(&legacy_backup_path, &original_json);
    }

    let existing_records = vault.item_list()?;
    let mut existing_by_fingerprint: HashMap<(String, String, String), (String, String, u64)> =
        HashMap::new();
    for record in existing_records {
        let fingerprint = vault.record_secret_fingerprint(&record)?;
        let key = (record.kind.clone(), record.label.clone(), fingerprint);
        let credential_id = VaultService::record_logical_id(&record);
        existing_by_fingerprint
            .entry(key)
            .and_modify(|current| {
                // Prefer the newest duplicate when earlier failed/stale secure-to-vault runs left
                // multiple records with the same generated label and secret.
                if record.created_at >= current.2 {
                    *current = (record.id.clone(), credential_id.clone(), record.created_at);
                }
            })
            .or_insert((record.id.clone(), credential_id, record.created_at));
    }

    let mut linked = Vec::new();
    let mut created_for_cleanup = Vec::new();
    for secure_item in &prepared {
        let kind = secure_item.kind.as_str();
        let fingerprint = prepared_secret_fingerprint(vault, secure_item)?;
        let lookup_key = (kind.to_string(), secure_item.label.clone(), fingerprint);
        if let Some((existing_id, credential_id, _)) = existing_by_fingerprint.get(&lookup_key) {
            linked.push((
                secure_item.index,
                existing_id.clone(),
                credential_id.clone(),
                secure_item.kind.clone(),
            ));
            continue;
        }

        match vault.item_create(&secure_item.label, kind, &secure_item.secret, None) {
            Ok(record) => {
                let credential_id = VaultService::record_logical_id(&record);
                let linked_record = (
                    secure_item.index,
                    record.id.clone(),
                    credential_id.clone(),
                    secure_item.kind.clone(),
                );
                existing_by_fingerprint.insert(
                    lookup_key,
                    (record.id.clone(), credential_id, record.created_at),
                );
                created_for_cleanup.push(linked_record.clone());
                linked.push(linked_record);
            }
            Err(e) => {
                cleanup_created_items(vault, &created_for_cleanup);
                return Err(VaultError::InvalidData(format!("vault item create: {e}")));
            }
        }
    }

    for (index, record_id, credential_id, kind) in &linked {
        let conn = &mut saved.connections[*index];
        conn.auth_ref = Some(CredentialRef {
            vault_id: vault_id.clone(),
            credential_id: Some(credential_id.clone()),
            item_id: record_id.clone(),
            item_kind: kind.clone(),
            purpose: CredentialPurpose::SshAuth,
        });
        match kind {
            CredentialItemKind::SshPrivateKey => {
                conn.private_key_path = None;
                conn.password = None;
            }
            CredentialItemKind::SshPassword => {
                conn.password = None;
            }
            CredentialItemKind::SshAgentKey => {}
        }
    }

    let secured = linked.len() as u32;
    let updated_json = serde_json::to_string_pretty(&saved).map_err(VaultError::Serde)?;
    if let Err(e) = atomic_write(&connections_path, &updated_json) {
        cleanup_created_items(vault, &created_for_cleanup);
        return Err(e);
    }

    Ok(SecureToVaultResult {
        secured,
        skipped,
        already_done,
        backup_path: Some(backup_path.to_string_lossy().into_owned()),
    })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

struct PreparedSecureItem {
    index: usize,
    label: String,
    kind: CredentialItemKind,
    secret: String,
}

fn prepared_secret_fingerprint(
    vault: &VaultService,
    item: &PreparedSecureItem,
) -> Result<String, VaultError> {
    let record = PlaintextRecord {
        id: String::new(),
        logical_id: None,
        kind: item.kind.as_str().to_string(),
        label: item.label.clone(),
        secret: String::new(),
        secret_values: secret_values_from_legacy(item.kind.as_str(), &item.secret),
        notes: None,
        credential: None,
        revision: 0,
        created_at: 0,
        updated_at: 0,
    };
    vault.record_secret_fingerprint(&record)
}

fn cleanup_created_items(
    vault: &VaultService,
    created: &[(usize, String, String, CredentialItemKind)],
) {
    for (_, item_id, _, _) in created {
        let _ = vault.item_delete(item_id);
    }
}

fn load_connections(data_dir: &Path) -> Result<SavedData, VaultError> {
    let path = data_dir.join("connections.json");
    if !path.exists() {
        return Ok(SavedData {
            connections: vec![],
            folders: vec![],
        });
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| VaultError::InvalidData(format!("read connections.json: {e}")))?;
    serde_json::from_str(&raw).map_err(VaultError::Serde)
}

fn atomic_write(path: &Path, content: &str) -> Result<(), VaultError> {
    use std::io::Write;
    let unique_suffix = uuid::Uuid::new_v4();
    let tmp = path.with_extension(format!("json.tmp.{unique_suffix}"));
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&tmp)
        .map_err(|e| VaultError::InvalidData(format!("tmp write open: {e}")))?;
    f.write_all(content.as_bytes())
        .map_err(|e| VaultError::InvalidData(format!("tmp write: {e}")))?;
    f.sync_all()
        .map_err(|e| VaultError::InvalidData(format!("tmp sync: {e}")))?;
    drop(f);

    if path.exists() {
        let backup = path.with_extension(format!("json.replace-bak.{unique_suffix}"));
        std::fs::rename(path, &backup)
            .map_err(|e| VaultError::InvalidData(format!("atomic backup rename: {e}")))?;
        match std::fs::rename(&tmp, path) {
            Ok(()) => {
                let _ = std::fs::remove_file(&backup);
            }
            Err(rename_error) => {
                let _ = std::fs::rename(&backup, path);
                let _ = std::fs::remove_file(&tmp);
                return Err(VaultError::InvalidData(format!(
                    "atomic replace rename: {rename_error}"
                )));
            }
        }
    } else {
        std::fs::rename(&tmp, path)
            .map_err(|e| VaultError::InvalidData(format!("atomic rename: {e}")))?;
    }
    Ok(())
}
