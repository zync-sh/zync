use crate::types::*;
use crate::pty::PtyManager;
use crate::fs::{FileSystem, FileEntry};
use crate::ssh::{SshManager, Client};
use russh::client::Handle;
use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, State, Manager};
use tokio::sync::Mutex;

use crate::tunnel::TunnelManager;
use serde::{Serialize, Deserialize};

/// Helper function to get the data directory.
/// Reads the configured `dataPath` from settings.json if available,
/// otherwise falls back to the default app_data_dir.
/// This ensures user-selected paths from the setup wizard are respected on all platforms.
pub fn get_data_dir(app: &AppHandle) -> std::path::PathBuf {
    let default_dir = app.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
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
    pub transfers: Arc<Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>>,
}

impl AppState {
    pub fn new(data_dir: std::path::PathBuf) -> Self {
        Self {
            connections: Arc::new(Mutex::new(HashMap::new())),
            pty_manager: Arc::new(PtyManager::new()),
            file_system: Arc::new(FileSystem::new()),
            ssh_manager: Arc::new(SshManager::new()),
            tunnel_manager: Arc::new(TunnelManager::new()),
            snippets_manager: Arc::new(crate::snippets::SnippetsManager::new(data_dir)),
            transfers: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[allow(dead_code)]
pub struct ConnectionHandle {
    pub config: ConnectionConfig,
    pub session: Option<Arc<Mutex<Handle<Client>>>>,
    pub sftp_session: Option<Arc<russh_sftp::client::SftpSession>>,
    pub detected_os: Option<String>,
}

#[tauri::command]
pub async fn ssh_connect(
    config: ConnectionConfig,
    state: State<'_, AppState>,
) -> Result<ConnectionResponse, String> {
    println!("[SSH] Connect request for: {} ({}@{}:{})", config.name, config.username, config.host, config.port);
    
    println!("[SSH] Attempting connection...");
    match state.ssh_manager.connect(config.clone(), state.tunnel_manager.clone()).await {
        Ok(session) => {
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
                 },
                 Err(e) => {
                     eprintln!("[SSH] Failed to open channel for SFTP: {}", e);
                     None
                 }
            };

            // Detect OS
            let mut detected_os = None;
            if let Ok(mut channel) = session.channel_open_session().await {
                 // 1. Try /etc/os-release (Linux)
                 if let Ok(_) = channel.exec(true, "cat /etc/os-release").await {
                     let mut output = String::new();
                     while let Some(msg) = channel.wait().await {
                         match msg {
                             russh::ChannelMsg::Data { data } => output.push_str(&String::from_utf8_lossy(&data)),
                             russh::ChannelMsg::ExitStatus { .. } => break,
                             _ => {}
                         }
                     }
                     // Parse ID=ubuntu or ID="ubuntu"
                     for line in output.lines() {
                         if line.starts_with("ID=") {
                             let id = line.trim_start_matches("ID=").trim_matches('"');
                             detected_os = Some(id.to_string());
                             break;
                         }
                     }
                 }
            }
            
            // 2. Fallback to uname -s (macOS / BSD / Legacy)
            if detected_os.is_none() {
                if let Ok(mut channel) = session.channel_open_session().await {
                    if let Ok(_) = channel.exec(true, "uname -s").await {
                        let mut output = String::new();
                        while let Some(msg) = channel.wait().await {
                            match msg {
                                russh::ChannelMsg::Data { data } => output.push_str(&String::from_utf8_lossy(&data)),
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
            
            println!("[SSH] Connected successfully. Detected OS: {:?}", detected_os);

             // IMPORTANT: We need RE-STORE the session because session was moved?
             // No, `session` variable is `Handle<Client>`.
             // `let sftp_session` block above used `session.channel_open_session()`.
             // `Handle` usually implements Clone? No, `session` returned by `connect` is likely `Handle`.
             // Check Line 51: `state.ssh_manager.connect(...)` returns `Handle<Client>`.
             // `Handle` is cheap to clone? It's an Arc internally usually.
             // Wait, `impl Clone for Handle<T>`. Yes.
             // So I can clone it for OS Check if needed, or just use it (reference or value).
             // `session` is used below in `ConnectionHandle { ... session: Some(Arc::new(Mutex::new(session))) }`.
             // If I use `session` above in `channel_open_session`, does it consume it?
             // `channel_open_session(&self)`. It takes `&self`. So `session` is fine.

            let mut connections = state.connections.lock().await;
            connections.insert(config.id.clone(), ConnectionHandle {
                config: config.clone(),
                session: Some(Arc::new(Mutex::new(session))),
                sftp_session,
                detected_os: detected_os.clone(),
            });

            Ok(ConnectionResponse {
                success: true,
                message: "Connected".to_string(),
                term_id: Some(config.id.clone()),
                detected_os,
            })
        }
        Err(e) => {
            println!("[SSH] Connection failed: {}", e);
            Err(format!("Failed to connect: {}", e))
        }
    }
}

#[tauri::command]
pub async fn ssh_test_connection(
    config: ConnectionConfig,
    state: State<'_, AppState>,
) -> Result<String, String> {
    println!("[SSH] Test connection for: {} ({}@{}:{})", config.name, config.username, config.host, config.port);
    
    match state.ssh_manager.connect(config.clone(), state.tunnel_manager.clone()).await {
        Ok(session) => {
             // Try a simple command to verify session
            let result = match session.channel_open_session().await {
                Ok(mut channel) => {
                    if let Ok(_) = channel.exec(true, "echo success").await {
                         let mut success = false;
                         while let Some(msg) = channel.wait().await {
                             if let russh::ChannelMsg::ExitStatus { exit_status } = msg {
                                 if exit_status == 0 { success = true; }
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
                },
                Err(_) => Ok("Authentication Successful (Session Open Failed)".to_string()) 
            };
            result
        },
        Err(e) => Err(format!("Connection Failed: {}", e)),
    }
}

#[tauri::command]
pub async fn ssh_extract_pem(
    app_handle: tauri::AppHandle,
    path: String,
) -> Result<String, String> {
    let data_dir = get_data_dir(&app_handle);
    let keys_dir = data_dir.join("keys");
    
    if !keys_dir.exists() {
        std::fs::create_dir_all(&keys_dir).map_err(|e| e.to_string())?;
    }

    let src_path = std::path::Path::new(&path);
    let filename = src_path.file_name().ok_or("Invalid file path")?.to_string_lossy();
    
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
        let mut perms = std::fs::metadata(&dest_path).map_err(|e| e.to_string())?.permissions();
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
    let mut saved_data: crate::types::SavedData = serde_json::from_str(&data).map_err(|e| e.to_string())?;
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
            let src_path_canonical = src_path.canonicalize().unwrap_or_else(|_| src_path.to_path_buf());

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
                        println!("[SSH Migration] Migrated key for {} to {:?}", conn.name, dest_path);
                    }
                    Err(e) => {
                        eprintln!("[SSH Migration] Failed to copy key for {} from {:?}: {}", conn.name, src_path, e);
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
        println!("[SSH Migration] Successfully saved and synced updated connections.json to {:?}", connections_path);
    }

    Ok(migrated_count)
}


#[tauri::command]
pub async fn ssh_disconnect(
    id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    println!("SSH Disconnect request for: {}", id);
    
    // First, close all associated PTYs to ensure tasks are aborted
    state.pty_manager.close_by_connection(&id).await.map_err(|e| e.to_string())?;

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
pub async fn connections_get(app: AppHandle) -> Result<SavedData, String> {
    let data_dir = get_data_dir(&app);
    let file_path = data_dir.join("connections.json");

    if !file_path.exists() {
        return Ok(SavedData { connections: vec![], folders: vec![] });
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
    let data = SavedData { connections, folders };
    
    let data_dir = get_data_dir(&app);
    if !data_dir.exists() {
        std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    }

    let file_path = data_dir.join("connections.json");
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    
    std::fs::write(file_path, json).map_err(|e| e.to_string())?;
    
    Ok(())
}

#[tauri::command]
pub async fn terminal_create(
    term_id: String,
    connection_id: String,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    println!("[TERM] Creating terminal for connection {} with ID {}, shell: {:?}", connection_id, term_id, shell);
    
    // Check if this is a local or remote connection
    if connection_id == "local" {
        println!("[TERM] Creating local PTY session");
        // Use term_id (UUID) for the session, not connection_id
        state.pty_manager.create_local_session(term_id.clone(), connection_id, cols, rows, app, shell).await
            .map_err(|e| e.to_string())?;
        Ok(term_id)
    } else {
        println!("[TERM] Creating remote SSH session");
        // Get the SSH session for this connection
        let session = {
            let connections = state.connections.lock().await;
            connections.get(&connection_id)
                .and_then(|c| c.session.clone())
                .ok_or_else(|| format!("Connection {} not found or session closed", connection_id))?
        };
        
        // Open a new channel for the terminal
        let channel = session.lock().await.channel_open_session().await.map_err(|e| e.to_string())?;
        
        println!("[TERM] SSH channel opened, requesting PTY");
        state
            .pty_manager
            .create_remote_session(term_id.clone(), connection_id, channel, cols, rows, app)
            .await
            .map_err(|e| e.to_string())?;

        Ok(term_id)
    }
}

#[tauri::command]
pub async fn terminal_close(
    term_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .pty_manager
        .close(&term_id)
        .await
        .map_err(|e| e.to_string())
}

// Helper to get SFTP session without holding lock
async fn get_sftp(state: &State<'_, AppState>, id: &str) -> Result<Arc<russh_sftp::client::SftpSession>, String> {
    let connections = state.connections.lock().await;
    connections.get(id)
        .ok_or_else(|| format!("Connection {} not found", id))
        .and_then(|c| c.sftp_session.clone().ok_or_else(|| "SFTP not initialized".to_string()))
}

#[tauri::command]
pub async fn fs_list(
    connection_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<FileEntry>, String> {
    if connection_id == "local" {
        state.file_system.list_local(&path).map_err(|e| e.to_string())
    } else {
        println!("[FS] Listing remote dir: {} on {}", path, connection_id);
        let sftp = get_sftp(&state, &connection_id).await?;
        state.file_system.list_remote(&sftp, &path).await.map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn fs_read_file(
    connection_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if connection_id == "local" {
       state.file_system.read_file(&connection_id, &path).await.map_err(|e| e.to_string())
    } else {
        let sftp = get_sftp(&state, &connection_id).await?;
        state.file_system.read_remote(&sftp, &path).await.map_err(|e| e.to_string())
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
        state.file_system.write_file(&connection_id, &path, &content).await.map_err(|e| e.to_string())
    } else {
        let sftp = get_sftp(&state, &connection_id).await?;
        state.file_system.write_remote(&sftp, &path, content.as_bytes()).await.map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn fs_cwd(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if connection_id == "local" {
        state
            .file_system
            .get_home_dir(&connection_id)
            .map_err(|e| e.to_string())
    } else {
        println!("[FS] Getting remote CWD for {}", connection_id);
        let sftp = get_sftp(&state, &connection_id).await?;
        // Canonicalize . to get cwd
        match sftp.canonicalize(".").await {
             Ok(path) => Ok(path),
             Err(e) => Err(e.to_string())
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
        state.file_system.create_dir(&connection_id, &path).await.map_err(|e| e.to_string())
    } else {
        let sftp = get_sftp(&state, &connection_id).await?;
        state.file_system.create_dir_remote(&sftp, &path).await.map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn fs_rename(
    connection_id: String,
    old_path: String,
    new_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if connection_id == "local" {
        state.file_system.rename(&connection_id, &old_path, &new_path).await.map_err(|e| e.to_string())
    } else {
        let sftp = get_sftp(&state, &connection_id).await?;
        state.file_system.rename_remote(&sftp, &old_path, &new_path).await.map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn fs_delete(
    connection_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if connection_id == "local" {
        state.file_system.delete(&connection_id, &path).await.map_err(|e| e.to_string())
    } else {
        // Optimization: Try server-side delete first (rm -rf) to avoid recursive SFTP calls
        let (session_opt, should_optimize) = {
            let connections = state.connections.lock().await;
            let conn = connections.get(&connection_id);
            (
                conn.and_then(|c| c.session.clone()),
                conn.map(|c| c.detected_os.is_some()).unwrap_or(false)
            )
        };

        if should_optimize {
            if let Some(session) = session_opt {
                 // Simple quoting for paths
                 let cmd = format!("rm -rf '{}'", path.replace("'", "'\\''"));
             println!("[FS] Attempting server-side delete: {}", cmd);

             match session.lock().await.channel_open_session().await {
                 Ok(mut channel) => {
                     if let Ok(_) = channel.exec(true, cmd).await {
                        // Wait for exit status
                        let mut success = false;
                        let mut output_log = String::new();
                        
                        while let Some(msg) = channel.wait().await {
                            match msg {
                                russh::ChannelMsg::Data { data } => {
                                    output_log.push_str(&String::from_utf8_lossy(&data));
                                },
                                russh::ChannelMsg::ExtendedData { data, .. } => {
                                    output_log.push_str(&String::from_utf8_lossy(&data));
                                },
                                russh::ChannelMsg::ExitStatus { exit_status } => {
                                    if exit_status == 0 {
                                        success = true;
                                    } else {
                                        output_log.push_str(&format!(" (Exit: {})", exit_status));
                                    }
                                    break;
                                }
                                _ => {}
                            }
                        }
                        
                        if success {
                            println!("[FS] Server-side delete successful. Output: {}", output_log);
                            return Ok(());
                        } else {
                            println!("[FS] Server-side delete failed: {}. Checking SFTP fallback...", output_log);
                        }
                     }
                 },
                 Err(e) => println!("[FS] Failed to open channel for delete optimization: {}", e),
             }
        }
    }

        // Fallback to SFTP (recursive delete implemented there)
        println!("[FS] Falling back to SFTP delete...");
        let sftp = get_sftp(&state, &connection_id).await?;
        state.file_system.delete_remote(&sftp, &path).await.map_err(|e| e.to_string())
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
        state.file_system.copy(&connection_id, &from, &to).await.map_err(|e| e.to_string())
    } else {
        // Optimization: Try server-side copy first (cp -r) to avoid download/upload
        let (session_opt, should_optimize) = {
            let connections = state.connections.lock().await;
            let conn = connections.get(&connection_id);
            (
                conn.and_then(|c| c.session.clone()),
                conn.map(|c| c.detected_os.is_some()).unwrap_or(false)
            )
        };

        if should_optimize {
            if let Some(session) = session_opt {
                 // Simple quoting for paths (Linux/Unix assumptions for now, robust enough for typical usage)
                 // We use standard "cp -r" which works on most Unix-likes.
                 // If it fails (e.g. Windows), we fall back to SFTP.
                 let cmd = format!("cp -r '{}' '{}'", from.replace("'", "'\\''"), to.replace("'", "'\\''"));
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
                 },
                 Err(e) => println!("[FS] Failed to open channel for copy optimization: {}", e),
             }
        }
    }

        // Fallback to SFTP
        println!("[FS] Falling back to SFTP copy...");
        let sftp = get_sftp(&state, &connection_id).await?;
        // Lock is DROPPED here
        state.file_system.copy_remote(&sftp, &from, &to).await.map_err(|e| e.to_string())
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
            state.file_system.copy(&connection_id, &op.from, &op.to).await.map_err(|e| e.to_string())?;
        }
        Ok(())
    } else {
        // Optimization: Try single SSH channel for all cp commands if OS detected
        let (session_opt, should_optimize) = {
            let connections = state.connections.lock().await;
            let conn = connections.get(&connection_id);
            (
                conn.and_then(|c| c.session.clone()),
                conn.map(|c| c.detected_os.is_some()).unwrap_or(false)
            )
        };

        if should_optimize && session_opt.is_some() {
            if let Some(session) = session_opt {
                let mut channel = session.lock().await.channel_open_session().await
                    .map_err(|e| format!("Failed to open channel: {}", e))?;
                
                // Build a multi-command string: cp -r 'a' 'b'; cp -r 'c' 'd'; ...
                let cmd = operations.iter()
                    .map(|op| format!("cp -r '{}' '{}'", op.from.replace("'", "'\\''"), op.to.replace("'", "'\\''")))
                    .collect::<Vec<_>>()
                    .join("; ");
                
                println!("[FS] Attempting batch server-side copy: {}", cmd);
                channel.exec(true, cmd).await.map_err(|e| format!("Exec failed: {}", e))?;
                
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
        let sftp = get_sftp(&state, &connection_id).await?;
        for op in operations {
            state.file_system.copy_remote(&sftp, &op.from, &op.to).await.map_err(|e| e.to_string())?;
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
            state.file_system.rename(&connection_id, &op.from, &op.to).await.map_err(|e| e.to_string())?;
        }
        Ok(())
    } else {
        let sftp = get_sftp(&state, &connection_id).await?;
        for op in operations {
            state.file_system.rename_remote(&sftp, &op.from, &op.to).await.map_err(|e| e.to_string())?;
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
        state.file_system.exists(&connection_id, &path).await.map_err(|e| e.to_string())
    } else {
        let sftp = get_sftp(&state, &connection_id).await?;
        state.file_system.exists_remote(&sftp, &path).await.map_err(|e| e.to_string())
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
        connections.get(&connection_id)
            .and_then(|c| c.session.clone())
            .ok_or_else(|| format!("Connection {} not found", connection_id))?
    };

    let res: anyhow::Result<String> = state.tunnel_manager.start_local_forwarding(
        session,
        "127.0.0.1".to_string(),
        local_port,
        remote_host,
        remote_port
    ).await;
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
        connections.get(&connection_id)
            .and_then(|c| c.session.clone())
            .ok_or_else(|| format!("Connection {} not found", connection_id))?
    };

    let res: anyhow::Result<String> = state.tunnel_manager.start_remote_forwarding(
        session,
        "0.0.0.0".to_string(),
        remote_port,
        local_host,
        local_port
    ).await;
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
    
    let tunnel = saved_data.tunnels.into_iter().find(|t| t.id == id)
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
        connections.get(&tunnel.connection_id)
            .and_then(|c| c.session.clone())
    };
    
    // 4. Stop
    println!("[TUNNEL CMD] Stopping tunnel: internal_id={}", internal_id);
    let res = state.tunnel_manager.stop_tunnel(session, internal_id, bind_address).await;
    
    if let Err(ref e) = res {
        let _ = app.emit("tunnel:status-change", TunnelStatusChange {
            id: id.clone(),
            status: "error".to_string(),
            error: Some(e.to_string()),
        });
    } else {
        let _ = app.emit("tunnel:status-change", TunnelStatusChange {
            id: id.clone(),
            status: "stopped".to_string(),
            error: None,
        });
    }
    
    res.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn window_is_maximized(app: AppHandle) -> bool {
    app.get_webview_window("main").map(|w| w.is_maximized().unwrap_or(false)).unwrap_or(false)
}

#[tauri::command]
pub async fn window_maximize(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_maximized().unwrap_or(false) {
            window.unmaximize().unwrap();
        } else {
            window.maximize().unwrap();
        }
    }
}

#[tauri::command]
pub async fn window_minimize(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        window.minimize().unwrap();
    }
}

#[tauri::command]
pub async fn window_close(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        window.close().unwrap();
    }
}

#[tauri::command]
pub async fn tunnel_list(app: AppHandle, state: State<'_, AppState>, connection_id: String) -> Result<Vec<SavedTunnel>, String> {
    // let connection_id = connectionId; // Resolved: using snake_case directly
    let data_dir = get_data_dir(&app);
    let file_path = data_dir.join("tunnels.json");

    if !file_path.exists() {
        return Ok(vec![]);
    }

    let data = std::fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    let saved_data: SavedTunnelsData = serde_json::from_str(&data).map_err(|e| e.to_string())?;

    let mut tunnels: Vec<SavedTunnel> = saved_data.tunnels.into_iter()
        .filter(|t| t.connection_id == connection_id)
        .collect();

    // Inject dynamic status
    let local_listeners: tokio::sync::MutexGuard<'_, std::collections::HashMap<String, (tokio::task::AbortHandle, tokio::sync::broadcast::Sender<()>)>> = state.tunnel_manager.local_listeners.lock().await;
    let remote_forwards: tokio::sync::MutexGuard<'_, std::collections::HashMap<u16, (String, u16, String)>> = state.tunnel_manager.remote_forwards.lock().await;

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

    let json = serde_json::to_string_pretty(&SavedTunnelsData { tunnels }).map_err(|e| e.to_string())?;
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
    
    let tunnel = saved_data.tunnels.into_iter().find(|t| t.id == id)
        .ok_or_else(|| "Tunnel not found".to_string())?;

    // 2. Get session
    let session = {
        let connections = state.connections.lock().await;
        connections.get(&tunnel.connection_id)
            .and_then(|c| c.session.clone())
            .ok_or_else(|| format!("Connection {} not found or session closed", tunnel.connection_id))?
    };

    let res = if tunnel.tunnel_type == "local" {
        let bind_addr = tunnel.bind_address.clone().unwrap_or_else(|| "127.0.0.1".to_string());
        state.tunnel_manager.start_local_forwarding(
             session,
             bind_addr,
             tunnel.local_port,
             tunnel.remote_host,
             tunnel.remote_port
        ).await
    } else {
        let bind_addr = tunnel.bind_address.clone().unwrap_or_else(|| "0.0.0.0".to_string());
        state.tunnel_manager.start_remote_forwarding(
             session,
             bind_addr,
             tunnel.remote_port,
             tunnel.remote_host.clone(),
             tunnel.local_port
        ).await
    };

    if let Err(ref e) = res {
        let _ = app.emit("tunnel:status-change", TunnelStatusChange {
            id: id.clone(),
            status: "error".to_string(),
            error: Some(e.to_string()),
        });
    } else {
        let _ = app.emit("tunnel:status-change", TunnelStatusChange {
            id: id.clone(),
            status: "active".to_string(),
            error: None,
        });
    }

    res.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tunnel_get_all(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<SavedTunnel>, String> {
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
            String::from_utf8(output.stdout)
                .map_err(|e| format!("Invalid UTF-8 output: {}", e))
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("Command failed: {}", stderr))
        }
    } else {
        // Execute SSH command
        let connections = state.connections.lock().await;
        if let Some(conn) = connections.get(&connection_id) {
             if let Some(session) = &conn.session {
                 // Wrap command in sh -c to ensure shell features like pipes and semicolons work reliably
                 let shell_command = format!("sh -c '{}'", command.replace("'", "'\\''"));
                 
                 let mut channel = session.lock().await.channel_open_session().await.map_err(|e| e.to_string())?;
                 channel.exec(true, shell_command).await.map_err(|e| e.to_string())?;
                 
                 let mut stdout = Vec::new();
                 let mut stderr = Vec::new();
                 let mut exit_status = 0;
                 
                 while let Some(msg) = channel.wait().await {
                     match msg {
                        russh::ChannelMsg::Data { ref data } => stdout.extend_from_slice(data),
                        russh::ChannelMsg::ExtendedData { ref data, .. } => stderr.extend_from_slice(data),
                        russh::ChannelMsg::ExitStatus { exit_status: code } => {
                            exit_status = code;
                            break;
                        },
                         _ => {}
                     }
                 }
                 
                 if exit_status == 0 {
                     return String::from_utf8(stdout).map_err(|e| e.to_string());
                 } else {
                     let err_str = String::from_utf8_lossy(&stderr);
                     return Err(format!("Remote command failed (Exit {}): {}", exit_status, err_str));
                 }
             }
        }
        Err("Connection not found".to_string())
    }
}

#[tauri::command]
pub async fn ssh_import_config(app: AppHandle) -> Result<Vec<crate::ssh_config::ParsedSshConnection>, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let config_path = home.join(".ssh/config");
    
    // println!("[SSH] Importing config from: {:?}", config_path);
    
    crate::ssh_config::parse_config(&config_path).map_err(|e| e.to_string())
}

/// Helper to internalize a single key file
fn internalize_key(path: &str, data_dir: &std::path::Path) -> Option<String> {
    if path.is_empty() {
        return None;
    }

    let src_path = std::path::Path::new(path);
    
    // Canonicalize paths to ensure robust comparison
    let data_dir_canonical = data_dir.canonicalize().unwrap_or_else(|_| data_dir.to_path_buf());
    let src_path_canonical = src_path.canonicalize().unwrap_or_else(|_| src_path.to_path_buf());

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
            eprintln!("[SSH Internalize] Failed to copy key from {:?} to {:?}: {}", src_path, dest_path, e);
            None
        }
    }
}

#[tauri::command]
pub async fn ssh_internalize_connections(
    app: AppHandle,
    connections: Vec<crate::ssh_config::ParsedSshConnection>
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
    println!("[SSH Internalize] Internalized keys for {} connections", internalized_count);
    Ok(updated_connections)
}

// Snippets Commands
use crate::snippets::Snippet;

#[tauri::command]
pub async fn snippets_list(
    state: State<'_, AppState>,
) -> Result<Vec<Snippet>, String> {
    state.snippets_manager.list().await
}

#[tauri::command]
pub async fn snippets_save(
    snippet: Snippet,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.snippets_manager.save(snippet).await
}

#[tauri::command]
pub async fn snippets_delete(
    id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
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
pub async fn settings_set(
    app: AppHandle,
    settings: serde_json::Value,
) -> Result<(), String> {
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
                
                upload_recursive(sftp, &path, &new_remote, file_system, app, transfer_id, total_size, transferred, cancel_token).await?;
            }
        } else {
            // Upload file with chunked progress
            use russh_sftp::protocol::OpenFlags;
            use tokio::io::AsyncWriteExt;

            let file_metadata = std::fs::metadata(local_path).map_err(|e| format!("Failed to stat local file: {}", e))?;
            let file_size = file_metadata.len();
            
            // Open remote file
            let mut remote_file = sftp.open_with_flags(remote_path, OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE)
                .await.map_err(|e| format!("Failed to open remote file '{}': {}", remote_path, e))?;

            // Full-Duplex Channel (Pipes local reads to remote writes)
            let (tx, mut rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, String>>(4);
            let local_path_buf = local_path.to_path_buf();
            
            // Spawn Disk Reader Task
            tokio::spawn(async move {
                use tokio::io::AsyncReadExt;
                let mut file = match tokio::fs::File::open(local_path_buf).await {
                    Ok(f) => f,
                    Err(e) => { let _ = tx.send(Err(format!("Local open failed: {}", e))).await; return; }
                };
                loop {
                    let mut buffer = vec![0u8; 4 * 1024 * 1024]; // 4MB Chunk
                    match file.read(&mut buffer).await {
                        Ok(0) => break,
                        Ok(n) => {
                            buffer.truncate(n);
                            if tx.send(Ok(buffer)).await.is_err() { break; }
                        }
                        Err(e) => { let _ = tx.send(Err(format!("Local read failed: {}", e))).await; break; }
                    }
                }
            });

            let mut file_transferred = 0;
            let mut last_emit = std::time::Instant::now();

            // Main loop: Receive from reader and Write to Server concurrently
            while let Some(chunk_res) = rx.recv().await {
                let chunk = chunk_res?;
                if cancel_token.load(std::sync::atomic::Ordering::Relaxed) {
                    return Err("Cancelled".to_string());
                }

                remote_file.write_all(&chunk).await.map_err(|e| format!("SFTP write failed: {}", e))?;
                
                let n = chunk.len();
                *transferred += n as u64;
                file_transferred += n as u64;

                if last_emit.elapsed().as_millis() >= 100 {
                    let _ = app.emit("transfer-progress", TransferProgress {
                        id: transfer_id.to_string(),
                        transferred: *transferred,
                        total: *total_size, 
                    });
                    last_emit = std::time::Instant::now();
                }
            }
            
            // Validate size
             if file_transferred != file_size {
                 // println!("Warning: Transferred size mismatch. Expected {}, got {}", file_size, file_transferred);
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
                let sftp = get_sftp(&state, &connection_id).await?;
                let path = std::path::Path::new(&local);
                
                // Calculate total size for progress bar
                let mut total_size = get_local_size(path);
                if total_size == 0 { total_size = 1; } // Avoid division by zero
                let mut transferred = 0;
                
                // Emit initial start event to switch UI to "transferring" immediately
                let _ = app_handle.emit("transfer-progress", TransferProgress {
                    id: tid.clone(),
                    transferred: 0,
                    total: total_size,
                });

                upload_recursive(&sftp, path, &remote, &state.file_system, &app_handle, &tid, &mut total_size, &mut transferred, &cancel_token).await?;
             }
             Ok(())
        }.await;
                // Cleanup
         {
             let mut transfers = state.transfers.lock().await;
             transfers.remove(&tid);
         }

         match result {
             Ok(_) => {
                 let _ = app_handle.emit("transfer-success", TransferSuccess { 
                     id: tid, 
                     destination_connection_id: connection_id 
                 });
             },
             Err(e) => {
                 if e == "Cancelled" {
                     let _ = app_handle.emit("transfer-error", TransferError { id: tid, error: "Cancelled".to_string() });
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
             let src_sftp = get_sftp(&state, &src_id).await?;
             // Calculate size upfront for accurate progress
             let mut total_size = get_remote_size(&src_sftp, &src_path).await;
             if total_size == 0 { total_size = 1; }
             
             let _ = app_handle.emit("transfer-progress", TransferProgress {
                id: tid.clone(),
                transferred: 0,
                total: total_size,
             });

            // Check cancellation early
            if cancel_token.load(std::sync::atomic::Ordering::Relaxed) {
                return Err("Cancelled".to_string());
            }

            // Standard Mode (Proxied Streaming)
            let dst_sftp = get_sftp(&state, &dst_id).await?;
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
                &cancel_token
            ).await?;

            Ok(())
         }.await;

         // Cleanup cancellation token
         {
             let mut transfers = state.transfers.lock().await;
             transfers.remove(&tid);
         }

         match result {
             Ok(_) => {
                let _ = app_handle.emit("transfer-progress", TransferProgress {
                    id: tid.clone(),
                    transferred: 100, // Make sure it finishes
                    total: 100,
                });
                 
                 let _ = app_handle.emit("transfer-success", TransferSuccess { 
                     id: tid, 
                     destination_connection_id: dst_id 
                 });
             },
             Err(e) => {
                 let status = if e == "Cancelled" { "cancelled" } else { "failed" };
                 if status == "cancelled" {
                     let _ = app_handle.emit("transfer-cancelled", TransferSuccess { // reusing struct or just ID? Frontend expects error or distinct event?
                        id: tid.clone(),
                        destination_connection_id: dst_id // Payload matches success for ID extraction
                     });
                     // Or separate event? Frontend listens for 'transfer-error' usually.
                     // CopyToServerModal handles error. TransferManager handles 'cancelled' status if we update store.
                     // Let's emit error with "Cancelled" message, easiest.
                     let _ = app_handle.emit("transfer-error", TransferError { id: tid, error: "Cancelled".into() });
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
    cancel_token: &Arc<std::sync::atomic::AtomicBool>
) -> Result<(), String> {
    use russh_sftp::protocol::OpenFlags;
    use tokio::io::AsyncWriteExt;

    if cancel_token.load(std::sync::atomic::Ordering::Relaxed) {
        return Err("Cancelled".to_string());
    }

    let metadata = src_sftp.metadata(src_path).await.map_err(|e| format!("Failed to stat source: {}", e))?;

    if metadata.is_dir() {
        // Create remote dir (ignore error if exists)
        let _ = dst_sftp.create_dir(dst_path).await;

        let entries = src_sftp.read_dir(src_path).await.map_err(|e| format!("Read dir failed: {}", e))?;
        for entry in entries {
            let filename = entry.file_name();
            if filename == "." || filename == ".." { continue; }

            let new_src = if src_path.ends_with('/') { format!("{}{}", src_path, filename) } else { format!("{}/{}", src_path, filename) };
            let new_dst = if dst_path.ends_with('/') { format!("{}{}", dst_path, filename) } else { format!("{}/{}", dst_path, filename) };

            Box::pin(copy_recursive_optimized(src_sftp, dst_sftp, &new_src, &new_dst, app, transfer_id, total_size, transferred, cancel_token)).await?;
        }
    } else {
        // File copy
        let mut src_file = src_sftp.open_with_flags(src_path, OpenFlags::READ).await.map_err(|e| format!("Open src failed: {}", e))?;
        let mut dst_file = dst_sftp.open_with_flags(dst_path, OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE).await.map_err(|e| format!("Open dst failed: {}", e))?;

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
                        if tx.send(Ok(buffer)).await.is_err() { break; }
                    }
                    Err(e) => { let _ = tx.send(Err(format!("SFTP source read failed: {}", e))).await; break; }
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

            dst_file.write_all(&chunk).await.map_err(|e| format!("SFTP destination write failed: {}", e))?;
            
            let n = chunk.len();
            *transferred += n as u64;

            if last_emit.elapsed().as_millis() >= 200 {
                let _ = app.emit("transfer-progress", TransferProgress {
                    id: transfer_id.to_string(),
                    transferred: *transferred,
                    total: total_size,
                });
                last_emit = std::time::Instant::now();
            }
        }
        
        // Final emit for file
        let _ = app.emit("transfer-progress", TransferProgress {
            id: transfer_id.to_string(),
            transferred: *transferred,
            total: total_size,
        });
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
        let metadata = sftp.metadata(remote_path).await.map_err(|e| format!("Failed to stat remote path '{}': {}", remote_path, e))?;
        
        if metadata.is_dir() {
            // Create local directory
            std::fs::create_dir_all(local_path).map_err(|e| format!("Failed to create local dir: {}", e))?;

            // List remote directory
            let entries = sftp.read_dir(remote_path).await.map_err(|e| format!("Failed to read remote dir: {}", e))?;
            
            for entry in entries {
                let name = entry.file_name();
                if name == "." || name == ".." { continue; }

                let new_remote = if remote_path.ends_with('/') {
                    format!("{}{}", remote_path, name)
                } else {
                    format!("{}/{}", remote_path, name)
                };
                
                let new_local = local_path.join(&name);
                
                download_recursive(sftp, &new_remote, &new_local, app, transfer_id, total_size, transferred, cancel_token).await?;
            }
        } else {
            // Download file
            use russh_sftp::protocol::OpenFlags;

            // Create local file using tokio for async writing
            let mut local_file = tokio::fs::File::create(local_path).await
                .map_err(|e| format!("Failed to create local file: {}", e))?;

            // Full-Duplex Channel (Remote reads piped to local disk writes)
            let (tx, mut rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, String>>(4);
            
            // Open remote file
            let mut remote_file = sftp.open_with_flags(remote_path, OpenFlags::READ).await
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
                            if tx.send(Ok(buffer)).await.is_err() { break; }
                        }
                        Err(e) => { let _ = tx.send(Err(format!("SFTP read failed: {}", e))).await; break; }
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
                local_file.write_all(&chunk).await.map_err(|e| format!("Local write failed: {}", e))?;
                
                let n = chunk.len();
                *transferred += n as u64;

                if last_emit.elapsed().as_millis() >= 100 {
                    let _ = app.emit("transfer-progress", TransferProgress {
                        id: transfer_id.to_string(),
                        transferred: *transferred,
                        total: *total_size, 
                    });
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
                if filename == "." || filename == ".." { continue; }

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
             let sftp = get_sftp(&state, &connection_id).await?;
             let local_p = std::path::Path::new(&local);
             
             // Prepare total size (Best effort)
             let mut total_size = get_remote_size(&sftp, &remote).await;
             if total_size == 0 { total_size = 1; }
             let mut transferred = 0;

             let tid_clone = tid.clone();
             let cancel_token = Arc::new(std::sync::atomic::AtomicBool::new(false));
             
             // Register token
             {
                 let mut transfers = state.transfers.lock().await;
                 transfers.insert(tid_clone.clone(), cancel_token.clone());
             }

             // Emit start
             let _ = app_handle.emit("transfer-progress", TransferProgress {
                id: tid.clone(),
                transferred: 0,
                total: total_size,
            });

             let res = download_recursive(&sftp, &remote, local_p, &app_handle, &tid, &mut total_size, &mut transferred, &cancel_token).await;

             // Cleanup
             {
                 let mut transfers = state.transfers.lock().await;
                 transfers.remove(&tid_clone);
             }
             
             res
        }.await;

        match result {
            Ok(_) => {
                let _ = app_handle.emit("transfer-success", TransferSuccess { 
                    id: tid, 
                    destination_connection_id: "local".to_string() 
                });
            },
            Err(e) => {
                if e == "Cancelled" {
                    let _ = app_handle.emit("transfer-error", TransferError { id: tid, error: "Cancelled".to_string() });
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
    app.opener().open_url(path, None::<String>).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn app_get_exe_dir() -> Result<String, String> {
    let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe_path.parent().ok_or("Could not get executable directory")?;
    Ok(exe_dir.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn app_exit(app: tauri::AppHandle) {
    app.exit(0);
}
#[tauri::command]
pub async fn plugins_load(
    app: AppHandle,
) -> Result<Vec<crate::plugins::Plugin>, String> {
    crate::plugins::PluginScanner::scan(&app).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn plugins_toggle(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    crate::plugins::PluginScanner::save_state(&app, id, enabled).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn plugin_fs_read(
    path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state.file_system.read_file("local", &path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn plugin_fs_write(
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.file_system.write_file("local", &path, &content).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn plugin_fs_list(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<FileEntry>, String> {
    state.file_system.list_local(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn plugin_fs_exists(
    path: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    state.file_system.exists("local", &path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn plugin_fs_create_dir(
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.file_system.create_dir("local", &path).await.map_err(|e| e.to_string())
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
   use base64::Engine;
   let label = format!("plugin-window-{}", uuid::Uuid::new_v4());
   let mut builder = WebviewWindowBuilder::new(
       &app,
       &label,
       if let Some(u) = url {
           tauri::WebviewUrl::External(u.parse().map_err(|e: url::ParseError| e.to_string())?) 
       } else if let Some(h) = html {
           // For HTML content, we use a data URL for simplicity in MVP
           let data_url = format!("data:text/html;base64,{}", base64::engine::general_purpose::STANDARD.encode(h));
           tauri::WebviewUrl::External(data_url.parse().map_err(|e: url::ParseError| e.to_string())?)
       } else {
           return Err("Must provide url or html".into());
       }
   );
   
   if let Some(t) = title { builder = builder.title(t); }
   if let Some(w) = width { builder = builder.inner_size(w, height.unwrap_or(600.0)); }
   
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
