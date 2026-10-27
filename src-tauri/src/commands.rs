use crate::fs::{FileEntry, FileSystem, SftpIdentityMaps};
use crate::fs_volumes::{list_local_volumes, FileVolume};
use crate::pty::PtyManager;
use crate::ssh::{Client, SshManager};
use crate::types::*;
use anyhow::Result;
use russh::client::{Handle, Msg};
use russh::Channel;
use secrecy::{ExposeSecret, SecretString};
use std::collections::{HashMap, HashSet};
use std::io::ErrorKind;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex as StdMutex};
use std::time::{Duration, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_store::StoreExt;
use tokio::sync::Mutex;

use crate::tunnels::session_failure::{session_failure_channel, spawn_session_failure_watcher};
use crate::tunnels::TunnelManager;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_IMPORT_TEXT_BYTES: usize = 1_048_576; // 1 MiB
const MAX_CONNECTION_IMPORT_BYTES: u64 = 5 * 1024 * 1024; // 5 MiB
const SETTINGS_CHANGED_ON_DISK_ERROR_CODE: &str = "SETTINGS_CHANGED_ON_DISK";
static DATA_DIR_CACHE: StdMutex<Option<std::path::PathBuf>> = StdMutex::new(None);
static DATA_DIR_WARNED: StdMutex<Option<String>> = StdMutex::new(None);

fn warn_data_dir_fallback(custom_dir: &Path, error: &std::io::Error, default_dir: &Path) {
    let key = custom_dir.display().to_string();
    let mut warned = DATA_DIR_WARNED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if warned.as_deref() == Some(key.as_str()) {
        return;
    }
    *warned = Some(key);
    eprintln!(
        "[DataDir] Could not create custom dataPath {:?} ({}). Using default {:?}.",
        custom_dir, error, default_dir
    );
}
fn is_transient_data_dir_error(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        ErrorKind::PermissionDenied | ErrorKind::Interrupted | ErrorKind::WouldBlock
    )
}
static SETTINGS_MUTATION_LOCK: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));
static NEXT_CONNECT_TASK_ID: AtomicU64 = AtomicU64::new(1);
pub(crate) use crate::sync::domain_hosts::CONNECTIONS_MUTATION_LOCK;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionExportRequest {
    pub path: String,
    pub format: String, // zync | json | csv | ssh_config
    pub connection_ids: Option<Vec<String>>,
    pub include_secrets: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionImportRequest {
    pub path: String,
    pub format: Option<String>, // auto | zync | json | csv
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ZyncConnectionsExport {
    format: String,
    version: u32,
    exported_at_ms: u64,
    connections: Vec<SavedConnection>,
    folders: Vec<Folder>,
    #[serde(default)]
    tunnels: Vec<SavedTunnel>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionImportResult {
    pub connections: Vec<SavedConnection>,
    pub folders: Vec<Folder>,
    #[serde(default)]
    pub tunnels: Vec<SavedTunnel>,
}

#[derive(Debug, Serialize)]
pub struct SystemInfo {
    pub data_dir: String,
    pub app_root: String,
}

/// Helper function to get the data directory.
/// Reads the configured `dataPath` from settings.json if available,
/// otherwise falls back to the default app_data_dir.
/// This ensures user-selected paths from the setup wizard are respected on all platforms.
fn merge_json_values(base: Value, overlay: Value) -> Value {
    match (base, overlay) {
        (Value::Object(mut base_obj), Value::Object(overlay_obj)) => {
            for (key, overlay_value) in overlay_obj {
                let merged = if let Some(base_value) = base_obj.remove(&key) {
                    merge_json_values(base_value, overlay_value)
                } else {
                    overlay_value
                };
                base_obj.insert(key, merged);
            }
            Value::Object(base_obj)
        }
        (_, overlay_other) => overlay_other,
    }
}

/// Resolve the native, user-scoped settings directory (OS config convention).
/// Example: `%APPDATA%/Zync/User` on Windows, `~/.config/Zync/User` on Linux.
fn get_native_settings_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let config_root = app.path().config_dir().map_err(|e| e.to_string())?;
    let dir = config_root.join("Zync").join("User");
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

/// Canonical settings file path used by Zync as the primary source of truth.
fn get_native_settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(get_native_settings_dir(app)?.join("settings.json"))
}

/// Backup path for the last successfully written settings payload.
fn get_last_known_good_settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(get_native_settings_dir(app)?.join("settings.last-known-good.json"))
}

/// Legacy settings locations that we still read once for migration compatibility.
fn get_legacy_settings_candidates(app: &AppHandle) -> Vec<std::path::PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        candidates.push(app_data_dir.join("settings.json"));
    }
    candidates.extend(
        crate::identity_migration::legacy_app_data_dir_candidates(
            app.path().app_data_dir().ok().as_deref(),
        )
        .into_iter()
        .map(|path| path.join("settings.json")),
    );
    if let Ok(home_dir) = app.path().home_dir() {
        candidates.push(home_dir.join(".zync").join("settings.json"));
    }
    crate::identity_migration::dedupe_paths(candidates)
}

/// Write file content atomically via temporary file + rename.
/// Prevents partial/corrupt settings writes on crashes/interruption.
fn write_atomic_file(path: &std::path::Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }

    let unique_suffix = uuid::Uuid::new_v4();
    let tmp_path = path.with_extension(format!("json.tmp.{}", unique_suffix));
    let mut tmp_file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&tmp_path)
        .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    std::fs::set_permissions(
        &tmp_path,
        std::os::unix::fs::PermissionsExt::from_mode(0o600),
    )
    .map_err(|e| e.to_string())?;
    use std::io::Write;
    tmp_file
        .write_all(content.as_bytes())
        .map_err(|e| e.to_string())?;
    tmp_file.sync_all().map_err(|e| e.to_string())?;
    let replace_result = if path.exists() {
        #[cfg(target_os = "windows")]
        {
            let backup_path = path.with_extension(format!("json.bak.{}", unique_suffix));
            match std::fs::rename(path, &backup_path) {
                Ok(()) => match std::fs::rename(&tmp_path, path) {
                    Ok(()) => {
                        let _ = std::fs::remove_file(&backup_path);
                        Ok(())
                    }
                    Err(rename_error) => {
                        if let Err(restore_error) = std::fs::rename(&backup_path, path) {
                            eprintln!(
                                "[settings] Failed to restore backup after rename error. backup_path={}, tmp_path={}, target_path={}, rename_error={}, restore_error={}",
                                backup_path.display(),
                                tmp_path.display(),
                                path.display(),
                                rename_error,
                                restore_error
                            );
                        }
                        Err(rename_error.to_string())
                    }
                },
                Err(error) => Err(format!(
                    "Failed to move existing file to backup before atomic replace: {}",
                    error
                )),
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            std::fs::rename(&tmp_path, path).map_err(|e| e.to_string())
        }
    } else {
        std::fs::rename(&tmp_path, path).map_err(|e| e.to_string())
    };

    if let Err(error) = replace_result {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(error);
    }

    Ok(())
}
/// Encode settings command errors in a stable, machine-readable shape.
fn settings_command_error(code: &str, message: &str) -> String {
    serde_json::json!({
        "code": code,
        "message": message
    })
    .to_string()
}

/// Guard that settings payload is a top-level JSON object.
fn ensure_object_settings(value: Value) -> Result<Value, String> {
    if value.is_object() {
        Ok(value)
    } else {
        Err("settings.json must be a JSON object at the top level.".to_string())
    }
}

/// Lightweight schema validation for known settings keys.
/// Keeps external/manual edits safe without requiring a full schema engine.
fn validate_settings_schema(settings: &Value) -> Result<(), String> {
    let obj = settings
        .as_object()
        .ok_or_else(|| "settings.json must be an object.".to_string())?;

    if let Some(theme) = obj.get("theme") {
        if !theme.is_string() {
            return Err("Invalid \"theme\": expected string.".to_string());
        }
    }
    if let Some(window_opacity) = obj.get("windowOpacity") {
        let opacity = window_opacity
            .as_f64()
            .ok_or_else(|| "Invalid \"windowOpacity\": expected number 0..1.".to_string())?;
        if !(0.0..=1.0).contains(&opacity) {
            return Err("Invalid \"windowOpacity\": expected number between 0 and 1.".to_string());
        }
    }
    if let Some(enable_vibrancy) = obj.get("enableVibrancy") {
        if !enable_vibrancy.is_boolean() {
            return Err("Invalid \"enableVibrancy\": expected boolean.".to_string());
        }
    }
    if let Some(sidebar_width) = obj.get("sidebarWidth") {
        let width = sidebar_width
            .as_i64()
            .ok_or_else(|| "Invalid \"sidebarWidth\": expected integer.".to_string())?;
        if !(160..=640).contains(&width) {
            return Err(
                "Invalid \"sidebarWidth\": expected integer between 160 and 640.".to_string(),
            );
        }
    }
    if let Some(mode) = obj.get("mainTabCloseButton") {
        if !matches!(mode.as_str(), Some("hover" | "always" | "active" | "hidden")) {
            return Err(
                "Invalid \"mainTabCloseButton\": expected hover, always, active, or hidden.".to_string(),
            );
        }
    }
    if let Some(data_path) = obj.get("dataPath") {
        if !(data_path.is_null() || data_path.is_string()) {
            return Err("Invalid \"dataPath\": expected string or null.".to_string());
        }
    }
    if let Some(log_path) = obj.get("logPath") {
        if !(log_path.is_null() || log_path.is_string()) {
            return Err("Invalid \"logPath\": expected string or null.".to_string());
        }
    }
    if let Some(ai) = obj.get("ai") {
        if !ai.is_object() {
            return Err("Invalid \"ai\": expected object.".to_string());
        }
    }
    if let Some(editor) = obj.get("editor") {
        if !editor.is_object() {
            return Err("Invalid \"editor\": expected object.".to_string());
        }
    }
    if let Some(notifications) = obj.get("notifications") {
        let notifications_obj = notifications
            .as_object()
            .ok_or_else(|| "Invalid \"notifications\": expected object.".to_string())?;
        if let Some(position) = notifications_obj.get("position") {
            let position = position.as_str().ok_or_else(|| {
                "Invalid \"notifications.position\": expected string.".to_string()
            })?;
            if !matches!(
                position,
                "bottom-right" | "bottom-left" | "top-right" | "top-left"
            ) {
                return Err(
                    "Invalid \"notifications.position\": expected bottom-right, bottom-left, top-right, or top-left."
                        .to_string(),
                );
            }
        }
        if let Some(do_not_disturb) = notifications_obj.get("doNotDisturb") {
            if !do_not_disturb.is_boolean() {
                return Err("Invalid \"notifications.doNotDisturb\": expected boolean.".to_string());
            }
        }
        if let Some(play_sound) = notifications_obj.get("playSound") {
            if !play_sound.is_boolean() {
                return Err("Invalid \"notifications.playSound\": expected boolean.".to_string());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tab_chrome_settings_tests {
    use super::validate_settings_schema;
    use serde_json::json;

    #[test]
    fn close_button_default_is_optional_and_strict() {
        assert!(validate_settings_schema(&json!({})).is_ok());
        for mode in ["hover", "always", "active", "hidden"] {
            assert!(validate_settings_schema(&json!({"mainTabCloseButton": mode})).is_ok());
        }
        for mode in [json!(null), json!(false), json!(1), json!("future"), json!({})] {
            assert!(validate_settings_schema(&json!({"mainTabCloseButton": mode})).is_err());
        }
    }
}

/// Read + parse + validate a settings file from disk.
fn read_settings_from_path(path: &std::path::Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(Value::Object(serde_json::Map::new()));
    }
    let data = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read settings.json: {}", e))?;
    let parsed = serde_json::from_str::<Value>(&data)
        .map_err(|e| format!("Invalid JSON in settings.json: {}", e))?;
    let object_settings = ensure_object_settings(parsed)?;
    validate_settings_schema(&object_settings)?;
    Ok(object_settings)
}

/// Last-modified timestamp in milliseconds, used for optimistic concurrency checks.
fn settings_mtime_ms(path: &std::path::Path) -> Option<u64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

/// Read effective settings from the native path.
/// If missing, migrate from legacy locations once; otherwise return empty object.
pub(crate) fn read_effective_settings(app: &AppHandle) -> Result<Value, String> {
    let settings_path = get_native_settings_path(app)?;
    if settings_path.exists() {
        return read_settings_from_path(&settings_path);
    }

    for legacy_path in get_legacy_settings_candidates(app) {
        if !legacy_path.exists() {
            continue;
        }
        let legacy_settings = read_settings_from_path(&legacy_path)?;
        if let Ok(_mutation_guard) = SETTINGS_MUTATION_LOCK.try_lock() {
            if !settings_path.exists() {
                let json =
                    serde_json::to_string_pretty(&legacy_settings).map_err(|e| e.to_string())?;
                write_atomic_file(&settings_path, &json)?;
            }
        }
        return Ok(legacy_settings);
    }

    Ok(Value::Object(serde_json::Map::new()))
}

/// Persist validated settings to native path and update last-known-good backup.
fn persist_settings_json(app: &AppHandle, settings: &Value) -> Result<(), String> {
    ensure_object_settings(settings.clone())?;
    validate_settings_schema(settings)?;

    let settings_path = get_native_settings_path(app)?;
    let backup_path = get_last_known_good_settings_path(app)?;
    if settings_path.exists() {
        let existing = std::fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
        match serde_json::from_str::<Value>(&existing) {
            Ok(parsed) => match ensure_object_settings(parsed) {
                Ok(valid_existing) => {
                    validate_settings_schema(&valid_existing)?;
                    write_atomic_file(&backup_path, &existing)?;
                }
                Err(error) => {
                    eprintln!(
                        "[settings] Skipping last-known-good backup due to invalid existing settings at {}: {}",
                        settings_path.display(),
                        error
                    );
                }
            },
            Err(error) => {
                eprintln!(
                    "[settings] Skipping last-known-good backup due to invalid JSON at {}: {}",
                    settings_path.display(),
                    error
                );
            }
        }
    }

    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    write_atomic_file(&settings_path, &json)
}

pub(crate) fn persist_settings_after_secret_migration(
    app: &AppHandle,
    settings: &Value,
) -> Result<(), String> {
    ensure_object_settings(settings.clone())?;
    validate_settings_schema(settings)?;
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    let settings_path = get_native_settings_path(app)?;
    if settings_path.exists() {
        write_atomic_file(&get_last_known_good_settings_path(app)?, &json)?;
    }
    write_atomic_file(&settings_path, &json)
}

pub(crate) fn scrub_settings_backup_after_secret_migration(
    app: &AppHandle,
    providers: &[&str],
) -> Result<(), String> {
    scrub_settings_file_api_keys(&get_last_known_good_settings_path(app)?, providers)
}

fn scrub_settings_file_api_keys(path: &std::path::Path, providers: &[&str]) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let mut settings = read_settings_from_path(path)?;
    let Some(keys) = settings
        .get_mut("ai")
        .and_then(|ai| ai.get_mut("keys"))
        .and_then(Value::as_object_mut)
    else {
        return Ok(());
    };
    let mut changed = false;
    for provider in providers {
        changed |= keys.remove(*provider).is_some();
    }
    if changed {
        let json = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
        write_atomic_file(path, &json)?;
    }
    Ok(())
}

#[cfg(test)]
mod ai_settings_migration_tests {
    use super::scrub_settings_file_api_keys;

    #[test]
    fn scrubs_known_ai_keys_from_backup_while_preserving_unknown_settings() {
        let dir =
            std::env::temp_dir().join(format!("zync-ai-settings-backup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create test directory");
        let path = dir.join("settings.last-known-good.json");
        std::fs::write(
            &path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "theme": "dark",
                "ai": { "keys": { "openai": "plaintext", "custom": "preserve" } }
            }))
            .expect("serialize settings"),
        )
        .expect("write backup settings");

        scrub_settings_file_api_keys(&path, &["openai", "claude"]).expect("scrub backup settings");
        let scrubbed: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).expect("read scrubbed settings"))
                .expect("parse scrubbed settings");
        assert_eq!(scrubbed["theme"], "dark");
        assert!(scrubbed["ai"]["keys"].get("openai").is_none());
        assert_eq!(scrubbed["ai"]["keys"]["custom"], "preserve");

        let _ = std::fs::remove_dir_all(dir);
    }
}

pub fn get_data_dir(app: &AppHandle) -> std::path::PathBuf {
    if let Ok(cache) = DATA_DIR_CACHE.lock() {
        if let Some(cached) = cache.clone() {
            return cached;
        }
    }

    let default_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let merged_settings =
        read_effective_settings(app).unwrap_or_else(|_| Value::Object(serde_json::Map::new()));
    let has_custom_data_path = merged_settings
        .get("dataPath")
        .and_then(|v| v.as_str())
        .is_some_and(|value| !value.trim().is_empty());

    crate::identity_migration::migrate_default_dirs(app, &default_dir, has_custom_data_path);

    let (resolved, cache_result) =
        if let Some(data_path) = merged_settings.get("dataPath").and_then(|v| v.as_str()) {
            if !data_path.is_empty() {
                let custom_dir = std::path::PathBuf::from(data_path);
                if custom_dir.is_file() {
                    eprintln!(
                    "[DataDir] Custom dataPath is a file, not a directory: {:?}. Using default.",
                    custom_dir
                );
                    (default_dir.clone(), true)
                } else if custom_dir.is_dir() {
                    (custom_dir, true)
                } else if let Err(e) = std::fs::create_dir_all(&custom_dir) {
                    warn_data_dir_fallback(&custom_dir, &e, &default_dir);
                    // Retry on transient I/O errors; cache default for stale/invalid paths.
                    (default_dir.clone(), !is_transient_data_dir_error(&e))
                } else {
                    (custom_dir, true)
                }
            } else {
                (default_dir.clone(), true)
            }
        } else {
            (default_dir.clone(), true)
        };

    if let Err(e) = std::fs::create_dir_all(&resolved) {
        eprintln!(
            "[DataDir] Warning: could not create data directory {:?}: {}",
            resolved, e
        );
    }

    if cache_result {
        if let Ok(mut cache) = DATA_DIR_CACHE.lock() {
            *cache = Some(resolved.clone());
        }
    }

    resolved
}

fn clear_data_dir_cache() {
    if let Ok(mut cache) = DATA_DIR_CACHE.lock() {
        *cache = None;
    }
    if let Ok(mut warned) = DATA_DIR_WARNED.lock() {
        *warned = None;
    }
}

fn data_path_from_settings(settings: &Value) -> Option<String> {
    settings
        .get("dataPath")
        .and_then(|v| v.as_str())
        .map(|value| value.to_string())
}

fn data_path_from_raw_json(raw: &str) -> Option<String> {
    let parsed = serde_json::from_str::<Value>(raw).ok()?;
    parsed
        .get("dataPath")
        .and_then(|v| v.as_str())
        .map(|value| value.to_string())
}

#[derive(Debug, Deserialize)]
pub struct CopyOperation {
    pub from: String,
    pub to: String,
}

#[derive(Clone)]
pub struct AppState {
    pub app_handle: tauri::AppHandle,
    pub connections: Arc<Mutex<HashMap<String, ConnectionHandle>>>,
    pub pty_manager: Arc<PtyManager>,
    pub file_system: Arc<FileSystem>,
    pub ssh_manager: Arc<SshManager>,
    pub tunnel_manager: Arc<TunnelManager>,
    pub snippets_manager: Arc<crate::snippets::SnippetsManager>,
    pub connect_tasks: Arc<Mutex<HashMap<String, ConnectAttempt>>>,
    pub transfers: crate::transfers::TransferRegistry,
    pub file_transfers: Arc<crate::file_transfers::Service>,
    pub permission_elevation: Arc<crate::file_permissions::elevation::Service>,
    pub folder_sizes: Arc<crate::folder_sizes::Service>,
    // Agent v2: active run cancellation tokens
    pub agent_runs: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    // Agent v2: pending checkpoint responders (ask_user tool)
    pub agent_checkpoints: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>>,
    // Agent v2: per-scope command whitelist (scope = connection_id or "local")
    pub command_whitelist: Arc<Mutex<HashMap<String, std::collections::HashSet<String>>>>,
    // Ghost suggestions: frecency-scored command history, persisted to disk.
    pub ghost_manager: Arc<crate::ghost::GhostManager>,
    pub shell_icon_cache: crate::shell_icons::IconCache,
    pub shell_icon_cache_path: std::path::PathBuf,
}

impl AppState {
    pub fn new(data_dir: std::path::PathBuf, app_handle: tauri::AppHandle) -> Self {
        let (failure_tx, failure_rx) = session_failure_channel();
        spawn_session_failure_watcher(app_handle.clone(), failure_rx);

        Self {
            app_handle: app_handle.clone(),
            connections: Arc::new(Mutex::new(HashMap::new())),
            pty_manager: Arc::new(PtyManager::new()),
            file_system: Arc::new(FileSystem::new()),
            ssh_manager: Arc::new(SshManager::with_app(app_handle.clone())),
            tunnel_manager: Arc::new(TunnelManager::new(failure_tx)),
            snippets_manager: Arc::new(crate::snippets::SnippetsManager::new(data_dir.clone())),
            connect_tasks: Arc::new(Mutex::new(HashMap::new())),
            transfers: Arc::new(Mutex::new(HashMap::new())),
            permission_elevation: Arc::default(),
            folder_sizes: Default::default(),
            file_transfers: Arc::new(crate::file_transfers::Service::new(data_dir.clone()).with_started_callback({
                let app = app_handle.clone();
                move |receipt| { let _ = app.emit("file-transfer-started", receipt); }
            })),
            agent_runs: Arc::new(Mutex::new(HashMap::new())),
            agent_checkpoints: Arc::new(Mutex::new(HashMap::new())),
            command_whitelist: Arc::new(Mutex::new(HashMap::new())),
            ghost_manager: Arc::new(crate::ghost::GhostManager::new(&data_dir)),
            shell_icon_cache: crate::shell_icons::new_cache(),
            shell_icon_cache_path: data_dir.join("shell-icon-cache.json"),
        }
    }
}

#[allow(dead_code)]
pub struct ConnectionHandle {
    pub config: ConnectionConfig,
    pub session: Option<Arc<Mutex<Handle<Client>>>>,
    pub sftp_session: Option<Arc<russh_sftp::client::SftpSession>>,
    /// Opaque runtime binding, renewed whenever an SFTP channel is installed.
    pub file_permission_session: String,
    pub sftp_identity_maps: Arc<tokio::sync::OnceCell<SftpIdentityMaps>>,
    pub detected_os: Option<String>,
    /// Canonical uname kernel name for this transport, separate from distribution IDs.
    pub detected_kernel_os: Option<String>,
    pub detected_shell: Option<String>,
    /// SSH userauth banner, shown once when this connection opens its first terminal.
    pub auth_banner: Option<String>,
    /// Public key accepted for this authenticated transport, used to bind explicit assessment comparisons.
    pub host_key_fingerprint:String,
    pub uses_vault_auth: bool,
    /// Bumped on each new connect/reconnect; stale in-flight reconnects must match before replacing.
    pub reconnect_generation: u64,
    /// Serializes reconnect attempts for this connection to prevent races.
    pub reconnect_lock: Arc<tokio::sync::Mutex<()>>,
}

pub enum ConnectAttempt {
    Preparing {
        attempt_id: String,
        /// Set to true by `ssh_cancel_connect` so preparation can abort promptly.
        cancel: tokio::sync::watch::Sender<bool>,
    },
    Connecting {
        attempt_id: String,
        abort_handle: tokio::task::AbortHandle,
    },
}

/// Establishes the SSH transport without opening a session channel.
///
/// OpenSSH keeps PAM login messages for the first session channel. A terminal
/// must therefore get a chance to claim that channel before SFTP and metadata
/// probes run, otherwise the server's MOTD is discarded into a non-interactive
/// channel.
async fn reconnect_connection(
    config: &ConnectionConfig,
    ssh_manager: &crate::ssh::SshManager,
    tunnel_manager: &crate::tunnels::TunnelManager,
) -> Result<ConnectionHandle, String> {
    let (session, auth_banner, host_key_fingerprint) = ssh_manager
        .connect_with_identity(config.clone(), Arc::new(tunnel_manager.clone()))
        .await
        .map_err(|e| format!("Failed to connect: {}", e))?;

    Ok(ConnectionHandle {
        config: config.clone(),
        session: Some(Arc::new(Mutex::new(session))),
        sftp_session: None,
        file_permission_session: uuid::Uuid::new_v4().to_string(),
        sftp_identity_maps: Arc::new(tokio::sync::OnceCell::new()),
        detected_os: None,
        detected_kernel_os: None,
        detected_shell: None,
        auth_banner,
        host_key_fingerprint,
        uses_vault_auth: config_uses_vault_auth(config),
        reconnect_generation: 0,
        reconnect_lock: Arc::new(tokio::sync::Mutex::new(())),
    })
}

/// Recursively resolves every `VaultRef` auth method in `config` (and jump hosts)
/// to a concrete `Password` or `PrivateKeyData` using the vault service.
/// Must be called before any SSH connect/test operation.
fn config_uses_vault_auth(config: &ConnectionConfig) -> bool {
    matches!(
        config.auth_method,
        crate::types::AuthMethod::VaultRef { .. }
    ) || config.agent_forwarding.as_ref().is_some_and(|forwarding| {
        matches!(
            forwarding.auth_method,
            crate::types::AuthMethod::VaultRef { .. }
        )
    }) || config
        .jump_host
        .as_ref()
        .map(|jump| config_uses_vault_auth(jump.as_ref()))
        .unwrap_or(false)
}

#[derive(Debug, Clone)]
struct RelinkedVaultRefUpdate {
    connection_id: String,
    credential_id: String,
    item_id: String,
    vault_id: Option<String>,
}

fn resolve_vault_refs<'a>(
    config: &'a mut ConnectionConfig,
    vault: &'a tokio::sync::Mutex<crate::vault::store::VaultService>,
) -> std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<Vec<RelinkedVaultRefUpdate>, String>> + Send + 'a>,
> {
    Box::pin(async move {
        let mut relinked =
            resolve_auth_method(&config.id, &mut config.auth_method, vault, false).await?;
        if let Some(forwarding) = config.agent_forwarding.as_mut() {
            relinked.extend(
                resolve_auth_method(
                    &forwarding.source_connection_id,
                    &mut forwarding.auth_method,
                    vault,
                    true,
                )
                .await?,
            );
        }
        if let Some(jump) = config.jump_host.as_mut() {
            relinked.extend(resolve_vault_refs(jump.as_mut(), vault).await?);
        }
        Ok(relinked)
    })
}

fn persist_relinked_vault_refs(
    app: &AppHandle,
    updates: &[RelinkedVaultRefUpdate],
) -> Result<(), String> {
    if updates.is_empty() {
        return Ok(());
    }

    let data_dir = get_data_dir(app);
    let file_path = data_dir.join("connections.json");
    if !file_path.exists() {
        return Ok(());
    }

    let _connections_guard = CONNECTIONS_MUTATION_LOCK
        .lock()
        .map_err(|e| e.to_string())?;
    let data = std::fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
    let mut saved_data: SavedData = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    let mut changed = false;

    for update in updates {
        if let Some(connection) = saved_data
            .connections
            .iter_mut()
            .find(|connection| connection.id == update.connection_id)
        {
            if let Some(auth_ref) = connection.auth_ref.as_mut() {
                let credential_matches = auth_ref
                    .credential_id
                    .as_deref()
                    .map(|value| value == update.credential_id)
                    .unwrap_or(false);
                if credential_matches && auth_ref.item_id != update.item_id {
                    auth_ref.item_id = update.item_id.clone();
                    changed = true;
                }
                if let Some(vault_id) = update.vault_id.as_deref() {
                    if credential_matches && auth_ref.vault_id != vault_id {
                        auth_ref.vault_id = vault_id.to_string();
                        changed = true;
                    }
                }
            }
        }
    }

    if changed {
        let json = serde_json::to_string_pretty(&saved_data).map_err(|e| e.to_string())?;
        write_atomic_file(&file_path, &json)?;
    }

    Ok(())
}

fn inject_remembered_key_passphrases(config: &mut ConnectionConfig) -> Result<(), String> {
    fn inject_auth(auth_method: &mut crate::types::AuthMethod) {
        let crate::types::AuthMethod::PrivateKey {
            key_path,
            passphrase,
        } = auth_method
        else {
            return;
        };
        if passphrase.is_none() {
            match crate::ssh_key_passphrase_cache::load(key_path) {
                Ok(Some(remembered)) => {
                    *passphrase = Some(remembered.expose_secret().to_string());
                }
                Ok(None) => {}
                Err(error) => {
                    log::warn!(
                        "Remembered SSH key passphrase could not be read for configured key path: {error}"
                    );
                }
            }
        }
    }

    inject_auth(&mut config.auth_method);
    if let Some(forwarding) = config.agent_forwarding.as_mut() {
        inject_auth(&mut forwarding.auth_method);
    }
    if let Some(jump) = config.jump_host.as_mut() {
        inject_remembered_key_passphrases(jump)?;
    }
    Ok(())
}

/// Enumerate local adapters on demand without changing routes or starting a VPN.
#[tauri::command]
pub async fn ssh_network_interfaces() -> Result<Vec<crate::network_interfaces::NetworkInterface>, String> {
    tokio::task::spawn_blocking(crate::network_interfaces::list).await.map_err(|e| e.to_string())?
        .map(crate::network_interfaces::picker_snapshot)
        .map_err(|e| e.to_string())
}

/// Read host-specific, device-only routing preferences outside synced host records.
#[tauri::command]
pub async fn ssh_network_preference(app: AppHandle, connection_id: String) -> Result<crate::network_interfaces::Preference, String> {
    let data_dir = get_data_dir(&app);
    tokio::task::spawn_blocking(move || crate::network_interfaces::get_preference(&data_dir, &connection_id))
        .await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

/// Save only a validated routing preference using the existing atomic writer.
#[tauri::command]
pub async fn ssh_set_network_preference(app: AppHandle, connection_id: String, preference: crate::network_interfaces::Preference) -> Result<(), String> {
    let data_dir = get_data_dir(&app);
    tokio::task::spawn_blocking(move || crate::network_interfaces::set_preference(&data_dir, &connection_id, preference))
        .await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

async fn inject_remembered_key_passphrases_blocking(
    config: &mut ConnectionConfig,
) -> Result<(), String> {
    let mut moved = config.clone();
    let moved = tokio::task::spawn_blocking(move || {
        inject_remembered_key_passphrases(&mut moved)?;
        Ok::<ConnectionConfig, String>(moved)
    })
    .await
    .map_err(|error| format!("Remembered SSH key passphrase task failed: {error}"))??;
    *config = moved;
    Ok(())
}

#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    mut config: ConnectionConfig,
    state: State<'_, AppState>,
    vault: State<'_, tokio::sync::Mutex<crate::vault::store::VaultService>>,
) -> Result<ConnectionResponse, String> {
    let original_config = config.clone();
    let connection_id = original_config.id.clone();
    let attempt_id = original_config
        .connect_attempt_id
        .clone()
        .unwrap_or_else(|| {
            NEXT_CONNECT_TASK_ID
                .fetch_add(1, Ordering::Relaxed)
                .to_string()
        });
    let mut prepare_cancel_rx = {
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let mut connect_tasks = state.connect_tasks.lock().await;
        if let Some(previous) = connect_tasks.insert(
            connection_id.clone(),
            ConnectAttempt::Preparing {
                attempt_id: attempt_id.clone(),
                cancel: cancel_tx,
            },
        ) {
            if let ConnectAttempt::Connecting { abort_handle, .. } = previous {
                abort_handle.abort();
            }
        }
        cancel_rx
    };

    let uses_vault_auth = config_uses_vault_auth(&original_config);
    let prepare_result = tokio::select! {
        biased;
        _ = prepare_cancel_rx.wait_for(|cancelled| *cancelled) => {
            Err("Connection cancelled".to_string())
        }
        result = async {
            let relinked = resolve_vault_refs(&mut config, &vault).await?;
            inject_remembered_key_passphrases_blocking(&mut config).await?;
            if relinked.is_empty() {
                return Ok(());
            }
            let app_handle = app.clone();
            let persist_result = tokio::task::spawn_blocking(move || {
                persist_relinked_vault_refs(&app_handle, &relinked)
            })
            .await;
            match persist_result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    return Err(format!("Failed to persist relinked vault refs: {error}"))
                }
                Err(join_error) => {
                    return Err(format!(
                        "Failed to persist relinked vault refs: task join error: {join_error}"
                    ))
                }
            }
            Ok::<(), String>(())
        } => result,
    };

    if let Err(error) = prepare_result {
        let mut connect_tasks = state.connect_tasks.lock().await;
        match connect_tasks.get(&connection_id) {
            Some(ConnectAttempt::Preparing {
                attempt_id: active_attempt_id,
                cancel,
            }) if active_attempt_id == &attempt_id => {
                let cancelled = *cancel.borrow();
                connect_tasks.remove(&connection_id);
                if cancelled || error == "Connection cancelled" {
                    return Err("Connection cancelled".to_string());
                }
                return Err(error);
            }
            _ => {
                return Err("Connection superseded".to_string());
            }
        }
    }

    {
        let mut connect_tasks = state.connect_tasks.lock().await;
        match connect_tasks.get(&connection_id) {
            Some(ConnectAttempt::Preparing {
                attempt_id: active_attempt_id,
                cancel,
            }) if active_attempt_id == &attempt_id && *cancel.borrow() => {
                connect_tasks.remove(&connection_id);
                return Err("Connection cancelled".to_string());
            }
            Some(ConnectAttempt::Preparing {
                attempt_id: active_attempt_id,
                cancel,
            }) if active_attempt_id == &attempt_id && !*cancel.borrow() => {}
            _ => return Err("Connection superseded".to_string()),
        }
    }

    let task_config = config.clone();
    let ssh_manager = state.ssh_manager.clone();
    let tunnel_manager = state.tunnel_manager.clone();
    let connect_task = tokio::spawn(async move {
        reconnect_connection(&task_config, &ssh_manager, &tunnel_manager).await
    });
    let spawn_outcome = {
        let mut connect_tasks = state.connect_tasks.lock().await;
        match connect_tasks.get(&connection_id) {
            Some(ConnectAttempt::Preparing {
                attempt_id: active_attempt_id,
                cancel,
            }) if active_attempt_id == &attempt_id && *cancel.borrow() => {
                connect_tasks.remove(&connection_id);
                Err("Connection cancelled")
            }
            Some(ConnectAttempt::Preparing {
                attempt_id: active_attempt_id,
                cancel,
            }) if active_attempt_id == &attempt_id && !*cancel.borrow() => {
                connect_tasks.insert(
                    connection_id.clone(),
                    ConnectAttempt::Connecting {
                        attempt_id: attempt_id.clone(),
                        abort_handle: connect_task.abort_handle(),
                    },
                );
                Ok(())
            }
            _ => Err("Connection superseded"),
        }
    };
    if let Err(reason) = spawn_outcome {
        connect_task.abort();
        match connect_task.await {
            Ok(Ok(mut handle)) => {
                // Task finished before abort took effect — tear the session down explicitly.
                handle.sftp_session = None;
                if let Some(session) = handle.session.take() {
                    let guard = session.lock().await;
                    if let Err(error) = guard
                        .disconnect(russh::Disconnect::ByApplication, reason, "")
                        .await
                    {
                        eprintln!(
                            "[SSH] Failed to disconnect {} connection {}: {error}",
                            reason.to_lowercase(),
                            connection_id
                        );
                    }
                }
            }
            _ => {}
        }
        return Err(reason.to_string());
    }

    let connect_result = match connect_task.await {
        Ok(result) => result,
        Err(join_error) if join_error.is_cancelled() => Err("Connection cancelled".to_string()),
        Err(join_error) => Err(format!("Connection task failed: {join_error}")),
    };
    let still_owns_attempt = {
        let mut connect_tasks = state.connect_tasks.lock().await;
        let still_owns_attempt = matches!(
            connect_tasks.get(&connection_id),
            Some(ConnectAttempt::Connecting {
                attempt_id: active_attempt_id,
                ..
            }) if active_attempt_id == &attempt_id
        );
        if still_owns_attempt {
            connect_tasks.remove(&connection_id);
        }
        still_owns_attempt
    };

    match connect_result {
        Ok(mut handle) => {
            if !still_owns_attempt {
                // Cancel raced past a completed connect task: tear the session down
                // explicitly so we do not leave a live SSH handle to Drop cleanup alone.
                handle.sftp_session = None;
                if let Some(session) = handle.session.take() {
                    let guard = session.lock().await;
                    if let Err(error) = guard
                        .disconnect(russh::Disconnect::ByApplication, "Connection cancelled", "")
                        .await
                    {
                        eprintln!(
                            "[SSH] Failed to disconnect cancelled connection {}: {error}",
                            connection_id
                        );
                    }
                }
                return Err("Connection cancelled".to_string());
            }
            let detected_os = handle.detected_os.clone();
            // Do not keep decrypted vault secrets in the long-lived handle config.
            // The handle keeps the original VaultRef config so future reconnects
            // require the vault to be explicitly unlocked again.
            handle.config = original_config.clone();
            handle.uses_vault_auth = uses_vault_auth;
            let mut connections = state.connections.lock().await;
            handle.reconnect_generation = connections
                .get(&original_config.id)
                .map(|existing| existing.reconnect_generation.wrapping_add(1))
                .unwrap_or(0);
            connections.insert(original_config.id.clone(), handle);

            Ok(ConnectionResponse {
                success: true,
                message: "Connected".to_string(),
                term_id: Some(original_config.id.clone()),
                detected_os,
            })
        }
        Err(e) => {
            eprintln!("[SSH] Connection failed: {}", e);
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn ssh_cancel_connect(
    id: String,
    attempt_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let abort_handle = {
        let mut connect_tasks = state.connect_tasks.lock().await;
        match connect_tasks.get_mut(&id) {
            Some(ConnectAttempt::Preparing {
                attempt_id: active_attempt_id,
                cancel,
            }) if attempt_id
                .as_deref()
                .map(|attempt_id| attempt_id == active_attempt_id)
                .unwrap_or(true) =>
            {
                let _ = cancel.send(true);
                None
            }
            Some(ConnectAttempt::Connecting {
                attempt_id: active_attempt_id,
                ..
            }) if attempt_id
                .as_deref()
                .map(|attempt_id| attempt_id == active_attempt_id)
                .unwrap_or(true) =>
            {
                match connect_tasks.remove(&id) {
                    Some(ConnectAttempt::Connecting { abort_handle, .. }) => Some(abort_handle),
                    _ => None,
                }
            }
            _ => None,
        }
    };

    if let Some(abort_handle) = abort_handle {
        abort_handle.abort();
    }

    Ok(())
}

/// Resolve a vault credential natively, including its optional encrypted SSH certificate.
async fn resolve_auth_method(
    connection_id: &str,
    auth_method: &mut crate::types::AuthMethod,
    vault: &tokio::sync::Mutex<crate::vault::store::VaultService>,
    require_private_key: bool,
) -> Result<Vec<RelinkedVaultRefUpdate>, String> {
    let crate::types::AuthMethod::VaultRef {
        item_id,
        credential_id,
    } = auth_method
    else {
        return Ok(Vec::new());
    };
    let item_id = item_id.clone();
    let credential_id = credential_id.clone();
    let svc = vault.lock().await;
    let mut relinked = Vec::new();
    let record = match svc.item_get(&item_id) {
        Ok(record) => record,
        Err(item_error) => {
            let Some(credential_id) = credential_id.as_deref() else {
                return Err(item_error.to_string());
            };
            let record = svc
                .item_get_by_logical_id(credential_id)
                .map_err(|logical_error| {
                    format!(
                        "{item_error}; relink by credentialId '{credential_id}' failed: {logical_error}"
                    )
                })?;
            relinked.push(RelinkedVaultRefUpdate {
                connection_id: connection_id.to_string(),
                credential_id: credential_id.to_string(),
                item_id: record.id.clone(),
                vault_id: svc.vault_id(),
            });
            record
        }
    };
    drop(svc);
    *auth_method = match record.kind.as_str() {
        "ssh-password" if !require_private_key => crate::types::AuthMethod::Password {
            password: crate::vault::credential::primary_secret_value(&record)
                .ok_or_else(|| "Vault password credential has no password value".to_string())?
                .to_string(),
        },
        "ssh-private-key" => {
            let (key_data, passphrase) = crate::vault::credential::private_key_auth_values(&record)
                .ok_or_else(|| {
                    "Vault private-key credential has no private key value".to_string()
                })?;
            crate::types::AuthMethod::PrivateKeyData {
                key_data: key_data.to_string(),
                passphrase: passphrase.map(str::to_string),
                certificate: record
                    .secret_values
                    .get(crate::vault::credential::SSH_CERTIFICATE_FIELD)
                    .cloned(),
            }
        }
        kind if require_private_key => {
            return Err(format!(
                "Vault item kind '{kind}' cannot be used for SSH agent forwarding"
            ))
        }
        kind => {
            return Err(format!(
                "Vault item kind '{kind}' is not supported for SSH auth"
            ))
        }
    };
    Ok(relinked)
}

#[tauri::command]
pub async fn ssh_agent_signature_respond(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    request_id: String,
    decision: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("SSH agent consent is only accepted from the main window".to_string());
    }
    state
        .ssh_manager
        .respond_agent_signature(&request_id, &decision)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn ssh_test_connection(
    mut config: ConnectionConfig,
    state: State<'_, AppState>,
    vault: State<'_, tokio::sync::Mutex<crate::vault::store::VaultService>>,
) -> Result<String, String> {
    let _relinked = resolve_vault_refs(&mut config, &vault).await?;
    inject_remembered_key_passphrases_blocking(&mut config).await?;
    match state
        .ssh_manager
        .connect(config.clone(), Arc::new((*state.tunnel_manager).clone()))
        .await
    {
        Ok(session) => {
            // Try a simple command to verify session
            let result = match session.channel_open_session().await {
                Ok(mut channel) => {
                    if channel.exec(true, "echo success").await.is_ok() {
                        let mut success = false;
                        while let Some(msg) = channel.wait().await {
                            if let russh::ChannelMsg::ExitStatus { exit_status } = msg {
                                if exit_status == 0 {
                                    success = true;
                                }
                                break;
                            }
                        }
                        if success {
                            Ok("Authentication Successful!".to_string())
                        } else {
                            Ok("Connected but execution failed.".to_string())
                        }
                    } else {
                        Ok("Connected but failed to exec.".to_string())
                    }
                }
                Err(e) => Err(format!("Connected, but failed to open session: {}", e)),
            };
            result
        }
        Err(e) => Err(format!("Connection Failed: {}", e)),
    }
}

#[tauri::command]
pub async fn get_system_info(app: AppHandle) -> Result<SystemInfo, String> {
    let data_dir = get_data_dir(&app);

    // Use Tauri's path resolver to find assets correctly in both Dev and Prod
    let app_root = (|| {
        if cfg!(debug_assertions) {
            // In Dev, we climb up from the executable or search for a project marker
            if let Ok(exe) = std::env::current_exe() {
                let mut current = exe.parent();
                while let Some(path) = current {
                    if path.join("Cargo.toml").exists() {
                        return Some(path.to_path_buf());
                    }
                    current = path.parent();
                }
                return Some(exe.to_path_buf());
            }
            None
        } else {
            // In Prod, use the official resource directory
            app.path().resource_dir().ok()
        }
    })()
    .unwrap_or_else(|| std::path::PathBuf::from("."));

    Ok(SystemInfo {
        data_dir: data_dir.to_string_lossy().to_string(),
        app_root: app_root.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn save_secret(
    app: tauri::AppHandle,
    vault: State<'_, Mutex<crate::vault::store::VaultService>>,
    key: String,
    value: SecretString,
) -> Result<(), String> {
    let vault = vault.lock().await;
    if value.expose_secret().is_empty() {
        crate::ai::delete_api_key(&vault, &key).map_err(|error| error.to_string())?;
    } else {
        crate::ai::save_api_key(&vault, &key, value.expose_secret())
            .map_err(|error| error.to_string())?;
    }
    let store = app
        .store("secrets.json")
        .map_err(|error| error.to_string())?;
    store.delete(&key);
    store.save().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_secret(
    vault: State<'_, Mutex<crate::vault::store::VaultService>>,
    key: String,
) -> Result<Option<String>, String> {
    let vault = vault.lock().await;
    crate::ai::get_api_key(&vault, &key).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn delete_secret(
    app: tauri::AppHandle,
    vault: State<'_, Mutex<crate::vault::store::VaultService>>,
    key: String,
) -> Result<(), String> {
    let vault = vault.lock().await;
    crate::ai::delete_api_key(&vault, &key).map_err(|error| error.to_string())?;
    let store = app
        .store("secrets.json")
        .map_err(|error| error.to_string())?;
    store.delete(&key);
    store.save().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn ssh_extract_pem(app_handle: tauri::AppHandle, path: String) -> Result<String, String> {
    let data_dir = get_data_dir(&app_handle);
    let keys_dir = data_dir.join("keys");

    if !keys_dir.exists() {
        std::fs::create_dir_all(&keys_dir).map_err(|e| e.to_string())?;
    }

    let src_path = std::path::Path::new(&path);
    let filename = src_path
        .file_name()
        .ok_or("Invalid file path")?
        .to_string_lossy();

    // Create a unique filename based on the hash of the original path to avoid collisions
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    let hash = hasher.finish();
    let dest_filename = format!("{:x}_{}", hash, filename);
    let dest_path = keys_dir.join(dest_filename);

    if src_path == dest_path {
        return Ok(path);
    }

    std::fs::copy(src_path, &dest_path).map_err(|e| e.to_string())?;

    // On Unix, set permissions to 600 for SSH keys
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&dest_path)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(&dest_path, perms).map_err(|e| e.to_string())?;
    }

    Ok(dest_path.to_string_lossy().to_string())
}

fn looks_like_private_key_pem(content: &str) -> bool {
    content.contains("-----BEGIN ")
        && content.contains("PRIVATE KEY-----")
        && content.contains("-----END ")
}

fn set_private_key_file_permissions(path: &std::path::Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(path, perms).map_err(|e| e.to_string())?;
    }
    let _ = path;
    Ok(())
}

/// Write private-key PEM with restrictive permissions.
/// On Unix, `mode(0o600)` applies at create time; chmod afterward covers umask and existing files.
fn write_private_key_file(path: &std::path::Path, content: &str) -> Result<(), String> {
    use std::io::Write;

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    file.write_all(content.as_bytes())
        .map_err(|e| e.to_string())?;
    // Guarantee 0o600 even when umask softened create-time mode, or when truncating an older file.
    set_private_key_file_permissions(path)?;
    Ok(())
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteManagedKeyRequest {
    pub content: String,
    pub suggested_name: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectPrivateKeyRequest {
    pub path: Option<String>,
    pub content: Option<SecretString>,
    pub passphrase: Option<SecretString>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectPrivateKeyResponse {
    pub status: String,
    pub encrypted: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub remembered: bool,
}

fn private_key_uses_encrypted_pem_container(content: &str) -> bool {
    content.contains("-----BEGIN ENCRYPTED PRIVATE KEY-----")
        || content.contains("Proc-Type: 4,ENCRYPTED")
}

/// Classify supported private-key content without storing the supplied secret.
fn inspect_private_key_content(
    content: &str,
    passphrase: Option<&str>,
) -> InspectPrivateKeyResponse {
    let encrypted_container = private_key_uses_encrypted_pem_container(content);
    if encrypted_container {
        let Some(passphrase) = passphrase.filter(|value| !value.is_empty()) else {
            return InspectPrivateKeyResponse {
                status: "passphraseRequired".to_string(),
                encrypted: true,
                remembered: false,
            };
        };
        return match russh::keys::decode_secret_key(content, Some(passphrase)) {
            Ok(_) => InspectPrivateKeyResponse {
                status: "valid".to_string(),
                encrypted: true,
                remembered: false,
            },
            Err(_) => InspectPrivateKeyResponse {
                status: "invalidPassphrase".to_string(),
                encrypted: true,
                remembered: false,
            },
        };
    }

    match russh::keys::decode_secret_key(content, None) {
        Ok(_) => InspectPrivateKeyResponse {
            status: "valid".to_string(),
            encrypted: false,
            remembered: false,
        },
        Err(russh::keys::Error::KeyIsEncrypted) => {
            let Some(passphrase) = passphrase.filter(|value| !value.is_empty()) else {
                return InspectPrivateKeyResponse {
                    status: "passphraseRequired".to_string(),
                    encrypted: true,
                    remembered: false,
                };
            };
            match russh::keys::decode_secret_key(content, Some(passphrase)) {
                Ok(_) => InspectPrivateKeyResponse {
                    status: "valid".to_string(),
                    encrypted: true,
                    remembered: false,
                },
                Err(_) => InspectPrivateKeyResponse {
                    status: "invalidPassphrase".to_string(),
                    encrypted: true,
                    remembered: false,
                },
            }
        }
        Err(_) => InspectPrivateKeyResponse {
            status: "invalidKey".to_string(),
            encrypted: false,
            remembered: false,
        },
    }
}

/// Inspect a private key locally and verify its passphrase without persisting either value.
fn ssh_inspect_private_key_sync(
    request: InspectPrivateKeyRequest,
) -> Result<InspectPrivateKeyResponse, String> {
    let content = match (request.path.as_deref(), request.content) {
        (Some(path), None) if !path.trim().is_empty() => {
            let metadata = std::fs::metadata(path.trim()).map_err(|e| e.to_string())?;
            if metadata.len() > MAX_IMPORT_TEXT_BYTES as u64 {
                return Err("Private key file too large (max 1 MiB).".to_string());
            }
            SecretString::from(std::fs::read_to_string(path.trim()).map_err(|e| e.to_string())?)
        }
        (None, Some(content)) if !content.expose_secret().trim().is_empty() => {
            if content.expose_secret().len() > MAX_IMPORT_TEXT_BYTES {
                return Err("Private key content too large (max 1 MiB).".to_string());
            }
            content
        }
        _ => return Err("Provide exactly one private key path or key content.".to_string()),
    };

    if !looks_like_private_key_pem(content.expose_secret()) {
        return Ok(InspectPrivateKeyResponse {
            status: "invalidKey".to_string(),
            encrypted: false,
            remembered: false,
        });
    }

    Ok(inspect_private_key_content(
        content.expose_secret(),
        request.passphrase.as_ref().map(ExposeSecret::expose_secret),
    ))
}

#[tauri::command]
pub async fn ssh_inspect_private_key(
    request: InspectPrivateKeyRequest,
) -> Result<InspectPrivateKeyResponse, String> {
    tokio::task::spawn_blocking(move || ssh_inspect_private_key_sync(request))
        .await
        .map_err(|error| format!("Private key inspection task failed: {error}"))?
}

fn read_private_key_file(path: &str) -> Result<SecretString, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Key path is empty.".to_string());
    }
    let metadata = std::fs::metadata(trimmed).map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("Private key path is not a file.".to_string());
    }
    if metadata.len() > MAX_IMPORT_TEXT_BYTES as u64 {
        return Err("Private key file too large (max 1 MiB).".to_string());
    }
    std::fs::read_to_string(trimmed)
        .map(SecretString::from)
        .map_err(|e| e.to_string())
}

fn ssh_private_key_readiness_sync(path: String) -> Result<InspectPrivateKeyResponse, String> {
    let content = match read_private_key_file(&path) {
        Ok(content) => content,
        Err(error) => {
            log::warn!("Private key readiness could not read configured key path: {error}");
            return Ok(InspectPrivateKeyResponse {
                status: "unavailable".to_string(),
                encrypted: false,
                remembered: false,
            });
        }
    };
    let initial = inspect_private_key_content(content.expose_secret(), None);
    if initial.status != "passphraseRequired" {
        return Ok(initial);
    }

    let passphrase = match crate::ssh_key_passphrase_cache::load(&path) {
        Ok(Some(passphrase)) => passphrase,
        Ok(None) => return Ok(initial),
        Err(error) => {
            log::warn!(
                "Remembered SSH key passphrase could not be read during readiness check: {error}"
            );
            return Ok(initial);
        }
    };
    let mut remembered =
        inspect_private_key_content(content.expose_secret(), Some(passphrase.expose_secret()));
    if remembered.status == "valid" {
        remembered.remembered = true;
        return Ok(remembered);
    }

    if let Err(error) = crate::ssh_key_passphrase_cache::clear(&path) {
        log::warn!(
            "Remembered SSH key passphrase could not be cleared after failed readiness check: {error}"
        );
    }
    Ok(initial)
}

#[tauri::command]
pub async fn ssh_private_key_readiness(path: String) -> Result<InspectPrivateKeyResponse, String> {
    tokio::task::spawn_blocking(move || ssh_private_key_readiness_sync(path))
        .await
        .map_err(|error| format!("Private key readiness task failed: {error}"))?
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RememberKeyPassphraseRequest {
    pub path: String,
    pub passphrase: SecretString,
}

fn ssh_remember_key_passphrase_sync(request: RememberKeyPassphraseRequest) -> Result<(), String> {
    let content = read_private_key_file(&request.path)?;
    let inspection = inspect_private_key_content(
        content.expose_secret(),
        Some(request.passphrase.expose_secret()),
    );
    if inspection.status != "valid" || !inspection.encrypted {
        return Err("Passphrase does not unlock this encrypted private key.".to_string());
    }
    crate::ssh_key_passphrase_cache::save(&request.path, &request.passphrase)
}

#[tauri::command]
pub async fn ssh_remember_key_passphrase(
    request: RememberKeyPassphraseRequest,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || ssh_remember_key_passphrase_sync(request))
        .await
        .map_err(|error| format!("Remember SSH key passphrase task failed: {error}"))?
}

#[tauri::command]
pub async fn ssh_forget_key_passphrase(path: String) -> Result<(), String> {
    crate::ssh_key_passphrase_cache::clear(&path)
}

#[cfg(test)]
mod private_key_inspection_tests {
    use super::inspect_private_key_content;

    #[test]
    fn accepts_unencrypted_private_keys_without_a_passphrase() {
        let key = russh::keys::PrivateKey::random(
            &mut russh::keys::key::safe_rng(),
            russh::keys::Algorithm::Ed25519,
        )
        .expect("generate fixture key");
        let mut pem = Vec::new();
        russh::keys::encode_pkcs8_pem(&key, &mut pem).expect("encode private key");
        let pem = String::from_utf8(pem).expect("PEM is UTF-8");

        let result = inspect_private_key_content(&pem, None);

        assert_eq!(result.status, "valid");
        assert!(!result.encrypted);
    }

    #[test]
    fn requires_and_verifies_encrypted_key_passphrases() {
        let key = russh::keys::PrivateKey::random(
            &mut russh::keys::key::safe_rng(),
            russh::keys::Algorithm::Ed25519,
        )
        .expect("generate fixture key");
        let mut pem = Vec::new();
        russh::keys::encode_pkcs8_pem_encrypted(&key, b"correct horse", 2, &mut pem)
            .expect("encode encrypted private key");
        let pem = String::from_utf8(pem).expect("PEM is UTF-8");

        let missing = inspect_private_key_content(&pem, None);
        let invalid = inspect_private_key_content(&pem, Some("wrong passphrase"));
        let valid = inspect_private_key_content(&pem, Some("correct horse"));

        assert_eq!(missing.status, "passphraseRequired");
        assert_eq!(invalid.status, "invalidPassphrase");
        assert_eq!(valid.status, "valid");
        assert!(missing.encrypted && invalid.encrypted && valid.encrypted);
    }

    #[test]
    fn rejects_non_key_content() {
        let result = inspect_private_key_content("not a private key", None);

        assert_eq!(result.status, "invalidKey");
        assert!(!result.encrypted);
    }
}

/// Write pasted private-key PEM into the managed `{dataDir}/keys` folder and return the path.
/// Used for non-vault "Paste" key auth — host stores only `privateKeyPath`.
#[tauri::command]
pub async fn ssh_write_managed_key(
    app_handle: tauri::AppHandle,
    request: WriteManagedKeyRequest,
) -> Result<String, String> {
    let trimmed = request.content.trim();
    if trimmed.is_empty() {
        return Err("Private key content is empty.".to_string());
    }
    if !looks_like_private_key_pem(trimmed) {
        return Err("Pasted key must include valid BEGIN/END private key markers.".to_string());
    }

    let data_dir = get_data_dir(&app_handle);
    let keys_dir = data_dir.join("keys");
    if !keys_dir.exists() {
        std::fs::create_dir_all(&keys_dir).map_err(|e| e.to_string())?;
    }

    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    trimmed.hash(&mut hasher);
    let hash = hasher.finish();

    let raw_name = request
        .suggested_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("pasted_key");
    let safe_name: String = raw_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let safe_name = if safe_name.is_empty() {
        "pasted_key".to_string()
    } else {
        safe_name
    };
    let dest_filename =
        if safe_name.to_ascii_lowercase().ends_with(".pem") || safe_name.starts_with("id_") {
            format!("{:x}_{}", hash, safe_name)
        } else {
            format!("{:x}_{}.pem", hash, safe_name)
        };
    let dest_path = keys_dir.join(dest_filename);

    write_private_key_file(&dest_path, &format!("{trimmed}\n"))?;
    Ok(dest_path.to_string_lossy().to_string())
}

/// Read a local private key file for vault import (returns PEM text).
#[tauri::command]
pub async fn ssh_read_local_key_file(path: String) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Key path is empty.".to_string());
    }
    let metadata = std::fs::metadata(trimmed).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_IMPORT_TEXT_BYTES as u64 {
        return Err("Private key file too large (max 1 MiB).".to_string());
    }
    let content = std::fs::read_to_string(trimmed).map_err(|e| e.to_string())?;
    if !looks_like_private_key_pem(&content) {
        return Err("Selected file does not look like a private key.".to_string());
    }
    Ok(content)
}

fn ephemeral_keys_dir(app_handle: &tauri::AppHandle) -> std::path::PathBuf {
    get_data_dir(app_handle).join("tmp-keys")
}

/// Remove leftover Test-only key files under `{dataDir}/tmp-keys` (e.g. after a crash).
/// Missing directory is fine; individual delete failures are logged and skipped.
pub fn cleanup_stale_ephemeral_key_files(app: &tauri::AppHandle) {
    let dir = ephemeral_keys_dir(app);
    if !dir.exists() {
        return;
    }
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) => {
            eprintln!(
                "[ssh] Failed to scan ephemeral key dir {}: {}",
                dir.display(),
                error
            );
            return;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if let Err(error) = std::fs::remove_file(&path) {
            eprintln!(
                "[ssh] Failed to remove stale ephemeral key {}: {}",
                path.display(),
                error
            );
        }
    }
}

/// Write a short-lived key file for connection Test only (not durable host auth).
/// Caller should delete via `ssh_delete_ephemeral_key` after the test.
#[tauri::command]
pub async fn ssh_write_ephemeral_key(
    app_handle: tauri::AppHandle,
    content: String,
) -> Result<String, String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err("Private key content is empty.".to_string());
    }
    if !looks_like_private_key_pem(trimmed) {
        return Err("Pasted key must include valid BEGIN/END private key markers.".to_string());
    }

    let dir = ephemeral_keys_dir(&app_handle);
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }

    let dest_path = dir.join(format!(
        "test-{}-{}.pem",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        uuid::Uuid::new_v4().simple()
    ));
    write_private_key_file(&dest_path, &format!("{trimmed}\n"))?;
    Ok(dest_path.to_string_lossy().to_string())
}

/// Delete an ephemeral test key. Refuses paths outside `{dataDir}/tmp-keys`.
#[tauri::command]
pub async fn ssh_delete_ephemeral_key(
    app_handle: tauri::AppHandle,
    path: String,
) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let target = std::path::PathBuf::from(trimmed);
    let dir = ephemeral_keys_dir(&app_handle);
    let dir_canon = match dir.canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Failed to resolve ephemeral key directory ({}): {error}",
                dir.display()
            ));
        }
    };
    let target_canon = target.canonicalize().unwrap_or(target.clone());
    if !target_canon.starts_with(&dir_canon) {
        return Err("Refusing to delete a path outside the ephemeral key directory.".to_string());
    }
    if target_canon.is_file() {
        let _ = std::fs::remove_file(&target_canon);
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_migrate_all_keys(app_handle: tauri::AppHandle) -> Result<usize, String> {
    let data_dir = get_data_dir(&app_handle);
    let connections_path = data_dir.join("connections.json");

    if !connections_path.exists() {
        return Ok(0);
    }

    let _connections_guard = CONNECTIONS_MUTATION_LOCK
        .lock()
        .map_err(|e| e.to_string())?;
    let data = std::fs::read_to_string(&connections_path).map_err(|e| e.to_string())?;
    let mut saved_data: crate::types::SavedData =
        serde_json::from_str(&data).map_err(|e| e.to_string())?;
    let mut migrated_count = 0;
    let mut changed = false;

    let keys_dir = data_dir.join("keys");
    if !keys_dir.exists() {
        std::fs::create_dir_all(&keys_dir).map_err(|e| e.to_string())?;
    }

    for conn in &mut saved_data.connections {
        if let Some(path) = &conn.private_key_path {
            if path.is_empty() {
                continue;
            }

            let src_path = std::path::Path::new(path);

            // Canonicalize paths to ensure robust comparison (handles symlinks, etc.)
            let data_dir_canonical = data_dir.canonicalize().unwrap_or_else(|_| data_dir.clone());
            // Note: If src_path doesn't exist, canonicalize might fail or behave oddly.
            // If it doesn't exist, we can't migrate it anyway.
            let src_path_canonical = src_path
                .canonicalize()
                .unwrap_or_else(|_| src_path.to_path_buf());

            // If the path is already inside the app data directory, skip it
            if src_path_canonical.starts_with(&data_dir_canonical) {
                continue;
            } else {
                #[cfg(debug_assertions)]
                println!("[SSH Migration] Path {:?} (canonical: {:?}) does not start with data_dir {:?} (canonical: {:?}). Triggering migration check.", src_path, src_path_canonical, data_dir, data_dir_canonical);
            }

            if src_path.exists() && src_path.is_file() {
                let filename = src_path.file_name().unwrap_or_default().to_string_lossy();

                use std::collections::hash_map::DefaultHasher;
                use std::hash::{Hash, Hasher};
                let mut hasher = DefaultHasher::new();
                path.hash(&mut hasher);
                let hash = hasher.finish();
                let dest_filename = format!("{:x}_{}", hash, filename);
                let dest_path = keys_dir.join(dest_filename);

                if src_path == dest_path {
                    continue;
                }

                if dest_path.exists() {
                    // Update the path even if we don't copy (in case it was partially migrated or already there)
                    conn.private_key_path = Some(dest_path.to_string_lossy().to_string());
                    changed = true;
                    #[cfg(debug_assertions)]
                    println!("[SSH Migration] Key already exists at dest, updating config path only: {:?}", dest_path);
                    continue;
                }

                match std::fs::copy(src_path, &dest_path) {
                    Ok(_) => {
                        #[cfg(unix)]
                        {
                            use std::os::unix::fs::PermissionsExt;
                            if let Ok(metadata) = std::fs::metadata(&dest_path) {
                                let mut perms = metadata.permissions();
                                perms.set_mode(0o600);
                                let _ = std::fs::set_permissions(&dest_path, perms);
                            }
                        }
                        conn.private_key_path = Some(dest_path.to_string_lossy().to_string());
                        migrated_count += 1;
                        changed = true;
                        println!(
                            "[SSH Migration] Migrated key for {} to {:?}",
                            conn.name, dest_path
                        );
                    }
                    Err(e) => {
                        eprintln!(
                            "[SSH Migration] Failed to copy key for {} from {:?}: {}",
                            conn.name, src_path, e
                        );
                    }
                }
            }
        }
    }

    if changed {
        let json = serde_json::to_string_pretty(&saved_data).map_err(|e| e.to_string())?;

        // Use OpenOptions to truncate and write, then sync_all to ensure durability
        use std::fs::OpenOptions;
        use std::io::Write;

        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&connections_path)
            .map_err(|e| e.to_string())?;

        file.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;

        #[cfg(debug_assertions)]
        println!(
            "[SSH Migration] Successfully saved and synced updated connections.json to {:?}",
            connections_path
        );
    }

    Ok(migrated_count)
}

/// Drop a dead SSH session after unexpected transport loss.
/// Unlike `ssh_disconnect`, does not tear down terminal tabs — PTYs are already EOF or frontend-suspended.
#[tauri::command]
pub async fn ssh_transport_lost(
    app: AppHandle,
    id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if let Err(error) =
        crate::tunnels::stop_tunnels_for_connections(&app, &state, &[id.clone()]).await
    {
        eprintln!("[TUNNEL] stop on transport lost for {id}: {error}");
    }

    let mut connections = state.connections.lock().await;
    connections.remove(&id);
    Ok(())
}

#[tauri::command]
pub async fn ssh_disconnect(
    app: AppHandle,
    id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .pty_manager
        .close_by_connection(&id)
        .await
        .map_err(|e| e.to_string())?;

    if let Err(error) =
        crate::tunnels::stop_tunnels_for_connections(&app, &state, &[id.clone()]).await
    {
        eprintln!("[TUNNEL] stop on disconnect for {id}: {error}");
    }

    let mut connections = state.connections.lock().await;
    connections.remove(&id);

    Ok(())
}

#[tauri::command]
pub async fn ssh_disconnect_vault_backed(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let ids = {
        let connections = state.connections.lock().await;
        connections
            .iter()
            .filter_map(|(id, handle)| handle.uses_vault_auth.then(|| id.clone()))
            .collect::<Vec<_>>()
    };

    let mut errors = Vec::new();
    for id in &ids {
        if let Err(error) = state.pty_manager.close_by_connection(id).await {
            errors.push(format!("PTY close failed for {id}: {error}"));
        }
    }

    if let Err(error) = crate::tunnels::stop_tunnels_for_connections(&app, &state, &ids).await {
        errors.push(format!("Tunnel stop failed: {error}"));
    }

    if errors.is_empty() {
        let mut connections = state.connections.lock().await;
        for id in &ids {
            connections.remove(id);
        }
        Ok(ids)
    } else {
        Err(errors.join("; "))
    }
}

/// Return cumulative output credit only for the matching native channel owner.
#[tauri::command]
pub async fn terminal_ack_output(
    term_id: String,
    generation: u32,
    channel_id: u32,
    sequence: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .pty_manager
        .acknowledge_output(&term_id, generation, channel_id, sequence)
        .await
        .map_err(|error| error.to_string())
}

/// A parser/transport fault must not silently drop bytes or leave a live shell
/// without a reader. Reuse existing tab cleanup after closing only this owner.
#[tauri::command]
pub async fn terminal_output_failed(
    app: AppHandle,
    term_id: String,
    generation: u32,
    channel_id: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if state
        .pty_manager
        .fail_output(&term_id, generation, channel_id)
        .await
        .map_err(|error| error.to_string())?
    {
        let _ = app.emit(
            &format!("terminal-exit-{}", term_id),
            serde_json::json!({ "generation": generation, "channel_id": channel_id }),
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn terminal_write(
    term_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .pty_manager
        .write(&term_id, &data)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn terminal_resize(
    term_id: String,
    rows: u16,
    cols: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .pty_manager
        .resize(&term_id, cols, rows)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn terminal_navigate(
    term_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .pty_manager
        .navigate_to_path(&term_id, &path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn connections_get(
    app: AppHandle,
    vault: State<'_, tokio::sync::Mutex<crate::vault::store::VaultService>>,
) -> Result<SavedData, String> {
    let data_dir = get_data_dir(&app);
    {
        let guard = vault.lock().await;
        if guard.vault_id().is_some() {
            crate::vault::commands::repair_connection_refs(&data_dir, &guard)
                .map_err(|e| e.to_string())?;
        }
    }
    let file_path = data_dir.join("connections.json");

    if !file_path.exists() {
        return Ok(SavedData {
            connections: vec![],
            folders: vec![],
        });
    }

    let data = std::fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    let saved_data: SavedData = serde_json::from_str(&data).map_err(|e| e.to_string())?;

    Ok(saved_data)
}

#[tauri::command]
pub async fn connections_save(
    app: AppHandle,
    connections: Vec<SavedConnection>,
    folders: Vec<Folder>,
) -> Result<(), String> {
    let data = SavedData {
        connections,
        folders,
    };

    let data_dir = get_data_dir(&app);
    if !data_dir.exists() {
        std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    }

    let file_path = data_dir.join("connections.json");
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;

    let _connections_guard = CONNECTIONS_MUTATION_LOCK
        .lock()
        .map_err(|e| e.to_string())?;
    write_atomic_file(&file_path, &json)?;

    Ok(())
}

fn csv_escape(value: &str) -> String {
    if value.contains(',') || value.contains('"') || value.contains('\n') || value.contains('\r') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn csv_bool(value: Option<bool>) -> String {
    match value {
        Some(true) => "true".to_string(),
        Some(false) => "false".to_string(),
        None => "".to_string(),
    }
}

fn csv_join(values: &Option<Vec<String>>) -> String {
    values
        .as_ref()
        .map(|items| items.join(";"))
        .unwrap_or_default()
}

/// Encode the same field order as the CSV export header, including optional certificate paths.
fn connection_to_csv_line(connection: &SavedConnection) -> String {
    let fields = vec![
        csv_escape(&connection.id),
        csv_escape(&connection.name),
        csv_escape(&connection.host),
        connection.port.to_string(),
        csv_escape(&connection.username),
        csv_escape(&connection.password.clone().unwrap_or_default()),
        csv_escape(&connection.private_key_path.clone().unwrap_or_default()),
        csv_escape(&connection.certificate_path.clone().unwrap_or_default()),
        csv_escape(&connection.jump_server_id.clone().unwrap_or_default()),
        csv_escape(&connection.folder.clone().unwrap_or_default()),
        csv_escape(&connection.theme.clone().unwrap_or_default()),
        csv_escape(&csv_join(&connection.tags)),
        csv_escape(&csv_bool(connection.is_favorite)),
        csv_escape(&csv_join(&connection.pinned_features)),
        connection
            .created_at
            .map(|value| value.to_string())
            .unwrap_or_default(),
        connection
            .last_connected
            .map(|value| value.to_string())
            .unwrap_or_default(),
    ];
    fields.join(",")
}

fn normalize_folder_path(value: &str) -> String {
    value
        .split('/')
        .map(|segment| segment.trim())
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

fn build_host_alias(connection: &SavedConnection) -> String {
    let mut alias = connection
        .name
        .trim()
        .replace(char::is_whitespace, "-")
        .replace(
            |ch: char| !ch.is_ascii_alphanumeric() && ch != '-' && ch != '_' && ch != '.',
            "-",
        )
        .trim_matches('-')
        .to_string();

    if alias.is_empty() {
        alias = connection
            .host
            .trim()
            .replace(char::is_whitespace, "-")
            .replace(
                |ch: char| !ch.is_ascii_alphanumeric() && ch != '-' && ch != '_' && ch != '.',
                "-",
            )
            .trim_matches('-')
            .to_string();
    }

    if alias.is_empty() {
        alias = connection.id.clone();
    }

    alias
}

fn filter_export_folders(
    all_folders: &[Folder],
    selected_connections: &[SavedConnection],
) -> Vec<Folder> {
    let mut required = std::collections::HashSet::new();

    for connection in selected_connections {
        let normalized = connection
            .folder
            .as_deref()
            .map(normalize_folder_path)
            .unwrap_or_default();
        if normalized.is_empty() {
            continue;
        }
        let mut current = String::new();
        for segment in normalized.split('/') {
            if current.is_empty() {
                current = segment.to_string();
            } else {
                current.push('/');
                current.push_str(segment);
            }
            required.insert(current.clone());
        }
    }

    all_folders
        .iter()
        .filter_map(|folder| {
            let normalized = normalize_folder_path(&folder.name);
            if normalized.is_empty() || !required.contains(&normalized) {
                return None;
            }
            let mut next = folder.clone();
            next.name = normalized;
            Some(next)
        })
        .collect()
}

fn split_csv_row(row: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = row.chars().peekable();

    while let Some(ch) = chars.next() {
        if in_quotes {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    current.push('"');
                    let _ = chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                current.push(ch);
            }
        } else if ch == '"' {
            in_quotes = true;
        } else if ch == ',' {
            fields.push(current.trim().to_string());
            current.clear();
        } else {
            current.push(ch);
        }
    }

    fields.push(current.trim().to_string());
    fields
}

fn parse_bool_field(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "y" => Some(true),
        "false" | "0" | "no" | "n" => Some(false),
        _ => None,
    }
}

/// Import optional connection fields by header name, preserving older CSV files.
fn parse_csv_connections(content: &str) -> Result<Vec<SavedConnection>, String> {
    let mut lines = content.lines().filter(|line| !line.trim().is_empty());
    let Some(header_line) = lines.next() else {
        return Ok(vec![]);
    };
    let headers = split_csv_row(header_line)
        .into_iter()
        .map(|header| header.trim().to_ascii_lowercase())
        .collect::<Vec<_>>();

    let index_of = |name: &str| headers.iter().position(|header| header == name);
    let id_idx = index_of("id");
    let name_idx = index_of("name")
        .or_else(|| index_of("connection_name"))
        .ok_or_else(|| "CSV missing required 'name' column.".to_string())?;
    let host_idx = index_of("host")
        .or_else(|| index_of("hostname"))
        .ok_or_else(|| "CSV missing required 'host' column.".to_string())?;
    let username_idx = index_of("username")
        .or_else(|| index_of("user"))
        .ok_or_else(|| "CSV missing required 'username' column.".to_string())?;
    let port_idx = index_of("port");
    let password_idx = index_of("password");
    let key_idx = index_of("privatekeypath").or_else(|| index_of("private_key_path"));
    let certificate_idx = index_of("certificatepath").or_else(|| index_of("certificate_path"));
    let jump_idx = index_of("jumpserverid").or_else(|| index_of("jump_server_id"));
    let folder_idx = index_of("folder");
    let theme_idx = index_of("theme");
    let tags_idx = index_of("tags");
    let favorite_idx = index_of("isfavorite").or_else(|| index_of("is_favorite"));
    let pinned_idx = index_of("pinnedfeatures").or_else(|| index_of("pinned_features"));
    let created_idx = index_of("createdat").or_else(|| index_of("created_at"));
    let last_connected_idx = index_of("lastconnected").or_else(|| index_of("last_connected"));

    let mut parsed = Vec::new();
    for line in lines {
        let fields = split_csv_row(line);
        let field = |idx: Option<usize>| -> String {
            idx.and_then(|i| fields.get(i).cloned()).unwrap_or_default()
        };

        let host = field(Some(host_idx)).trim().to_string();
        let username = field(Some(username_idx)).trim().to_string();
        if host.is_empty() || username.is_empty() {
            continue;
        }

        let id = field(id_idx).trim().to_string();
        let name = field(Some(name_idx)).trim().to_string();
        let port = field(port_idx).parse::<u16>().unwrap_or(22);
        let tags = field(tags_idx)
            .split(';')
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string())
            .collect::<Vec<_>>();
        let pinned_features = field(pinned_idx)
            .split(';')
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string())
            .collect::<Vec<_>>();

        parsed.push(SavedConnection {
            id: if id.is_empty() {
                uuid::Uuid::new_v4().to_string()
            } else {
                id
            },
            name: if name.is_empty() { host.clone() } else { name },
            host,
            port,
            username,
            password: {
                let value = field(password_idx);
                if value.is_empty() {
                    None
                } else {
                    Some(value)
                }
            },
            private_key_path: {
                let value = field(key_idx);
                if value.is_empty() {
                    None
                } else {
                    Some(value)
                }
            },
            certificate_path: {
                let value = field(certificate_idx);
                if value.is_empty() { None } else { Some(value) }
            },
            jump_server_id: {
                let value = field(jump_idx);
                if value.is_empty() {
                    None
                } else {
                    Some(value)
                }
            },
            last_connected: field(last_connected_idx).parse::<u64>().ok(),
            icon: None,
            folder: {
                let value = field(folder_idx);
                if value.is_empty() {
                    None
                } else {
                    Some(value)
                }
            },
            theme: {
                let value = field(theme_idx);
                if value.is_empty() {
                    None
                } else {
                    Some(value)
                }
            },
            tags: if tags.is_empty() { None } else { Some(tags) },
            created_at: field(created_idx).parse::<u64>().ok(),
            is_favorite: parse_bool_field(&field(favorite_idx)),
            pinned_features: if pinned_features.is_empty() {
                None
            } else {
                Some(pinned_features)
            },
            auth_ref: None,
            agent_forwarding_key_connection_id: None,
        });
    }

    Ok(parsed)
}

/// Export explicit identities and user certificates without changing server trust configuration.
fn build_ssh_config_export(connections: &[SavedConnection]) -> Result<String, String> {
    if connections.iter()
        .flat_map(|connection| [connection.private_key_path.as_deref(), connection.certificate_path.as_deref()])
        .flatten()
        .any(|path| path.chars().any(char::is_control)) {
        return Err("Cannot export private-key or certificate paths containing control characters.".into());
    }
    let alias_by_id = connections
        .iter()
        .map(|connection| (connection.id.clone(), build_host_alias(connection)))
        .collect::<HashMap<_, _>>();

    let mut output = String::new();
    for connection in connections {
        let alias = alias_by_id
            .get(&connection.id)
            .cloned()
            .unwrap_or_else(|| build_host_alias(connection));

        output.push_str(&format!("Host {}\n", alias));
        output.push_str(&format!("  HostName {}\n", connection.host));
        output.push_str(&format!("  User {}\n", connection.username));
        output.push_str(&format!("  Port {}\n", connection.port));
        if let Some(key_path) = &connection.private_key_path {
            if !key_path.trim().is_empty() {
                output.push_str(&format!("  IdentityFile {}\n", quote_ssh_config_path(key_path)));
            }
        }
        if let Some(jump_id) = &connection.jump_server_id {
            if let Some(jump_alias) = alias_by_id.get(jump_id) {
                output.push_str(&format!("  ProxyJump {}\n", jump_alias));
            }
        }
        if let Some(path) = &connection.certificate_path {
            output.push_str(&format!("  CertificateFile {}\n", quote_ssh_config_path(path)));
        }
        output.push('\n');
    }
    Ok(output)
}

/// Quote one SSH-config path; backslashes must be escaped before double quotes.
fn quote_ssh_config_path(path: &str) -> String {
    format!("\"{}\"", path.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(test)]
mod certificate_exchange_tests {
    use super::*;

    #[tokio::test]
    async fn ssh_certificate_vault_resolution_keeps_attachment_backend_only() {
        use russh::keys::{key::safe_rng, ssh_key::certificate::Builder, Algorithm, PrivateKey};
        let directory = tempfile::tempdir().unwrap();
        let mut service = crate::vault::store::VaultService::new(directory.path().to_path_buf());
        service.initialize("correct horse battery staple", false).unwrap();
        let key = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519).unwrap();
        let ca = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519).unwrap();
        let mut builder = Builder::new(vec![8; 32], key.public_key().key_data().clone(), 100, 200).unwrap();
        builder.valid_principal("fixture").unwrap();
        let certificate = builder.sign(&ca).unwrap().to_openssh().unwrap();
        let mut encoded = Vec::new();
        russh::keys::encode_pkcs8_pem(&key, &mut encoded).unwrap();
        let values = std::collections::BTreeMap::from([
            ("privateKey".into(), String::from_utf8(encoded).unwrap()),
            ("sshCertificate".into(), certificate.clone()),
        ]);
        let record = service.item_create_with_secret_values("fixture", "ssh-private-key", &values, None, None).unwrap();
        let mut auth = crate::types::AuthMethod::VaultRef { item_id: "stale-item".into(), credential_id: record.logical_id.clone() };
        let vault = tokio::sync::Mutex::new(service);
        let relinked = resolve_auth_method("fixture-host", &mut auth, &vault, false).await.unwrap();
        assert_eq!(relinked.len(), 1);
        match &auth {
            crate::types::AuthMethod::PrivateKeyData { key_data, certificate: Some(actual), .. } => {
                assert_eq!(actual, &certificate);
                assert_eq!(key_data, &values["privateKey"]);
            }
            _ => panic!("expected native key plus certificate"),
        }
        assert!(!serde_json::to_string(&auth).unwrap_or_default().contains(&certificate));
        assert!(serde_json::from_str::<crate::types::AuthMethod>(r#"{"type":"PrivateKeyData","key_data":"untrusted","passphrase":null,"certificate":"untrusted"}"#).is_err());
    }

    #[test]
    fn openssh_path_exports_escape_and_validate_both_path_fields() {
        let mut connection = parse_csv_connections("id,name,host,port,username\nfixture,Fixture,fixture.invalid,22,user\n")
            .unwrap().remove(0);
        for path in [r"C:\Users\Fixture Name\cert.pub", r"\\server\share\cert.pub", "/tmp/a \"quoted\" #name.pub", r"C:\"] {
            connection.private_key_path = Some(path.into());
            connection.certificate_path = Some(path.into());
            let exported = build_ssh_config_export(&[connection.clone()]).unwrap();
            let parsed = crate::ssh_config::parse_config_text(&exported).unwrap();
            assert_eq!(parsed[0].private_key_path.as_deref(), Some(path));
            assert_eq!(parsed[0].certificate_path.as_deref(), Some(path));
        }
        for path in ["bad\nHost injected", "bad\rpath", "bad\tpath", "bad\0path"] {
            connection.private_key_path = Some(path.into());
            connection.certificate_path = None;
            assert!(build_ssh_config_export(&[connection.clone()]).unwrap_err().contains("control characters"));
            connection.private_key_path = None;
            connection.certificate_path = Some(path.into());
            assert!(build_ssh_config_export(&[connection.clone()]).unwrap_err().contains("control characters"));
        }
    }

    #[test]
    fn csv_and_openssh_exports_preserve_the_certificate_pair() {
        let raw = "id,name,host,port,username,privateKeyPath,certificatePath\nfixture,Fixture,fixture.invalid,22,user,/keys/user,/keys/user-cert.pub\n";
        let connections = parse_csv_connections(raw).unwrap();
        let connection = &connections[0];
        let header = "id,name,host,port,username,password,privateKeyPath,certificatePath,jumpServerId,folder,theme,tags,isFavorite,pinnedFeatures,createdAt,lastConnected";
        let round_trip = parse_csv_connections(&format!("{header}\n{}\n", connection_to_csv_line(connection))).unwrap();
        assert_eq!(round_trip[0].certificate_path, connection.certificate_path);
        let parsed = crate::ssh_config::parse_config_text(&build_ssh_config_export(&connections).unwrap()).unwrap();
        assert_eq!(parsed[0].certificate_path, connection.certificate_path);
        assert_eq!(parsed[0].private_key_path, connection.private_key_path);
        let json = serde_json::to_string(connection).unwrap();
        assert_eq!(serde_json::from_str::<SavedConnection>(&json).unwrap().certificate_path, connection.certificate_path);
    }
}

#[tauri::command]
/// Export selected hosts using the existing explicit secret-inclusion policy.
pub async fn connections_export_to_file(
    app: AppHandle,
    request: ConnectionExportRequest,
    vault: State<'_, tokio::sync::Mutex<crate::vault::store::VaultService>>,
) -> Result<String, String> {
    let path = request.path.trim();
    if path.is_empty() {
        return Err("Export path is required.".to_string());
    }

    let tunnels_path = get_data_dir(&app).join("tunnels.json");
    let data = connections_get(app, vault).await?;
    let SavedData {
        connections: all_connections,
        folders: all_folders,
    } = data;
    let include_secrets = request.include_secrets.unwrap_or(false);
    let is_scoped_export = request.connection_ids.is_some();
    let mut selected_connections = if let Some(ids) = request.connection_ids {
        let id_set = ids.into_iter().collect::<std::collections::HashSet<_>>();
        all_connections
            .into_iter()
            .filter(|connection| id_set.contains(&connection.id))
            .collect::<Vec<_>>()
    } else {
        all_connections
    };
    if !include_secrets {
        selected_connections.iter_mut().for_each(|connection| {
            connection.password = None;
            connection.private_key_path = None;
            connection.certificate_path = None;
        });
    }

    let format = request.format.trim().to_ascii_lowercase();
    let content = match format.as_str() {
        "zync" => {
            let folders = if is_scoped_export {
                filter_export_folders(&all_folders, &selected_connections)
            } else {
                all_folders
            };
            let all_tunnels = match std::fs::read_to_string(&tunnels_path) {
                Ok(raw) => serde_json::from_str::<SavedTunnelsData>(&raw)
                    .map(|data| data.tunnels)
                    .map_err(|error| format!("Failed to parse tunnels.json: {error}"))?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
                Err(error) => {
                    return Err(format!("Failed to read tunnels.json: {error}"));
                }
            };
            // Full export keeps every tunnel (including orphans). Scoped export keeps only
            // tunnels whose host is in the selected connection set.
            let scoped_tunnels = if is_scoped_export {
                let selected_connection_ids: std::collections::HashSet<&str> = selected_connections
                    .iter()
                    .map(|connection| connection.id.as_str())
                    .collect();
                all_tunnels
                    .into_iter()
                    .filter(|tunnel| {
                        selected_connection_ids.contains(tunnel.connection_id.as_str())
                    })
                    .collect::<Vec<_>>()
            } else {
                all_tunnels
            };
            let tunnels = scoped_tunnels
                .into_iter()
                .map(|mut tunnel| {
                    // Export configs only — never mark tunnels as active on the other device.
                    tunnel.status = Some("stopped".to_string());
                    tunnel
                })
                .collect::<Vec<_>>();
            serde_json::to_string_pretty(&ZyncConnectionsExport {
                format: "zync-connections".to_string(),
                version: 1,
                exported_at_ms: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|duration| duration.as_millis() as u64)
                    .unwrap_or(0),
                connections: selected_connections,
                folders,
                tunnels,
            })
            .map_err(|error| error.to_string())?
        }
        "json" => serde_json::to_string_pretty(&selected_connections)
            .map_err(|error| error.to_string())?,
        "csv" => {
            let mut lines = vec![
                "id,name,host,port,username,password,privateKeyPath,certificatePath,jumpServerId,folder,theme,tags,isFavorite,pinnedFeatures,createdAt,lastConnected".to_string(),
            ];
            lines.extend(selected_connections.iter().map(connection_to_csv_line));
            lines.join("\n")
        }
        "ssh_config" | "config" => build_ssh_config_export(&selected_connections)?,
        _ => return Err("Unsupported export format.".to_string()),
    };

    std::fs::write(path, content)
        .map_err(|error| format!("Failed to write export file: {}", error))?;
    Ok(path.to_string())
}

#[tauri::command]
pub async fn connections_import_from_file(
    request: ConnectionImportRequest,
) -> Result<ConnectionImportResult, String> {
    let path = request.path.trim();
    if path.is_empty() {
        return Err("Import path is required.".to_string());
    }

    let file_path = std::path::Path::new(path);
    if !file_path.exists() {
        return Err("Import file not found.".to_string());
    }
    if !file_path.is_file() {
        return Err("Import path is not a file.".to_string());
    }
    let metadata = std::fs::metadata(file_path)
        .map_err(|error| format!("Cannot read import file metadata: {}", error))?;
    if metadata.len() > MAX_CONNECTION_IMPORT_BYTES {
        return Err("Import file is too large (max 5 MiB).".to_string());
    }

    let content = std::fs::read_to_string(file_path)
        .map_err(|error| format!("Failed to read import file: {}", error))?;
    let requested_format = request
        .format
        .unwrap_or_else(|| "auto".to_string())
        .trim()
        .to_ascii_lowercase();
    let extension = file_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    let effective_format = if requested_format == "auto" {
        if extension == "csv" {
            "csv".to_string()
        } else {
            "json".to_string()
        }
    } else {
        requested_format
    };

    match effective_format.as_str() {
        "csv" => Ok(ConnectionImportResult {
            connections: parse_csv_connections(&content)?,
            folders: vec![],
            tunnels: vec![],
        }),
        "json" | "zync" => {
            if let Ok(zync_data) = serde_json::from_str::<ZyncConnectionsExport>(&content) {
                return Ok(ConnectionImportResult {
                    connections: zync_data.connections,
                    folders: zync_data.folders,
                    tunnels: zync_data.tunnels,
                });
            }
            if let Ok(saved_data) = serde_json::from_str::<SavedData>(&content) {
                return Ok(ConnectionImportResult {
                    connections: saved_data.connections,
                    folders: saved_data.folders,
                    tunnels: vec![],
                });
            }
            if let Ok(connections) = serde_json::from_str::<Vec<SavedConnection>>(&content) {
                return Ok(ConnectionImportResult {
                    connections,
                    folders: vec![],
                    tunnels: vec![],
                });
            }
            Err("Unsupported JSON import shape. Expected zync/json connection export.".to_string())
        }
        _ => Err("Unsupported import format.".to_string()),
    }
}

#[tauri::command]
/// Create a local or SSH terminal with generation- and channel-bound output ownership.
pub async fn terminal_create(
    term_id: String,
    connection_id: String,
    cols: u16,
    rows: u16,
    output_channel: tauri::ipc::Channel,
    shell: Option<String>,
    cwd: Option<String>,
    generation: Option<u32>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let creation = state
        .pty_manager
        .begin_creation(&term_id, &connection_id)
        .await
        .map_err(|error| error.to_string())?;
    let channel_id = output_channel.id();
    let generation = match generation {
        Some(value) => value,
        None => {
            eprintln!(
                "[TERM] terminal_create called without generation for connection {} and term {}; defaulting to 0",
                connection_id, term_id
            );
            0
        }
    };
    // Check if this is a local or remote connection
    if connection_id == "local" {
        // Use term_id (UUID) for the session, not connection_id
        state
            .pty_manager
            .create_local_session(
                creation,
                generation,
                cols,
                rows,
                app,
                output_channel,
                shell,
                cwd,
            )
            .await
            .map_err(|e| e.to_string())?;
        Ok(term_id)
    } else {
        let channel = open_ssh_channel_with_single_reconnect(&connection_id, &state).await?;
        let (remote_os, detected_shell, forward_agent) = {
            let connections = state.connections.lock().await;
            let connection = connections.get(&connection_id);
            (
                connection.and_then(|c| c.detected_os.clone()),
                connection.and_then(|c| c.detected_shell.clone()),
                connection
                    .and_then(|c| c.config.agent_forwarding.as_ref())
                    .is_some(),
            )
        };
        if forward_agent {
            channel
                .agent_forward(true)
                .await
                .map_err(|error| format!("SSH agent forwarding request failed: {error}"))?;
        }

        let (auth_banner, reconnect_generation) = {
            let mut connections = state.connections.lock().await;
            let mut connection = connections.get_mut(&connection_id);
            (
                connection.as_mut().and_then(|c| c.auth_banner.take()),
                connection.map(|c| c.reconnect_generation),
            )
        };

        let deferred_startup = remote_os.is_none();
        let deferred_shell = shell.clone();
        let deferred_cwd = cwd.clone();

        let created = state
            .pty_manager
            .create_remote_session(
                creation,
                generation,
                channel,
                cols,
                rows,
                app,
                output_channel,
                shell,
                remote_os,
                detected_shell,
                cwd,
                auth_banner.clone(),
            )
            .await;
        if let Err(error) = created {
            if let Some(banner) = auth_banner {
                let mut connections = state.connections.lock().await;
                if let Some(connection) = connections.get_mut(&connection_id) {
                    if Some(connection.reconnect_generation) == reconnect_generation
                        && connection.auth_banner.is_none()
                    {
                        connection.auth_banner = Some(banner);
                    }
                }
            }
            return Err(error.to_string());
        }

        // The interactive shell has now claimed OpenSSH's first session
        // channel, so metadata probes can no longer consume its PAM/MOTD text.
        // Keep them detached from terminal startup; slow remote commands must
        // not delay a usable prompt.
        let metadata_connection_id = connection_id.clone();
        let metadata_term_id = term_id.clone();
        let metadata_app = state.app_handle.clone();
        tokio::spawn(async move {
            if let Some(app_state) = metadata_app.try_state::<AppState>() {
                initialize_remote_metadata_after_terminal(
                    &metadata_connection_id,
                    Some(&metadata_term_id),
                    Some(generation),
                    Some(channel_id),
                    deferred_startup,
                    deferred_shell,
                    deferred_cwd,
                    app_state.inner(),
                )
                .await;
            }
        });

        Ok(term_id)
    }
}

/// A changed generation under the same owner means a serialized sibling already
/// reconnected (including counter wrap). It is reusable only with a session;
/// a replacement lock always belongs to a different connection context.
fn reconnect_completed_by_sibling(
    expected_lock: &Arc<Mutex<()>>,
    expected_generation: u64,
    current_lock: &Arc<Mutex<()>>,
    current_generation: u64,
    has_session: bool,
) -> Result<bool, ()> {
    if !Arc::ptr_eq(current_lock, expected_lock) {
        return Err(());
    }
    if current_generation != expected_generation {
        return if has_session { Ok(true) } else { Err(()) };
    }
    Ok(false)
}

#[cfg(test)]
mod reconnect_waiter_tests {
    use super::reconnect_completed_by_sibling;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    #[test]
    fn sibling_waiter_reuses_only_a_completed_reconnect_with_the_same_owner() {
        let owner = Arc::new(Mutex::new(()));
        assert_eq!(
            reconnect_completed_by_sibling(&owner, 7, &owner, 7, false),
            Ok(false)
        );
        assert_eq!(
            reconnect_completed_by_sibling(&owner, 7, &owner, 8, true),
            Ok(true)
        );
        assert_eq!(
            reconnect_completed_by_sibling(&owner, 7, &owner, 9, true),
            Ok(true)
        );
        assert_eq!(
            reconnect_completed_by_sibling(&owner, u64::MAX, &owner, 0, true),
            Ok(true)
        );
        assert_eq!(
            reconnect_completed_by_sibling(&owner, 7, &owner, 8, false),
            Err(())
        );
    }

    #[test]
    fn replacement_owner_is_rejected_even_with_a_session_or_reused_generation() {
        let owner = Arc::new(Mutex::new(()));
        let replacement = Arc::new(Mutex::new(()));
        for generation in [7, 8] {
            for has_session in [false, true] {
                assert_eq!(
                    reconnect_completed_by_sibling(&owner, 7, &replacement, generation, has_session),
                    Err(())
                );
            }
        }
    }
}

/// Replace only the captured connection owner; reprobe kernel capabilities on its new transport.
async fn reconnect_stored_connection(
    connection_id: &str,
    reconnect_lock: Arc<Mutex<()>>,
    expected_generation: u64,
    state: &AppState,
) -> Result<(), String> {
    // Keep the originally captured owner across admission. Reacquiring an owner
    // by ID could reconnect old account/configuration over a replacement host.
    let _reconnect_guard = reconnect_lock.clone().lock_owned().await;

    let (original_config, previous_detected_os, previous_detected_shell) = {
        let connections = state.connections.lock().await;
        let handle = connections.get(connection_id)
            .ok_or_else(|| format!("Connection {connection_id} was disconnected during reconnect"))?;
        if reconnect_completed_by_sibling(
            &reconnect_lock,
            expected_generation,
            &handle.reconnect_lock,
            handle.reconnect_generation,
            handle.session.is_some(),
        )
        .map_err(|()| format!("Connection {connection_id} changed before reconnect"))?
        {
            return Ok(());
        }
        (handle.config.clone(), handle.detected_os.clone(), handle.detected_shell.clone())
    };

    let uses_vault_auth = config_uses_vault_auth(&original_config);
    let mut connect_config = original_config.clone();

    if uses_vault_auth {
        let vault = state
            .app_handle
            .try_state::<tokio::sync::Mutex<crate::vault::store::VaultService>>()
            .ok_or("Vault service unavailable")?;
        let relinked = resolve_vault_refs(&mut connect_config, &vault).await?;
        if !relinked.is_empty() {
            let app_handle = state.app_handle.clone();
            let persist_result = tokio::task::spawn_blocking(move || {
                persist_relinked_vault_refs(&app_handle, &relinked)
            })
            .await;
            match persist_result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    return Err(format!("Failed to persist relinked vault refs: {error}"))
                }
                Err(join_error) => {
                    return Err(format!(
                        "Failed to persist relinked vault refs: task join error: {join_error}"
                    ))
                }
            }
        }
    }

    inject_remembered_key_passphrases_blocking(&mut connect_config).await?;

    let mut new_handle =
        reconnect_connection(&connect_config, &state.ssh_manager, &state.tunnel_manager).await?;
    new_handle.config = original_config;
    new_handle.uses_vault_auth = uses_vault_auth;
    new_handle.detected_os = previous_detected_os;
    new_handle.detected_shell = previous_detected_shell;
    // Kernel capabilities remain unknown until probed on the new transport.
    let mut connections = state.connections.lock().await;
    match connections.get(connection_id) {
        Some(existing) if existing.reconnect_generation == expected_generation
            && Arc::ptr_eq(&existing.reconnect_lock, &reconnect_lock) => {
            new_handle.reconnect_generation = expected_generation.wrapping_add(1);
            // Preserve the *same* reconnect_lock Arc so any concurrent waiters on the old handle continue to serialize against this instance.
            new_handle.reconnect_lock = reconnect_lock.clone();
            connections.insert(connection_id.to_string(), new_handle);
            Ok(())
        }
        Some(_) => Err(format!(
            "Connection {connection_id} changed during reconnect"
        )),
        None => Err(format!(
            "Connection {connection_id} was disconnected during reconnect"
        )),
    }
}

/// Machine-readable prefix — must stay in sync with `TERMINAL_SPAWN_CONNECTION_NOT_READY` in TS.
fn connection_not_ready_error(connection_id: &str) -> String {
    format!("CONNECTION_NOT_READY:{connection_id}")
}

async fn get_live_ssh_session(
    connection_id: &str,
    state: &State<'_, AppState>,
) -> Result<Arc<Mutex<russh::client::Handle<crate::ssh::Client>>>, String> {
    let (existing, reconnect_lock, generation) = {
        let connections = state.connections.lock().await;
        let conn = connections.get(connection_id)
            .ok_or_else(|| connection_not_ready_error(connection_id))?;
        (conn.session.clone(), conn.reconnect_lock.clone(), conn.reconnect_generation)
    };
    if let Some(session) = existing {
        return Ok(session);
    }

    reconnect_stored_connection(connection_id, reconnect_lock, generation, state).await?;
    let session = {
        let connections = state.connections.lock().await;
        connections
            .get(connection_id)
            .and_then(|c| c.session.clone())
    };
    session.ok_or_else(|| "Reconnection did not produce a session".to_string())
}

/// Open a published russh session channel, retrying once through the shared reconnect path.
async fn open_ssh_channel_with_single_reconnect(
    connection_id: &str,
    state: &State<'_, AppState>,
) -> Result<Channel<Msg>, String> {
    let session = get_live_ssh_session(connection_id, state).await?;
    let first_try = {
        let guard = session.lock().await;
        guard.channel_open_session().await
    };
    if let Ok(channel) = first_try {
        return Ok(channel);
    }

    // First channel open failed; clear stale session and re-use centralized
    // get_live_ssh_session() reconnect path.
    {
        let mut connections = state.connections.lock().await;
        if let Some(conn) = connections.get_mut(connection_id) {
            conn.session = None;
        }
    }
    let new_session = get_live_ssh_session(connection_id, state).await?;
    let guard = new_session.lock().await;
    guard
        .channel_open_session()
        .await
        .map_err(|e| format!("Channel open failed after reconnect: {}", e))
}

async fn run_connection_probe(
    session: &Arc<Mutex<russh::client::Handle<crate::ssh::Client>>>,
    command: &str,
) -> Option<String> {
    const PROBE_TIMEOUT: Duration = Duration::from_secs(4);
    tokio::time::timeout(PROBE_TIMEOUT, async {
        let mut channel = {
            let guard = session.lock().await;
            guard.channel_open_session().await.ok()?
        };
        channel.exec(true, command).await.ok()?;
        let mut output = String::new();
        while let Some(message) = channel.wait().await {
            match message {
                russh::ChannelMsg::Data { data } => {
                    output.push_str(&String::from_utf8_lossy(&data));
                }
                russh::ChannelMsg::ExitStatus { .. } => {}
                _ => {}
            }
        }
        Some(output)
    })
    .await
    .ok()
    .flatten()
}

fn parse_windows_openssh_default_shell(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let marker = "REG_SZ";
        let marker_start = line.to_ascii_uppercase().find(marker)?;
        let value = line[marker_start + marker.len()..].trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

fn resolve_windows_openssh_shell(probe_output: Option<String>) -> Option<String> {
    probe_output.map(|output| {
        parse_windows_openssh_default_shell(&output).unwrap_or_else(|| "cmd.exe".to_string())
    })
}

/// Preserve the distribution label for UI consumers and uname's kernel for capabilities.
fn parse_remote_os_metadata(
    os_release: Option<&str>,
    uname: Option<&str>,
) -> (Option<String>, Option<String>) {
    let kernel = uname
        .map(|output| output.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    let distribution = os_release.and_then(|output| {
        output.lines().find_map(|line| {
            line.strip_prefix("ID=")
                .map(|id| id.trim_matches('"').to_string())
                .filter(|id| !id.is_empty())
        })
    });
    let os = distribution.or_else(|| {
        kernel.as_ref().map(|system| {
            if system == "darwin" { "macos".to_string() } else { system.clone() }
        })
    });
    (os, kernel)
}

#[cfg(test)]
mod remote_metadata_tests {
    use super::{parse_remote_os_metadata, parse_windows_openssh_default_shell, resolve_windows_openssh_shell};

    #[test]
    fn distribution_labels_never_determine_kernel_capabilities() {
        for (distribution, uname, expected_os, expected_kernel) in [
            (Some("ID=\"ubuntu\"\n"), Some("Linux\n"), Some("ubuntu"), Some("linux")),
            (Some("ID=alpine\n"), Some(" Linux \n"), Some("alpine"), Some("linux")),
            (Some("ID=debian\n"), Some("FreeBSD\n"), Some("debian"), Some("freebsd")),
            (Some("ID=linux\n"), None, Some("linux"), None),
            (None, Some("Darwin\n"), Some("macos"), Some("darwin")),
            (None, Some("Linux\n"), Some("linux"), Some("linux")),
            (Some("ID=\"\"\n"), Some(" \n"), None, None),
            (None, None, None, None),
        ] {
            let (os, kernel) = parse_remote_os_metadata(distribution, uname);
            assert_eq!(os.as_deref(), expected_os);
            assert_eq!(kernel.as_deref(), expected_kernel);
        }
    }

    #[test]
    fn parses_windows_openssh_default_shell_registry_value() {
        let output = concat!(
            "HKEY_LOCAL_MACHINE\\SOFTWARE\\OpenSSH\r\n",
            "    DefaultShell    REG_SZ    C:\\Program Files\\PowerShell\\7\\pwsh.exe\r\n",
        );

        assert_eq!(
            parse_windows_openssh_default_shell(output).as_deref(),
            Some(r"C:\Program Files\PowerShell\7\pwsh.exe")
        );
    }

    #[test]
    fn missing_windows_openssh_default_shell_uses_caller_fallback() {
        assert_eq!(
            parse_windows_openssh_default_shell("ERROR: not found"),
            None
        );
    }

    #[test]
    fn successful_probe_without_registry_value_uses_cmd() {
        assert_eq!(
            resolve_windows_openssh_shell(Some(String::new())).as_deref(),
            Some("cmd.exe")
        );
    }

    #[test]
    fn failed_probe_does_not_cache_cmd() {
        assert_eq!(resolve_windows_openssh_shell(None), None);
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionMetadataPayload {
    connection_id: String,
    detected_os: Option<String>,
    detected_shell: Option<String>,
}

/// Probe connection metadata without letting an obsolete terminal startup
/// apply shell commands to a replacement that reused its generation.
async fn initialize_remote_metadata_after_terminal(
    connection_id: &str,
    term_id: Option<&str>,
    generation: Option<u32>,
    channel_id: Option<u32>,
    finalize_startup: bool,
    pending_shell: Option<String>,
    pending_cwd: Option<String>,
    state: &AppState,
) {
    let (session, reconnect_generation, cached_os, cached_kernel_os, cached_shell) = {
        let connections = state.connections.lock().await;
        let Some(connection) = connections.get(connection_id) else {
            return;
        };
        (
            connection.session.clone(),
            connection.reconnect_generation,
            connection.detected_os.clone(),
            connection.detected_kernel_os.clone(),
            connection.detected_shell.clone(),
        )
    };
    if cached_os.is_some() && cached_shell.is_some()
        && (cached_kernel_os.is_some() || cached_os.as_deref() == Some("windows"))
    {
        if let (true, Some(term_id), Some(generation), Some(channel_id)) =
            (finalize_startup, term_id, generation, channel_id)
        {
            finalize_remote_terminal_startup(
                term_id,
                generation,
                channel_id,
                cached_os.as_deref(),
                cached_shell.as_deref(),
                pending_shell.as_deref(),
                pending_cwd.as_deref(),
                state,
            )
            .await;
        }
        return;
    }
    let Some(session) = session else {
        return;
    };

    let os_release = run_connection_probe(&session, "cat /etc/os-release").await;
    let uname = run_connection_probe(&session, "uname -s").await;
    let (mut detected_os, detected_kernel_os) =
        parse_remote_os_metadata(os_release.as_deref(), uname.as_deref());
    if detected_os.is_none() {
        if let Some(output) = run_connection_probe(&session, "cmd /c ver").await {
            if output.to_ascii_lowercase().contains("windows") {
                detected_os = Some("windows".to_string());
            }
        }
    }

    let detected_shell = if detected_os
        .as_deref()
        .is_some_and(|os| os.eq_ignore_ascii_case("windows"))
    {
        let probe_output = run_connection_probe(
            &session,
            r"cmd.exe /d /c reg.exe query HKLM\SOFTWARE\OpenSSH /v DefaultShell",
        )
        .await;
        // OpenSSH uses cmd.exe when the registry query succeeds but DefaultShell
        // is absent. A failed probe must remain unknown so it can be retried.
        resolve_windows_openssh_shell(probe_output)
    } else {
        run_connection_probe(&session, "basename \"${SHELL:-}\"")
            .await
            .map(|output| output.trim().to_string())
            .filter(|shell| !shell.is_empty())
    };

    let current_metadata = {
        let mut connections = state.connections.lock().await;
        if let Some(connection) = connections.get_mut(connection_id) {
            if connection.reconnect_generation == reconnect_generation
                && connection.session.as_ref().is_some_and(|current| Arc::ptr_eq(current, &session))
            {
                if detected_os.is_some() {
                    connection.detected_os = detected_os.clone();
                }
                if detected_shell.is_some() {
                    connection.detected_shell = detected_shell.clone();
                }
                connection.detected_kernel_os = detected_kernel_os;
                Some((
                    connection.detected_os.clone(),
                    connection.detected_shell.clone(),
                ))
            } else {
                None
            }
        } else {
            None
        }
    };

    if let Some((current_os, current_shell)) = current_metadata {
        let _ = state.app_handle.emit(
            "connection:metadata",
            ConnectionMetadataPayload {
                connection_id: connection_id.to_string(),
                detected_os: current_os.clone(),
                detected_shell: current_shell.clone(),
            },
        );

        if let (true, Some(term_id), Some(generation), Some(channel_id)) =
            (finalize_startup, term_id, generation, channel_id)
        {
            finalize_remote_terminal_startup(
                term_id,
                generation,
                channel_id,
                current_os.as_deref(),
                current_shell.as_deref(),
                pending_shell.as_deref(),
                pending_cwd.as_deref(),
                state,
            )
            .await;
        }
    }
}

/// Refresh shared host metadata after SFTP without claiming any terminal startup.
fn probe_remote_metadata_after_sftp(connection_id: String, app_handle: AppHandle) {
    tokio::spawn(async move {
        if let Some(state) = app_handle.try_state::<AppState>() {
            initialize_remote_metadata_after_terminal(
                &connection_id,
                None,
                None,
                None,
                false,
                None,
                None,
                state.inner(),
            )
            .await;
        }
    });
}

/// Apply deferred input only to the channel that requested this metadata probe.
async fn finalize_remote_terminal_startup(
    term_id: &str,
    generation: u32,
    channel_id: u32,
    remote_os: Option<&str>,
    detected_shell: Option<&str>,
    pending_shell: Option<&str>,
    pending_cwd: Option<&str>,
    state: &AppState,
) {
    let Some(remote_os) = remote_os else {
        return;
    };
    if let Err(error) = state
        .pty_manager
        .finalize_remote_startup(
            term_id,
            generation,
            channel_id,
            remote_os,
            detected_shell,
            pending_shell,
            pending_cwd,
        )
        .await
    {
        eprintln!(
            "[TERM] Failed to apply deferred startup for terminal {}: {}",
            term_id, error
        );
    }
}

#[tauri::command]
pub async fn terminal_close(term_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state
        .pty_manager
        .close(&term_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn terminal_has_active_processes(
    term_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    Ok(state.pty_manager.has_active_child_processes(&term_id).await)
}

/// Process-wide PTY flush-reason totals. Not per-session. Does not change the
/// output Channel frame layout.
#[tauri::command]
pub fn terminal_flush_stats() -> crate::pty_output_flush::FlushReasonCounts {
    crate::pty_output_flush::flush_reason_snapshot()
}

#[derive(Debug)]
enum OpenSftpError {
    Transport(String),
    ChannelRejected(String),
    Subsystem(String),
    Initialize(String),
}

impl std::fmt::Display for OpenSftpError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(message)
            | Self::ChannelRejected(message)
            | Self::Subsystem(message)
            | Self::Initialize(message) => formatter.write_str(message),
        }
    }
}

fn classify_sftp_channel_open_error(error: russh::Error) -> OpenSftpError {
    let message = format!("Failed to open SFTP channel: {error}");
    if matches!(error, russh::Error::ChannelOpenFailure(_)) {
        OpenSftpError::ChannelRejected(message)
    } else {
        OpenSftpError::Transport(message)
    }
}

#[cfg(test)]
mod sftp_open_error_tests {
    use super::{classify_sftp_channel_open_error, OpenSftpError};

    #[test]
    fn server_channel_rejection_does_not_look_like_transport_loss() {
        let error = classify_sftp_channel_open_error(russh::Error::ChannelOpenFailure(
            russh::ChannelOpenFailure::AdministrativelyProhibited,
        ));
        assert!(matches!(error, OpenSftpError::ChannelRejected(_)));
    }

    #[test]
    fn disconnect_is_classified_as_transport_loss() {
        let error = classify_sftp_channel_open_error(russh::Error::Disconnect);
        assert!(matches!(error, OpenSftpError::Transport(_)));
    }
}

async fn open_sftp_stream(
    session: &Arc<Mutex<russh::client::Handle<crate::ssh::Client>>>,
) -> Result<russh::ChannelStream<russh::client::Msg>, OpenSftpError> {
    let channel = {
        let guard = session.lock().await;
        guard
            .channel_open_session()
            .await
            .map_err(classify_sftp_channel_open_error)?
    };
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|error| {
            OpenSftpError::Subsystem(format!("Failed to request SFTP subsystem: {error}"))
        })?;
    Ok(channel.into_stream())
}

/// Initialize the cached SFTP session with shared packet and per-file queue bounds.
async fn open_sftp_session(
    session: &Arc<Mutex<russh::client::Handle<crate::ssh::Client>>>,
) -> Result<Arc<russh_sftp::client::SftpSession>, OpenSftpError> {
    let sftp = russh_sftp::client::SftpSession::new_with_config(
        open_sftp_stream(session).await?,
        crate::sftp_read::session_config(),
    )
    .await
    .map_err(|error| {
        OpenSftpError::Initialize(format!("Failed to initialize SFTP: {error}"))
    })?;
    Ok(Arc::new(sftp))
}

// Helper to get SFTP session - initializes it lazily on the live transport and
// reconnects only when the SSH transport itself has gone away.
async fn get_sftp_or_reconnect(
    state: &AppState,
    id: &str,
) -> Result<Arc<russh_sftp::client::SftpSession>, String> {
    let (reconnect_lock, existing_session, reconnect_generation) = {
        let connections = state.connections.lock().await;
        let conn = connections
            .get(id)
            .ok_or_else(|| format!("Connection {} not found, cannot reconnect for SFTP", id))?;

        if let Some(sftp) = &conn.sftp_session {
            return Ok(sftp.clone());
        }
        (
            conn.reconnect_lock.clone(),
            conn.session.clone(),
            conn.reconnect_generation,
        )
    };

    if let Some(session) = existing_session {
        match open_sftp_session(&session).await {
            Ok(opened) => {
                let (sftp, opened_first_sftp) = {
                    let mut connections = state.connections.lock().await;
                    let conn = connections
                        .get_mut(id)
                        .ok_or_else(|| "Connection was removed while SFTP started".to_string())?;
                    if conn.reconnect_generation != reconnect_generation
                        || !crate::sftp_read::is_current_session(&conn.session, &session)
                    {
                        return conn
                            .sftp_session
                            .clone()
                            .ok_or_else(|| "Connection changed while SFTP started".to_string());
                    }
                    let opened_first_sftp = conn.sftp_session.is_none();
                    if opened_first_sftp {
                        conn.file_permission_session = uuid::Uuid::new_v4().to_string();
                    }
                    let sftp = conn
                        .sftp_session
                        .get_or_insert_with(|| opened.clone())
                        .clone();
                    (sftp, opened_first_sftp)
                };
                if opened_first_sftp {
                    probe_remote_metadata_after_sftp(id.to_string(), state.app_handle.clone());
                }
                return Ok(sftp);
            }
            Err(OpenSftpError::Transport(_)) => {
                let mut connections = state.connections.lock().await;
                let conn = connections.get_mut(id).ok_or("Connection was removed while SFTP started")?;
                if conn.reconnect_generation != reconnect_generation
                    || !crate::sftp_read::is_current_session(&conn.session, &session)
                {
                    return Err("Connection changed while SFTP started".into());
                }
                crate::sftp_read::invalidate_if_current(&mut conn.session, &session);
            }
            Err(
                error @ (OpenSftpError::ChannelRejected(_)
                | OpenSftpError::Subsystem(_)
                | OpenSftpError::Initialize(_)),
            ) => {
                return Err(error.to_string());
            }
        }
    }

    println!("[SFTP] SSH session missing for '{}', reconnecting...", id);

    let timeout_duration = std::time::Duration::from_secs(12);
    match tokio::time::timeout(
        timeout_duration,
        reconnect_stored_connection(id, reconnect_lock, reconnect_generation, state),
    )
    .await
    {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(format!("DISCONNECTED: Auto-reconnect failed: {}", e)),
        Err(_) => {
            return Err(format!(
                "DISCONNECTED: Auto-reconnect timed out after {}s (Is the network down?)",
                timeout_duration.as_secs()
            ))
        }
    };
    let (session, reconnect_generation) = {
        let connections = state.connections.lock().await;
        let conn = connections
            .get(id)
            .ok_or_else(|| "Reconnection succeeded but connection is missing".to_string())?;
        (
            conn.session
                .clone()
                .ok_or_else(|| "Reconnection succeeded but SSH session is missing".to_string())?,
            conn.reconnect_generation,
        )
    };
    let sftp = open_sftp_session(&session)
        .await
        .map_err(|error| error.to_string())?;
    let (sftp, opened_first_sftp) = {
        let mut connections = state.connections.lock().await;
        let conn = connections.get_mut(id)
            .ok_or("Connection was removed while SFTP started")?;
        if conn.reconnect_generation != reconnect_generation
            || !crate::sftp_read::is_current_session(&conn.session, &session)
        {
            return Err("Connection changed while SFTP started".into());
        }
        let opened_first_sftp = conn.sftp_session.is_none();
        if opened_first_sftp {
            conn.file_permission_session = uuid::Uuid::new_v4().to_string();
        }
        let installed = conn.sftp_session.get_or_insert_with(|| sftp.clone()).clone();
        (installed, opened_first_sftp)
    };
    if opened_first_sftp {
        probe_remote_metadata_after_sftp(id.to_string(), state.app_handle.clone());
    }

    println!("[SFTP] Reconnected successfully for '{}'", id);
    Ok(sftp)
}

async fn sftp_list_ctx(
    state: &AppState,
    id: &str,
) -> Result<
    (
        Arc<russh_sftp::client::SftpSession>,
        Arc<tokio::sync::OnceCell<SftpIdentityMaps>>,
    ),
    String,
> {
    let sftp = get_sftp_or_reconnect(state, id).await?;
    let cache = {
        let connections = state.connections.lock().await;
        connections
            .get(id)
            .map(|c| c.sftp_identity_maps.clone())
            .ok_or_else(|| "Connection not found".to_string())?
    };
    Ok((sftp, cache))
}

#[tauri::command]
pub async fn fs_list_volumes(connection_id: String) -> Result<Vec<FileVolume>, String> {
    if connection_id != "local" {
        return Ok(Vec::new());
    }
    tokio::task::spawn_blocking(list_local_volumes)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_list(
    connection_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<FileEntry>, String> {
    if connection_id == "local" {
        state
            .file_system
            .list_local(&path)
            .map_err(|e| e.to_string())
    } else {
        let (sftp, identity_cache) = sftp_list_ctx(&state, &connection_id).await?;

        let timeout_duration = std::time::Duration::from_secs(10);
        match tokio::time::timeout(
            timeout_duration,
            state.file_system.list_remote(&sftp, &path, &identity_cache),
        )
        .await
        {
            Ok(Ok(res)) => Ok(res),
            Ok(Err(e)) if e.to_string().to_lowercase().contains("session closed") => {
                println!("[FS] SFTP session closed during list, retrying...");
                {
                    let mut connections = state.connections.lock().await;
                    if let Some(c) = connections.get_mut(&connection_id) {
                        c.sftp_session = None;
                    }
                }
                let (sftp, identity_cache) = sftp_list_ctx(&state, &connection_id).await?;
                match tokio::time::timeout(
                    timeout_duration,
                    state.file_system.list_remote(&sftp, &path, &identity_cache),
                )
                .await
                {
                    Ok(Ok(res)) => Ok(res),
                    Ok(Err(e)) => Err(e.to_string()),
                    Err(_) => Err(format!(
                        "DISCONNECTED: SFTP listing timed out after {}s",
                        timeout_duration.as_secs()
                    )),
                }
            }
            Ok(Err(e)) => Err(e.to_string()),
            Err(_) => {
                {
                    let mut connections = state.connections.lock().await;
                    if let Some(c) = connections.get_mut(&connection_id) {
                        c.sftp_session = None;
                    }
                }
                Err(format!(
                    "DISCONNECTED: SFTP listing timed out after {}s",
                    timeout_duration.as_secs()
                ))
            }
        }
    }
}

/// True when an SFTP read error indicates the shared session is dead (not a slow read).
pub(crate) fn sftp_error_is_dead_session(err: &anyhow::Error) -> bool {
    crate::sftp_read::is_dead_session(err)
}

pub(crate) async fn read_remote_connection_file(
    state: &AppState,
    connection_id: &str,
    path: &str,
    timeout_secs: u64,
    max_bytes: Option<u64>,
) -> Result<String, String> {
    let sftp = get_sftp_or_reconnect(state, connection_id).await?;
    let timeout_duration = std::time::Duration::from_secs(timeout_secs);

    let read = async {
        match max_bytes {
            Some(limit) => state.file_system.read_remote_limited(&sftp, path, limit).await,
            None => state.file_system.read_remote(&sftp, path).await,
        }
    };
    match tokio::time::timeout(timeout_duration, read).await {
        Ok(Ok(res)) => Ok(res),
        Ok(Err(e)) if sftp_error_is_dead_session(&e) => {
            println!("[FS] SFTP session closed during read, retrying...");
            {
                let mut connections = state.connections.lock().await;
                if let Some(c) = connections.get_mut(connection_id) {
                    c.sftp_session = None;
                }
            }
            let sftp = get_sftp_or_reconnect(state, connection_id).await?;
            let retry = async {
                match max_bytes {
                    Some(limit) => state.file_system.read_remote_limited(&sftp, path, limit).await,
                    None => state.file_system.read_remote(&sftp, path).await,
                }
            };
            match tokio::time::timeout(timeout_duration, retry)
                .await
            {
                Ok(Ok(res)) => Ok(res),
                Ok(Err(e)) => Err(e.to_string()),
                Err(_) => Err(format!(
                    "DISCONNECTED: SFTP read timed out after {}s",
                    timeout_duration.as_secs()
                )),
            }
        }
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err(format!(
            "DISCONNECTED: SFTP read timed out after {}s",
            timeout_duration.as_secs()
        )),
    }
}

#[tauri::command]
pub async fn fs_read_file(
    connection_id: String,
    path: String,
    max_bytes: Option<u64>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // Only bounded editor reads opt in. Other existing consumers retain their behavior.
    if max_bytes.is_some_and(|limit| limit == 0 || limit > 16 * 1024 * 1024) {
        return Err("Invalid editor read limit".into());
    }
    if connection_id == "local" {
        match max_bytes {
            Some(limit) => state.file_system.read_local_limited(&path, limit).map_err(|e| e.to_string()),
            None => state.file_system.read_file(&connection_id, &path).await.map_err(|e| e.to_string()),
        }
    } else {
        read_remote_connection_file(&state, &connection_id, &path, 10, max_bytes).await
    }
}

#[tauri::command]
pub async fn fs_write_file(
    connection_id: String,
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if connection_id == "local" {
        state
            .file_system
            .write_file(&connection_id, &path, &content)
            .await
            .map_err(|e| e.to_string())
    } else {
        let sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
        let timeout_duration = std::time::Duration::from_secs(10);

        match tokio::time::timeout(
            timeout_duration,
            state
                .file_system
                .write_remote(&sftp, &path, content.as_bytes()),
        )
        .await
        {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(e)) if e.to_string().to_lowercase().contains("session closed") => {
                println!("[FS] SFTP session closed during write, retrying...");
                {
                    let mut connections = state.connections.lock().await;
                    if let Some(c) = connections.get_mut(&connection_id) {
                        c.sftp_session = None;
                    }
                }
                let sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
                match tokio::time::timeout(
                    timeout_duration,
                    state
                        .file_system
                        .write_remote(&sftp, &path, content.as_bytes()),
                )
                .await
                {
                    Ok(Ok(_)) => Ok(()),
                    Ok(Err(e)) => Err(e.to_string()),
                    Err(_) => Err(format!(
                        "DISCONNECTED: SFTP write timed out after {}s",
                        timeout_duration.as_secs()
                    )),
                }
            }
            Ok(Err(e)) => Err(e.to_string()),
            Err(_) => {
                {
                    let mut connections = state.connections.lock().await;
                    if let Some(c) = connections.get_mut(&connection_id) {
                        c.sftp_session = None;
                    }
                }
                Err(format!(
                    "DISCONNECTED: SFTP write timed out after {}s",
                    timeout_duration.as_secs()
                ))
            }
        }
    }
}

#[tauri::command]
pub async fn fs_cwd(connection_id: String, state: State<'_, AppState>) -> Result<String, String> {
    if connection_id == "local" {
        state
            .file_system
            .get_home_dir(&connection_id)
            .map_err(|e| e.to_string())
    } else {
        let sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
        let timeout_duration = std::time::Duration::from_secs(10);

        match tokio::time::timeout(timeout_duration, sftp.canonicalize(".")).await {
            Ok(Ok(path)) => Ok(path),
            Ok(Err(e)) if e.to_string().to_lowercase().contains("session closed") => {
                println!("[FS] SFTP session closed during cwd, retrying...");
                {
                    let mut connections = state.connections.lock().await;
                    if let Some(c) = connections.get_mut(&connection_id) {
                        c.sftp_session = None;
                    }
                }
                let sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
                match tokio::time::timeout(timeout_duration, sftp.canonicalize(".")).await {
                    Ok(Ok(path)) => Ok(path),
                    Ok(Err(e)) => Err(e.to_string()),
                    Err(_) => Err(format!(
                        "DISCONNECTED: SFTP cwd timed out after {}s",
                        timeout_duration.as_secs()
                    )),
                }
            }
            Ok(Err(e)) => Err(e.to_string()),
            Err(_) => {
                {
                    let mut connections = state.connections.lock().await;
                    if let Some(c) = connections.get_mut(&connection_id) {
                        c.sftp_session = None;
                    }
                }
                Err(format!(
                    "DISCONNECTED: SFTP cwd timed out after {}s",
                    timeout_duration.as_secs()
                ))
            }
        }
    }
}

/// Read zsh init file contents from a WSL distro home (Windows local terminals only).
/// Returns empty string when WSL is unavailable, login shell is not zsh, or files are missing.
#[tauri::command]
pub async fn read_wsl_zsh_init_files(wsl_distro: Option<String>) -> Result<String, String> {
    read_wsl_zsh_init_files_impl(wsl_distro).await
}

#[cfg(target_os = "windows")]
async fn read_wsl_zsh_init_files_impl(wsl_distro: Option<String>) -> Result<String, String> {
    use tokio::process::Command;

    let mut cmd = Command::new("wsl.exe");
    if let Some(distro) = wsl_distro {
        let trimmed = distro.trim();
        if !trimmed.is_empty() {
            cmd.arg("-d").arg(trimmed);
        }
    }

    let shell_script = concat!(
        "case \"$SHELL\" in *zsh*) ;; *) exit 2;; esac; ",
        "for f in ~/.zshrc ~/.zprofile ~/.zshenv; do ",
        "[ -f \"$f\" ] && cat \"$f\"; done"
    );
    cmd.args(["--", "sh", "-lc", shell_script]);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let timeout_duration = std::time::Duration::from_secs(8);
    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to run WSL probe: {}", e))?;
    let child_pid = child.id();
    let output = match tokio::time::timeout(timeout_duration, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => return Err(format!("Failed to run WSL probe: {}", e)),
        Err(_) => {
            if let Some(pid) = child_pid {
                let _ = Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/F", "/T"])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .await;
            }
            eprintln!(
                "[WSL] zsh init probe timed out after {}s",
                timeout_duration.as_secs()
            );
            return Ok(String::new());
        }
    };

    if output.status.code() == Some(2) {
        return Ok(String::new());
    }
    if !output.status.success() {
        return Ok(String::new());
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(not(target_os = "windows"))]
async fn read_wsl_zsh_init_files_impl(_wsl_distro: Option<String>) -> Result<String, String> {
    Ok(String::new())
}

/// Current working directory inside a WSL distro (Linux path).
#[tauri::command]
pub async fn wsl_get_cwd(wsl_distro: Option<String>) -> Result<String, String> {
    wsl_get_cwd_impl(wsl_distro).await
}

/// List a directory inside a WSL distro for ghost path completion.
#[tauri::command]
pub async fn fs_list_wsl(
    wsl_distro: Option<String>,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    fs_list_wsl_impl(wsl_distro, path).await
}

#[cfg(target_os = "windows")]
fn push_wsl_distro(cmd: &mut tokio::process::Command, wsl_distro: &Option<String>) {
    if let Some(distro) = wsl_distro {
        let trimmed = distro.trim();
        if !trimmed.is_empty() {
            cmd.arg("-d").arg(trimmed);
        }
    }
}

#[cfg(target_os = "windows")]
async fn wsl_get_cwd_impl(wsl_distro: Option<String>) -> Result<String, String> {
    use tokio::process::Command;

    let mut cmd = Command::new("wsl.exe");
    push_wsl_distro(&mut cmd, &wsl_distro);
    cmd.args(["--", "sh", "-lc", "pwd -P"]);

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to read WSL cwd: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "WSL cwd failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(not(target_os = "windows"))]
async fn wsl_get_cwd_impl(_wsl_distro: Option<String>) -> Result<String, String> {
    Err("WSL is only available on Windows".to_string())
}

#[cfg(target_os = "windows")]
fn shell_single_quote(path: &str) -> String {
    format!("'{}'", path.replace('\'', "'\"'\"'"))
}

#[cfg(target_os = "windows")]
fn wsl_list_path_shell(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == "~" {
        return "\"$HOME\"".to_string();
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        if rest.is_empty() {
            return "\"$HOME\"".to_string();
        }
        return format!("\"$HOME\"/{}", shell_single_quote(rest));
    }
    shell_single_quote(trimmed)
}

#[cfg(target_os = "windows")]
async fn fs_list_wsl_impl(
    wsl_distro: Option<String>,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    use tokio::process::Command;

    // Inline the path in the script — `wsl.exe -- sh -lc` drops assignments like
    // `target=...` when spawned from the Windows side, so `$target` is always empty.
    let path_shell = wsl_list_path_shell(&path);
    let list_script = format!(
        "if [ ! -d {path_shell} ]; then exit 1; fi; \
         ls -1AF -- {path_shell} 2>/dev/null"
    );

    let mut cmd = Command::new("wsl.exe");
    push_wsl_distro(&mut cmd, &wsl_distro);
    cmd.args(["--", "sh", "-lc", &list_script]);

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to list WSL directory: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(format!("WSL list failed for {path:?}: {detail}"));
    }

    Ok(parse_wsl_ls_listing(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

#[cfg(not(target_os = "windows"))]
async fn fs_list_wsl_impl(
    _wsl_distro: Option<String>,
    _path: String,
) -> Result<Vec<FileEntry>, String> {
    Err("WSL is only available on Windows".to_string())
}

/// Filesystem helpers for ghost suggest v2 (P5).
pub(crate) async fn ghost_fs_list(
    state: &AppState,
    connection_id: &str,
    path: &str,
) -> Result<Vec<FileEntry>, String> {
    if connection_id == "local" {
        state
            .file_system
            .list_local(path)
            .map_err(|e| e.to_string())
    } else {
        let (sftp, identity_cache) = sftp_list_ctx(state, connection_id).await?;
        let timeout_duration = std::time::Duration::from_secs(10);
        match tokio::time::timeout(
            timeout_duration,
            state.file_system.list_remote(&sftp, path, &identity_cache),
        )
        .await
        {
            Ok(Ok(res)) => Ok(res),
            Ok(Err(e)) if sftp_error_is_dead_session(&e) => {
                println!("[FS] SFTP session closed during list, retrying...");
                {
                    let mut connections = state.connections.lock().await;
                    if let Some(c) = connections.get_mut(connection_id) {
                        c.sftp_session = None;
                    }
                }
                let (sftp, identity_cache) = sftp_list_ctx(state, connection_id).await?;
                match tokio::time::timeout(
                    timeout_duration,
                    state.file_system.list_remote(&sftp, path, &identity_cache),
                )
                .await
                {
                    Ok(Ok(res)) => Ok(res),
                    Ok(Err(e)) => Err(e.to_string()),
                    Err(_) => Err(format!(
                        "DISCONNECTED: SFTP listing timed out after {}s",
                        timeout_duration.as_secs()
                    )),
                }
            }
            Ok(Err(e)) => Err(e.to_string()),
            Err(_) => Err(format!(
                "DISCONNECTED: SFTP listing timed out after {}s",
                timeout_duration.as_secs()
            )),
        }
    }
}

pub(crate) async fn ghost_fs_cwd(state: &AppState, connection_id: &str) -> Result<String, String> {
    if connection_id == "local" {
        state
            .file_system
            .get_home_dir(connection_id)
            .map_err(|e| e.to_string())
    } else {
        let sftp = get_sftp_or_reconnect(state, connection_id).await?;
        let timeout_duration = std::time::Duration::from_secs(10);
        match tokio::time::timeout(timeout_duration, sftp.canonicalize(".")).await {
            Ok(Ok(path)) => Ok(path),
            Ok(Err(e)) => Err(e.to_string()),
            Err(_) => Err(format!(
                "DISCONNECTED: SFTP cwd timed out after {}s",
                timeout_duration.as_secs()
            )),
        }
    }
}

pub(crate) async fn ghost_fs_list_wsl(
    wsl_distro: Option<String>,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    fs_list_wsl_impl(wsl_distro, path).await
}

pub(crate) async fn ghost_wsl_get_cwd(wsl_distro: Option<String>) -> Result<String, String> {
    wsl_get_cwd_impl(wsl_distro).await
}

fn parse_wsl_ls_listing(stdout: &str) -> Vec<FileEntry> {
    let mut entries = Vec::new();

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let (name, file_type) = if let Some(stripped) = line.strip_suffix('/') {
            (stripped, "d")
        } else if let Some(stripped) = line.strip_suffix('@') {
            (stripped, "l")
        } else if let Some((link, _)) = line.split_once(" -> ") {
            (link.trim(), "l")
        } else {
            (line, "-")
        };
        if name == "." || name == ".." {
            continue;
        }

        entries.push(FileEntry {
            name: name.to_string(),
            path: String::new(),
            r#type: file_type.to_string(),
            size: 0,
            last_modified: 0,
            permissions: String::new(),
            owner: String::new(),
            group: String::new(),
        });
    }

    entries.sort_by(|a, b| {
        let a_dir = a.r#type == "d" || a.r#type == "l";
        let b_dir = b.r#type == "d" || b.r#type == "l";
        if a_dir && !b_dir {
            std::cmp::Ordering::Less
        } else if !a_dir && b_dir {
            std::cmp::Ordering::Greater
        } else {
            a.name.cmp(&b.name)
        }
    });

    entries
}

#[cfg(test)]
mod wsl_list_tests {
    use super::parse_wsl_ls_listing;

    #[test]
    fn parse_ls_marks_directories_and_symlinks() {
        let stdout = "data/\nfile.txt\nlink@\nother -> target\n";
        let entries = parse_wsl_ls_listing(stdout);
        assert_eq!(entries.len(), 4);
        let by_name: std::collections::HashMap<_, _> = entries
            .iter()
            .map(|e| (e.name.as_str(), e.r#type.as_str()))
            .collect();
        assert_eq!(by_name.get("data"), Some(&"d"));
        assert_eq!(by_name.get("file.txt"), Some(&"-"));
        assert_eq!(by_name.get("link"), Some(&"l"));
        assert_eq!(by_name.get("other"), Some(&"l"));
    }
}

#[tauri::command]
pub async fn fs_touch(
    connection_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if connection_id == "local" {
        if let Ok(true) = state.file_system.exists(&connection_id, &path).await {
            return Err(format!(
                "An item with the name '{}' already exists in this directory.",
                std::path::Path::new(&path)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
            ));
        }
        state
            .file_system
            .create_file(&connection_id, &path)
            .await
            .map_err(|e| e.to_string())
    } else {
        let mut sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
        let timeout_duration = std::time::Duration::from_secs(10);

        let touch_fut = async {
            if let Ok(true) = state.file_system.exists_remote(&sftp, &path).await {
                return Err(format!(
                    "An item with the name '{}' already exists in this directory.",
                    std::path::Path::new(&path)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                ));
            }
            state
                .file_system
                .create_file_remote(&sftp, &path)
                .await
                .map_err(|e| e.to_string())
        };

        match tokio::time::timeout(timeout_duration, touch_fut).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(e)) if e.to_string().to_lowercase().contains("session closed") => {
                println!("[FS] SFTP session closed during touch, retrying...");
                {
                    let mut connections = state.connections.lock().await;
                    if let Some(c) = connections.get_mut(&connection_id) {
                        c.sftp_session = None;
                    }
                }
                sftp = get_sftp_or_reconnect(&state, &connection_id).await?;

                let retry_fut = async {
                    if let Ok(true) = state.file_system.exists_remote(&sftp, &path).await {
                        // After reconnect, if it exists, it likely means our original request succeeded before the disconnect
                        return Ok(());
                    }
                    state
                        .file_system
                        .create_file_remote(&sftp, &path)
                        .await
                        .map_err(|e| e.to_string())
                };

                match tokio::time::timeout(timeout_duration, retry_fut).await {
                    Ok(Ok(_)) => Ok(()),
                    Ok(Err(e)) => Err(e.to_string()),
                    Err(_) => {
                        {
                            let mut connections = state.connections.lock().await;
                            if let Some(c) = connections.get_mut(&connection_id) {
                                c.sftp_session = None;
                            }
                        }
                        Err(format!(
                            "DISCONNECTED: SFTP touch timed out after {}s",
                            timeout_duration.as_secs()
                        ))
                    }
                }
            }
            Ok(Err(e)) => Err(e.to_string()),
            Err(_) => {
                {
                    let mut connections = state.connections.lock().await;
                    if let Some(c) = connections.get_mut(&connection_id) {
                        c.sftp_session = None;
                    }
                }
                Err(format!(
                    "DISCONNECTED: SFTP touch timed out after {}s",
                    timeout_duration.as_secs()
                ))
            }
        }
    }
}

#[tauri::command]
pub async fn fs_mkdir(
    connection_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if connection_id == "local" {
        if let Ok(true) = state.file_system.exists(&connection_id, &path).await {
            return Err(format!(
                "An item with the name '{}' already exists in this directory.",
                std::path::Path::new(&path)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
            ));
        }
        state
            .file_system
            .create_dir(&connection_id, &path)
            .await
            .map_err(|e| e.to_string())
    } else {
        let mut sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
        let timeout_duration = std::time::Duration::from_secs(10);

        let mkdir_fut = async {
            if let Ok(true) = state.file_system.exists_remote(&sftp, &path).await {
                return Err(format!(
                    "An item with the name '{}' already exists in this directory.",
                    std::path::Path::new(&path)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                ));
            }
            state
                .file_system
                .create_dir_remote(&sftp, &path)
                .await
                .map_err(|e| e.to_string())
        };

        match tokio::time::timeout(timeout_duration, mkdir_fut).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(e)) if e.to_string().to_lowercase().contains("session closed") => {
                println!("[FS] SFTP session closed during mkdir, retrying...");
                {
                    let mut connections = state.connections.lock().await;
                    if let Some(c) = connections.get_mut(&connection_id) {
                        c.sftp_session = None;
                    }
                }
                sftp = get_sftp_or_reconnect(&state, &connection_id).await?;

                let retry_fut = async {
                    if let Ok(true) = state.file_system.exists_remote(&sftp, &path).await {
                        // After reconnect, if it exists, it likely means our original request succeeded before the disconnect
                        return Ok(());
                    }
                    state
                        .file_system
                        .create_dir_remote(&sftp, &path)
                        .await
                        .map_err(|e| e.to_string())
                };

                match tokio::time::timeout(timeout_duration, retry_fut).await {
                    Ok(Ok(_)) => Ok(()),
                    Ok(Err(e)) => Err(e.to_string()),
                    Err(_) => {
                        {
                            let mut connections = state.connections.lock().await;
                            if let Some(c) = connections.get_mut(&connection_id) {
                                c.sftp_session = None;
                            }
                        }
                        Err(format!(
                            "DISCONNECTED: SFTP mkdir timed out after {}s",
                            timeout_duration.as_secs()
                        ))
                    }
                }
            }
            Ok(Err(e)) => Err(e.to_string()),
            Err(_) => {
                {
                    let mut connections = state.connections.lock().await;
                    if let Some(c) = connections.get_mut(&connection_id) {
                        c.sftp_session = None;
                    }
                }
                Err(format!(
                    "DISCONNECTED: SFTP mkdir timed out after {}s",
                    timeout_duration.as_secs()
                ))
            }
        }
    }
}

#[tauri::command]
pub async fn fs_rename(
    connection_id: String,
    old_path: String,
    mut new_path: String,
    auto_rename: Option<bool>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if connection_id == "local" {
        if auto_rename.unwrap_or(false) && std::path::Path::new(&new_path).exists() {
            let path_buf = std::path::PathBuf::from(&new_path);
            let parent = path_buf
                .parent()
                .unwrap_or_else(|| std::path::Path::new(""));
            let file_stem = path_buf.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let extension = path_buf.extension().and_then(|s| s.to_str()).unwrap_or("");
            let mut counter = 1;

            let mut found_unique = false;
            while counter <= 100 {
                let new_name = if extension.is_empty() {
                    format!("{} ({})", file_stem, counter)
                } else {
                    format!("{} ({}).{}", file_stem, counter, extension)
                };
                let candidate = parent.join(new_name).to_string_lossy().to_string();
                if !std::path::Path::new(&candidate).exists() {
                    new_path = candidate;
                    found_unique = true;
                    break;
                }
                counter += 1;
            }

            if !found_unique {
                return Err("Too many existing files, cannot auto-rename".to_string());
            }
        }

        state
            .file_system
            .rename(&connection_id, &old_path, &new_path)
            .await
            .map_err(|e| e.to_string())
    } else {
        let mut sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
        let timeout_duration = std::time::Duration::from_secs(10);

        if auto_rename.unwrap_or(false) {
            // Wrap the unique path check in the same timeout/reconnect pattern as the rename itself
            match tokio::time::timeout(
                timeout_duration,
                state.file_system.get_unique_path_remote(&sftp, &new_path),
            )
            .await
            {
                Ok(Ok(unique_path)) => {
                    new_path = unique_path;
                }
                Ok(Err(e)) if e.to_string().to_lowercase().contains("session closed") => {
                    println!("[FS] SFTP session closed during name check, retrying...");
                    sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
                    new_path = tokio::time::timeout(
                        timeout_duration,
                        state.file_system.get_unique_path_remote(&sftp, &new_path),
                    )
                    .await
                    .map_err(|e| format!("Timeout generating unique path: {}", e))?
                    .map_err(|e| e.to_string())?;
                }
                Ok(Err(e)) => return Err(e.to_string()),
                Err(_) => return Err("Timeout generating unique path".to_string()),
            }
        }

        match tokio::time::timeout(
            timeout_duration,
            state.file_system.rename_remote(&sftp, &old_path, &new_path),
        )
        .await
        {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(e)) if e.to_string().to_lowercase().contains("session closed") => {
                {
                    let mut connections = state.connections.lock().await;
                    if let Some(c) = connections.get_mut(&connection_id) {
                        c.sftp_session = None;
                    }
                }
                Err(format!("DISCONNECTED: Rename outcome is unconfirmed; check source and destination before retrying: {}", e))
            }
            Ok(Err(e)) => Err(e.to_string()),
            Err(_) => {
                {
                    let mut connections = state.connections.lock().await;
                    if let Some(c) = connections.get_mut(&connection_id) {
                        c.sftp_session = None;
                    }
                }
                Err(format!(
                    "DISCONNECTED: SFTP rename timed out after {}s; outcome is unconfirmed, check source and destination before retrying",
                    timeout_duration.as_secs()
                ))
            }
        }
    }
}

/// Returns false only when the server-side mutation definitely did not start.
async fn try_remote_files_mutation(
    session: &Arc<Mutex<Handle<Client>>>,
    command: String,
    label: &str,
) -> Result<bool, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let channel = match tokio::time::timeout_at(deadline, async {
        session.lock().await.channel_open_session().await
    }).await {
        Ok(Ok(channel)) => channel,
        _ => return Ok(false), // No exec was submitted; fallback is safe.
    };
    tokio::time::timeout_at(deadline, channel.exec(true, command)).await
        .map_err(|_| format!("{label} submission outcome is unconfirmed; check destination before retrying"))?
        .map_err(|error| format!(
            "{label} submission outcome is unconfirmed; check destination before retrying: {error}"
        ))?;
    let messages = futures_util::stream::unfold(channel, |mut channel| async move {
        channel.wait().await.map(|message| (message, channel))
    });
    // A cancellation request is honored by the transfer owner after exec/CLOSE
    // confirms completion; dropping an accepted exec cannot prove it stopped.
    crate::transfers::remote_mutation_outcome(messages, deadline, label).await
}

#[tauri::command]
pub async fn fs_delete(
    connection_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if connection_id == "local" {
        return state.file_system.delete(&connection_id, &path).await
            .map_err(|error| error.to_string());
    }
    let (session, should_optimize) = {
        let connections = state.connections.lock().await;
        let connection = connections.get(&connection_id);
        (
            connection.and_then(|connection| connection.session.clone()),
            connection.and_then(|connection| connection.detected_os.as_deref())
                .is_some_and(|os| !os.eq_ignore_ascii_case("windows")),
        )
    };
    let server_attempt = async {
        if should_optimize {
            if let Some(session) = session {
                if let Some(command) = remote_remove_command_for_exec(&[path.clone()]) {
                    return try_remote_files_mutation(&session, command, "Delete").await;
                }
            }
        }
        Ok(false)
    };
    crate::transfers::mutation_with_safe_fallback(server_attempt, async {
        let sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
        match tokio::time::timeout(Duration::from_secs(10), state.file_system.delete_remote(&sftp, &path)).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => {
                if error.to_string().to_lowercase().contains("session closed") {
                    let mut connections = state.connections.lock().await;
                    if let Some(connection) = connections.get_mut(&connection_id) {
                        connection.sftp_session = None;
                    }
                }
                Err(format!("Delete failed; its outcome may be partial. Check destination before retrying: {error}"))
            }
            Err(_) => {
                let mut connections = state.connections.lock().await;
                if let Some(connection) = connections.get_mut(&connection_id) {
                    connection.sftp_session = None;
                }
                Err("DISCONNECTED: Delete timed out; outcome is unconfirmed. Check destination before retrying".to_string())
            }
        }
    }).await
}

#[derive(Debug, Serialize)]
pub struct BatchDeleteError {
    pub message: String,
    pub failed_paths: Vec<String>,
}

#[tauri::command]
pub async fn fs_delete_batch(
    connection_id: String,
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), BatchDeleteError> {
    if connection_id == "local" {
        let mut failed_paths = Vec::new();
        for path in &paths {
            if let Err(e) = state.file_system.delete(&connection_id, path).await {
                failed_paths.push(path.clone());
                eprintln!("[FS] Local delete failed for {}: {}", path, e);
            }
        }
        if !failed_paths.is_empty() {
            return Err(BatchDeleteError {
                message: "Some local files could not be deleted".to_string(),
                failed_paths,
            });
        }
        Ok(())
    } else {
        // Share the single-delete no-replay policy: only definite pre-execution
        // refusal permits SFTP fallback, never a partial or unknown outcome.
        let (session_opt, should_optimize) = {
            let connections = state.connections.lock().await;
            let conn = connections.get(&connection_id);
            (
                conn.and_then(|c| c.session.clone()),
                conn.and_then(|c| c.detected_os.as_deref())
                    .is_some_and(|os| !os.eq_ignore_ascii_case("windows")),
            )
        };

        let server_attempt = async {
            if should_optimize {
                if let Some(session) = session_opt {
                    if let Some(command) = remote_remove_command_for_exec(&paths) {
                        return try_remote_files_mutation(&session, command, "Delete").await;
                    }
                }
            }
            Ok(false)
        };

        // Each requested path is submitted at most once; even a failed response
        // can describe a deletion that already happened on the server.
        async fn perform_sftp_batch_delete(
            sftp: &Arc<russh_sftp::client::SftpSession>,
            paths: &[String],
            fs: &Arc<FileSystem>,
        ) -> Vec<String> {
            let mut failed = Vec::new();
            for path in paths {
                if let Err(e) = fs.delete_remote(sftp, path).await {
                    failed.push(path.clone());
                    eprintln!("[FS] SFTP delete failed for {}: {}", path, e);
                }
            }
            failed
        }

        // An SSH failure cannot identify a confirmed subset. SFTP can report
        // precisely which responses failed, without retrying those paths.
        let mut failed_paths = paths.clone();
        crate::transfers::mutation_with_safe_fallback(server_attempt, async {
            let sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
            failed_paths = perform_sftp_batch_delete(&sftp, &paths, &state.file_system).await;
            if failed_paths.is_empty() {
                Ok(())
            } else {
                Err("Some remote deletions failed or have an unconfirmed outcome. Check the folder before retrying".to_string())
            }
        })
        .await
        .map_err(|message| BatchDeleteError { message, failed_paths })
    }
}

#[tauri::command]
pub async fn fs_copy(
    connection_id: String,
    from: String,
    to: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    fs_copy_batch(connection_id, vec![CopyOperation { from, to }], state).await
}

#[tauri::command]
pub async fn fs_copy_batch(
    connection_id: String,
    operations: Vec<CopyOperation>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if operations.is_empty() {
        return Ok(());
    }
    // Files and whole-folder copies share the native staging owner. Only
    // top-level links retain their legacy policy; folders never bypass staging.
    let mut legacy_links = Vec::new();
    for operation in operations {
        let result = fs_transfer_file(state.app_handle.clone(), connection_id.clone(), operation.from.clone(),
            connection_id.clone(), operation.to.clone(), uuid::Uuid::new_v4().to_string(), Some(false), None, state.clone()).await
            .map_err(|error| match error.strip_prefix("TRANSFER_NOT_STARTED:") {
                // Earlier files in this batch may have succeeded. Never attach
                // a whole-batch unchanged-destination claim to one file's failure.
                Some(detail) => format!("Copy preparation failed for {}: {detail}", operation.from),
                None => error,
            })?;
        match result {
            None => legacy_links.push(operation),
            Some(receipt) if receipt.phase == crate::file_transfers::Phase::Completed => {}
            Some(receipt) => return Err(receipt.error.or(receipt.warning).unwrap_or_else(|| "File transfer requires recovery inspection".into())),
        }
    }
    let operations = legacy_links;
    if operations.is_empty() { return Ok(()); }
    if connection_id == "local" {
        for op in operations {
            state
                .file_system
                .copy(&connection_id, &op.from, &op.to)
                .await
                .map_err(|error| error.to_string())?;
        }
        return Ok(());
    }

    let (session, should_optimize) = {
        let connections = state.connections.lock().await;
        let connection = connections.get(&connection_id);
        (
            connection.and_then(|connection| connection.session.clone()),
            connection
                .and_then(|connection| connection.detected_os.as_deref())
                .is_some_and(|os| !os.eq_ignore_ascii_case("windows")),
        )
    };

    let server_attempt = async {
        if should_optimize {
            if let Some(session) = session {
                let command = operations
                    .iter()
                    .map(|op| remote_copy_command(&op.from, &op.to))
                    .collect::<Vec<_>>()
                    .join(" && ");
                return try_remote_files_mutation(&session, command, "Copy").await;
            }
        }
        Ok(false)
    };

    crate::transfers::mutation_with_safe_fallback(server_attempt, async {
        let sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
        for (index, operation) in operations.iter().enumerate() {
            // SFTP bounds individual requests itself. Do not time out an entire
            // recursive/streaming copy merely because it takes over ten seconds.
            match state.file_system.copy_remote(&sftp, &operation.from, &operation.to).await {
                Ok(()) => {}
                Err(error) => {
                    if error.to_string().to_lowercase().contains("session closed") {
                        let mut connections = state.connections.lock().await;
                        if let Some(connection) = connections.get_mut(&connection_id) {
                            connection.sftp_session = None;
                        }
                    }
                    return Err(format!("SFTP copy failed at item {index}; destination may be partial. Check it before retrying: {error}"));
                }
            }
        }
        Ok(())
    }).await
}

#[tauri::command]
pub async fn fs_rename_batch(
    connection_id: String,
    operations: Vec<CopyOperation>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if connection_id == "local" {
        for op in operations {
            state
                .file_system
                .rename(&connection_id, &op.from, &op.to)
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    } else {
        let sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
        for op in &operations {
            let res = tokio::time::timeout(
                Duration::from_secs(10),
                state.file_system.rename_remote(&sftp, &op.from, &op.to),
            )
            .await;

            let final_res = match res {
                Ok(inner) => inner.map_err(|e| e.to_string()),
                Err(_) => Err("DISCONNECTED: SFTP session timeout".to_string()),
            };

            if let Err(e) = final_res {
                if e.to_lowercase().contains("session closed") || e.contains("DISCONNECTED:") {
                    println!(
                        "[FS] SFTP session closed or timed out during batch rename, retrying..."
                    );
                    {
                        let mut connections = state.connections.lock().await;
                        if let Some(c) = connections.get_mut(&connection_id) {
                            c.sftp_session = None;
                        }
                    }
                    let sftp_fresh = get_sftp_or_reconnect(&state, &connection_id).await?;
                    // Resume from current op
                    for retry_op in operations.iter().skip_while(|oo| oo.from != op.from) {
                        let to_exists = tokio::time::timeout(
                            Duration::from_secs(10),
                            state.file_system.exists_remote(&sftp_fresh, &retry_op.to),
                        )
                        .await
                        .map_err(|_| "DISCONNECTED: SFTP session timeout".to_string())?
                        .map_err(|e| e.to_string())?;

                        let from_exists = tokio::time::timeout(
                            Duration::from_secs(10),
                            state.file_system.exists_remote(&sftp_fresh, &retry_op.from),
                        )
                        .await
                        .map_err(|_| "DISCONNECTED: SFTP session timeout".to_string())?
                        .map_err(|e| e.to_string())?;

                        if !from_exists {
                            continue;
                        }
                        if to_exists && from_exists {
                            return Err(format!(
                                "Batch rename conflict: both source and destination exist for '{}' -> '{}'",
                                retry_op.from, retry_op.to
                            ));
                        }

                        let retry_res = tokio::time::timeout(
                            Duration::from_secs(10),
                            state.file_system.rename_remote(
                                &sftp_fresh,
                                &retry_op.from,
                                &retry_op.to,
                            ),
                        )
                        .await;

                        match retry_res {
                            Ok(inner) => inner.map_err(|e| e.to_string())?,
                            Err(_) => return Err("DISCONNECTED: SFTP session timeout".to_string()),
                        };
                    }
                    return Ok(());
                }
                return Err(e);
            }
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn fs_exists(
    connection_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    if connection_id == "local" {
        state
            .file_system
            .exists(&connection_id, &path)
            .await
            .map_err(|e| e.to_string())
    } else {
        let sftp = get_sftp_or_reconnect(&state, &connection_id).await?;

        let res = tokio::time::timeout(
            Duration::from_secs(10),
            state.file_system.exists_remote(&sftp, &path),
        )
        .await;

        let final_res = match res {
            Ok(inner) => inner.map_err(|e| e.to_string()),
            Err(_) => Err("DISCONNECTED: SFTP session timeout".to_string()),
        };

        match final_res {
            Ok(res) => Ok(res),
            Err(e)
                if e.to_lowercase().contains("session closed") || e.contains("DISCONNECTED:") =>
            {
                println!("[FS] SFTP session closed or timed out during exists check, retrying...");
                {
                    let mut connections = state.connections.lock().await;
                    if let Some(c) = connections.get_mut(&connection_id) {
                        c.sftp_session = None;
                    }
                }
                let sftp = get_sftp_or_reconnect(&state, &connection_id).await?;

                let retry_res = tokio::time::timeout(
                    Duration::from_secs(10),
                    state.file_system.exists_remote(&sftp, &path),
                )
                .await;

                match retry_res {
                    Ok(inner) => inner.map_err(|e| e.to_string()),
                    Err(_) => Err("DISCONNECTED: SFTP session timeout".to_string()),
                }
            }
            Err(e) => Err(e),
        }
    }
}

/// No-follow metadata for conflict choices. Reuse read-only session preparation;
/// the eventual transfer still repeats native path/type checks before mutation.
#[tauri::command]
pub async fn fs_entry_kind(
    connection_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<Option<crate::file_transfers::endpoint::EntryKind>, String> {
    let (_, _, metadata) = prepare_file_transfer_endpoint(&state, &connection_id, &path, "entry").await?;
    Ok(metadata.map(|entry| entry.kind))
}

/// Capture a metadata editor's exact live endpoint without creating a second
/// connection owner. Mutation callers never reconnect or replay a closed channel.
async fn file_permission_endpoint(
    state: &AppState,
    id: &str,
    allow_connect: bool,
) -> Result<
    (Arc<crate::file_transfers::endpoint::Endpoint>, crate::file_permissions::Binding),
    String,
> {
    use crate::file_permissions::{Binding, Model};
    use crate::file_transfers::endpoint::Endpoint;
    let (endpoint, identity) = file_transfer_endpoint(state, id, allow_connect).await?;
    let binding = match endpoint.as_ref() {
        Endpoint::Local => Binding {
            identity,
            session: "local".into(),
            model: if cfg!(unix) { Model::Posix } else { Model::Windows },
        },
        Endpoint::Remote(sftp) => {
            let connections = state.connections.lock().await;
            let conn = connections.get(id).ok_or("Connection is no longer available")?;
            if !conn.sftp_session.as_ref().is_some_and(|current| Arc::ptr_eq(current, sftp)) {
                return Err("Connection changed. Refresh permissions.".into());
            }
            Binding {
                identity,
                session: conn.file_permission_session.clone(),
                model: crate::file_permissions::remote_model(conn.detected_os.as_deref()),
            }
        }
    };
    Ok((endpoint, binding))
}

/// Read-only local action hints, bounded to one directory and immediate child.
/// SFTP v3 has no equivalent effective-access query; never guess from mode/UID.
#[tauri::command]
pub async fn fs_permissions_access(
    connection_id: String,
    directory: String,
    target: Option<String>,
) -> Result<crate::file_permissions::access::Evidence, String> {
    if connection_id != "local" {
        return Err("Effective access inspection is unavailable over SFTP".into());
    }
    tokio::task::spawn_blocking(move || crate::file_permissions::access::inspect(directory, target))
        .await.map_err(|_| "Local access inspection was interrupted".to_string())?
}

/// Explicit Copy preflight only, not browsing-time permission inference. A short-
/// lived channel permits OPENDIR/CLOSE without the library's full directory scan.
/// Drop closes only the probe channel on failure/timeout; shared SFTP transfers
/// are untouched. No reconnect, shell, recursive walk or file data is requested.
#[tauri::command]
pub async fn fs_copy_access(
    connection_id: String,
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if connection_id == "local" || paths.is_empty() || paths.len() > 64 {
        return Err("Copy access checks require 1–64 SSH source paths".into());
    }
    for path in &paths {
        crate::file_permissions::validate_path(path)?;
    }
    let session = {
        let connections = state.connections.lock().await;
        connections
            .get(&connection_id)
            .and_then(|connection| connection.session.clone())
            .ok_or("Connection is not available. Reconnect before copying.")?
    };
    tokio::time::timeout(copy_access_timeout(paths.len() as u32), async {
        let raw = russh_sftp::client::RawSftpSession::new(
            open_sftp_stream(&session).await.map_err(|error| error.to_string())?,
        );
        raw.init().await.map_err(|error| error.to_string())?;
        for path in &paths {
            crate::file_permissions::access::check_remote_copy(&raw, path).await?;
        }
        let connections = state.connections.lock().await;
        if !connections
            .get(&connection_id)
            .and_then(|connection| connection.session.as_ref())
            .is_some_and(|current| Arc::ptr_eq(current, &session))
        {
            return Err("Connection changed while checking Copy access. Try again.".into());
        }
        Ok(())
    })
    .await
    .map_err(|_| "Copy access check timed out. Try again.".to_string())?
}

/// Register before starting so renderer cancellation cannot race registration.
#[tauri::command]
pub fn fs_folder_size_begin(id: String, connection_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.folder_sizes.begin(id, connection_id)
}

#[tauri::command]
pub fn fs_folder_size_cancel(id: String, state: State<'_, AppState>) {
    state.folder_sizes.cancel(&id);
}

/// Metadata only, with bounded admission and captured-transport ownership. A
/// fixed ordinary-account Linux program avoids per-directory SSH round trips;
/// unsupported servers retain incremental SFTP. Neither path reads contents.
#[tauri::command]
pub async fn fs_folder_size_calculate(
    id: String, connection_id: String, path: String, state: State<'_, AppState>,
) -> Result<crate::folder_sizes::Report, String> {
    crate::file_permissions::validate_path(&path)?;
    let lease = state.folder_sizes.claim(&id, &connection_id)?;
    // Keep admission through explicit exec cleanup, including cancellation.
    let _permits = lease.run(async {
        tokio::time::timeout(Duration::from_secs(15), lease.permits()).await
            .map_err(|_| "Folder-size scan timed out during admission")?
    }).await?;
    let mut owned_channel = None;
    let result = lease.run(async {
        // Setup/admission and traversal have separate, non-overlapping budgets.
        // Keep permits until the owned channel and actual scan future have stopped.
        let setup = async {
            let (session, try_exec) = if connection_id == "local" { (None, false) } else {
                let connections = state.connections.lock().await;
                let connection = connections.get(&connection_id)
                    .ok_or("Connection is unavailable. Reconnect before calculating sizes.")?;
                (Some(connection.session.clone().ok_or("Connection is unavailable. Reconnect before calculating sizes.")?),
                    crate::folder_sizes::remote::supports_kernel(connection.detected_kernel_os.as_deref()))
            };
            let endpoint = if let Some(session) = &session {
                let stream = open_sftp_stream(session).await.map_err(|e| e.to_string())?;
                let raw = russh_sftp::client::RawSftpSession::new(crate::folder_sizes::PacketLimited::new(stream));
                raw.set_timeout(5);
                raw.init().await.map_err(|e| e.to_string())?;
                crate::folder_sizes::Endpoint::Remote(raw)
            } else { crate::folder_sizes::Endpoint::Local };
            Ok::<_, String>((endpoint, session, try_exec))
        };
        let (endpoint, session, try_exec) = tokio::time::timeout(Duration::from_secs(15), setup)
            .await.map_err(|_| "Folder-size scan timed out during admission or setup. Try again.")??;
        let mut fast_report = None;
        if let (true, Some(session), crate::folder_sizes::Endpoint::Remote(raw)) = (try_exec, &session, &endpoint) {
            let support = &state.folder_sizes.remote_support;
            if support.allows(session) {
                let nonce = uuid::Uuid::new_v4().simple().to_string();
                if let Ok(Some(request)) = tokio::time::timeout(Duration::from_secs(5),
                    crate::folder_sizes::remote::request(raw, &path, &nonce)).await {
                    // Provisional block also covers a cancellation or unconfirmed
                    // open. Never repeat that request for all queued siblings.
                    if support.block(session) {
                        fast_report = crate::folder_sizes::remote::calculate(session, &request, &nonce, &mut owned_channel).await?;
                        if fast_report.is_some() { support.allow(session); }
                    }
                    // Confirmed unsupported/mismatched programs have exited.
                    // Keep the channel owner here until uncancellable cleanup.
                }
            }
        }
        let report = match fast_report {
            Some(report) => report,
            None => crate::folder_sizes::calculate(&endpoint, &path).await,
        };
        if let Some(session) = session {
            if !state.connections.lock().await.get(&connection_id).and_then(|c| c.session.as_ref())
                .is_some_and(|current| Arc::ptr_eq(current, &session)) {
                return Err("Connection changed during the folder-size scan. Calculate again.".to_string());
            }
        }
        Ok(report)
    }).await;
    crate::folder_sizes::remote::close(owned_channel).await;
    result
}

/// Preserve setup/connection allowance while budgeting the sequential source
/// checks. The command validates the count (1–64) before calculating this bound.
fn copy_access_timeout(path_count: u32) -> Duration {
    Duration::from_secs(30 + 3 * u64::from(path_count))
}

/// Read one selected item; listing display strings never authorize mode edits.
#[tauri::command]
pub async fn fs_permissions_read(
    connection_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<crate::file_permissions::Metadata, String> {
    crate::file_permissions::validate_path(&path)?;
    let initial = file_permission_endpoint(&state, &connection_id, true).await?;
    let (binding, metadata) = if connection_id == "local" {
        let metadata = crate::file_permissions::inspect(initial.0.as_ref(), initial.1.clone(), &path).await?;
        (initial.1, metadata)
    } else {
        let ((_, binding), metadata) = crate::sftp_read::read_with_recovery(
            initial,
            |(endpoint, binding)| {
                let path = &path;
                async move { crate::file_permissions::inspect(endpoint.as_ref(), binding, path).await }
            },
            |(failed, previous)| {
                let state = &state;
                let id = connection_id.as_str();
                async move {
                if let crate::file_transfers::endpoint::Endpoint::Remote(failed) = failed.as_ref() {
                    let mut connections = state.connections.lock().await;
                    let conn = connections.get_mut(id).ok_or("Connection was disconnected while reading permissions")?;
                    crate::sftp_read::invalidate_if_current(&mut conn.sftp_session, failed);
                }
                let fresh = file_permission_endpoint(state, id, true).await?;
                if fresh.1.identity != previous.identity {
                    return Err("Connection identity changed while reading permissions".into());
                }
                Ok(fresh)
                }
            },
        ).await?;
        (binding, metadata)
    };
    let (_, current) = file_permission_endpoint(&state, &connection_id, false).await?;
    if current != binding {
        return Err("Connection changed. Refresh permissions.".into());
    }
    Ok(metadata)
}

/// Explicit Windows-owned UI; never return a chmod/ACL mutation acknowledgement.
/// The main window owns native UI and Windows owns its authorization decisions.
#[tauri::command]
pub async fn fs_permissions_open_system_editor(
    window: tauri::WebviewWindow,
    connection_id: String,
    expected: crate::file_permissions::Metadata,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if window.label() != "main" || connection_id != "local" {
        return Err("Windows permissions are only available from the local host window".into());
    }
    crate::file_permissions::validate_path(&expected.path)?;
    #[cfg(not(windows))]
    { let _ = (expected, state); Err("The Windows permission editor is not available on this platform".into()) }
    #[cfg(windows)]
    {
        let path = expected.path.clone();
        if !tokio::task::spawn_blocking(move || crate::file_permissions::system_editor::supported(&path))
            .await.map_err(|_| "Windows target inspection was interrupted".to_string())? {
            return Err("Windows permissions require a supported local file or folder".into());
        }
        let (endpoint, binding) = file_permission_endpoint(&state, &connection_id, false).await?;
        let lease = state.file_transfers.reserve_metadata_change(endpoint.as_ref(), &binding.identity, &expected.path).await?;
        crate::file_permissions::system_editor::prepare(endpoint.as_ref(), binding, &expected).await?;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let owner = window.clone();
        window.run_on_main_thread(move || {
            let _lease = lease;
            let result = owner.hwnd().map_err(|error| error.to_string())
                .and_then(|hwnd| crate::file_permissions::system_editor::open(&expected.path, hwnd.0));
            let _ = sender.send(result);
        }).map_err(|error| error.to_string())?;
        receiver.await.map_err(|_| "Windows permission editor invocation was interrupted".to_string())?
    }
}

/// Apply one ordinary-mode change under existing native mutation admission.
/// Neither session loss nor an uncertain SETSTAT acknowledgement triggers replay.
#[tauri::command]
pub async fn fs_permissions_apply(
    connection_id: String,
    expected: crate::file_permissions::Metadata,
    set_bits: u32,
    clear_bits: u32,
    state: State<'_, AppState>,
) -> Result<crate::file_permissions::Outcome, String> {
    crate::file_permissions::changed_mode(0, set_bits, clear_bits)?;
    crate::file_permissions::validate_path(&expected.path)?;
    let (endpoint, binding) = file_permission_endpoint(&state, &connection_id, false).await?;
    if binding != expected.binding {
        return Err("Connection changed. Refresh permissions before editing.".into());
    }
    let _lease = state.file_transfers
        .reserve_metadata_change(endpoint.as_ref(), &binding.identity, &expected.path).await?;
    let captured = binding.clone();
    crate::file_permissions::apply(
        endpoint.as_ref(), binding, &expected, set_bits, clear_bits,
        || async {
            let (_, current) = file_permission_endpoint(&state, &connection_id, false).await?;
            if current != captured {
                return Err("Connection changed. Refresh permissions before editing.".into());
            }
            Ok(())
        },
    ).await
}

/// Explicit no-helper administrator review. Capture the existing verified SSH
/// transport, SFTP identity and generation; this path never connects/reconnects.
#[tauri::command]
pub async fn fs_permissions_admin_start(
    window: tauri::WebviewWindow,
    connection_id: String,
    expected: crate::file_permissions::Metadata,
    state: State<'_, AppState>,
) -> Result<crate::file_permissions::elevation::Reply, String> {
    use crate::file_permissions::{elevation::Guard, Model};
    if window.label() != "main" || connection_id == "local" || expected.binding.model != Model::Posix {
        return Err("Administrator review requires the main window and a live POSIX SSH connection".into());
    }
    crate::file_permissions::validate_path(&expected.path)?;
    if !expected.path.starts_with('/') { return Err("Administrator review requires an absolute SSH host path".into()); }
    let (endpoint, binding) = file_permission_endpoint(&state, &connection_id, false).await?;
    if binding != expected.binding { return Err("Connection changed. Refresh permissions before administrator review.".into()); }
    let (session, generation) = {
        let connections = state.connections.lock().await;
        let connection = connections.get(&connection_id).ok_or("Connection is no longer available")?;
        (connection.session.clone().ok_or("SSH session is closed")?, connection.reconnect_generation)
    };
    let captured = binding.clone();
    let context = state.inner().clone();
    let id = connection_id.clone();
    let transport = session.clone();
    let guard: Guard = Arc::new(move || {
        let (context, id, captured, transport) = (context.clone(), id.clone(), captured.clone(), transport.clone());
        Box::pin(async move {
            let (_, current) = file_permission_endpoint(&context, &id, false).await?;
            let connections = context.connections.lock().await;
            let connection = connections.get(&id).ok_or("Connection was disconnected")?;
            if current != captured || connection.reconnect_generation != generation
                || !connection.session.as_ref().is_some_and(|session| Arc::ptr_eq(session, &transport)) {
                return Err("Connection changed. Administrator review was not reused. Refresh permissions.".into());
            }
            Ok(())
        })
    });
    guard().await?;
    let lease = state.file_transfers.reserve_metadata_change(endpoint.as_ref(), &binding.identity, &expected.path).await?;
    state.permission_elevation.start(connection_id, binding, expected.path, session, guard, lease).await
}

/// Password input is transient, main-window-only and never sent to generic exec,
/// credential storage, events or logs. Sudo, not Zync, decides authorization.
#[tauri::command]
pub async fn fs_permissions_admin_authenticate(
    window: tauri::WebviewWindow,
    challenge_id: String,
    password: String,
    state: State<'_, AppState>,
) -> Result<crate::file_permissions::elevation::Reply, String> {
    let password = zeroize::Zeroizing::new(password);
    if window.label() != "main" { return Err("Administrator review is only available in the main window".into()); }
    state.permission_elevation.authenticate(&challenge_id, password).await
}

#[tauri::command]
pub async fn fs_permissions_admin_apply(
    window: tauri::WebviewWindow, challenge_id: String, review_token: String, set_bits: u32, clear_bits: u32,
    state: State<'_, AppState>,
) -> Result<crate::file_permissions::elevation::Reply, String> {
    if window.label() != "main" { return Err("Administrator review is only available in the main window".into()); }
    state.permission_elevation.apply(&challenge_id, review_token, set_bits, clear_bits).await
}

#[tauri::command]
pub async fn fs_permissions_admin_cancel(
    window: tauri::WebviewWindow, challenge_id: String, state: State<'_, AppState>,
) -> Result<(), String> {
    if window.label() != "main" { return Err("Administrator review is only available in the main window".into()); }
    state.permission_elevation.cancel(&challenge_id);
    Ok(())
}

#[tauri::command]
pub async fn window_is_maximized(app: AppHandle) -> bool {
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };

    let maximized = window.is_maximized().unwrap_or(false);
    let fullscreen = window.is_fullscreen().unwrap_or(false);
    maximized || fullscreen
}

#[tauri::command]
pub async fn window_maximize(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;

    #[cfg(target_os = "macos")]
    {
        let fullscreen = window.is_fullscreen().map_err(|e| e.to_string())?;
        window
            .set_fullscreen(!fullscreen)
            .map_err(|e| e.to_string())?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        if window.is_maximized().map_err(|e| e.to_string())? {
            window.unmaximize().map_err(|e| e.to_string())?;
        } else {
            window.maximize().map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn window_minimize(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn window_close(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ssh_exec(
    connection_id: String,
    command: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if connection_id == "local" {
        // Execute local command
        let (shell, arg) = if cfg!(target_os = "windows") {
            ("powershell", "-Command")
        } else {
            ("sh", "-c")
        };

        let output = std::process::Command::new(shell)
            .arg(arg)
            .arg(&command)
            .output()
            .map_err(|e| format!("Failed to execute local command: {}", e))?;

        if output.status.success() {
            String::from_utf8(output.stdout).map_err(|e| format!("Invalid UTF-8 output: {}", e))
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("Command failed: {}", stderr))
        }
    } else {
        ssh_exec_remote(&state.connections, &connection_id, &command).await
    }
}

pub(crate) async fn ssh_exec_remote(
    connections: &Mutex<HashMap<String, ConnectionHandle>>,
    connection_id: &str,
    command: &str,
) -> Result<String, String> {
    let session = {
        let connections = connections.lock().await;
        connections
            .get(connection_id)
            .and_then(|connection| connection.session.clone())
            .ok_or_else(|| "Connection not found".to_string())?
    };

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let exit_status = crate::ssh_command::run(
        session,
        command,
        None,
        crate::ssh_command::DEFAULT_COMMAND_TIMEOUT,
        |stream, data| {
            if stream == 0 {
                stdout.extend_from_slice(data);
            } else {
                stderr.extend_from_slice(data);
            }
        },
    )
    .await?
    .unwrap_or(0);

    if exit_status == 0 {
        String::from_utf8(stdout).map_err(|error| error.to_string())
    } else {
        Err(format!(
            "Remote command failed (Exit {}): {}",
            exit_status,
            String::from_utf8_lossy(&stderr)
        ))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionLatencyPayload {
    pub connection_id: String,
    pub rtt_ms: u64,
}

#[tauri::command]
pub async fn ssh_connection_latency(
    id: String,
    state: State<'_, AppState>,
) -> Result<ConnectionLatencyPayload, String> {
    if id == "local" {
        return Err("Local workspace has no SSH latency".to_string());
    }

    let session = {
        let connections = state.connections.lock().await;
        let conn = connections
            .get(&id)
            .ok_or_else(|| "Connection not found".to_string())?;
        conn.session
            .clone()
            .ok_or_else(|| "Connection is not live".to_string())?
    };

    let rtt_ms = {
        let handle = session.lock().await;
        crate::connection_latency::measure_session_rtt_ms(&handle).await?
    };

    Ok(ConnectionLatencyPayload {
        connection_id: id,
        rtt_ms,
    })
}

#[tauri::command]
pub async fn ssh_import_config(
    app: AppHandle,
) -> Result<Vec<crate::ssh_config::ParsedSshConnection>, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let config_path = home.join(".ssh/config");

    // println!("[SSH] Importing config from: {:?}", config_path);

    let connections = crate::ssh_config::parse_config(&config_path).map_err(|e| e.to_string())?;
    inspect_imported_connection_keys_blocking(connections).await
}

fn inspect_imported_connection_keys(connections: &mut [crate::ssh_config::ParsedSshConnection]) {
    for connection in connections {
        let Some(path) = connection.private_key_path.as_deref() else {
            continue;
        };
        let status = read_private_key_file(path)
            .ok()
            .map(|content| inspect_private_key_content(content.expose_secret(), None).status)
            .unwrap_or_else(|| "unavailable".to_string());
        connection.private_key_status = Some(status);
    }
}

async fn inspect_imported_connection_keys_blocking(
    mut connections: Vec<crate::ssh_config::ParsedSshConnection>,
) -> Result<Vec<crate::ssh_config::ParsedSshConnection>, String> {
    tokio::task::spawn_blocking(move || {
        inspect_imported_connection_keys(&mut connections);
        connections
    })
    .await
    .map_err(|error| format!("SSH import key inspection task failed: {error}"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshImportSourceRequest {
    pub source_type: String,
    pub path: Option<String>,
    pub content: Option<String>,
}

#[tauri::command]
pub async fn ssh_import_config_from_file(
    path: String,
) -> Result<Vec<crate::ssh_config::ParsedSshConnection>, String> {
    let normalized = path.trim();
    if normalized.is_empty() {
        return Err("Select an SSH config file path first.".to_string());
    }

    let config_path = std::path::Path::new(normalized);
    if !config_path.exists() {
        return Err("SSH config file not found.".to_string());
    }
    if !config_path.is_file() {
        return Err("Selected SSH config path is not a file.".to_string());
    }
    let metadata = std::fs::metadata(config_path)
        .map_err(|e| format!("Cannot stat SSH config file: {}", e))?;
    if metadata.len() > MAX_IMPORT_TEXT_BYTES as u64 {
        return Err("SSH config file too large (max 1 MiB).".to_string());
    }
    let connections = crate::ssh_config::parse_config(config_path).map_err(|e| e.to_string())?;
    inspect_imported_connection_keys_blocking(connections).await
}

#[tauri::command]
pub async fn ssh_import_config_from_text(
    content: String,
) -> Result<Vec<crate::ssh_config::ParsedSshConnection>, String> {
    if content.trim().is_empty() {
        return Ok(vec![]);
    }

    if content.len() > MAX_IMPORT_TEXT_BYTES {
        return Err("Pasted SSH config is too large (max 1 MiB).".to_string());
    }

    let connections = crate::ssh_config::parse_config_text(&content).map_err(|e| e.to_string())?;
    inspect_imported_connection_keys_blocking(connections).await
}

#[tauri::command]
pub async fn ssh_import_config_by_source(
    app: AppHandle,
    request: SshImportSourceRequest,
) -> Result<Vec<crate::ssh_config::ParsedSshConnection>, String> {
    match request.source_type.as_str() {
        "default_ssh" => ssh_import_config(app).await,
        "file" => {
            let path = request.path.as_deref().unwrap_or("").trim().to_string();
            if path.is_empty() {
                return Err("Select an SSH config file path first.".to_string());
            }
            ssh_import_config_from_file(path).await
        }
        "text" => {
            let content = request.content.as_deref().unwrap_or("").to_string();
            if content.trim().is_empty() {
                return Err("Paste SSH config text first.".to_string());
            }

            if content.len() > MAX_IMPORT_TEXT_BYTES {
                return Err("Pasted SSH config is too large (max 1 MiB).".to_string());
            }
            ssh_import_config_from_text(content).await
        }
        _ => Err("Unsupported SSH import source.".to_string()),
    }
}

/// Helper to internalize a single key file
fn internalize_key(path: &str, data_dir: &std::path::Path) -> Option<String> {
    if path.is_empty() {
        return None;
    }

    let src_path = std::path::Path::new(path);

    // Canonicalize paths to ensure robust comparison
    let data_dir_canonical = data_dir
        .canonicalize()
        .unwrap_or_else(|_| data_dir.to_path_buf());
    let src_path_canonical = src_path
        .canonicalize()
        .unwrap_or_else(|_| src_path.to_path_buf());

    // If already in data dir, return as is (but maybe canonicalized)
    if src_path_canonical.starts_with(&data_dir_canonical) {
        return None;
    }

    if !src_path.exists() || !src_path.is_file() {
        // If we can't find it, we can't copy it.
        return None;
    }

    let keys_dir = data_dir.join("keys");
    if !keys_dir.exists() {
        let _ = std::fs::create_dir_all(&keys_dir);
    }

    let filename = src_path.file_name().unwrap_or_default().to_string_lossy();

    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    let hash = hasher.finish();
    let dest_filename = format!("{:x}_{}", hash, filename);
    let dest_path = keys_dir.join(dest_filename);

    if dest_path.exists() {
        // Already exists? Use it.
        return Some(dest_path.to_string_lossy().to_string());
    }

    match std::fs::copy(src_path, &dest_path) {
        Ok(_) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(metadata) = std::fs::metadata(&dest_path) {
                    let mut perms = metadata.permissions();
                    perms.set_mode(0o600);
                    let _ = std::fs::set_permissions(&dest_path, perms);
                }
            }
            Some(dest_path.to_string_lossy().to_string())
        }
        Err(e) => {
            eprintln!(
                "[SSH Internalize] Failed to copy key from {:?} to {:?}: {}",
                src_path, dest_path, e
            );
            None
        }
    }
}

#[tauri::command]
pub async fn ssh_internalize_connections(
    app: AppHandle,
    connections: Vec<crate::ssh_config::ParsedSshConnection>,
) -> Result<Vec<crate::ssh_config::ParsedSshConnection>, String> {
    let data_dir = get_data_dir(&app);
    let mut updated_connections = connections.clone();
    let mut internalized_count = 0;

    for conn in &mut updated_connections {
        if let Some(path) = &conn.private_key_path {
            if let Some(new_path) = internalize_key(path, &data_dir) {
                conn.private_key_path = Some(new_path);
                internalized_count += 1;
            }
        }
    }

    #[cfg(debug_assertions)]
    println!(
        "[SSH Internalize] Internalized keys for {} connections",
        internalized_count
    );
    Ok(updated_connections)
}

// Snippets Commands
use crate::snippets::Snippet;

#[tauri::command]
pub async fn snippets_list(state: State<'_, AppState>) -> Result<Vec<Snippet>, String> {
    state.snippets_manager.list().await
}

#[tauri::command]
pub async fn snippets_save(snippet: Snippet, state: State<'_, AppState>) -> Result<(), String> {
    state.snippets_manager.save(snippet).await
}

#[tauri::command]
pub async fn snippets_delete(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.snippets_manager.delete(id).await
}

#[tauri::command]
pub async fn settings_get(app: AppHandle) -> Result<serde_json::Value, String> {
    read_effective_settings(&app)
}

#[tauri::command]
pub async fn settings_set(app: AppHandle, settings: serde_json::Value) -> Result<(), String> {
    persist_settings_patch(&app, settings, None).await
}

/// UI theme/accent edits compare against import-owned fields; restore callers retain their existing contract.
#[tauri::command]
pub async fn settings_theme_set(
    app: AppHandle,
    settings: Value,
    expected: Value,
) -> Result<(), String> {
    persist_settings_patch(&app, settings, Some(&expected)).await
}

async fn persist_settings_patch(
    app: &AppHandle,
    settings: Value,
    expected_theme: Option<&Value>,
) -> Result<(), String> {
    let _mutation_guard = SETTINGS_MUTATION_LOCK.lock().await;
    let current = read_effective_settings(app)?;
    if expected_theme.is_some() {
        crate::theme_settings::validate_theme_patch(&current, &settings, expected_theme)?;
    }
    crate::navigation_settings::validate_patch(&current, &settings)?;
    // Retired preset metadata remains opaque and cannot be replaced by stale clients.
    crate::preference_settings::validate_preserved_patch(&current, &settings, "workspaceLayoutPresets")?;
    crate::element_color_settings::validate_managed_patch(&current, &settings)?;
    crate::theme_settings::validate_managed_patch(&current, &settings)?;
    crate::chrome_action_settings::validate_managed_patch(&current, &settings)?;
    let current_data_path = data_path_from_settings(&current);
    let merged = ensure_object_settings(merge_json_values(current, settings))?;
    let next_data_path = data_path_from_settings(&merged);
    persist_settings_json(app, &merged)?;
    if current_data_path != next_data_path {
        clear_data_dir_cache();
    }
    Ok(())
}

/// Replace only global navigation chrome and host tab placement; never session geometry or resources.
#[tauri::command]
pub async fn settings_navigation_save(
    app: AppHandle,
    expected: serde_json::Value,
    value: serde_json::Value,
) -> Result<(), String> {
    let _mutation_guard = SETTINGS_MUTATION_LOCK.lock().await;
    let current = read_effective_settings(&app)?;
    if let Some(next) = crate::navigation_settings::replacement(&current, &expected, &value)? {
        persist_settings_json(&app, &next)?;
    }
    Ok(())
}

/// Replace only semantic element colors. No CSS, plugin or resource operations are exposed.
#[tauri::command]
pub async fn settings_element_colors_save(
    app: AppHandle,
    expected: serde_json::Value,
    value: serde_json::Value,
) -> Result<(), String> {
    let _mutation_guard = SETTINGS_MUTATION_LOCK.lock().await;
    let current = read_effective_settings(&app)?;
    if let Some(next) = crate::element_color_settings::replacement(&current, &expected, &value)? {
        persist_settings_json(&app, &next)?;
    }
    Ok(())
}

/// Apply a validated portable theme in one atomic save after comparing affected fields.
#[tauri::command]
pub async fn settings_theme_import(
    app: AppHandle,
    expected: Value,
    value: Value,
) -> Result<(), String> {
    let _mutation_guard = SETTINGS_MUTATION_LOCK.lock().await;
    let current = read_effective_settings(&app)?;
    if let Some(next) = crate::theme_settings::replacement(&current, &expected, &value)? {
        persist_settings_json(&app, &next)?;
    }
    Ok(())
}

/// Replace only host toolbar/status presentation under the existing settings mutation lock.
/// The fixed codec rejects attempts to hide mandatory indicators or create new commands.
#[tauri::command]
pub async fn settings_chrome_actions_save(
    app: AppHandle,
    expected: serde_json::Value,
    value: serde_json::Value,
) -> Result<(), String> {
    let _mutation_guard = SETTINGS_MUTATION_LOCK.lock().await;
    let current = read_effective_settings(&app)?;
    if let Some(next) = crate::chrome_action_settings::replacement(&current, &expected, &value)? {
        persist_settings_json(&app, &next)?;
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct SettingsFilePayload {
    pub path: String,
    pub content: String,
    #[serde(rename = "modifiedMs")]
    pub modified_ms: Option<u64>,
}

#[tauri::command]
pub async fn settings_get_path(app: AppHandle) -> Result<String, String> {
    Ok(get_native_settings_path(&app)?
        .to_string_lossy()
        .to_string())
}

/// Read raw settings.json content for in-app editing surfaces.
#[tauri::command]
pub async fn settings_read_raw(app: AppHandle) -> Result<SettingsFilePayload, String> {
    let path = get_native_settings_path(&app)?;
    let content = if path.exists() {
        std::fs::read_to_string(&path).map_err(|e| e.to_string())?
    } else {
        let migrated = read_effective_settings(&app)?;
        if migrated.is_object() && !migrated.as_object().map(|o| o.is_empty()).unwrap_or(true) {
            format!(
                "{}\n",
                serde_json::to_string_pretty(&migrated).map_err(|e| e.to_string())?
            )
        } else {
            "{}\n".to_string()
        }
    };
    let modified_ms = settings_mtime_ms(&path);
    Ok(SettingsFilePayload {
        path: path.to_string_lossy().to_string(),
        content,
        modified_ms,
    })
}

/// Save raw settings.json content from in-app editor with optimistic concurrency.
/// Fails if file changed externally since last read (`expected_modified_ms` mismatch).
#[tauri::command]
pub async fn settings_write_raw(
    app: AppHandle,
    content: String,
    expected_modified_ms: Option<u64>,
) -> Result<SettingsFilePayload, String> {
    let _mutation_guard = SETTINGS_MUTATION_LOCK.lock().await;
    let settings_path = get_native_settings_path(&app)?;
    // Preserve real I/O errors; only treat missing file as "no previous content".
    let current_raw = match std::fs::read_to_string(&settings_path) {
        Ok(content) => Some(content),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => {
            return Err(format!(
                "Failed to read existing settings.json before overwrite: {}",
                err
            ));
        }
    };
    let current_data_path = current_raw.as_deref().and_then(data_path_from_raw_json);

    let actual = settings_mtime_ms(&settings_path);
    if actual != expected_modified_ms {
        return Err(settings_command_error(
            SETTINGS_CHANGED_ON_DISK_ERROR_CODE,
            "settings.json changed on disk. Reload before saving.",
        ));
    }

    let parsed: Value = serde_json::from_str(&content)
        .map_err(|e| format!("Invalid JSON in settings.json: {}", e))?;
    let validated = ensure_object_settings(parsed)?;
    validate_settings_schema(&validated)?;

    // Under mutation lock: re-read immediately before LKG + overwrite so an external
    // change after the first read cannot be clobbered or promoted as last-known-good.
    let latest_raw = match std::fs::read_to_string(&settings_path) {
        Ok(content) => Some(content),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => {
            return Err(format!(
                "Failed to re-read settings.json before overwrite: {}",
                err
            ));
        }
    };
    if latest_raw.as_deref() != current_raw.as_deref()
        || settings_mtime_ms(&settings_path) != expected_modified_ms
    {
        return Err(settings_command_error(
            SETTINGS_CHANGED_ON_DISK_ERROR_CODE,
            "settings.json changed on disk. Reload before saving.",
        ));
    }

    // Promote current file to last-known-good before overwrite (same as managed settings_set).
    let backup_path = get_last_known_good_settings_path(&app)?;
    if let Some(existing) = current_raw.as_ref() {
        match serde_json::from_str::<Value>(existing) {
            Ok(existing_parsed) => match ensure_object_settings(existing_parsed) {
                Ok(valid_existing) => match validate_settings_schema(&valid_existing) {
                    Ok(()) => {
                        write_atomic_file(&backup_path, existing)?;
                    }
                    Err(error) => {
                        eprintln!(
                            "[settings] Skipping last-known-good backup (raw write) due to schema validation failure: {}",
                            error
                        );
                    }
                },
                Err(error) => {
                    eprintln!(
                        "[settings] Skipping last-known-good backup (raw write) due to invalid existing settings: {}",
                        error
                    );
                }
            },
            Err(error) => {
                eprintln!(
                    "[settings] Skipping last-known-good backup (raw write) due to invalid JSON: {}",
                    error
                );
            }
        }
    }

    write_atomic_file(&settings_path, &content)?;
    let next_data_path = data_path_from_raw_json(&content);
    if current_data_path != next_data_path {
        clear_data_dir_cache();
    }

    let saved_content = std::fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
    let modified_ms = settings_mtime_ms(&settings_path);
    Ok(SettingsFilePayload {
        path: settings_path.to_string_lossy().to_string(),
        content: saved_content,
        modified_ms,
    })
}

/// Restore settings.json from the last-known-good backup.
#[tauri::command]
pub async fn settings_restore_last_known_good(
    app: AppHandle,
) -> Result<SettingsFilePayload, String> {
    let _mutation_guard = SETTINGS_MUTATION_LOCK.lock().await;
    let settings_path = get_native_settings_path(&app)?;
    let current_raw = if settings_path.exists() {
        std::fs::read_to_string(&settings_path).ok()
    } else {
        None
    };
    let current_data_path = current_raw.as_deref().and_then(data_path_from_raw_json);
    let backup_path = get_last_known_good_settings_path(&app)?;
    if !backup_path.exists() {
        return Err("No last-known-good settings backup found.".to_string());
    }

    let backup_content = std::fs::read_to_string(&backup_path).map_err(|e| e.to_string())?;
    let parsed_backup = serde_json::from_str::<Value>(&backup_content)
        .map_err(|e| format!("Invalid JSON in last-known-good backup: {}", e))?;
    let validated_backup = ensure_object_settings(parsed_backup)?;
    validate_settings_schema(&validated_backup)?;
    write_atomic_file(&settings_path, &backup_content)?;
    let next_data_path = data_path_from_raw_json(&backup_content);
    if current_data_path != next_data_path {
        clear_data_dir_cache();
    }

    let saved_content = std::fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
    let modified_ms = settings_mtime_ms(&settings_path);
    Ok(SettingsFilePayload {
        path: settings_path.to_string_lossy().to_string(),
        content: saved_content,
        modified_ms,
    })
}

#[derive(Clone, serde::Serialize)]
struct TransferProgress {
    id: String,
    transferred: u64,
    total: u64,
}

#[derive(Clone, serde::Serialize)]
struct TransferSuccess {
    id: String,
    destination_connection_id: String,
}

#[derive(Clone, serde::Serialize)]
struct TransferError {
    id: String,
    error: String,
}

fn emit_transfer_outcome(
    app: &AppHandle,
    id: &str,
    destination_connection_id: &str,
    result: &Result<(), String>,
) {
    match result {
        Ok(()) => {
            let _ = app.emit(
                "transfer-success",
                TransferSuccess {
                    id: id.to_string(),
                    destination_connection_id: destination_connection_id.to_string(),
                },
            );
        }
        Err(error) => {
            let _ = app.emit(
                "transfer-error",
                TransferError {
                    id: id.to_string(),
                    error: error.clone(),
                },
            );
        }
    }
}


// Helper for recursive upload
// Now takes AppHandle and transfer_id for emitting events
fn upload_recursive<'a>(
    sftp: &'a russh_sftp::client::SftpSession,
    local_path: &'a std::path::Path,
    remote_path: &'a str,
    app: &'a AppHandle,
    transfer_id: &'a str,
    total_size: &'a mut u64,
    transferred: &'a mut u64,
    cancel_token: &'a std::sync::atomic::AtomicBool,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        crate::transfers::check_cancelled(cancel_token)?;
        if local_path.is_dir() {
            crate::fs::ensure_remote_transfer_directory(sftp, remote_path).await?;

            for entry in std::fs::read_dir(local_path).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                let new_remote = if remote_path.ends_with('/') {
                    format!("{}{}", remote_path, name)
                } else {
                    format!("{}/{}", remote_path, name)
                };

                upload_recursive(
                    sftp,
                    &path,
                    &new_remote,
                    app,
                    transfer_id,
                    total_size,
                    transferred,
                    cancel_token,
                )
                .await?;
            }
        } else {
            // Upload file with chunked progress
            use russh_sftp::protocol::OpenFlags;
            use tokio::io::AsyncWriteExt;

            // Open remote file
            let mut remote_file = sftp
                .open_with_flags(
                    remote_path,
                    OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
                )
                .await
                .map_err(|e| format!("Failed to open remote file '{}': {}", remote_path, e))?;

            // Full-Duplex Channel (Pipes local reads to remote writes)
            let (tx, mut rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, String>>(4);
            let local_path_buf = local_path.to_path_buf();

            // Spawn Disk Reader Task
            let reader = tokio::spawn(async move {
                use tokio::io::AsyncReadExt;
                let mut file = match tokio::fs::File::open(local_path_buf).await {
                    Ok(f) => f,
                    Err(e) => {
                        let _ = tx.send(Err(format!("Local open failed: {}", e))).await;
                        return;
                    }
                };
                loop {
                    let mut buffer = vec![0u8; 4 * 1024 * 1024]; // 4MB Chunk
                    match file.read(&mut buffer).await {
                        Ok(0) => break,
                        Ok(n) => {
                            buffer.truncate(n);
                            if tx.send(Ok(buffer)).await.is_err() {
                                break;
                            }
                        }
                        Err(e) => {
                            let _ = tx.send(Err(format!("Local read failed: {}", e))).await;
                            break;
                        }
                    }
                }
            });

            let mut last_emit = std::time::Instant::now();

            // Finish the in-flight write before cancellation; never abort/replay writes.
            let copy_result = async {
                while let Some(chunk_res) = rx.recv().await {
                    let chunk = chunk_res?;
                    if cancel_token.load(std::sync::atomic::Ordering::Relaxed) {
                        return Err("Cancelled".to_string());
                    }

                    remote_file
                        .write_all(&chunk)
                        .await
                        .map_err(|e| format!("SFTP write failed: {}", e))?;

                    let n = chunk.len();
                    *transferred += n as u64;

                    if last_emit.elapsed().as_millis() >= 100 {
                        let _ = app.emit(
                            "transfer-progress",
                            TransferProgress {
                                id: transfer_id.to_string(),
                                transferred: *transferred,
                                total: *total_size,
                            },
                        );
                        last_emit = std::time::Instant::now();
                    }
                }
                Ok(())
            }
            .await;
            rx.close();
            crate::transfers::finish_pipeline(&mut remote_file, reader, copy_result).await?;
        }
        Ok(())
    })
}

// Helper to calculate local size or directory size recursively
fn get_local_size(path: &std::path::Path) -> u64 {
    if path.is_dir() {
        match std::fs::read_dir(path) {
            Ok(entries) => entries
                .filter_map(|e| e.ok())
                .map(|e| get_local_size(&e.path()))
                .sum(),
            Err(_) => 0,
        }
    } else {
        path.metadata().map(|m| m.len()).unwrap_or(0)
    }
}

#[tauri::command]
pub async fn fs_transfer_file(
    app: AppHandle,
    source_connection_id: String,
    source_path: String,
    destination_connection_id: String,
    destination_path: String,
    transfer_id: String,
    overwrite: Option<bool>,
    folder_mode: Option<crate::file_transfers::FolderCopyMode>,
    state: State<'_, AppState>,
) -> Result<Option<crate::file_transfers::Receipt>, String> {
    use crate::file_transfers::{endpoint::EntryKind, Request};
    // This entire preparation block is read-only. Its tagged errors must not be
    // presented as a partially written destination or a saved recovery record.
    let prepared = async {
        let (source, source_identity, metadata) = prepare_file_transfer_endpoint(
            &state, &source_connection_id, &source_path, "source",
        ).await?;
        let Some(metadata) = metadata else { return Err("Source no longer exists".into()); };
        // Only top-level links retain the explicit legacy policy. Nested links
        // are preserved as links by staged folder copies, never followed.
        if metadata.kind == EntryKind::Symlink {
            if folder_mode == Some(crate::file_transfers::FolderCopyMode::Combine) {
                return Err("Combine folders does not follow a symbolic-link root".into());
            }
            return Ok(None);
        }
        if !matches!(metadata.kind, EntryKind::File | EntryKind::Directory) {
            return Err("Special files require a separate copy policy".into());
        }
        let (destination, destination_identity, _) = prepare_file_transfer_endpoint(
            &state, &destination_connection_id, &destination_path, "destination",
        ).await?;
        let stage_copy: Option<Arc<dyn crate::file_transfers::StageCopy>> =
            if source_connection_id == destination_connection_id && source_connection_id != "local" {
                let connections = state.connections.lock().await;
                let pinned = match (source.as_ref(), destination.as_ref()) {
                    (crate::file_transfers::endpoint::Endpoint::Remote(source_session),
                     crate::file_transfers::endpoint::Endpoint::Remote(destination_session))
                        if Arc::ptr_eq(source_session, destination_session) => source_session,
                    _ => return Err("Connection changed while preparing same-server copy".into()),
                };
                if !connections.get(&source_connection_id)
                    .and_then(|connection| connection.sftp_session.as_ref())
                    .is_some_and(|session| Arc::ptr_eq(session, pinned)) {
                    return Err("Connection changed while preparing same-server copy".into());
                }
                connections.get(&source_connection_id)
                    .filter(|connection| connection.detected_os.as_deref()
                        .is_some_and(|os| !os.eq_ignore_ascii_case("windows")))
                    .and_then(|connection| connection.session.clone())
                    .map(|session| Arc::new(SshStageCopy { session }) as Arc<dyn crate::file_transfers::StageCopy>)
            } else { None };
        Ok(Some((source, destination, source_identity, destination_identity, stage_copy)))
    }.await.map_err(transfer_not_started_error)?;
    let Some((source, destination, source_identity, destination_identity, stage_copy)) = prepared else { return Ok(None); };
    let service = state.file_transfers.clone();
    let request = Request { id: transfer_id.clone(), source_connection_id, source_path, source_identity,
        destination_connection_id, destination_path, destination_identity, overwrite: overwrite.unwrap_or(false),
        folder_mode: folder_mode.unwrap_or_default(), stage_copy };
    crate::transfers::run_owned_transfer(state.transfers.clone(), transfer_id.clone(), move |token| async move {
        let progress_app = app.clone(); let progress_id = transfer_id.clone();
        let receipt = service.execute(request, source, destination, token, move |transferred, total| {
            let _ = progress_app.emit("transfer-progress", TransferProgress { id: progress_id.clone(), transferred, total });
        }).await.map_err(transfer_not_started_error)?;
        let _ = app.emit("file-transfer-outcome", &receipt);
        Ok(Some(receipt))
    }).await
}

struct SshStageCopy { session: Arc<Mutex<Handle<Client>>> }

/// Service admission errors precede filesystem writes; preserve queued cancellation.
fn transfer_not_started_error(error: String) -> String {
    if error == "Cancelled" {
        error
    } else {
        format!("TRANSFER_NOT_STARTED:{error}")
    }
}

/// Probe the actual source/target, not a second health-check path. Only this
/// read-only preparation may reopen SFTP once; an active transfer stays pinned.
async fn prepare_file_transfer_endpoint(
    state: &AppState, id: &str, path: &str, role: &str,
) -> Result<(Arc<crate::file_transfers::endpoint::Endpoint>, String, Option<crate::file_transfers::endpoint::Snapshot>), String> {
    use crate::file_transfers::endpoint::{Endpoint, FileEndpoint};
    let prepare = async {
        let initial = file_transfer_endpoint(state, id, true).await?;
        let ((endpoint, identity), metadata) = if id == "local" {
            let metadata = initial.0.stat(path).await?;
            (initial, metadata)
        } else {
            crate::sftp_read::read_with_recovery(initial,
                |(endpoint, _)| async move { endpoint.stat(path).await },
                |(failed, identity)| async move {
                    eprintln!("[SFTP] Closed {role} session during copy preparation for {id}; reopening once");
                    if let Endpoint::Remote(failed) = failed.as_ref() {
                        let mut connections = state.connections.lock().await;
                        let connection = connections.get_mut(id).ok_or("Connection was disconnected while preparing the copy")?;
                        crate::sftp_read::invalidate_if_current(&mut connection.sftp_session, failed);
                    }
                    let fresh = file_transfer_endpoint(state, id, true).await?;
                    if fresh.1 != identity {
                        return Err("Connection identity changed while preparing the copy".into());
                    }
                    Ok(fresh)
                }).await?
        };
        Ok((endpoint, identity, metadata))
    };
    prepare.await.map_err(|error: String| format!("Could not prepare {role} connection {id}: {error}"))
}

#[async_trait::async_trait]
impl crate::file_transfers::StageCopy for SshStageCopy {
    async fn copy(&self, source: &str, stage: &str) -> Result<bool, String> {
        // The stage already exists exclusively with restrictive permissions.
        // Never copy directly over the user's destination or replay unknown exec.
        let command = format!("cp -- {} {}", shell_quote(source), shell_quote(stage));
        try_remote_files_mutation(&self.session, command, "Copy into staging").await
    }
}

/// Only connected, authenticated sessions are captured here. Recovery listing
/// never opens network connections; explicit inspection verifies identity first.
async fn file_transfer_endpoint(state: &AppState, id: &str, allow_connect: bool) -> Result<(Arc<crate::file_transfers::endpoint::Endpoint>, String), String> {
    if id == "local" { return Ok((Arc::new(crate::file_transfers::endpoint::Endpoint::Local), "local".into())); }
    let connected = if allow_connect { Some(get_sftp_or_reconnect(state, id).await?) } else { None };
    let connections = state.connections.lock().await;
    let connection = connections.get(id).ok_or("Connection is not available")?;
    let sftp = connection.sftp_session.clone().ok_or("Open the SSH connection before transferring or inspecting recovery files")?;
    if connected.as_ref().is_some_and(|session| !Arc::ptr_eq(session, &sftp)) {
        return Err("Connection changed while preparing the transfer".into());
    }
    // Hash only endpoint identity, excluding all auth fields, labels and secrets.
    fn identity(config: &ConnectionConfig) -> serde_json::Value {
        serde_json::json!({ "host": config.host, "port": config.port, "user": config.username,
            "jump": config.jump_host.as_ref().map(|jump| identity(jump)) })
    }
    use sha2::{Digest, Sha256};
    let key: String = Sha256::digest(identity(&connection.config).to_string().as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect();
    Ok((Arc::new(crate::file_transfers::endpoint::Endpoint::Remote(sftp)), key))
}

#[tauri::command]
pub async fn fs_transfer_history(state: State<'_, AppState>) -> Result<Vec<crate::file_transfers::Receipt>, String> {
    let history = state.file_transfers.history().await?;
    let active = state.transfers.lock().await;
    Ok(history.into_iter().filter_map(|receipt| {
        let running = active.contains_key(&receipt.id);
        receipt.for_restore(running)
    }).collect())
}

/// Recovery never reconnects implicitly or borrows the currently selected host.
async fn recovery_file_endpoint(state: &AppState, transfer_id: &str) -> Result<Arc<crate::file_transfers::endpoint::Endpoint>, String> {
    if state.transfers.lock().await.contains_key(transfer_id) { return Err("Wait for the active transfer to finish before accessing recovery".into()); }
    let receipt = state.file_transfers.history().await?.into_iter().find(|r| r.id == transfer_id).ok_or("Recovery record not found")?;
    let (endpoint, identity) = file_transfer_endpoint(state, &receipt.destination_connection_id, false).await?;
    if identity != receipt.destination_identity { return Err("Connection identity changed; recovery access was refused".into()); }
    Ok(endpoint)
}

#[tauri::command]
pub async fn fs_transfer_inspect(state: State<'_, AppState>, transfer_id: String) -> Result<crate::file_transfers::Inspection, String> {
    let endpoint = recovery_file_endpoint(&state, &transfer_id).await?;
    state.file_transfers.inspect_recovery(&transfer_id, endpoint.as_ref()).await
}

#[tauri::command]
pub async fn fs_transfer_cleanup(state: State<'_, AppState>, transfer_id: String) -> Result<(), String> {
    let endpoint = recovery_file_endpoint(&state, &transfer_id).await?;
    state.file_transfers.cleanup_recovery(&transfer_id, endpoint.as_ref()).await
}

#[tauri::command]
pub async fn fs_transfer_dismiss(state: State<'_, AppState>, transfer_id: String) -> Result<(), String> {
    if state.transfers.lock().await.contains_key(&transfer_id) { return Err("Transfer is still active".into()); }
    state.file_transfers.dismiss(transfer_id).await
}

#[tauri::command]
pub async fn fs_transfer_resolve(state: State<'_, AppState>, transfer_id: String) -> Result<(), String> {
    let endpoint = recovery_file_endpoint(&state, &transfer_id).await?;
    state.file_transfers.resolve_after_artifacts_removed(transfer_id, endpoint.as_ref()).await
}

#[tauri::command]
pub async fn sftp_put(
    app: AppHandle,
    id: String,
    local_path: String,
    remote_path: String,
    transfer_id: String,
    wait_for_completion: Option<bool>,
    _state: State<'_, AppState>,
) -> Result<(), String> {
    let app_handle = app.clone();
    let outcome_app = app.clone();
    let connection_id = id.clone();
    let outcome_connection_id = id;
    let local = local_path.clone();
    let remote = remote_path.clone();
    let tid = transfer_id.clone();

    crate::transfers::start_transfer(
        _state.transfers.clone(),
        transfer_id.clone(),
        wait_for_completion.unwrap_or(false),
        move |cancel_token| async move {
            let state = app_handle.state::<AppState>();
            crate::transfers::check_cancelled(&cancel_token)?;
            if connection_id == "local" {
                // Local copy
                let path = std::path::Path::new(&local);
                if path.is_dir() {
                    // Todo recursive local
                    return Err("Local directory copy not yet implemented".to_string());
                }
                let transferred = std::fs::copy(&local, &remote).map_err(|e| e.to_string())?;
                let _ = app_handle.emit("transfer-progress", TransferProgress {
                    id: tid.clone(), transferred, total: transferred,
                });
            } else {
                let sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
                let path = std::path::Path::new(&local);

                // Calculate total size for progress bar
                let mut total_size = get_local_size(path);
                if total_size == 0 {
                    total_size = 1;
                } // Avoid division by zero
                crate::transfers::check_cancelled(&cancel_token)?;
                let mut transferred = 0;

                // Emit initial start event to switch UI to "transferring" immediately
                let _ = app_handle.emit(
                    "transfer-progress",
                    TransferProgress {
                        id: tid.clone(),
                        transferred: 0,
                        total: total_size,
                    },
                );

                upload_recursive(
                    &sftp,
                    path,
                    &remote,
                    &app_handle,
                    &tid,
                    &mut total_size,
                    &mut transferred,
                    &cancel_token,
                )
                .await?;
                let _ = app_handle.emit("transfer-progress", TransferProgress {
                    id: tid.clone(), transferred, total: total_size,
                });
            }
            Ok(())
        },
        move |result| {
            emit_transfer_outcome(&outcome_app, &transfer_id, &outcome_connection_id, result)
        },
    )
    .await
}

#[tauri::command]
pub async fn sftp_cancel_transfer(
    state: State<'_, AppState>,
    transfer_id: String,
) -> Result<(), String> {
    crate::transfers::request_cancel(&state.transfers, &transfer_id).await?;
    state.file_transfers.wake_cancelled(&transfer_id);
    Ok(())
}

#[tauri::command]
pub async fn sftp_copy_to_server(
    app: AppHandle,
    source_connection_id: String,
    source_path: String,
    destination_connection_id: String,
    destination_path: String,
    transfer_id: String,
    mode: Option<String>, // "standard" or "turbo" (Ignored, always standard now)
    wait_for_completion: Option<bool>,
    _state: State<'_, AppState>,
) -> Result<(), String> {
    let app_handle = app.clone();
    let outcome_app = app.clone();
    let src_id = source_connection_id.clone();
    let src_path = source_path.clone();
    let dst_id = destination_connection_id.clone();
    let outcome_destination_id = destination_connection_id;
    let dst_path = destination_path.clone();
    let tid = transfer_id.clone();
    let _mode = mode.unwrap_or_else(|| "standard".to_string());

    crate::transfers::start_transfer(
        _state.transfers.clone(),
        transfer_id.clone(),
        wait_for_completion.unwrap_or(false),
        move |cancel_token| async move {
            let state = app_handle.state::<AppState>();
            crate::transfers::check_cancelled(&cancel_token)?;
            // Shared SFTP session for size calculation
            let src_sftp = get_sftp_or_reconnect(&state, &src_id).await?;
            // Calculate size upfront for accurate progress
            let mut total_size = get_remote_size(&src_sftp, &src_path).await;
            if total_size == 0 {
                total_size = 1;
            }

            let _ = app_handle.emit(
                "transfer-progress",
                TransferProgress {
                    id: tid.clone(),
                    transferred: 0,
                    total: total_size,
                },
            );

            // Check cancellation early
            if cancel_token.load(std::sync::atomic::Ordering::Relaxed) {
                return Err("Cancelled".to_string());
            }

            // Standard Mode (Proxied Streaming)
            let dst_sftp = get_sftp_or_reconnect(&state, &dst_id).await?;
            let mut transferred = 0;

            copy_recursive_optimized(
                &src_sftp,
                &dst_sftp,
                &src_path,
                &dst_path,
                &app_handle,
                &tid,
                total_size,
                &mut transferred,
                &cancel_token,
            )
            .await?;

            let _ = app_handle.emit(
                "transfer-progress",
                TransferProgress {
                    id: tid.clone(),
                    transferred,
                    total: total_size,
                },
            );
            Ok(())
        },
        move |result| {
            emit_transfer_outcome(&outcome_app, &transfer_id, &outcome_destination_id, result)
        },
    )
    .await
}

// Optimized recursive copy with cancellation and larger buffer
async fn copy_recursive_optimized(
    src_sftp: &russh_sftp::client::SftpSession,
    dst_sftp: &russh_sftp::client::SftpSession,
    src_path: &str,
    dst_path: &str,
    app: &AppHandle,
    transfer_id: &str,
    total_size: u64,
    transferred: &mut u64,
    cancel_token: &Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), String> {
    use russh_sftp::protocol::OpenFlags;
    use tokio::io::AsyncWriteExt;

    if cancel_token.load(std::sync::atomic::Ordering::Relaxed) {
        return Err("Cancelled".to_string());
    }

    let metadata = src_sftp
        .metadata(src_path)
        .await
        .map_err(|e| format!("Failed to stat source: {}", e))?;

    if metadata.file_type().is_dir() {
        crate::fs::ensure_remote_transfer_directory(dst_sftp, dst_path).await?;

        let entries = src_sftp
            .read_dir(src_path)
            .await
            .map_err(|e| format!("Read dir failed: {}", e))?;
        for entry in entries {
            let filename = entry.file_name();
            if filename == "." || filename == ".." {
                continue;
            }

            let new_src = if src_path.ends_with('/') {
                format!("{}{}", src_path, filename)
            } else {
                format!("{}/{}", src_path, filename)
            };
            let new_dst = if dst_path.ends_with('/') {
                format!("{}{}", dst_path, filename)
            } else {
                format!("{}/{}", dst_path, filename)
            };

            Box::pin(copy_recursive_optimized(
                src_sftp,
                dst_sftp,
                &new_src,
                &new_dst,
                app,
                transfer_id,
                total_size,
                transferred,
                cancel_token,
            ))
            .await?;
        }
    } else {
        // File copy
        let mut src_file = src_sftp
            .open_with_flags(src_path, OpenFlags::READ)
            .await
            .map_err(|e| format!("Open src failed: {}", e))?;
        let mut dst_file = dst_sftp
            .open_with_flags(
                dst_path,
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
            )
            .await
            .map_err(|e| format!("Open dst failed: {}", e))?;

        // 4MB buffer to maximize throughput on high-latency links
        // Full-Duplex Channel (Remote Source reads piped to Remote Destination writes)
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, String>>(4);

        // Spawn Source Reader Task
        let reader = tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            loop {
                let mut buffer = vec![0u8; 4194304]; // 4MB Chunk
                match src_file.read(&mut buffer).await {
                    Ok(0) => break,
                    Ok(n) => {
                        buffer.truncate(n);
                        if tx.send(Ok(buffer)).await.is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = tx
                            .send(Err(format!("SFTP source read failed: {}", e)))
                            .await;
                        break;
                    }
                }
            }
        });

        let mut last_emit = std::time::Instant::now();

        let copy_result = async {
            while let Some(chunk_res) = rx.recv().await {
                let chunk = chunk_res?;
                if cancel_token.load(std::sync::atomic::Ordering::Relaxed) {
                    return Err("Cancelled".to_string());
                }

                dst_file
                    .write_all(&chunk)
                    .await
                    .map_err(|e| format!("SFTP destination write failed: {}", e))?;

                let n = chunk.len();
                *transferred += n as u64;

                if last_emit.elapsed().as_millis() >= 200 {
                    let _ = app.emit(
                        "transfer-progress",
                        TransferProgress {
                            id: transfer_id.to_string(),
                            transferred: *transferred,
                            total: total_size,
                        },
                    );
                    last_emit = std::time::Instant::now();
                }
            }

            Ok(())
        }
        .await;
        rx.close();
        crate::transfers::finish_pipeline(&mut dst_file, reader, copy_result).await?;

        // Final emit for file
        let _ = app.emit(
            "transfer-progress",
            TransferProgress {
                id: transfer_id.to_string(),
                transferred: *transferred,
                total: total_size,
            },
        );
    }

    Ok(())
}

// Helper for recursive download
fn download_recursive<'a>(
    sftp: &'a russh_sftp::client::SftpSession,
    remote_path: &'a str,
    local_path: &'a std::path::Path,
    app: &'a AppHandle,
    transfer_id: &'a str,
    total_size: &'a mut u64,
    transferred: &'a mut u64,
    cancel_token: &'a std::sync::atomic::AtomicBool,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        crate::transfers::check_cancelled(cancel_token)?;
        // Check if remote is dir or file
        let metadata = sftp
            .metadata(remote_path)
            .await
            .map_err(|e| format!("Failed to stat remote path '{}': {}", remote_path, e))?;

        if metadata.file_type().is_dir() {
            // Create local directory
            std::fs::create_dir_all(local_path)
                .map_err(|e| format!("Failed to create local dir: {}", e))?;

            // List remote directory
            let entries = sftp
                .read_dir(remote_path)
                .await
                .map_err(|e| format!("Failed to read remote dir: {}", e))?;

            for entry in entries {
                let name = entry.file_name();
                if name == "." || name == ".." {
                    continue;
                }

                let new_remote = if remote_path.ends_with('/') {
                    format!("{}{}", remote_path, name)
                } else {
                    format!("{}/{}", remote_path, name)
                };

                let new_local = local_path.join(&name);

                download_recursive(
                    sftp,
                    &new_remote,
                    &new_local,
                    app,
                    transfer_id,
                    total_size,
                    transferred,
                    cancel_token,
                )
                .await?;
            }
        } else {
            // Download file
            use russh_sftp::protocol::OpenFlags;

            // Create local file using tokio for async writing
            let mut local_file = tokio::fs::File::create(local_path)
                .await
                .map_err(|e| format!("Failed to create local file: {}", e))?;

            // Full-Duplex Channel (Remote reads piped to local disk writes)
            let (tx, mut rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, String>>(4);

            // Open remote file
            let mut remote_file = sftp
                .open_with_flags(remote_path, OpenFlags::READ)
                .await
                .map_err(|e| format!("Failed to open remote file '{}': {}", remote_path, e))?;

            // Spawn Remote Reader Task
            let reader = tokio::spawn(async move {
                use tokio::io::AsyncReadExt;
                loop {
                    let mut buffer = vec![0u8; 4 * 1024 * 1024];
                    match remote_file.read(&mut buffer).await {
                        Ok(0) => break,
                        Ok(n) => {
                            buffer.truncate(n);
                            if tx.send(Ok(buffer)).await.is_err() {
                                break;
                            }
                        }
                        Err(e) => {
                            let _ = tx.send(Err(format!("SFTP read failed: {}", e))).await;
                            break;
                        }
                    }
                }
            });

            let mut last_emit = std::time::Instant::now();

            let copy_result = async {
                while let Some(chunk_res) = rx.recv().await {
                    let chunk = chunk_res?;
                    if cancel_token.load(std::sync::atomic::Ordering::Relaxed) {
                        return Err("Cancelled".to_string());
                    }

                    use tokio::io::AsyncWriteExt;
                    local_file
                        .write_all(&chunk)
                        .await
                        .map_err(|e| format!("Local write failed: {}", e))?;

                    let n = chunk.len();
                    *transferred += n as u64;

                    if last_emit.elapsed().as_millis() >= 100 {
                        let _ = app.emit(
                            "transfer-progress",
                            TransferProgress {
                                id: transfer_id.to_string(),
                                transferred: *transferred,
                                total: *total_size,
                            },
                        );
                        last_emit = std::time::Instant::now();
                    }
                }
                Ok(())
            }
            .await;
            rx.close();
            crate::transfers::finish_pipeline(&mut local_file, reader, copy_result).await?;
        }
        Ok(())
    })
}

// Helper to calculate remote size recursively
async fn get_remote_size(sftp: &russh_sftp::client::SftpSession, path: &str) -> u64 {
    let mut total_size = 0;
    // Queue of paths to visit
    let mut queue = vec![path.to_string()];

    // Initial check for file vs dir
    if let Ok(metadata) = sftp.metadata(path).await {
        if !metadata.file_type().is_dir() {
            return metadata.len();
        }
    } else {
        return 0; // Path doesn't exist
    }

    // BFS
    while let Some(current_path) = queue.pop() {
        if let Ok(entries) = sftp.read_dir(&current_path).await {
            for entry in entries {
                let filename = entry.file_name();
                if filename == "." || filename == ".." {
                    continue;
                }

                let next_path = if current_path.ends_with('/') {
                    format!("{}{}", current_path, filename)
                } else {
                    format!("{}/{}", current_path, filename)
                };

                // Stat the entry to get attributes
                if let Ok(attrs) = sftp.metadata(&next_path).await {
                    if attrs.file_type().is_dir() {
                        queue.push(next_path);
                    } else {
                        // It's a file (or symlink pointing to file? treated as file size)
                        total_size += attrs.len();
                    }
                }
            }
        }
    }
    total_size
}

#[tauri::command]
pub async fn sftp_get(
    app: AppHandle,
    id: String,
    remote_path: String,
    local_path: String,
    transfer_id: String,
    wait_for_completion: Option<bool>,
    _state: State<'_, AppState>,
) -> Result<(), String> {
    let app_handle = app.clone();
    let outcome_app = app.clone();
    let connection_id = id.clone();
    let remote = remote_path.clone();
    let local = local_path.clone();
    let tid = transfer_id.clone();

    crate::transfers::start_transfer(
        _state.transfers.clone(),
        transfer_id.clone(),
        wait_for_completion.unwrap_or(false),
        move |cancel_token| async move {
            let state = app_handle.state::<AppState>();
            crate::transfers::check_cancelled(&cancel_token)?;
            // Retrieve session
            let sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
            let local_p = std::path::Path::new(&local);

            // Prepare total size (Best effort)
            let mut total_size = get_remote_size(&sftp, &remote).await;
            if total_size == 0 {
                total_size = 1;
            }
            crate::transfers::check_cancelled(&cancel_token)?;
            let mut transferred = 0;

            // Emit start
            let _ = app_handle.emit(
                "transfer-progress",
                TransferProgress {
                    id: tid.clone(),
                    transferred: 0,
                    total: total_size,
                },
            );

            download_recursive(
                &sftp,
                &remote,
                local_p,
                &app_handle,
                &tid,
                &mut total_size,
                &mut transferred,
                &cancel_token,
            )
            .await?;
            let _ = app_handle.emit("transfer-progress", TransferProgress {
                id: tid.clone(), transferred, total: total_size,
            });
            Ok(())
        },
        move |result| emit_transfer_outcome(&outcome_app, &transfer_id, "local", result),
    )
    .await
}

#[tauri::command]
pub async fn shell_open(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(path, None::<String>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn shell_get_wsl_distros() -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        use tokio::process::Command;
        let output = match Command::new("wsl.exe").args(["-l", "-q"]).output().await {
            Ok(o) => o,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.to_string()),
        };

        if !output.status.success() {
            return Ok(Vec::new());
        }

        let bytes = &output.stdout;
        let mut words = Vec::with_capacity(bytes.len() / 2);
        let mut i = 0usize;
        while i + 1 < bytes.len() {
            words.push(u16::from_le_bytes([bytes[i], bytes[i + 1]]));
            i += 2;
        }

        let mut decoded = String::from_utf16_lossy(&words);
        if decoded.starts_with('\u{feff}') {
            decoded.remove(0);
        }

        let stdout = decoded;
        let distros = stdout
            .lines()
            .map(|line| line.trim())
            .filter(|line| !line.is_empty())
            .map(|line| line.to_string())
            .collect::<Vec<_>>();
        return Ok(distros);
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(Vec::new())
    }
}

#[derive(serde::Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ShellIconData {
    Bundled { name: String },
    Base64Png { data: String },
    Base64Icon { data: String },
}

fn bundled(name: &'static str) -> Option<ShellIconData> {
    Some(ShellIconData::Bundled {
        name: name.to_string(),
    })
}

fn wsl_bundled_icon(_distro: &str) -> Option<ShellIconData> {
    // TODO: support distro-specific bundled icons; `_distro` is intentionally unused for now.
    bundled("wsl.png")
}

fn remote_shell_icon(path_or_name: &str) -> Option<ShellIconData> {
    let value = path_or_name.to_lowercase();
    if value.contains("bash") {
        bundled("bash.png")
    } else if value.contains("zsh") {
        bundled("zsh.svg")
    } else if value.contains("fish") {
        bundled("fish.png")
    } else {
        bundled("terminal.png")
    }
}

fn remote_shell_fallbacks(detected_default: Option<String>) -> Vec<DetectedShell> {
    // No hardcoded shells — the dropdown must reflect only what the host actually has.
    // If the /etc/shells query fails, surface at most the user's detected login shell
    // (captured at connect time) so the picker isn't empty. Nothing else is invented.
    let Some(default_shell) = detected_default else {
        return Vec::new();
    };
    let label = std::path::Path::new(&default_shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&default_shell)
        .to_string();
    vec![DetectedShell {
        id: default_shell.clone(),
        label,
        icon: remote_shell_icon(&default_shell),
    }]
}

fn dedupe_shells_by_label(shells: Vec<DetectedShell>) -> Vec<DetectedShell> {
    let mut seen_labels = HashSet::new();
    let mut deduped = Vec::new();
    for shell in shells {
        let key = shell.label.trim().to_lowercase();
        if seen_labels.insert(key) {
            deduped.push(shell);
        }
    }
    deduped
}

fn remote_windows_shell_entry(id: &str) -> Option<DetectedShell> {
    match id.trim().to_ascii_lowercase().as_str() {
        "powershell" | "powershell.exe" => Some(DetectedShell {
            id: "powershell".to_string(),
            label: "Windows PowerShell".to_string(),
            icon: bundled("powershell.svg"),
        }),
        "pwsh" | "pwsh.exe" => Some(DetectedShell {
            id: "pwsh".to_string(),
            label: "PowerShell".to_string(),
            icon: bundled("pwsh.svg"),
        }),
        "cmd" | "cmd.exe" => Some(DetectedShell {
            id: "cmd".to_string(),
            label: "Command Prompt".to_string(),
            icon: bundled("cmd.png"),
        }),
        _ => None,
    }
}

/// Discover Windows shell executables on the host through an ordinary SSH channel.
async fn query_remote_windows_shells(
    connection_id: &str,
    state: &tauri::State<'_, AppState>,
) -> Result<Vec<DetectedShell>, String> {
    const WINDOWS_SHELL_QUERY_TIMEOUT: Duration = Duration::from_secs(10);

    let mut channel = open_ssh_channel_with_single_reconnect(connection_id, state).await?;
    let list_cmd = "cmd /c \"where powershell.exe >nul 2>nul && echo powershell & where pwsh.exe >nul 2>nul && echo pwsh & where cmd.exe >nul 2>nul && echo cmd\"";
    channel
        .exec(true, list_cmd)
        .await
        .map_err(|e| format!("Failed to query remote Windows shells: {}", e))?;

    let mut output = String::new();
    let mut stderr = String::new();
    loop {
        let msg = match tokio::time::timeout(WINDOWS_SHELL_QUERY_TIMEOUT, channel.wait()).await {
            Ok(msg) => msg,
            Err(_) => return Err("Failed to query remote Windows shells: timeout".to_string()),
        };
        let Some(msg) = msg else {
            break;
        };
        match msg {
            russh::ChannelMsg::Data { data } => {
                output.push_str(&String::from_utf8_lossy(&data));
            }
            russh::ChannelMsg::ExtendedData { data, .. } => {
                stderr.push_str(&String::from_utf8_lossy(&data));
            }
            _ => {}
        }
    }

    if !stderr.trim().is_empty() {
        eprintln!(
            "[Shells] Remote Windows stderr for '{}': {}",
            connection_id,
            stderr.trim()
        );
    }

    let mut shells: Vec<DetectedShell> = output
        .lines()
        .filter_map(remote_windows_shell_entry)
        .collect();

    if shells.is_empty() {
        // Windows OpenSSH defaults commonly use PowerShell even when explicit
        // probing fails because of policy/path quirks. Keep the picker useful
        // while default terminal creation still uses request_shell fallback.
        shells.push(remote_windows_shell_entry("powershell").expect("static shell id"));
        shells.push(remote_windows_shell_entry("cmd").expect("static shell id"));
    }

    Ok(dedupe_shells_by_label(shells))
}

#[cfg(not(target_os = "windows"))]
fn linux_icon(path: &str) -> Option<ShellIconData> {
    let name = if path.contains("bash") {
        "bash.png"
    } else if path.contains("zsh") {
        "zsh.svg"
    } else if path.contains("fish") {
        "fish.png"
    } else {
        "terminal.png"
    };
    Some(ShellIconData::Bundled {
        name: name.to_string(),
    })
}

#[derive(serde::Serialize, Clone)]
pub struct DetectedShell {
    pub id: String,
    pub label: String,
    pub icon: Option<ShellIconData>,
}

#[tauri::command]
pub async fn shell_get_windows_shells(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<DetectedShell>, String> {
    #[cfg(target_os = "windows")]
    {
        use tokio::process::Command;
        let mut shells = Vec::new();

        // Windows PowerShell — always present on Win10+
        shells.push(DetectedShell {
            id: "powershell".into(),
            label: "Windows PowerShell".into(),
            icon: bundled("powershell.svg"),
        });

        // PowerShell 7 (pwsh) — optional install
        let pwsh_paths = [
            "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
            "C:\\Program Files\\PowerShell\\pwsh.exe",
        ];
        if pwsh_paths.iter().any(|p| std::path::Path::new(p).exists()) {
            shells.push(DetectedShell {
                id: "pwsh".into(),
                label: "PowerShell".into(),
                icon: bundled("pwsh.svg"),
            });
        }

        // Command Prompt — always present
        shells.push(DetectedShell {
            id: "cmd".into(),
            label: "Command Prompt".into(),
            icon: bundled("cmd.png"),
        });

        // Git Bash — check common install paths
        let git_bash_paths = [
            "C:\\Program Files\\Git\\bin\\bash.exe",
            "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
        ];
        if git_bash_paths
            .iter()
            .any(|p| std::path::Path::new(p).exists())
        {
            shells.push(DetectedShell {
                id: "gitbash".into(),
                label: "Git Bash".into(),
                icon: bundled("gitbash.svg"),
            });
        }

        // WSL distros — reuse the same UTF-16 decode as shell_get_wsl_distros
        if let Ok(output) = Command::new("wsl.exe").args(["-l", "-q"]).output().await {
            if output.status.success() {
                let bytes = &output.stdout;
                let mut words = Vec::with_capacity(bytes.len() / 2);
                let mut i = 0usize;
                while i + 1 < bytes.len() {
                    words.push(u16::from_le_bytes([bytes[i], bytes[i + 1]]));
                    i += 2;
                }
                let mut decoded = String::from_utf16_lossy(&words);
                if decoded.starts_with('\u{feff}') {
                    decoded.remove(0);
                }
                let distros: Vec<String> = decoded
                    .lines()
                    .map(|l| l.trim().to_string())
                    .filter(|l| !l.is_empty() && !l.to_lowercase().starts_with("docker-"))
                    .collect();
                if !distros.is_empty() {
                    let cache = state.shell_icon_cache.clone();
                    let cache_path = state.shell_icon_cache_path.clone();
                    let should_prefetch = {
                        let guard = cache.read().await;
                        distros
                            .iter()
                            .any(|distro| !guard.contains_key(&distro.to_lowercase()))
                    };
                    if should_prefetch {
                        crate::shell_icons::prefetch_all_wsl_icons(&cache, &cache_path).await;
                    }

                    let guard = cache.read().await;
                    for distro in distros {
                        let icon = guard
                            .get(&distro.to_lowercase())
                            .and_then(|v| v.clone())
                            .map(|tagged| {
                                if let Some(data) = tagged.strip_prefix("png:") {
                                    ShellIconData::Base64Png {
                                        data: data.to_string(),
                                    }
                                } else if let Some(data) = tagged.strip_prefix("ico:") {
                                    ShellIconData::Base64Icon {
                                        data: data.to_string(),
                                    }
                                } else {
                                    ShellIconData::Base64Png { data: tagged }
                                }
                            })
                            .or_else(|| wsl_bundled_icon(&distro));
                        shells.push(DetectedShell {
                            id: format!("wsl:{}", distro),
                            label: distro,
                            icon,
                        });
                    }
                }
            }
        }

        Ok(shells)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(Vec::new())
    }
}

#[tauri::command]
pub async fn shell_get_available_shells() -> Result<Vec<DetectedShell>, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let detected_default = std::env::var("SHELL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && std::path::Path::new(s).exists());
        let contents = std::fs::read_to_string("/etc/shells").unwrap_or_default();
        let mut seen = HashSet::new();
        let mut shells: Vec<DetectedShell> = contents
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .filter(|l| std::path::Path::new(l).exists())
            .filter_map(|l| {
                let id = l.to_string();
                if !seen.insert(id.clone()) {
                    return None;
                }
                Some(DetectedShell {
                    label: l.split('/').last().unwrap_or(l).to_string(),
                    icon: linux_icon(l),
                    id,
                })
            })
            .collect();

        shells.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));

        if let Some(default_shell) = detected_default {
            shells.retain(|shell| shell.id != default_shell);
            let label = std::path::Path::new(&default_shell)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(&default_shell)
                .to_string();
            shells.insert(
                0,
                DetectedShell {
                    id: default_shell.clone(),
                    label,
                    icon: linux_icon(&default_shell),
                },
            );
        }

        Ok(shells)
    }
    #[cfg(target_os = "windows")]
    {
        Ok(Vec::new())
    }
}

#[tauri::command]
/// List actual local/remote shells while preserving the connection's detected default.
pub async fn shell_get_connection_shells(
    connection_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<DetectedShell>, String> {
    // `local` shell discovery is intentionally handled by dedicated local
    // commands (`shell_get_windows_shells` / `shell_get_available_shells`).
    if connection_id == "local" {
        return Ok(Vec::new());
    }

    let (detected_default, detected_os) = {
        let connections = state.connections.lock().await;
        let entry = connections.get(&connection_id);
        (
            entry.and_then(|c| c.detected_shell.clone()),
            entry.and_then(|c| c.detected_os.clone()),
        )
    };
    if detected_os
        .as_deref()
        .map(|os| os.eq_ignore_ascii_case("windows"))
        .unwrap_or(false)
    {
        let shells = query_remote_windows_shells(&connection_id, &state).await?;
        return Ok(shells);
    }

    let mut output = String::new();
    let mut stderr = String::new();
    let query_result: Result<(), String> = match tokio::time::timeout(Duration::from_secs(10), async {
        let mut channel = open_ssh_channel_with_single_reconnect(&connection_id, &state).await?;
        // Compound query: cat /etc/shells (canonical login-shell registry) plus
        // a disk probe of well-known shell paths. The probe catches shells that
        // exist on disk but aren't registered in /etc/shells (rare but real).
        //
        // Both halves are dynamic — every emitted line is a path that actually
        // exists on the remote — so nothing is invented. Duplicates are removed
        // downstream (by id, then by basename).
        //
        // Run as a bare compound command, NOT wrapped in `/bin/sh -c '...'`.
        // SSH exec already runs under the user's login shell; an extra wrapper
        // adds a quoting layer that has bitten us before on hosts with quirky
        // login shells.
        let list_cmd = "cat /etc/shells 2>/dev/null; for s in /bin/bash /usr/bin/bash /bin/sh /usr/bin/sh /bin/dash /usr/bin/dash /bin/zsh /usr/bin/zsh /usr/local/bin/zsh /bin/fish /usr/bin/fish /usr/local/bin/fish /bin/rbash /usr/bin/rbash /bin/ksh /usr/bin/ksh /bin/tcsh /usr/bin/tcsh /bin/csh /usr/bin/csh; do [ -x \"$s\" ] && echo \"$s\"; done";
        channel
            .exec(true, list_cmd)
            .await
            .map_err(|e| format!("Failed to query remote shells: {}", e))?;
        // Drain the channel to completion. Breaking early on ExitStatus risks
        // losing trailing Data messages that haven't been pulled yet, which is
        // how this query was returning empty on some hosts.
        while let Some(msg) = channel.wait().await {
            match msg {
                russh::ChannelMsg::Data { data } => {
                    output.push_str(&String::from_utf8_lossy(&data));
                }
                russh::ChannelMsg::ExtendedData { data, .. } => {
                    stderr.push_str(&String::from_utf8_lossy(&data));
                }
                russh::ChannelMsg::ExitStatus { .. } => {}
                _ => {}
            }
        }
        Ok(())
    })
    .await
    {
        Ok(result) => result,
        Err(_) => Err("Failed to query remote shells: timeout".to_string()),
    };

    if let Err(err) = query_result {
        eprintln!(
            "[Shells] Remote query FAILED for '{}': {}",
            connection_id, err
        );
        // Return Err — not Ok([]) — so the frontend keeps any cached shells
        // visible and exposes an explicit reload affordance instead of caching
        // a sticky empty result during connection-startup races.
        return Err(err);
    }
    if !stderr.trim().is_empty() {
        eprintln!(
            "[Shells] Remote stderr for '{}': {}",
            connection_id,
            stderr.trim()
        );
    }

    let mut seen = HashSet::new();
    let mut shells: Vec<DetectedShell> = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| line.split_whitespace().next())
        .filter(|line| line.starts_with('/'))
        .filter_map(|line| {
            let id = line.to_string();
            if !seen.insert(id.clone()) {
                return None;
            }
            let label = std::path::Path::new(&id)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(&id)
                .to_string();
            Some(DetectedShell {
                id: id.clone(),
                label,
                icon: remote_shell_icon(&id),
            })
        })
        .collect();

    if shells.is_empty() {
        shells = remote_shell_fallbacks(detected_default.clone());
    }

    shells.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));

    if let Some(default_shell) = detected_default {
        // Keep the user/account default shell pinned at the top after sorting.
        shells.retain(|shell| shell.id != default_shell);
        let label = std::path::Path::new(&default_shell)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&default_shell)
            .to_string();
        shells.insert(
            0,
            DetectedShell {
                id: default_shell.clone(),
                label,
                icon: remote_shell_icon(&default_shell),
            },
        );
    }

    Ok(dedupe_shells_by_label(shells))
}

#[tauri::command]
pub async fn app_get_exe_dir() -> Result<String, String> {
    let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe_path
        .parent()
        .ok_or("Could not get executable directory")?;
    Ok(exe_dir.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn app_exit(
    app: tauri::AppHandle,
    recovery: State<'_, crate::plugins::recovery::PluginRecoveryState>,
) -> Result<(), String> {
    if let Err(error) = recovery.mark_clean_exit() {
        log::warn!("[Plugins] Failed to record a clean app exit: {error}");
    }
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub async fn app_relaunch(
    app: tauri::AppHandle,
    recovery: State<'_, crate::plugins::recovery::PluginRecoveryState>,
) -> Result<(), String> {
    if let Err(error) = recovery.mark_clean_exit() {
        log::warn!("[Plugins] Failed to record a clean app relaunch: {error}");
    }
    app.restart()
}

#[tauri::command]
pub async fn plugins_load(app: AppHandle) -> Result<Vec<crate::plugins::Plugin>, String> {
    crate::plugins::PluginScanner::scan(&app).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn plugins_developer_mode_get(app: AppHandle) -> Result<bool, String> {
    crate::plugins::PluginScanner::developer_mode_enabled(&app).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn plugins_developer_mode_set(
    app: AppHandle,
    broker: State<'_, crate::plugins::broker::PluginBrokerState>,
    enabled: bool,
) -> Result<(), String> {
    crate::plugins::PluginScanner::set_developer_mode(&app, enabled)
        .map_err(|error| error.to_string())?;
    // Mode changes invalidate every runtime identity. The renderer reloads eligible
    // plugins after this command, while stale workers lose native broker authority now.
    broker.reset();
    Ok(())
}

#[tauri::command]
pub async fn plugins_registry_load(
    app: AppHandle,
) -> Result<crate::plugins::registry::TrustedRegistrySnapshot, String> {
    crate::plugins::registry::load(&app)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn plugins_beta_plugins_get(app: AppHandle) -> Result<Vec<String>, String> {
    crate::plugins::PluginScanner::beta_plugins(&app).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn plugins_beta_plugin_set(
    app: AppHandle,
    plugin_id: String,
    enabled: bool,
) -> Result<(), String> {
    crate::plugins::PluginScanner::set_beta_enabled(&app, &plugin_id, enabled)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn plugins_toggle(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    crate::plugins::PluginScanner::save_state(&app, id, enabled).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn plugins_inspect_local(
    app: AppHandle,
    path: String,
) -> Result<crate::plugins::install::PluginInstallInspection, String> {
    let app_handle = app.clone();
    let local_path = path.clone();

    tokio::task::spawn_blocking(move || {
        crate::plugins::PluginScanner::inspect_local_plugin(&app_handle, &local_path)
    })
    .await
    .map_err(|e| format!("Local plugin inspection task failed: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn plugins_inspect_marketplace(
    app: AppHandle,
    plugin_id: String,
    version: String,
) -> Result<crate::plugins::install::PluginInstallInspection, String> {
    crate::plugins::PluginScanner::inspect_marketplace_plugin(&app, &plugin_id, &version)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn plugins_install_inspected(
    app: AppHandle,
    inspection_id: String,
    package_digest: String,
    optional_permission_ids: Vec<String>,
) -> Result<crate::plugins::install::PluginActivationTransaction, String> {
    tokio::task::spawn_blocking(move || {
        crate::plugins::PluginScanner::install_inspected_plugin(
            &app,
            &inspection_id,
            &package_digest,
            optional_permission_ids,
        )
    })
    .await
    .map_err(|e| format!("Plugin activation task failed: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn plugins_commit_activation(
    app: AppHandle,
    activation_id: String,
) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        crate::plugins::PluginScanner::commit_plugin_activation(&app, &activation_id)
    })
    .await
    .map_err(|e| format!("Plugin activation commit task failed: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn plugins_rollback_version(
    app: AppHandle,
    broker: State<'_, crate::plugins::broker::PluginBrokerState>,
    plugin_id: String,
) -> Result<crate::plugins::rollback::PluginRollbackResult, String> {
    broker.stop_plugin(&plugin_id);
    tokio::task::spawn_blocking(move || crate::plugins::rollback::rollback(&app, &plugin_id))
        .await
        .map_err(|e| format!("Plugin version rollback task failed: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn plugins_rollback_activation(
    app: AppHandle,
    activation_id: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        crate::plugins::PluginScanner::rollback_plugin_activation(&app, &activation_id)
    })
    .await
    .map_err(|e| format!("Plugin rollback task failed: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn plugins_discard_inspection(
    app: AppHandle,
    inspection_id: String,
) -> Result<(), String> {
    crate::plugins::PluginScanner::discard_plugin_inspection(&app, &inspection_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn plugins_runtime_start(
    app: AppHandle,
    state: State<'_, crate::plugins::broker::PluginBrokerState>,
    recovery: State<'_, crate::plugins::recovery::PluginRecoveryState>,
    plugin_id: String,
) -> Result<crate::plugins::broker::PluginRuntimeRegistration, String> {
    recovery.status().map_err(|error| error.to_string())?;
    state
        .start_runtime(&app, &plugin_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn plugins_runtime_authorize(
    app: AppHandle,
    state: State<'_, crate::plugins::broker::PluginBrokerState>,
    runtime_instance_id: String,
    capability: String,
) -> Result<(), String> {
    state
        .authorize(&app, &runtime_instance_id, &capability)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn plugins_runtime_register_command(
    app: AppHandle,
    state: State<'_, crate::plugins::broker::PluginBrokerState>,
    runtime_instance_id: String,
    command_id: String,
    title: String,
) -> Result<(), String> {
    state
        .authorize_command_registration(&app, &runtime_instance_id, &command_id, &title)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn plugins_runtime_register_pane(
    app: AppHandle,
    state: State<'_, crate::plugins::broker::PluginBrokerState>,
    runtime_instance_id: String,
    pane_kind_id: String,
) -> Result<Option<crate::plugins::broker::PluginPaneRegistration>, String> {
    state
        .register_pane(&app, &runtime_instance_id, &pane_kind_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn plugins_storage_get(
    app: AppHandle,
    broker: State<'_, crate::plugins::broker::PluginBrokerState>,
    storage: State<'_, crate::plugins::storage::PluginStorageState>,
    runtime_instance_id: String,
    key: String,
) -> Result<Option<String>, String> {
    let principal = broker
        .authorize_principal(&app, &runtime_instance_id, "filesystem.pluginData.read")
        .map_err(|error| error.to_string())?;
    storage
        .get(&app, &principal, &key)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn plugins_storage_keys(
    app: AppHandle,
    broker: State<'_, crate::plugins::broker::PluginBrokerState>,
    storage: State<'_, crate::plugins::storage::PluginStorageState>,
    runtime_instance_id: String,
) -> Result<Vec<String>, String> {
    let principal = broker
        .authorize_principal(&app, &runtime_instance_id, "filesystem.pluginData.read")
        .map_err(|error| error.to_string())?;
    storage
        .keys(&app, &principal)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn plugins_storage_set(
    app: AppHandle,
    broker: State<'_, crate::plugins::broker::PluginBrokerState>,
    storage: State<'_, crate::plugins::storage::PluginStorageState>,
    runtime_instance_id: String,
    key: String,
    value: String,
) -> Result<(), String> {
    let principal = broker
        .authorize_principal(&app, &runtime_instance_id, "filesystem.pluginData.write")
        .map_err(|error| error.to_string())?;
    storage
        .set(&app, &principal, &key, &value)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn plugins_storage_delete(
    app: AppHandle,
    broker: State<'_, crate::plugins::broker::PluginBrokerState>,
    storage: State<'_, crate::plugins::storage::PluginStorageState>,
    runtime_instance_id: String,
    key: String,
) -> Result<bool, String> {
    let principal = broker
        .authorize_principal(&app, &runtime_instance_id, "filesystem.pluginData.write")
        .map_err(|error| error.to_string())?;
    storage
        .delete(&app, &principal, &key)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn plugins_filesystem_pick(
    app: AppHandle,
    broker: State<'_, crate::plugins::broker::PluginBrokerState>,
    filesystem: State<'_, crate::plugins::filesystem::PluginFilesystemState>,
    runtime_instance_id: String,
    request: crate::plugins::filesystem::PluginFilesystemPickRequest,
) -> Result<Option<crate::plugins::filesystem::PluginFilesystemHandle>, String> {
    use tauri_plugin_dialog::DialogExt;

    broker
        .authorize(&app, &runtime_instance_id, "filesystem.external.read")
        .map_err(|error| error.to_string())?;
    let kind = request.kind;
    let app_for_picker = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || match kind {
        crate::plugins::filesystem::PluginFilesystemPickKind::File => {
            app_for_picker.dialog().file().blocking_pick_file()
        }
        crate::plugins::filesystem::PluginFilesystemPickKind::Directory => {
            app_for_picker.dialog().file().blocking_pick_folder()
        }
    })
    .await
    .map_err(|error| format!("Plugin file picker task failed: {error}"))?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    filesystem
        .issue_handle(
            &app,
            &runtime_instance_id,
            &std::path::PathBuf::from(selected.to_string()),
            kind,
        )
        .map(Some)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn plugins_runtime_optional_permission(
    app: AppHandle,
    broker: State<'_, crate::plugins::broker::PluginBrokerState>,
    runtime_instance_id: String,
    capability: String,
    approved_digest: Option<String>,
) -> Result<Option<crate::plugins::broker::OptionalPermissionPrompt>, String> {
    broker
        .optional_permission(
            &app,
            &runtime_instance_id,
            &capability,
            approved_digest.as_deref(),
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn plugins_filesystem_pick_write_file(
    app: AppHandle,
    broker: State<'_, crate::plugins::broker::PluginBrokerState>,
    filesystem: State<'_, crate::plugins::filesystem::PluginFilesystemState>,
    runtime_instance_id: String,
) -> Result<Option<crate::plugins::filesystem::PluginFilesystemHandle>, String> {
    use tauri_plugin_dialog::DialogExt;

    broker
        .authorize(&app, &runtime_instance_id, "filesystem.external.write")
        .map_err(|error| error.to_string())?;
    let app_for_picker = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app_for_picker.dialog().file().blocking_save_file()
    })
    .await
    .map_err(|error| format!("Plugin save picker task failed: {error}"))?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    filesystem
        .issue_write_file_handle(
            &app,
            &runtime_instance_id,
            &std::path::PathBuf::from(selected.to_string()),
        )
        .map(Some)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn plugins_filesystem_read_text(
    app: AppHandle,
    broker: State<'_, crate::plugins::broker::PluginBrokerState>,
    filesystem: State<'_, crate::plugins::filesystem::PluginFilesystemState>,
    runtime_instance_id: String,
    handle: String,
    relative_path: Option<String>,
) -> Result<String, String> {
    broker
        .authorize(&app, &runtime_instance_id, "filesystem.external.read")
        .map_err(|error| error.to_string())?;
    filesystem
        .read_text(
            &app,
            &runtime_instance_id,
            &handle,
            relative_path.as_deref(),
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn plugins_filesystem_write_text(
    app: AppHandle,
    broker: State<'_, crate::plugins::broker::PluginBrokerState>,
    filesystem: State<'_, crate::plugins::filesystem::PluginFilesystemState>,
    runtime_instance_id: String,
    handle: String,
    content: String,
) -> Result<(), String> {
    broker
        .authorize(&app, &runtime_instance_id, "filesystem.external.write")
        .map_err(|error| error.to_string())?;
    filesystem
        .write_text(&app, &runtime_instance_id, &handle, &content)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn plugins_filesystem_list(
    app: AppHandle,
    broker: State<'_, crate::plugins::broker::PluginBrokerState>,
    filesystem: State<'_, crate::plugins::filesystem::PluginFilesystemState>,
    runtime_instance_id: String,
    handle: String,
    relative_path: Option<String>,
) -> Result<Vec<crate::plugins::filesystem::PluginFilesystemEntry>, String> {
    broker
        .authorize(&app, &runtime_instance_id, "filesystem.external.read")
        .map_err(|error| error.to_string())?;
    filesystem
        .list(
            &app,
            &runtime_instance_id,
            &handle,
            relative_path.as_deref(),
        )
        .map_err(|error| error.to_string())
}

const MAX_PLUGIN_SSH_PATH_BYTES: usize = 1024;
const MAX_PLUGIN_SSH_TEXT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_PLUGIN_SSH_DIRECTORY_ENTRIES: usize = 500;

fn validate_plugin_ssh_relative_path(path: &str, allow_empty: bool) -> Result<Vec<&str>, String> {
    if (!allow_empty && path.trim().is_empty()) || path.len() > MAX_PLUGIN_SSH_PATH_BYTES {
        return Err("Server filesystem relative path is invalid".into());
    }
    if path.contains('\0') || path.starts_with('/') || path.starts_with('\\') {
        return Err("Server filesystem paths must be relative to the server home folder".into());
    }
    let mut components = Vec::new();
    for component in path.split('/') {
        if component.is_empty() || component == "." {
            continue;
        }
        if component == ".." || component.contains('\\') {
            return Err("Server filesystem paths cannot leave the server home folder".into());
        }
        components.push(component);
    }
    if !allow_empty && components.is_empty() {
        return Err("Server filesystem relative path is required".into());
    }
    Ok(components)
}

#[cfg(test)]
mod plugin_ssh_filesystem_path_tests {
    use super::validate_plugin_ssh_relative_path;

    #[test]
    fn accepts_only_home_relative_paths() {
        assert!(validate_plugin_ssh_relative_path("", true).is_ok());
        assert!(validate_plugin_ssh_relative_path("projects/zync/README.md", false).is_ok());
        assert!(validate_plugin_ssh_relative_path("../secret", false).is_err());
        assert!(validate_plugin_ssh_relative_path("/etc/passwd", false).is_err());
        assert!(validate_plugin_ssh_relative_path("projects\\secret", false).is_err());
    }
}

async fn resolve_plugin_ssh_path(
    sftp: &russh_sftp::client::SftpSession,
    relative_path: &str,
    allow_empty: bool,
) -> Result<String, String> {
    let components = validate_plugin_ssh_relative_path(relative_path, allow_empty)?;
    let home = tokio::time::timeout(Duration::from_secs(10), sftp.canonicalize("."))
        .await
        .map_err(|_| "DISCONNECTED: SFTP cwd timed out after 10s".to_string())?
        .map_err(|error| error.to_string())?;
    let requested = components
        .into_iter()
        .fold(home.clone(), |mut path, component| {
            if !path.ends_with('/') {
                path.push('/');
            }
            path.push_str(component);
            path
        });
    let resolved = tokio::time::timeout(Duration::from_secs(10), sftp.canonicalize(&requested))
        .await
        .map_err(|_| "DISCONNECTED: SFTP path resolution timed out after 10s".to_string())?
        .map_err(|error| error.to_string())?;
    let home_prefix = if home.ends_with('/') {
        home
    } else {
        format!("{home}/")
    };
    if resolved != home_prefix.trim_end_matches('/') && !resolved.starts_with(&home_prefix) {
        return Err("Server filesystem path resolves outside the server home folder".into());
    }
    Ok(resolved)
}

#[tauri::command]
pub async fn plugins_runtime_bind_pane(
    app: AppHandle,
    broker: State<'_, crate::plugins::broker::PluginBrokerState>,
    runtime_instance_id: String,
    pane_kind_id: String,
    pane_instance_id: String,
    connection_id: String,
) -> Result<(), String> {
    broker
        .authorize(&app, &runtime_instance_id, "ui.pane.register")
        .map_err(|error| error.to_string())?;
    broker
        .bind_pane_connection(
            &runtime_instance_id,
            &pane_kind_id,
            &pane_instance_id,
            &connection_id,
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn plugins_runtime_unbind_pane(
    broker: State<'_, crate::plugins::broker::PluginBrokerState>,
    runtime_instance_id: String,
    pane_instance_id: String,
) -> Result<(), String> {
    broker.unbind_pane_connection(&runtime_instance_id, &pane_instance_id);
    Ok(())
}

#[tauri::command]
pub async fn plugins_ssh_filesystem_list(
    app: AppHandle,
    broker: State<'_, crate::plugins::broker::PluginBrokerState>,
    state: State<'_, AppState>,
    runtime_instance_id: String,
    pane_instance_id: String,
    relative_path: Option<String>,
) -> Result<Vec<crate::plugins::ssh_filesystem::PluginSshFilesystemEntry>, String> {
    let connection_id = broker
        .authorize_pane_connection(
            &app,
            &runtime_instance_id,
            &pane_instance_id,
            "ssh.filesystem.read",
        )
        .map_err(|error| error.to_string())?;
    if connection_id == "local" {
        return Err("This pane is local. Use the local filesystem picker instead.".into());
    }
    let requested_path = relative_path.unwrap_or_default();
    let (sftp, identity_cache) = sftp_list_ctx(&state, &connection_id).await?;
    let resolved_path = resolve_plugin_ssh_path(&sftp, &requested_path, true).await?;
    let entries = tokio::time::timeout(
        Duration::from_secs(10),
        state
            .file_system
            .list_remote(&sftp, &resolved_path, &identity_cache),
    )
    .await
    .map_err(|_| "DISCONNECTED: SFTP listing timed out after 10s".to_string())?
    .map_err(|error| error.to_string())?;
    if entries.len() > MAX_PLUGIN_SSH_DIRECTORY_ENTRIES {
        return Err(format!(
            "Server folder contains more than {MAX_PLUGIN_SSH_DIRECTORY_ENTRIES} visible entries"
        ));
    }
    Ok(entries
        .into_iter()
        .map(crate::plugins::ssh_filesystem::PluginSshFilesystemEntry::from)
        .collect())
}

#[tauri::command]
pub async fn plugins_ssh_filesystem_read_text(
    app: AppHandle,
    broker: State<'_, crate::plugins::broker::PluginBrokerState>,
    state: State<'_, AppState>,
    runtime_instance_id: String,
    pane_instance_id: String,
    relative_path: String,
) -> Result<String, String> {
    let connection_id = broker
        .authorize_pane_connection(
            &app,
            &runtime_instance_id,
            &pane_instance_id,
            "ssh.filesystem.read",
        )
        .map_err(|error| error.to_string())?;
    if connection_id == "local" {
        return Err("This pane is local. Use the local filesystem picker instead.".into());
    }
    let sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
    let resolved_path = resolve_plugin_ssh_path(&sftp, &relative_path, false).await?;
    let metadata = tokio::time::timeout(Duration::from_secs(10), sftp.metadata(&resolved_path))
        .await
        .map_err(|_| "DISCONNECTED: SFTP metadata timed out after 10s".to_string())?
        .map_err(|error| error.to_string())?;
    if metadata.size.unwrap_or(MAX_PLUGIN_SSH_TEXT_BYTES + 1) > MAX_PLUGIN_SSH_TEXT_BYTES {
        return Err(format!(
            "Server file exceeds the {MAX_PLUGIN_SSH_TEXT_BYTES}-byte text limit"
        ));
    }
    let text = read_remote_connection_file(&state, &connection_id, &resolved_path, 10, None).await?;
    if text.len() > MAX_PLUGIN_SSH_TEXT_BYTES as usize {
        return Err(format!(
            "Server file exceeds the {MAX_PLUGIN_SSH_TEXT_BYTES}-byte text limit"
        ));
    }
    Ok(text)
}

#[tauri::command]
pub async fn plugins_runtime_stop(
    state: State<'_, crate::plugins::broker::PluginBrokerState>,
    filesystem: State<'_, crate::plugins::filesystem::PluginFilesystemState>,
    runtime_instance_id: String,
) -> Result<(), String> {
    filesystem.revoke_runtime(&runtime_instance_id);
    state.stop_runtime(&runtime_instance_id);
    Ok(())
}

#[tauri::command]
pub async fn plugins_runtime_reset(
    state: State<'_, crate::plugins::broker::PluginBrokerState>,
    filesystem: State<'_, crate::plugins::filesystem::PluginFilesystemState>,
) -> Result<(), String> {
    filesystem.reset();
    state.reset_worker_runtimes();
    Ok(())
}

#[tauri::command]
pub async fn plugins_network_fetch(
    app: AppHandle,
    broker: State<'_, crate::plugins::broker::PluginBrokerState>,
    runtime_instance_id: String,
    request: crate::plugins::network::PluginNetworkFetchRequest,
) -> Result<crate::plugins::network::PluginNetworkFetchResponse, String> {
    let grant = broker
        .authorize_network_fetch(&app, &runtime_instance_id)
        .map_err(|error| error.to_string())?;
    crate::plugins::network::fetch(&grant, request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn plugins_recovery_status(
    state: State<'_, crate::plugins::recovery::PluginRecoveryState>,
) -> Result<crate::plugins::recovery::PluginRecoveryStatus, String> {
    state.status().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn plugins_recovery_record_failure(
    state: State<'_, crate::plugins::recovery::PluginRecoveryState>,
    plugin_id: String,
    kind: String,
) -> Result<(), String> {
    state
        .record_failure(&plugin_id, &kind)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn plugins_recovery_clear_safe_mode(
    state: State<'_, crate::plugins::recovery::PluginRecoveryState>,
) -> Result<(), String> {
    state.clear_safe_mode().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn plugins_recovery_clear_plugin_failures(
    state: State<'_, crate::plugins::recovery::PluginRecoveryState>,
    plugin_id: String,
) -> Result<(), String> {
    state
        .clear_plugin_failures(&plugin_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn plugins_management_details(
    app: AppHandle,
    storage: State<'_, crate::plugins::storage::PluginStorageState>,
    plugin_id: String,
) -> Result<crate::plugins::management::PluginManagementDetails, String> {
    crate::plugins::management::details(&app, &storage, &plugin_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn plugins_management_set_optional_permissions(
    app: AppHandle,
    broker: State<'_, crate::plugins::broker::PluginBrokerState>,
    plugin_id: String,
    optional_permission_ids: Vec<String>,
) -> Result<crate::plugins::management::PluginGrantSummary, String> {
    let result = crate::plugins::management::set_optional_permissions(
        &app,
        &plugin_id,
        optional_permission_ids,
    )
    .map_err(|error| error.to_string())?;
    // In-flight commands must lose their leases immediately, not just after the
    // frontend notices the permission change and replaces the worker.
    broker.stop_plugin(&plugin_id);
    Ok(result)
}

#[tauri::command]
pub async fn plugins_management_clear_storage(
    app: AppHandle,
    broker: State<'_, crate::plugins::broker::PluginBrokerState>,
    storage: State<'_, crate::plugins::storage::PluginStorageState>,
    plugin_id: String,
) -> Result<bool, String> {
    // Revoke the live native identity before deleting data so a still-closing Worker
    // cannot immediately recreate the store after this command returns.
    broker.stop_plugin(&plugin_id);
    crate::plugins::management::clear_storage(&app, &storage, &plugin_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn plugins_uninstall(
    app: AppHandle,
    broker: State<'_, crate::plugins::broker::PluginBrokerState>,
    recovery: State<'_, crate::plugins::recovery::PluginRecoveryState>,
    storage: State<'_, crate::plugins::storage::PluginStorageState>,
    id: String,
    delete_data: Option<bool>,
) -> Result<crate::plugins::management::PluginUninstallResult, String> {
    broker.stop_plugin(&id);
    let result =
        crate::plugins::management::uninstall(&app, &storage, &id, delete_data.unwrap_or(false))
            .map_err(|error| error.to_string())?;
    if let Err(error) = recovery.clear_plugin_failures(&id) {
        log::warn!("[Plugins] Failed to clear recovery diagnostics after uninstall: {error}");
    }
    Ok(result)
}

#[tauri::command]
pub async fn plugin_fs_read(path: String, state: State<'_, AppState>) -> Result<String, String> {
    state
        .file_system
        .read_file("local", &path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn plugin_fs_write(
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .file_system
        .write_file("local", &path, &content)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn plugin_fs_list(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<FileEntry>, String> {
    state
        .file_system
        .list_local(&path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn plugin_fs_exists(path: String, state: State<'_, AppState>) -> Result<bool, String> {
    state
        .file_system
        .exists("local", &path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn plugin_fs_create_dir(path: String, state: State<'_, AppState>) -> Result<(), String> {
    state
        .file_system
        .create_dir("local", &path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn config_select_folder(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let app_for_picker = app.clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        app_for_picker.dialog().file().blocking_pick_folder()
    })
    .await
    .map_err(|e| format!("Folder picker task failed: {}", e))?;
    Ok(path.map(|p| p.to_string()))
}

#[tauri::command]
#[cfg_attr(target_os = "windows", allow(unused_variables))]
pub async fn system_install_cli(app: AppHandle) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        return Ok("Windows: Please add installation folder to PATH manually.".into());
    }

    #[cfg(not(target_os = "windows"))]
    {
        use tauri::Manager;
        let home = app.path().home_dir().map_err(|e| e.to_string())?;
        let local_bin = home.join(".local/bin");

        if !local_bin.exists() {
            std::fs::create_dir_all(&local_bin).map_err(|e| e.to_string())?;
        }

        let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
        let target_path = local_bin.join("zync");

        // Remove existing if any
        if target_path.exists() {
            std::fs::remove_file(&target_path).map_err(|e| e.to_string())?;
        }

        std::os::unix::fs::symlink(exe_path, &target_path).map_err(|e| e.to_string())?;

        Ok(format!("Installed zync to {:?}", target_path))
    }
}

#[tauri::command]
pub async fn ssh_parse_command(command: String) -> Result<crate::ssh_parser::ParseResult, String> {
    Ok(crate::ssh_parser::parse_ssh_command(&command))
}

// â”€â”€â”€ Download as Tar (SSH exec + tar streaming) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/// Shell-quote a path so it can be safely embedded in a remote command string.
pub(crate) fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn remote_copy_command(from: &str, to: &str) -> String {
    format!("cp -r -- {} {}", shell_quote(from), shell_quote(to))
}

fn remote_remove_command(paths: &[String]) -> String {
    format!("rm -rf -- {}", paths.iter().map(|path| shell_quote(path)).collect::<Vec<_>>().join(" "))
}

const MAX_REMOTE_REMOVE_COMMAND_BYTES: usize = 32 * 1024;

/// Budget the final UTF-8 shell argument, including quoting expansion. Oversize
/// requests skip exec before any mutation, retaining the existing SFTP fallback.
fn remote_remove_command_for_exec(paths: &[String]) -> Option<String> {
    let command = remote_remove_command(paths);
    (command.len() <= MAX_REMOTE_REMOVE_COMMAND_BYTES).then_some(command)
}

/// Each tar member is an explicit relative operand, never a command-line option.
fn remote_archive_command(paths: &[String]) -> Result<String, String> {
    let mut args = String::new();
    for path in paths {
        let trimmed = path.trim_end_matches('/');
        if trimmed.is_empty() { continue; }
        let (parent, name) = match trimmed.rsplit_once('/') {
            Some((parent, name)) => (if parent.is_empty() { "/" } else { parent }, name),
            None => (".", trimmed),
        };
        args.push_str(&format!(" -C {} {}", shell_quote(parent), shell_quote(&format!("./{name}"))));
    }
    if args.is_empty() { return Err("No valid paths to archive".into()); }
    Ok(format!("tar -czf -{args}"))
}

#[cfg(test)]
mod remote_mutation_command_tests {
    use super::{copy_access_timeout, remote_copy_command, remote_remove_command, remote_remove_command_for_exec,
        remote_archive_command, transfer_not_started_error, MAX_REMOTE_REMOVE_COMMAND_BYTES};

    #[test]
    fn copy_access_timeout_scales_with_the_validated_source_count() {
        assert_eq!(copy_access_timeout(1).as_secs(), 33);
        assert_eq!(copy_access_timeout(16).as_secs(), 78);
        assert_eq!(copy_access_timeout(64).as_secs(), 222);
        assert!(copy_access_timeout(64) > copy_access_timeout(1));
    }

    #[test]
    fn delete_exec_budget_measures_final_utf8_and_shell_quoting_bytes() {
        let overhead = remote_remove_command(&[String::new()]).len();
        let boundary = "a".repeat(MAX_REMOTE_REMOVE_COMMAND_BYTES - overhead);
        let command = remote_remove_command_for_exec(&[boundary.clone()]).unwrap();
        assert_eq!(command.len(), MAX_REMOTE_REMOVE_COMMAND_BYTES);
        assert!(remote_remove_command_for_exec(&[format!("{boundary}a")]).is_none());
        assert!(remote_remove_command_for_exec(&["'".repeat(MAX_REMOTE_REMOVE_COMMAND_BYTES / 2)]).is_none());
        assert!(remote_remove_command_for_exec(&["文".repeat(MAX_REMOTE_REMOVE_COMMAND_BYTES / 2)]).is_none());
        let paths = vec!["/folder/name".repeat(500); 10];
        assert!(remote_remove_command_for_exec(&paths).is_none());
        let small = vec!["-backup".into(), "quote'file".into()];
        assert_eq!(remote_remove_command_for_exec(&small), Some(remote_remove_command(&small)));
    }

    #[tokio::test]
    async fn oversized_delete_exec_uses_the_existing_pre_execution_fallback() {
        let command = remote_remove_command_for_exec(&["x".repeat(MAX_REMOTE_REMOVE_COMMAND_BYTES)]);
        let mut fallback_calls = 0;
        crate::transfers::mutation_with_safe_fallback(async {
            assert!(command.is_none(), "Oversized commands cannot enter the SSH attempt");
            Ok(false)
        }, async {
            fallback_calls += 1;
            Ok(())
        }).await.unwrap();
        assert_eq!(fallback_calls, 1);
    }

    #[test]
    fn archive_members_cannot_be_interpreted_as_tar_options() {
        assert_eq!(remote_archive_command(&["/tmp/-Tsecret".into(), "/home/quote'file".into()]).unwrap(),
            "tar -czf - -C '/tmp' './-Tsecret' -C '/home' './quote'\\''file'");
        assert_eq!(remote_archive_command(&["relative".into()]).unwrap(), "tar -czf - -C '.' './relative'");
        assert!(remote_archive_command(&["/".into(), "".into()]).is_err());
    }

    #[test]
    fn admission_errors_are_unchanged_destinations_without_reclassifying_cancellation() {
        assert_eq!(transfer_not_started_error("Queue full".into()), "TRANSFER_NOT_STARTED:Queue full");
        assert_eq!(transfer_not_started_error("Cancelled".into()), "Cancelled");
    }

    #[test]
    fn option_terminator_precedes_quoted_file_operands() {
        assert_eq!(remote_copy_command("-source", "-target"), "cp -r -- '-source' '-target'");
        assert_eq!(remote_remove_command(&["-backup".into(), "quote'file".into()]), "rm -rf -- '-backup' 'quote'\\''file'");
    }
}

fn archive_exit_result(exit_status: Option<u32>, stderr: &[u8]) -> Result<(), String> {
    match exit_status {
        Some(0) => Ok(()),
        Some(status) => Err(format!(
            "tar failed (exit {}): {}",
            status,
            String::from_utf8_lossy(stderr).trim()
        )),
        None => Err("Archive command closed without an exit status".to_string()),
    }
}

/// Remote diagnostics must not grow without bound while an archive is streaming.
fn append_archive_stderr(buffer: &mut Vec<u8>, data: &[u8]) {
    const MAX_BYTES: usize = 16 * 1024;
    let count = data.len().min(MAX_BYTES.saturating_sub(buffer.len()));
    buffer.extend_from_slice(&data[..count]);
}

fn archive_output_result(result: Result<(), String>, output_path: &str) -> Result<(), String> {
    result.map_err(|error| {
        // Only a confirmed close preserves exact cancellation. The transfer row
        // already names its destination and warns that incomplete output may remain.
        if error == "Cancelled" { return error; }
        format!("{}; Archive output may be incomplete at '{}'; check it before retrying", error, output_path)
    })
}

#[cfg(test)]
mod archive_result_tests {
    use super::{archive_exit_result, archive_output_result, append_archive_stderr};

    #[test]
    fn archive_diagnostics_are_bounded_and_keep_the_first_error() {
        let mut buffer = Vec::new();
        append_archive_stderr(&mut buffer, b"Permission denied\n");
        for _ in 0..10 { append_archive_stderr(&mut buffer, &[b'x'; 8192]); }
        assert_eq!(buffer.len(), 16 * 1024);
        assert!(buffer.starts_with(b"Permission denied\n"));
    }

    #[test]
    fn only_a_confirmed_zero_exit_status_is_success() {
        assert!(archive_exit_result(Some(0), b"").is_ok());
        assert_eq!(
            archive_exit_result(Some(2), b" permission denied\n"),
            Err("tar failed (exit 2): permission denied".to_string())
        );
        assert!(archive_exit_result(None, b"").is_err());
    }

    #[test]
    fn unsuccessful_created_output_is_retained_with_its_location_and_original_error() {
        assert!(archive_output_result(Ok(()), "/downloads/archive.tar.gz").is_ok());
        assert_eq!(archive_output_result(Err("Cancelled".into()), "/downloads/archive.tar.gz"), Err("Cancelled".into()));
        for error in ["Write failed", "Destination close failed", "Cancelled; Destination close failed"] {
            let result = archive_output_result(Err(error.into()), "/downloads/archive.tar.gz").unwrap_err();
            assert!(result.starts_with(error));
            assert!(result.contains("/downloads/archive.tar.gz"));
            assert!(result.contains("may be incomplete"));
            assert_ne!(result, "Cancelled");
        }
    }
}

/// Download selected remote files/directories as a .tar.gz archive.
///
/// Uses SSH exec to run `tar -czf - -C <parent> <name> ...` on the server and
/// streams the output directly to a local file â€” a single SSH channel handles
/// everything regardless of how many files are selected.
#[tauri::command]
pub async fn sftp_download_as_zip(
    app: AppHandle,
    id: String,
    remote_paths: Vec<String>,
    local_path: String,
    transfer_id: String,
    wait_for_completion: Option<bool>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if remote_paths.is_empty() {
        return Err("No files selected for download".to_string());
    }

    let app_handle = app.clone();
    let outcome_app = app.clone();
    let connection_id = id.clone();
    let tid = transfer_id.clone();

    crate::transfers::start_transfer(
        state.transfers.clone(),
        transfer_id.clone(),
        wait_for_completion.unwrap_or(false),
        move |cancel_token| async move {
            let state_ref = app_handle.state::<AppState>();
            crate::transfers::check_cancelled(&cancel_token)?;
            // Estimate total size after registration, so setup failures are terminal too.
            let sftp = get_sftp_or_reconnect(&state_ref, &connection_id).await?;
            let mut total_size = 0;
            for path in &remote_paths {
                crate::transfers::check_cancelled(&cancel_token)?;
                total_size += get_remote_size(&sftp, path).await;
            }
            let total_size = total_size.max(1);
            crate::transfers::check_cancelled(&cancel_token)?;
            // Get the SSH session handle (not SFTP).
            let session = {
                let conns = state_ref.connections.lock().await;
                conns
                    .get(&connection_id)
                    .ok_or_else(|| format!("Connection '{}' not found", connection_id))?
                    .session
                    .clone()
                    .ok_or_else(|| "SSH session not initialised".to_string())?
            };

            let tar_cmd = remote_archive_command(&remote_paths)?;

            // Open SSH exec channel.
            let mut channel = session
                .lock()
                .await
                .channel_open_session()
                .await
                .map_err(|e| format!("Failed to open SSH channel: {}", e))?;
            channel
                .exec(true, tar_cmd.as_str())
                .await
                .map_err(|e| format!("Failed to exec tar: {}", e))?;

            // Ensure parent directory exists.
            if let Some(parent) = std::path::Path::new(&local_path).parent() {
                if !parent.exists() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("Cannot create output directory: {}", e))?;
                }
            }

            let mut out_file = tokio::fs::File::create(&local_path)
                .await
                .map_err(|e| format!("Cannot create output file: {}", e))?;

            let _ = app_handle.emit(
                "transfer-progress",
                TransferProgress {
                    id: tid.clone(),
                    transferred: 0,
                    total: total_size,
                },
            );

            let mut bytes_written: u64 = 0;
            let mut exit_status = None;
            let mut last_emit = std::time::Instant::now();
            let mut stderr_buf: Vec<u8> = Vec::new();

            let archive_result = async {
                // Stream tar output to local file.
                while let Some(msg) = channel.wait().await {
                    if cancel_token.load(std::sync::atomic::Ordering::Relaxed) {
                        return Err("Cancelled".to_string());
                    }
                    match msg {
                        russh::ChannelMsg::Data { ref data } => {
                            use tokio::io::AsyncWriteExt;
                            out_file
                                .write_all(data)
                                .await
                                .map_err(|e| format!("Write failed: {}", e))?;
                            bytes_written += data.len() as u64;
                            if last_emit.elapsed().as_millis() >= 150 {
                                let _ = app_handle.emit(
                                    "transfer-progress",
                                    TransferProgress {
                                        id: tid.clone(),
                                        transferred: bytes_written.min(total_size),
                                        total: total_size,
                                    },
                                );
                                last_emit = std::time::Instant::now();
                            }
                        }
                        russh::ChannelMsg::ExtendedData { ref data, .. } => {
                            append_archive_stderr(&mut stderr_buf, data);
                        }
                        russh::ChannelMsg::ExitStatus { exit_status: code } => {
                            exit_status = Some(code);
                        }
                        _ => {}
                    }
                }

                archive_exit_result(exit_status, &stderr_buf)?;
                Ok(())
            }
            .await;
            let result = crate::transfers::finish_destination(&mut out_file, archive_result).await;
            archive_output_result(result, &local_path)?;

            // Preserve actual archive bytes; total_size is only the source-size estimate.
            let _ = app_handle.emit(
                "transfer-progress",
                TransferProgress {
                    id: tid.clone(),
                    transferred: bytes_written,
                    total: total_size,
                },
            );

            Ok(())
        },
        move |result| emit_transfer_outcome(&outcome_app, &transfer_id, "local", result),
    )
    .await
}

#[tauri::command]
pub async fn ai_translate(
    app: AppHandle,
    vault: State<'_, Mutex<crate::vault::store::VaultService>>,
    query: String,
    context: crate::ai::TerminalContext,
    request_id: String,
) -> Result<crate::ai::AiTranslateResponse, String> {
    let config = require_enabled_ai(&app, &vault).await?;
    crate::ai::translate(&app, query, context, request_id, config).await
}

#[tauri::command]
pub async fn ai_translate_stream(
    app: AppHandle,
    vault: State<'_, Mutex<crate::vault::store::VaultService>>,
    query: String,
    context: crate::ai::TerminalContext,
    request_id: String,
    history: Vec<crate::ai::ChatMessage>,
) -> Result<(), String> {
    let config = require_enabled_ai(&app, &vault).await?;
    tauri::async_runtime::spawn(crate::ai::translate_stream(
        app, query, context, request_id, config, history,
    ));
    Ok(())
}

#[tauri::command]
pub async fn ai_check_ollama(
    app: AppHandle,
    vault: State<'_, Mutex<crate::vault::store::VaultService>>,
) -> Result<bool, String> {
    let config = require_enabled_ai(&app, &vault).await?;
    let url = config
        .ollama_url
        .as_deref()
        .unwrap_or("http://localhost:11434");
    Ok(crate::ai::check_ollama(url).await)
}

#[tauri::command]
pub async fn ai_get_ollama_models(
    app: AppHandle,
    vault: State<'_, Mutex<crate::vault::store::VaultService>>,
) -> Result<Vec<String>, String> {
    let config = require_enabled_ai(&app, &vault).await?;
    crate::ai::get_ollama_models(&config).await
}

#[tauri::command]
pub async fn ai_get_provider_models(
    app: AppHandle,
    vault: State<'_, Mutex<crate::vault::store::VaultService>>,
) -> Result<Vec<String>, String> {
    let config = require_enabled_ai(&app, &vault).await?;
    crate::ai::get_provider_models(&config).await
}

// Agent v2 commands

/// Start an agentic run. Returns immediately; the loop runs in the background
/// and emits events: ai:agent-thinking, ai:tool-start, ai:tool-output,
/// ai:tool-done, ai:tool-diff, ai:agent-checkpoint, ai:agent-done, ai:agent-error.
#[tauri::command]
pub async fn ai_agent_run(
    app: AppHandle,
    state: State<'_, AppState>,
    vault: State<'_, Mutex<crate::vault::store::VaultService>>,
    request: crate::ai::AgentRunRequest,
) -> Result<(), String> {
    let config = require_enabled_ai(&app, &vault).await?;

    let cancel = Arc::new(AtomicBool::new(false));
    let run_id = request.run_id.clone();

    {
        let mut runs = state.agent_runs.lock().await;
        runs.insert(run_id.clone(), cancel.clone());
    }

    // Clone what we need to move into the spawned task
    let app_clone = app.clone();
    let state_clone = state.inner().clone();

    tokio::spawn(async move {
        crate::ai::agent_loop::run(&app_clone, &state_clone, request, config, cancel).await;

        // Clean up run entry when the loop finishes
        let mut runs = state_clone.agent_runs.lock().await;
        runs.remove(&run_id);
    });

    Ok(())
}

async fn require_enabled_ai(
    app: &AppHandle,
    vault: &State<'_, Mutex<crate::vault::store::VaultService>>,
) -> Result<crate::ai::AiConfig, String> {
    let vault = vault.lock().await;
    let config = crate::ai::read_ai_config(app, &vault);
    if !config.enabled {
        return Err("AI is disabled in Settings -> AI.".to_string());
    }
    Ok(config)
}

/// Cancel a running agent loop by its run_id.
#[tauri::command]
pub async fn ai_agent_stop(state: State<'_, AppState>, run_id: String) -> Result<(), String> {
    let runs = state.agent_runs.lock().await;
    if let Some(cancel) = runs.get(&run_id) {
        cancel.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(())
}

/// Respond to a pending ask_user checkpoint inside an agent run.
/// `proceed = true` means continue; `proceed = false` means stop.
#[tauri::command]
pub async fn ai_agent_checkpoint_respond(
    state: State<'_, AppState>,
    checkpoint_id: String,
    proceed: bool,
) -> Result<(), String> {
    let mut checkpoints = state.agent_checkpoints.lock().await;
    if let Some(tx) = checkpoints.remove(&checkpoint_id) {
        let _ = tx.send(proceed);
    }
    Ok(())
}

/// Add a command to the per-scope whitelist so it bypasses safety-net checkpoints
/// for the rest of this session. Scope is the connection_id or "local".
#[tauri::command]
pub async fn ai_agent_whitelist_command(
    state: State<'_, AppState>,
    scope: String,
    command: String,
) -> Result<(), String> {
    let mut whitelist = state.command_whitelist.lock().await;
    whitelist.entry(scope).or_default().insert(command);
    Ok(())
}

/// Clear specific brain session folders by their absolute paths.
/// Only deletes directories that live inside the brain/ folder (safety check).
#[tauri::command]
pub async fn ai_clear_brain_sessions(
    app: tauri::AppHandle,
    paths: Vec<String>,
) -> Result<(), String> {
    let data_dir = get_data_dir(&app);
    let brain_dir = data_dir.join("brain");

    let canon_brain = match std::fs::canonicalize(&brain_dir) {
        Ok(p) => p,
        Err(_) => return Ok(()), // brain dir doesn't exist yet
    };

    for path_str in &paths {
        let path = std::path::PathBuf::from(path_str);
        // Safety: canonicalize to resolve any ".." and verify containment.
        let canon_path = match std::fs::canonicalize(&path) {
            Ok(p) => p,
            Err(_) => continue, // path doesn't exist or is inaccessible, skip
        };
        // Only delete if it's a session folder exactly 2 levels deep:
        // brain/{connection}/{session} — prevents deleting brain/ or brain/{connection}/.
        if canon_path.starts_with(&canon_brain) && canon_path.is_dir() {
            if let Ok(rel) = canon_path.strip_prefix(&canon_brain) {
                if rel.components().count() == 2 {
                    let _ = std::fs::remove_dir_all(&canon_path);
                }
            }
        }
    }

    // Clean up empty connection folders left behind after session deletion.
    if brain_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&brain_dir) {
            for entry in entries.flatten() {
                let dir = entry.path();
                if dir.is_dir() {
                    let is_empty = std::fs::read_dir(&dir)
                        .map(|mut d| d.next().is_none())
                        .unwrap_or(false);
                    if is_empty {
                        let _ = std::fs::remove_dir(&dir);
                    }
                }
            }
        }
    }
    Ok(())
}
