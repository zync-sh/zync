use std::collections::HashMap;
use std::sync::Arc;

use tauri::Emitter;
use tokio::sync::Mutex;

use crate::ai::tool_command_exec::{exec_silent, exec_ssh_silent, exec_ssh_silent_with_stdin};
use crate::ai::tool_exec_support::{cap_output, emit_output, shell_quote};
use crate::ai::tools::ToolContext;
use crate::ai::types::ToolDiffEvent;
use crate::commands::ConnectionHandle;

fn build_read_file_command(path: &str) -> String {
    format!("cat -- {}", shell_quote(path))
}

fn build_existing_file_read_command(path: &str) -> String {
    format!("cat -- {} 2>/dev/null || true", shell_quote(path))
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

pub(crate) async fn read_file(
    ctx: &ToolContext<'_>,
    path: &str,
    tool_call_id: &str,
) -> Result<String, String> {
    let content = if let Some(conn_id) = ctx.connection_id {
        {
            let conns = ctx.connections.lock().await;
            if !conns.contains_key(conn_id) {
                return Err(format!("SSH connection '{}' not found. Reconnect and try again.", conn_id));
            }
        }
        let cmd = build_read_file_command(path);
        exec_silent(ctx, &cmd).await?
    } else {
        tokio::fs::read_to_string(path)
            .await
            .map_err(|e| format!("Cannot read {}: {}", path, e))?
    };

    let capped = cap_output(ctx.session_dir.as_deref(), Some(tool_call_id), content);
    emit_output(ctx.app, ctx.run_id, tool_call_id, &capped);
    Ok(capped)
}

pub(crate) async fn write_file(
    ctx: &ToolContext<'_>,
    path: &str,
    content: &str,
    tool_call_id: &str,
) -> Result<String, String> {
    let before = if ctx.connection_id.is_some() {
        let cmd = build_existing_file_read_command(path);
        exec_silent(ctx, &cmd).await.unwrap_or_default()
    } else {
        tokio::fs::read_to_string(path).await.unwrap_or_default()
    };

    let _ = ctx.app.emit(
        "ai:tool-diff",
        ToolDiffEvent {
            run_id: ctx.run_id.to_string(),
            tool_call_id: tool_call_id.to_string(),
            path: path.to_string(),
            before: before.trim().to_string(),
            after: content.to_string(),
        },
    );

    let result = do_write_file(ctx, path, content).await;
    let message = match &result {
        Ok(_) => format!("Written: {}", path),
        Err(error) => format!("Write failed: {}", error),
    };
    emit_output(ctx.app, ctx.run_id, tool_call_id, &message);
    result.map(|_| message)
}

async fn do_write_file(
    ctx: &ToolContext<'_>,
    path: &str,
    content: &str,
) -> Result<(), String> {
    if let Some(conn_id) = ctx.connection_id {
        let conns = ctx.connections.lock().await;
        let handle = conns
            .get(conn_id)
            .ok_or_else(|| format!("SSH connection '{}' not found. Reconnect and try again.", conn_id))?;

        if let Some(parent) = std::path::Path::new(path).parent() {
            if let Some(parent_str) = parent.to_str().filter(|value| !value.is_empty()) {
                if let Some(session_arc) = &handle.session {
                    let mkdir_cmd = format!("mkdir -p {}", shell_quote(parent_str));
                    let session = session_arc.lock().await;
                    let _ = exec_ssh_silent(&session, &mkdir_cmd).await;
                }
            }
        }

        if let Some(sftp) = &handle.sftp_session {
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

        let session_arc = handle
            .session
            .as_ref()
            .ok_or_else(|| "SSH session is not active. Reconnect and try again.".to_string())?;
        use base64::{engine::general_purpose, Engine as _};
        let encoded = general_purpose::STANDARD.encode(content.as_bytes());
        let session = session_arc.lock().await;
        if should_stream_remote_write(content.len()) {
            let cmd = build_streaming_write_command(path);
            exec_ssh_silent_with_stdin(&session, &cmd, encoded.as_bytes()).await?;
        } else {
            let cmd = format!(
                "printf '%s' '{}' | base64 -d > {}",
                encoded,
                shell_quote(path)
            );
            exec_ssh_silent(&session, &cmd).await?;
        }
        return Ok(());
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

pub(crate) async fn list_files(
    ctx: &ToolContext<'_>,
    path: &str,
    tool_call_id: &str,
) -> Result<String, String> {
    let cmd = build_list_files_command(path);
    let out = exec_silent(ctx, &cmd).await?;
    let capped = cap_output(ctx.session_dir.as_deref(), Some(tool_call_id), out);
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
        build_existing_file_read_command,
        build_file_exists_command,
        build_list_files_command,
        build_read_file_command,
        build_streaming_write_command,
        should_stream_remote_write,
    };

    #[test]
    fn builds_expected_shell_commands() {
        assert_eq!(build_read_file_command("/tmp/a.txt"), "cat -- '/tmp/a.txt'");
        assert_eq!(
            build_existing_file_read_command("/tmp/a.txt"),
            "cat -- '/tmp/a.txt' 2>/dev/null || true"
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
}
