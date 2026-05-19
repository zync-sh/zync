#![allow(dead_code)]

use super::types::{SyncDomain, SyncError, SyncResult};
use crate::types::{SavedConnection, SavedData};
use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::Path;

const CONNECTIONS_FILE: &str = "connections.json";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostSyncRecord {
    pub logical_id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub folder: Option<String>,
    pub tags: Vec<String>,
    pub is_favorite: bool,
    pub updated_at: u64,
}

impl HostSyncRecord {
    pub fn domain() -> SyncDomain {
        SyncDomain::Hosts
    }
}

pub fn load_hosts_sync_records(data_dir: &Path) -> SyncResult<Vec<HostSyncRecord>> {
    let path = data_dir.join(CONNECTIONS_FILE);
    if !path.exists() {
        return Ok(Vec::new());
    }

    let raw = std::fs::read_to_string(&path).map_err(|e| {
        SyncError::new(
            "sync_hosts_read_failed",
            format!("Failed to read hosts source file: {e}"),
        )
    })?;

    let data = serde_json::from_str::<SavedData>(&raw).map_err(|e| {
        SyncError::new(
            "sync_hosts_parse_failed",
            format!("Failed to parse hosts source file: {e}"),
        )
    })?;

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
    HostSyncRecord {
        logical_id,
        name: conn.name,
        host: conn.host,
        port: conn.port,
        username: conn.username,
        folder: conn.folder.filter(|v| !v.trim().is_empty()),
        tags: conn.tags.unwrap_or_default(),
        is_favorite: conn.is_favorite.unwrap_or(false),
        updated_at: conn.last_connected.or(conn.created_at).unwrap_or(0),
    }
}

pub fn apply_hosts_restore_records(
    data_dir: &Path,
    records: &[HostSyncRecord],
) -> SyncResult<(u64, u64)> {
    if records.is_empty() {
        return Ok((0, 0));
    }
    let path = data_dir.join(CONNECTIONS_FILE);
    let mut data = load_saved_data(&path)?;
    let mut restored = 0u64;
    let mut updated = 0u64;

    for record in records {
        if let Some(existing) = data.connections.iter_mut().find(|conn| conn.id == record.logical_id) {
            existing.name = record.name.clone();
            existing.host = record.host.clone();
            existing.port = record.port;
            existing.username = record.username.clone();
            existing.folder = record.folder.clone();
            existing.tags = if record.tags.is_empty() {
                None
            } else {
                Some(record.tags.clone())
            };
            existing.is_favorite = Some(record.is_favorite);
            existing.last_connected = Some(record.updated_at);
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
            jump_server_id: None,
            last_connected: Some(record.updated_at),
            icon: None,
            folder: record.folder.clone(),
            theme: None,
            tags: if record.tags.is_empty() {
                None
            } else {
                Some(record.tags.clone())
            },
            created_at: Some(record.updated_at),
            is_favorite: Some(record.is_favorite),
            pinned_features: None,
            auth_ref: None,
        });
        restored = restored.saturating_add(1);
    }

    save_saved_data_atomic(&path, &data)?;
    Ok((restored, updated))
}

fn load_saved_data(path: &Path) -> SyncResult<SavedData> {
    if !path.exists() {
        return Ok(SavedData {
            connections: Vec::new(),
            folders: Vec::new(),
        });
    }
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
            match std::fs::remove_file(path) {
                Ok(()) => std::fs::rename(&temp_path, path).map_err(|retry_err| {
                    let _ = std::fs::remove_file(&temp_path);
                    SyncError::new(
                        "sync_hosts_write_failed",
                        format!("Failed to finalize hosts file after replace retry: {retry_err}"),
                    )
                }),
                Err(remove_err) if remove_err.kind() == ErrorKind::NotFound => {
                    if std::fs::rename(&temp_path, path).is_ok() {
                        Ok(())
                    } else {
                        let _ = std::fs::remove_file(&temp_path);
                        Err(SyncError::new(
                            "sync_hosts_write_failed",
                            "Failed to finalize hosts file after replace retry",
                        ))
                    }
                }
                Err(remove_err) => {
                    let _ = std::fs::remove_file(&temp_path);
                    Err(SyncError::new(
                        "sync_hosts_write_failed",
                        format!("Failed to replace existing hosts file: {remove_err}"),
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

    #[test]
    fn domain_marker_is_hosts() {
        assert_eq!(HostSyncRecord::domain(), SyncDomain::Hosts);
    }

    #[test]
    fn host_logical_id_prefers_connection_id() {
        let conn = SavedConnection {
            id: "host-1".into(),
            name: "n".into(),
            host: "h".into(),
            port: 22,
            username: "u".into(),
            password: None,
            private_key_path: None,
            jump_server_id: None,
            last_connected: None,
            icon: None,
            folder: None,
            theme: None,
            tags: None,
            created_at: None,
            is_favorite: None,
            pinned_features: None,
            auth_ref: None,
        };
        assert_eq!(host_logical_id(&conn), "host-1");
    }
}
