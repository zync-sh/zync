#![allow(dead_code)]

use super::types::{SyncError, SyncResult};
use crate::types::{SavedTunnel, SavedTunnelsData};
use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::Path;

const TUNNELS_FILE: &str = "tunnels.json";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TunnelSyncRecord {
    pub logical_id: String,
    pub connection_id: String,
    pub name: String,
    pub tunnel_type: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub bind_address: Option<String>,
    pub bind_to_any: bool,
    pub auto_start: bool,
    pub group: Option<String>,
    pub updated_at: u64,
}

pub fn load_tunnel_sync_records(data_dir: &Path) -> SyncResult<Vec<TunnelSyncRecord>> {
    let path = data_dir.join(TUNNELS_FILE);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| {
        SyncError::new(
            "sync_tunnels_read_failed",
            format!("Failed to read tunnels source file: {e}"),
        )
    })?;
    let data = serde_json::from_str::<SavedTunnelsData>(&raw).map_err(|e| {
        SyncError::new(
            "sync_tunnels_parse_failed",
            format!("Failed to parse tunnels source file: {e}"),
        )
    })?;
    let mut dedup: BTreeMap<String, TunnelSyncRecord> = BTreeMap::new();
    for tunnel in data.tunnels {
        let logical_id = if tunnel.id.trim().is_empty() {
            format!(
                "{}:{}:{}:{}",
                tunnel.connection_id.trim().to_ascii_lowercase(),
                tunnel.local_port,
                tunnel.remote_host.trim().to_ascii_lowercase(),
                tunnel.remote_port
            )
        } else {
            tunnel.id.trim().to_string()
        };
        dedup.insert(logical_id.clone(), map_tunnel(tunnel, logical_id));
    }
    Ok(dedup.into_values().collect())
}

fn map_tunnel(tunnel: SavedTunnel, logical_id: String) -> TunnelSyncRecord {
    TunnelSyncRecord {
        logical_id,
        connection_id: tunnel.connection_id,
        name: tunnel.name,
        tunnel_type: tunnel.tunnel_type,
        local_port: tunnel.local_port,
        remote_host: tunnel.remote_host,
        remote_port: tunnel.remote_port,
        bind_address: tunnel.bind_address.filter(|v| !v.trim().is_empty()),
        bind_to_any: tunnel.bind_to_any.unwrap_or(false),
        auto_start: tunnel.auto_start.unwrap_or(false),
        group: tunnel.group.filter(|v| !v.trim().is_empty()),
        updated_at: tunnel.original_port.map(|v| v as u64).unwrap_or(0),
    }
}

pub fn apply_tunnel_restore_records(data_dir: &Path, records: &[TunnelSyncRecord]) -> SyncResult<(u64, u64)> {
    if records.is_empty() {
        return Ok((0, 0));
    }
    let path = data_dir.join(TUNNELS_FILE);
    let mut saved = load_saved(path.as_path())?;
    let mut restored = 0u64;
    let mut updated = 0u64;
    for record in records {
        if let Some(existing) = saved.tunnels.iter_mut().find(|t| t.id == record.logical_id) {
            existing.connection_id = record.connection_id.clone();
            existing.name = record.name.clone();
            existing.tunnel_type = record.tunnel_type.clone();
            existing.local_port = record.local_port;
            existing.remote_host = record.remote_host.clone();
            existing.remote_port = record.remote_port;
            existing.bind_address = record.bind_address.clone();
            existing.bind_to_any = Some(record.bind_to_any);
            existing.auto_start = Some(record.auto_start);
            existing.group = record.group.clone();
            updated = updated.saturating_add(1);
            continue;
        }
        saved.tunnels.push(SavedTunnel {
            id: record.logical_id.clone(),
            connection_id: record.connection_id.clone(),
            name: record.name.clone(),
            tunnel_type: record.tunnel_type.clone(),
            local_port: record.local_port,
            remote_host: record.remote_host.clone(),
            remote_port: record.remote_port,
            bind_address: record.bind_address.clone(),
            bind_to_any: Some(record.bind_to_any),
            auto_start: Some(record.auto_start),
            status: None,
            original_port: None,
            group: record.group.clone(),
        });
        restored = restored.saturating_add(1);
    }
    save_saved_atomic(path.as_path(), &saved)?;
    Ok((restored, updated))
}

fn load_saved(path: &Path) -> SyncResult<SavedTunnelsData> {
    if !path.exists() {
        return Ok(SavedTunnelsData { tunnels: Vec::new() });
    }
    let raw = std::fs::read_to_string(path).map_err(|e| {
        SyncError::new("sync_tunnels_read_failed", format!("Failed to read tunnels file: {e}"))
    })?;
    serde_json::from_str::<SavedTunnelsData>(&raw).map_err(|e| {
        SyncError::new("sync_tunnels_parse_failed", format!("Failed to parse tunnels file: {e}"))
    })
}

fn save_saved_atomic(path: &Path, data: &SavedTunnelsData) -> SyncResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| SyncError::new("sync_tunnels_write_failed", "Invalid tunnels file path"))?;
    std::fs::create_dir_all(parent).map_err(|e| {
        SyncError::new("sync_tunnels_write_failed", format!("Failed to create tunnels dir: {e}"))
    })?;
    let temp_path = path.with_extension("tmp");
    let json = serde_json::to_string_pretty(data).map_err(|e| {
        SyncError::new("sync_tunnels_write_failed", format!("Failed to serialize tunnels data: {e}"))
    })?;
    std::fs::write(&temp_path, json).map_err(|e| {
        SyncError::new("sync_tunnels_write_failed", format!("Failed to write temp tunnels file: {e}"))
    })?;
    match std::fs::rename(&temp_path, path) {
        Ok(()) => Ok(()),
        Err(rename_err) if rename_err.kind() == ErrorKind::AlreadyExists && path.exists() => {
            let _ = std::fs::remove_file(path);
            std::fs::rename(&temp_path, path).map_err(|e| {
                let _ = std::fs::remove_file(&temp_path);
                SyncError::new("sync_tunnels_write_failed", format!("Failed to finalize tunnels file: {e}"))
            })
        }
        Err(rename_err) => {
            let _ = std::fs::remove_file(&temp_path);
            Err(SyncError::new(
                "sync_tunnels_write_failed",
                format!("Failed to finalize tunnels file: {rename_err}"),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_tunnel_snapshot_empty_when_file_missing() {
        let dir = std::env::temp_dir().join(format!(
            "zync-sync-tunnels-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let records = load_tunnel_sync_records(&dir).expect("load records");
        assert!(records.is_empty());
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn apply_restore_adds_and_updates_records() {
        let dir = std::env::temp_dir().join(format!(
            "zync-sync-tunnels-apply-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");

        let initial = SavedTunnelsData {
            tunnels: vec![SavedTunnel {
                id: "tun-1".into(),
                connection_id: "conn-1".into(),
                name: "Old".into(),
                tunnel_type: "local".into(),
                local_port: 7001,
                remote_host: "localhost".into(),
                remote_port: 5432,
                bind_address: None,
                bind_to_any: Some(false),
                auto_start: Some(false),
                status: None,
                original_port: None,
                group: None,
            }],
        };
        let path = dir.join("tunnels.json");
        std::fs::write(&path, serde_json::to_string_pretty(&initial).expect("serialize")).expect("write");

        let changes = vec![
            TunnelSyncRecord {
                logical_id: "tun-1".into(),
                connection_id: "conn-1".into(),
                name: "New".into(),
                tunnel_type: "local".into(),
                local_port: 7002,
                remote_host: "db.internal".into(),
                remote_port: 5432,
                bind_address: Some("127.0.0.1".into()),
                bind_to_any: false,
                auto_start: true,
                group: Some("db".into()),
                updated_at: 1,
            },
            TunnelSyncRecord {
                logical_id: "tun-2".into(),
                connection_id: "conn-2".into(),
                name: "Second".into(),
                tunnel_type: "remote".into(),
                local_port: 22,
                remote_host: "10.0.0.8".into(),
                remote_port: 22,
                bind_address: None,
                bind_to_any: false,
                auto_start: false,
                group: None,
                updated_at: 1,
            },
        ];
        let (restored, updated) = apply_tunnel_restore_records(&dir, &changes).expect("apply");
        assert_eq!(restored, 1);
        assert_eq!(updated, 1);
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }
}
