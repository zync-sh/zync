#![allow(dead_code)]

use super::types::{SyncError, SyncResult};
use crate::types::{SavedTunnel, SavedTunnelsData};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{LazyLock, Mutex};

const TUNNELS_FILE: &str = "tunnels.json";
pub(crate) static TUNNELS_MUTATION_LOCK: LazyLock<Mutex<()>> =
    LazyLock::new(|| Mutex::new(()));

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
    let _guard = TUNNELS_MUTATION_LOCK
        .lock()
        .map_err(|error| SyncError::new("sync_tunnels_lock_failed", error.to_string()))?;
    let data = load_saved_tunnels(path.as_path())?;
    let mut dedup: BTreeMap<String, TunnelSyncRecord> = BTreeMap::new();
    for tunnel in data.tunnels {
        let logical_id = tunnel_logical_id(&tunnel);
        let record = map_tunnel(tunnel, logical_id.clone());
        match dedup.get(&logical_id) {
            Some(existing) if existing.updated_at >= record.updated_at => {}
            _ => {
                dedup.insert(logical_id, record);
            }
        }
    }
    Ok(dedup.into_values().collect())
}

fn tunnel_logical_id(tunnel: &SavedTunnel) -> String {
    if !tunnel.id.trim().is_empty() {
        return tunnel.id.trim().to_string();
    }
    tunnel_fallback_logical_id(
        &tunnel.connection_id,
        &tunnel.tunnel_type,
        tunnel.local_port,
        &tunnel.remote_host,
        tunnel.remote_port,
        tunnel.bind_address.as_deref(),
        tunnel.bind_to_any.unwrap_or(false),
    )
}

fn tunnel_fallback_logical_id(
    connection_id: &str,
    tunnel_type: &str,
    local_port: u16,
    remote_host: &str,
    remote_port: u16,
    bind_address: Option<&str>,
    bind_to_any: bool,
) -> String {
    format!(
        "{}:{}:{}:{}:{}:{}:{}",
        connection_id.trim().to_ascii_lowercase(),
        tunnel_type.trim().to_ascii_lowercase(),
        local_port,
        remote_host.trim().to_ascii_lowercase(),
        remote_port,
        bind_address.unwrap_or_default().trim().to_ascii_lowercase(),
        bind_to_any
    )
}

fn legacy_tunnel_fallback_logical_id(
    connection_id: &str,
    local_port: u16,
    remote_host: &str,
    remote_port: u16,
) -> String {
    format!(
        "{}:{}:{}:{}",
        connection_id.trim().to_ascii_lowercase(),
        local_port,
        remote_host.trim().to_ascii_lowercase(),
        remote_port
    )
}

fn tunnel_matches_record(tunnel: &SavedTunnel, record: &TunnelSyncRecord) -> bool {
    if tunnel.id == record.logical_id {
        return true;
    }
    let current_fallback = tunnel_fallback_logical_id(
        &record.connection_id,
        &record.tunnel_type,
        record.local_port,
        &record.remote_host,
        record.remote_port,
        record.bind_address.as_deref(),
        record.bind_to_any,
    );
    let legacy_fallback = legacy_tunnel_fallback_logical_id(
        &record.connection_id,
        record.local_port,
        &record.remote_host,
        record.remote_port,
    );
    if record.logical_id != current_fallback && record.logical_id != legacy_fallback {
        return false;
    }
    let tunnel_current_fallback = tunnel_fallback_logical_id(
        &tunnel.connection_id,
        &tunnel.tunnel_type,
        tunnel.local_port,
        &tunnel.remote_host,
        tunnel.remote_port,
        tunnel.bind_address.as_deref(),
        tunnel.bind_to_any.unwrap_or(false),
    );
    let tunnel_legacy_fallback = legacy_tunnel_fallback_logical_id(
        &tunnel.connection_id,
        tunnel.local_port,
        &tunnel.remote_host,
        tunnel.remote_port,
    );
    if !tunnel.id.trim().is_empty()
        && tunnel.id != tunnel_current_fallback
        && tunnel.id != tunnel_legacy_fallback
    {
        return false;
    }
    tunnel.connection_id.trim().eq_ignore_ascii_case(record.connection_id.trim())
        && tunnel.tunnel_type.trim().eq_ignore_ascii_case(record.tunnel_type.trim())
        && tunnel.local_port == record.local_port
        && tunnel.remote_host.trim().eq_ignore_ascii_case(record.remote_host.trim())
        && tunnel.remote_port == record.remote_port
        && tunnel.bind_address.as_deref().unwrap_or_default().trim().eq_ignore_ascii_case(
            record.bind_address.as_deref().unwrap_or_default().trim(),
        )
        && tunnel.bind_to_any.unwrap_or(false) == record.bind_to_any
}

fn map_tunnel(tunnel: SavedTunnel, logical_id: String) -> TunnelSyncRecord {
    let updated_at = tunnel.updated_at.or(tunnel.created_at).unwrap_or(0);
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
        updated_at,
    }
}

pub fn apply_tunnel_restore_records(data_dir: &Path, records: &[TunnelSyncRecord]) -> SyncResult<(u64, u64)> {
    if records.is_empty() {
        return Ok((0, 0));
    }
    let path = data_dir.join(TUNNELS_FILE);
    let _guard = TUNNELS_MUTATION_LOCK
        .lock()
        .map_err(|error| SyncError::new("sync_tunnels_lock_failed", error.to_string()))?;
    let mut saved = load_saved_tunnels(path.as_path())?;
    let mut restored = 0u64;
    let mut updated = 0u64;
    for record in records {
        if let Some(existing) = saved
            .tunnels
            .iter_mut()
            .find(|t| tunnel_matches_record(t, record))
        {
            existing.id = record.logical_id.clone();
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
            existing.updated_at = Some(record.updated_at);
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
            created_at: Some(record.updated_at),
            updated_at: Some(record.updated_at),
        });
        restored = restored.saturating_add(1);
    }
    write_saved_tunnels_atomic(path.as_path(), &saved)?;
    Ok((restored, updated))
}

pub(crate) fn load_saved_tunnels(path: &Path) -> SyncResult<SavedTunnelsData> {
    if !path.exists() {
        let temp_path = path.with_extension("tmp");
        let backup_path = path.with_extension("bak");
        for candidate in [&temp_path, &backup_path] {
            if let Some(data) = parse_saved_tunnels_candidate(candidate) {
                std::fs::rename(candidate, path).map_err(|e| {
                    SyncError::new(
                        "sync_tunnels_read_failed",
                        format!("Failed to promote recovered tunnels file: {e}"),
                    )
                })?;
                return Ok(data);
            }
        }
        return Ok(SavedTunnelsData { tunnels: Vec::new() });
    }
    parse_saved_tunnels_file(path)
}

fn parse_saved_tunnels_candidate(path: &Path) -> Option<SavedTunnelsData> {
    parse_saved_tunnels_file(path).ok()
}

fn parse_saved_tunnels_file(path: &Path) -> SyncResult<SavedTunnelsData> {
    let raw = std::fs::read_to_string(path).map_err(|e| {
        SyncError::new("sync_tunnels_read_failed", format!("Failed to read tunnels file: {e}"))
    })?;
    serde_json::from_str::<SavedTunnelsData>(&raw).map_err(|e| {
        SyncError::new("sync_tunnels_parse_failed", format!("Failed to parse tunnels file: {e}"))
    })
}

pub(crate) fn write_saved_tunnels_atomic(path: &Path, data: &SavedTunnelsData) -> SyncResult<()> {
    let json = serde_json::to_string_pretty(data).map_err(|e| {
        SyncError::new("sync_tunnels_write_failed", format!("Failed to serialize tunnels data: {e}"))
    })?;
    crate::atomic_io::durable_replace(path, json.as_bytes()).map_err(|e| {
        SyncError::new("sync_tunnels_write_failed", format!("Failed to write tunnels file: {e}"))
    })
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
    fn load_saved_tunnels_recovers_backup_when_primary_is_missing() {
        let dir = std::env::temp_dir().join(format!(
            "zync-sync-tunnels-backup-recovery-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join(TUNNELS_FILE);
        let backup_path = path.with_extension("bak");
        let data = SavedTunnelsData {
            tunnels: vec![SavedTunnel {
                id: "tun-1".into(),
                connection_id: "conn-1".into(),
                name: "Recovered".into(),
                tunnel_type: "local".into(),
                local_port: 8080,
                remote_host: "localhost".into(),
                remote_port: 80,
                bind_address: None,
                bind_to_any: Some(false),
                auto_start: Some(false),
                status: None,
                original_port: None,
                group: None,
                created_at: Some(1),
                updated_at: Some(1),
            }],
        };
        std::fs::write(
            &backup_path,
            serde_json::to_string_pretty(&data).expect("serialize"),
        )
        .expect("write backup");

        let loaded = load_saved_tunnels(&path).expect("recover backup");
        assert_eq!(loaded.tunnels.len(), 1);
        assert_eq!(loaded.tunnels[0].name, "Recovered");
        assert!(path.exists());
        assert!(!backup_path.exists());
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn load_saved_tunnels_skips_corrupt_temp_and_recovers_valid_backup() {
        let dir = std::env::temp_dir().join(format!(
            "zync-sync-tunnels-corrupt-temp-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join(TUNNELS_FILE);
        let temp_path = path.with_extension("tmp");
        let backup_path = path.with_extension("bak");
        std::fs::write(&temp_path, "{not-json").expect("write corrupt temp");
        let data = SavedTunnelsData {
            tunnels: vec![SavedTunnel {
                id: "tun-1".into(),
                connection_id: "conn-1".into(),
                name: "Recovered backup".into(),
                tunnel_type: "local".into(),
                local_port: 8080,
                remote_host: "localhost".into(),
                remote_port: 80,
                bind_address: None,
                bind_to_any: Some(false),
                auto_start: Some(false),
                status: None,
                original_port: None,
                group: None,
                created_at: Some(1),
                updated_at: Some(1),
            }],
        };
        std::fs::write(
            &backup_path,
            serde_json::to_string_pretty(&data).expect("serialize"),
        )
        .expect("write backup");

        let recovered = load_saved_tunnels(&path).expect("recover valid backup");

        assert_eq!(recovered.tunnels[0].name, "Recovered backup");
        assert!(path.exists());
        assert!(temp_path.exists());
        assert!(!backup_path.exists());
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
                created_at: Some(10),
                updated_at: Some(11),
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

    #[test]
    fn map_tunnel_uses_saved_timestamps() {
        let record = map_tunnel(
            SavedTunnel {
                id: "tun-1".into(),
                connection_id: "conn-1".into(),
                name: "API".into(),
                tunnel_type: "local".into(),
                local_port: 8080,
                remote_host: "127.0.0.1".into(),
                remote_port: 80,
                bind_address: None,
                bind_to_any: Some(false),
                auto_start: Some(false),
                status: None,
                original_port: Some(9999),
                group: None,
                created_at: Some(12),
                updated_at: Some(55),
            },
            "tun-1".into(),
        );

        assert_eq!(record.updated_at, 55);
    }

    #[test]
    fn load_tunnel_sync_records_keeps_newest_duplicate() {
        let dir = std::env::temp_dir().join(format!(
            "zync-sync-tunnels-newest-dedup-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let base = SavedTunnel {
            id: "tun-1".into(),
            connection_id: "conn-1".into(),
            name: "Newer".into(),
            tunnel_type: "local".into(),
            local_port: 8080,
            remote_host: "localhost".into(),
            remote_port: 80,
            bind_address: None,
            bind_to_any: Some(false),
            auto_start: Some(false),
            status: None,
            original_port: None,
            group: None,
            created_at: Some(1),
            updated_at: Some(20),
        };
        std::fs::write(
            dir.join(TUNNELS_FILE),
            serde_json::to_string_pretty(&SavedTunnelsData {
                tunnels: vec![
                    base.clone(),
                    SavedTunnel {
                        name: "Older".into(),
                        updated_at: Some(10),
                        ..base
                    },
                ],
            })
            .expect("serialize"),
        )
        .expect("write");

        let records = load_tunnel_sync_records(&dir).expect("load records");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].name, "Newer");
        assert_eq!(records[0].updated_at, 20);
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn legacy_logical_id_distinguishes_tunnel_type_and_bind_address() {
        let mut first = SavedTunnel {
            id: String::new(),
            connection_id: "Conn-1".into(),
            name: "API".into(),
            tunnel_type: "local".into(),
            local_port: 8080,
            remote_host: "DB.INTERNAL".into(),
            remote_port: 80,
            bind_address: Some("127.0.0.1".into()),
            bind_to_any: Some(false),
            auto_start: Some(false),
            status: None,
            original_port: None,
            group: None,
            created_at: Some(1),
            updated_at: Some(1),
        };
        let first_id = tunnel_logical_id(&first);
        first.tunnel_type = "remote".into();
        assert_ne!(first_id, tunnel_logical_id(&first));
        first.tunnel_type = "local".into();
        first.bind_address = Some("0.0.0.0".into());
        assert_ne!(first_id, tunnel_logical_id(&first));
    }

    #[test]
    fn restore_matches_existing_tunnel_by_legacy_fallback_logical_id() {
        let dir = std::env::temp_dir().join(format!(
            "zync-sync-tunnels-legacy-restore-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let existing = SavedTunnel {
            id: String::new(),
            connection_id: "conn-1".into(),
            name: "Old".into(),
            tunnel_type: "local".into(),
            local_port: 8080,
            remote_host: "db.internal".into(),
            remote_port: 80,
            bind_address: Some("127.0.0.1".into()),
            bind_to_any: Some(false),
            auto_start: Some(false),
            status: None,
            original_port: None,
            group: None,
            created_at: Some(1),
            updated_at: Some(1),
        };
        let logical_id = tunnel_logical_id(&existing);
        let initial = SavedTunnelsData {
            tunnels: vec![existing],
        };
        std::fs::write(
            dir.join(TUNNELS_FILE),
            serde_json::to_string_pretty(&initial).expect("serialize"),
        )
        .expect("write");

        let record = TunnelSyncRecord {
            logical_id,
            connection_id: "conn-1".into(),
            name: "Updated".into(),
            tunnel_type: "local".into(),
            local_port: 8080,
            remote_host: "db.internal".into(),
            remote_port: 80,
            bind_address: Some("127.0.0.1".into()),
            bind_to_any: false,
            auto_start: true,
            group: None,
            updated_at: 9,
        };
        let (restored, updated) =
            apply_tunnel_restore_records(&dir, std::slice::from_ref(&record)).expect("apply");
        assert_eq!((restored, updated), (0, 1));
        let saved = load_saved_tunnels(&dir.join(TUNNELS_FILE)).expect("read");
        assert_eq!(saved.tunnels.len(), 1);
        assert_eq!(saved.tunnels[0].name, "Updated");
        assert_eq!(saved.tunnels[0].id, record.logical_id);
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn restore_matches_preexisting_legacy_v1_fallback_id() {
        let dir = std::env::temp_dir().join(format!(
            "zync-sync-tunnels-v1-restore-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let existing = SavedTunnel {
            id: String::new(),
            connection_id: "conn-1".into(),
            name: "Old".into(),
            tunnel_type: "local".into(),
            local_port: 8080,
            remote_host: "db.internal".into(),
            remote_port: 80,
            bind_address: Some("127.0.0.1".into()),
            bind_to_any: Some(false),
            auto_start: Some(false),
            status: None,
            original_port: None,
            group: None,
            created_at: Some(1),
            updated_at: Some(1),
        };
        let legacy_id = legacy_tunnel_fallback_logical_id(
            &existing.connection_id,
            existing.local_port,
            &existing.remote_host,
            existing.remote_port,
        );
        std::fs::write(
            dir.join(TUNNELS_FILE),
            serde_json::to_string_pretty(&SavedTunnelsData {
                tunnels: vec![existing],
            })
            .expect("serialize"),
        )
        .expect("write");

        let record = TunnelSyncRecord {
            logical_id: legacy_id,
            connection_id: "conn-1".into(),
            name: "Updated".into(),
            tunnel_type: "local".into(),
            local_port: 8080,
            remote_host: "db.internal".into(),
            remote_port: 80,
            bind_address: Some("127.0.0.1".into()),
            bind_to_any: false,
            auto_start: true,
            group: None,
            updated_at: 9,
        };

        let (restored, updated) =
            apply_tunnel_restore_records(&dir, std::slice::from_ref(&record)).expect("apply");
        assert_eq!((restored, updated), (0, 1));
        let saved = load_saved_tunnels(&dir.join(TUNNELS_FILE)).expect("read");
        assert_eq!(saved.tunnels.len(), 1);
        assert_eq!(saved.tunnels[0].name, "Updated");
        assert_eq!(saved.tunnels[0].id, record.logical_id);
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn fallback_restore_does_not_merge_explicitly_identified_tunnel() {
        let explicit = SavedTunnel {
            id: "explicit-tunnel".into(),
            connection_id: "conn-1".into(),
            name: "Explicit".into(),
            tunnel_type: "local".into(),
            local_port: 8080,
            remote_host: "db.internal".into(),
            remote_port: 80,
            bind_address: Some("127.0.0.1".into()),
            bind_to_any: Some(false),
            auto_start: Some(false),
            status: None,
            original_port: None,
            group: None,
            created_at: Some(1),
            updated_at: Some(1),
        };
        let fallback = tunnel_fallback_logical_id(
            &explicit.connection_id,
            &explicit.tunnel_type,
            explicit.local_port,
            &explicit.remote_host,
            explicit.remote_port,
            explicit.bind_address.as_deref(),
            explicit.bind_to_any.unwrap_or(false),
        );
        let record = TunnelSyncRecord {
            logical_id: fallback,
            connection_id: explicit.connection_id.clone(),
            name: "Remote fallback".into(),
            tunnel_type: explicit.tunnel_type.clone(),
            local_port: explicit.local_port,
            remote_host: explicit.remote_host.clone(),
            remote_port: explicit.remote_port,
            bind_address: explicit.bind_address.clone(),
            bind_to_any: false,
            auto_start: false,
            group: None,
            updated_at: 2,
        };

        assert!(!tunnel_matches_record(&explicit, &record));
    }
}
