use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use russh::client::Msg;
use russh::{Channel, ChannelMsg};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::mem;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::mpsc as std_mpsc;
use tauri::ipc::{Channel as IpcChannel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex};
use tokio::time::{Duration, Instant};

/// Maximum time to hold PTY output before emitting a combined frontend event.
const OUTPUT_BATCH_MS: u64 = 8;
/// Flush buffered PTY output immediately once it reaches this many bytes.
const OUTPUT_FLUSH_THRESHOLD: usize = 4096;

enum LocalReaderEvent {
    Data(Vec<u8>),
    Finished { exit_code: Option<u32> },
}

fn remote_shell_login_flag(shell_override: &str) -> Option<&'static str> {
    let token = shell_override.split_whitespace().next().unwrap_or(shell_override);
    let base_name = std::path::Path::new(token)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(token)
        .to_ascii_lowercase();

    match base_name.as_str() {
        "bash" | "zsh" | "sh" | "dash" | "ksh" | "rbash" | "tcsh" | "csh" => Some("-l"),
        "fish" => Some("--login"),
        _ => None,
    }
}

fn is_remote_windows(remote_os: Option<&str>) -> bool {
    remote_os
        .map(|os| os.eq_ignore_ascii_case("windows"))
        .unwrap_or(false)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ShellKind {
    Cmd,
    PowerShell,
    Pwsh,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NavigateShellStyle {
    Posix,
    WindowsCmd,
    WindowsPowerShell,
    WindowsOther,
}

impl From<ShellKind> for NavigateShellStyle {
    fn from(kind: ShellKind) -> Self {
        match kind {
            ShellKind::Cmd => NavigateShellStyle::WindowsCmd,
            ShellKind::PowerShell | ShellKind::Pwsh => NavigateShellStyle::WindowsPowerShell,
            ShellKind::Other => NavigateShellStyle::WindowsOther,
        }
    }
}

fn classify_windows_shell(shell_label: &str) -> ShellKind {
    let trimmed = shell_label.trim();
    if trimmed.is_empty() {
        return ShellKind::Other;
    }

    let token = trimmed.split_whitespace().next().unwrap_or(trimmed);
    let base_name = std::path::Path::new(token)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(token)
        .to_ascii_lowercase();

    match base_name.as_str() {
        "cmd" | "cmd.exe" => ShellKind::Cmd,
        "powershell" | "powershell.exe" => ShellKind::PowerShell,
        "pwsh" | "pwsh.exe" => ShellKind::Pwsh,
        _ => {
            let lc = trimmed.to_ascii_lowercase();
            if lc == "command prompt" {
                ShellKind::Cmd
            } else if lc == "windows powershell" || lc == "powershell" {
                ShellKind::PowerShell
            } else if lc.starts_with("powershell 7") {
                ShellKind::Pwsh
            } else {
                ShellKind::Other
            }
        }
    }
}

fn remote_windows_shell_command(shell_override: &str) -> Option<&'static str> {
    match classify_windows_shell(shell_override) {
        ShellKind::PowerShell => Some("powershell.exe -NoLogo"),
        ShellKind::Pwsh => Some("pwsh.exe -NoLogo"),
        ShellKind::Cmd => Some("cmd.exe"),
        ShellKind::Other => None,
    }
}

fn shell_single_quote(value: &str) -> String {
    value.replace('\'', "'\\''")
}

/// Format a path for POSIX `cd`. Tilde prefixes must stay unquoted so the shell
/// expands them; only the suffix after `~/` is single-quoted when present.
pub(crate) fn posix_shell_cd_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed == "~" {
        return "~".to_string();
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        if rest.is_empty() {
            return "~".to_string();
        }
        return format!("~/'{}'", shell_single_quote(rest));
    }
    if let Some(tail) = trimmed.strip_prefix('~') {
        if !tail.is_empty() && !tail.starts_with('/') {
            let (user, rest) = tail
                .split_once('/')
                .map(|(u, r)| (u, Some(r)))
                .unwrap_or((tail, None));
            if !user.is_empty()
                && user
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            {
                return match rest {
                    Some("") | None => format!("~{user}"),
                    Some(rest) => format!("~{user}/'{}'", shell_single_quote(rest)),
                };
            }
        }
    }
    format!("'{}'", shell_single_quote(trimmed))
}

pub(crate) fn build_navigate_cd_command(path: &str, style: NavigateShellStyle) -> String {
    match style {
        NavigateShellStyle::Posix => format!("cd {}\r", posix_shell_cd_path(path)),
        NavigateShellStyle::WindowsCmd => {
            format!("cd /d \"{}\"\r", windows_double_quote(path, false))
        }
        NavigateShellStyle::WindowsPowerShell => format!(
            "Set-Location -LiteralPath '{}'\r",
            powershell_single_quote(path)
        ),
        NavigateShellStyle::WindowsOther => {
            format!("cd \"{}\"\r", windows_double_quote(path, false))
        }
    }
}

fn local_navigate_shell_style(
    shell_override: Option<&str>,
    is_wsl_shell: bool,
    shell: &str,
) -> NavigateShellStyle {
    if !cfg!(target_os = "windows") {
        return NavigateShellStyle::Posix;
    }
    if is_wsl_shell || is_posix_interactive_shell(shell) {
        return NavigateShellStyle::Posix;
    }
    match shell_override.map(str::trim) {
        Some("cmd") => NavigateShellStyle::WindowsCmd,
        Some("pwsh") => NavigateShellStyle::WindowsPowerShell,
        Some(s) if s.eq_ignore_ascii_case("powershell") || s.eq_ignore_ascii_case("default") => {
            NavigateShellStyle::WindowsPowerShell
        }
        None => NavigateShellStyle::WindowsPowerShell,
        Some(other) => classify_windows_shell(other).into(),
    }
}

fn remote_navigate_shell_style(
    remote_is_windows: bool,
    shell_override: Option<&str>,
) -> NavigateShellStyle {
    if !remote_is_windows {
        return NavigateShellStyle::Posix;
    }
    let selected = shell_override
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("default"));
    match selected {
        Some(shell) => classify_windows_shell(shell).into(),
        None => NavigateShellStyle::WindowsOther,
    }
}

fn powershell_single_quote(value: &str) -> String {
    value.replace('\'', "''")
}

fn windows_double_quote(value: &str, batch_mode: bool) -> String {
    // cmd.exe escaping for literal values:
    //  - always: ^ => ^^, " => ""
    //  - batch/exec only: ! => ^!, % => %% (expansion semantics differ from interactive input)
    let escaped = value.replace('^', "^^").replace('"', "\"\"");
    if batch_mode {
        escaped.replace('!', "^!").replace('%', "%%")
    } else {
        escaped
    }
}

fn is_posix_interactive_shell(shell: &str) -> bool {
    let normalized = shell.trim().to_ascii_lowercase();
    let basename = normalized
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(normalized.as_str());
    let normalized_base = basename.strip_suffix(".exe").unwrap_or(basename);
    matches!(
        normalized_base,
        "bash" | "zsh" | "fish" | "dash" | "ksh" | "tcsh" | "csh" | "sh"
    )
}

#[derive(Clone, Serialize)]
struct TerminalLifecycleEvent {
    generation: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<u32>,
}

/// Flushes buffered PTY output through the streaming IPC channel.
///
/// Frames are `generation` (u32 LE) + raw PTY bytes so the frontend can ignore
/// stale chunks after suspend/restart races.
fn flush_pending_output(
    output_channel: &IpcChannel,
    generation: u32,
    pending_output: &mut Vec<u8>,
) {
    if pending_output.is_empty() {
        return;
    }

    let output = mem::take(pending_output);
    let mut frame = Vec::with_capacity(4 + output.len());
    frame.extend_from_slice(&generation.to_le_bytes());
    frame.extend_from_slice(&output);

    if let Err(e) = output_channel.send(InvokeResponseBody::Raw(frame)) {
        eprintln!("[PTY] Failed to send output on channel: {}", e);
    }
}

fn process_tree_has_children(root_pid: u32) -> bool {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);
    let parent = Pid::from_u32(root_pid);
    system.processes().values().any(|process| process.parent() == Some(parent))
}

fn emit_terminal_exit(app_handle: &AppHandle, term_id: &str, generation: u32, exit_code: Option<u32>) {
    if let Err(e) = app_handle.emit(
        &format!("terminal-exit-{}", term_id),
        TerminalLifecycleEvent {
            generation,
            exit_code,
        },
    ) {
        eprintln!("[PTY] Failed to emit exit for {}: {}", term_id, e);
    }
}

fn emit_connection_transport_lost(app_handle: &AppHandle, connection_id: &str) {
    if let Err(e) = app_handle.emit(
        "connection:transport-lost",
        serde_json::json!({ "connectionId": connection_id }),
    ) {
        eprintln!(
            "[PTY] Failed to emit transport-lost for {}: {}",
            connection_id, e
        );
    }
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
        child_killer: Box<dyn ChildKiller + Send + Sync>,
        child_pid: Option<u32>,
    },
    Remote {
        tx: mpsc::Sender<Vec<u8>>,           // Send input data to the channel task
        resize_tx: mpsc::Sender<(u16, u16)>, // Send resize events
        task_handle: Option<tokio::task::JoinHandle<()>>,
    },
}

pub struct PtySession {
    pub connection_id: String,
    /// Held for the session lifetime so the frontend channel stays open until close.
    #[allow(dead_code)]
    pub output_channel: IpcChannel,
    pub handle: TerminalHandle,
    navigate_shell: NavigateShellStyle,
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

    fn cleanup_session_handles(handle: &mut TerminalHandle) {
        match handle {
            TerminalHandle::Local {
                reader_handle,
                inject_handle,
                child_killer,
                ..
            } => {
                if let Some(task) = inject_handle.take() {
                    task.abort();
                }
                if let Some(task) = reader_handle.take() {
                    task.abort();
                }
                let _ = child_killer.kill();
            }
            TerminalHandle::Remote { task_handle, .. } => {
                if let Some(task) = task_handle.take() {
                    task.abort();
                }
            }
        }
    }

    /// Drop backend resources after a natural shell exit without aborting the reader task that reported it.
    fn finalize_session_after_natural_exit(handle: &mut TerminalHandle) {
        match handle {
            TerminalHandle::Local {
                reader_handle,
                inject_handle,
                child_killer,
                ..
            } => {
                inject_handle.take();
                reader_handle.take();
                let _ = child_killer.kill();
            }
            TerminalHandle::Remote { task_handle, .. } => {
                task_handle.take();
            }
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
        output_channel: IpcChannel,
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
        let (shell, mut args, is_wsl_shell): (String, Vec<String>, bool) = if cfg!(target_os = "windows") {
            match shell_override.as_deref() {
                Some("cmd") => ("cmd.exe".to_string(), vec![], false),
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
                    (bash_path, vec!["--login".to_string(), "-i".to_string()], false)
                }
                Some("wsl") => ("wsl.exe".to_string(), vec![], true),
                Some(wsl_distro) if wsl_distro.starts_with("wsl:") => {
                    let distro = wsl_distro.strip_prefix("wsl:").unwrap_or("").to_string();
                    if distro.trim().is_empty() {
                        ("wsl.exe".to_string(), vec![], true)
                    } else {
                        ("wsl.exe".to_string(), vec!["-d".to_string(), distro], true)
                    }
                }
                Some("pwsh") => {
                    let pwsh_paths = [
                        "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
                        "C:\\Program Files\\PowerShell\\pwsh.exe",
                    ];
                    let pwsh_path = pwsh_paths
                        .iter()
                        .find(|p| std::path::Path::new(p).exists())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| "pwsh.exe".to_string());
                    (pwsh_path, vec!["-NoLogo".to_string()], false)
                }
                Some(s)
                    if s.eq_ignore_ascii_case("powershell")
                        || s.eq_ignore_ascii_case("default") =>
                {
                    ("powershell.exe".to_string(), vec![], false)
                }
                None => ("powershell.exe".to_string(), vec![], false),
                Some(other) => {
                    // Try to use it as a direct path or command
                    (other.to_string(), vec![], false)
                }
            }
        } else {
            let path = shell_override
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("default"))
                .map(|s| s.to_string())
                .unwrap_or_else(|| std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string()));
            (path, vec![], false)
        };

        // WSL should open in Linux context. If we have a Linux cwd, pass it via `--cd`.
        // Otherwise force distro home (`~`) instead of inheriting host Windows cwd.
        if is_wsl_shell {
            let provided_cwd = cwd.as_deref().map(str::trim);
            let linux_cwd = provided_cwd
                .filter(|path| !path.is_empty() && path.starts_with('/'));
            if linux_cwd.is_none() {
                if let Some(original) = provided_cwd {
                    eprintln!(
                        "[PTY] WSL: provided cwd '{}' is not a Linux path, falling back to '~'",
                        original
                    );
                } else {
                    eprintln!("[PTY] WSL: no Linux cwd provided, falling back to '~'");
                }
            }
            let wsl_cwd = linux_cwd.unwrap_or("~").to_string();
            args.push("--cd".to_string());
            args.push(wsl_cwd);
        }

        let mut cmd = CommandBuilder::new(&shell);
        for arg in &args {
            cmd.arg(arg);
        }

        if !is_wsl_shell {
            if let Some(path) = cwd {
                cmd.cwd(path);
            }
        }

        // Add interactive flag only for shells known to support POSIX-style `-i`.
        if !args.iter().any(|arg| arg == "-i") && is_posix_interactive_shell(&shell) {
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

        let mut child = pair
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
        let child_killer = child.clone_killer();
        let child_pid = child.process_id();

        let navigate_shell = local_navigate_shell_style(
            shell_override.as_deref(),
            is_wsl_shell,
            &shell,
        );
        let session = PtySession {
            connection_id,
            output_channel: output_channel.clone(),
            handle: TerminalHandle::Local {
                writer: writer_arc,
                reader_handle: None,
                inject_handle,
                master: pair.master,
                child_killer,
                child_pid,
            },
            navigate_shell,
        };

        let mut sessions = self.sessions.lock().await;
        sessions.insert(term_id.clone(), session);
        drop(sessions);

        // Spawn a task to read from PTY, but gate its first read until after
        // ready has been published. This keeps the session insertion atomic and
        // avoids orphaning the reader if close() races immediately after insert.
        let term_id_clone = term_id.clone();
        let app_handle_clone = app_handle.clone();
        let output_channel_clone = output_channel.clone();
        let (reader_start_tx, reader_start_rx) = std_mpsc::channel::<()>();
        let (output_tx, mut output_rx) = tokio::sync::mpsc::channel::<LocalReaderEvent>(64);
        let output_tx_for_wait = output_tx.clone();

        tokio::task::spawn_blocking(move || {
            let exit_code = child.wait().ok().map(|status| status.exit_code());
            let _ = output_tx_for_wait.blocking_send(LocalReaderEvent::Finished { exit_code });
        });

        tokio::task::spawn_blocking(move || {
            let _ = reader_start_rx.recv();
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        let _ = output_tx.blocking_send(LocalReaderEvent::Finished { exit_code: None });
                        break;
                    }
                    Ok(n) => {
                        if output_tx
                            .blocking_send(LocalReaderEvent::Data(buf[..n].to_vec()))
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(e) => {
                        eprintln!("Error reading from PTY: {}", e);
                        let _ = output_tx.blocking_send(LocalReaderEvent::Finished { exit_code: None });
                        break;
                    }
                }
            }
        });

        let exit_emitted = Arc::new(AtomicBool::new(false));
        let exit_emitted_clone = exit_emitted.clone();
        let sessions_for_exit = self.sessions.clone();
        let term_id_for_exit = term_id.clone();

        let reader_handle = tokio::spawn(async move {
            let mut pending_output = Vec::new();
            let mut flush_deadline: Option<Instant> = None;

            loop {
                tokio::select! {
                    event = output_rx.recv() => {
                        match event {
                            Some(LocalReaderEvent::Data(chunk)) => {
                                pending_output.extend_from_slice(&chunk);

                                if pending_output.len() >= OUTPUT_FLUSH_THRESHOLD {
                                    flush_pending_output(&output_channel_clone, generation, &mut pending_output);
                                    flush_deadline = None;
                                } else if flush_deadline.is_none() {
                                    flush_deadline = Some(Instant::now() + Duration::from_millis(OUTPUT_BATCH_MS));
                                }
                            }
                            Some(LocalReaderEvent::Finished { exit_code }) => {
                                flush_pending_output(&output_channel_clone, generation, &mut pending_output);
                                if !exit_emitted_clone.swap(true, Ordering::SeqCst) {
                                    emit_terminal_exit(
                                        &app_handle_clone,
                                        &term_id_clone,
                                        generation,
                                        exit_code,
                                    );
                                    let sessions_ref = sessions_for_exit.clone();
                                    let term_id_cleanup = term_id_for_exit.clone();
                                    tokio::spawn(async move {
                                        let mut sessions = sessions_ref.lock().await;
                                        if let Some(mut session) = sessions.remove(&term_id_cleanup) {
                                            PtyManager::finalize_session_after_natural_exit(
                                                &mut session.handle,
                                            );
                                        }
                                    });
                                }
                                break;
                            }
                            None => break,
                        }
                    }

                    _ = async {
                        if let Some(deadline) = flush_deadline {
                            tokio::time::sleep_until(deadline).await;
                        }
                    }, if flush_deadline.is_some() => {
                        flush_pending_output(&output_channel_clone, generation, &mut pending_output);
                        flush_deadline = None;
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
            TerminalLifecycleEvent {
                generation,
                exit_code: None,
            },
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
        output_channel: IpcChannel,
        shell_override: Option<String>,
        remote_os: Option<String>,
        cwd: Option<String>,
    ) -> Result<()> {
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

        let remote_is_windows = is_remote_windows(remote_os.as_deref());
        let selected_shell = shell_override
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("default"));

        if let Some(shell) = selected_shell {
            // Start explicit remote shell (path or command name) when user selected one.
            // Unix hosts use `exec` to replace the current command process with the chosen shell.
            // Windows OpenSSH hosts need native shell executables instead of POSIX `exec`.
            let launch = if remote_is_windows {
                remote_windows_shell_command(shell)
                    .map(|command| command.to_string())
                    .unwrap_or_else(|| format!("\"{}\"", windows_double_quote(shell, true)))
            } else {
                let escaped_shell = shell_single_quote(shell);
                match remote_shell_login_flag(shell) {
                    Some(login_flag) => format!("exec '{}' {}", escaped_shell, login_flag),
                    None => format!("exec '{}'", escaped_shell),
                }
            };
            // Important: `exec` and `request_shell` are different channel request
            // types. If `exec` fails, callers must open a fresh channel before retrying.
            channel
                .exec(false, launch)
                .await
                .map_err(|e| anyhow!("Failed to launch selected remote shell '{}': {}", shell, e))?;
        } else {
            // Default remote login shell.
            channel
                .request_shell(false)
                .await
                .map_err(|e| anyhow!("Failed to request shell: {}", e))?;
        }

        // If cwd is provided, send a cd command immediately.
        if let Some(path) = cwd {
            let cd_cmd = if remote_is_windows {
                match selected_shell.map(classify_windows_shell).unwrap_or(ShellKind::Other) {
                    ShellKind::Cmd => {
                        format!("cd /d \"{}\" && cls\r", windows_double_quote(&path, false))
                    }
                    ShellKind::PowerShell | ShellKind::Pwsh => {
                        format!(
                            "Set-Location -LiteralPath '{}'; Clear-Host\r",
                            powershell_single_quote(&path)
                        )
                    }
                    ShellKind::Other => {
                        // Unknown Windows default shell. `cd \"...\"` is accepted by
                        // both cmd and PowerShell for same-drive navigation; avoid
                        // shell-specific `/d` or `Set-Location` syntax here.
                        format!("cd \"{}\" && cls\r", windows_double_quote(&path, false))
                    }
                }
            } else {
                let trimmed = path.trim();
                if trimmed == "~" {
                    "clear\r".to_string()
                } else {
                    format!("cd {} && clear\r", posix_shell_cd_path(trimmed))
                }
            };
            channel
                .data(cd_cmd.as_bytes())
                .await
                .map_err(|e| anyhow!("Failed to send initial cd command: {}", e))?;
        }

        // Create channels for communication
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(32);
        let (resize_tx, mut resize_rx) = mpsc::channel::<(u16, u16)>(4);

        let navigate_shell = remote_navigate_shell_style(
            remote_is_windows,
            selected_shell,
        );
        let connection_id_for_transport = connection_id.clone();
        let session = PtySession {
            connection_id,
            output_channel: output_channel.clone(),
            handle: TerminalHandle::Remote {
                tx,
                resize_tx,
                task_handle: None,
            },
            navigate_shell,
        };

        let mut sessions = self.sessions.lock().await;
        sessions.insert(term_id.clone(), session);
        drop(sessions);

        // Notify frontend that terminal is ready for input
        let _ = app_handle.emit(
            &format!("terminal-ready-{}", term_id),
            TerminalLifecycleEvent {
                generation,
                exit_code: None,
            },
        );

        let term_id_clone = term_id.clone();
        let app_handle_clone = app_handle.clone();
        let output_channel_clone = output_channel.clone();
        let sessions_for_exit = self.sessions.clone();
        let term_id_for_exit = term_id.clone();

        // Spawn the manager task only after ready has been published so same-generation
        // output/exit events can never arrive before the frontend has seen ready.
        let task_handle = tokio::task::spawn(async move {
            let app_handle = app_handle_clone;
            let mut pending_output = Vec::new();
            let mut flush_deadline: Option<Instant> = None;

            loop {
                tokio::select! {
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { ref data }) => {
                                pending_output.extend_from_slice(data.as_ref());

                                if pending_output.len() >= OUTPUT_FLUSH_THRESHOLD {
                                    flush_pending_output(&output_channel_clone, generation, &mut pending_output);
                                    flush_deadline = None;
                                } else if flush_deadline.is_none() {
                                    flush_deadline = Some(Instant::now() + Duration::from_millis(OUTPUT_BATCH_MS));
                                }
                            }
                            Some(ChannelMsg::ExitStatus { exit_status }) => {
                                flush_pending_output(&output_channel_clone, generation, &mut pending_output);
                                emit_terminal_exit(
                                    &app_handle,
                                    &term_id_clone,
                                    generation,
                                    Some(exit_status),
                                );
                                break;
                            }
                            Some(ChannelMsg::Eof) => {
                                flush_pending_output(&output_channel_clone, generation, &mut pending_output);
                                emit_connection_transport_lost(&app_handle, &connection_id_for_transport);
                                emit_terminal_exit(&app_handle, &term_id_clone, generation, None);
                                break;
                            }
                            None => {
                                flush_pending_output(&output_channel_clone, generation, &mut pending_output);
                                emit_connection_transport_lost(&app_handle, &connection_id_for_transport);
                                emit_terminal_exit(&app_handle, &term_id_clone, generation, None);
                                break;
                            }
                            _ => {}
                        }
                    }

                    _ = async {
                        if let Some(deadline) = flush_deadline {
                            tokio::time::sleep_until(deadline).await;
                        }
                    }, if flush_deadline.is_some() => {
                        flush_pending_output(&output_channel_clone, generation, &mut pending_output);
                        flush_deadline = None;
                    }

                    Some(input) = rx.recv() => {
                        if let Err(e) = channel.data(&input[..]).await {
                             eprintln!("[PTY] Failed to send data to channel: {}", e);
                             emit_connection_transport_lost(&app_handle, &connection_id_for_transport);
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

            flush_pending_output(&output_channel_clone, generation, &mut pending_output);
            let _ = channel.close().await;

            let mut sessions = sessions_for_exit.lock().await;
            if let Some(mut session) = sessions.remove(&term_id_for_exit) {
                PtyManager::finalize_session_after_natural_exit(&mut session.handle);
            }
        });

        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.get_mut(&term_id) {
            if let TerminalHandle::Remote { task_handle: session_task_handle, .. } = &mut session.handle {
                *session_task_handle = Some(task_handle);
            }
        }
        Ok(())
    }

    pub async fn navigate_to_path(&self, term_id: &str, path: &str) -> Result<()> {
        let cd_cmd = {
            let sessions = self.sessions.lock().await;
            let session = sessions
                .get(term_id)
                .ok_or_else(|| anyhow!("Session not found: {}", term_id))?;
            build_navigate_cd_command(path, session.navigate_shell)
        };
        self.write(term_id, &cd_cmd).await
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

    /// True when the local shell has child processes (foreground/background jobs).
    /// Remote sessions always return false — callers should use output-based busy detection.
    pub async fn has_active_child_processes(&self, term_id: &str) -> bool {
        let child_pid = {
            let sessions = self.sessions.lock().await;
            let Some(session) = sessions.get(term_id) else {
                // Missing session during start/teardown — treat as busy so idle suspend defers.
                return true;
            };

            match &session.handle {
                TerminalHandle::Local { child_pid, .. } => *child_pid,
                TerminalHandle::Remote { .. } => return false,
            }
        };

        let Some(pid) = child_pid else {
            return false;
        };
        process_tree_has_children(pid)
    }

    pub async fn close(&self, term_id: &str) -> Result<()> {
        let mut sessions = self.sessions.lock().await;
        if let Some(mut session) = sessions.remove(term_id) {
            Self::cleanup_session_handles(&mut session.handle);
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

        for id in ids_to_remove {
            if let Some(mut session) = sessions.remove(&id) {
                Self::cleanup_session_handles(&mut session.handle);
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{build_navigate_cd_command, posix_shell_cd_path, NavigateShellStyle};

    #[test]
    fn build_navigate_cd_command_uses_cmd_syntax_for_windows_cmd() {
        let cmd = build_navigate_cd_command(r"E:\work\data", NavigateShellStyle::WindowsCmd);
        assert!(cmd.contains("cd /d"));
        assert!(cmd.contains(r"E:\work\data"));
    }

    #[test]
    fn build_navigate_cd_command_uses_posix_tilde_quoting() {
        let cmd = build_navigate_cd_command("~/data", NavigateShellStyle::Posix);
        assert_eq!(cmd, "cd ~/'data'\r");
    }

    #[test]
    fn posix_shell_cd_path_leaves_tilde_unquoted() {
        assert_eq!(posix_shell_cd_path("~"), "~");
        assert_eq!(posix_shell_cd_path(" ~/ "), "~");
    }

    #[test]
    fn posix_shell_cd_path_quotes_suffix_after_tilde_slash() {
        assert_eq!(posix_shell_cd_path("~/data"), "~/'data'");
        assert_eq!(posix_shell_cd_path("~/my dir"), "~/'my dir'");
        assert_eq!(posix_shell_cd_path("~/it's"), "~/'it'\\''s'");
    }

    #[test]
    fn posix_shell_cd_path_quotes_absolute_paths() {
        assert_eq!(posix_shell_cd_path("/home/user"), "'/home/user'");
        assert_eq!(posix_shell_cd_path("/home/a b"), "'/home/a b'");
    }
}
