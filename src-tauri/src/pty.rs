use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use russh::client::Msg;
use russh::{Channel, ChannelMsg};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::Arc;
use tauri::ipc::{Channel as IpcChannel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex};
use tokio::time::Instant;

use crate::pty_output_flush::{
    encode_output_frame, record_flush_reason, FlushInstruction, FlushReason, OutputFlushPolicy,
};

enum LocalReaderEvent {
    Data(Vec<u8>),
    Finished { exit_code: Option<u32> },
}

fn remote_shell_login_flag(shell_override: &str) -> Option<&'static str> {
    let token = shell_override
        .split_whitespace()
        .next()
        .unwrap_or(shell_override);
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

    // Split off a Windows path before looking for arguments. Doing this in the
    // opposite order turns `C:\Program Files\...\pwsh.exe` into `C:\Program`.
    let path_tail = trimmed.rsplit(['\\', '/']).next().unwrap_or(trimmed);
    let base_name = path_tail
        .split_whitespace()
        .next()
        .unwrap_or(path_tail)
        .trim_matches(['"', '\''])
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
    if shell_override.contains(['\\', '/']) {
        return None;
    }
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

fn initial_remote_cd_command(path: &str, style: NavigateShellStyle) -> Option<String> {
    let path = path.trim();
    if path.is_empty() || matches!(path, "~" | "~/" | "~\\") {
        return None;
    }
    Some(build_navigate_cd_command(path, style))
}

fn terminal_auth_banner(banner: &str) -> Vec<u8> {
    let normalized = banner.replace("\r\n", "\n").replace('\r', "\n");
    let mut output = normalized.replace('\n', "\r\n");
    if !output.ends_with("\r\n") {
        output.push_str("\r\n");
    }
    output.into_bytes()
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

fn remote_shell_launch_command(shell: &str, remote_is_windows: bool) -> String {
    if remote_is_windows {
        remote_windows_shell_command(shell)
            .map(str::to_string)
            .unwrap_or_else(|| format!("\"{}\"", windows_double_quote(shell, true)))
    } else {
        let escaped_shell = shell_single_quote(shell);
        match remote_shell_login_flag(shell) {
            Some(login_flag) => format!("exec '{}' {}", escaped_shell, login_flag),
            None => format!("exec '{}'", escaped_shell),
        }
    }
}

fn deferred_remote_startup_input(
    remote_os: &str,
    detected_shell: Option<&str>,
    shell_override: Option<&str>,
    cwd: Option<&str>,
) -> (NavigateShellStyle, String) {
    let remote_is_windows = is_remote_windows(Some(remote_os));
    let selected_shell = shell_override
        .map(str::trim)
        .filter(|shell| !shell.is_empty() && !shell.eq_ignore_ascii_case("default"));
    let navigate_shell =
        remote_navigate_shell_style(remote_is_windows, selected_shell.or(detected_shell));

    let mut startup_input = String::new();
    if let Some(shell) = selected_shell {
        let launch_command = if remote_is_windows
            && detected_shell.is_some_and(|current| {
                matches!(
                    classify_windows_shell(current),
                    ShellKind::PowerShell | ShellKind::Pwsh
                )
            })
            && remote_windows_shell_command(shell).is_none()
        {
            format!("& '{}'", powershell_single_quote(shell))
        } else {
            remote_shell_launch_command(shell, remote_is_windows)
        };
        startup_input.push_str(&launch_command);
        startup_input.push('\r');
    }
    if let Some(cd_command) = cwd.and_then(|path| initial_remote_cd_command(path, navigate_shell)) {
        startup_input.push_str(&cd_command);
    }
    (navigate_shell, startup_input)
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

/// Flushes PTY bytes through the streaming IPC channel.
///
/// Frames are `generation` (u32 LE) + raw PTY bytes so the frontend can ignore
/// stale chunks after suspend/restart races. Layout must not change.
fn flush_output_frame(output_channel: &IpcChannel, generation: u32, bytes: Vec<u8>) {
    if bytes.is_empty() {
        return;
    }

    let frame = encode_output_frame(generation, &bytes);
    if let Err(e) = output_channel.send(InvokeResponseBody::Raw(frame)) {
        eprintln!("[PTY] Failed to send output on channel: {}", e);
    }
}

fn apply_flush_instruction(
    output_channel: &IpcChannel,
    generation: u32,
    instruction: FlushInstruction,
) {
    if let FlushInstruction::Flush {
        bytes,
        reason,
        rearm_burst: _,
    } = instruction
    {
        record_flush_reason(reason);
        flush_output_frame(output_channel, generation, bytes);
    }
}

fn flush_policy_tail(output_channel: &IpcChannel, generation: u32, policy: &mut OutputFlushPolicy) {
    let tail = policy.take_tail_on_close();
    if tail.is_empty() {
        return;
    }
    record_flush_reason(FlushReason::Close);
    flush_output_frame(output_channel, generation, tail);
}

fn process_tree_has_children(root_pid: u32) -> bool {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);
    let parent = Pid::from_u32(root_pid);
    system
        .processes()
        .values()
        .any(|process| process.parent() == Some(parent))
}

fn emit_terminal_exit(
    app_handle: &AppHandle,
    term_id: &str,
    generation: u32,
    exit_code: Option<u32>,
) {
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

/// How a russh `Channel::wait()` result should affect the remote PTY task.
/// EOF is not an end by itself (OpenSSH sends it before Close; a Wi-Fi drop
/// can send it before wait-None). Missing follow-up is `None` (channel gone).
#[derive(Debug, PartialEq, Eq)]
enum RemoteWaitAction {
    BufferOutput,
    PaneExit { exit_code: Option<u32> },
    TransportDrop,
    KeepWaiting,
}

fn remote_wait_action(msg: Option<&ChannelMsg>) -> RemoteWaitAction {
    match msg {
        Some(ChannelMsg::Data { .. } | ChannelMsg::ExtendedData { .. }) => {
            RemoteWaitAction::BufferOutput
        }
        Some(ChannelMsg::ExitStatus { exit_status }) => RemoteWaitAction::PaneExit {
            exit_code: Some(*exit_status),
        },
        Some(ChannelMsg::ExitSignal { .. } | ChannelMsg::Close) => {
            RemoteWaitAction::PaneExit { exit_code: None }
        }
        Some(ChannelMsg::Eof) => RemoteWaitAction::KeepWaiting,
        None => RemoteWaitAction::TransportDrop,
        Some(_) => RemoteWaitAction::KeepWaiting,
    }
}

fn buffer_remote_wait_output(
    msg: &ChannelMsg,
    policy: &mut OutputFlushPolicy,
    output_channel: &IpcChannel,
    generation: u32,
) {
    match msg {
        ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
            apply_flush_instruction(
                output_channel,
                generation,
                policy.on_bytes(data.as_ref(), Instant::now()),
            );
        }
        _ => {}
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
        input: Arc<RemoteInput>,
        resize_tx: mpsc::Sender<(u16, u16)>, // Send resize events
        task_handle: Option<tokio::task::JoinHandle<()>>,
    },
}

pub struct RemoteInput {
    tx: mpsc::Sender<Vec<u8>>,
    send_gate: Mutex<()>,
    user_input_started: AtomicBool,
    startup_pending: AtomicBool,
}

#[derive(Debug, PartialEq, Eq)]
enum DeferredStartupClaim {
    Apply,
    CancelledByInput,
    NotPending,
}

impl RemoteInput {
    fn new(tx: mpsc::Sender<Vec<u8>>, startup_pending: bool) -> Self {
        Self {
            tx,
            send_gate: Mutex::new(()),
            user_input_started: AtomicBool::new(false),
            startup_pending: AtomicBool::new(startup_pending),
        }
    }

    fn mark_user_input_started(&self) {
        self.user_input_started.store(true, Ordering::Release);
    }

    // Call while holding send_gate so claiming startup and sending it are one
    // ordered operation relative to normal terminal input.
    fn claim_deferred_startup(&self) -> DeferredStartupClaim {
        if !self.startup_pending.swap(false, Ordering::AcqRel) {
            return DeferredStartupClaim::NotPending;
        }
        if self.user_input_started.load(Ordering::Acquire) {
            DeferredStartupClaim::CancelledByInput
        } else {
            DeferredStartupClaim::Apply
        }
    }
}

pub struct PtySession {
    pub connection_id: String,
    generation: u32,
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
        let (shell, mut args, is_wsl_shell): (String, Vec<String>, bool) =
            if cfg!(target_os = "windows") {
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
                        (
                            bash_path,
                            vec!["--login".to_string(), "-i".to_string()],
                            false,
                        )
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
                    .unwrap_or_else(|| {
                        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
                    });
                (path, vec![], false)
            };

        // WSL should open in Linux context. If we have a Linux cwd, pass it via `--cd`.
        // Otherwise force distro home (`~`) instead of inheriting host Windows cwd.
        if is_wsl_shell {
            let provided_cwd = cwd.as_deref().map(str::trim);
            let linux_cwd = provided_cwd.filter(|path| !path.is_empty() && path.starts_with('/'));
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
        crate::pty_term_env::apply_local_pty_term_env(&mut cmd, env!("CARGO_PKG_VERSION"));

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

        let navigate_shell =
            local_navigate_shell_style(shell_override.as_deref(), is_wsl_shell, &shell);
        let session = PtySession {
            connection_id,
            generation,
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
                        let _ =
                            output_tx.blocking_send(LocalReaderEvent::Finished { exit_code: None });
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
                        let _ =
                            output_tx.blocking_send(LocalReaderEvent::Finished { exit_code: None });
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
            let mut policy = OutputFlushPolicy::new();

            loop {
                let deadline = policy.deadline();
                tokio::select! {
                    event = output_rx.recv() => {
                        match event {
                            Some(LocalReaderEvent::Data(chunk)) => {
                                apply_flush_instruction(
                                    &output_channel_clone,
                                    generation,
                                    policy.on_bytes(&chunk, Instant::now()),
                                );
                            }
                            Some(LocalReaderEvent::Finished { exit_code }) => {
                                flush_policy_tail(&output_channel_clone, generation, &mut policy);
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
                            None => {
                                flush_policy_tail(&output_channel_clone, generation, &mut policy);
                                break;
                            }
                        }
                    }

                    _ = async {
                        if let Some(d) = deadline {
                            tokio::time::sleep_until(d).await;
                        }
                    }, if deadline.is_some() => {
                        apply_flush_instruction(
                            &output_channel_clone,
                            generation,
                            policy.on_timer(Instant::now()),
                        );
                    }
                }
            }
        });

        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.get_mut(&term_id) {
            if let TerminalHandle::Local {
                reader_handle: session_reader_handle,
                ..
            } = &mut session.handle
            {
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
        detected_shell: Option<String>,
        cwd: Option<String>,
        auth_banner: Option<String>,
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

        let remote_os_known = remote_os.is_some();
        let remote_is_windows = is_remote_windows(remote_os.as_deref());
        let requested_shell = shell_override
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("default"));
        // On a first connection the OS hint may not exist yet because probes
        // intentionally run after the terminal claims the MOTD-bearing channel.
        // Use the server's default shell until the hint is known rather than
        // risking POSIX `exec` syntax on Windows OpenSSH.
        let selected_shell = requested_shell.filter(|_| remote_os_known);

        if let Some(shell) = selected_shell {
            // Start explicit remote shell (path or command name) when user selected one.
            // Unix hosts use `exec` to replace the current command process with the chosen shell.
            // Windows OpenSSH hosts need native shell executables instead of POSIX `exec`.
            let launch = remote_shell_launch_command(shell, remote_is_windows);
            // Important: `exec` and `request_shell` are different channel request
            // types. If `exec` fails, callers must open a fresh channel before retrying.
            channel.exec(false, launch).await.map_err(|e| {
                anyhow!("Failed to launch selected remote shell '{}': {}", shell, e)
            })?;
        } else {
            // Default remote login shell.
            channel
                .request_shell(false)
                .await
                .map_err(|e| anyhow!("Failed to request shell: {}", e))?;
        }

        let navigate_shell = remote_navigate_shell_style(
            remote_is_windows,
            selected_shell.or(detected_shell.as_deref()),
        );

        // If cwd is provided, navigate without clearing the shell output. The
        // server's login banner and MOTD are useful connection context.
        if let Some(cd_cmd) = remote_os_known
            .then_some(cwd.as_deref())
            .flatten()
            .and_then(|path| initial_remote_cd_command(path, navigate_shell))
        {
            channel
                .data(cd_cmd.as_bytes())
                .await
                .map_err(|e| anyhow!("Failed to send initial cd command: {}", e))?;
        }

        // Create channels for communication
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(32);
        let (resize_tx, mut resize_rx) = mpsc::channel::<(u16, u16)>(4);

        let connection_id_for_transport = connection_id.clone();
        let session = PtySession {
            connection_id,
            generation,
            output_channel: output_channel.clone(),
            handle: TerminalHandle::Remote {
                input: Arc::new(RemoteInput::new(tx, !remote_os_known)),
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

        if let Some(banner) = auth_banner {
            flush_output_frame(&output_channel, generation, terminal_auth_banner(&banner));
        }

        let term_id_clone = term_id.clone();
        let app_handle_clone = app_handle.clone();
        let output_channel_clone = output_channel.clone();
        let sessions_for_exit = self.sessions.clone();
        let term_id_for_exit = term_id.clone();

        // Spawn the manager task only after ready has been published so same-generation
        // output/exit events can never arrive before the frontend has seen ready.
        let task_handle = tokio::task::spawn(async move {
            let app_handle = app_handle_clone;
            let mut policy = OutputFlushPolicy::new();
            let drop_transport;
            let exit_code;

            loop {
                let deadline = policy.deadline();
                tokio::select! {
                    msg = channel.wait() => {
                        match remote_wait_action(msg.as_ref()) {
                            RemoteWaitAction::BufferOutput => {
                                if let Some(ref msg) = msg {
                                    buffer_remote_wait_output(
                                        msg,
                                        &mut policy,
                                        &output_channel_clone,
                                        generation,
                                    );
                                }
                            }
                            RemoteWaitAction::PaneExit { exit_code: code } => {
                                flush_policy_tail(&output_channel_clone, generation, &mut policy);
                                drop_transport = false;
                                exit_code = Some(code);
                                break;
                            }
                            RemoteWaitAction::TransportDrop => {
                                flush_policy_tail(&output_channel_clone, generation, &mut policy);
                                exit_code = Some(None);
                                drop_transport = true;
                                break;
                            }
                            // EOF: keep waiting for Close / ExitStatus (pane) or None (host drop).
                            RemoteWaitAction::KeepWaiting => {}
                        }
                    }

                    _ = async {
                        if let Some(d) = deadline {
                            tokio::time::sleep_until(d).await;
                        }
                    }, if deadline.is_some() => {
                        apply_flush_instruction(
                            &output_channel_clone,
                            generation,
                            policy.on_timer(Instant::now()),
                        );
                    }

                    Some(input) = rx.recv() => {
                        if let Err(e) = channel.data(&input[..]).await {
                             eprintln!("[PTY] Failed to send data to channel: {}", e);
                             exit_code = Some(None);
                             drop_transport = true;
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

            flush_policy_tail(&output_channel_clone, generation, &mut policy);
            let _ = channel.close().await;

            let mut sessions = sessions_for_exit.lock().await;
            if let Some(mut session) = sessions.remove(&term_id_for_exit) {
                PtyManager::finalize_session_after_natural_exit(&mut session.handle);
            }
            drop(sessions);
            if drop_transport {
                // Host is gone: suspend every pane. Never emit terminal-exit
                // (that would look like the user typed `exit` in this pane).
                emit_connection_transport_lost(&app_handle, &connection_id_for_transport);
            } else if let Some(code) = exit_code {
                emit_terminal_exit(&app_handle, &term_id_clone, generation, code);
            }
        });

        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.get_mut(&term_id) {
            if let TerminalHandle::Remote {
                task_handle: session_task_handle,
                ..
            } = &mut session.handle
            {
                *session_task_handle = Some(task_handle);
            }
        }
        Ok(())
    }

    /// Completes first-connect startup once deferred OS detection finishes.
    /// Returns false when the terminal was closed or replaced meanwhile.
    pub async fn finalize_remote_startup(
        &self,
        term_id: &str,
        generation: u32,
        remote_os: &str,
        detected_shell: Option<&str>,
        shell_override: Option<&str>,
        cwd: Option<&str>,
    ) -> Result<bool> {
        let (navigate_shell, startup_input) =
            deferred_remote_startup_input(remote_os, detected_shell, shell_override, cwd);
        let default_navigate_shell =
            remote_navigate_shell_style(is_remote_windows(Some(remote_os)), detected_shell);

        let input = {
            let sessions = self.sessions.lock().await;
            let Some(session) = sessions.get(term_id) else {
                return Ok(false);
            };
            if session.generation != generation {
                return Ok(false);
            }
            match &session.handle {
                TerminalHandle::Remote { input, .. } => input.clone(),
                TerminalHandle::Local { .. } => return Ok(false),
            }
        };

        let _send_guard = input.send_gate.lock().await;
        let startup_claim = input.claim_deferred_startup();
        if startup_claim == DeferredStartupClaim::NotPending {
            return Ok(false);
        }
        let apply_startup = startup_claim == DeferredStartupClaim::Apply;

        {
            let mut sessions = self.sessions.lock().await;
            let Some(session) = sessions.get_mut(term_id) else {
                return Ok(false);
            };
            if session.generation != generation {
                return Ok(false);
            }
            session.navigate_shell = if apply_startup {
                navigate_shell
            } else {
                default_navigate_shell
            };
        }

        if !apply_startup {
            return Ok(false);
        }

        if !startup_input.is_empty() {
            input
                .tx
                .send(startup_input.into_bytes())
                .await
                .map_err(|error| anyhow!("Failed to finish remote terminal startup: {error}"))?;
        }
        Ok(true)
    }

    pub async fn navigate_to_path(&self, term_id: &str, path: &str) -> Result<()> {
        let remote_input = {
            let sessions = self.sessions.lock().await;
            let session = sessions
                .get(term_id)
                .ok_or_else(|| anyhow!("Session not found: {}", term_id))?;
            match &session.handle {
                TerminalHandle::Remote { input, .. } => Some(input.clone()),
                TerminalHandle::Local { .. } => None,
            }
        };

        let Some(input) = remote_input else {
            let cd_cmd = {
                let sessions = self.sessions.lock().await;
                let session = sessions
                    .get(term_id)
                    .ok_or_else(|| anyhow!("Session not found: {}", term_id))?;
                build_navigate_cd_command(path, session.navigate_shell)
            };
            return self.write(term_id, &cd_cmd).await;
        };

        // Navigation is terminal input too. Mark it before waiting so a pending
        // startup cannot be injected ahead of a command built for the old shell.
        input.mark_user_input_started();
        let _send_guard = input.send_gate.lock().await;
        let cd_cmd = {
            let sessions = self.sessions.lock().await;
            let session = sessions
                .get(term_id)
                .ok_or_else(|| anyhow!("Session not found: {}", term_id))?;
            match &session.handle {
                TerminalHandle::Remote {
                    input: current_input,
                    ..
                } if Arc::ptr_eq(current_input, &input) => {
                    build_navigate_cd_command(path, session.navigate_shell)
                }
                _ => return Err(anyhow!("Terminal session changed while navigating")),
            }
        };
        input
            .tx
            .send(cd_cmd.into_bytes())
            .await
            .map_err(|e| anyhow!("Failed to send navigation to SSH task: {}", e))
    }

    pub async fn write(&self, term_id: &str, data: &str) -> Result<()> {
        let (local_writer_opt, remote_input_opt) = {
            let sessions = self.sessions.lock().await;
            let session = sessions
                .get(term_id)
                .ok_or_else(|| anyhow!("Session not found: {}", term_id))?;

            match &session.handle {
                TerminalHandle::Local { writer, .. } => (Some(writer.clone()), None),
                TerminalHandle::Remote { input, .. } => (None, Some(input.clone())),
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
        } else if let Some(input) = remote_input_opt {
            // Mark interaction before waiting for the send gate. Deferred
            // startup will either finish first or observe this and stand down.
            input.mark_user_input_started();
            let _send_guard = input.send_gate.lock().await;
            input
                .tx
                .send(data.as_bytes().to_vec())
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
                TerminalHandle::Remote { resize_tx, .. } => Some(resize_tx.clone()),
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
    use super::{
        build_navigate_cd_command, deferred_remote_startup_input, initial_remote_cd_command,
        posix_shell_cd_path, remote_navigate_shell_style, remote_wait_action, terminal_auth_banner,
        DeferredStartupClaim, NavigateShellStyle, RemoteInput, RemoteWaitAction,
    };
    use russh::ChannelMsg;

    #[test]
    fn remote_wait_eof_is_not_pane_exit_or_host_drop() {
        assert_eq!(
            remote_wait_action(Some(&ChannelMsg::Eof)),
            RemoteWaitAction::KeepWaiting
        );
    }

    #[test]
    fn remote_wait_close_and_exit_status_are_pane_local() {
        assert_eq!(
            remote_wait_action(Some(&ChannelMsg::Close)),
            RemoteWaitAction::PaneExit { exit_code: None }
        );
        assert_eq!(
            remote_wait_action(Some(&ChannelMsg::ExitStatus { exit_status: 0 })),
            RemoteWaitAction::PaneExit { exit_code: Some(0) }
        );
    }

    #[test]
    fn remote_wait_none_is_transport_drop() {
        assert_eq!(remote_wait_action(None), RemoteWaitAction::TransportDrop);
    }

    #[test]
    fn remote_wait_missing_follow_up_after_eof_is_wait_none() {
        // russh 0.46: after CHANNEL_EOF, wait() still yields Close / ExitStatus,
        // or None when the channel receiver is dropped (host gone). EOF itself
        // must not end the pane; None is the missing-follow-up fallback.
        assert_eq!(
            remote_wait_action(Some(&ChannelMsg::Eof)),
            RemoteWaitAction::KeepWaiting
        );
        assert_eq!(remote_wait_action(None), RemoteWaitAction::TransportDrop);
    }

    #[test]
    fn build_navigate_cd_command_uses_cmd_syntax_for_windows_cmd() {
        let cmd = build_navigate_cd_command(r"E:\work\data", NavigateShellStyle::WindowsCmd);
        assert!(cmd.contains("cd /d"));
        assert!(cmd.contains(r"E:\work\data"));
        assert!(!cmd.to_ascii_lowercase().contains("cls"));
    }

    #[test]
    fn build_navigate_cd_command_uses_posix_tilde_quoting() {
        let cmd = build_navigate_cd_command("~/data", NavigateShellStyle::Posix);
        assert_eq!(cmd, "cd ~/'data'\r");
        assert!(!cmd.contains("clear"));
    }

    #[test]
    fn build_navigate_cd_command_preserves_login_output_at_home() {
        assert_eq!(
            build_navigate_cd_command("~", NavigateShellStyle::Posix),
            "cd ~\r"
        );
        assert_eq!(
            build_navigate_cd_command(r"E:\work\data", NavigateShellStyle::WindowsPowerShell),
            "Set-Location -LiteralPath 'E:\\work\\data'\r"
        );
    }

    #[test]
    fn initial_remote_navigation_skips_home_and_keeps_other_paths() {
        assert_eq!(
            initial_remote_cd_command("~", NavigateShellStyle::Posix),
            None
        );
        assert_eq!(
            initial_remote_cd_command("~/", NavigateShellStyle::Posix),
            None
        );
        assert_eq!(
            initial_remote_cd_command("~\\", NavigateShellStyle::WindowsPowerShell),
            None
        );
        assert_eq!(
            initial_remote_cd_command("  ", NavigateShellStyle::Posix),
            None
        );
        assert_eq!(
            initial_remote_cd_command("~/work", NavigateShellStyle::Posix).as_deref(),
            Some("cd ~/'work'\r")
        );
    }

    #[test]
    fn deferred_startup_applies_posix_shell_then_cwd() {
        let (style, input) =
            deferred_remote_startup_input("ubuntu", Some("bash"), Some("zsh"), Some("/srv/app"));
        assert_eq!(style, NavigateShellStyle::Posix);
        assert_eq!(input, "exec 'zsh' -l\rcd '/srv/app'\r");
    }

    #[test]
    fn deferred_startup_uses_windows_navigation_for_requested_shell() {
        let (style, input) = deferred_remote_startup_input(
            "windows",
            Some("powershell"),
            Some("pwsh"),
            Some(r"E:\work\app"),
        );
        assert_eq!(style, NavigateShellStyle::WindowsPowerShell);
        assert!(input.starts_with("pwsh.exe -NoLogo\r"));
        assert!(input.ends_with("Set-Location -LiteralPath 'E:\\work\\app'\r"));
    }

    #[test]
    fn deferred_startup_uses_detected_powershell_default() {
        let (style, input) = deferred_remote_startup_input(
            "windows",
            Some("powershell"),
            None,
            Some(r"E:\work\app"),
        );
        assert_eq!(style, NavigateShellStyle::WindowsPowerShell);
        assert_eq!(input, "Set-Location -LiteralPath 'E:\\work\\app'\r");
    }

    #[test]
    fn deferred_startup_uses_cmd_cross_drive_navigation_for_default_cmd() {
        let (style, input) =
            deferred_remote_startup_input("windows", Some("cmd.exe"), None, Some(r"E:\work\app"));
        assert_eq!(style, NavigateShellStyle::WindowsCmd);
        assert_eq!(input, "cd /d \"E:\\work\\app\"\r");
    }

    #[test]
    fn full_windows_shell_path_selects_powershell_navigation() {
        let full_path = r"C:\Program Files\PowerShell\7\pwsh.exe";
        assert_eq!(
            remote_navigate_shell_style(true, Some(full_path)),
            NavigateShellStyle::WindowsPowerShell
        );

        let (detected_style, detected_input) =
            deferred_remote_startup_input("windows", Some(full_path), None, Some(r"E:\work\app"));
        assert_eq!(detected_style, NavigateShellStyle::WindowsPowerShell);
        assert_eq!(
            detected_input,
            "Set-Location -LiteralPath 'E:\\work\\app'\r"
        );

        let (selected_style, selected_input) = deferred_remote_startup_input(
            "windows",
            Some("cmd.exe"),
            Some(full_path),
            Some(r"E:\work\app"),
        );
        assert_eq!(selected_style, NavigateShellStyle::WindowsPowerShell);
        assert!(selected_input.starts_with("\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\"\r"));
        assert!(selected_input.ends_with("Set-Location -LiteralPath 'E:\\work\\app'\r"));
    }

    #[test]
    fn deferred_startup_uses_powershell_call_operator_for_custom_shell_path() {
        let (style, input) = deferred_remote_startup_input(
            "windows",
            Some("powershell"),
            Some(r"C:\Tools\Custom Shell\shell.exe"),
            None,
        );
        assert_eq!(style, NavigateShellStyle::WindowsOther);
        assert_eq!(input, "& 'C:\\Tools\\Custom Shell\\shell.exe'\r");
    }

    #[test]
    fn user_input_cancels_deferred_startup() {
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let input = RemoteInput::new(tx, true);

        input.mark_user_input_started();

        assert_eq!(
            input.claim_deferred_startup(),
            DeferredStartupClaim::CancelledByInput
        );
        assert_eq!(
            input.claim_deferred_startup(),
            DeferredStartupClaim::NotPending
        );
    }

    #[test]
    fn authentication_banner_keeps_lines_before_shell_output() {
        assert_eq!(
            terminal_auth_banner("Authorized users only\nWelcome"),
            b"Authorized users only\r\nWelcome\r\n"
        );
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
