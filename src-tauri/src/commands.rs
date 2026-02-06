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
use serde::Serialize;

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

#[derive(Clone)]
pub struct AppState {
    pub connections: Arc<Mutex<HashMap<String, ConnectionHandle>>>,
    pub pty_manager: Arc<PtyManager>,
    pub file_system: Arc<FileSystem>,
    pub ssh_manager: Arc<SshManager>,
    pub tunnel_manager: Arc<TunnelManager>,
    pub snippets_manager: Arc<crate::snippets::SnippetsManager>,
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
            
            // If the path is already inside the app data directory, skip it
            if src_path.starts_with(&data_dir) {
                continue;
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
        std::fs::write(connections_path, json).map_err(|e| e.to_string())?;
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
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    println!("[TERM] Creating terminal for connection {} with ID {}", connection_id, term_id);
    
    // Check if this is a local or remote connection
    if connection_id == "local" {
        println!("[TERM] Creating local PTY session");
        // Use term_id (UUID) for the session, not connection_id
        state.pty_manager.create_local_session(term_id.clone(), connection_id, cols, rows, app).await
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
pub async fn tunnel_save(app: AppHandle, tunnel: SavedTunnel) -> Result<(), String> {
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
    
    println!("[SSH] Importing config from: {:?}", config_path);
    
    crate::ssh_config::parse_config(&config_path).map_err(|e| e.to_string())
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
    total_size: &'a mut u64, // Track total mostly for logging or rough progress if pre-calculated
    transferred: &'a mut u64,
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
                
                upload_recursive(sftp, &path, &new_remote, file_system, app, transfer_id, total_size, transferred).await?;
            }
        } else {
            // Upload file with chunked progress
            use russh_sftp::protocol::OpenFlags;
            use tokio::io::AsyncWriteExt;
            use std::io::Read;

            let mut file = std::fs::File::open(local_path).map_err(|e| format!("Failed to open local file: {}", e))?;
            let file_size = file.metadata().map(|m| m.len()).unwrap_or(0);
            
            // Open remote file
            let mut remote_file = sftp.open_with_flags(remote_path, OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE)
                .await.map_err(|e| format!("Failed to open remote file '{}': {}", remote_path, e))?;

            // Chunked upload
            // Using 4MB chunks to maximize throughput on high-latency links
            // and minimize round-trip awaits.
            let mut buffer = vec![0u8; 4 * 1024 * 1024]; 
            let mut file_transferred = 0;
            let mut last_emit = std::time::Instant::now();

            loop {
                // Read chunk
                let n = file.read(&mut buffer).map_err(|e| format!("Failed to read chunk: {}", e))?;
                if n == 0 { break; }

                // Write chunk
                remote_file.write_all(&buffer[..n]).await.map_err(|e| format!("Failed to write chunk: {}", e))?;
                
                // Update progress
                *transferred += n as u64;
                file_transferred += n as u64;

                // Throttle emission: Enforce minimum 100ms interval OR completion
                // Always emit if this is the last chunk effectively (handled by completion event anyway, but good to be precise)
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

                upload_recursive(&sftp, path, &remote, &state.file_system, &app_handle, &tid, &mut total_size, &mut transferred).await?;
             }
             Ok(())
        }.await;
        
        match result {
            Ok(_) => {
                let _ = app_handle.emit("transfer-success", TransferSuccess { 
                    id: tid, 
                    destination_connection_id: connection_id 
                });
            },
            Err(e) => {
                let _ = app_handle.emit("transfer-error", TransferError { id: tid, error: e });
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
