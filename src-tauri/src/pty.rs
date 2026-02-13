use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, CommandBuilder, PtySize, MasterPty};
use russh::{Channel, ChannelMsg};
use russh::client::Msg;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, mpsc};

// Enum to handle both local PTY and remote SSH channels
pub enum TerminalHandle {
    Local {
        writer: Arc<Mutex<Box<dyn Write + Send>>>,
        reader_handle: Option<tokio::task::JoinHandle<()>>,
        master: Box<dyn MasterPty + Send>,
        #[allow(dead_code)]
        child: Box<dyn portable_pty::Child + Send>,
    },
    Remote {
        tx: mpsc::Sender<Vec<u8>>, // Send input data to the channel task
        resize_tx: mpsc::Sender<(u16, u16)>, // Send resize events
        task_handle: Option<tokio::task::JoinHandle<()>>,
    },
}

pub struct PtySession {
    #[allow(dead_code)]
    pub term_id: String,
    pub connection_id: String,
    pub handle: TerminalHandle,
}

pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    // Create a local PTY session
    pub async fn create_local_session(
        &self,
        term_id: String,
        connection_id: String,
        cols: u16,
        rows: u16,
        app_handle: AppHandle,
        shell_override: Option<String>,
    ) -> Result<()> {
        println!("[PTY-DEBUG] create_local_session called for {} with shell override: {:?}", term_id, shell_override);
        
        // Check if session already exists to prevent duplicate spawns
        {
            let sessions = self.sessions.lock().await;
            if sessions.contains_key(&term_id) {
                println!("[PTY-DEBUG] Session {} already exists, skipping creation", term_id);
                return Ok(());
            }
        }
        
        let pty_system = native_pty_system();

        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| anyhow!("Failed to open PTY: {}", e))?;

        // Determine shell to use based on platform and user preference
        let (shell, args): (String, Vec<String>) = if cfg!(target_os = "windows") {
            match shell_override.as_deref() {
                Some("cmd") => ("cmd.exe".to_string(), vec![]),
                Some("gitbash") => {
                    // Try common Git Bash locations
                    let git_bash_paths = [
                        "C:\\Program Files\\Git\\bin\\bash.exe",
                        "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
                    ];
                    let bash_path = git_bash_paths
                        .iter()
                        .find(|p| std::path::Path::new(p).exists())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| "bash.exe".to_string());
                    (bash_path, vec!["--login".to_string(), "-i".to_string()])
                }
                Some("wsl") => ("wsl.exe".to_string(), vec![]),
                Some(wsl_distro) if wsl_distro.starts_with("wsl:") => {
                    let distro = wsl_distro.strip_prefix("wsl:").unwrap_or("").to_string();
                    ("wsl.exe".to_string(), vec!["-d".to_string(), distro])
                }
                Some("powershell") | Some("default") | None => ("powershell.exe".to_string(), vec![]),
                Some(other) => {
                    // Try to use it as a direct path or command
                    (other.to_string(), vec![])
                }
            }
        } else {
            (std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string()), vec![])
        };
        println!("[PTY-DEBUG] Using shell: {} with args: {:?}", shell, args);

        let mut cmd = CommandBuilder::new(&shell);
        for arg in &args {
            cmd.arg(arg);
        }
        
        // Add interactive flag if not already present
        if !args.contains(&"-i".to_string()) && !shell.contains("powershell") && !shell.contains("cmd.exe") {
             cmd.arg("-i");
        }
        cmd.env("TERM", "xterm-256color");

        // Clear IDE/Editor specific variables that might interfere with git/ssh prompts
        cmd.env_remove("GIT_ASKPASS");
        cmd.env_remove("SSH_ASKPASS");
        cmd.env_remove("VSCODE_GIT_ASKPASS");
        cmd.env_remove("ELECTRON_RUN_AS_NODE");

        // Fix for AppImage: Unset LD_LIBRARY_PATH and other vars to prevent
        // bundled libraries from interfering with system binaries (like git).
        if cfg!(target_os = "linux") && std::env::var("APPIMAGE").is_ok() {
            cmd.env_remove("LD_LIBRARY_PATH");
            cmd.env_remove("APPIMAGE");
            cmd.env_remove("APPDIR");
            cmd.env_remove("OWD");
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| anyhow!("Failed to spawn shell: {}", e))?;
        println!("[PTY-DEBUG] Shell spawned");

        let mut reader = pair.master.try_clone_reader().map_err(|e| anyhow!("Failed to clone reader: {}", e))?;
        let writer = pair.master.take_writer().map_err(|e| anyhow!("Failed to take writer: {}", e))?;

        // Spawn a task to read from PTY and emit events
        let term_id_clone = term_id.clone();
        let app_handle_clone = app_handle.clone();
        let reader_handle = tokio::task::spawn_blocking(move || {
            println!("[PTY-DEBUG] Reader loop starting for {}", term_id_clone);
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        println!("[PTY-DEBUG] EOF read for {}", term_id_clone);
                        // Notify frontend that terminal exited
                        let _ = app_handle_clone.emit(&format!("terminal-exit-{}", term_id_clone), ());
                        break; 
                    }, // EOF
                    Ok(n) => {
                        // Emit as binary (Vec<u8>) to avoid UTF-8 corruption on chunk boundaries
                        if let Err(e) = app_handle.emit(&format!("terminal-output-{}", term_id_clone), &buf[..n]) {
                            eprintln!("Failed to emit terminal output: {}", e);
                        }
                    }
                    Err(e) => {
                        eprintln!("Error reading from PTY: {}", e);
                        // Notify frontend that terminal exited due to error
                        let _ = app_handle_clone.emit(&format!("terminal-exit-{}", term_id_clone), ());
                        break;
                    }
                }
            }
        });

        let session = PtySession {
            term_id: term_id.clone(),
            connection_id,
            handle: TerminalHandle::Local {
                writer: Arc::new(Mutex::new(writer)),
                reader_handle: Some(reader_handle),
                master: pair.master,
                child,
            },
        };

        let mut sessions = self.sessions.lock().await;
        sessions.insert(term_id, session);
        println!("[PTY-DEBUG] Session inserted");

        Ok(())
    }

    // Create a remote SSH session
    pub async fn create_remote_session(
        &self,
        term_id: String,
        connection_id: String,
        mut channel: Channel<Msg>,
        cols: u16,
        rows: u16,
        app_handle: AppHandle,
    ) -> Result<()> {
        println!("[PTY] Creating remote session for {}", term_id);
        
        // Check if session already exists to prevent duplicate spawns
        {
            let sessions = self.sessions.lock().await;
            if sessions.contains_key(&term_id) {
                println!("[PTY] Session {} already exists, skipping creation", term_id);
                // Close the channel since we're not using it
                let _ = channel.close().await;
                return Ok(());
            }
        }

        // Request PTY on the channel
        channel.request_pty(
            false,
            "xterm-256color",
            cols as u32,
            rows as u32,
            0,
            0,
            &[], // No modes for now
        ).await.map_err(|e| anyhow!("Failed to request PTY: {}", e))?;

        // Request shell
        channel.request_shell(false).await.map_err(|e| anyhow!("Failed to request shell: {}", e))?;

        // Create channels for communication
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(32);
        let (resize_tx, mut resize_rx) = mpsc::channel::<(u16, u16)>(4);
        
        let term_id_clone = term_id.clone();

        // Spawn a single task to manage the SSH channel (Reader + Writer + Resize)
        let task_handle = tokio::task::spawn(async move {
            println!("[PTY] Starting manager task for {}", term_id_clone);
            
            loop {
                tokio::select! {
                    // 1. Handle incoming SSH data (Output from server)
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { ref data }) => {
                                // Emit as binary (Vec<u8>) to avoid UTF-8 corruption on chunk boundaries
                                if let Err(e) = app_handle.emit(&format!("terminal-output-{}", term_id_clone), data.as_ref()) {
                                    eprintln!("[PTY] Failed to emit output: {}", e);
                                }
                            }
                            Some(ChannelMsg::ExitStatus { exit_status }) => {
                                println!("[PTY] Remote shell exited with status: {}", exit_status);
                                break;
                            }
                            Some(ChannelMsg::Eof) => {
                                println!("[PTY] Remote channel EOF");
                                break;
                            }
                            None => {
                                println!("[PTY] Channel closed");
                                break;
                            }
                            _ => {} // Ignore other messages for now
                        }
                    }
                    
                    // 2. Handle outgoing user input (Input to server)
                    Some(input) = rx.recv() => {
                        if let Err(e) = channel.data(&input[..]).await {
                             eprintln!("[PTY] Failed to send data to channel: {}", e);
                             break;
                        }
                    }
                    
                    // 3. Handle resize events - drain channel to get only latest
                    Some((mut c, mut r)) = resize_rx.recv() => {
                        // Drain any additional resize events to avoid stale resizes
                        while let Ok((latest_c, latest_r)) = resize_rx.try_recv() {
                            c = latest_c;
                            r = latest_r;
                        }
                        if let Err(e) = channel.window_change(c as u32, r as u32, 0, 0).await {
                            eprintln!("[PTY] Failed to resize channel: {}", e);
                        }
                    }
                }
            }
            
            // Cleanup on exit
            let _ = channel.close().await;
            println!("[PTY] Remote session task ended");
        });

        let session = PtySession {
            term_id: term_id.clone(),
            connection_id,
            handle: TerminalHandle::Remote {
                tx,
                resize_tx,
                task_handle: Some(task_handle),
            },
        };

        let mut sessions = self.sessions.lock().await;
        sessions.insert(term_id, session);
        println!("[PTY] Remote session created successfully");

        Ok(())
    }

    pub async fn write(&self, term_id: &str, data: &str) -> Result<()> {
        let sessions = self.sessions.lock().await;
        let session = sessions
            .get(term_id)
            .ok_or_else(|| anyhow!("Session not found: {}", term_id))?;

        match &session.handle {
            TerminalHandle::Local { writer, .. } => {
                let mut writer = writer.lock().await;
                writer
                    .write_all(data.as_bytes())
                    .map_err(|e| anyhow!("Failed to write to PTY: {}", e))?;
                writer.flush().map_err(|e| anyhow!("Failed to flush PTY: {}", e))?;
            }
            TerminalHandle::Remote { tx, .. } => {
                // Send data to the manager task
                tx.send(data.as_bytes().to_vec()).await
                    .map_err(|e| anyhow!("Failed to send input to SSH task: {}", e))?;
            }
        }

        Ok(())
    }

    pub async fn resize(&self, term_id: &str, cols: u16, rows: u16) -> Result<()> {
        let mut sessions = self.sessions.lock().await;
        let session = sessions
            .get_mut(term_id)
            .ok_or_else(|| anyhow!("Session not found: {}", term_id))?;

        match &mut session.handle {
            TerminalHandle::Local { master, .. } => {
                master
                    .resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .map_err(|e| anyhow!("Failed to resize PTY: {}", e))?;
            }
            TerminalHandle::Remote { resize_tx, .. } => {
                resize_tx.send((cols, rows)).await
                    .map_err(|e| anyhow!("Failed to send resize to SSH task: {}", e))?;
            }
        }

        Ok(())
    }

    pub async fn close(&self, term_id: &str) -> Result<()> {
        let mut sessions = self.sessions.lock().await;
        if let Some(mut session) = sessions.remove(term_id) {
            match &mut session.handle {
                TerminalHandle::Local { reader_handle, .. } => {
                    if let Some(handle) = reader_handle.take() {
                        handle.abort();
                    }
                }
                TerminalHandle::Remote { task_handle, .. } => {
                    if let Some(handle) = task_handle.take() {
                        handle.abort();
                    }
                }
            }
        }
        Ok(())
    }

    pub async fn close_by_connection(&self, connection_id: &str) -> Result<()> {
        let mut sessions = self.sessions.lock().await;
        let mut ids_to_remove = Vec::new();

        for (id, session) in sessions.iter() {
            if session.connection_id == connection_id {
                ids_to_remove.push(id.clone());
            }
        }

        println!("[PTY] Closing {} sessions for connection {}", ids_to_remove.len(), connection_id);

        for id in ids_to_remove {
            if let Some(mut session) = sessions.remove(&id) {
                match &mut session.handle {
                    TerminalHandle::Local { reader_handle, .. } => {
                        if let Some(handle) = reader_handle.take() {
                            handle.abort();
                        }
                    }
                    TerminalHandle::Remote { task_handle, .. } => {
                        if let Some(handle) = task_handle.take() {
                            handle.abort();
                        }
                    }
                }
            }
        }

        Ok(())
    }
}
