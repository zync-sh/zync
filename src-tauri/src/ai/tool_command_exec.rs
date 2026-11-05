use crate::ai::tool_exec_support::{
    emit_output, OutputCapture, MAX_ARTIFACT_BYTES, MAX_OUTPUT_BYTES,
};
use crate::ai::tools::ToolContext;
use crate::ai::util::COMMAND_TIMEOUT;
use crate::ssh_command::SshSession;
use std::process::Stdio;
use tokio::io::{AsyncRead, AsyncReadExt};

mod process;
use process::OwnedProcess;

/// Executes a tool command with bounded model/UI output and an optional capped artifact.
pub(crate) async fn exec_command(
    ctx: &ToolContext<'_>,
    cmd: &str,
    tool_call_id: &str,
) -> Result<String, String> {
    if let Some(conn_id) = ctx.connection_id {
        let session_arc = {
            let conns = ctx.connections.lock().await;
            let handle = conns.get(conn_id).ok_or_else(|| {
                format!(
                    "SSH connection '{}' not found. Reconnect and try again.",
                    conn_id
                )
            })?;
            handle
                .session
                .as_ref()
                .ok_or_else(|| "SSH session is not active. Reconnect and try again.".to_string())?
                .clone()
        };
        return exec_ssh(
            ctx.app,
            ctx.session_dir.as_deref(),
            session_arc,
            cmd,
            ctx.run_id,
            tool_call_id,
        )
        .await;
    }

    exec_local(
        ctx.app,
        ctx.session_dir.as_deref(),
        cmd,
        ctx.run_id,
        tool_call_id,
    )
    .await
}

/// Executes an internal probe without emitting events or retaining unbounded diagnostics.
pub(crate) async fn exec_silent(ctx: &ToolContext<'_>, cmd: &str) -> Result<String, String> {
    Ok(exec_silent_capture(ctx, cmd, MAX_OUTPUT_BYTES)
        .await?
        .finish(None, None)
        .await)
}

/// Captures a bounded internal read while retaining whether its complete content was available.
pub(crate) async fn exec_silent_capture(
    ctx: &ToolContext<'_>,
    cmd: &str,
    limit: usize,
) -> Result<OutputCapture, String> {
    if let Some(conn_id) = ctx.connection_id {
        let session_arc = {
            let conns = ctx.connections.lock().await;
            let handle = conns
                .get(conn_id)
                .ok_or_else(|| format!("SSH connection '{}' not found.", conn_id))?;
            handle
                .session
                .as_ref()
                .ok_or_else(|| "SSH session is not active.".to_string())?
                .clone()
        };
        return capture_ssh(session_arc, cmd, limit, None).await;
    }

    run_local_process(cmd, limit).await
}

/// Streams only a bounded prefix to the UI while collecting a bounded SSH diagnostic artifact.
async fn exec_ssh(
    app: &tauri::AppHandle,
    session_dir: Option<&std::path::Path>,
    session: SshSession,
    cmd: &str,
    run_id: &str,
    tool_call_id: &str,
) -> Result<String, String> {
    let output = capture_ssh(
        session,
        cmd,
        MAX_ARTIFACT_BYTES,
        Some((app, run_id, tool_call_id)),
    )
    .await?;
    Ok(output.finish(session_dir, Some(tool_call_id)).await)
}

/// Drains an owned SSH command even after capture/UI limits have been reached.
async fn capture_ssh(
    session: SshSession,
    cmd: &str,
    limit: usize,
    live: Option<(&tauri::AppHandle, &str, &str)>,
) -> Result<OutputCapture, String> {
    let mut output = OutputCapture::new(limit);
    let exit_code = crate::ssh_command::run(session, cmd, None, COMMAND_TIMEOUT, |stream, data| {
        output.push(stream, data);
        if let Some((app, run_id, call_id)) = live {
            let chunk = output.take_live_chunk();
            if !chunk.is_empty() {
                emit_output(app, run_id, call_id, &chunk);
            }
        }
    })
    .await?;
    output.flush();
    if let Some(code) = exit_code {
        if code != 0 {
            output.push_text(&format!("\n[Exit code: {}]", code));
        }
    }
    if let Some((app, run_id, call_id)) = live {
        let chunk = output.take_live_chunk();
        if !chunk.is_empty() {
            emit_output(app, run_id, call_id, &chunk);
        }
    }
    Ok(output)
}

/// Emits the bounded local result after concurrent stdout/stderr drainage and artifact finalization.
async fn exec_local(
    app: &tauri::AppHandle,
    session_dir: Option<&std::path::Path>,
    cmd: &str,
    run_id: &str,
    tool_call_id: &str,
) -> Result<String, String> {
    let output = run_local_process(cmd, MAX_ARTIFACT_BYTES).await?;
    let capped = output.finish(session_dir, Some(tool_call_id)).await;
    if !capped.is_empty() {
        emit_output(app, run_id, tool_call_id, &capped);
    }
    Ok(capped)
}

/// Drains one pipe through a fixed-size scratch buffer without storing unlimited process output.
async fn capture_reader(
    mut reader: impl AsyncRead + Unpin,
    limit: usize,
) -> Result<OutputCapture, String> {
    let mut capture = OutputCapture::new(limit);
    let mut buffer = [0; MAX_OUTPUT_BYTES];
    loop {
        let length = reader
            .read(&mut buffer)
            .await
            .map_err(|error| format!("Failed to read process output: {error}"))?;
        if length == 0 {
            capture.flush();
            return Ok(capture);
        }
        capture.push(0, &buffer[..length]);
    }
}

/// Preserves stdout-before-stderr formatting and exit annotations using bounded captures.
fn combine_process_captures(
    mut stdout: OutputCapture,
    mut stderr: OutputCapture,
    status: std::process::ExitStatus,
) -> OutputCapture {
    if stderr.complete_text() != Some("") {
        if stdout.complete_text() == Some("") {
            stdout = stderr;
        } else {
            stdout.trim_end();
            stderr.trim_end();
            stdout.push_text("\n");
            stdout.append(stderr);
        }
    }
    if !status.success() {
        stdout.trim_end();
        if stdout.complete_text() != Some("") {
            stdout.push_text(" ");
        }
        stdout.push_text(&format!("[Exit code: {}]", status.code().unwrap_or(-1)));
    }
    stdout
}

/// Waits for a process while independently draining both pipes; stdin remains closed like output().
async fn capture_process(
    command: &mut tokio::process::Command,
    limit: usize,
) -> Result<OutputCapture, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut owned = OwnedProcess::spawn(command)?;
    let stdout = owned.child_mut().stdout.take().expect("piped stdout");
    let stderr = owned.child_mut().stderr.take().expect("piped stderr");
    let (stdout, stderr) =
        tokio::try_join!(capture_reader(stdout, limit), capture_reader(stderr, limit),)?;
    // Keep the leader PID reserved until all inherited pipes have closed. Once
    // wait returns, synchronous disarm runs before cancellation can interrupt us.
    let status = owned
        .child_mut()
        .wait()
        .await
        .map_err(|error| format!("Failed to wait for process: {error}"))?;
    owned.complete()?;
    Ok(combine_process_captures(stdout, stderr, status))
}

/// Applies the existing command deadline to bounded pipe collection and process completion.
async fn run_local_process(cmd: &str, limit: usize) -> Result<OutputCapture, String> {
    let result = tokio::time::timeout(COMMAND_TIMEOUT, async {
        let mut command = if cfg!(target_os = "windows") {
            let mut command = tokio::process::Command::new("cmd");
            command.args(["/C", cmd]);
            command
        } else {
            let mut command = tokio::process::Command::new("sh");
            command.args(["-c", cmd]);
            command
        };
        capture_process(&mut command, limit).await
    })
    .await;

    match result {
        Ok(inner) => inner,
        Err(_) => Err(format!(
            "Command timed out after {}s. Consider breaking it into smaller steps.",
            COMMAND_TIMEOUT.as_secs()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::{capture_process, combine_process_captures, run_local_process};
    use crate::ai::tool_exec_support::{OutputCapture, MAX_ARTIFACT_BYTES, MAX_OUTPUT_BYTES};
    use crate::ai::util::COMMAND_TIMEOUT;

    fn capture(text: &str) -> OutputCapture {
        let mut output = OutputCapture::new(MAX_OUTPUT_BYTES);
        output.push_text(text);
        output
    }

    fn status(code: i32) -> std::process::ExitStatus {
        #[cfg(windows)]
        {
            use std::os::windows::process::ExitStatusExt;
            std::process::ExitStatus::from_raw(code as u32)
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            std::process::ExitStatus::from_raw(code << 8)
        }
    }

    #[tokio::test]
    async fn combines_successful_stdout_and_stderr() {
        let combined = combine_process_captures(capture("out"), capture("err"), status(0))
            .finish(None, None)
            .await;
        assert_eq!(combined, "out\nerr");
    }

    #[tokio::test]
    async fn returns_combined_output_for_failed_process() {
        let output = combine_process_captures(capture("out"), capture("err"), status(12))
            .finish(None, None)
            .await;
        assert_eq!(output, "out\nerr [Exit code: 12]");
    }

    #[tokio::test]
    #[cfg_attr(windows, ignore = "sleep is not reliable on Windows cmd")]
    async fn command_times_out_after_30_seconds() {
        let expected_timeout = COMMAND_TIMEOUT.as_secs();
        let start = std::time::Instant::now();
        let result = run_local_process("sleep 60", MAX_OUTPUT_BYTES).await;
        let elapsed = start.elapsed().as_secs();

        assert!(result.is_err(), "Expected timeout error");
        let err = result.unwrap_err();
        assert!(
            err.contains("timed out"),
            "Expected timeout message, got: {}",
            err
        );
        assert!(err.contains(&expected_timeout.to_string()));
        assert!(
            elapsed >= expected_timeout.saturating_sub(1) && elapsed <= expected_timeout + 5,
            "Timeout should fire around {}s, was {}s",
            expected_timeout,
            elapsed
        );
    }

    #[tokio::test]
    async fn fast_command_completes_without_timeout() {
        let result = run_local_process("echo hello", MAX_OUTPUT_BYTES).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().finish(None, None).await.trim(), "hello");
    }

    #[test]
    fn process_output_fixture() {
        if std::env::var("ZYNC_AI_OUTPUT_FIXTURE").as_deref() != Ok("1") {
            return;
        }
        use std::io::{Read, Write};
        let mut stdin = Vec::new();
        std::io::stdin().read_to_end(&mut stdin).unwrap();
        assert!(stdin.is_empty(), "the output runner must close stdin");
        let stdout = std::thread::spawn(|| {
            let mut stdout = std::io::stdout().lock();
            stdout.write_all(b"stdout-head\n").unwrap();
            for _ in 0..256 {
                stdout.write_all(&[b'O'; MAX_OUTPUT_BYTES]).unwrap();
            }
            stdout.write_all(b"stdout-tail").unwrap();
        });
        let stderr = std::thread::spawn(|| {
            let mut stderr = std::io::stderr().lock();
            for _ in 0..256 {
                stderr.write_all(&[b'E'; MAX_OUTPUT_BYTES]).unwrap();
            }
            stderr.write_all(b"final-stderr-diagnostic").unwrap();
        });
        stdout.join().unwrap();
        stderr.join().unwrap();
        std::process::exit(7);
    }

    #[tokio::test]
    async fn concurrent_process_pipes_drain_after_limits_and_keep_stderr_and_exit_status() {
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "ai::tool_command_exec::tests::process_output_fixture",
                "--nocapture",
            ])
            .env("ZYNC_AI_OUTPUT_FIXTURE", "1");
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            capture_process(&mut command, MAX_ARTIFACT_BYTES),
        )
        .await
        .expect("both pipes must drain after their capture limits")
        .unwrap()
        .finish(None, None)
        .await;
        assert!(output.contains("stdout-head"));
        assert!(output.contains("final-stderr-diagnostic"));
        assert!(output.ends_with("[Exit code: 7]"));
        assert!(output.len() < MAX_OUTPUT_BYTES + 512);
    }

    #[test]
    fn process_tree_fixture() {
        let Ok(mode) = std::env::var("ZYNC_AI_PROCESS_FIXTURE") else {
            return;
        };
        use std::io::{Read, Write};
        use std::process::Stdio;

        let address = std::env::var("ZYNC_AI_PROCESS_ADDRESS").unwrap();
        if mode == "descendant" {
            let mut socket = std::net::TcpStream::connect(address).unwrap();
            socket.write_all(b"D").unwrap();
            let mut request = [0];
            while socket.read_exact(&mut request).is_ok() {
                match request[0] {
                    b'Q' => break,
                    b'P' => socket.write_all(b"P").unwrap(),
                    _ => panic!("unexpected process fixture request"),
                }
            }
            std::process::exit(0);
        }
        let mut descendant = std::process::Command::new(std::env::current_exe().unwrap());
        descendant
            .args([
                "--exact",
                "ai::tool_command_exec::tests::process_tree_fixture",
                "--nocapture",
            ])
            .env("ZYNC_AI_PROCESS_FIXTURE", "descendant")
            .stdin(Stdio::null());
        if mode == "detach" {
            descendant.stdout(Stdio::null()).stderr(Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::io::AsRawHandle;
                use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT};

                // NUL stdio alone does not exclude other inheritable handles from
                // CreateProcess. Make this fixture a genuinely detached service.
                for handle in [
                    std::io::stdout().as_raw_handle(),
                    std::io::stderr().as_raw_handle(),
                ] {
                    // SAFETY: these handles belong to this disposable fixture's stdio;
                    // changing inheritance does not close or transfer either handle.
                    assert_ne!(
                        unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) },
                        0
                    );
                }
            }
        }
        let _descendant = descendant.spawn().unwrap();
        if mode == "detach" {
            let code = std::env::var("ZYNC_AI_PROCESS_EXIT")
                .unwrap()
                .parse()
                .unwrap();
            std::process::exit(code);
        }
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    }

    fn tree_command(address: std::net::SocketAddr, mode: &str) -> tokio::process::Command {
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "ai::tool_command_exec::tests::process_tree_fixture",
                "--nocapture",
            ])
            .env("ZYNC_AI_PROCESS_FIXTURE", mode)
            .env("ZYNC_AI_PROCESS_ADDRESS", address.to_string());
        command
    }

    async fn descendant_socket(listener: &tokio::net::TcpListener) -> tokio::net::TcpStream {
        use tokio::io::AsyncReadExt;
        let (mut socket, _) =
            tokio::time::timeout(std::time::Duration::from_secs(10), listener.accept())
                .await
                .expect("fixture descendant must connect")
                .unwrap();
        let mut ready = [0];
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            socket.read_exact(&mut ready),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(ready, *b"D");
        socket
    }

    async fn descendant_closed(mut socket: tokio::net::TcpStream) {
        use tokio::io::AsyncReadExt;
        let mut data = [0];
        match tokio::time::timeout(std::time::Duration::from_secs(10), socket.read(&mut data))
            .await
            .expect("cancelled descendant must release its socket")
        {
            Ok(0) => {}
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
            other => panic!("descendant still active or unexpected socket result: {other:?}"),
        }
    }

    #[tokio::test]
    async fn timeout_and_dropped_execution_terminate_owned_descendants() {
        for timed_out in [false, true] {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .unwrap();
            let mut command = tree_command(listener.local_addr().unwrap(), "wait");
            let mut execution = Box::pin(capture_process(&mut command, MAX_OUTPUT_BYTES));
            let first = futures_util::poll!(&mut execution);
            assert!(first.is_pending(), "fixture must remain active: {first:?}");
            let socket = descendant_socket(&listener).await;
            if timed_out {
                assert!(tokio::time::timeout(std::time::Duration::ZERO, execution)
                    .await
                    .is_err());
            } else {
                drop(execution);
            }
            descendant_closed(socket).await;
        }
    }

    #[tokio::test]
    async fn normal_completion_preserves_intentionally_detached_descendants_even_on_nonzero_exit() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for exit in [0, 7] {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .unwrap();
            let mut command = tree_command(listener.local_addr().unwrap(), "detach");
            command.env("ZYNC_AI_PROCESS_EXIT", exit.to_string());
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(10),
                capture_process(&mut command, MAX_OUTPUT_BYTES),
            )
            .await
            .unwrap()
            .unwrap()
            .finish(None, None)
            .await;
            let mut socket = descendant_socket(&listener).await;
            socket.write_all(b"P").await.unwrap();
            let mut reply = [0];
            tokio::time::timeout(
                std::time::Duration::from_secs(10),
                socket.read_exact(&mut reply),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(
                reply, *b"P",
                "normal completion must not kill a detached service"
            );
            socket.write_all(b"Q").await.unwrap();
            descendant_closed(socket).await;
            assert_eq!(result.contains("[Exit code: 7]"), exit == 7);
        }
    }
}
