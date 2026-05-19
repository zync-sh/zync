#![allow(dead_code)]

use super::types::{SyncError, SyncResult};
use crate::snippets::{Snippet, SnippetsData};
use std::collections::BTreeMap;
use std::io::ErrorKind;
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
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| {
        SyncError::new(
            "sync_snippets_read_failed",
            format!("Failed to read snippets source file: {e}"),
        )
    })?;
    let data = serde_json::from_str::<SnippetsData>(&raw).map_err(|e| {
        SyncError::new(
            "sync_snippets_parse_failed",
            format!("Failed to parse snippets source file: {e}"),
        )
    })?;
    let mut dedup: BTreeMap<String, SnippetSyncRecord> = BTreeMap::new();
    for snip in data.snippets {
        let logical_id = if snip.id.trim().is_empty() {
            format!("{}:{}", snip.name.trim().to_ascii_lowercase(), snip.command.len())
        } else {
            snip.id.trim().to_string()
        };
        dedup.insert(logical_id.clone(), map_snippet(snip, logical_id));
    }
    Ok(dedup.into_values().collect())
}

fn map_snippet(snip: Snippet, logical_id: String) -> SnippetSyncRecord {
    SnippetSyncRecord {
        logical_id,
        name: snip.name,
        command: snip.command,
        category: snip.category.filter(|v| !v.trim().is_empty()),
        tags: snip.tags.unwrap_or_default(),
        connection_id: snip.connection_id.filter(|v| !v.trim().is_empty()),
        updated_at: 0,
    }
}

pub fn apply_snippet_restore_records(data_dir: &Path, records: &[SnippetSyncRecord]) -> SyncResult<(u64, u64)> {
    if records.is_empty() {
        return Ok((0, 0));
    }
    let path = data_dir.join(SNIPPETS_FILE);
    let mut saved = load_saved(path.as_path())?;
    let mut restored = 0u64;
    let mut updated = 0u64;
    for record in records {
        if let Some(existing) = saved.snippets.iter_mut().find(|s| s.id == record.logical_id) {
            existing.name = record.name.clone();
            existing.command = record.command.clone();
            existing.category = record.category.clone();
            existing.tags = if record.tags.is_empty() { None } else { Some(record.tags.clone()) };
            existing.connection_id = record.connection_id.clone();
            updated = updated.saturating_add(1);
            continue;
        }
        saved.snippets.push(Snippet {
            id: record.logical_id.clone(),
            name: record.name.clone(),
            command: record.command.clone(),
            category: record.category.clone(),
            tags: if record.tags.is_empty() { None } else { Some(record.tags.clone()) },
            connection_id: record.connection_id.clone(),
        });
        restored = restored.saturating_add(1);
    }
    save_saved_atomic(path.as_path(), &saved)?;
    Ok((restored, updated))
}

fn load_saved(path: &Path) -> SyncResult<SnippetsData> {
    if !path.exists() {
        return Ok(SnippetsData { snippets: Vec::new() });
    }
    let raw = std::fs::read_to_string(path).map_err(|e| {
        SyncError::new("sync_snippets_read_failed", format!("Failed to read snippets file: {e}"))
    })?;
    serde_json::from_str::<SnippetsData>(&raw).map_err(|e| {
        SyncError::new("sync_snippets_parse_failed", format!("Failed to parse snippets file: {e}"))
    })
}

fn save_saved_atomic(path: &Path, data: &SnippetsData) -> SyncResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| SyncError::new("sync_snippets_write_failed", "Invalid snippets file path"))?;
    std::fs::create_dir_all(parent).map_err(|e| {
        SyncError::new("sync_snippets_write_failed", format!("Failed to create snippets dir: {e}"))
    })?;
    let temp_path = path.with_extension("tmp");
    let json = serde_json::to_string_pretty(data).map_err(|e| {
        SyncError::new("sync_snippets_write_failed", format!("Failed to serialize snippets data: {e}"))
    })?;
    std::fs::write(&temp_path, json).map_err(|e| {
        SyncError::new("sync_snippets_write_failed", format!("Failed to write temp snippets file: {e}"))
    })?;
    match std::fs::rename(&temp_path, path) {
        Ok(()) => Ok(()),
        Err(rename_err) if rename_err.kind() == ErrorKind::AlreadyExists && path.exists() => {
            let _ = std::fs::remove_file(path);
            std::fs::rename(&temp_path, path).map_err(|e| {
                let _ = std::fs::remove_file(&temp_path);
                SyncError::new("sync_snippets_write_failed", format!("Failed to finalize snippets file: {e}"))
            })
        }
        Err(rename_err) => {
            let _ = std::fs::remove_file(&temp_path);
            Err(SyncError::new(
                "sync_snippets_write_failed",
                format!("Failed to finalize snippets file: {rename_err}"),
            ))
        }
    }
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
}
