use crate::fs::{FileEntry, FileSystem};
use crate::pty::PtyManager;
use crate::ssh::{Client, SshManager};
use crate::types::*;
use anyhow::Result;
use russh::client::Handle;
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;
use std::time::Duration;
use tauri_plugin_store::StoreExt;

use crate::tunnel::TunnelManager;
use serde::{Deserialize, Serialize};

const MAX_IMPORT_TEXT_BYTES: usize = 1_048_576; // 1 MiB
const MAX_CONNECTION_IMPORT_BYTES: u64 = 5 * 1024 * 1024; // 5 MiB

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
pub fn get_data_dir(app: &AppHandle) -> std::path::PathBuf {
    let default_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let settings_path = default_dir.join("settings.json");

    if settings_path.exists() {
        if let Ok(data) = std::fs::read_to_string(&settings_path) {
            if let Ok(settings) = serde_json::from_str::<serde_json::Value>(&data) {
                if let Some(data_path) = settings.get("dataPath").and_then(|v| v.as_str()) {
                    if !data_path.is_empty() {
                        let custom_dir = std::path::PathBuf::from(data_path);
                        // Ensure the directory exists
                        if !custom_dir.exists() {
                            let _ = std::fs::create_dir_all(&custom_dir);
                        }
                        return custom_dir;
                    }
                }
            }
        }
    }

    default_dir
}

#[derive(Debug, Serialize, Clone)]
pub struct TunnelStatusChange {
    pub id: String,
    pub status: String,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CopyOperation {
    pub from: String,
    pub to: String,
}

#[derive(Clone)]
pub struct AppState {
    pub connections: Arc<Mutex<HashMap<String, ConnectionHandle>>>,
    pub pty_manager: Arc<PtyManager>,
    pub file_system: Arc<FileSystem>,
    pub ssh_manager: Arc<SshManager>,
    pub tunnel_manager: Arc<TunnelManager>,
    pub snippets_manager: Arc<crate::snippets::SnippetsManager>,
    pub transfers: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    // Agent v2: active run cancellation tokens
    pub agent_runs: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    // Agent v2: pending checkpoint responders (ask_user tool)
    pub agent_checkpoints: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>>,
    // Agent v2: per-scope command whitelist (scope = connection_id or "local")
    pub command_whitelist: Arc<Mutex<HashMap<String, std::collections::HashSet<String>>>>,
    // Ghost suggestions: frecency-scored command history, persisted to disk.
    pub ghost_manager: Arc<crate::ghost::GhostManager>,
}

impl AppState {
    pub fn new(data_dir: std::path::PathBuf) -> Self {
        Self {
            connections: Arc::new(Mutex::new(HashMap::new())),
            pty_manager: Arc::new(PtyManager::new()),
            file_system: Arc::new(FileSystem::new()),
            ssh_manager: Arc::new(SshManager::new()),
            tunnel_manager: Arc::new(TunnelManager::new()),
            snippets_manager: Arc::new(crate::snippets::SnippetsManager::new(data_dir.clone())),
            transfers: Arc::new(Mutex::new(HashMap::new())),
            agent_runs: Arc::new(Mutex::new(HashMap::new())),
            agent_checkpoints: Arc::new(Mutex::new(HashMap::new())),
            command_whitelist: Arc::new(Mutex::new(HashMap::new())),
            ghost_manager: Arc::new(crate::ghost::GhostManager::new(&data_dir)),
        }
    }
}

#[allow(dead_code)]
pub struct ConnectionHandle {
    pub config: ConnectionConfig,
    pub session: Option<Arc<Mutex<Handle<Client>>>>,
    pub sftp_session: Option<Arc<russh_sftp::client::SftpSession>>,
    pub detected_os: Option<String>,
    pub detected_shell: Option<String>,
}

/// Internal helper: establishes a full SSH connection (session + SFTP + OS detection)
/// and returns a fresh `ConnectionHandle`. Used for initial `ssh_connect` and reactive reconnection.
async fn reconnect_connection(
    config: &ConnectionConfig,
    ssh_manager: &crate::ssh::SshManager,
    tunnel_manager: &crate::tunnel::TunnelManager,
) -> Result<ConnectionHandle, String> {
    println!(
        "[SSH] (Re)connecting to {} ({}@{}:{})",
        config.name, config.username, config.host, config.port
    );

    let session = ssh_manager
        .connect(config.clone(), Arc::new(tunnel_manager.clone()))
        .await
        .map_err(|e| format!("Failed to connect: {}", e))?;

    // Initialize SFTP session
    let sftp_session = match session.channel_open_session().await {
        Ok(channel) => {
            if let Err(e) = channel.request_subsystem(true, "sftp").await {
                eprintln!("[SSH] Failed to request SFTP subsystem: {}", e);
                None
            } else {
                let stream = channel.into_stream();
                match russh_sftp::client::SftpSession::new(stream).await {
                    Ok(sftp) => Some(Arc::new(sftp)),
                    Err(e) => {
                        eprintln!("[SSH] Failed to initialize SFTP: {}", e);
                        None
                    }
                }
            }
        }
        Err(e) => {
            eprintln!("[SSH] Failed to open channel for SFTP: {}", e);
            None
        }
    };

    // Detect OS (best-effort — reuse cached value if already known via caller)
    let mut detected_os = None;
    if let Ok(mut channel) = session.channel_open_session().await {
        if channel.exec(true, "cat /etc/os-release").await.is_ok() {
            let mut output = String::new();
            while let Some(msg) = channel.wait().await {
                match msg {
                    russh::ChannelMsg::Data { data } => {
                        output.push_str(&String::from_utf8_lossy(&data))
                    }
                    russh::ChannelMsg::ExitStatus { .. } => break,
                    _ => {}
                }
            }
            for line in output.lines() {
                if line.starts_with("ID=") {
                    let id = line.trim_start_matches("ID=").trim_matches('"');
                    detected_os = Some(id.to_string());
                    break;
                }
            }
        }
    }
    if detected_os.is_none() {
        if let Ok(mut channel) = session.channel_open_session().await {
            if channel.exec(true, "uname -s").await.is_ok() {
                let mut output = String::new();
                while let Some(msg) = channel.wait().await {
                    match msg {
                        russh::ChannelMsg::Data { data } => {
                            output.push_str(&String::from_utf8_lossy(&data))
                        }
                        russh::ChannelMsg::ExitStatus { .. } => break,
                        _ => {}
                    }
                }
                let sys_name = output.trim().to_lowercase();
                if sys_name == "darwin" {
                    detected_os = Some("macos".to_string());
                } else if !sys_name.is_empty() {
                    detected_os = Some(sys_name);
                }
            }
        }
    }

    // Detect login shell (best-effort)
    let mut detected_shell = None;
    if let Ok(mut channel) = session.channel_open_session().await {
        if channel.exec(true, "basename \"${SHELL:-}\"").await.is_ok() {
            let mut output = String::new();
            while let Some(msg) = channel.wait().await {
                match msg {
                    russh::ChannelMsg::Data { data } => {
                        output.push_str(&String::from_utf8_lossy(&data))
                    }
                    russh::ChannelMsg::ExitStatus { .. } => break,
                    _ => {}
                }
            }
            let shell_name = output.trim().to_string();
            if !shell_name.is_empty() {
                detected_shell = Some(shell_name);
            }
        }
    }

    println!("[SSH] (Re)connected. Detected OS: {:?}, shell: {:?}", detected_os, detected_shell);

    Ok(ConnectionHandle {
        config: config.clone(),
        session: Some(Arc::new(Mutex::new(session))),
        sftp_session,
        detected_os,
        detected_shell,
    })
}

#[tauri::command]
pub async fn ssh_connect(
    config: ConnectionConfig,
    state: State<'_, AppState>,
) -> Result<ConnectionResponse, String> {
    println!(
        "[SSH] Connect request for: {} ({}@{}:{})",
        config.name, config.username, config.host, config.port
    );

    match reconnect_connection(&config, &state.ssh_manager, &state.tunnel_manager).await {
        Ok(handle) => {
            let detected_os = handle.detected_os.clone();
            let mut connections = state.connections.lock().await;
            connections.insert(config.id.clone(), handle);

            Ok(ConnectionResponse {
                success: true,
                message: "Connected".to_string(),
                term_id: Some(config.id.clone()),
                detected_os,
            })
        }
        Err(e) => {
            println!("[SSH] Connection failed: {}", e);
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn ssh_test_connection(
    config: ConnectionConfig,
    state: State<'_, AppState>,
) -> Result<String, String> {
    println!(
        "[SSH] Test connection for: {} ({}@{}:{})",
        config.name, config.username, config.host, config.port
    );

    match state
        .ssh_manager
        .connect(config.clone(), state.tunnel_manager.clone())
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
    })().unwrap_or_else(|| std::path::PathBuf::from("."));

    Ok(SystemInfo {
        data_dir: data_dir.to_string_lossy().to_string(),
        app_root: app_root.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn save_secret(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let store = app.store("secrets.json").map_err(|e| e.to_string())?;
    store.set(key, serde_json::Value::String(value));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_secret(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    let store = app.store("secrets.json").map_err(|e| e.to_string())?;
    Ok(store.get(key).and_then(|v| v.as_str().map(|s| s.to_string())))
}

#[tauri::command]
pub async fn delete_secret(app: tauri::AppHandle, key: String) -> Result<(), String> {
    let store = app.store("secrets.json").map_err(|e| e.to_string())?;
    store.delete(key);
    store.save().map_err(|e| e.to_string())?;
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

#[tauri::command]
pub async fn ssh_migrate_all_keys(app_handle: tauri::AppHandle) -> Result<usize, String> {
    let data_dir = get_data_dir(&app_handle);
    let connections_path = data_dir.join("connections.json");

    if !connections_path.exists() {
        return Ok(0);
    }

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

#[tauri::command]
pub async fn ssh_disconnect(id: String, state: State<'_, AppState>) -> Result<(), String> {
    println!("SSH Disconnect request for: {}", id);

    // First, close all associated PTYs to ensure tasks are aborted
    state
        .pty_manager
        .close_by_connection(&id)
        .await
        .map_err(|e| e.to_string())?;

    let mut connections = state.connections.lock().await;
    connections.remove(&id);
    // Explicit close logic if needed, but drop handles largely work.

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
    // Escape single quotes for shell safety to prevent command injection
    let escaped_path = path.replace("'", "'\\''");
    let cd_cmd = format!("cd '{}'\r", escaped_path);
    state
        .pty_manager
        .write(&term_id, &cd_cmd)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn connections_get(app: AppHandle) -> Result<SavedData, String> {
    let data_dir = get_data_dir(&app);
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

    std::fs::write(file_path, json).map_err(|e| e.to_string())?;

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
        connection.created_at.map(|value| value.to_string()).unwrap_or_default(),
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
        .replace(|ch: char| !ch.is_ascii_alphanumeric() && ch != '-' && ch != '_' && ch != '.', "-")
        .trim_matches('-')
        .to_string();

    if alias.is_empty() {
        alias = connection
            .host
            .trim()
            .replace(char::is_whitespace, "-")
            .replace(|ch: char| !ch.is_ascii_alphanumeric() && ch != '-' && ch != '_' && ch != '.', "-")
            .trim_matches('-')
            .to_string();
    }

    if alias.is_empty() {
        alias = connection.id.clone();
    }

    alias
}

fn filter_export_folders(all_folders: &[Folder], selected_connections: &[SavedConnection]) -> Vec<Folder> {
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
            id: if id.is_empty() { uuid::Uuid::new_v4().to_string() } else { id },
            name: if name.is_empty() { host.clone() } else { name },
            host,
            port,
            username,
            password: {
                let value = field(password_idx);
                if value.is_empty() { None } else { Some(value) }
            },
            private_key_path: {
                let value = field(key_idx);
                if value.is_empty() { None } else { Some(value) }
            },
            jump_server_id: {
                let value = field(jump_idx);
                if value.is_empty() { None } else { Some(value) }
            },
            last_connected: field(last_connected_idx).parse::<u64>().ok(),
            icon: None,
            folder: {
                let value = field(folder_idx);
                if value.is_empty() { None } else { Some(value) }
            },
            theme: {
                let value = field(theme_idx);
                if value.is_empty() { None } else { Some(value) }
            },
            tags: if tags.is_empty() { None } else { Some(tags) },
            created_at: field(created_idx).parse::<u64>().ok(),
            is_favorite: parse_bool_field(&field(favorite_idx)),
            pinned_features: if pinned_features.is_empty() { None } else { Some(pinned_features) },
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
) -> Result<String, String> {
    let path = request.path.trim();
    if path.is_empty() {
        return Err("Export path is required.".to_string());
    }

    let data = connections_get(app).await?;
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
            serde_json::to_string_pretty(&ZyncConnectionsExport {
                format: "zync-connections".to_string(),
                version: 1,
                exported_at_ms: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|duration| duration.as_millis() as u64)
                    .unwrap_or(0),
                connections: selected_connections,
                folders,
            })
            .map_err(|error| error.to_string())?
        }
        "json" => serde_json::to_string_pretty(&selected_connections).map_err(|error| error.to_string())?,
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

    std::fs::write(path, content).map_err(|error| format!("Failed to write export file: {}", error))?;
    Ok(path.to_string())
}

#[tauri::command]
pub async fn connections_import_from_file(
    request: ConnectionImportRequest,
) -> Result<SavedData, String> {
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
    let metadata = std::fs::metadata(file_path).map_err(|error| format!("Cannot read import file metadata: {}", error))?;
    if metadata.len() > MAX_CONNECTION_IMPORT_BYTES {
        return Err("Import file is too large (max 5 MiB).".to_string());
    }

    let content = std::fs::read_to_string(file_path).map_err(|error| format!("Failed to read import file: {}", error))?;
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
        "csv" => Ok(SavedData {
            connections: parse_csv_connections(&content)?,
            folders: vec![],
        }),
        "json" | "zync" => {
            if let Ok(zync_data) = serde_json::from_str::<ZyncConnectionsExport>(&content) {
                return Ok(SavedData {
                    connections: zync_data.connections,
                    folders: zync_data.folders,
                });
            }
            if let Ok(saved_data) = serde_json::from_str::<SavedData>(&content) {
                return Ok(saved_data);
            }
            if let Ok(connections) = serde_json::from_str::<Vec<SavedConnection>>(&content) {
                return Ok(SavedData {
                    connections,
                    folders: vec![],
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
    println!(
        "[TERM] Creating terminal for connection {} with ID {}, shell: {:?}",
        connection_id, term_id, shell
    );

    // Check if this is a local or remote connection
    if connection_id == "local" {
        println!("[TERM] Creating local PTY session");
        // Use term_id (UUID) for the session, not connection_id
        state
            .pty_manager
            .create_local_session(term_id.clone(), connection_id, generation, cols, rows, app, shell, cwd)
            .await
            .map_err(|e| e.to_string())?;
        Ok(term_id)
    } else {
        println!("[TERM] Creating remote SSH session");

        // Helper: get live session, reconnecting if necessary
        async fn get_live_session(
            connection_id: &str,
            state: &State<'_, AppState>,
        ) -> Result<Arc<Mutex<russh::client::Handle<crate::ssh::Client>>>, String> {
            let existing = {
                let connections = state.connections.lock().await;
                connections
                    .get(connection_id)
                    .and_then(|c| c.session.clone())
            };
            if let Some(s) = existing {
                return Ok(s);
            }
            // No session — reconnect using cached config
            let config = {
                let connections = state.connections.lock().await;
                connections
                    .get(connection_id)
                    .map(|c| c.config.clone())
                    .ok_or_else(|| format!("Connection config for {} not found", connection_id))?
            };
            let mut new_handle = reconnect_connection(
                &config,
                &state.ssh_manager,
                &state.tunnel_manager,
            )
            .await?;
            let new_session = new_handle
                .session
                .take()
                .ok_or("Reconnection did not produce a session")?;
            new_handle.session = Some(new_session.clone());
            state.connections.lock().await.insert(connection_id.to_string(), new_handle);
            Ok(new_session)
        }

        // 1. Get (or reconnect to get) a live session
        let session = get_live_session(&connection_id, &state).await?;

        // 2. Try opening a channel; if it fails (session dead), reconnect once and retry
        let channel = {
            let ch_result = {
                let guard = session.lock().await;
                guard.channel_open_session().await
            };
            match ch_result {
                Ok(ch) => ch,
                Err(e) => {
                    println!("[TERM] Channel open failed ({}), reconnecting...", e);
                    // Drop stale session, force a fresh one
                    let config = {
                        let connections = state.connections.lock().await;
                        connections
                            .get(&connection_id)
                            .map(|c| c.config.clone())
                            .ok_or_else(|| format!("Connection config for {} not found", connection_id))?
                    };
                    let mut new_handle = reconnect_connection(
                        &config,
                        &state.ssh_manager,
                        &state.tunnel_manager,
                    )
                    .await
                    .map_err(|e| format!("Auto-reconnect failed: {}", e))?;
                    let new_session = new_handle
                        .session
                        .take()
                        .ok_or("Reconnection did not produce a session")?;
                    new_handle.session = Some(new_session.clone());
                    state.connections.lock().await.insert(connection_id.clone(), new_handle);
                    let guard = new_session.lock().await;
                    guard
                        .channel_open_session()
                        .await
                        .map_err(|e| format!("Channel open failed after reconnect: {}", e))?
                }
            }
        };

        println!("[TERM] SSH channel opened, requesting PTY");
        state
            .pty_manager
            .create_remote_session(term_id.clone(), connection_id, generation, channel, cols, rows, app, cwd)
            .await
            .map_err(|e| e.to_string())?;

        Ok(term_id)
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

// Helper to get SFTP session - reconnects automatically if session is dead.
// Zero overhead for healthy connections; only re-establishes when needed.
async fn get_sftp_or_reconnect(
    state: &State<'_, AppState>,
    id: &str,
) -> Result<Arc<russh_sftp::client::SftpSession>, String> {
    // 1. Try to get existing SFTP session
    let config = {
        let connections = state.connections.lock().await;
        let conn = connections.get(id)
            .ok_or_else(|| format!("Connection {} not found, cannot reconnect for SFTP", id))?;
            
        if let Some(sftp) = &conn.sftp_session {
            return Ok(sftp.clone());
        }
        conn.config.clone()
    };

    // 2. Session dropped — attempt full reconnect
    println!("[SFTP] Session not found for '{}', attempting reconnect...", id);

    let timeout_duration = std::time::Duration::from_secs(12);
    let new_handle = match tokio::time::timeout(timeout_duration, reconnect_connection(&config, &state.ssh_manager, &state.tunnel_manager)).await {
        Ok(Ok(h)) => h,
        Ok(Err(e)) => return Err(format!("DISCONNECTED: Auto-reconnect failed: {}", e)),
        Err(_) => return Err(format!("DISCONNECTED: Auto-reconnect timed out after {}s (Is the network down?)", timeout_duration.as_secs())),
    };
    let sftp = new_handle
        .sftp_session
        .clone()
        .ok_or_else(|| "Reconnection succeeded but SFTP initialization failed".to_string())?;

    let mut connections = state.connections.lock().await;
    connections.insert(id.to_string(), new_handle);

    println!("[SFTP] Reconnected successfully for '{}'", id);
    Ok(sftp)
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
        println!("[FS] Listing remote dir: {} on {}", path, connection_id);
        let sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
        
        let timeout_duration = std::time::Duration::from_secs(10);
        match tokio::time::timeout(timeout_duration, state.file_system.list_remote(&sftp, &path)).await {
            Ok(Ok(res)) => Ok(res),
            Ok(Err(e)) if e.to_string().to_lowercase().contains("session closed") => {
                println!("[FS] SFTP session closed during list, retrying...");
                {
                    let mut connections = state.connections.lock().await;
                    if let Some(c) = connections.get_mut(&connection_id) {
                        c.sftp_session = None;
                    }
                }
                let sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
                match tokio::time::timeout(timeout_duration, state.file_system.list_remote(&sftp, &path)).await {
                    Ok(Ok(res)) => Ok(res),
                    Ok(Err(e)) => Err(e.to_string()),
                    Err(_) => Err(format!("DISCONNECTED: SFTP listing timed out after {}s", timeout_duration.as_secs())),
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
                Err(format!("DISCONNECTED: SFTP listing timed out after {}s", timeout_duration.as_secs()))
            }
        }
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
        let sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
        let timeout_duration = std::time::Duration::from_secs(10);
        
        match tokio::time::timeout(timeout_duration, state.file_system.read_remote(&sftp, &path)).await {
            Ok(Ok(res)) => Ok(res),
            Ok(Err(e)) if e.to_string().to_lowercase().contains("session closed") => {
                println!("[FS] SFTP session closed during read, retrying...");
                {
                    let mut connections = state.connections.lock().await;
                    if let Some(c) = connections.get_mut(&connection_id) {
                        c.sftp_session = None;
                    }
                }
                let sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
                match tokio::time::timeout(timeout_duration, state.file_system.read_remote(&sftp, &path)).await {
                    Ok(Ok(res)) => Ok(res),
                    Ok(Err(e)) => Err(e.to_string()),
                    Err(_) => Err(format!("DISCONNECTED: SFTP read timed out after {}s", timeout_duration.as_secs())),
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
                Err(format!("DISCONNECTED: SFTP read timed out after {}s", timeout_duration.as_secs()))
            }
        }
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
        
        match tokio::time::timeout(timeout_duration, state.file_system.write_remote(&sftp, &path, content.as_bytes())).await {
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
                match tokio::time::timeout(timeout_duration, state.file_system.write_remote(&sftp, &path, content.as_bytes())).await {
                    Ok(Ok(_)) => Ok(()),
                    Ok(Err(e)) => Err(e.to_string()),
                    Err(_) => Err(format!("DISCONNECTED: SFTP write timed out after {}s", timeout_duration.as_secs())),
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
                Err(format!("DISCONNECTED: SFTP write timed out after {}s", timeout_duration.as_secs()))
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
        println!("[FS] Getting remote CWD for {}", connection_id);
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
                    Err(_) => Err(format!("DISCONNECTED: SFTP cwd timed out after {}s", timeout_duration.as_secs())),
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
                Err(format!("DISCONNECTED: SFTP cwd timed out after {}s", timeout_duration.as_secs()))
            }
        }
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
            return Err(format!("An item with the name '{}' already exists in this directory.", std::path::Path::new(&path).file_name().unwrap_or_default().to_string_lossy()));
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
                 return Err(format!("An item with the name '{}' already exists in this directory.", std::path::Path::new(&path).file_name().unwrap_or_default().to_string_lossy()));
            }
            state.file_system.create_file_remote(&sftp, &path).await.map_err(|e| e.to_string())
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
                    state.file_system.create_file_remote(&sftp, &path).await.map_err(|e| e.to_string())
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
                        Err(format!("DISCONNECTED: SFTP touch timed out after {}s", timeout_duration.as_secs()))
                    },
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
                Err(format!("DISCONNECTED: SFTP touch timed out after {}s", timeout_duration.as_secs()))
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
             return Err(format!("An item with the name '{}' already exists in this directory.", std::path::Path::new(&path).file_name().unwrap_or_default().to_string_lossy()));
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
                 return Err(format!("An item with the name '{}' already exists in this directory.", std::path::Path::new(&path).file_name().unwrap_or_default().to_string_lossy()));
            }
            state.file_system.create_dir_remote(&sftp, &path).await.map_err(|e| e.to_string())
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
                    state.file_system.create_dir_remote(&sftp, &path).await.map_err(|e| e.to_string())
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
                        Err(format!("DISCONNECTED: SFTP mkdir timed out after {}s", timeout_duration.as_secs()))
                    },
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
                Err(format!("DISCONNECTED: SFTP mkdir timed out after {}s", timeout_duration.as_secs()))
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
             let parent = path_buf.parent().unwrap_or_else(|| std::path::Path::new(""));
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
            match tokio::time::timeout(timeout_duration, state.file_system.get_unique_path_remote(&sftp, &new_path)).await {
                Ok(Ok(unique_path)) => {
                    new_path = unique_path;
                }
                Ok(Err(e)) if e.to_string().to_lowercase().contains("session closed") => {
                    println!("[FS] SFTP session closed during name check, retrying...");
                    sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
                    new_path = tokio::time::timeout(timeout_duration, state.file_system.get_unique_path_remote(&sftp, &new_path))
                        .await
                        .map_err(|e| format!("Timeout generating unique path: {}", e))?
                        .map_err(|e| e.to_string())?;
                }
                Ok(Err(e)) => return Err(e.to_string()),
                Err(_) => return Err("Timeout generating unique path".to_string()),
            }
        }
        
        match tokio::time::timeout(timeout_duration, state.file_system.rename_remote(&sftp, &old_path, &new_path)).await {
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
                match tokio::time::timeout(timeout_duration, state.file_system.rename_remote(&sftp, &old_path, &new_path)).await {
                    Ok(Ok(_)) => Ok(()),
                    Ok(Err(e)) => Err(e.to_string()),
                    Err(_) => Err(format!("DISCONNECTED: SFTP rename timed out after {}s", timeout_duration.as_secs())),
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
                Err(format!("DISCONNECTED: SFTP rename timed out after {}s", timeout_duration.as_secs()))
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
                // Simple quoting for paths
                let cmd = format!("rm -rf '{}'", path.replace("'", "'\\''"));
                println!("[FS] Attempting server-side delete: {}", cmd);

                let timeout_duration = std::time::Duration::from_secs(10);
                let optimize_fut = async {
                    match session.lock().await.channel_open_session().await {
                        Ok(mut channel) => {
                            if let Ok(_) = channel.exec(true, cmd).await {
                                let mut success = false;
                                let mut output_log = String::new();
                                while let Some(msg) = channel.wait().await {
                                    match msg {
                                        russh::ChannelMsg::Data { data } => output_log.push_str(&String::from_utf8_lossy(&data)),
                                        russh::ChannelMsg::ExtendedData { data, .. } => output_log.push_str(&String::from_utf8_lossy(&data)),
                                        russh::ChannelMsg::ExitStatus { exit_status } => {
                                            if exit_status == 0 { success = true; }
                                            break;
                                        }
                                        _ => {}
                                    }
                                }
                                success
                            } else { false }
                        }
                        Err(_) => false,
                    }
                };

                match tokio::time::timeout(timeout_duration, optimize_fut).await {
                    Ok(true) => {
                        println!("[FS] Server-side delete successful.");
                        return Ok(());
                    }
                    _ => println!("[FS] Server-side delete failed or timed out. Checking SFTP fallback..."),
                }
            }
        }

        // Fallback to SFTP (recursive delete implemented there)
        println!("[FS] Falling back to SFTP delete...");
        let sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
        let timeout_duration = std::time::Duration::from_secs(10);
        
        match tokio::time::timeout(timeout_duration, state.file_system.delete_remote(&sftp, &path)).await {
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
                match tokio::time::timeout(timeout_duration, state.file_system.delete_remote(&sftp, &path)).await {
                    Ok(Ok(_)) => Ok(()),
                    Ok(Err(e)) => Err(e.to_string()),
                    Err(_) => Err(format!("DISCONNECTED: SFTP delete timed out after {}s", timeout_duration.as_secs())),
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
                Err(format!("DISCONNECTED: SFTP delete timed out after {}s", timeout_duration.as_secs()))
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
                        .map(|p| format!("'{}'", p.replace("'", "'\\''")))
                        .collect::<Vec<_>>()
                        .join(" ");
                    
                    let cmd = format!("rm -rf {}", paths_str);
                    println!("[FS] Attempting batch server-side delete: {}", cmd);
                    
                    channel.exec(true, cmd).await.map_err(|e| format!("Exec failed: {}", e))?;

                    let mut success = false;
                    while let Some(msg) = channel.wait().await {
                        if let russh::ChannelMsg::ExitStatus { exit_status } = msg {
                            if exit_status == 0 { success = true; }
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
                    Ok(Err(e)) => println!("[FS] Batch SSH delete error: {}. Falling back to SFTP...", e),
                    Err(_) => println!("[FS] Batch SSH delete timed out after {}s. Falling back to SFTP...", timeout_duration.as_secs()),
                    _ => println!("[FS] Batch SSH delete failed, falling back to SFTP..."),
                }
            }
        }

        // Fallback: Individual SFTP deletes with retry logic
        async fn perform_sftp_batch_delete(
            sftp: &Arc<russh_sftp::client::SftpSession>,
            paths: &[String],
            fs: &Arc<FileSystem>
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
            Err(e) => return Err(BatchDeleteError { message: e, failed_paths: paths }),
        };

        let mut failed_paths = perform_sftp_batch_delete(&sftp, &paths, &state.file_system).await;
        
        // If some failed, maybe it was a session disconnect? Try reconnecting ONCE for the failures
        if !failed_paths.is_empty() {
            println!("[FS] Some batch deletes failed, attempting one-time reconnect for {} items...", failed_paths.len());
            {
                let mut connections = state.connections.lock().await;
                if let Some(c) = connections.get_mut(&connection_id) {
                    c.sftp_session = None;
                }
            }
            if let Ok(retry_sftp) = get_sftp_or_reconnect(&state, &connection_id).await {
                // Only retry the previously failed paths
                let still_failed = perform_sftp_batch_delete(&retry_sftp, &failed_paths, &state.file_system).await;
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
                let cmd = format!(
                    "cp -r '{}' '{}'",
                    from.replace("'", "'\\''"),
                    to.replace("'", "'\\''")
                );
                println!("[FS] Attempting server-side copy: {}", cmd);

                match session.lock().await.channel_open_session().await {
                    Ok(mut channel) => {
                        if let Ok(_) = channel.exec(true, cmd).await {
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
                            if success {
                                println!("[FS] Server-side copy successful");
                                return Ok(());
                            } else {
                                println!("[FS] Server-side copy failed (non-zero exit), checking SFTP fallback...");
                            }
                        }
                    }
                    Err(e) => println!("[FS] Failed to open channel for copy optimization: {}", e),
                }
            }
        }

        // Fallback to SFTP
        let sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
        let timeout_duration = std::time::Duration::from_secs(10);
        
        match tokio::time::timeout(timeout_duration, state.file_system.copy_remote(&sftp, &from, &to)).await {
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
                match tokio::time::timeout(timeout_duration, state.file_system.copy_remote(&sftp, &from, &to)).await {
                    Ok(Ok(_)) => Ok(()),
                    Ok(Err(e)) => Err(e.to_string()),
                    Err(_) => Err(format!("DISCONNECTED: SFTP copy timed out after {}s", timeout_duration.as_secs())),
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
                Err(format!("DISCONNECTED: SFTP copy timed out after {}s", timeout_duration.as_secs()))
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
                let mut channel = session
                    .lock()
                    .await
                    .channel_open_session()
                    .await
                    .map_err(|e| format!("Failed to open channel: {}", e))?;

                // Build a multi-command string: cp -r 'a' 'b' && cp -r 'c' 'd' ...
                let cmd = operations
                    .iter()
                    .map(|op| {
                        format!(
                            "cp -r '{}' '{}'",
                            op.from.replace("'", "'\\''"),
                            op.to.replace("'", "'\\''")
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(" && ");

                println!("[FS] Attempting batch server-side copy: {}", cmd);
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

                if let Some(0) = exit_code {
                    println!("[FS] Batch server-side copy successful");
                    return Ok(());
                } else {
                    println!("[FS] Batch server-side copy failed with exit code {:?}, falling back to SFTP...", exit_code);
                }
            }
        }

        // Final fallback: Sequential SFTP if no session or optimization fails
        let mut current_sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
        let timeout_duration = std::time::Duration::from_secs(10);
        
        let mut idx = 0;
        while idx < operations.len() {
            let op = &operations[idx];
            match tokio::time::timeout(timeout_duration, state.file_system.copy_remote(&current_sftp, &op.from, &op.to)).await {
                Ok(Ok(_)) => {
                    idx += 1;
                }
                Ok(Err(e)) if e.to_string().to_lowercase().contains("session closed") => {
                    println!("[FS] SFTP session closed during batch item {}, retrying...", idx);
                    {
                        let mut connections = state.connections.lock().await;
                        if let Some(c) = connections.get_mut(&connection_id) {
                            c.sftp_session = None;
                        }
                    }
                    current_sftp = get_sftp_or_reconnect(&state, &connection_id).await?;
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
                    return Err(format!("DISCONNECTED: SFTP batch copy timed out at item {} after {}s", idx, timeout_duration.as_secs()));
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
                state.file_system.rename_remote(&sftp, &op.from, &op.to)
            ).await;

            let final_res = match res {
                Ok(inner) => inner.map_err(|e| e.to_string()),
                Err(_) => Err("DISCONNECTED: SFTP session timeout".to_string()),
            };

            if let Err(e) = final_res {
                if e.to_lowercase().contains("session closed") || e.contains("DISCONNECTED:") {
                    println!("[FS] SFTP session closed or timed out during batch rename, retrying...");
                    {
                        let mut connections = state.connections.lock().await;
                        if let Some(c) = connections.get_mut(&connection_id) {
                            c.sftp_session = None;
                        }
                    }
                    let sftp_fresh = get_sftp_or_reconnect(&state, &connection_id).await?;
                    // Resume from current op
                    for retry_op in operations.iter().skip_while(|oo| oo.from != op.from) {
                        let retry_res = tokio::time::timeout(
                            Duration::from_secs(10),
                            state.file_system.rename_remote(&sftp_fresh, &retry_op.from, &retry_op.to)
                        ).await;

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
            state.file_system.exists_remote(&sftp, &path)
        ).await;

        let final_res = match res {
            Ok(inner) => inner.map_err(|e| e.to_string()),
            Err(_) => Err("DISCONNECTED: SFTP session timeout".to_string()),
        };

        match final_res {
            Ok(res) => Ok(res),
            Err(e) if e.to_lowercase().contains("session closed") || e.contains("DISCONNECTED:") => {
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
                    state.file_system.exists_remote(&sftp, &path)
                ).await;

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
pub async fn tunnel_start_local(
    connection_id: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let session = {
        let connections = state.connections.lock().await;
        connections
            .get(&connection_id)
            .and_then(|c| c.session.clone())
            .ok_or_else(|| format!("Connection {} not found", connection_id))?
    };

    let res: anyhow::Result<String> = state
        .tunnel_manager
        .start_local_forwarding(
            session,
            "127.0.0.1".to_string(),
            local_port,
            remote_host,
            remote_port,
        )
        .await;
    res.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tunnel_start_remote(
    connection_id: String,
    remote_port: u16,
    local_host: String,
    local_port: u16,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let session = {
        let connections = state.connections.lock().await;
        connections
            .get(&connection_id)
            .and_then(|c| c.session.clone())
            .ok_or_else(|| format!("Connection {} not found", connection_id))?
    };

    let res: anyhow::Result<String> = state
        .tunnel_manager
        .start_remote_forwarding(
            session,
            "0.0.0.0".to_string(),
            remote_port,
            local_host,
            local_port,
        )
        .await;
    res.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tunnel_stop(
    app: AppHandle,
    id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // 1. Load tunnel config to reconstruct ID
    let data_dir = get_data_dir(&app);
    let file_path = data_dir.join("tunnels.json");
    if !file_path.exists() {
        return Ok(()); // Nothing to stop
    }
    let data = std::fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    let saved_data: SavedTunnelsData = serde_json::from_str(&data).map_err(|e| e.to_string())?;

    let tunnel = saved_data
        .tunnels
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| "Tunnel key not found".to_string())?;

    // 2. Reconstruct internal ID
    let internal_id = if tunnel.tunnel_type == "local" {
        format!("local:{}:{}", tunnel.local_port, tunnel.remote_port)
    } else {
        format!("remote:{}:{}", tunnel.remote_port, tunnel.local_port)
    };

    let bind_address = tunnel.bind_address.clone();

    // 3. Get session (needed for remote cancellation)
    let session = {
        let connections = state.connections.lock().await;
        connections
            .get(&tunnel.connection_id)
            .and_then(|c| c.session.clone())
    };

    // 4. Stop
    println!("[TUNNEL CMD] Stopping tunnel: internal_id={}", internal_id);
    let res = state
        .tunnel_manager
        .stop_tunnel(session, internal_id, bind_address)
        .await;

    if let Err(ref e) = res {
        let _ = app.emit(
            "tunnel:status-change",
            TunnelStatusChange {
                id: id.clone(),
                status: "error".to_string(),
                error: Some(e.to_string()),
            },
        );
    } else {
        let _ = app.emit(
            "tunnel:status-change",
            TunnelStatusChange {
                id: id.clone(),
                status: "stopped".to_string(),
                error: None,
            },
        );
    }

    res.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn window_is_maximized(app: AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|w| w.is_maximized().ok())
        .unwrap_or(false)
}

#[tauri::command]
pub async fn window_maximize(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("Main window not found")?;
    if window.is_maximized().map_err(|e| e.to_string())? {
        window.unmaximize().map_err(|e| e.to_string())?;
    } else {
        window.maximize().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn window_minimize(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("Main window not found")?;
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn window_close(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("Main window not found")?;
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tunnel_list(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<SavedTunnel>, String> {
    // let connection_id = connectionId; // Resolved: using snake_case directly
    let data_dir = get_data_dir(&app);
    let file_path = data_dir.join("tunnels.json");

    if !file_path.exists() {
        return Ok(vec![]);
    }

    let data = std::fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    let saved_data: SavedTunnelsData = serde_json::from_str(&data).map_err(|e| e.to_string())?;

    let mut tunnels: Vec<SavedTunnel> = saved_data
        .tunnels
        .into_iter()
        .filter(|t| t.connection_id == connection_id)
        .collect();

    // Inject dynamic status
    let local_listeners: tokio::sync::MutexGuard<
        '_,
        std::collections::HashMap<
            String,
            (tokio::task::AbortHandle, tokio::sync::broadcast::Sender<()>),
        >,
    > = state.tunnel_manager.local_listeners.lock().await;
    let remote_forwards: tokio::sync::MutexGuard<
        '_,
        std::collections::HashMap<u16, (String, u16, String)>,
    > = state.tunnel_manager.remote_forwards.lock().await;

    for t in &mut tunnels {
        let is_active = if t.tunnel_type == "local" {
            let id = format!("local:{}:{}", t.local_port, t.remote_port);
            local_listeners.contains_key(&id)
        } else {
            // remote maps u16 -> (host, port)
            // Just check if the remote port is bound
            remote_forwards.contains_key(&t.remote_port)
        };

        if is_active {
            t.status = Some("active".to_string());
        } else {
            t.status = Some("stopped".to_string());
        }
    }

    Ok(tunnels)
}

#[tauri::command]
pub async fn tunnel_save(app: AppHandle, tunnel_val: serde_json::Value) -> Result<(), String> {
    let tunnel: SavedTunnel = serde_json::from_value(tunnel_val).map_err(|e| e.to_string())?;
    let data_dir = get_data_dir(&app);
    if !data_dir.exists() {
        std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    }
    let file_path = data_dir.join("tunnels.json");

    let mut tunnels = if file_path.exists() {
        let data = std::fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
        let saved: SavedTunnelsData = serde_json::from_str(&data).map_err(|e| e.to_string())?;
        saved.tunnels
    } else {
        vec![]
    };

    if let Some(idx) = tunnels.iter().position(|t| t.id == tunnel.id) {
        tunnels[idx] = tunnel;
    } else {
        tunnels.push(tunnel);
    }

    let json =
        serde_json::to_string_pretty(&SavedTunnelsData { tunnels }).map_err(|e| e.to_string())?;
    std::fs::write(file_path, json).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn tunnel_delete(app: AppHandle, id: String) -> Result<(), String> {
    let data_dir = get_data_dir(&app);
    let file_path = data_dir.join("tunnels.json");

    if !file_path.exists() {
        return Ok(());
    }

    let data = std::fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
    let mut saved: SavedTunnelsData = serde_json::from_str(&data).map_err(|e| e.to_string())?;

    saved.tunnels.retain(|t| t.id != id);

    let json = serde_json::to_string_pretty(&saved).map_err(|e| e.to_string())?;
    std::fs::write(file_path, json).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn tunnel_start(
    app: AppHandle,
    id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // 1. Load tunnel config
    let data_dir = get_data_dir(&app);
    let file_path = data_dir.join("tunnels.json");
    if !file_path.exists() {
        return Err("Tunnels file not found".to_string());
    }
    let data = std::fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    let saved_data: SavedTunnelsData = serde_json::from_str(&data).map_err(|e| e.to_string())?;

    let tunnel = saved_data
        .tunnels
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| "Tunnel not found".to_string())?;

    // 2. Get session
    let session = {
        let connections = state.connections.lock().await;
        connections
            .get(&tunnel.connection_id)
            .and_then(|c| c.session.clone())
            .ok_or_else(|| {
                format!(
                    "Connection {} not found or session closed",
                    tunnel.connection_id
                )
            })?
    };

    let res = if tunnel.tunnel_type == "local" {
        let bind_addr = tunnel
            .bind_address
            .clone()
            .unwrap_or_else(|| "127.0.0.1".to_string());
        state
            .tunnel_manager
            .start_local_forwarding(
                session,
                bind_addr,
                tunnel.local_port,
                tunnel.remote_host,
                tunnel.remote_port,
            )
            .await
    } else {
        let bind_addr = tunnel
            .bind_address
            .clone()
            .unwrap_or_else(|| "127.0.0.1".to_string());
        state
            .tunnel_manager
            .start_remote_forwarding(
                session,
                bind_addr,
                tunnel.remote_port,
                tunnel.remote_host.clone(),
                tunnel.local_port,
            )
            .await
    };

    if let Err(ref e) = res {
        let _ = app.emit(
            "tunnel:status-change",
            TunnelStatusChange {
                id: id.clone(),
                status: "error".to_string(),
                error: Some(e.to_string()),
            },
        );
    } else {
        let _ = app.emit(
            "tunnel:status-change",
            TunnelStatusChange {
                id: id.clone(),
                status: "active".to_string(),
                error: None,
            },
        );
    }

    res.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tunnel_get_all(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<SavedTunnel>, String> {
    let data_dir = get_data_dir(&app);
    let file_path = data_dir.join("tunnels.json");

    if !file_path.exists() {
        return Ok(vec![]);
    }

    let data = std::fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    let saved_data: SavedTunnelsData = serde_json::from_str(&data).map_err(|e| e.to_string())?;

    let mut tunnels = saved_data.tunnels;

    // Inject dynamic status
    let local_listeners = state.tunnel_manager.local_listeners.lock().await;
    let remote_forwards = state.tunnel_manager.remote_forwards.lock().await;

    for t in &mut tunnels {
        let is_active = if t.tunnel_type == "local" {
            let id = format!("local:{}:{}", t.local_port, t.remote_port);
            local_listeners.contains_key(&id)
        } else {
            remote_forwards.contains_key(&t.remote_port)
        };

        if is_active {
            t.status = Some("active".to_string());
        } else {
            t.status = Some("stopped".to_string());
        }
    }

    Ok(tunnels)
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

#[tauri::command]
pub async fn ssh_import_config(
    app: AppHandle,
) -> Result<Vec<crate::ssh_config::ParsedSshConnection>, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let config_path = home.join(".ssh/config");

    // println!("[SSH] Importing config from: {:?}", config_path);

    crate::ssh_config::parse_config(&config_path).map_err(|e| e.to_string())
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
    std::fs::File::open(config_path)
        .map_err(|e| format!("Cannot read SSH config file: {}", e))?;

    crate::ssh_config::parse_config(config_path).map_err(|e| e.to_string())
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

    crate::ssh_config::parse_config_text(&content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ssh_import_config_by_source(
    app: AppHandle,
    request: SshImportSourceRequest,
) -> Result<Vec<crate::ssh_config::ParsedSshConnection>, String> {
    match request.source_type.as_str() {
        "default_ssh" => ssh_import_config(app).await,
        "file" => {
            let path = request
                .path
                .as_deref()
                .unwrap_or("")
                .trim()
                .to_string();
            if path.is_empty() {
                return Err("Select an SSH config file path first.".to_string());
            }
            ssh_import_config_from_file(path).await
        }
        "text" => {
            let content = request
                .content
                .as_deref()
                .unwrap_or("")
                .to_string();
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
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let file_path = data_dir.join("settings.json");

    if !file_path.exists() {
        return Ok(serde_json::json!({}));
    }

    let data = std::fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    let settings: serde_json::Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;

    Ok(settings)
}

#[tauri::command]
pub async fn settings_set(app: AppHandle, settings: serde_json::Value) -> Result<(), String> {
    // Always write to the default app_data_dir for bootstrap purposes
    let default_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if !default_dir.exists() {
        std::fs::create_dir_all(&default_dir).map_err(|e| e.to_string())?;
    }

    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;

    // Write to bootstrap location (app_data_dir)
    let bootstrap_path = default_dir.join("settings.json");
    std::fs::write(&bootstrap_path, &json).map_err(|e| e.to_string())?;

    // Also write to the configured dataPath if it's set
    if let Some(data_path) = settings.get("dataPath").and_then(|v| v.as_str()) {
        if !data_path.is_empty() {
            let custom_dir = std::path::PathBuf::from(data_path);
            if !custom_dir.exists() {
                std::fs::create_dir_all(&custom_dir).map_err(|e| e.to_string())?;
            }
            let custom_settings_path = custom_dir.join("settings.json");
            std::fs::write(custom_settings_path, &json).map_err(|e| e.to_string())?;
        }
    }




    Ok(())
}

use tauri::Emitter;

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

        let result = async {
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

            Ok(())
        }
        .await;

        // Cleanup cancellation token
        {
            let mut transfers = state.transfers.lock().await;
            transfers.remove(&tid);
        }

        match result {
            Ok(_) => {
                let _ = app_handle.emit(
                    "transfer-progress",
                    TransferProgress {
                        id: tid.clone(),
                        transferred: 100, // Make sure it finishes
                        total: 100,
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
    use base64::Engine;
    use tauri::WebviewWindowBuilder;
    let label = format!("plugin-window-{}", uuid::Uuid::new_v4());
    let mut builder = WebviewWindowBuilder::new(
        &app,
        &label,
        if let Some(u) = url {
            tauri::WebviewUrl::External(u.parse().map_err(|e: url::ParseError| e.to_string())?)
        } else if let Some(h) = html {
            // For HTML content, we use a data URL for simplicity in MVP
            let data_url = format!(
                "data:text/html;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(h)
            );
            tauri::WebviewUrl::External(
                data_url
                    .parse()
                    .map_err(|e: url::ParseError| e.to_string())?,
            )
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

    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn config_select_folder(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app.dialog().file().blocking_pick_folder();
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

            let mut out_file = std::fs::File::create(&local_path)
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
                        use std::io::Write;
                        out_file
                            .write_all(data)
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
    query: String,
    context: crate::ai::TerminalContext,
    request_id: String,
) -> Result<crate::ai::AiTranslateResponse, String> {
    let config = crate::ai::read_ai_config(&app);
    if !config.enabled {
        return Err("AI is disabled in Settings -> AI.".to_string());
    }
    crate::ai::translate(&app, query, context, request_id, config).await
}

#[tauri::command]
pub async fn ai_translate_stream(
    app: AppHandle,
    query: String,
    context: crate::ai::TerminalContext,
    request_id: String,
    history: Vec<crate::ai::ChatMessage>,
) -> Result<(), String> {
    let config = crate::ai::read_ai_config(&app);
    if !config.enabled {
        return Err("AI is disabled in Settings -> AI.".to_string());
    }
    tauri::async_runtime::spawn(crate::ai::translate_stream(
        app, query, context, request_id, config, history,
    ));
    Ok(())
}

#[tauri::command]
pub async fn ai_check_ollama(app: AppHandle) -> Result<bool, String> {
    let config = crate::ai::read_ai_config(&app);
    let url = config
        .ollama_url
        .as_deref()
        .unwrap_or("http://localhost:11434");
    Ok(crate::ai::check_ollama(url).await)
}

#[tauri::command]
pub async fn ai_get_ollama_models(app: AppHandle) -> Result<Vec<String>, String> {
    crate::ai::get_ollama_models(&app).await
}

#[tauri::command]
pub async fn ai_get_provider_models(app: AppHandle) -> Result<Vec<String>, String> {
    crate::ai::get_provider_models(&app).await
}

// Agent v2 commands

/// Start an agentic run. Returns immediately; the loop runs in the background
/// and emits events: ai:agent-thinking, ai:tool-start, ai:tool-output,
/// ai:tool-done, ai:tool-diff, ai:agent-checkpoint, ai:agent-done, ai:agent-error.
#[tauri::command]
pub async fn ai_agent_run(
    app: AppHandle,
    state: State<'_, AppState>,
    request: crate::ai::AgentRunRequest,
) -> Result<(), String> {
    let config = crate::ai::read_ai_config(&app);
    if !config.enabled {
        return Err("AI is disabled in Settings -> AI.".to_string());
    }

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

/// Cancel a running agent loop by its run_id.
#[tauri::command]
pub async fn ai_agent_stop(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<(), String> {
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
