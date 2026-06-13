#![allow(dead_code)]

use super::types::{SyncError, SyncResult};
use crate::snippets::{Snippet, SnippetsData, SNIPPETS_MUTATION_LOCK};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;

const SNIPPETS_FILE: &str = "snippets.json";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnippetSyncRecord {
    pub logical_id: String,
    pub name: String,
    pub command: String,
    pub category: Option<String>,
    pub tags: Vec<String>,
    pub connection_id: Option<String>,
    pub updated_at: u64,
}

pub fn load_snippet_sync_records(data_dir: &Path) -> SyncResult<Vec<SnippetSyncRecord>> {
    let path = data_dir.join(SNIPPETS_FILE);
    let _guard = SNIPPETS_MUTATION_LOCK
        .lock()
        .map_err(|error| SyncError::new("sync_snippets_lock_failed", error.to_string()))?;
    let data = load_saved(&path)?;
    let mut dedup: BTreeMap<String, SnippetSyncRecord> = BTreeMap::new();
    for snip in data.snippets {
        let logical_id = if snip.id.trim().is_empty() {
            snippet_fallback_logical_id(&snip)
        } else {
            snip.id.trim().to_string()
        };
        let record = map_snippet(snip, logical_id.clone());
        if dedup
            .get(&logical_id)
            .map_or(true, |existing| record.updated_at > existing.updated_at)
        {
            dedup.insert(logical_id, record);
        }
    }
    Ok(dedup.into_values().collect())
}

fn normalize_snippet_timestamp(timestamp: u64) -> u64 {
    // Local snippet timestamps may be persisted in ms while sync watermarks use seconds.
    if timestamp >= 1_000_000_000_000 {
        timestamp / 1000
    } else {
        timestamp
    }
}

fn snippet_timestamp_from_sync(updated_at: u64) -> u64 {
    if updated_at >= 1_000_000_000_000 {
        updated_at
    } else {
        updated_at.saturating_mul(1000)
    }
}

fn map_snippet(snip: Snippet, logical_id: String) -> SnippetSyncRecord {
    let updated_at =
        normalize_snippet_timestamp(snip.updated_at.or(snip.created_at).unwrap_or(0));
    SnippetSyncRecord {
        logical_id,
        name: snip.name,
        command: snip.command,
        category: snip.category.filter(|v| !v.trim().is_empty()),
        tags: snip.tags.unwrap_or_default(),
        connection_id: snip.connection_id.filter(|v| !v.trim().is_empty()),
        updated_at,
    }
}

fn snippet_fallback_logical_id(snip: &Snippet) -> String {
    snippet_content_logical_id(&snip.name, &snip.command, snip.connection_id.as_deref())
}

pub(crate) fn snippet_record_logical_id(record: &SnippetSyncRecord) -> String {
    let logical_id = record.logical_id.trim();
    if logical_id.is_empty() {
        snippet_content_logical_id(&record.name, &record.command, record.connection_id.as_deref())
    } else {
        logical_id.to_string()
    }
}

fn snippet_content_logical_id(name: &str, command: &str, connection_id: Option<&str>) -> String {
    let label = name.trim().to_ascii_lowercase();
    let mut hasher = Sha256::new();
    hasher.update(command.as_bytes());
    hasher.update([0]);
    hasher.update(
        connection_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or_default()
            .as_bytes(),
    );
    let digest = hasher.finalize();
    let short_hash = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{label}:{short_hash}")
}

pub fn apply_snippet_restore_records(data_dir: &Path, records: &[SnippetSyncRecord]) -> SyncResult<(u64, u64)> {
    if records.is_empty() {
        return Ok((0, 0));
    }
    let path = data_dir.join(SNIPPETS_FILE);
    let _guard = SNIPPETS_MUTATION_LOCK
        .lock()
        .map_err(|error| SyncError::new("sync_snippets_lock_failed", error.to_string()))?;
    let mut saved = load_saved(path.as_path())?;
    let mut restored = 0u64;
    let mut updated = 0u64;
    for record in records {
        let logical_id = snippet_record_logical_id(record);
        if let Some(existing) = saved.snippets.iter_mut().find(|snippet| {
            snippet.id == logical_id
                || (snippet.id.trim().is_empty()
                    && snippet_fallback_logical_id(snippet) == logical_id)
        }) {
            existing.id = logical_id;
            existing.name = record.name.clone();
            existing.command = record.command.clone();
            existing.category = record.category.clone();
            existing.tags = if record.tags.is_empty() { None } else { Some(record.tags.clone()) };
            existing.connection_id = record.connection_id.clone();
            let restored_at = snippet_timestamp_from_sync(record.updated_at);
            existing.updated_at = Some(restored_at);
            updated = updated.saturating_add(1);
            continue;
        }
        let restored_at = snippet_timestamp_from_sync(record.updated_at);
        saved.snippets.push(Snippet {
            id: logical_id,
            name: record.name.clone(),
            command: record.command.clone(),
            category: record.category.clone(),
            tags: if record.tags.is_empty() { None } else { Some(record.tags.clone()) },
            connection_id: record.connection_id.clone(),
            created_at: Some(restored_at),
            updated_at: Some(restored_at),
        });
        restored = restored.saturating_add(1);
    }
    save_saved_atomic(path.as_path(), &saved)?;
    Ok((restored, updated))
}

fn load_saved(path: &Path) -> SyncResult<SnippetsData> {
    if !path.exists() {
        let temp_path = path.with_extension("tmp");
        let backup_path = path.with_extension("bak");
        for candidate in [&temp_path, &backup_path] {
            if let Some(data) = parse_saved_candidate(candidate) {
                std::fs::rename(candidate, path).map_err(|e| {
                    SyncError::new(
                        "sync_snippets_read_failed",
                        format!("Failed to promote recovered snippets file: {e}"),
                    )
                })?;
                return Ok(data);
            }
        }
        return Ok(SnippetsData { snippets: Vec::new() });
    }
    parse_saved_file(path)
}

fn parse_saved_candidate(path: &Path) -> Option<SnippetsData> {
    parse_saved_file(path).ok()
}

fn parse_saved_file(path: &Path) -> SyncResult<SnippetsData> {
    let raw = std::fs::read_to_string(path).map_err(|e| {
        SyncError::new("sync_snippets_read_failed", format!("Failed to read snippets file: {e}"))
    })?;
    serde_json::from_str::<SnippetsData>(&raw).map_err(|e| {
        SyncError::new("sync_snippets_parse_failed", format!("Failed to parse snippets file: {e}"))
    })
}

fn save_saved_atomic(path: &Path, data: &SnippetsData) -> SyncResult<()> {
    let json = serde_json::to_string_pretty(data).map_err(|e| {
        SyncError::new("sync_snippets_write_failed", format!("Failed to serialize snippets data: {e}"))
    })?;
    crate::atomic_io::durable_replace(path, json.as_bytes()).map_err(|e| {
        SyncError::new("sync_snippets_write_failed", format!("Failed to write snippets file: {e}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_snippet_snapshot_empty_when_file_missing() {
        let dir = std::env::temp_dir().join(format!(
            "zync-sync-snippets-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let records = load_snippet_sync_records(&dir).expect("load records");
        assert!(records.is_empty());
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn load_saved_recovers_backup_when_primary_is_missing() {
        let dir = std::env::temp_dir().join(format!(
            "zync-sync-snippets-recovery-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join(SNIPPETS_FILE);
        let backup_path = path.with_extension("bak");
        let data = SnippetsData {
            snippets: vec![Snippet {
                id: "snip-1".into(),
                name: "Recovered".into(),
                command: "echo recovered".into(),
                category: None,
                tags: None,
                connection_id: None,
                created_at: Some(1),
                updated_at: Some(2),
            }],
        };
        std::fs::write(
            &backup_path,
            serde_json::to_string_pretty(&data).expect("serialize"),
        )
        .expect("write backup");

        let recovered = load_snippet_sync_records(&dir).expect("recover backup");

        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].name, "Recovered");
        assert!(path.exists());
        assert!(!backup_path.exists());
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn load_saved_skips_corrupt_temp_and_recovers_valid_backup() {
        let dir = std::env::temp_dir().join(format!(
            "zync-sync-snippets-corrupt-temp-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join(SNIPPETS_FILE);
        let temp_path = path.with_extension("tmp");
        let backup_path = path.with_extension("bak");
        std::fs::write(&temp_path, "{not-json").expect("write corrupt temp");
        let data = SnippetsData {
            snippets: vec![Snippet {
                id: "snip-1".into(),
                name: "Recovered backup".into(),
                command: "echo recovered".into(),
                category: None,
                tags: None,
                connection_id: None,
                created_at: Some(1),
                updated_at: Some(2),
            }],
        };
        std::fs::write(
            &backup_path,
            serde_json::to_string_pretty(&data).expect("serialize"),
        )
        .expect("write backup");

        let recovered = load_saved(&path).expect("recover valid backup");

        assert_eq!(recovered.snippets[0].name, "Recovered backup");
        assert!(path.exists());
        assert!(temp_path.exists());
        assert!(!backup_path.exists());
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn load_snippet_sync_records_keeps_newest_duplicate() {
        let dir = std::env::temp_dir().join(format!(
            "zync-sync-snippets-dedup-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let newer = Snippet {
            id: "snip-1".into(),
            name: "Newer".into(),
            command: "echo newer".into(),
            category: None,
            tags: None,
            connection_id: None,
            created_at: Some(1),
            updated_at: Some(20),
        };
        let older = Snippet {
            name: "Older".into(),
            command: "echo older".into(),
            updated_at: Some(10),
            ..newer.clone()
        };
        std::fs::write(
            dir.join(SNIPPETS_FILE),
            serde_json::to_string_pretty(&SnippetsData {
                snippets: vec![newer, older],
            })
            .expect("serialize"),
        )
        .expect("write snippets");

        let records = load_snippet_sync_records(&dir).expect("load records");

        assert_eq!(records.len(), 1);
        assert_eq!(records[0].name, "Newer");
        assert_eq!(records[0].updated_at, 20);
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn apply_restore_adds_and_updates_records() {
        let dir = std::env::temp_dir().join(format!(
            "zync-sync-snippets-apply-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");

        let initial = SnippetsData {
            snippets: vec![Snippet {
                id: "snip-1".into(),
                name: "Old".into(),
                command: "ls".into(),
                category: None,
                tags: None,
                connection_id: None,
                created_at: Some(10),
                updated_at: Some(11),
            }],
        };
        let path = dir.join("snippets.json");
        std::fs::write(&path, serde_json::to_string_pretty(&initial).expect("serialize")).expect("write");

        let changes = vec![
            SnippetSyncRecord {
                logical_id: "snip-1".into(),
                name: "New".into(),
                command: "pwd".into(),
                category: Some("ops".into()),
                tags: vec!["core".into()],
                connection_id: Some("conn-1".into()),
                updated_at: 1,
            },
            SnippetSyncRecord {
                logical_id: "snip-2".into(),
                name: "Second".into(),
                command: "whoami".into(),
                category: None,
                tags: vec![],
                connection_id: None,
                updated_at: 1,
            },
        ];
        let (restored, updated) = apply_snippet_restore_records(&dir, &changes).expect("apply");
        assert_eq!(restored, 1);
        assert_eq!(updated, 1);
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn snippet_fallback_logical_id_uses_command_hash() {
        let first = Snippet {
            id: String::new(),
            name: "Deploy".into(),
            command: "echo first".into(),
            category: None,
            tags: None,
            connection_id: None,
            created_at: None,
            updated_at: None,
        };
        let second = Snippet {
            command: "echo second".into(),
            ..first.clone()
        };

        assert_ne!(
            snippet_fallback_logical_id(&first),
            snippet_fallback_logical_id(&second)
        );
    }

    #[test]
    fn snippet_fallback_logical_id_distinguishes_connections() {
        let first = Snippet {
            id: String::new(),
            name: "Deploy".into(),
            command: "echo deploy".into(),
            category: None,
            tags: None,
            connection_id: Some("conn-a".into()),
            created_at: None,
            updated_at: None,
        };
        let second = Snippet {
            connection_id: Some("conn-b".into()),
            ..first.clone()
        };

        assert_ne!(
            snippet_fallback_logical_id(&first),
            snippet_fallback_logical_id(&second)
        );
    }

    #[test]
    fn restore_blank_logical_id_matches_existing_fallback_record() {
        let dir = std::env::temp_dir().join(format!(
            "zync-sync-snippets-blank-id-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let existing = Snippet {
            id: String::new(),
            name: "Deploy".into(),
            command: "echo deploy".into(),
            category: None,
            tags: None,
            connection_id: None,
            created_at: Some(1),
            updated_at: Some(1),
        };
        let fallback_id = snippet_fallback_logical_id(&existing);
        std::fs::write(
            dir.join(SNIPPETS_FILE),
            serde_json::to_string_pretty(&SnippetsData {
                snippets: vec![existing],
            })
            .expect("serialize"),
        )
        .expect("write");

        let record = SnippetSyncRecord {
            logical_id: String::new(),
            name: "Deploy".into(),
            command: "echo deploy".into(),
            category: Some("ops".into()),
            tags: vec![],
            connection_id: None,
            updated_at: 9,
        };
        let (restored, updated) = apply_snippet_restore_records(&dir, &[record]).expect("apply");
        assert_eq!((restored, updated), (0, 1));
        let saved = load_saved(&dir.join(SNIPPETS_FILE)).expect("read");
        assert_eq!(saved.snippets.len(), 1);
        assert_eq!(saved.snippets[0].id, fallback_id);
        assert_eq!(saved.snippets[0].updated_at, Some(9_000));
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn map_snippet_uses_real_timestamps() {
        let record = map_snippet(
            Snippet {
                id: "snip-1".into(),
                name: "Deploy".into(),
                command: "echo deploy".into(),
                category: None,
                tags: None,
                connection_id: None,
                created_at: Some(42),
                updated_at: Some(77),
            },
            "snip-1".into(),
        );

        assert_eq!(record.updated_at, 77);
    }
}
