use std::collections::HashMap;
use std::sync::Arc;

use tauri::Emitter;
use tokio::sync::Mutex;

use crate::ai::tool_command_exec::{exec_silent, exec_silent_capture};
use crate::ai::tool_exec_support::{
    cap_output, emit_output, shell_quote, OutputCapture, MAX_ARTIFACT_BYTES, MAX_OUTPUT_BYTES,
    MAX_WRITE_BYTES,
};
use crate::ai::tools::ToolContext;
use crate::ai::types::ToolDiffEvent;
use crate::ai::util::COMMAND_TIMEOUT;
use crate::commands::ConnectionHandle;
use crate::ssh_command::SshSession;

/// Bounds remote file acquisition before it enters the SSH output collector.
fn build_read_file_command(path: &str, limit: usize) -> String {
    format!("head -c {} -- {}", limit + 1, shell_quote(path))
}

/// Treats missing originals like an empty new file while bounding a remote diff read.
fn build_existing_file_read_command(path: &str) -> String {
    format!(
        "{} 2>/dev/null || true",
        build_read_file_command(path, MAX_WRITE_BYTES)
    )
}

fn build_list_files_command(path: &str) -> String {
    format!("ls -la -- {}", shell_quote(path))
}

fn build_file_exists_command(path: &str) -> String {
    format!("test -e {} && echo yes || echo no", shell_quote(path))
}

const INLINE_REMOTE_WRITE_THRESHOLD: usize = 100 * 1024;

fn should_stream_remote_write(content_len: usize) -> bool {
    content_len > INLINE_REMOTE_WRITE_THRESHOLD
}

fn build_streaming_write_command(path: &str) -> String {
    format!("base64 -d > {}", shell_quote(path))
}

/// Confirm a shell write step only with an explicit zero exit status, retaining
/// stderr diagnostics on errors. Success-looking stdout is not confirmation.
async fn checked_remote_write_command(
    session: SshSession,
    command: &str,
    input: Option<&[u8]>,
    operation: &str,
) -> Result<(), String> {
    let mut stderr = OutputCapture::new(MAX_OUTPUT_BYTES);
    let status =
        crate::ssh_command::run(session, command, input, COMMAND_TIMEOUT, |stream, data| {
            if stream != 0 {
                stderr.push(1, data);
            }
        })
        .await;

    let error = match status {
        Ok(Some(0)) => return Ok(()),
        Ok(Some(code)) => format!("{operation} failed (exit code {code})"),
        Ok(None) => format!("{operation} failed: remote command did not report an exit status"),
        Err(error) => format!("{operation} failed: {error}"),
    };
    stderr.flush();
    if stderr.complete_text() == Some("") {
        Err(error)
    } else {
        Err(format!("{error}: {}", stderr.finish(None, None).await))
    }
}

/// Reads local text with a hard acquisition limit, retaining one overflow byte as evidence.
async fn read_local_capture(
    path: &str,
    limit: usize,
    missing_is_empty: bool,
) -> Result<OutputCapture, String> {
    use tokio::io::AsyncReadExt;

    let mut capture = OutputCapture::new(limit);
    let file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(error) if missing_is_empty && error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(capture);
        }
        Err(error) => return Err(format!("Cannot read {path}: {error}")),
    };
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| format!("Cannot read {path}: {error}"))?;
    if let Err(error) = std::str::from_utf8(&bytes) {
        if error.error_len().is_some() || bytes.len() <= limit {
            return Err(format!("Cannot read {path}: file is not valid UTF-8"));
        }
    }
    capture.push(0, &bytes);
    capture.flush();
    Ok(capture)
}

/// Bounds diff size and rejects lossy text; callers retain legacy missing/read-error handling.
fn prepare_diff(before: &OutputCapture, after: &str) -> Option<(String, String)> {
    if after.len() > MAX_WRITE_BYTES {
        return None;
    }
    before
        .complete_utf8_text()
        .map(|before| (before.trim().to_owned(), after.to_owned()))
}

/// Keeps an omitted-diff explanation in the authoritative success or failure result.
fn write_result_message(path: &str, result: &Result<(), String>, omission: Option<&str>) -> String {
    let mut message = match result {
        Ok(()) => format!("Written: {path}"),
        Err(error) => format!("Write failed: {error}"),
    };
    if let Some(omission) = omission {
        message.push('\n');
        message.push_str(omission);
    }
    message
}

/// Reads a bounded file prefix and emits only the small model preview, with a capped artifact.
pub(crate) async fn read_file(
    ctx: &ToolContext<'_>,
    path: &str,
    tool_call_id: &str,
) -> Result<String, String> {
    let content = if let Some(conn_id) = ctx.connection_id {
        {
            let conns = ctx.connections.lock().await;
            if !conns.contains_key(conn_id) {
                return Err(format!(
                    "SSH connection '{}' not found. Reconnect and try again.",
                    conn_id
                ));
            }
        }
        let cmd = build_read_file_command(path, MAX_ARTIFACT_BYTES);
        exec_silent_capture(ctx, &cmd, MAX_ARTIFACT_BYTES).await?
    } else {
        read_local_capture(path, MAX_ARTIFACT_BYTES, false).await?
    };

    let capped = content
        .finish(ctx.session_dir.as_deref(), Some(tool_call_id))
        .await;
    emit_output(ctx.app, ctx.run_id, tool_call_id, &capped);
    Ok(capped)
}

/// Bounds diff acquisition/IPC while preserving the actual write and explicit remote success checks.
pub(crate) async fn write_file(
    ctx: &ToolContext<'_>,
    path: &str,
    content: &str,
    tool_call_id: &str,
) -> Result<String, String> {
    let before = if ctx.connection_id.is_some() {
        let cmd = build_existing_file_read_command(path);
        exec_silent_capture(ctx, &cmd, MAX_WRITE_BYTES).await.ok()
    } else {
        read_local_capture(path, MAX_WRITE_BYTES, true).await.ok()
    };

    let omission = if let Some((before, after)) = before
        .as_ref()
        .and_then(|before| prepare_diff(before, content))
    {
        let _ = ctx.app.emit(
            "ai:tool-diff",
            ToolDiffEvent {
                run_id: ctx.run_id.to_string(),
                tool_call_id: tool_call_id.to_string(),
                path: path.to_string(),
                before,
                after,
            },
        );
        None
    } else {
        let omission = format!("Diff preview omitted: the original could not be read completely within {MAX_WRITE_BYTES} bytes, or the replacement exceeds that limit.");
        emit_output(ctx.app, ctx.run_id, tool_call_id, &omission);
        Some(omission)
    };

    let result = do_write_file(ctx, path, content).await;
    let message = write_result_message(path, &result, omission.as_deref());
    let capped = cap_output(ctx.session_dir.as_deref(), Some(tool_call_id), message).await;
    emit_output(ctx.app, ctx.run_id, tool_call_id, &capped);
    if result.is_ok() {
        Ok(capped)
    } else {
        Err(capped)
    }
}

async fn do_write_file(ctx: &ToolContext<'_>, path: &str, content: &str) -> Result<(), String> {
    if let Some(conn_id) = ctx.connection_id {
        return write_remote_file(ctx.connections, conn_id, path, content).await;
    }

    if let Some(parent) = std::path::Path::new(path).parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Cannot create parent dirs: {}", e))?;
    }
    tokio::fs::write(path, content)
        .await
        .map_err(|e| format!("Cannot write {}: {}", path, e))
}

pub(crate) async fn write_remote_file(
    connections: &Mutex<HashMap<String, ConnectionHandle>>,
    connection_id: &str,
    path: &str,
    content: &str,
) -> Result<(), String> {
    // Both handles belong to the same transport even if the registry is replaced
    // during mkdir or writing. Never retain the registry guard across network I/O.
    let (session, sftp) = {
        let conns = connections.lock().await;
        let handle = conns.get(connection_id).ok_or_else(|| {
            format!(
                "SSH connection '{}' not found. Reconnect and try again.",
                connection_id
            )
        })?;
        (handle.session.clone(), handle.sftp_session.clone())
    };

    if let Some(parent) = std::path::Path::new(path).parent() {
        if let Some(parent_str) = parent.to_str().filter(|value| !value.is_empty()) {
            if let Some(session) = &session {
                let mkdir_cmd = format!("mkdir -p {}", shell_quote(parent_str));
                checked_remote_write_command(session.clone(), &mkdir_cmd, None, "Remote mkdir")
                    .await?;
            }
        }
    }

    if let Some(sftp) = sftp {
        use tokio::io::AsyncWriteExt;

        let mut file = sftp
            .create(path)
            .await
            .map_err(|e| format!("SFTP create failed: {}", e))?;
        file.write_all(content.as_bytes())
            .await
            .map_err(|e| format!("SFTP write failed: {}", e))?;
        file.flush()
            .await
            .map_err(|e| format!("SFTP flush failed: {}", e))?;
        file.shutdown()
            .await
            .map_err(|e| format!("SFTP close failed: {}", e))?;
        return Ok(());
    }

    let session =
        session.ok_or_else(|| "SSH session is not active. Reconnect and try again.".to_string())?;
    use base64::{engine::general_purpose, Engine as _};
    let encoded = general_purpose::STANDARD.encode(content.as_bytes());
    if should_stream_remote_write(content.len()) {
        let cmd = build_streaming_write_command(path);
        checked_remote_write_command(session, &cmd, Some(encoded.as_bytes()), "Remote file write")
            .await?;
    } else {
        let cmd = format!(
            "printf '%s' '{}' | base64 -d > {}",
            encoded,
            shell_quote(path)
        );
        checked_remote_write_command(session, &cmd, None, "Remote file write").await?;
    }
    Ok(())
}

/// Caps directory-command output before formatting, artifact creation and UI emission.
pub(crate) async fn list_files(
    ctx: &ToolContext<'_>,
    path: &str,
    tool_call_id: &str,
) -> Result<String, String> {
    let cmd = build_list_files_command(path);
    let out = exec_silent_capture(ctx, &cmd, MAX_ARTIFACT_BYTES).await?;
    let capped = out
        .finish(ctx.session_dir.as_deref(), Some(tool_call_id))
        .await;
    emit_output(ctx.app, ctx.run_id, tool_call_id, &capped);
    Ok(capped)
}

pub(crate) async fn file_exists(
    app: &tauri::AppHandle,
    connections: &Arc<Mutex<HashMap<String, ConnectionHandle>>>,
    connection_id: Option<&str>,
    path: &str,
) -> bool {
    let ctx = ToolContext {
        app,
        connections,
        connection_id,
        run_id: "",
        session_dir: None,
    };
    let cmd = build_file_exists_command(path);
    match exec_silent(&ctx, &cmd).await {
        Ok(out) => out.trim() == "yes",
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_existing_file_read_command, build_file_exists_command, build_list_files_command,
        build_read_file_command, build_streaming_write_command, prepare_diff, read_local_capture,
        should_stream_remote_write, write_result_message, MAX_ARTIFACT_BYTES, MAX_WRITE_BYTES,
    };

    #[test]
    fn builds_expected_shell_commands() {
        assert_eq!(
            build_read_file_command("/tmp/a.txt", MAX_ARTIFACT_BYTES),
            format!("head -c {} -- '/tmp/a.txt'", MAX_ARTIFACT_BYTES + 1)
        );
        assert_eq!(
            build_existing_file_read_command("/tmp/a.txt"),
            format!(
                "head -c {} -- '/tmp/a.txt' 2>/dev/null || true",
                MAX_WRITE_BYTES + 1
            )
        );
        assert_eq!(build_list_files_command("/tmp/dir"), "ls -la -- '/tmp/dir'");
        assert_eq!(
            build_file_exists_command("/tmp/dir"),
            "test -e '/tmp/dir' && echo yes || echo no"
        );
        assert_eq!(
            build_streaming_write_command("/tmp/a.txt"),
            "base64 -d > '/tmp/a.txt'"
        );
        assert!(!should_stream_remote_write(100 * 1024));
        assert!(should_stream_remote_write(100 * 1024 + 1));
    }

    #[tokio::test]
    async fn bounded_file_reader_and_diff_never_claim_a_partial_original_is_complete() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("large.txt");
        std::fs::write(&path, vec![b'A'; MAX_ARTIFACT_BYTES * 4]).unwrap();
        let content = read_local_capture(path.to_str().unwrap(), MAX_ARTIFACT_BYTES, false)
            .await
            .unwrap();
        assert!(content.complete_text().is_none());
        let preview = content.finish(None, None).await;
        assert!(preview.contains(&(MAX_ARTIFACT_BYTES + 1).to_string()));
        let before = read_local_capture(path.to_str().unwrap(), MAX_WRITE_BYTES, false)
            .await
            .unwrap();
        assert!(prepare_diff(&before, "replacement").is_none());

        std::fs::write(&path, "old content\n").unwrap();
        let before = read_local_capture(path.to_str().unwrap(), MAX_WRITE_BYTES, false)
            .await
            .unwrap();
        assert_eq!(
            prepare_diff(&before, "new content"),
            Some(("old content".into(), "new content".into()))
        );
        assert!(prepare_diff(&before, &"B".repeat(MAX_WRITE_BYTES + 1)).is_none());
    }

    #[tokio::test]
    async fn bounded_file_reader_preserves_missing_and_invalid_utf8_behaviors() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("missing.txt");
        assert!(
            read_local_capture(path.to_str().unwrap(), MAX_WRITE_BYTES, false)
                .await
                .is_err()
        );
        let missing = read_local_capture(path.to_str().unwrap(), MAX_WRITE_BYTES, true)
            .await
            .unwrap();
        assert_eq!(
            prepare_diff(&missing, "new"),
            Some((String::new(), "new".into()))
        );
        std::fs::write(&path, [0xff, 0xfe]).unwrap();
        assert!(
            read_local_capture(path.to_str().unwrap(), MAX_WRITE_BYTES, false)
                .await
                .is_err()
        );
    }

    #[test]
    fn remote_like_diff_capture_rejects_lossy_bytes_but_accepts_split_valid_utf8() {
        let mut before = super::OutputCapture::new(MAX_WRITE_BYTES);
        before.push(0, &[b'A', 0xff, b'B']);
        before.flush();
        assert!(prepare_diff(&before, "replacement").is_none());

        let mut before = super::OutputCapture::new(MAX_WRITE_BYTES);
        let character = "🙂".as_bytes();
        before.push(0, &character[..2]);
        assert!(prepare_diff(&before, "replacement").is_none());
        before.push(0, &character[2..]);
        before.flush();
        assert_eq!(
            prepare_diff(&before, "new"),
            Some(("🙂".into(), "new".into()))
        );
    }

    #[test]
    fn final_write_results_keep_diff_omission_for_success_and_failure() {
        let omission = "Diff preview omitted: original exceeds the preview budget.";
        assert_eq!(
            write_result_message("file.txt", &Ok(()), Some(omission)),
            format!("Written: file.txt\n{omission}")
        );
        let failure =
            write_result_message("file.txt", &Err("permission denied".into()), Some(omission));
        assert!(failure.starts_with("Write failed: permission denied"));
        assert_eq!(failure.matches(omission).count(), 1);
        assert_eq!(
            write_result_message("file.txt", &Ok(()), None),
            "Written: file.txt"
        );
    }
}
