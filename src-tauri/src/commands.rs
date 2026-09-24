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
use std::time::{Duration, SystemTime, UNIX_EPOCH};
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
const MAX_SFTP_RETRIES: u8 = 3;
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
static PLUGIN_WINDOW_TEMP_FILES: LazyLock<StdMutex<HashMap<String, std::path::PathBuf>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));
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
    pub transfers: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
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
    pub sftp_identity_maps: Arc<tokio::sync::OnceCell<SftpIdentityMaps>>,
    pub detected_os: Option<String>,
    pub detected_shell: Option<String>,
    /// SSH userauth banner, shown once when this connection opens its first terminal.
    pub auth_banner: Option<String>,
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
    let (session, auth_banner) = ssh_manager
        .connect_with_banner(config.clone(), Arc::new(tunnel_manager.clone()))
        .await
        .map_err(|e| format!("Failed to connect: {}", e))?;

    Ok(ConnectionHandle {
        config: config.clone(),
        session: Some(Arc::new(Mutex::new(session))),
        sftp_session: None,
        sftp_identity_maps: Arc::new(tokio::sync::OnceCell::new()),
        detected_os: None,
        detected_shell: None,
        auth_banner,
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
        return match russh_keys::decode_secret_key(content, Some(passphrase)) {
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

    match russh_keys::decode_secret_key(content, None) {
        Ok(_) => InspectPrivateKeyResponse {
            status: "valid".to_string(),
            encrypted: false,
            remembered: false,
        },
        Err(russh_keys::Error::KeyIsEncrypted) => {
            let Some(passphrase) = passphrase.filter(|value| !value.is_empty()) else {
                return InspectPrivateKeyResponse {
                    status: "passphraseRequired".to_string(),
                    encrypted: true,
                    remembered: false,
                };
            };
            match russh_keys::decode_secret_key(content, Some(passphrase)) {
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
        let key = russh_keys::key::KeyPair::generate_ed25519();
        let mut pem = Vec::new();
        russh_keys::encode_pkcs8_pem(&key, &mut pem).expect("encode private key");
        let pem = String::from_utf8(pem).expect("PEM is UTF-8");

        let result = inspect_private_key_content(&pem, None);

        assert_eq!(result.status, "valid");
        assert!(!result.encrypted);
    }

    #[test]
    fn requires_and_verifies_encrypted_key_passphrases() {
        let key = russh_keys::key::KeyPair::generate_ed25519();
        let mut pem = Vec::new();
        russh_keys::encode_pkcs8_pem_encrypted(&key, b"correct horse", 2, &mut pem)
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

fn connection_to_csv_line(connection: &SavedConnection) -> String {
    let fields = vec![
        csv_escape(&connection.id),
        csv_escape(&connection.name),
        csv_escape(&connection.host),
        connection.port.to_string(),
        csv_escape(&connection.username),
        csv_escape(&connection.password.clone().unwrap_or_default()),
        csv_escape(&connection.private_key_path.clone().unwrap_or_default()),
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

fn build_ssh_config_export(connections: &[SavedConnection]) -> String {
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
                output.push_str(&format!("  IdentityFile {}\n", key_path));
            }
        }
        if let Some(jump_id) = &connection.jump_server_id {
            if let Some(jump_alias) = alias_by_id.get(jump_id) {
                output.push_str(&format!("  ProxyJump {}\n", jump_alias));
            }
        }
        output.push('\n');
    }
    output
}

#[tauri::command]
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
                "id,name,host,port,username,password,privateKeyPath,jumpServerId,folder,theme,tags,isFavorite,pinnedFeatures,createdAt,lastConnected".to_string(),
            ];
            lines.extend(selected_connections.iter().map(connection_to_csv_line));
            lines.join("\n")
        }
        "ssh_config" | "config" => build_ssh_config_export(&selected_connections),
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
                term_id.clone(),
                connection_id,
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
                term_id.clone(),
                connection_id.clone(),
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

async fn reconnect_stored_connection(
    connection_id: &str,
    original_config: ConnectionConfig,
    state: &AppState,
) -> Result<(), String> {
    // Acquire per-connection reconnect lock *without* holding connections lock across await (avoids deadlock with concurrent ops needing connections).
    let reconnect_lock = {
        let connections = state.connections.lock().await;
        connections
            .get(connection_id)
            .map(|h| h.reconnect_lock.clone())
            .ok_or_else(|| {
                format!("Connection {connection_id} was disconnected during reconnect")
            })?
    };
    let _reconnect_guard = reconnect_lock.clone().lock_owned().await;

    let (expected_generation, previous_detected_os, previous_detected_shell) = {
        let connections = state.connections.lock().await;
        connections
            .get(connection_id)
            .map(|handle| {
                (
                    handle.reconnect_generation,
                    handle.detected_os.clone(),
                    handle.detected_shell.clone(),
                )
            })
            .ok_or_else(|| {
                format!("Connection {connection_id} was disconnected during reconnect")
            })?
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
    let mut connections = state.connections.lock().await;
    match connections.get(connection_id) {
        Some(existing) if existing.reconnect_generation == expected_generation => {
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
    let existing = {
        let connections = state.connections.lock().await;
        connections
            .get(connection_id)
            .and_then(|c| c.session.clone())
    };
    if let Some(session) = existing {
        return Ok(session);
    }

    let config = {
        let connections = state.connections.lock().await;
        connections
            .get(connection_id)
            .map(|c| c.config.clone())
            .ok_or_else(|| connection_not_ready_error(connection_id))?
    };

    reconnect_stored_connection(connection_id, config, state).await?;
    let session = {
        let connections = state.connections.lock().await;
        connections
            .get(connection_id)
            .and_then(|c| c.session.clone())
    };
    session.ok_or_else(|| "Reconnection did not produce a session".to_string())
}

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

#[cfg(test)]
mod remote_metadata_tests {
    use super::{parse_windows_openssh_default_shell, resolve_windows_openssh_shell};

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

async fn initialize_remote_metadata_after_terminal(
    connection_id: &str,
    term_id: Option<&str>,
    generation: Option<u32>,
    finalize_startup: bool,
    pending_shell: Option<String>,
    pending_cwd: Option<String>,
    state: &AppState,
) {
    let (session, reconnect_generation, cached_os, cached_shell) = {
        let connections = state.connections.lock().await;
        let Some(connection) = connections.get(connection_id) else {
            return;
        };
        (
            connection.session.clone(),
            connection.reconnect_generation,
            connection.detected_os.clone(),
            connection.detected_shell.clone(),
        )
    };
    if cached_os.is_some() && cached_shell.is_some() {
        if let (true, Some(term_id), Some(generation)) = (finalize_startup, term_id, generation) {
            finalize_remote_terminal_startup(
                term_id,
                generation,
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

    let mut detected_os = None;
    if let Some(output) = run_connection_probe(&session, "cat /etc/os-release").await {
        detected_os = output.lines().find_map(|line| {
            line.strip_prefix("ID=")
                .map(|id| id.trim_matches('"').to_string())
        });
    }
    if detected_os.is_none() {
        if let Some(output) = run_connection_probe(&session, "uname -s").await {
            let system = output.trim().to_ascii_lowercase();
            if !system.is_empty() {
                detected_os = Some(if system == "darwin" {
                    "macos".to_string()
                } else {
                    system
                });
            }
        }
    }
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
            if connection.reconnect_generation == reconnect_generation {
                if detected_os.is_some() {
                    connection.detected_os = detected_os.clone();
                }
                if detected_shell.is_some() {
                    connection.detected_shell = detected_shell.clone();
                }
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

        if let (true, Some(term_id), Some(generation)) = (finalize_startup, term_id, generation) {
            finalize_remote_terminal_startup(
                term_id,
                generation,
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

fn probe_remote_metadata_after_sftp(connection_id: String, app_handle: AppHandle) {
    tokio::spawn(async move {
        if let Some(state) = app_handle.try_state::<AppState>() {
            initialize_remote_metadata_after_terminal(
                &connection_id,
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

async fn finalize_remote_terminal_startup(
    term_id: &str,
    generation: u32,
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

async fn open_sftp_session(
    session: &Arc<Mutex<russh::client::Handle<crate::ssh::Client>>>,
) -> Result<Arc<russh_sftp::client::SftpSession>, OpenSftpError> {
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
    let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
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
    let (config, existing_session, reconnect_generation) = {
        let connections = state.connections.lock().await;
        let conn = connections
            .get(id)
            .ok_or_else(|| format!("Connection {} not found, cannot reconnect for SFTP", id))?;

        if let Some(sftp) = &conn.sftp_session {
            return Ok(sftp.clone());
        }
        (
            conn.config.clone(),
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
                    if conn.reconnect_generation != reconnect_generation {
                        return conn
                            .sftp_session
                            .clone()
                            .ok_or_else(|| "Connection changed while SFTP started".to_string());
                    }
                    let opened_first_sftp = conn.sftp_session.is_none();
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
                if let Some(conn) = connections.get_mut(id) {
                    if conn.reconnect_generation == reconnect_generation {
                        conn.session = None;
                    }
                }
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
        reconnect_stored_connection(id, config, state),
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
    let opened_first_sftp = {
        let mut connections = state.connections.lock().await;
        if let Some(conn) = connections.get_mut(id) {
            if conn.reconnect_generation == reconnect_generation {
                let opened_first_sftp = conn.sftp_session.is_none();
                conn.sftp_session = Some(sftp.clone());
                opened_first_sftp
            } else {
                false
            }
        } else {
            false
        }
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
    let mut current: &dyn std::error::Error = err.as_ref();
    loop {
        if let Some(io_err) = current.downcast_ref::<std::io::Error>() {
            return matches!(
                io_err.kind(),
                ErrorKind::BrokenPipe
                    | ErrorKind::ConnectionReset
                    | ErrorKind::UnexpectedEof
                    | ErrorKind::NotConnected
            );
        }
        let lower = current.to_string().to_ascii_lowercase();
        if lower.contains("session closed")
            || lower.contains("connection is closed")
            || lower.contains("channel is eof")
        {
            return true;
        }
        current = match current.source() {
            Some(source) => source,
            None => break,
        };
    }
    false
}

pub(crate) async fn read_remote_connection_file(
    state: &AppState,
    connection_id: &str,
    path: &str,
    timeout_secs: u64,
) -> Result<String, String> {
    let sftp = get_sftp_or_reconnect(state, connection_id).await?;
    let timeout_duration = std::time::Duration::from_secs(timeout_secs);

    match tokio::time::timeout(timeout_duration, state.file_system.read_remote(&sftp, path)).await {
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
            match tokio::time::timeout(timeout_duration, state.file_system.read_remote(&sftp, path))
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
    state: State<'_, AppState>,
) -> Result<String, String> {
    if connection_id == "local" {
        state
            .file_system
            .read_file(&connection_id, &path)
            .await
            .map_err(|e| e.to_string())
    } else {
        read_remote_connection_file(&state, &connection_id, &path, 10).await
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
                println!("[FS] SFTP session closed during rename, retrying...");
                {
                    let mut connections = state.connections.lock().await;
                    if let Some(c) = connections.get_mut(&connection_id) {
                        c.sftp_session = None;
                    }
                }
                let sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
                match tokio::time::timeout(
                    timeout_duration,
                    state.file_system.rename_remote(&sftp, &old_path, &new_path),
                )
                .await
                {
                    Ok(Ok(_)) => Ok(()),
                    Ok(Err(e)) => Err(e.to_string()),
                    Err(_) => Err(format!(
                        "DISCONNECTED: SFTP rename timed out after {}s",
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
                    "DISCONNECTED: SFTP rename timed out after {}s",
                    timeout_duration.as_secs()
                ))
            }
        }
    }
}

#[tauri::command]
pub async fn fs_delete(
    connection_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if connection_id == "local" {
        state
            .file_system
            .delete(&connection_id, &path)
            .await
            .map_err(|e| e.to_string())
    } else {
        // Optimization: Try server-side delete first (rm -rf) to avoid recursive SFTP calls
        let (session_opt, should_optimize) = {
            let connections = state.connections.lock().await;
            let conn = connections.get(&connection_id);
            (
                conn.and_then(|c| c.session.clone()),
                conn.map(|c| c.detected_os.is_some()).unwrap_or(false),
            )
        };

        if should_optimize {
            if let Some(session) = session_opt {
                let cmd = format!("rm -rf {}", shell_quote(&path));
                println!("[FS] Attempting server-side delete: {}", cmd);

                let timeout_duration = std::time::Duration::from_secs(10);
                let optimize_fut = async {
                    match session.lock().await.channel_open_session().await {
                        Ok(mut channel) => {
                            if channel.exec(true, cmd).await.is_ok() {
                                let mut success = false;
                                let mut output_log = String::new();
                                while let Some(msg) = channel.wait().await {
                                    match msg {
                                        russh::ChannelMsg::Data { data } => {
                                            output_log.push_str(&String::from_utf8_lossy(&data))
                                        }
                                        russh::ChannelMsg::ExtendedData { data, .. } => {
                                            output_log.push_str(&String::from_utf8_lossy(&data))
                                        }
                                        russh::ChannelMsg::ExitStatus { exit_status } => {
                                            if exit_status == 0 {
                                                success = true;
                                            }
                                            break;
                                        }
                                        _ => {}
                                    }
                                }
                                success
                            } else {
                                false
                            }
                        }
                        Err(_) => false,
                    }
                };

                match tokio::time::timeout(timeout_duration, optimize_fut).await {
                    Ok(true) => {
                        println!("[FS] Server-side delete successful.");
                        return Ok(());
                    }
                    _ => println!(
                        "[FS] Server-side delete failed or timed out. Checking SFTP fallback..."
                    ),
                }
            }
        }

        // Fallback to SFTP (recursive delete implemented there)
        println!("[FS] Falling back to SFTP delete...");
        let sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
        let timeout_duration = std::time::Duration::from_secs(10);

        match tokio::time::timeout(
            timeout_duration,
            state.file_system.delete_remote(&sftp, &path),
        )
        .await
        {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(e)) if e.to_string().to_lowercase().contains("session closed") => {
                println!("[FS] SFTP session closed during delete, retrying...");
                {
                    let mut connections = state.connections.lock().await;
                    if let Some(c) = connections.get_mut(&connection_id) {
                        c.sftp_session = None;
                    }
                }
                let sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
                match tokio::time::timeout(
                    timeout_duration,
                    state.file_system.delete_remote(&sftp, &path),
                )
                .await
                {
                    Ok(Ok(_)) => Ok(()),
                    Ok(Err(e)) => Err(e.to_string()),
                    Err(_) => Err(format!(
                        "DISCONNECTED: SFTP delete timed out after {}s",
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
                    "DISCONNECTED: SFTP delete timed out after {}s",
                    timeout_duration.as_secs()
                ))
            }
        }
    }
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
        // Optimization: Single SSH channel for combined rm -rf calls
        let (session_opt, should_optimize) = {
            let connections = state.connections.lock().await;
            let conn = connections.get(&connection_id);
            (
                conn.and_then(|c| c.session.clone()),
                conn.map(|c| c.detected_os.is_some()).unwrap_or(false),
            )
        };

        if should_optimize {
            if let Some(session) = session_opt {
                let timeout_duration = std::time::Duration::from_secs(15);

                let ssh_optimize_fut = async {
                    let mut channel = session
                        .lock()
                        .await
                        .channel_open_session()
                        .await
                        .map_err(|e| format!("Failed to open channel: {}", e))?;

                    let paths_str = paths
                        .iter()
                        .map(|p| shell_quote(p))
                        .collect::<Vec<_>>()
                        .join(" ");

                    let cmd = format!("rm -rf {}", paths_str);
                    println!("[FS] Attempting batch server-side delete: {}", cmd);

                    channel
                        .exec(true, cmd)
                        .await
                        .map_err(|e| format!("Exec failed: {}", e))?;

                    let mut success = false;
                    while let Some(msg) = channel.wait().await {
                        if let russh::ChannelMsg::ExitStatus { exit_status } = msg {
                            if exit_status == 0 {
                                success = true;
                            }
                            break;
                        }
                    }
                    Ok::<bool, String>(success)
                };

                match tokio::time::timeout(timeout_duration, ssh_optimize_fut).await {
                    Ok(Ok(true)) => {
                        println!("[FS] Batch server-side delete successful.");
                        return Ok(());
                    }
                    Ok(Err(e)) => println!(
                        "[FS] Batch SSH delete error: {}. Falling back to SFTP...",
                        e
                    ),
                    Err(_) => println!(
                        "[FS] Batch SSH delete timed out after {}s. Falling back to SFTP...",
                        timeout_duration.as_secs()
                    ),
                    _ => println!("[FS] Batch SSH delete failed, falling back to SFTP..."),
                }
            }
        }

        // Fallback: Individual SFTP deletes with retry logic
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

        let sftp = match get_sftp_or_reconnect(&state, &connection_id).await {
            Ok(s) => s,
            Err(e) => {
                return Err(BatchDeleteError {
                    message: e,
                    failed_paths: paths,
                })
            }
        };

        let mut failed_paths = perform_sftp_batch_delete(&sftp, &paths, &state.file_system).await;

        // If some failed, maybe it was a session disconnect? Try reconnecting ONCE for the failures
        if !failed_paths.is_empty() {
            println!(
                "[FS] Some batch deletes failed, attempting one-time reconnect for {} items...",
                failed_paths.len()
            );
            {
                let mut connections = state.connections.lock().await;
                if let Some(c) = connections.get_mut(&connection_id) {
                    c.sftp_session = None;
                }
            }
            if let Ok(retry_sftp) = get_sftp_or_reconnect(&state, &connection_id).await {
                // Only retry the previously failed paths
                let still_failed =
                    perform_sftp_batch_delete(&retry_sftp, &failed_paths, &state.file_system).await;
                failed_paths = still_failed;
            }
        }

        if !failed_paths.is_empty() {
            return Err(BatchDeleteError {
                message: "Some remote files could not be deleted".to_string(),
                failed_paths,
            });
        }

        Ok(())
    }
}

#[tauri::command]
pub async fn fs_copy(
    connection_id: String,
    from: String,
    to: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if connection_id == "local" {
        state
            .file_system
            .copy(&connection_id, &from, &to)
            .await
            .map_err(|e| e.to_string())
    } else {
        // Optimization: Try server-side copy first (cp -r) to avoid download/upload
        let (session_opt, should_optimize) = {
            let connections = state.connections.lock().await;
            let conn = connections.get(&connection_id);
            (
                conn.and_then(|c| c.session.clone()),
                conn.map(|c| c.detected_os.is_some()).unwrap_or(false),
            )
        };

        if should_optimize {
            if let Some(session) = session_opt {
                // Simple quoting for paths (Linux/Unix assumptions for now, robust enough for typical usage)
                // We use standard "cp -r" which works on most Unix-likes.
                // If it fails (e.g. Windows), we fall back to SFTP.
                let cmd = format!("cp -r {} {}", shell_quote(&from), shell_quote(&to));
                println!("[FS] Attempting server-side copy: {}", cmd);
                let timeout_duration = std::time::Duration::from_secs(10);
                let optimize_fut = async {
                    match session.lock().await.channel_open_session().await {
                        Ok(mut channel) => {
                            if channel.exec(true, cmd).await.is_ok() {
                                // Wait for exit status
                                let mut success = false;
                                while let Some(msg) = channel.wait().await {
                                    if let russh::ChannelMsg::ExitStatus { exit_status } = msg {
                                        if exit_status == 0 {
                                            success = true;
                                        }
                                        break;
                                    }
                                }
                                Ok::<bool, String>(success)
                            } else {
                                Ok::<bool, String>(false)
                            }
                        }
                        Err(e) => {
                            println!("[FS] Failed to open channel for copy optimization: {}", e);
                            Ok::<bool, String>(false)
                        }
                    }
                };

                match tokio::time::timeout(timeout_duration, optimize_fut).await {
                    Ok(Ok(true)) => {
                        println!("[FS] Server-side copy successful");
                        return Ok(());
                    }
                    Ok(Ok(false)) => {
                        println!("[FS] Server-side copy failed (non-zero exit), checking SFTP fallback...");
                    }
                    Ok(Err(e)) => {
                        println!(
                            "[FS] Server-side copy failed (error), checking SFTP fallback: {}",
                            e
                        );
                    }
                    Err(_) => {
                        println!("[FS] Server-side copy optimization timed out, checking SFTP fallback...");
                    }
                }
            }
        }

        // Fallback to SFTP
        let sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
        let timeout_duration = std::time::Duration::from_secs(10);

        match tokio::time::timeout(
            timeout_duration,
            state.file_system.copy_remote(&sftp, &from, &to),
        )
        .await
        {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(e)) if e.to_string().to_lowercase().contains("session closed") => {
                println!("[FS] SFTP session closed during copy, retrying...");
                {
                    let mut connections = state.connections.lock().await;
                    if let Some(c) = connections.get_mut(&connection_id) {
                        c.sftp_session = None;
                    }
                }
                let sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
                match tokio::time::timeout(
                    timeout_duration,
                    state.file_system.copy_remote(&sftp, &from, &to),
                )
                .await
                {
                    Ok(Ok(_)) => Ok(()),
                    Ok(Err(e)) => Err(e.to_string()),
                    Err(_) => Err(format!(
                        "DISCONNECTED: SFTP copy timed out after {}s",
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
                    "DISCONNECTED: SFTP copy timed out after {}s",
                    timeout_duration.as_secs()
                ))
            }
        }
    }
}

#[tauri::command]
pub async fn fs_copy_batch(
    connection_id: String,
    operations: Vec<CopyOperation>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if connection_id == "local" {
        for op in operations {
            state
                .file_system
                .copy(&connection_id, &op.from, &op.to)
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    } else {
        // Optimization: Try single SSH channel for all cp commands if OS detected
        let (session_opt, should_optimize) = {
            let connections = state.connections.lock().await;
            let conn = connections.get(&connection_id);
            (
                conn.and_then(|c| c.session.clone()),
                conn.map(|c| c.detected_os.is_some()).unwrap_or(false),
            )
        };

        if should_optimize && session_opt.is_some() {
            if let Some(session) = session_opt {
                // Build a multi-command string: cp -r 'a' 'b' && cp -r 'c' 'd' ...
                let cmd = operations
                    .iter()
                    .map(|op| format!("cp -r {} {}", shell_quote(&op.from), shell_quote(&op.to)))
                    .collect::<Vec<_>>()
                    .join(" && ");

                println!("[FS] Attempting batch server-side copy: {}", cmd);
                let timeout_duration = std::time::Duration::from_secs(10);
                let optimize_fut = async {
                    let mut channel = session
                        .lock()
                        .await
                        .channel_open_session()
                        .await
                        .map_err(|e| format!("Failed to open channel: {}", e))?;
                    channel
                        .exec(true, cmd)
                        .await
                        .map_err(|e| format!("Exec failed: {}", e))?;

                    let mut exit_code = None;
                    while let Some(msg) = channel.wait().await {
                        if let russh::ChannelMsg::ExitStatus { exit_status } = msg {
                            exit_code = Some(exit_status);
                            break;
                        }
                    }
                    Ok::<Option<u32>, String>(exit_code)
                };

                match tokio::time::timeout(timeout_duration, optimize_fut).await {
                    Ok(Ok(Some(0))) => {
                        println!("[FS] Batch server-side copy successful");
                        return Ok(());
                    }
                    Ok(Ok(exit_code)) => {
                        println!("[FS] Batch server-side copy failed with exit code {:?}, falling back to SFTP...", exit_code);
                    }
                    Ok(Err(e)) => {
                        println!("[FS] Batch server-side copy optimization failed: {}. Falling back to SFTP...", e);
                    }
                    Err(_) => {
                        println!("[FS] Batch server-side copy optimization timed out. Falling back to SFTP...");
                    }
                }
            }
        }

        // Final fallback: Sequential SFTP if no session or optimization fails
        let mut current_sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
        let timeout_duration = std::time::Duration::from_secs(10);

        let mut idx = 0;
        let mut sftp_retry = 0u8;
        while idx < operations.len() {
            let op = &operations[idx];
            match tokio::time::timeout(
                timeout_duration,
                state
                    .file_system
                    .copy_remote(&current_sftp, &op.from, &op.to),
            )
            .await
            {
                Ok(Ok(_)) => {
                    sftp_retry = 0;
                    idx += 1;
                }
                Ok(Err(e)) if e.to_string().to_lowercase().contains("session closed") => {
                    sftp_retry = sftp_retry.saturating_add(1);
                    println!(
                        "[FS] SFTP session closed during batch item {}, retrying...",
                        idx
                    );
                    {
                        let mut connections = state.connections.lock().await;
                        if let Some(c) = connections.get_mut(&connection_id) {
                            c.sftp_session = None;
                        }
                    }
                    current_sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
                    if sftp_retry > MAX_SFTP_RETRIES {
                        return Err(format!(
                            "DISCONNECTED: SFTP batch copy failed at item {} after {} reconnect retries",
                            idx, MAX_SFTP_RETRIES
                        ));
                    }
                    // Don't increment idx, retry the same operation with new SFTP
                }
                Ok(Err(e)) => return Err(e.to_string()),
                Err(_) => {
                    {
                        let mut connections = state.connections.lock().await;
                        if let Some(c) = connections.get_mut(&connection_id) {
                            c.sftp_session = None;
                        }
                    }
                    return Err(format!(
                        "DISCONNECTED: SFTP batch copy timed out at item {} after {}s",
                        idx,
                        timeout_duration.as_secs()
                    ));
                }
            }
        }
        Ok(())
    }
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
        // Execute SSH command
        let connections = state.connections.lock().await;
        if let Some(conn) = connections.get(&connection_id) {
            if let Some(session) = &conn.session {
                let mut channel = session
                    .lock()
                    .await
                    .channel_open_session()
                    .await
                    .map_err(|e| e.to_string())?;
                channel
                    .exec(true, command)
                    .await
                    .map_err(|e| e.to_string())?;

                let mut stdout = Vec::new();
                let mut stderr = Vec::new();
                let mut exit_status = 0;

                while let Some(msg) = channel.wait().await {
                    match msg {
                        russh::ChannelMsg::Data { ref data } => stdout.extend_from_slice(data),
                        russh::ChannelMsg::ExtendedData { ref data, .. } => {
                            stderr.extend_from_slice(data)
                        }
                        russh::ChannelMsg::ExitStatus { exit_status: code } => {
                            exit_status = code;
                        }
                        _ => {}
                    }
                }

                if exit_status == 0 {
                    return String::from_utf8(stdout).map_err(|e| e.to_string());
                } else {
                    let err_str = String::from_utf8_lossy(&stderr);
                    return Err(format!(
                        "Remote command failed (Exit {}): {}",
                        exit_status, err_str
                    ));
                }
            }
        }
        Err("Connection not found".to_string())
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
    let _mutation_guard = SETTINGS_MUTATION_LOCK.lock().await;
    let current = read_effective_settings(&app)?;
    let current_data_path = data_path_from_settings(&current);
    let merged = ensure_object_settings(merge_json_values(current, settings))?;
    let next_data_path = data_path_from_settings(&merged);
    persist_settings_json(&app, &merged)?;
    if current_data_path != next_data_path {
        clear_data_dir_cache();
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

// Helper for recursive upload
// Now takes AppHandle and transfer_id for emitting events
fn upload_recursive<'a>(
    sftp: &'a russh_sftp::client::SftpSession,
    local_path: &'a std::path::Path,
    remote_path: &'a str,
    file_system: &'a FileSystem,
    app: &'a AppHandle,
    transfer_id: &'a str,
    total_size: &'a mut u64,
    transferred: &'a mut u64,
    cancel_token: &'a std::sync::atomic::AtomicBool,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        if local_path.is_dir() {
            // Create remote directory
            let _ = file_system.create_dir_remote(sftp, remote_path).await;

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
                    file_system,
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
            tokio::spawn(async move {
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

            // Main loop: Receive from reader and Write to Server concurrently
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
pub async fn sftp_put(
    app: AppHandle,
    id: String,
    local_path: String,
    remote_path: String,
    transfer_id: String,
    _state: State<'_, AppState>,
) -> Result<(), String> {
    // Spawn background task
    let app_handle = app.clone();
    let connection_id = id.clone();
    let local = local_path.clone();
    let remote = remote_path.clone();
    let tid = transfer_id.clone();

    // Create cancellation token
    let cancel_token = Arc::new(std::sync::atomic::AtomicBool::new(false));

    // Register token
    {
        let mut transfers = _state.transfers.lock().await;
        transfers.insert(tid.clone(), cancel_token.clone());
    }

    tauri::async_runtime::spawn(async move {
        // Retrieve state inside task
        let state = app_handle.state::<AppState>();

        let result = async {
            if connection_id == "local" {
                // Local copy
                let path = std::path::Path::new(&local);
                if path.is_dir() {
                    // Todo recursive local
                    return Err("Local directory copy not yet implemented".to_string());
                }
                std::fs::copy(&local, &remote).map_err(|e| e.to_string())?;
            } else {
                let sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
                let path = std::path::Path::new(&local);

                // Calculate total size for progress bar
                let mut total_size = get_local_size(path);
                if total_size == 0 {
                    total_size = 1;
                } // Avoid division by zero
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
                    &state.file_system,
                    &app_handle,
                    &tid,
                    &mut total_size,
                    &mut transferred,
                    &cancel_token,
                )
                .await?;
            }
            Ok(())
        }
        .await;
        // Cleanup
        {
            let mut transfers = state.transfers.lock().await;
            transfers.remove(&tid);
        }

        match result {
            Ok(_) => {
                let _ = app_handle.emit(
                    "transfer-success",
                    TransferSuccess {
                        id: tid,
                        destination_connection_id: connection_id,
                    },
                );
            }
            Err(e) => {
                if e == "Cancelled" {
                    let _ = app_handle.emit(
                        "transfer-error",
                        TransferError {
                            id: tid,
                            error: "Cancelled".to_string(),
                        },
                    );
                } else {
                    let _ = app_handle.emit("transfer-error", TransferError { id: tid, error: e });
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn sftp_cancel_transfer(
    state: State<'_, AppState>,
    transfer_id: String,
) -> Result<(), String> {
    let transfers = state.transfers.lock().await;
    if let Some(token) = transfers.get(&transfer_id) {
        token.store(true, std::sync::atomic::Ordering::Relaxed);
    }
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
    _state: State<'_, AppState>, // kept for signature compatibility if needed, but we use app_handle.state()
) -> Result<(), String> {
    let app_handle = app.clone();
    let src_id = source_connection_id.clone();
    let src_path = source_path.clone();
    let dst_id = destination_connection_id.clone();
    let dst_path = destination_path.clone();
    let tid = transfer_id.clone();
    let _mode = mode.unwrap_or_else(|| "standard".to_string());

    tauri::async_runtime::spawn(async move {
        let state = app_handle.state::<AppState>();

        // Create cancellation token
        let cancel_token = Arc::new(std::sync::atomic::AtomicBool::new(false));
        {
            let mut transfers = state.transfers.lock().await;
            transfers.insert(tid.clone(), cancel_token.clone());
        }

        let result: Result<(u64, u64), String> = async {
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

            Ok((transferred, total_size))
        }
        .await;

        // Cleanup cancellation token
        {
            let mut transfers = state.transfers.lock().await;
            transfers.remove(&tid);
        }

        match result {
            Ok((transferred, total)) => {
                let _ = app_handle.emit(
                    "transfer-progress",
                    TransferProgress {
                        id: tid.clone(),
                        transferred,
                        total,
                    },
                );

                let _ = app_handle.emit(
                    "transfer-success",
                    TransferSuccess {
                        id: tid,
                        destination_connection_id: dst_id,
                    },
                );
            }
            Err(e) => {
                let status = if e == "Cancelled" {
                    "cancelled"
                } else {
                    "failed"
                };
                if status == "cancelled" {
                    let _ = app_handle.emit(
                        "transfer-cancelled",
                        TransferSuccess {
                            // reusing struct or just ID? Frontend expects error or distinct event?
                            id: tid.clone(),
                            destination_connection_id: dst_id, // Payload matches success for ID extraction
                        },
                    );
                    // Or separate event? Frontend listens for 'transfer-error' usually.
                    // CopyToServerModal handles error. TransferManager handles 'cancelled' status if we update store.
                    // Let's emit error with "Cancelled" message, easiest.
                    let _ = app_handle.emit(
                        "transfer-error",
                        TransferError {
                            id: tid,
                            error: "Cancelled".into(),
                        },
                    );
                } else {
                    let _ = app_handle.emit("transfer-error", TransferError { id: tid, error: e });
                }
            }
        }
    });
    Ok(())
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

    if metadata.is_dir() {
        // Create remote dir (ignore error if exists)
        let _ = dst_sftp.create_dir(dst_path).await;

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
        tokio::spawn(async move {
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

        // Main loop: Receive from source and Write to destination concurrently
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
        // Check if remote is dir or file
        let metadata = sftp
            .metadata(remote_path)
            .await
            .map_err(|e| format!("Failed to stat remote path '{}': {}", remote_path, e))?;

        if metadata.is_dir() {
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
            tokio::spawn(async move {
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

            // Main loop: Receive from remote reader and Write to Local Disk concurrently
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
        if !metadata.is_dir() {
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
                    if attrs.is_dir() {
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
    _state: State<'_, AppState>,
) -> Result<(), String> {
    let app_handle = app.clone();
    let connection_id = id.clone();
    let remote = remote_path.clone();
    let local = local_path.clone();
    let tid = transfer_id.clone();

    tauri::async_runtime::spawn(async move {
        let state = app_handle.state::<AppState>();

        let result = async {
            // Retrieve session
            let sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
            let local_p = std::path::Path::new(&local);

            // Prepare total size (Best effort)
            let mut total_size = get_remote_size(&sftp, &remote).await;
            if total_size == 0 {
                total_size = 1;
            }
            let mut transferred = 0;

            let tid_clone = tid.clone();
            let cancel_token = Arc::new(std::sync::atomic::AtomicBool::new(false));

            // Register token
            {
                let mut transfers = state.transfers.lock().await;
                transfers.insert(tid_clone.clone(), cancel_token.clone());
            }

            // Emit start
            let _ = app_handle.emit(
                "transfer-progress",
                TransferProgress {
                    id: tid.clone(),
                    transferred: 0,
                    total: total_size,
                },
            );

            let res = download_recursive(
                &sftp,
                &remote,
                local_p,
                &app_handle,
                &tid,
                &mut total_size,
                &mut transferred,
                &cancel_token,
            )
            .await;

            // Cleanup
            {
                let mut transfers = state.transfers.lock().await;
                transfers.remove(&tid_clone);
            }

            res
        }
        .await;

        match result {
            Ok(_) => {
                let _ = app_handle.emit(
                    "transfer-success",
                    TransferSuccess {
                        id: tid,
                        destination_connection_id: "local".to_string(),
                    },
                );
            }
            Err(e) => {
                if e == "Cancelled" {
                    let _ = app_handle.emit(
                        "transfer-error",
                        TransferError {
                            id: tid,
                            error: "Cancelled".to_string(),
                        },
                    );
                } else {
                    let _ = app_handle.emit("transfer-error", TransferError { id: tid, error: e });
                }
            }
        }
    });

    Ok(())
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
pub async fn app_exit(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub async fn app_relaunch(app: tauri::AppHandle) {
    app.restart();
}

#[tauri::command]
pub async fn plugins_load(app: AppHandle) -> Result<Vec<crate::plugins::Plugin>, String> {
    crate::plugins::PluginScanner::scan(&app).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn plugins_toggle(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    crate::plugins::PluginScanner::save_state(&app, id, enabled).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn plugins_install(app: AppHandle, url: String) -> Result<String, String> {
    crate::plugins::PluginScanner::install_plugin(&app, &url)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn plugins_install_local(app: AppHandle, path: String) -> Result<String, String> {
    let app_handle = app.clone();
    let local_path = path.clone();

    tokio::task::spawn_blocking(move || {
        crate::plugins::PluginScanner::install_plugin_from_local_path(&app_handle, &local_path)
    })
    .await
    .map_err(|e| format!("Local plugin install task failed: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn plugins_uninstall(app: AppHandle, id: String) -> Result<(), String> {
    crate::plugins::PluginScanner::uninstall_plugin(&app, &id).map_err(|e| e.to_string())
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
pub async fn plugin_window_create(
    app: AppHandle,
    url: Option<String>,
    html: Option<String>,
    title: Option<String>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    use tauri::WebviewWindowBuilder;
    let label = format!("plugin-window-{}", uuid::Uuid::new_v4());
    let mut temp_html_path: Option<std::path::PathBuf> = None;
    let mut builder = WebviewWindowBuilder::new(
        &app,
        &label,
        if let Some(u) = url {
            tauri::WebviewUrl::External(u.parse().map_err(|e: url::ParseError| e.to_string())?)
        } else if let Some(h) = html {
            let cache_dir = app
                .path()
                .app_cache_dir()
                .map_err(|e| format!("Failed to resolve app cache dir: {}", e))?
                .join("plugin-window-html");
            if !cache_dir.exists() {
                std::fs::create_dir_all(&cache_dir)
                    .map_err(|e| format!("Failed to create plugin cache dir: {}", e))?;
            }
            let file_path =
                cache_dir.join(format!("zync-plugin-window-{}.html", uuid::Uuid::new_v4()));
            std::fs::write(&file_path, h)
                .map_err(|e| format!("Failed to write temporary plugin HTML file: {}", e))?;
            temp_html_path = Some(file_path.clone());
            let file_url = url::Url::from_file_path(&file_path)
                .map_err(|_| format!("Failed to create file URL for {}", file_path.display()))?;
            tauri::WebviewUrl::External(file_url)
        } else {
            return Err("Must provide url or html".into());
        },
    );

    if let Some(t) = title {
        builder = builder.title(t);
    }
    if let Some(w) = width {
        builder = builder.inner_size(w, height.unwrap_or(600.0));
    }

    if let Err(error) = builder.build() {
        if let Some(path) = temp_html_path.as_ref() {
            let _ = std::fs::remove_file(path);
        }
        return Err(error.to_string());
    }
    if let Some(file_path) = temp_html_path {
        match PLUGIN_WINDOW_TEMP_FILES.lock() {
            Ok(mut files) => {
                files.insert(label, file_path);
            }
            Err(lock_error) => {
                eprintln!(
                    "Failed to register plugin window temp file for cleanup: {}",
                    lock_error
                );
            }
        }
    }
    Ok(())
}

pub fn cleanup_plugin_window_temp_file(window_label: &str) {
    let maybe_path = if let Ok(mut files) = PLUGIN_WINDOW_TEMP_FILES.lock() {
        files.remove(window_label)
    } else {
        None
    };
    if let Some(path) = maybe_path {
        if let Err(error) = std::fs::remove_file(&path) {
            eprintln!(
                "[plugin-window] Failed to remove temporary HTML file {}: {}",
                path.display(),
                error
            );
        }
    }
}

pub fn cleanup_stale_plugin_window_temp_files(app: &AppHandle) {
    let cache_dir = match app.path().app_cache_dir() {
        Ok(dir) => dir.join("plugin-window-html"),
        Err(error) => {
            eprintln!("[plugin-window] Failed to resolve cache dir: {}", error);
            return;
        }
    };

    if !cache_dir.exists() {
        return;
    }

    let stale_after = Duration::from_secs(60 * 60 * 24);
    let now = SystemTime::now();
    let entries = match std::fs::read_dir(&cache_dir) {
        Ok(entries) => entries,
        Err(error) => {
            eprintln!(
                "[plugin-window] Failed to scan temp cache dir {}: {}",
                cache_dir.display(),
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
        if path.extension().and_then(|ext| ext.to_str()) != Some("html") {
            continue;
        }

        let should_remove = entry
            .metadata()
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|modified| now.duration_since(modified).ok())
            .map(|age| age > stale_after)
            .unwrap_or(true);

        if should_remove {
            if let Err(error) = std::fs::remove_file(&path) {
                eprintln!(
                    "[plugin-window] Failed to remove stale HTML file {}: {}",
                    path.display(),
                    error
                );
            }
        }
    }
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
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
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
    state: State<'_, AppState>,
) -> Result<(), String> {
    if remote_paths.is_empty() {
        return Err("No files selected for download".to_string());
    }

    let app_handle = app.clone();
    let connection_id = id.clone();
    let tid = transfer_id.clone();

    let cancel_token = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let mut transfers = state.transfers.lock().await;
        transfers.insert(tid.clone(), cancel_token.clone());
    }

    // Estimate total size using SFTP (already connected) for progress reporting.
    let total_size = {
        let sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
        let mut sz: u64 = 0;
        for rp in &remote_paths {
            sz += get_remote_size(&sftp, rp).await;
        }
        if sz == 0 {
            1
        } else {
            sz
        }
    };

    tauri::async_runtime::spawn(async move {
        let state_ref = app_handle.state::<AppState>();

        let result: Result<(), String> = async {
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

            // Build: tar -czf - -C <parent_dir> <entry_name> ...
            // Each item gets its own -C <parent_dir> <entry_name> so entries appear at
            // the archive root regardless of where they live on the server.
            let mut tar_args = String::new();
            for rp in &remote_paths {
                let trimmed = rp.trim_end_matches('/');
                // Guard: skip empty paths (e.g. if caller passes "/" which trims to "")
                if trimmed.is_empty() {
                    continue;
                }
                let (entry_name, parent_dir) = match trimmed.rfind('/') {
                    Some(idx) => {
                        let p = if idx == 0 { "/" } else { &trimmed[..idx] };
                        (&trimmed[idx + 1..], p)
                    }
                    // No slash at all â€” treat as relative name in current directory
                    None => (trimmed, "."),
                };
                // Guard: entry_name should never be empty after a valid split
                if entry_name.is_empty() {
                    continue;
                }
                tar_args.push_str(&format!(
                    " -C {} {}",
                    shell_quote(parent_dir),
                    shell_quote(entry_name)
                ));
            }
            if tar_args.is_empty() {
                return Err("No valid paths to archive".to_string());
            }
            let tar_cmd = format!("tar -czf -{}", tar_args);

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
            let mut exit_status: u32 = 0;
            let mut last_emit = std::time::Instant::now();
            let mut stderr_buf: Vec<u8> = Vec::new();

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
                        stderr_buf.extend_from_slice(data);
                    }
                    russh::ChannelMsg::ExitStatus { exit_status: code } => {
                        exit_status = code;
                    }
                    _ => {}
                }
            }

            if exit_status != 0 {
                let stderr = String::from_utf8_lossy(&stderr_buf);
                return Err(format!(
                    "tar failed (exit {}): {}",
                    exit_status,
                    stderr.trim()
                ));
            }

            // Emit 100% progress.
            let _ = app_handle.emit(
                "transfer-progress",
                TransferProgress {
                    id: tid.clone(),
                    transferred: total_size,
                    total: total_size,
                },
            );

            Ok(())
        }
        .await;

        {
            let mut transfers = state_ref.transfers.lock().await;
            transfers.remove(&tid);
        }

        match result {
            Ok(_) => {
                let _ = app_handle.emit(
                    "transfer-success",
                    TransferSuccess {
                        id: tid,
                        destination_connection_id: "local".to_string(),
                    },
                );
            }
            Err(e) => {
                let _ = std::fs::remove_file(&local_path);
                let _ = app_handle.emit("transfer-error", TransferError { id: tid, error: e });
            }
        }
    });

    Ok(())
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
