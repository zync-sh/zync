use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use russh::client::Msg;
use russh::{Channel, ChannelMsg};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard};
use tauri::ipc::Channel as IpcChannel;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex};
use tokio::time::Instant;

use crate::pty_output::{OutputCursor, PtyOutput};
use crate::pty_output_flush::{
    record_flush_reason, FlushInstruction, FlushReason, OutputFlushPolicy,
};
use tokio::io::AsyncWriteExt;

// Shared protocol packet size with inputPipeline.ts; queue slots bound remote buffered bytes.
pub(crate) const TERMINAL_INPUT_CHUNK_BYTES: usize = 16 * 1024;
const REMOTE_INPUT_QUEUE_CHUNKS: usize = 32;
const REMOTE_RESIZE_QUEUE_REQUESTS: usize = 4;

/// A size belongs to one installed SSH channel and completes only after sender admission.
pub struct RemoteResize {
    cols: u16,
    rows: u16,
    reply: tokio::sync::oneshot::Sender<std::result::Result<(), String>>,
}

/// Keeps stalled control writes off the reader task and wakes callers on failure or cancellation.
async fn run_remote_resizes<F, Fut>(
    mut requests: mpsc::Receiver<RemoteResize>,
    mut apply: F,
) -> std::io::Result<()>
where
    F: FnMut(u16, u16) -> Fut,
    Fut: std::future::Future<Output = std::io::Result<()>>,
{
    while let Some(request) = requests.recv().await {
        match apply(request.cols, request.rows).await {
            Ok(()) => {
                let _ = request.reply.send(Ok(()));
            }
            Err(error) => {
                let _ = request.reply.send(Err(error.to_string()));
                return Err(error);
            }
        }
    }
    Ok(())
}

enum LocalReaderEvent {
    Data(Vec<u8>),
    /// Reader EOF is distinct from child exit: the pipe may still contain tail bytes.
    Eof,
    /// An OS read failure cannot be treated as a successfully drained stream.
    Failed,
}

/// Shared local pipe writer, serialized across blocking operations.
type LocalWriter = Arc<Mutex<Box<dyn Write + Send>>>;
/// The control handle can close on child exit before the output pipe reaches EOF.
type LocalMaster = Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>;

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
    channel_id: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<u32>,
}

/// Turn a batching decision into cancellation-safe pending delivery.
fn apply_flush_instruction(instruction: FlushInstruction) -> OutputCursor {
    if let FlushInstruction::Flush {
        bytes,
        reason,
        rearm_burst: _,
    } = instruction
    {
        record_flush_reason(reason);
        OutputCursor::new(bytes)
    } else {
        OutputCursor::default()
    }
}

/// Drain batching state at EOF without confusing IPC dispatch with parser completion.
fn flush_policy_tail(policy: &mut OutputFlushPolicy) -> OutputCursor {
    let tail = policy.take_tail_on_close();
    if tail.is_empty() {
        return OutputCursor::default();
    }
    record_flush_reason(FlushReason::Close);
    OutputCursor::new(tail)
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

/// Publish completion for the exact channel, including fatal output shutdown.
fn emit_terminal_exit(
    app_handle: &AppHandle,
    term_id: &str,
    generation: u32,
    channel_id: u32,
    exit_code: Option<u32>,
) {
    if let Err(e) = app_handle.emit(
        &format!("terminal-exit-{}", term_id),
        TerminalLifecycleEvent {
            generation,
            channel_id,
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
    RecordExit { exit_code: Option<u32> },
    PaneExit { exit_code: Option<u32> },
    TransportDrop,
    KeepWaiting,
}

/// Exit status is advisory until close: servers may still send trailing bytes.
fn remote_wait_action(msg: Option<&ChannelMsg>) -> RemoteWaitAction {
    match msg {
        Some(ChannelMsg::Data { .. } | ChannelMsg::ExtendedData { .. }) => {
            RemoteWaitAction::BufferOutput
        }
        Some(ChannelMsg::ExitStatus { exit_status }) => RemoteWaitAction::RecordExit {
            exit_code: Some(*exit_status),
        },
        Some(ChannelMsg::ExitSignal { .. }) => RemoteWaitAction::RecordExit { exit_code: None },
        Some(ChannelMsg::Close) => RemoteWaitAction::PaneExit { exit_code: None },
        Some(ChannelMsg::Eof) => RemoteWaitAction::KeepWaiting,
        None => RemoteWaitAction::TransportDrop,
        Some(_) => RemoteWaitAction::KeepWaiting,
    }
}

/// Classify receive exhaustion using any exit evidence drained before wait returned None.
/// A recorded signal exit (`Some(None)`) is still pane-local, without a numeric status.
fn remote_io_completion(recorded_exit: Option<Option<u32>>) -> (bool, Option<Option<u32>>) {
    (recorded_exit.is_none(), Some(recorded_exit.flatten()))
}

/// Preserve stdout/stderr packet order through the common batching policy.
fn buffer_remote_wait_output(msg: &ChannelMsg, policy: &mut OutputFlushPolicy) -> OutputCursor {
    match msg {
        ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
            apply_flush_instruction(policy.on_bytes(data.as_ref(), Instant::now()))
        }
        _ => OutputCursor::default(),
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
        writer: LocalWriter,
        reader_handle: Option<tokio::task::JoinHandle<()>>,
        /// Handle for the PowerShell prompt-injection task.
        /// Aborted on session close so it can't write to a dead PTY.
        inject_handle: Option<tokio::task::JoinHandle<()>>,
        master: LocalMaster,
        child_killer: Box<dyn ChildKiller + Send + Sync>,
        child_pid: Option<u32>,
    },
    Remote {
        input: Arc<RemoteInput>,
        resize_tx: mpsc::Sender<RemoteResize>,
        task_handle: Option<tokio::task::JoinHandle<()>>,
    },
}

pub struct RemoteInput {
    tx: mpsc::Sender<Vec<u8>>,
    send_gate: Mutex<()>,
    user_input_started: AtomicBool,
    startup_pending: AtomicBool,
    admitted_bytes: AtomicU64,
    write_progress: tokio::sync::watch::Sender<(u64, bool)>,
}

/// Aborted/unpolled readers and failed writers must release acknowledged-input waiters.
struct RemoteInputLifetime(Arc<RemoteInput>);

impl Drop for RemoteInputLifetime {
    /// Marks this exact input stream stopped without touching a replacement PTY.
    fn drop(&mut self) {
        self.0.stop();
    }
}

#[derive(Debug, PartialEq, Eq)]
enum DeferredStartupClaim {
    Apply,
    CancelledByInput,
    NotPending,
}

impl RemoteInput {
    /// Reserves bounded queue admission before allocating a packet; callers hold the send gate.
    async fn send_bytes(&self, data: &[u8]) -> std::result::Result<(), mpsc::error::SendError<()>> {
        for bytes in data.chunks(TERMINAL_INPUT_CHUNK_BYTES) {
            if self.write_progress.borrow().1 {
                return Err(mpsc::error::SendError(()));
            }
            let permit = self.tx.reserve().await?;
            if self.write_progress.borrow().1 {
                return Err(mpsc::error::SendError(()));
            }
            self.admitted_bytes
                .fetch_add(bytes.len() as u64, Ordering::Release);
            permit.send(bytes.to_vec());
        }
        Ok(())
    }

    /// Initializes ordered admission and completion tracking for one remote input stream.
    fn new(tx: mpsc::Sender<Vec<u8>>, startup_pending: bool) -> Self {
        Self {
            tx,
            send_gate: Mutex::new(()),
            user_input_started: AtomicBool::new(false),
            startup_pending: AtomicBool::new(startup_pending),
            admitted_bytes: AtomicU64::new(0),
            write_progress: tokio::sync::watch::channel((0, false)).0,
        }
    }

    /// Advances acknowledgments only after write_all completes on the SSH channel writer.
    fn record_written(&self, bytes: usize) {
        self.write_progress.send_modify(|(written, stopped)| {
            if !*stopped {
                *written += bytes as u64;
            }
        });
    }

    /// Wakes pending delivery on close/error; stopped streams cannot become writable again.
    fn stop(&self) {
        self.write_progress
            .send_modify(|(_, stopped)| *stopped = true);
    }

    /// Waits for this ordered write's completion without retaining another packet copy.
    async fn wait_written(&self, target: u64) -> Result<()> {
        let mut progress = self.write_progress.subscribe();
        loop {
            let (written, stopped) = *progress.borrow_and_update();
            if written >= target {
                return Ok(());
            }
            if stopped {
                return Err(anyhow!("Remote terminal input stream closed"));
            }
            progress
                .changed()
                .await
                .map_err(|_| anyhow!("Remote terminal input stream closed"))?;
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
    /// Held for the session lifetime so the frontend channel stays open until close.
    #[allow(dead_code)]
    pub output_channel: IpcChannel,
    output: Arc<PtyOutput>,
    pub handle: TerminalHandle,
    navigate_shell: NavigateShellStyle,
}

pub struct PtyManager {
    state: Arc<StdMutex<PtyState>>,
}

/// Pending and installed owners share one lock so close cannot miss a creator.
#[derive(Default)]
struct PtyState {
    sessions: HashMap<String, PtySession>,
    pending: HashMap<String, PendingCreation>,
}

struct PendingCreation {
    connection_id: String,
    owner: Arc<()>,
}

/// Reserve startup order before any asynchronous transport work. Dropping an
/// unfinished creator releases only its own reservation, never a replacement.
pub struct PtyCreation {
    state: Arc<StdMutex<PtyState>>,
    term_id: String,
    connection_id: String,
    owner: Arc<()>,
}

/// State guards cover only map operations, never platform I/O or an await.
fn lock_pty_state(state: &StdMutex<PtyState>) -> MutexGuard<'_, PtyState> {
    state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl PtyCreation {
    /// Publish only the latest reserved owner; stale resources stay with the
    /// caller so the existing detached cleanup path can release them safely.
    fn install(&self, session: PtySession) -> std::result::Result<(), PtySession> {
        let mut state = lock_pty_state(&self.state);
        if state.pending.get(&self.term_id).is_some_and(|pending| {
            Arc::ptr_eq(&pending.owner, &self.owner)
                && pending.connection_id == session.connection_id
        }) {
            state.pending.remove(&self.term_id);
            state.sessions.insert(self.term_id.clone(), session);
            Ok(())
        } else {
            Err(session)
        }
    }
}

impl Drop for PtyCreation {
    /// Cancel only this exact unfinished startup, including same-generation reloads.
    fn drop(&mut self) {
        let mut state = lock_pty_state(&self.state);
        if state
            .pending
            .get(&self.term_id)
            .is_some_and(|pending| Arc::ptr_eq(&pending.owner, &self.owner))
        {
            state.pending.remove(&self.term_id);
        }
    }
}

impl PtyManager {
    /// Start with no running or pending terminal owners.
    pub fn new() -> Self {
        Self {
            state: Arc::new(StdMutex::new(PtyState::default())),
        }
    }

    /// Reserve command arrival order before opening SSH or spawning a child.
    /// Superseded sessions are detached atomically and cleaned outside the lock.
    pub async fn begin_creation(&self, term_id: &str, connection_id: &str) -> Result<PtyCreation> {
        let creation = PtyCreation {
            state: self.state.clone(),
            term_id: term_id.to_string(),
            connection_id: connection_id.to_string(),
            owner: Arc::new(()),
        };
        let previous = {
            let mut state = lock_pty_state(&self.state);
            state.pending.insert(
                term_id.to_string(),
                PendingCreation {
                    connection_id: connection_id.to_string(),
                    owner: creation.owner.clone(),
                },
            );
            state.sessions.remove(term_id)
        };
        if let Some(session) = previous {
            Self::close_sessions(vec![session]).await?;
        }
        Ok(creation)
    }

    /// Reject superseded startup without dropping child/channel resources on
    /// the async executor or replacing the terminal that won the reservation.
    async fn install_created_session(
        &self,
        creation: &PtyCreation,
        session: PtySession,
    ) -> Result<()> {
        if let Err(session) = creation.install(session) {
            Self::close_sessions(vec![session]).await?;
            return Err(anyhow!("Terminal owner changed during startup"));
        }
        Ok(())
    }

    /// Stop async delivery immediately without performing platform-blocking I/O.
    fn stop_session_tasks(handle: &mut TerminalHandle) {
        match handle {
            TerminalHandle::Local {
                reader_handle,
                inject_handle,
                ..
            } => {
                if let Some(task) = inject_handle.take() {
                    task.abort();
                }
                if let Some(task) = reader_handle.take() {
                    task.abort();
                }
            }
            TerminalHandle::Remote {
                input, task_handle, ..
            } => {
                input.stop();
                if let Some(task) = task_handle.take() {
                    task.abort();
                }
            }
        }
    }

    /// Release one detached session's platform handles on a blocking worker.
    fn cleanup_session_handles(handle: &mut TerminalHandle) {
        Self::stop_session_tasks(handle);
        if let TerminalHandle::Local { child_killer, .. } = handle {
            let _ = child_killer.kill();
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

    /// Create an ordinary local shell with bounded output and independent input.
    pub async fn create_local_session(
        &self,
        creation: PtyCreation,
        generation: u32,
        cols: u16,
        rows: u16,
        app_handle: AppHandle,
        output_channel: IpcChannel,
        shell_override: Option<String>,
        cwd: Option<String>,
    ) -> Result<()> {
        let term_id = creation.term_id.clone();
        let connection_id = creation.connection_id.clone();
        let channel_id = output_channel.id();

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

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| anyhow!("Failed to spawn shell: {}", e))?;
        // The slave shares ConPTY's control handle; only the master should own
        // that handle once the child exists, so its exit can release pipe EOF.
        drop(pair.slave);
        let reader = pair
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
        let master = Arc::new(Mutex::new(Some(pair.master)));
        let output = Arc::new(PtyOutput::new(output_channel.clone(), generation));
        let mut session = PtySession {
            connection_id,
            output_channel: output_channel.clone(),
            output: output.clone(),
            handle: TerminalHandle::Local {
                writer: writer_arc,
                reader_handle: None,
                inject_handle,
                master: master.clone(),
                child_killer,
                child_pid,
            },
            navigate_shell,
        };

        // Gate async delivery until ready, but let the OS reader drain at once.
        // If startup loses ownership, abort drops its bounded receiver so the
        // dedicated reader switches to discard/drain before ConPTY closes.
        let term_id_clone = term_id.clone();
        let app_handle_clone = app_handle.clone();
        let (reader_start_tx, reader_start_rx) = tokio::sync::oneshot::channel();
        let (output_tx, output_rx) = tokio::sync::mpsc::channel::<LocalReaderEvent>(64);
        let (child_exit_tx, child_exit_rx) = tokio::sync::oneshot::channel();

        tokio::task::spawn_blocking(move || {
            wait_for_local_child(child, master, child_exit_tx);
        });

        tokio::task::spawn_blocking(move || {
            read_local_output(reader, output_tx);
        });

        let state_for_exit = self.state.clone();
        let term_id_for_exit = term_id.clone();

        let reader_handle = tokio::spawn(async move {
            if reader_start_rx.await.is_err() {
                return;
            }
            let result = forward_local_output(output_rx, &output, child_exit_rx).await;
            let exit_code = match result {
                Ok(code) => code,
                Err(error) => {
                    eprintln!("[PTY] Local output stopped: {}", error);
                    None
                }
            };
            if PtyManager::finish_session(
                &state_for_exit,
                &term_id_for_exit,
                generation,
                channel_id,
            )
            .await
            {
                emit_terminal_exit(
                    &app_handle_clone,
                    &term_id_clone,
                    generation,
                    channel_id,
                    exit_code,
                );
            }
        });

        if let TerminalHandle::Local {
            reader_handle: slot,
            ..
        } = &mut session.handle
        {
            *slot = Some(reader_handle);
        }
        self.install_created_session(&creation, session).await?;

        // Notify frontend that terminal is ready for input only after the
        // session has a live reader handle wired for cleanup.
        let _ = app_handle.emit(
            &format!("terminal-ready-{}", term_id),
            TerminalLifecycleEvent {
                generation,
                channel_id,
                exit_code: None,
            },
        );
        let _ = reader_start_tx.send(());

        Ok(())
    }

    /// Bind an SSH PTY to parser-credit output without blocking control traffic.
    pub async fn create_remote_session(
        &self,
        creation: PtyCreation,
        generation: u32,
        channel: Channel<Msg>,
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
        let term_id = creation.term_id.clone();
        let connection_id = creation.connection_id.clone();
        let channel_id = output_channel.id();

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
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(REMOTE_INPUT_QUEUE_CHUNKS);
        let (resize_tx, resize_rx) = mpsc::channel(REMOTE_RESIZE_QUEUE_REQUESTS);

        let connection_id_for_transport = connection_id.clone();
        let output = Arc::new(PtyOutput::new(output_channel.clone(), generation));
        let input = Arc::new(RemoteInput::new(tx, !remote_os_known));
        let mut session = PtySession {
            connection_id,
            output_channel: output_channel.clone(),
            output: output.clone(),
            handle: TerminalHandle::Remote {
                input: input.clone(),
                resize_tx,
                task_handle: None,
            },
            navigate_shell,
        };

        let term_id_clone = term_id.clone();
        let app_handle_clone = app_handle.clone();
        let input_writer = channel.make_writer();
        let (mut channel, channel_writer) = channel.split();
        let channel_writer = Arc::new(channel_writer);
        let state_for_exit = self.state.clone();
        let term_id_for_exit = term_id.clone();
        let (reader_start_tx, reader_start_rx) = tokio::sync::oneshot::channel();
        let input_lifetime = RemoteInputLifetime(input.clone());

        // Install cleanup ownership before publishing ready; the task cannot
        // emit output/exit until the matching owner releases this startup gate.
        let task_handle = tokio::task::spawn(async move {
            let _input_lifetime = input_lifetime;
            if reader_start_rx.await.is_err() {
                return;
            }
            let app_handle = app_handle_clone;
            let mut policy = OutputFlushPolicy::new();
            let mut pending = OutputCursor::new(
                auth_banner
                    .map(|banner| terminal_auth_banner(&banner))
                    .unwrap_or_default(),
            );
            let mut recorded_exit = None;
            let mut output_failed = false;
            // Both send tasks belong to this reader. Stalled input/control sends
            // must not freeze receive, output acknowledgment or session cleanup.
            let mut writers = tokio::task::JoinSet::new();
            let writer_lifetime = RemoteInputLifetime(input.clone());
            let writer_input = input.clone();
            writers.spawn(async move {
                let _writer_lifetime = writer_lifetime;
                tokio::pin!(input_writer);
                while let Some(bytes) = rx.recv().await {
                    input_writer.as_mut().write_all(&bytes).await?;
                    writer_input.record_written(bytes.len());
                }
                Ok::<(), std::io::Error>(())
            });
            let resize_writer = channel_writer.clone();
            writers.spawn(run_remote_resizes(resize_rx, move |cols, rows| {
                let writer = resize_writer.clone();
                async move {
                    writer
                        .window_change(cols as u32, rows as u32, 0, 0)
                        .await
                        .map_err(std::io::Error::other)
                }
            }));
            let drop_transport;
            let exit_code;

            loop {
                let deadline = policy.deadline();
                let has_pending = !pending.is_empty();
                tokio::select! {
                    result = output.send_pending(&mut pending), if has_pending => {
                        if let Err(error) = result {
                            eprintln!("[PTY] Remote output stopped: {}", error);
                            output_failed = true;
                            drop_transport = false;
                            exit_code = Some(None);
                            break;
                        }
                    }
                    msg = channel.wait(), if !has_pending => {
                        match remote_wait_action(msg.as_ref()) {
                            RemoteWaitAction::BufferOutput => {
                                if let Some(ref msg) = msg {
                                    pending = buffer_remote_wait_output(msg, &mut policy);
                                }
                            }
                            RemoteWaitAction::RecordExit { exit_code: code } => {
                                recorded_exit = Some(code);
                            }
                            RemoteWaitAction::PaneExit { exit_code: code } => {
                                drop_transport = false;
                                exit_code = Some(recorded_exit.unwrap_or(code));
                                break;
                            }
                            RemoteWaitAction::TransportDrop => {
                                (drop_transport, exit_code) = remote_io_completion(recorded_exit);
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
                    }, if !has_pending && deadline.is_some() => {
                        pending = apply_flush_instruction(policy.on_timer(Instant::now()));
                    }

                    _ = writers.join_next(), if !writers.is_empty() => {
                        // Peer Close can stop sends before queued exit/output is read.
                        // Only channel.wait() can distinguish pane exit from host loss.
                        input.stop();
                        writers.abort_all();
                    }

                }
            }

            if !output_failed {
                // Close follows parser completion, not just successful IPC send.
                // User close still aborts this task and cancels any ACK wait.
                let tail = drain_terminal_output(&output, &mut pending, &mut policy).await;
                if let Err(error) = tail {
                    eprintln!("[PTY] Remote final output stopped: {}", error);
                }
            }
            writers.abort_all();
            let _ = tokio::time::timeout(std::time::Duration::from_secs(1), channel_writer.close())
                .await;

            let owned = PtyManager::finish_session(
                &state_for_exit,
                &term_id_for_exit,
                generation,
                channel_id,
            )
            .await;
            if !owned {
                return;
            }
            if drop_transport {
                // Host is gone: suspend every pane. Never emit terminal-exit
                // (that would look like the user typed `exit` in this pane).
                emit_connection_transport_lost(&app_handle, &connection_id_for_transport);
            } else if let Some(code) = exit_code {
                emit_terminal_exit(&app_handle, &term_id_clone, generation, channel_id, code);
            }
        });

        if let TerminalHandle::Remote {
            task_handle: slot, ..
        } = &mut session.handle
        {
            *slot = Some(task_handle);
        }
        self.install_created_session(&creation, session).await?;
        let _ = app_handle.emit(
            &format!("terminal-ready-{}", term_id),
            TerminalLifecycleEvent {
                generation,
                channel_id,
                exit_code: None,
            },
        );
        let _ = reader_start_tx.send(());
        Ok(())
    }

    /// Completes first-connect startup once deferred OS detection finishes.
    /// Returns false when the terminal was closed or replaced meanwhile.
    pub async fn finalize_remote_startup(
        &self,
        term_id: &str,
        generation: u32,
        channel_id: u32,
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
            let state = lock_pty_state(&self.state);
            let sessions = &state.sessions;
            let Some(session) = sessions.get(term_id) else {
                return Ok(false);
            };
            if !session.output.matches(generation, channel_id) {
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
            let mut state = lock_pty_state(&self.state);
            let sessions = &mut state.sessions;
            let Some(session) = sessions.get_mut(term_id) else {
                return Ok(false);
            };
            if !session.output.matches(generation, channel_id) {
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
                .send_bytes(startup_input.as_bytes())
                .await
                .map_err(|error| anyhow!("Failed to finish remote terminal startup: {error}"))?;
        }
        Ok(true)
    }

    /// Navigate using the installed shell's quoting rules, retaining the exact
    /// remote input owner across its send gate rather than following a respawn.
    pub async fn navigate_to_path(&self, term_id: &str, path: &str) -> Result<()> {
        let remote_input = {
            let state = lock_pty_state(&self.state);
            let sessions = &state.sessions;
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
                let state = lock_pty_state(&self.state);
                let sessions = &state.sessions;
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
            let state = lock_pty_state(&self.state);
            let sessions = &state.sessions;
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
            .send_bytes(cd_cmd.as_bytes())
            .await
            .map_err(|e| anyhow!("Failed to send navigation to SSH task: {}", e))
    }

    /// Clone the installed input handle under the short state lock, then perform
    /// serialized local or remote I/O without holding the lifecycle registry.
    pub async fn write(&self, term_id: &str, data: &str) -> Result<()> {
        self.write_for_owner(term_id, data, None).await
    }

    /// Fences delayed IPC by generation/channel before cloning a handle; replacements never inherit input.
    pub(crate) async fn write_for_owner(
        &self,
        term_id: &str,
        data: &str,
        owner: Option<(u32, u32)>,
    ) -> Result<()> {
        let (local_writer_opt, remote_input_opt) = {
            let state = lock_pty_state(&self.state);
            let sessions = &state.sessions;
            let session = sessions
                .get(term_id)
                .ok_or_else(|| anyhow!("Session not found: {}", term_id))?;

            if owner.is_some_and(|(generation, channel_id)| {
                !session.output.matches(generation, channel_id)
            }) {
                return Err(anyhow!("Terminal session changed before input admission"));
            }

            match &session.handle {
                TerminalHandle::Local { writer, .. } => (Some(writer.clone()), None),
                TerminalHandle::Remote { input, .. } => (None, Some(input.clone())),
            }
        }; // sessions lock is dropped here

        if let Some(writer) = local_writer_opt {
            write_local_pty_chunks(writer, data.as_bytes()).await?;
        } else if let Some(input) = remote_input_opt {
            // Mark interaction before waiting for the send gate. Deferred
            // startup will either finish first or observe this and stand down.
            input.mark_user_input_started();
            let _send_guard = input.send_gate.lock().await;
            input
                .send_bytes(data.as_bytes())
                .await
                .map_err(|e| anyhow!("Failed to send input to SSH task: {}", e))?;
            if owner.is_some() {
                input
                    .wait_written(input.admitted_bytes.load(Ordering::Acquire))
                    .await?;
            }
        }

        Ok(())
    }

    /// Exercises ownerless resize callers without duplicating the native admission path.
    #[cfg(test)]
    pub async fn resize(&self, term_id: &str, cols: u16, rows: u16) -> Result<()> {
        self.resize_for_owner(term_id, cols, rows, None).await
    }

    /// Binds queued resize work to its installed generation/channel before awaiting platform I/O.
    pub(crate) async fn resize_for_owner(
        &self,
        term_id: &str,
        cols: u16,
        rows: u16,
        owner: Option<(u32, u32)>,
    ) -> Result<()> {
        if cols == 0 || rows == 0 {
            return Err(anyhow!("Terminal dimensions must be nonzero"));
        }
        let (local_master, remote_tx_opt) = {
            let state = lock_pty_state(&self.state);
            let sessions = &state.sessions;
            let session = sessions
                .get(term_id)
                .ok_or_else(|| anyhow!("Session not found: {}", term_id))?;

            if owner.is_some_and(|(generation, channel_id)| {
                !session.output.matches(generation, channel_id)
            }) {
                return Err(anyhow!("Terminal session changed before resize admission"));
            }

            match &session.handle {
                TerminalHandle::Local { master, .. } => (Some(master.clone()), None),
                TerminalHandle::Remote { resize_tx, .. } => (None, Some(resize_tx.clone())),
            }
        }; // sessions lock is dropped here

        if let Some(master) = local_master {
            // Acquire before dispatch so competing resizes preserve lock order
            // without occupying blocking workers while waiting for the same PTY.
            let master = master.lock_owned().await;
            tokio::task::spawn_blocking(move || {
                master
                    .as_ref()
                    .ok_or_else(|| anyhow!("Local PTY has exited"))?
                    .resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .map_err(|e| anyhow!("Failed to resize PTY: {}", e))
            })
            .await
            .map_err(|e| anyhow!("PTY resize task failed: {}", e))??;
        }

        if let Some(resize_tx) = remote_tx_opt {
            let (reply, completed) = tokio::sync::oneshot::channel();
            resize_tx
                .send(RemoteResize { cols, rows, reply })
                .await
                .map_err(|e| anyhow!("Failed to send resize to SSH task: {}", e))?;
            completed
                .await
                .map_err(|_| anyhow!("Remote terminal closed before resize completion"))?
                .map_err(|error| anyhow!("Failed to resize SSH terminal: {error}"))?;
        }

        Ok(())
    }

    /// True when the local shell has child processes (foreground/background jobs).
    /// Remote sessions always return false — callers should use output-based busy detection.
    pub async fn has_active_child_processes(&self, term_id: &str) -> bool {
        let child_pid = {
            let state = lock_pty_state(&self.state);
            let sessions = &state.sessions;
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

    /// Explicit close cancels parser waits before killing detached OS resources.
    pub async fn close(&self, term_id: &str) -> Result<()> {
        let session = {
            let mut state = lock_pty_state(&self.state);
            state.pending.remove(term_id);
            state.sessions.remove(term_id)
        };
        if let Some(session) = session {
            Self::close_sessions(vec![session]).await?;
        }
        Ok(())
    }

    /// An old reader may finish after respawn. Remove only its generation and
    /// release the manager lock before platform cleanup, just as explicit close
    /// does. Do not abort the reader that reported this natural exit.
    async fn finish_session(
        state: &StdMutex<PtyState>,
        term_id: &str,
        generation: u32,
        channel_id: u32,
    ) -> bool {
        let session = {
            let mut state = lock_pty_state(state);
            let sessions = &mut state.sessions;
            if sessions
                .get(term_id)
                .is_some_and(|s| s.output.matches(generation, channel_id))
            {
                sessions.remove(term_id)
            } else {
                None
            }
        };
        if let Some(mut session) = session {
            session.output.close();
            if let Err(error) = tokio::task::spawn_blocking(move || {
                Self::finalize_session_after_natural_exit(&mut session.handle);
            })
            .await
            {
                eprintln!("[PTY] Natural-exit cleanup task failed: {}", error);
            }
            return true;
        }
        false
    }

    /// Atomically detach this connection's sessions, keeping unrelated PTYs live.
    pub async fn close_by_connection(&self, connection_id: &str) -> Result<()> {
        let removed = {
            let mut state = lock_pty_state(&self.state);
            state
                .pending
                .retain(|_, pending| pending.connection_id != connection_id);
            let sessions = &mut state.sessions;
            let ids: Vec<_> = sessions
                .iter()
                .filter(|(_, session)| session.connection_id == connection_id)
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| sessions.remove(&id))
                .collect()
        };
        Self::close_sessions(removed).await
    }

    /// Parser progress belongs to an exact PTY generation/channel owner. Late
    /// messages after dispose/restart are inert, rather than granting new credit.
    pub async fn acknowledge_output(
        &self,
        term_id: &str,
        generation: u32,
        channel_id: u32,
        sequence: u32,
    ) -> Result<()> {
        let output = lock_pty_state(&self.state)
            .sessions
            .get(term_id)
            .filter(|session| session.output.matches(generation, channel_id))
            .map(|session| session.output.clone());
        if let Some(output) = output {
            output.acknowledge(sequence)?;
        }
        Ok(())
    }

    /// Stop only the failed output owner; a delayed failure may not kill a
    /// replacement PTY. The caller uses existing terminal-exit UI cleanup.
    pub async fn fail_output(
        &self,
        term_id: &str,
        generation: u32,
        channel_id: u32,
    ) -> Result<bool> {
        let session = {
            let mut state = lock_pty_state(&self.state);
            let sessions = &mut state.sessions;
            if sessions
                .get(term_id)
                .is_some_and(|session| session.output.matches(generation, channel_id))
            {
                sessions.remove(term_id)
            } else {
                None
            }
        };
        if let Some(session) = session {
            Self::close_sessions(vec![session]).await?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Detach sessions before platform teardown: a slow kill/drop must not hold
    /// the manager lock or block Tokio's workers serving other terminals.
    async fn close_sessions(mut sessions: Vec<PtySession>) -> Result<()> {
        if sessions.is_empty() {
            return Ok(());
        }
        // Stop delivery immediately, even if the blocking pool is busy.
        for session in &mut sessions {
            session.output.close();
            Self::stop_session_tasks(&mut session.handle);
        }
        tokio::task::spawn_blocking(move || {
            for session in &mut sessions {
                Self::cleanup_session_handles(&mut session.handle);
            }
        })
        .await
        .map_err(|e| anyhow!("PTY close task failed: {}", e))
    }
}

/// Forward a local reader through the common parser-credit window. Child status
/// is deliberately not a read-loop event: process exit may precede pipe EOF and
/// must never overtake trailing output. Control/close stays in PtyManager.
async fn forward_local_output(
    mut reader: mpsc::Receiver<LocalReaderEvent>,
    output: &PtyOutput,
    child_exit: tokio::sync::oneshot::Receiver<Option<u32>>,
) -> Result<Option<u32>> {
    let mut policy = OutputFlushPolicy::new();
    let mut pending = OutputCursor::default();
    let mut reader_failed = false;
    loop {
        let deadline = policy.deadline();
        let has_pending = !pending.is_empty();
        tokio::select! {
            result = output.send_pending(&mut pending), if has_pending => { result?; }
            event = reader.recv(), if !has_pending => match event {
                Some(LocalReaderEvent::Data(chunk)) => {
                    pending = apply_flush_instruction(policy.on_bytes(&chunk, Instant::now()));
                }
                Some(LocalReaderEvent::Eof) => break,
                Some(LocalReaderEvent::Failed) | None => {
                    reader_failed = true;
                    break;
                }
            },
            _ = async { if let Some(deadline) = deadline { tokio::time::sleep_until(deadline).await; } },
                if !has_pending && deadline.is_some() => {
                    pending = apply_flush_instruction(policy.on_timer(Instant::now()));
                }
        }
    }
    drain_terminal_output(output, &mut pending, &mut policy).await?;
    if reader_failed {
        return Err(anyhow!("Local PTY reader stopped before EOF"));
    }
    Ok(child_exit.await.unwrap_or(None))
}

/// Deliver all already-received bytes, including a timer-buffered tail on a
/// transport drop. Reader termination is not permission to discard that tail.
async fn drain_terminal_output(
    output: &PtyOutput,
    pending: &mut OutputCursor,
    policy: &mut OutputFlushPolicy,
) -> Result<()> {
    output.send_pending(pending).await?;
    output.send_pending(&mut flush_policy_tail(policy)).await?;
    output.drain().await
}

/// Read bounded chunks on a dedicated blocking worker. After receiver closure,
/// continue draining OS output until EOF instead of abandoning ConPTY's final
/// flush; a closed UI intentionally discards bytes, normal backpressure does not.
fn read_local_output(mut reader: Box<dyn Read + Send>, output: mpsc::Sender<LocalReaderEvent>) {
    let mut buf = [0u8; 8192];
    let mut forwarding = true;
    loop {
        match reader.read(&mut buf) {
            Ok(0) => {
                let _ = output.blocking_send(LocalReaderEvent::Eof);
                break;
            }
            Ok(count) => {
                if forwarding
                    && output
                        .blocking_send(LocalReaderEvent::Data(buf[..count].to_vec()))
                        .is_err()
                {
                    forwarding = false;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => {
                eprintln!("[PTY] Read failed: {}", error);
                let _ = output.blocking_send(LocalReaderEvent::Failed);
                break;
            }
        }
    }
}

/// Observe process exit independently of output delivery, then close the control
/// master on this blocking worker while the dedicated reader keeps draining.
/// ConPTY may not produce pipe EOF until ClosePseudoConsole completes; retaining
/// its master until reader EOF would form a shutdown cycle under backpressure.
fn wait_for_local_child(
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    master: LocalMaster,
    status: tokio::sync::oneshot::Sender<Option<u32>>,
) {
    let exit_code = child.wait().ok().map(|status| status.exit_code());
    let _ = status.send(exit_code);
    let master = master.blocking_lock().take();
    drop(master);
}

/// Serialize local input before dispatching blocking pipe I/O. Holding an owned
/// guard through flush prevents paste/keystroke interleaving, including when the
/// invoking future is cancelled after the blocking operation has started.
#[cfg(test)]
async fn write_local_pty(writer: LocalWriter, data: Vec<u8>) -> Result<()> {
    write_local_pty_chunks(writer, &data).await
}

/// Keeps one local write's lock across bounded blocking packets without copying the complete paste.
async fn write_local_pty_chunks(writer: LocalWriter, data: &[u8]) -> Result<()> {
    let mut writer = writer.lock_owned().await;
    for bytes in data.chunks(TERMINAL_INPUT_CHUNK_BYTES) {
        let bytes = bytes.to_vec();
        writer = tokio::task::spawn_blocking(move || {
            writer
                .write_all(&bytes)
                .map_err(|e| anyhow!("Failed to write to PTY: {}", e))?;
            writer
                .flush()
                .map_err(|e| anyhow!("Failed to flush PTY: {}", e))?;
            Ok::<_, anyhow::Error>(writer)
        })
        .await
        .map_err(|e| anyhow!("PTY input task failed: {}", e))??;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        build_navigate_cd_command, deferred_remote_startup_input, initial_remote_cd_command,
        posix_shell_cd_path, remote_navigate_shell_style, remote_wait_action, terminal_auth_banner,
        DeferredStartupClaim, NavigateShellStyle, RemoteInput, RemoteWaitAction,
    };
    use russh::ChannelMsg;

    #[tokio::test]
    async fn resize_owner_fences_replacements_and_waits_for_remote_completion() {
        let manager = super::PtyManager::new();
        let make_session = || {
            let mut session = test_local_session(None, None);
            let (tx, _rx) = tokio::sync::mpsc::channel(1);
            let (resize_tx, resize_rx) = tokio::sync::mpsc::channel(2);
            session.handle = super::TerminalHandle::Remote {
                input: std::sync::Arc::new(RemoteInput::new(tx, false)),
                resize_tx,
                task_handle: None,
            };
            (session, resize_rx)
        };
        let (first, mut first_rx) = make_session();
        let first_id = first.output_channel.id();
        super::lock_pty_state(&manager.state)
            .sessions
            .insert("resize-owner".into(), first);
        for owner in [Some((2, first_id)), Some((1, first_id.wrapping_add(1)))] {
            assert!(manager
                .resize_for_owner("resize-owner", 132, 31, owner)
                .await
                .is_err());
        }
        assert!(manager.resize("resize-owner", 0, 31).await.is_err());
        assert!(manager.resize("resize-owner", 132, 0).await.is_err());
        assert!(first_rx.try_recv().is_err());

        let resize = manager.resize_for_owner("resize-owner", 132, 31, Some((1, first_id)));
        tokio::pin!(resize);
        assert!(futures_util::poll!(&mut resize).is_pending());
        let first_request = first_rx.recv().await.unwrap();
        assert_eq!((first_request.cols, first_request.rows), (132, 31));
        assert!(futures_util::poll!(&mut resize).is_pending());

        // The admitted request continues only on its captured old channel.
        let (replacement, mut replacement_rx) = make_session();
        let replacement_id = replacement.output_channel.id();
        super::lock_pty_state(&manager.state)
            .sessions
            .insert("resize-owner".into(), replacement);
        first_request.reply.send(Ok(())).unwrap();
        resize.await.unwrap();
        assert!(replacement_rx.try_recv().is_err());
        assert!(manager
            .resize_for_owner("resize-owner", 202, 42, Some((1, first_id)))
            .await
            .is_err());
        assert!(replacement_rx.try_recv().is_err());

        let resize = manager.resize_for_owner("resize-owner", 202, 42, Some((1, replacement_id)));
        tokio::pin!(resize);
        assert!(futures_util::poll!(&mut resize).is_pending());
        let request = replacement_rx.recv().await.unwrap();
        assert_eq!((request.cols, request.rows), (202, 42));
        request.reply.send(Ok(())).unwrap();
        resize.await.unwrap();
    }

    #[tokio::test]
    async fn remote_resize_errors_and_closed_reply_never_acknowledge_success() {
        for reply_error in [true, false] {
            let manager = super::PtyManager::new();
            let mut session = test_local_session(None, None);
            let (tx, _rx) = tokio::sync::mpsc::channel(1);
            let (resize_tx, mut resize_rx) = tokio::sync::mpsc::channel(1);
            session.handle = super::TerminalHandle::Remote {
                input: std::sync::Arc::new(RemoteInput::new(tx, false)),
                resize_tx,
                task_handle: None,
            };
            super::lock_pty_state(&manager.state)
                .sessions
                .insert("resize-failure".into(), session);
            let resize = manager.resize("resize-failure", 64, 20);
            tokio::pin!(resize);
            assert!(futures_util::poll!(&mut resize).is_pending());
            let request = resize_rx.recv().await.unwrap();
            if reply_error {
                request
                    .reply
                    .send(Err("fixture sender closed".into()))
                    .unwrap();
                assert!(resize
                    .await
                    .unwrap_err()
                    .to_string()
                    .contains("fixture sender closed"));
            } else {
                drop(request);
                assert!(resize
                    .await
                    .unwrap_err()
                    .to_string()
                    .contains("closed before resize completion"));
            }
            drop(resize_rx);
            assert!(manager.resize("resize-failure", 64, 20).await.is_err());
        }
    }

    #[tokio::test]
    async fn remote_resize_worker_waits_for_sender_and_releases_all_waiters_on_abort() {
        let (requests, receiver) = tokio::sync::mpsc::channel(2);
        let (started, entered) = tokio::sync::oneshot::channel();
        let (release, blocked) = tokio::sync::oneshot::channel::<()>();
        let mut gate = Some((started, blocked));
        let task = tokio::spawn(super::run_remote_resizes(receiver, move |cols, rows| {
            let (started, blocked) = gate.take().unwrap();
            async move {
                started.send((cols, rows)).unwrap();
                let _ = blocked.await;
                Ok(())
            }
        }));
        let (reply, mut completed) = tokio::sync::oneshot::channel();
        requests
            .send(super::RemoteResize {
                cols: 132,
                rows: 31,
                reply,
            })
            .await
            .unwrap();
        assert_eq!(entered.await.unwrap(), (132, 31));
        assert!(matches!(
            completed.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        let (reply, queued) = tokio::sync::oneshot::channel();
        requests
            .send(super::RemoteResize {
                cols: 202,
                rows: 42,
                reply,
            })
            .await
            .unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(completed.await.is_err());
        assert!(queued.await.is_err());
        drop(release);
    }

    #[tokio::test]
    async fn remote_resize_worker_acknowledges_only_success_and_returns_sender_failure() {
        let (requests, receiver) = tokio::sync::mpsc::channel(2);
        let (reply, first) = tokio::sync::oneshot::channel();
        requests
            .send(super::RemoteResize {
                cols: 132,
                rows: 31,
                reply,
            })
            .await
            .unwrap();
        let (reply, second) = tokio::sync::oneshot::channel();
        requests
            .send(super::RemoteResize {
                cols: 64,
                rows: 20,
                reply,
            })
            .await
            .unwrap();
        let task = tokio::spawn(super::run_remote_resizes(
            receiver,
            |cols, rows| async move {
                if (cols, rows) == (132, 31) {
                    Ok(())
                } else {
                    Err(std::io::Error::other("fixture failed resize"))
                }
            },
        ));
        first.await.unwrap().unwrap();
        assert!(second
            .await
            .unwrap()
            .unwrap_err()
            .contains("fixture failed resize"));
        assert!(task
            .await
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("fixture failed resize"));
    }

    #[tokio::test]
    async fn remote_input_packets_bound_queue_bytes_and_preserve_complete_large_writes() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(super::REMOTE_INPUT_QUEUE_CHUNKS);
        let input = RemoteInput::new(tx, false);
        let data = "界🦀".repeat(super::TERMINAL_INPUT_CHUNK_BYTES * 6);
        let send = input.send_bytes(data.as_bytes());
        tokio::pin!(send);
        assert!(futures_util::poll!(&mut send).is_pending());
        assert_eq!(rx.len(), super::REMOTE_INPUT_QUEUE_CHUNKS);
        let receive = async {
            let mut received = Vec::new();
            while received.len() < data.len() {
                let packet = rx.recv().await.unwrap();
                assert!(!packet.is_empty());
                assert!(packet.len() <= super::TERMINAL_INPUT_CHUNK_BYTES);
                received.extend(packet);
            }
            assert_eq!(received, data.as_bytes());
        };
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            let (result, ()) = tokio::join!(send, receive);
            result.unwrap();
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn closed_remote_input_reports_failed_admission() {
        let (tx, rx) = tokio::sync::mpsc::channel(1);
        let input = RemoteInput::new(tx, false);
        drop(rx);
        assert!(input.send_bytes(b"unsent").await.is_err());
    }

    /// Stopping either sender rejects fresh input and input waiting for a queue permit.
    #[tokio::test]
    async fn stopped_remote_input_rejects_admission_before_receiver_is_dropped() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        let input = RemoteInput::new(tx, false);
        input.send_bytes(b"already admitted").await.unwrap();
        let waiting = input.send_bytes(b"waiting for space");
        tokio::pin!(waiting);
        assert!(futures_util::poll!(&mut waiting).is_pending());
        input.stop();
        assert!(input.send_bytes(b"after stop").await.is_err());
        assert!(input.wait_written(1).await.is_err());
        assert_eq!(rx.recv().await.unwrap(), b"already admitted");
        assert!(waiting.await.is_err());
        assert!(rx.try_recv().is_err());
        assert_eq!(input.admitted_bytes.load(super::Ordering::Acquire), 16);
    }

    #[tokio::test]
    async fn large_local_input_keeps_every_byte_through_partial_packet_writes() {
        let bytes = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let writer: super::LocalWriter =
            std::sync::Arc::new(tokio::sync::Mutex::new(Box::new(TestWriter {
                gate: None,
                bytes: bytes.clone(),
                fail_write: false,
                fail_flush: false,
            })));
        let data = "世🦀\r\x1b[201~".repeat(5000);
        super::write_local_pty_chunks(writer, data.as_bytes())
            .await
            .unwrap();
        assert_eq!(*bytes.lock().unwrap(), data.as_bytes());
    }

    #[tokio::test]
    async fn input_owner_fences_generation_and_same_generation_channel_replacement() {
        let manager = super::PtyManager::new();
        let make_session = || {
            let mut session = test_local_session(None, None);
            let (tx, rx) = tokio::sync::mpsc::channel(2);
            let (resize_tx, _) = tokio::sync::mpsc::channel(1);
            let input = std::sync::Arc::new(RemoteInput::new(tx, false));
            session.handle = super::TerminalHandle::Remote {
                input: input.clone(),
                resize_tx,
                task_handle: None,
            };
            (session, input, rx)
        };
        let (first, first_input, mut first_rx) = make_session();
        let first_id = first.output_channel.id();
        let creation = manager
            .begin_creation("input-owner", "test-local")
            .await
            .unwrap();
        manager
            .install_created_session(&creation, first)
            .await
            .unwrap();
        assert!(manager
            .write_for_owner("input-owner", "stale", Some((2, first_id)))
            .await
            .is_err());
        assert!(first_rx.try_recv().is_err());
        let first_write = manager.write_for_owner("input-owner", "first", Some((1, first_id)));
        tokio::pin!(first_write);
        assert!(futures_util::poll!(&mut first_write).is_pending());
        assert_eq!(first_rx.recv().await.unwrap(), b"first");
        first_input.record_written(5);
        first_write.await.unwrap();
        let (replacement, replacement_input, mut replacement_rx) = make_session();
        let replacement_id = replacement.output_channel.id();
        let creation = manager
            .begin_creation("input-owner", "test-local")
            .await
            .unwrap();
        manager
            .install_created_session(&creation, replacement)
            .await
            .unwrap();
        assert!(manager
            .write_for_owner("input-owner", "old", Some((1, first_id)))
            .await
            .is_err());
        assert!(replacement_rx.try_recv().is_err());
        let new_write = manager.write_for_owner("input-owner", "new", Some((1, replacement_id)));
        tokio::pin!(new_write);
        assert!(futures_util::poll!(&mut new_write).is_pending());
        assert_eq!(replacement_rx.recv().await.unwrap(), b"new");
        replacement_input.record_written(3);
        new_write.await.unwrap();
    }

    #[tokio::test]
    async fn remote_ack_waits_for_write_completion_and_wakes_on_close() {
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let input = std::sync::Arc::new(RemoteInput::new(tx, false));
        let wait = input.wait_written(5);
        tokio::pin!(wait);
        assert!(futures_util::poll!(&mut wait).is_pending());
        input.record_written(4);
        assert!(futures_util::poll!(&mut wait).is_pending());
        input.record_written(1);
        wait.await.unwrap();
        let wait = input.wait_written(6);
        tokio::pin!(wait);
        assert!(futures_util::poll!(&mut wait).is_pending());
        input.stop();
        assert!(wait.await.is_err());
        input.wait_written(5).await.unwrap();
        input.record_written(1);
        assert!(input.wait_written(6).await.is_err());
    }

    /// A finite safety timeout keeps a synchronous-I/O regression from hanging
    /// the test process. Tests release this gate explicitly, without sleeps.
    #[derive(Debug)]
    struct BlockingIo {
        entered: tokio::sync::Notify,
        release_tx: std::sync::mpsc::Sender<()>,
        release_rx: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
        finished: std::sync::atomic::AtomicBool,
    }

    impl BlockingIo {
        fn new() -> std::sync::Arc<Self> {
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            std::sync::Arc::new(Self {
                entered: tokio::sync::Notify::new(),
                release_tx,
                release_rx: std::sync::Mutex::new(release_rx),
                finished: std::sync::atomic::AtomicBool::new(false),
            })
        }

        fn block(&self) {
            self.entered.notify_one();
            let _ = self
                .release_rx
                .lock()
                .unwrap()
                .recv_timeout(std::time::Duration::from_secs(2));
            self.finished
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }

        async fn release_after_yield(&self) -> bool {
            tokio::time::timeout(std::time::Duration::from_secs(3), self.entered.notified())
                .await
                .unwrap();
            let yielded = !self.finished.load(std::sync::atomic::Ordering::SeqCst);
            self.release_tx.send(()).unwrap();
            yielded
        }
    }

    struct TestWriter {
        gate: Option<std::sync::Arc<BlockingIo>>,
        bytes: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
        fail_write: bool,
        fail_flush: bool,
    }

    impl std::io::Write for TestWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if let Some(gate) = self.gate.take() {
                gate.block();
            }
            if self.fail_write {
                return Err(std::io::ErrorKind::BrokenPipe.into());
            }
            // Exercise write_all, not just a writer that accepts every byte.
            let count = bytes.len().min(2);
            self.bytes
                .lock()
                .unwrap()
                .extend_from_slice(&bytes[..count]);
            Ok(count)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            if self.fail_flush {
                Err(std::io::ErrorKind::BrokenPipe.into())
            } else {
                Ok(())
            }
        }
    }

    struct TestMaster(Option<std::sync::Arc<BlockingIo>>);
    impl portable_pty::MasterPty for TestMaster {
        fn resize(&self, _: portable_pty::PtySize) -> anyhow::Result<()> {
            if let Some(gate) = &self.0 {
                gate.block();
            }
            Ok(())
        }
        fn get_size(&self) -> anyhow::Result<portable_pty::PtySize> {
            Ok(Default::default())
        }
        fn try_clone_reader(&self) -> anyhow::Result<Box<dyn std::io::Read + Send>> {
            unreachable!()
        }
        fn take_writer(&self) -> anyhow::Result<Box<dyn std::io::Write + Send>> {
            unreachable!()
        }
        #[cfg(unix)]
        fn process_group_leader(&self) -> Option<libc::pid_t> {
            None
        }
        #[cfg(unix)]
        fn as_raw_fd(&self) -> Option<std::os::fd::RawFd> {
            None
        }
    }

    #[derive(Debug, Clone)]
    struct TestKiller(Option<std::sync::Arc<BlockingIo>>);
    impl portable_pty::ChildKiller for TestKiller {
        fn kill(&mut self) -> std::io::Result<()> {
            if let Some(gate) = &self.0 {
                gate.block();
            }
            Ok(())
        }
        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(self.clone())
        }
    }

    fn test_local_session(
        resize: Option<std::sync::Arc<BlockingIo>>,
        kill: Option<std::sync::Arc<BlockingIo>>,
    ) -> super::PtySession {
        let output_channel = tauri::ipc::Channel::new(|_| Ok(()));
        super::PtySession {
            connection_id: "test-local".into(),
            output_channel: output_channel.clone(),
            output: std::sync::Arc::new(super::PtyOutput::new(output_channel, 1)),
            navigate_shell: NavigateShellStyle::Posix,
            handle: super::TerminalHandle::Local {
                writer: std::sync::Arc::new(tokio::sync::Mutex::new(Box::new(std::io::sink()))),
                reader_handle: None,
                inject_handle: None,
                master: std::sync::Arc::new(tokio::sync::Mutex::new(Some(Box::new(TestMaster(
                    resize,
                ))))),
                child_killer: Box::new(TestKiller(kill)),
                child_pid: None,
            },
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn local_write_yields_runtime_and_preserves_partial_writes() {
        let gate = BlockingIo::new();
        let bytes = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let writer = TestWriter {
            gate: Some(gate.clone()),
            bytes: bytes.clone(),
            fail_write: false,
            fail_flush: false,
        };
        let task = tokio::spawn(super::write_local_pty(
            std::sync::Arc::new(tokio::sync::Mutex::new(Box::new(writer))),
            b"paste-data".to_vec(),
        ));
        let yielded = gate.release_after_yield().await;
        task.await.unwrap().unwrap();
        assert!(yielded, "blocking pipe write starved the async runtime");
        assert_eq!(*bytes.lock().unwrap(), b"paste-data");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn local_write_cancellation_does_not_interleave_later_input() {
        let gate = BlockingIo::new();
        let bytes = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let writer: std::sync::Arc<tokio::sync::Mutex<Box<dyn std::io::Write + Send>>> =
            std::sync::Arc::new(tokio::sync::Mutex::new(Box::new(TestWriter {
                gate: Some(gate.clone()),
                bytes: bytes.clone(),
                fail_write: false,
                fail_flush: false,
            })));
        let first = tokio::spawn(super::write_local_pty(writer.clone(), b"first".to_vec()));
        gate.entered.notified().await;
        first.abort();
        let second = tokio::spawn(super::write_local_pty(writer, b"second".to_vec()));
        tokio::task::yield_now().await;
        let remained_serial = !second.is_finished();
        gate.release_tx.send(()).unwrap();
        second.await.unwrap().unwrap();
        assert!(remained_serial);
        assert_eq!(*bytes.lock().unwrap(), b"firstsecond");
    }

    #[tokio::test]
    async fn local_write_and_flush_errors_are_returned() {
        for (fail_write, fail_flush, expected) in [(true, false, "write"), (false, true, "flush")] {
            let writer = TestWriter {
                gate: None,
                bytes: Default::default(),
                fail_write,
                fail_flush,
            };
            let error = super::write_local_pty(
                std::sync::Arc::new(tokio::sync::Mutex::new(Box::new(writer))),
                b"x".to_vec(),
            )
            .await
            .unwrap_err();
            assert!(error.to_string().contains(expected));
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn local_resize_yields_and_releases_manager_lock() {
        let gate = BlockingIo::new();
        let manager = std::sync::Arc::new(super::PtyManager::new());
        super::lock_pty_state(&manager.state).sessions.insert(
            "resize".into(),
            test_local_session(Some(gate.clone()), None),
        );
        let operation = manager.clone();
        let task = tokio::spawn(async move { operation.resize("resize", 120, 40).await });
        gate.entered.notified().await;
        let unlocked = manager.state.try_lock().is_ok();
        let yielded = !gate.finished.load(std::sync::atomic::Ordering::SeqCst);
        gate.release_tx.send(()).unwrap();
        task.await.unwrap().unwrap();
        assert!(
            yielded && unlocked,
            "resize blocked the runtime or session manager"
        );
        manager.close("resize").await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn local_close_yields_and_detaches_before_kill() {
        for by_connection in [false, true] {
            let gate = BlockingIo::new();
            let manager = std::sync::Arc::new(super::PtyManager::new());
            super::lock_pty_state(&manager.state)
                .sessions
                .insert("close".into(), test_local_session(None, Some(gate.clone())));
            let operation = manager.clone();
            let task = tokio::spawn(async move {
                if by_connection {
                    operation.close_by_connection("test-local").await
                } else {
                    operation.close("close").await
                }
            });
            gate.entered.notified().await;
            let detached = manager
                .state
                .try_lock()
                .is_ok_and(|state| !state.sessions.contains_key("close"));
            let yielded = !gate.finished.load(std::sync::atomic::Ordering::SeqCst);
            gate.release_tx.send(()).unwrap();
            task.await.unwrap().unwrap();
            assert!(
                yielded && detached,
                "close blocked the runtime or retained the session lock"
            );
        }
    }

    #[tokio::test]
    async fn natural_exit_does_not_remove_replacement_generation() {
        let manager = super::PtyManager::new();
        let mut replacement = test_local_session(None, None);
        let channel_id = replacement.output_channel.id();
        replacement.output =
            std::sync::Arc::new(super::PtyOutput::new(replacement.output_channel.clone(), 2));
        super::lock_pty_state(&manager.state)
            .sessions
            .insert("reused".into(), replacement);
        super::PtyManager::finish_session(&manager.state, "reused", 1, channel_id).await;
        assert!(super::lock_pty_state(&manager.state)
            .sessions
            .get("reused")
            .unwrap()
            .output
            .matches(2, channel_id));
        super::PtyManager::finish_session(&manager.state, "reused", 2, channel_id).await;
        assert!(super::lock_pty_state(&manager.state).sessions.is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn natural_exit_releases_manager_lock_before_kill() {
        let gate = BlockingIo::new();
        let manager = std::sync::Arc::new(super::PtyManager::new());
        super::lock_pty_state(&manager.state)
            .sessions
            .insert("exit".into(), test_local_session(None, Some(gate.clone())));
        let channel_id = super::lock_pty_state(&manager.state)
            .sessions
            .get("exit")
            .unwrap()
            .output_channel
            .id();
        let operation = manager.clone();
        let task = tokio::spawn(async move {
            super::PtyManager::finish_session(&operation.state, "exit", 1, channel_id).await
        });
        gate.entered.notified().await;
        let detached = manager
            .state
            .try_lock()
            .is_ok_and(|state| state.sessions.is_empty());
        let yielded = !gate.finished.load(std::sync::atomic::Ordering::SeqCst);
        gate.release_tx.send(()).unwrap();
        task.await.unwrap();
        assert!(yielded && detached);
    }

    /// A child exiting early must not truncate queued data or final parser drain.
    #[tokio::test]
    async fn child_exit_waits_for_reader_eof_and_final_parser_ack() {
        let (frames_tx, mut frames_rx) = tokio::sync::mpsc::unbounded_channel();
        let channel = tauri::ipc::Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Raw(frame) = body {
                frames_tx.send(frame).unwrap();
            }
            Ok(())
        });
        let output = std::sync::Arc::new(super::PtyOutput::new(channel, 1));
        let (reader_tx, reader_rx) = tokio::sync::mpsc::channel(4);
        let (exit_tx, exit_rx) = tokio::sync::oneshot::channel();
        exit_tx.send(Some(23)).unwrap(); // child status arrives before any tail bytes
        let sender = tokio::spawn(async move {
            for _ in 0..80 {
                reader_tx
                    .send(super::LocalReaderEvent::Data(vec![b'x'; 8192]))
                    .await
                    .unwrap();
            }
            reader_tx.send(super::LocalReaderEvent::Eof).await.unwrap();
        });
        let delivery = output.clone();
        let task = tokio::spawn(async move {
            super::forward_local_output(reader_rx, &delivery, exit_rx).await
        });
        let mut parsed = 0;
        let mut last_sequence = 0;
        while parsed < 80 * 8192 {
            let frame = tokio::time::timeout(std::time::Duration::from_secs(3), frames_rx.recv())
                .await
                .unwrap()
                .unwrap();
            parsed += frame.len() - 8;
            last_sequence += 1;
            assert_eq!(
                u32::from_le_bytes(frame[4..8].try_into().unwrap()),
                last_sequence
            );
            assert!(!task.is_finished(), "completion overtook unparsed output");
            output.acknowledge(last_sequence).unwrap();
        }
        sender.await.unwrap();
        assert_eq!(task.await.unwrap().unwrap(), Some(23));
    }

    /// Explicit close cancels a full output window without requiring any ACK.
    #[tokio::test]
    async fn cancelled_local_forwarding_does_not_wait_for_slow_parser() {
        let channel = tauri::ipc::Channel::new(|_| Ok(()));
        let output = std::sync::Arc::new(super::PtyOutput::new(channel, 1));
        let (reader_tx, reader_rx) = tokio::sync::mpsc::channel(2);
        let (_exit_tx, exit_rx) = tokio::sync::oneshot::channel();
        let sender = tokio::spawn(async move {
            for _ in 0..80 {
                if reader_tx
                    .send(super::LocalReaderEvent::Data(vec![b'x'; 8192]))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        let delivery = output.clone();
        let task = tokio::spawn(async move {
            super::forward_local_output(reader_rx, &delivery, exit_rx).await
        });
        tokio::task::yield_now().await;
        output.close();
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(2), task)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        sender.await.unwrap();
    }

    /// After UI disposal, the dedicated reader must drain ConPTY until EOF.
    #[test]
    fn closed_output_receiver_does_not_stop_os_pipe_drain() {
        struct CountingReader {
            inner: std::io::Cursor<Vec<u8>>,
            bytes: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        }
        impl std::io::Read for CountingReader {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                let count = self.inner.read(buffer)?;
                self.bytes
                    .fetch_add(count, std::sync::atomic::Ordering::Relaxed);
                Ok(count)
            }
        }
        let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let reader = CountingReader {
            inner: std::io::Cursor::new(vec![0; 1024 * 1024]),
            bytes: count.clone(),
        };
        let (tx, rx) = tokio::sync::mpsc::channel(2);
        drop(rx);
        super::read_local_output(Box::new(reader), tx);
        assert_eq!(
            count.load(std::sync::atomic::Ordering::Relaxed),
            1024 * 1024
        );
    }

    /// An older creator cannot replace the latest channel even when both use
    /// generation 1; its already-produced child/task are cleaned off-lock.
    #[tokio::test(flavor = "current_thread")]
    async fn overlapping_creations_install_only_the_latest_owner_and_clean_stale_resources() {
        let manager = std::sync::Arc::new(super::PtyManager::new());
        let old = manager
            .begin_creation("reused", "test-local")
            .await
            .unwrap();
        let current = manager
            .begin_creation("reused", "test-local")
            .await
            .unwrap();
        let replacement = test_local_session(None, None);
        let current_channel = replacement.output_channel.id();
        manager
            .install_created_session(&current, replacement)
            .await
            .unwrap();

        let kill = BlockingIo::new();
        let mut stale = test_local_session(None, Some(kill.clone()));
        let task = tokio::spawn(std::future::pending::<()>());
        let abort = task.abort_handle();
        if let super::TerminalHandle::Local { reader_handle, .. } = &mut stale.handle {
            *reader_handle = Some(task);
        }
        let cleanup_manager = manager.clone();
        let cleanup =
            tokio::spawn(async move { cleanup_manager.install_created_session(&old, stale).await });
        assert!(kill.release_after_yield().await);
        assert!(cleanup.await.unwrap().is_err());
        wait_for_task_abort(&abort).await;
        drop(current); // a completed ticket must not remove its installed session
        assert!(super::lock_pty_state(&manager.state).sessions["reused"]
            .output
            .matches(1, current_channel));
        manager.close("reused").await.unwrap();
    }

    /// Close invalidates not-yet-installed resources too; connection close must
    /// preserve other hosts' pending startups.
    #[tokio::test]
    async fn explicit_and_connection_close_invalidate_pending_creation() {
        for by_connection in [false, true] {
            let manager = super::PtyManager::new();
            let pending = manager
                .begin_creation("closed", "test-local")
                .await
                .unwrap();
            let unrelated = manager.begin_creation("other", "other-host").await.unwrap();
            if by_connection {
                manager.close_by_connection("test-local").await.unwrap();
            } else {
                manager.close("closed").await.unwrap();
            }
            assert!(manager
                .install_created_session(&pending, test_local_session(None, None))
                .await
                .is_err());
            let mut other = test_local_session(None, None);
            other.connection_id = "other-host".into();
            manager
                .install_created_session(&unrelated, other)
                .await
                .unwrap();
            manager.close("other").await.unwrap();
            assert!(super::lock_pty_state(&manager.state).pending.is_empty());
        }
    }

    /// A failed or cancelled command releases its own reservation synchronously
    /// without allowing an older ticket's Drop to erase a newer reservation.
    #[tokio::test]
    async fn creation_ticket_drop_is_exact_owner_checked() {
        let manager = super::PtyManager::new();
        let old = manager
            .begin_creation("pending", "test-local")
            .await
            .unwrap();
        let replacement = manager
            .begin_creation("pending", "test-local")
            .await
            .unwrap();
        drop(old);
        assert!(super::lock_pty_state(&manager.state)
            .pending
            .contains_key("pending"));
        drop(replacement);
        assert!(super::lock_pty_state(&manager.state).pending.is_empty());
    }

    /// Cancellation while old OS cleanup is blocked must not retain a pending
    /// ticket or remove a replacement installed by a later invocation.
    #[tokio::test(flavor = "current_thread")]
    async fn cancelled_creation_during_previous_cleanup_preserves_replacement() {
        let manager = std::sync::Arc::new(super::PtyManager::new());
        let initial = manager
            .begin_creation("reused", "test-local")
            .await
            .unwrap();
        let kill = BlockingIo::new();
        manager
            .install_created_session(&initial, test_local_session(None, Some(kill.clone())))
            .await
            .unwrap();
        let old_manager = manager.clone();
        let old =
            tokio::spawn(async move { old_manager.begin_creation("reused", "test-local").await });
        tokio::time::timeout(std::time::Duration::from_secs(3), kill.entered.notified())
            .await
            .unwrap();
        let replacement = manager
            .begin_creation("reused", "test-local")
            .await
            .unwrap();
        old.abort();
        assert!(matches!(old.await, Err(error) if error.is_cancelled()));
        kill.release_tx.send(()).unwrap();
        manager
            .install_created_session(&replacement, test_local_session(None, None))
            .await
            .unwrap();
        assert!(super::lock_pty_state(&manager.state)
            .sessions
            .contains_key("reused"));
        manager.close("reused").await.unwrap();
    }

    /// Even a remote task produced after cancellation must be aborted by the
    /// same resource cleanup path rather than becoming a detached SSH reader.
    #[tokio::test]
    async fn stale_remote_creation_aborts_its_produced_task() {
        let manager = super::PtyManager::new();
        let creation = manager
            .begin_creation("closed", "test-local")
            .await
            .unwrap();
        manager.close("closed").await.unwrap();
        let mut session = test_local_session(None, None);
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let (resize_tx, _resize_rx) = tokio::sync::mpsc::channel(1);
        let task = tokio::spawn(std::future::pending::<()>());
        let abort = task.abort_handle();
        session.handle = super::TerminalHandle::Remote {
            input: std::sync::Arc::new(super::RemoteInput::new(tx, true)),
            resize_tx,
            task_handle: Some(task),
        };
        assert!(manager
            .install_created_session(&creation, session)
            .await
            .is_err());
        wait_for_task_abort(&abort).await;
        assert!(super::lock_pty_state(&manager.state).sessions.is_empty());
    }

    /// Metadata from an old channel cannot claim deferred input or change the
    /// navigation style of a same-generation replacement, on either lock check.
    #[tokio::test]
    async fn deferred_remote_startup_rejects_same_generation_replaced_channels() {
        let manager = std::sync::Arc::new(super::PtyManager::new());
        let make_remote = || {
            let mut session = test_local_session(None, None);
            let (tx, rx) = tokio::sync::mpsc::channel(1);
            let (resize_tx, _) = tokio::sync::mpsc::channel(1);
            let input = std::sync::Arc::new(super::RemoteInput::new(tx, true));
            session.handle = super::TerminalHandle::Remote {
                input: input.clone(),
                resize_tx,
                task_handle: None,
            };
            (session, input, rx)
        };
        let (session, old_input, mut old_rx) = make_remote();
        let old_channel = session.output_channel.id();
        let initial = manager
            .begin_creation("reused", "test-local")
            .await
            .unwrap();
        manager
            .install_created_session(&initial, session)
            .await
            .unwrap();
        assert!(!manager
            .finalize_remote_startup(
                "reused",
                1,
                old_channel.wrapping_add(1),
                "windows",
                Some("cmd"),
                None,
                Some("C:\\fixture")
            )
            .await
            .unwrap());
        assert!(old_input
            .startup_pending
            .load(std::sync::atomic::Ordering::Acquire));

        let send_guard = old_input.send_gate.lock().await;
        let task_manager = manager.clone();
        let finalizer = tokio::spawn(async move {
            task_manager
                .finalize_remote_startup(
                    "reused",
                    1,
                    old_channel,
                    "windows",
                    Some("cmd"),
                    None,
                    Some("C:\\fixture"),
                )
                .await
        });
        // Wait until the finalizer holds its own Arc to the old input and is
        // parked at the send gate; no sleep or scheduling-speed assumption.
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while std::sync::Arc::strong_count(&old_input) < 3 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let replacement = manager
            .begin_creation("reused", "test-local")
            .await
            .unwrap();
        let (session, current_input, mut current_rx) = make_remote();
        manager
            .install_created_session(&replacement, session)
            .await
            .unwrap();
        drop(send_guard);
        assert!(!finalizer.await.unwrap().unwrap());
        assert!(current_input
            .startup_pending
            .load(std::sync::atomic::Ordering::Acquire));
        assert!(current_rx.try_recv().is_err());
        assert!(old_rx.try_recv().is_err());
        assert_eq!(
            super::lock_pty_state(&manager.state).sessions["reused"].navigate_shell,
            NavigateShellStyle::Posix
        );
        manager.close("reused").await.unwrap();
    }

    /// An old ACK/failure is harmless even when the terminal ID has been reused.
    #[tokio::test]
    async fn output_commands_reject_stale_generation_and_channel_owners() {
        let manager = super::PtyManager::new();
        let session = test_local_session(None, None);
        let channel_id = session.output_channel.id();
        super::lock_pty_state(&manager.state)
            .sessions
            .insert("owned".into(), session);
        manager
            .acknowledge_output("owned", 2, channel_id, u32::MAX)
            .await
            .unwrap();
        manager
            .acknowledge_output("owned", 1, channel_id.wrapping_add(1), u32::MAX)
            .await
            .unwrap();
        assert!(manager
            .acknowledge_output("owned", 1, channel_id, u32::MAX)
            .await
            .is_err());
        assert!(!manager.fail_output("owned", 2, channel_id).await.unwrap());
        assert!(!manager
            .fail_output("owned", 1, channel_id.wrapping_add(1))
            .await
            .unwrap());
        assert!(super::lock_pty_state(&manager.state)
            .sessions
            .contains_key("owned"));
        assert!(manager.fail_output("owned", 1, channel_id).await.unwrap());
        assert!(super::lock_pty_state(&manager.state).sessions.is_empty());
        manager
            .acknowledge_output("owned", 1, channel_id, 1)
            .await
            .unwrap();
    }

    /// A replacement can reuse a generation after webview reload; the channel
    /// identity must still protect natural cleanup of its installed task.
    #[tokio::test]
    async fn output_task_cleanup_requires_exact_channel_owner() {
        let manager = super::PtyManager::new();
        let mut replacement = test_local_session(None, None);
        let channel_id = replacement.output_channel.id();
        let task = tokio::spawn(std::future::pending::<()>());
        let abort = task.abort_handle();
        if let super::TerminalHandle::Local { reader_handle, .. } = &mut replacement.handle {
            *reader_handle = Some(task);
        }
        super::lock_pty_state(&manager.state)
            .sessions
            .insert("reused".into(), replacement);
        assert!(
            !super::PtyManager::finish_session(
                &manager.state,
                "reused",
                1,
                channel_id.wrapping_add(1)
            )
            .await
        );
        assert!(!abort.is_finished());
        manager.close("reused").await.unwrap();
        wait_for_task_abort(&abort).await;
    }

    /// Abort is scheduled, not synchronous; wait for its bounded completion
    /// without relying on a single scheduler turn under parallel test load.
    async fn wait_for_task_abort(handle: &tokio::task::AbortHandle) {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !handle.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("aborted test task did not finish");
    }

    /// A transport loss before the burst timer fires must preserve bytes already
    /// received, then wait for parser acknowledgment before lifecycle cleanup.
    #[tokio::test]
    async fn transport_drop_drains_pending_flush_and_timer_tail_in_order() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let channel = tauri::ipc::Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Raw(frame) = body {
                let _ = tx.send(frame);
            }
            Ok(())
        });
        let output = std::sync::Arc::new(super::PtyOutput::new(channel, 1));
        let mut policy = crate::pty_output_flush::OutputFlushPolicy::new();
        let now = tokio::time::Instant::now();
        let mut pending = super::apply_flush_instruction(policy.on_bytes(b"lead", now));
        assert!(matches!(
            policy.on_bytes(b"tail", now),
            crate::pty_output_flush::FlushInstruction::None
        ));
        let delivery = output.clone();
        let task = tokio::spawn(async move {
            super::drain_terminal_output(&delivery, &mut pending, &mut policy).await
        });
        let mut parsed = Vec::new();
        for sequence in 1..=2 {
            let frame: Vec<u8> = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
                .await
                .unwrap()
                .unwrap();
            parsed.extend_from_slice(&frame[8..]);
            assert!(!task.is_finished());
            output.acknowledge(sequence).unwrap();
        }
        tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(parsed, b"leadtail");
    }

    /// A failed OS read still publishes known bytes and waits for their parser
    /// ACK, but must not wait for a child that may still be running.
    #[tokio::test]
    async fn local_read_failure_drains_received_tail_before_reporting_error() {
        let (frames_tx, mut frames_rx) = tokio::sync::mpsc::unbounded_channel();
        let channel = tauri::ipc::Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Raw(frame) = body {
                let _ = frames_tx.send(frame);
            }
            Ok(())
        });
        let output = std::sync::Arc::new(super::PtyOutput::new(channel, 1));
        let (reader_tx, reader_rx) = tokio::sync::mpsc::channel(4);
        let (_exit_tx, exit_rx) = tokio::sync::oneshot::channel();
        reader_tx
            .send(super::LocalReaderEvent::Data(b"lead".to_vec()))
            .await
            .unwrap();
        reader_tx
            .send(super::LocalReaderEvent::Data(b"tail".to_vec()))
            .await
            .unwrap();
        reader_tx
            .send(super::LocalReaderEvent::Failed)
            .await
            .unwrap();
        let delivery = output.clone();
        let task = tokio::spawn(async move {
            super::forward_local_output(reader_rx, &delivery, exit_rx).await
        });
        let mut parsed = Vec::new();
        for sequence in 1..=2 {
            let frame: Vec<u8> =
                tokio::time::timeout(std::time::Duration::from_secs(2), frames_rx.recv())
                    .await
                    .unwrap()
                    .unwrap();
            parsed.extend_from_slice(&frame[8..]);
            assert!(!task.is_finished(), "read error overtook unparsed output");
            output.acknowledge(sequence).unwrap();
        }
        let error = tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(parsed, b"leadtail");
        assert!(error.to_string().contains("before EOF"));
    }

    /// Qualify real ConPTY handle/pipe shutdown using only an ephemeral echo
    /// process. No user shell, profile, files, credentials or SSH hosts are used.
    #[cfg(windows)]
    #[tokio::test]
    async fn windows_child_exit_closes_master_and_preserves_final_output() -> anyhow::Result<()> {
        let pair = portable_pty::native_pty_system().openpty(portable_pty::PtySize::default())?;
        let mut command = portable_pty::CommandBuilder::new("cmd.exe");
        command.args(["/d", "/c", "echo ZYNC_CONPTY_FINAL_OUTPUT"]);
        let child = pair.slave.spawn_command(command)?;
        let mut child_killer = child.clone_killer();
        drop(pair.slave);
        let reader = pair.master.try_clone_reader()?;
        let master: super::LocalMaster =
            std::sync::Arc::new(tokio::sync::Mutex::new(Some(pair.master)));
        let (tx, rx) = tokio::sync::mpsc::channel(4);
        let (exit_tx, exit_rx) = tokio::sync::oneshot::channel();
        let child_master = master.clone();
        let child_task = tokio::task::spawn_blocking(move || {
            super::wait_for_local_child(child, child_master, exit_tx)
        });
        let reader_task = tokio::task::spawn_blocking(move || super::read_local_output(reader, tx));
        let (frames_tx, mut frames_rx) = tokio::sync::mpsc::unbounded_channel();
        let channel = tauri::ipc::Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Raw(frame) = body {
                let _ = frames_tx.send(frame);
            }
            Ok(())
        });
        let output = std::sync::Arc::new(super::PtyOutput::new(channel, 1));
        let delivery = output.clone();
        let mut forwarding =
            tokio::spawn(async move { super::forward_local_output(rx, &delivery, exit_rx).await });
        let mut bytes = Vec::new();
        let result = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                tokio::select! {
                    frame = frames_rx.recv() => {
                        let frame: Vec<u8> = frame.ok_or_else(|| anyhow::anyhow!("test frame channel closed"))?;
                        bytes.extend_from_slice(&frame[8..]);
                        output.acknowledge(u32::from_le_bytes(frame[4..8].try_into().unwrap()))?;
                    }
                    result = &mut forwarding => return result?,
                }
            }
        }).await;
        if !matches!(&result, Ok(Ok(_))) {
            output.close();
            if result.is_err() {
                forwarding.abort();
                let _ = forwarding.await;
            }
            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                tokio::task::spawn_blocking(move || {
                    let _ = child_killer.kill();
                    drop(master.blocking_lock().take());
                }),
            )
            .await??;
        }
        tokio::time::timeout(std::time::Duration::from_secs(3), child_task).await??;
        tokio::time::timeout(std::time::Duration::from_secs(3), reader_task).await??;
        let exit_code = result??;
        assert_eq!(exit_code, Some(0));
        assert!(String::from_utf8_lossy(&bytes).contains("ZYNC_CONPTY_FINAL_OUTPUT"));
        Ok(())
    }

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
            RemoteWaitAction::RecordExit { exit_code: Some(0) }
        );
    }

    #[test]
    fn remote_wait_none_is_transport_drop() {
        assert_eq!(remote_wait_action(None), RemoteWaitAction::TransportDrop);
    }

    /// Only receive exhaustion uses recorded exit evidence to classify connection scope.
    #[test]
    fn remote_receive_exhaustion_preserves_recorded_exit_and_connection_scope() {
        for (recorded_exit, expected_code, expected_transport_drop) in [
            (None, None, true),
            (Some(Some(0)), Some(0), false),
            (Some(Some(23)), Some(23), false),
            (Some(None), None, false),
        ] {
            assert_eq!(
                super::remote_io_completion(recorded_exit),
                (expected_transport_drop, Some(expected_code)),
            );
        }
    }

    /// Sender failure cannot replace queued peer-close evidence with a host-loss decision.
    #[tokio::test]
    async fn remote_peer_close_leaves_exit_messages_readable_after_writer_failure() {
        use russh::{client, server};
        use std::sync::Arc;
        use tokio::io::AsyncWriteExt;

        struct Client {
            key: russh::keys::PublicKey,
            closed: Arc<tokio::sync::Notify>,
        }
        impl client::Handler for Client {
            type Error = russh::Error;
            async fn check_server_key(
                &mut self,
                key: &russh::keys::PublicKeyOrCertificate,
            ) -> Result<bool, Self::Error> {
                Ok(
                    matches!(key, russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } if key == &self.key),
                )
            }
            async fn channel_close(
                &mut self,
                _: russh::ChannelId,
                _: &mut client::Session,
            ) -> Result<(), Self::Error> {
                self.closed.notify_one();
                Ok(())
            }
        }
        struct Server;
        impl server::Handler for Server {
            type Error = russh::Error;
            async fn auth_none(&mut self, _: &str) -> Result<server::Auth, Self::Error> {
                Ok(server::Auth::Accept)
            }
            async fn channel_open_session(
                &mut self,
                _: russh::Channel<server::Msg>,
                reply: server::ChannelOpenHandle,
                _: &mut server::Session,
            ) -> Result<(), Self::Error> {
                reply.accept().await;
                Ok(())
            }
            async fn exec_request(
                &mut self,
                channel: russh::ChannelId,
                command: &[u8],
                session: &mut server::Session,
            ) -> Result<(), Self::Error> {
                if command == b"with-status" {
                    session.exit_status_request(channel, 23)?;
                }
                session.data(channel, b"final output".to_vec())?;
                session.eof(channel)?;
                session.close(channel)?;
                Ok(())
            }
        }
        struct ServerTask(tokio::task::JoinHandle<()>);
        impl Drop for ServerTask {
            fn drop(&mut self) {
                self.0.abort();
            }
        }

        let key = russh::keys::PrivateKey::random(
            &mut russh::keys::key::safe_rng(),
            russh::keys::Algorithm::Ed25519,
        )
        .unwrap();
        let expected = key.public_key().clone();
        let config = Arc::new(server::Config {
            keys: vec![key],
            ..Default::default()
        });
        let (local, remote) = tokio::io::duplex(64 * 1024);
        let _server = ServerTask(tokio::spawn(async move {
            let running = server::run_stream(config, remote, Server).await.unwrap();
            let _ = running.await;
        }));
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            let closed = Arc::new(tokio::sync::Notify::new());
            let mut client = client::connect_stream(
                Arc::new(client::Config::default()),
                local,
                Client {
                    key: expected,
                    closed: closed.clone(),
                },
            )
            .await
            .unwrap();
            assert!(client.authenticate_none("fixture").await.unwrap().success());

            let mut pending = Vec::new();
            for status in [Some(23), None] {
                let channel = client.channel_open_session().await.unwrap();
                channel
                    .exec(
                        false,
                        if status.is_some() {
                            "with-status"
                        } else {
                            "without-status"
                        },
                    )
                    .await
                    .unwrap();
                // Handler notification follows removal of this channel's receive sender.
                // No channel.wait() has run, so all received messages remain queued.
                closed.notified().await;
                pending.push((status, channel));
            }
            // Peer Close alone leaves the shared transport usable. A subsequent
            // transport shutdown fails senders before queued receive evidence drains.
            let mut live = client.channel_open_session().await.unwrap();
            client
                .disconnect(russh::Disconnect::ByApplication, "fixture shutdown", "")
                .await
                .unwrap();
            while !client.is_closed() {
                tokio::task::yield_now().await;
            }
            for (status, channel) in pending {
                let mut writer = Box::pin(channel.make_writer());
                assert_eq!(
                    writer.write_all(b"late input").await.unwrap_err().kind(),
                    std::io::ErrorKind::BrokenPipe
                );
                assert!(channel.window_change(120, 40, 0, 0).await.is_err());

                let (mut reader, _) = channel.split();
                let mut recorded_exit = None;
                let mut tail = Vec::new();
                loop {
                    let message = reader.wait().await;
                    match remote_wait_action(message.as_ref()) {
                        RemoteWaitAction::BufferOutput => {
                            if let Some(ChannelMsg::Data { data }) = message {
                                tail.extend_from_slice(data.as_ref());
                            }
                        }
                        RemoteWaitAction::RecordExit { exit_code } => {
                            recorded_exit = Some(exit_code)
                        }
                        RemoteWaitAction::PaneExit { .. } => break,
                        RemoteWaitAction::TransportDrop => {
                            panic!("peer close misclassified as host loss")
                        }
                        RemoteWaitAction::KeepWaiting => {}
                    }
                }
                assert_eq!(recorded_exit, status.map(Some));
                assert_eq!(tail, b"final output");
                assert!(reader.wait().await.is_none());
            }
            // This pane received no peer Close: receive exhaustion is host loss.
            assert_eq!(
                remote_wait_action(live.wait().await.as_ref()),
                RemoteWaitAction::TransportDrop
            );
        })
        .await
        .unwrap();
    }

    #[test]
    fn remote_wait_missing_follow_up_after_eof_is_wait_none() {
        // After CHANNEL_EOF, wait() still yields Close / ExitStatus,
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
