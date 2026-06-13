#![allow(dead_code)]

use super::types::{SyncDomain, SyncError, SyncResult};
use crate::types::{CredentialRef, SavedConnection, SavedData};
use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::Path;
use std::sync::{LazyLock, Mutex};

const CONNECTIONS_FILE: &str = "connections.json";

pub(crate) static CONNECTIONS_MUTATION_LOCK: LazyLock<Mutex<()>> =
    LazyLock::new(|| Mutex::new(()));

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostSyncRecord {
    pub logical_id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jump_server_id: Option<String>,
    pub folder: Option<String>,
    pub tags: Vec<String>,
    pub is_favorite: bool,
    pub updated_at: u64,
    /// Non-secret pointer to the vault credential used by this host.
    ///
    /// Host sync must never carry plaintext passwords or local private-key file
    /// paths. A restored host can authenticate only when the referenced vault
    /// credential is restored/unlocked locally.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_ref: Option<CredentialRef>,
}

impl HostSyncRecord {
    pub fn domain() -> SyncDomain {
        SyncDomain::Hosts
    }
}

pub fn load_hosts_sync_records(data_dir: &Path) -> SyncResult<Vec<HostSyncRecord>> {
    let path = data_dir.join(CONNECTIONS_FILE);
    let _guard = CONNECTIONS_MUTATION_LOCK
        .lock()
        .map_err(|error| SyncError::new("sync_hosts_lock_failed", error.to_string()))?;
    let data = load_saved_data(&path)?;

    let mut dedup: BTreeMap<String, HostSyncRecord> = BTreeMap::new();
    for conn in data.connections {
        let logical_id = host_logical_id(&conn);
        let record = map_saved_connection_to_sync_record(conn, logical_id.clone());
        match dedup.get(&logical_id) {
            Some(existing) if existing.updated_at >= record.updated_at => {}
            _ => {
                dedup.insert(logical_id, record);
            }
        }
    }

    Ok(dedup.into_values().collect())
}

fn map_saved_connection_to_sync_record(conn: SavedConnection, logical_id: String) -> HostSyncRecord {
    let updated_at = host_updated_at(&conn);
    HostSyncRecord {
        logical_id,
        name: conn.name,
        host: conn.host,
        port: conn.port,
        username: conn.username,
        jump_server_id: conn.jump_server_id.filter(|v| !v.trim().is_empty()),
        folder: conn.folder.filter(|v| !v.trim().is_empty()),
        tags: conn.tags.unwrap_or_default(),
        is_favorite: conn.is_favorite.unwrap_or(false),
        updated_at,
        auth_ref: conn.auth_ref,
    }
}

fn normalize_host_timestamp(timestamp: Option<u64>) -> u64 {
    let Some(value) = timestamp else {
        return 0;
    };
    // Frontend connection timestamps are persisted with Date.now() in ms,
    // while sync watermarks are tracked in Unix seconds.
    if value >= 1_000_000_000_000 {
        value / 1000
    } else {
        value
    }
}

fn host_updated_at(conn: &SavedConnection) -> u64 {
    normalize_host_timestamp(conn.last_connected).max(normalize_host_timestamp(conn.created_at))
}

fn host_timestamp_from_sync(updated_at: u64) -> u64 {
    updated_at.saturating_mul(1000)
}

pub fn apply_hosts_restore_records(
    data_dir: &Path,
    records: &[HostSyncRecord],
) -> SyncResult<(u64, u64)> {
    if records.is_empty() {
        return Ok((0, 0));
    }
    let path = data_dir.join(CONNECTIONS_FILE);
    let _guard = CONNECTIONS_MUTATION_LOCK
        .lock()
        .map_err(|error| SyncError::new("sync_hosts_lock_failed", error.to_string()))?;
    let mut data = load_saved_data(&path)?;
    let mut restored = 0u64;
    let mut updated = 0u64;

    for record in records {
        if let Some(existing) = data
            .connections
            .iter_mut()
            .find(|conn| host_logical_id(conn) == record.logical_id)
        {
            existing.name = record.name.clone();
            existing.host = record.host.clone();
            existing.port = record.port;
            existing.username = record.username.clone();
            existing.jump_server_id = record.jump_server_id.clone();
            existing.folder = record.folder.clone();
            existing.tags = if record.tags.is_empty() {
                None
            } else {
                Some(record.tags.clone())
            };
            existing.is_favorite = Some(record.is_favorite);
            let restored_timestamp = host_timestamp_from_sync(record.updated_at);
            existing.created_at = Some(restored_timestamp);
            existing.last_connected = Some(restored_timestamp);
            existing.auth_ref = record.auth_ref.clone();
            existing.password = None;
            existing.private_key_path = None;
            updated = updated.saturating_add(1);
            continue;
        }

        data.connections.push(SavedConnection {
            id: record.logical_id.clone(),
            name: record.name.clone(),
            host: record.host.clone(),
            port: record.port,
            username: record.username.clone(),
            password: None,
            private_key_path: None,
            jump_server_id: record.jump_server_id.clone(),
            last_connected: Some(host_timestamp_from_sync(record.updated_at)),
            icon: None,
            folder: record.folder.clone(),
            theme: None,
            tags: if record.tags.is_empty() {
                None
            } else {
                Some(record.tags.clone())
            },
            created_at: Some(host_timestamp_from_sync(record.updated_at)),
            is_favorite: Some(record.is_favorite),
            pinned_features: None,
            auth_ref: record.auth_ref.clone(),
        });
        restored = restored.saturating_add(1);
    }

    save_saved_data_atomic(&path, &data)?;
    Ok((restored, updated))
}

fn load_saved_data(path: &Path) -> SyncResult<SavedData> {
    if !path.exists() {
        let temp_path = path.with_extension("tmp");
        let backup_path = path.with_extension("bak");
        for candidate in [&temp_path, &backup_path] {
            if let Some(data) = parse_saved_candidate(candidate) {
                std::fs::rename(candidate, path).map_err(|e| {
                    SyncError::new(
                        "sync_hosts_read_failed",
                        format!("Failed to promote recovered hosts file: {e}"),
                    )
                })?;
                return Ok(data);
            }
        }
        return Ok(SavedData {
            connections: Vec::new(),
            folders: Vec::new(),
        });
    }
    parse_saved_file(path)
}

fn parse_saved_candidate(path: &Path) -> Option<SavedData> {
    parse_saved_file(path).ok()
}

fn parse_saved_file(path: &Path) -> SyncResult<SavedData> {
    let raw = std::fs::read_to_string(path).map_err(|e| {
        SyncError::new(
            "sync_hosts_read_failed",
            format!("Failed to read hosts file: {e}"),
        )
    })?;
    serde_json::from_str::<SavedData>(&raw).map_err(|e| {
        SyncError::new(
            "sync_hosts_parse_failed",
            format!("Failed to parse hosts file: {e}"),
        )
    })
}

fn save_saved_data_atomic(path: &Path, data: &SavedData) -> SyncResult<()> {
    let parent = path.parent().ok_or_else(|| {
        SyncError::new("sync_hosts_write_failed", "Invalid hosts file path")
    })?;
    std::fs::create_dir_all(parent).map_err(|e| {
        SyncError::new(
            "sync_hosts_write_failed",
            format!("Failed to create hosts directory: {e}"),
        )
    })?;
    let temp_path = path.with_extension("tmp");
    let json = serde_json::to_string_pretty(data).map_err(|e| {
        SyncError::new(
            "sync_hosts_write_failed",
            format!("Failed to serialize hosts data: {e}"),
        )
    })?;
    std::fs::write(&temp_path, json).map_err(|e| {
        SyncError::new(
            "sync_hosts_write_failed",
            format!("Failed to write temp hosts file: {e}"),
        )
    })?;
    match std::fs::rename(&temp_path, path) {
        Ok(()) => Ok(()),
        Err(rename_err) if rename_err.kind() == ErrorKind::AlreadyExists && path.exists() => {
            let backup_path = path.with_extension("bak");
            std::fs::rename(path, &backup_path).map_err(|backup_err| {
                let _ = std::fs::remove_file(&temp_path);
                SyncError::new(
                    "sync_hosts_write_failed",
                    format!("Failed to stage hosts backup before replace: {backup_err}"),
                )
            })?;
            match std::fs::rename(&temp_path, path) {
                Ok(()) => {
                    let _ = std::fs::remove_file(&backup_path);
                    Ok(())
                }
                Err(retry_err) => {
                    let _ = std::fs::rename(&backup_path, path);
                    let _ = std::fs::remove_file(&temp_path);
                    Err(SyncError::new(
                        "sync_hosts_write_failed",
                        format!("Failed to finalize hosts file after replace retry: {retry_err}"),
                    ))
                }
            }
        }
        Err(rename_err) => {
            let _ = std::fs::remove_file(&temp_path);
            Err(SyncError::new(
                "sync_hosts_write_failed",
                format!("Failed to finalize hosts file: {rename_err}"),
            ))
        }
    }
}

fn host_logical_id(conn: &SavedConnection) -> String {
    if !conn.id.trim().is_empty() {
        return conn.id.trim().to_string();
    }
    format!(
        "{}@{}:{}",
        conn.username.trim().to_ascii_lowercase(),
        conn.host.trim().to_ascii_lowercase(),
        conn.port
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{CredentialItemKind, CredentialPurpose};

    fn test_auth_ref() -> CredentialRef {
        CredentialRef {
            vault_id: "local".into(),
            credential_id: Some("cred-stable-1".into()),
            item_id: "vault-item-1".into(),
            item_kind: CredentialItemKind::SshPrivateKey,
            purpose: CredentialPurpose::SshAuth,
        }
    }

    fn test_connection(id: &str) -> SavedConnection {
        SavedConnection {
            id: id.into(),
            name: "n".into(),
            host: "h".into(),
            port: 22,
            username: "u".into(),
            password: None,
            private_key_path: None,
            jump_server_id: None,
            last_connected: Some(1),
            icon: None,
            folder: None,
            theme: None,
            tags: None,
            created_at: Some(1),
            is_favorite: None,
            pinned_features: None,
            auth_ref: None,
        }
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "zync-sync-hosts-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ))
    }

    #[test]
    fn domain_marker_is_hosts() {
        assert_eq!(HostSyncRecord::domain(), SyncDomain::Hosts);
    }

    #[test]
    fn host_logical_id_prefers_connection_id() {
        let conn = test_connection("host-1");
        assert_eq!(host_logical_id(&conn), "host-1");
    }

    #[test]
    fn host_sync_record_preserves_non_secret_auth_ref() {
        let mut conn = test_connection("host-1");
        conn.password = Some("must-not-sync".into());
        conn.private_key_path = Some("C:\\Users\\me\\.ssh\\id_ed25519".into());
        conn.auth_ref = Some(test_auth_ref());

        let record = map_saved_connection_to_sync_record(conn, "host-1".into());

        assert_eq!(record.auth_ref, Some(test_auth_ref()));
    }

    #[test]
    fn host_sync_record_normalizes_millisecond_timestamps_to_seconds() {
        let mut conn = test_connection("host-ms");
        conn.created_at = Some(1_780_000_000_123);
        conn.last_connected = Some(1_780_000_123_456);

        let record = map_saved_connection_to_sync_record(conn, "host-ms".into());

        assert_eq!(record.updated_at, 1_780_000_123);
    }

    #[test]
    fn host_sync_record_uses_latest_of_created_and_connected_timestamps() {
        let mut conn = test_connection("host-latest");
        conn.created_at = Some(1_780_000_200);
        conn.last_connected = Some(1_780_000_100);

        let record = map_saved_connection_to_sync_record(conn, "host-latest".into());

        assert_eq!(record.updated_at, 1_780_000_200);
    }

    #[test]
    fn restore_new_host_writes_vault_auth_ref_without_plaintext_auth() {
        let dir = temp_dir("restore-new-auth-ref");
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let record = HostSyncRecord {
            logical_id: "host-1".into(),
            name: "Host".into(),
            host: "example.com".into(),
            port: 22,
            username: "app".into(),
            jump_server_id: Some("jump-1".into()),
            folder: None,
            tags: Vec::new(),
            is_favorite: false,
            updated_at: 7,
            auth_ref: Some(test_auth_ref()),
        };

        let (restored, updated) = apply_hosts_restore_records(&dir, &[record]).expect("apply");
        assert_eq!((restored, updated), (1, 0));

        let raw = std::fs::read_to_string(dir.join(CONNECTIONS_FILE)).expect("read saved hosts");
        let saved: SavedData = serde_json::from_str(&raw).expect("parse saved hosts");
        let restored = saved.connections.first().expect("restored host");
        assert_eq!(restored.auth_ref, Some(test_auth_ref()));
        assert_eq!(restored.jump_server_id.as_deref(), Some("jump-1"));
        assert_eq!(restored.password, None);
        assert_eq!(restored.private_key_path, None);
        assert_eq!(restored.created_at, Some(7_000));
        assert_eq!(restored.last_connected, Some(7_000));

        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn restore_existing_host_updates_auth_ref_and_clears_plaintext_fallbacks() {
        let dir = temp_dir("restore-existing-auth-ref");
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let mut existing = test_connection("host-1");
        existing.password = Some("old-password".into());
        existing.private_key_path = Some("C:\\Users\\me\\.ssh\\old.pem".into());
        existing.jump_server_id = Some("old-jump".into());
        let initial = SavedData {
            connections: vec![existing],
            folders: Vec::new(),
        };
        std::fs::write(
            dir.join(CONNECTIONS_FILE),
            serde_json::to_string_pretty(&initial).expect("serialize initial"),
        )
        .expect("write initial");

        let record = HostSyncRecord {
            logical_id: "host-1".into(),
            name: "Updated Host".into(),
            host: "example.com".into(),
            port: 2222,
            username: "app".into(),
            jump_server_id: Some("jump-2".into()),
            folder: Some("prod".into()),
            tags: vec!["prod".into()],
            is_favorite: true,
            updated_at: 9,
            auth_ref: Some(test_auth_ref()),
        };

        let (restored, updated) = apply_hosts_restore_records(&dir, &[record]).expect("apply");
        assert_eq!((restored, updated), (0, 1));

        let raw = std::fs::read_to_string(dir.join(CONNECTIONS_FILE)).expect("read saved hosts");
        let saved: SavedData = serde_json::from_str(&raw).expect("parse saved hosts");
        let updated = saved.connections.first().expect("updated host");
        assert_eq!(updated.auth_ref, Some(test_auth_ref()));
        assert_eq!(updated.jump_server_id.as_deref(), Some("jump-2"));
        assert_eq!(updated.password, None);
        assert_eq!(updated.private_key_path, None);
        assert_eq!(updated.port, 2222);
        assert_eq!(updated.created_at, Some(9_000));
        assert_eq!(updated.last_connected, Some(9_000));

        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn restore_existing_host_clears_stale_auth_when_remote_has_none() {
        let dir = temp_dir("restore-clears-stale-auth");
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let mut existing = test_connection("host-1");
        existing.password = Some("old-password".into());
        existing.private_key_path = Some("C:\\Users\\me\\.ssh\\old.pem".into());
        existing.auth_ref = Some(test_auth_ref());
        std::fs::write(
            dir.join(CONNECTIONS_FILE),
            serde_json::to_string_pretty(&SavedData {
                connections: vec![existing],
                folders: Vec::new(),
            })
            .expect("serialize initial"),
        )
        .expect("write initial");

        let record = HostSyncRecord {
            logical_id: "host-1".into(),
            name: "Host".into(),
            host: "example.com".into(),
            port: 22,
            username: "app".into(),
            jump_server_id: None,
            folder: None,
            tags: Vec::new(),
            is_favorite: false,
            updated_at: 9,
            auth_ref: None,
        };

        apply_hosts_restore_records(&dir, &[record]).expect("apply");
        let saved = load_saved_data(&dir.join(CONNECTIONS_FILE)).expect("read saved hosts");
        let updated = saved.connections.first().expect("updated host");
        assert_eq!(updated.auth_ref, None);
        assert_eq!(updated.password, None);
        assert_eq!(updated.private_key_path, None);
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn restore_matches_existing_host_by_legacy_fallback_logical_id() {
        let dir = temp_dir("restore-legacy-logical-id");
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let mut existing = test_connection("");
        existing.host = "Example.COM".into();
        existing.username = "App".into();
        existing.port = 2222;
        let initial = SavedData {
            connections: vec![existing],
            folders: Vec::new(),
        };
        std::fs::write(
            dir.join(CONNECTIONS_FILE),
            serde_json::to_string_pretty(&initial).expect("serialize initial"),
        )
        .expect("write initial");

        let record = HostSyncRecord {
            logical_id: "app@example.com:2222".into(),
            name: "Updated".into(),
            host: "example.com".into(),
            port: 2222,
            username: "app".into(),
            jump_server_id: None,
            folder: None,
            tags: Vec::new(),
            is_favorite: false,
            updated_at: 9,
            auth_ref: None,
        };

        let (restored, updated) = apply_hosts_restore_records(&dir, &[record]).expect("apply");
        assert_eq!((restored, updated), (0, 1));

        let raw = std::fs::read_to_string(dir.join(CONNECTIONS_FILE)).expect("read saved hosts");
        let saved: SavedData = serde_json::from_str(&raw).expect("parse saved hosts");
        assert_eq!(saved.connections.len(), 1);
        assert_eq!(saved.connections[0].name, "Updated");
        assert_eq!(saved.connections[0].last_connected, Some(9_000));

        std::fs::remove_dir_all(&dir).expect("cleanup");
    }
}
