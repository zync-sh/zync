use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use russh::client::Msg;
use russh::{Channel, ChannelMsg};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::mem;
use std::sync::Arc;
use std::sync::mpsc as std_mpsc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex};
use tokio::time::{Duration, Instant};

/// Maximum time to hold remote SSH output before emitting a combined frontend event.
const REMOTE_OUTPUT_BATCH_MS: u64 = 8;
/// Flush buffered remote output immediately once it reaches this many bytes.
const REMOTE_OUTPUT_FLUSH_THRESHOLD: usize = 4096;

#[derive(Clone, Serialize)]
struct TerminalLifecycleEvent {
    generation: u32,
}

#[derive(Clone, Serialize)]
struct TerminalOutputEvent {
    generation: u32,
    data: Vec<u8>,
}

/// Emits a terminal output chunk to the frontend without changing the existing event contract.
///
/// Keeping this in a helper centralizes the `terminal-output-{term_id}` event
/// shape so local and remote PTY paths stay consistent.
fn emit_terminal_output(app_handle: &AppHandle, term_id: &str, generation: u32, payload: &[u8]) {
    let event = TerminalOutputEvent {
        generation,
        data: payload.to_vec(),
    };
    if let Err(e) = app_handle.emit(&format!("terminal-output-{}", term_id), event) {
        eprintln!("[PTY] Failed to emit output: {}", e);
    }
}

/// Flushes buffered remote output into a single frontend event.
///
/// The remote SSH path may receive very small chunks for echo and control
/// sequences. This helper coalesces them without losing trailing bytes on exit.
fn flush_pending_output(
    app_handle: &AppHandle,
    term_id: &str,
    generation: u32,
    pending_output: &mut Vec<u8>,
) {
    if pending_output.is_empty() {
        return;
    }

    let output = mem::take(pending_output);
    emit_terminal_output(app_handle, term_id, generation, &output);
}
// Enum to handle both local PTY and remote SSH channels
pub enum TerminalHandle {
    Local {
        writer: Arc<Mutex<Box<dyn Write + Send>>>,
        reader_handle: Option<tokio::task::JoinHandle<()>>,
        /// Handle for the PowerShell prompt-injection task.
        /// Aborted on session close so it can't write to a dead PTY.
        inject_handle: Option<tokio::task::JoinHandle<()>>,
        master: Box<dyn MasterPty + Send>,
        #[allow(dead_code)]
        child: Box<dyn portable_pty::Child + Send>,
    },
    Remote {
        tx: mpsc::Sender<Vec<u8>>,           // Send input data to the channel task
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
        generation: u32,
        cols: u16,
        rows: u16,
        app_handle: AppHandle,
        shell_override: Option<String>,
        cwd: Option<String>,
    ) -> Result<()> {
        // Clean up any existing dead/stale session with this ID before creating a new one
        let _ = self.close(&term_id).await;

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
                Some("powershell") | Some("default") | None => {
                    ("powershell.exe".to_string(), vec![])
                }
                Some(other) => {
                    // Try to use it as a direct path or command
                    (other.to_string(), vec![])
                }
            }
        } else {
            (
                std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string()),
                vec![],
            )
        };
        let mut cmd = CommandBuilder::new(&shell);
        for arg in &args {
            cmd.arg(arg);
        }

        if let Some(path) = cwd {
            cmd.cwd(path);
        }

        // Add interactive flag if not already present
        if !args.contains(&"-i".to_string())
            && !shell.contains("powershell")
            && !shell.contains("cmd.exe")
            && !shell.contains("wsl.exe")
        {
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
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| anyhow!("Failed to clone reader: {}", e))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| anyhow!("Failed to take writer: {}", e))?;

        // Create the writer Arc up-front so we can clone it for shell integration.
        let writer_arc = Arc::new(Mutex::new(writer));

        // No shell integration injected — CWD is tracked passively via OSC 7
        // for shells that already emit it (starship, oh-my-posh, fish, etc.).
        let inject_handle: Option<tokio::task::JoinHandle<()>> = None;

        let session = PtySession {
            term_id: term_id.clone(),
            connection_id,
            handle: TerminalHandle::Local {
                writer: writer_arc,
                reader_handle: None,
                inject_handle,
                master: pair.master,
                child,
            },
        };

        let mut sessions = self.sessions.lock().await;
        sessions.insert(term_id.clone(), session);
        drop(sessions);

        // Spawn a task to read from PTY, but gate its first read until after
        // ready has been published. This keeps the session insertion atomic and
        // avoids orphaning the reader if close() races immediately after insert.
        let term_id_clone = term_id.clone();
        let app_handle_clone = app_handle.clone();
        let (reader_start_tx, reader_start_rx) = std_mpsc::channel::<()>();
        let reader_handle = tokio::task::spawn_blocking(move || {
            let _ = reader_start_rx.recv();
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        // Notify frontend that terminal exited
                        let _ = app_handle_clone.emit(
                            &format!("terminal-exit-{}", term_id_clone),
                            TerminalLifecycleEvent { generation },
                        );
                        break;
                    } // EOF
                    Ok(n) => {
                        // Emit as binary (Vec<u8>) to avoid UTF-8 corruption on chunk boundaries
                        emit_terminal_output(&app_handle_clone, &term_id_clone, generation, &buf[..n]);
                    }
                    Err(e) => {
                        eprintln!("Error reading from PTY: {}", e);
                        // Notify frontend that terminal exited due to error
                        let _ = app_handle_clone.emit(
                            &format!("terminal-exit-{}", term_id_clone),
                            TerminalLifecycleEvent { generation },
                        );
                        break;
                    }
                }
            }
        });

        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.get_mut(&term_id) {
            if let TerminalHandle::Local { reader_handle: session_reader_handle, .. } = &mut session.handle {
                *session_reader_handle = Some(reader_handle);
            }
        }
        drop(sessions);

        // Notify frontend that terminal is ready for input only after the
        // session has a live reader handle wired for cleanup.
        let _ = app_handle.emit(
            &format!("terminal-ready-{}", term_id),
            TerminalLifecycleEvent { generation },
        );
        let _ = reader_start_tx.send(());

        Ok(())
    }

    // Create a remote SSH session
    pub async fn create_remote_session(
        &self,
        term_id: String,
        connection_id: String,
        generation: u32,
        mut channel: Channel<Msg>,
        cols: u16,
        rows: u16,
        app_handle: AppHandle,
        cwd: Option<String>,
    ) -> Result<()> {
        println!("[PTY] Creating remote session for {}", term_id);

        // Clean up any existing dead/stale session with this ID before creating a new one
        let _ = self.close(&term_id).await;

        // Request PTY on the channel
        channel
            .request_pty(
                false,
                "xterm-256color",
                cols as u32,
                rows as u32,
                0,
                0,
                &[], // No modes for now
            )
            .await
            .map_err(|e| anyhow!("Failed to request PTY: {}", e))?;

        // Request shell
        channel
            .request_shell(false)
            .await
            .map_err(|e| anyhow!("Failed to request shell: {}", e))?;

        // If cwd is provided, send a cd command immediately
        if let Some(path) = cwd {
            let cd_cmd = format!("cd '{}' && clear\r", path.replace("'", "'\\''"));
            channel
                .data(cd_cmd.as_bytes())
                .await
                .map_err(|e| anyhow!("Failed to send initial cd command: {}", e))?;
        }

        // Create channels for communication
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(32);
        let (resize_tx, mut resize_rx) = mpsc::channel::<(u16, u16)>(4);

        let session = PtySession {
            term_id: term_id.clone(),
            connection_id,
            handle: TerminalHandle::Remote {
                tx,
                resize_tx,
                task_handle: None,
            },
        };

        let mut sessions = self.sessions.lock().await;
        sessions.insert(term_id.clone(), session);
        drop(sessions);

        // Notify frontend that terminal is ready for input
        let _ = app_handle.emit(
            &format!("terminal-ready-{}", term_id),
            TerminalLifecycleEvent { generation },
        );

        let term_id_clone = term_id.clone();
        let app_handle_clone = app_handle.clone();

        // Spawn the manager task only after ready has been published so same-generation
        // output/exit events can never arrive before the frontend has seen ready.
        let task_handle = tokio::task::spawn(async move {
            let app_handle = app_handle_clone;
            println!("[PTY] Starting manager task for {}", term_id_clone);
            let mut pending_output = Vec::new();
            let mut flush_deadline: Option<Instant> = None;

            loop {
                tokio::select! {
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { ref data }) => {
                                pending_output.extend_from_slice(data.as_ref());

                                if pending_output.len() >= REMOTE_OUTPUT_FLUSH_THRESHOLD {
                                    flush_pending_output(&app_handle, &term_id_clone, generation, &mut pending_output);
                                    flush_deadline = None;
                                } else if flush_deadline.is_none() {
                                    flush_deadline = Some(Instant::now() + Duration::from_millis(REMOTE_OUTPUT_BATCH_MS));
                                }
                            }
                            Some(ChannelMsg::ExitStatus { exit_status }) => {
                                flush_pending_output(&app_handle, &term_id_clone, generation, &mut pending_output);
                                let _ = app_handle.emit(
                                    &format!("terminal-exit-{}", term_id_clone),
                                    TerminalLifecycleEvent { generation },
                                );
                                println!("[PTY] Remote shell exited with status: {}", exit_status);
                                break;
                            }
                            Some(ChannelMsg::Eof) => {
                                flush_pending_output(&app_handle, &term_id_clone, generation, &mut pending_output);
                                let _ = app_handle.emit(
                                    &format!("terminal-exit-{}", term_id_clone),
                                    TerminalLifecycleEvent { generation },
                                );
                                println!("[PTY] Remote channel EOF");
                                break;
                            }
                            None => {
                                flush_pending_output(&app_handle, &term_id_clone, generation, &mut pending_output);
                                let _ = app_handle.emit(
                                    &format!("terminal-exit-{}", term_id_clone),
                                    TerminalLifecycleEvent { generation },
                                );
                                println!("[PTY] Channel closed");
                                break;
                            }
                            _ => {}
                        }
                    }

                    _ = async {
                        if let Some(deadline) = flush_deadline.clone() {
                            tokio::time::sleep_until(deadline).await;
                        }
                    }, if flush_deadline.is_some() => {
                        flush_pending_output(&app_handle, &term_id_clone, generation, &mut pending_output);
                        flush_deadline = None;
                    }

                    Some(input) = rx.recv() => {
                        if let Err(e) = channel.data(&input[..]).await {
                             eprintln!("[PTY] Failed to send data to channel: {}", e);
                             break;
                        }
                    }

                    Some((mut c, mut r)) = resize_rx.recv() => {
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

            flush_pending_output(&app_handle, &term_id_clone, generation, &mut pending_output);
            let _ = channel.close().await;
            println!("[PTY] Remote session task ended");
        });

        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.get_mut(&term_id) {
            if let TerminalHandle::Remote { task_handle: session_task_handle, .. } = &mut session.handle {
                *session_task_handle = Some(task_handle);
            }
        }
        println!("[PTY] Remote session created successfully");

        Ok(())
    }

    pub async fn write(&self, term_id: &str, data: &str) -> Result<()> {
        let (local_writer_opt, remote_tx_opt) = {
            let sessions = self.sessions.lock().await;
            let session = sessions
                .get(term_id)
                .ok_or_else(|| anyhow!("Session not found: {}", term_id))?;
            
            match &session.handle {
                TerminalHandle::Local { writer, .. } => (Some(writer.clone()), None),
                TerminalHandle::Remote { tx, .. } => (None, Some(tx.clone())),
            }
        }; // sessions lock is dropped here

        if let Some(writer) = local_writer_opt {
            let mut writer = writer.lock().await;
            writer
                .write_all(data.as_bytes())
                .map_err(|e| anyhow!("Failed to write to PTY: {}", e))?;
            writer
                .flush()
                .map_err(|e| anyhow!("Failed to flush PTY: {}", e))?;
        } else if let Some(tx) = remote_tx_opt {
            // Send data to the manager task
            tx.send(data.as_bytes().to_vec())
                .await
                .map_err(|e| anyhow!("Failed to send input to SSH task: {}", e))?;
        }

        Ok(())
    }

    pub async fn resize(&self, term_id: &str, cols: u16, rows: u16) -> Result<()> {
        let remote_tx_opt = {
            let mut sessions = self.sessions.lock().await;
            let session = sessions
                .get_mut(term_id)
                .ok_or_else(|| anyhow!("Session not found: {}", term_id))?;

            match &mut session.handle {
                TerminalHandle::Local { master, .. } => {
                    // Local resize is synchronous and doesn't block on network I/O
                    master
                        .resize(PtySize {
                            rows,
                            cols,
                            pixel_width: 0,
                            pixel_height: 0,
                        })
                        .map_err(|e| anyhow!("Failed to resize PTY: {}", e))?;
                    None
                }
                TerminalHandle::Remote { resize_tx, .. } => {
                    Some(resize_tx.clone())
                }
            }
        }; // sessions lock is dropped here

        if let Some(resize_tx) = remote_tx_opt {
            resize_tx
                .send((cols, rows))
                .await
                .map_err(|e| anyhow!("Failed to send resize to SSH task: {}", e))?;
        }

        Ok(())
    }

    pub async fn close(&self, term_id: &str) -> Result<()> {
        let mut sessions = self.sessions.lock().await;
        if let Some(mut session) = sessions.remove(term_id) {
            match &mut session.handle {
                TerminalHandle::Local { reader_handle, inject_handle, .. } => {
                    if let Some(handle) = inject_handle.take() {
                        handle.abort();
                    }
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

        println!(
            "[PTY] Closing {} sessions for connection {}",
            ids_to_remove.len(),
            connection_id
        );

        for id in ids_to_remove {
            if let Some(mut session) = sessions.remove(&id) {
                match &mut session.handle {
                    TerminalHandle::Local { reader_handle, inject_handle, .. } => {
                        if let Some(handle) = inject_handle.take() {
                            handle.abort();
                        }
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
