use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::AppHandle;

const SESSION_VERSION: u32 = 1;
/// Maximum terminal tabs persisted per connection scope.
const MAX_TABS_PER_SCOPE: usize = 20;

// ─── Data types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TerminalTabSnapshot {
    pub id: String,
    pub title: String,
    pub cwd: Option<String>,
    pub initial_path: Option<String>,
    pub is_synced: Option<bool>,
}

/// Snapshot of a sidebar connection tab.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TabSnapshot {
    pub id: String,
    pub tab_type: String,
    pub title: String,
    pub connection_id: Option<String>,
    pub view: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionData {
    /// Incremented when the schema changes to allow forward-only migrations.
    pub version: u32,
    pub active_tab_id: Option<String>,
    pub active_connection_id: Option<String>,
    /// Full snapshots of open sidebar tabs in order.
    pub tabs: Vec<TabSnapshot>,
    /// Terminal tabs keyed by connection scope ("local" or connection ID).
    pub terminals: HashMap<String, Vec<TerminalTabSnapshot>>,
    /// Active terminal ID per connection scope.
    pub active_terminal_ids: HashMap<String, String>,
}

// ─── Schema migration ────────────────────────────────────────────────────────

fn migrate(mut data: SessionData) -> SessionData {
    // v0 → v1: no structural changes needed, just stamp the version.
    if data.version == 0 {
        data.version = 1;
    }
    // If the file was written by a newer app version, log a warning and keep
    // the data as-is. serde(default) ensures unknown fields are ignored and
    // missing new fields use their default values, so this is safe.
    if data.version > SESSION_VERSION {
        eprintln!(
            "[Session] Warning: session file version {} is newer than supported version {}. \
             Some data may be ignored.",
            data.version, SESSION_VERSION
        );
    }
    data
}

// ─── Tauri commands ───────────────────────────────────────────────────────────

/// Load the session snapshot from disk.
/// Returns `None` when no session file exists yet.
/// Deserialisation failures are silently swallowed and return `None` so a
/// corrupt file never prevents the app from starting.
#[tauri::command]
pub async fn session_load(app: AppHandle) -> Result<Option<SessionData>, String> {
    let path = crate::commands::get_data_dir(&app).join("session.json");

    match tokio::fs::read_to_string(&path).await {
        Ok(s) => {
            // Silently return None on any parse error — corrupt file = empty session.
            let data = serde_json::from_str::<SessionData>(&s).ok().map(migrate);
            Ok(data)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Persist the session snapshot atomically (write to tmp → rename).
/// Enforces MAX_TABS_PER_SCOPE before writing.
#[tauri::command]
pub async fn session_save(app: AppHandle, mut data: SessionData) -> Result<(), String> {
    // Enforce per-scope tab cap before writing.
    for (scope, tabs) in data.terminals.iter_mut() {
        if tabs.len() > MAX_TABS_PER_SCOPE {
            eprintln!(
                "[Session] Truncating {} terminal tabs to {} for scope '{}'",
                tabs.len(), MAX_TABS_PER_SCOPE, scope
            );
            tabs.truncate(MAX_TABS_PER_SCOPE);
        }
    }
    data.version = SESSION_VERSION;

    let dir = crate::commands::get_data_dir(&app);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;

    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;

    // Atomic write: write to a temp file then rename so a crash mid-write never
    // leaves a corrupt session.json. On Windows, tokio::fs::rename replaces an
    // existing destination atomically (same as POSIX on the same volume).
    let tmp = dir.join("session.tmp");
    tokio::fs::write(&tmp, &json).await.map_err(|e| e.to_string())?;
    tokio::fs::rename(&tmp, dir.join("session.json")).await.map_err(|e| e.to_string())
}
