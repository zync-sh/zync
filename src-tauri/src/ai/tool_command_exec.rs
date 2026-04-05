use crate::ai::tool_exec_support::{cap_output, emit_output};
use crate::ai::tools::ToolContext;

pub(crate) async fn exec_command(
    ctx: &ToolContext<'_>,
    cmd: &str,
    tool_call_id: &str,
) -> Result<String, String> {
    if let Some(conn_id) = ctx.connection_id {
        let session_arc = {
            let conns = ctx.connections.lock().await;
            let handle = conns
                .get(conn_id)
                .ok_or_else(|| format!("SSH connection '{}' not found. Reconnect and try again.", conn_id))?;
            handle
                .session
                .as_ref()
                .ok_or_else(|| "SSH session is not active. Reconnect and try again.".to_string())?
                .clone()
        };
        let session = session_arc.lock().await;
        return exec_ssh(ctx.app, &session, cmd, ctx.run_id, tool_call_id).await;
    }

    exec_local(ctx.app, cmd, ctx.run_id, tool_call_id).await
}

pub(crate) async fn exec_silent(ctx: &ToolContext<'_>, cmd: &str) -> Result<String, String> {
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
        let session = session_arc.lock().await;
        return exec_ssh_silent(&session, cmd).await;
    }

    exec_local_silent(cmd).await
}

async fn exec_ssh(
    app: &tauri::AppHandle,
    session: &russh::client::Handle<crate::ssh::Client>,
    cmd: &str,
    run_id: &str,
    tool_call_id: &str,
) -> Result<String, String> {
    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("SSH channel error: {}", e))?;

    channel
        .exec(true, cmd)
        .await
        .map_err(|e| format!("SSH exec error: {}", e))?;

    let mut output = String::new();
    let mut exit_code: Option<u32> = None;
    loop {
        match channel.wait().await {
            Some(russh::ChannelMsg::Data { data }) => {
                let chunk = String::from_utf8_lossy(&data).to_string();
                emit_output(app, run_id, tool_call_id, &chunk);
                output.push_str(&chunk);
            }
            Some(russh::ChannelMsg::ExtendedData { data, .. }) => {
                let chunk = String::from_utf8_lossy(&data).to_string();
                emit_output(app, run_id, tool_call_id, &chunk);
                output.push_str(&chunk);
            }
            Some(russh::ChannelMsg::ExitStatus { exit_status }) => {
                exit_code = Some(exit_status);
            }
            None => break,
            _ => {}
        }
    }

    let mut result = cap_output(output);
    if let Some(code) = exit_code {
        if code != 0 {
            result.push_str(&format!("\n[Exit code: {}]", code));
        }
    }
    Ok(result)
}

pub(crate) async fn exec_ssh_silent(
    session: &russh::client::Handle<crate::ssh::Client>,
    cmd: &str,
) -> Result<String, String> {
    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("SSH channel error: {}", e))?;

    channel
        .exec(true, cmd)
        .await
        .map_err(|e| format!("SSH exec error: {}", e))?;

    collect_ssh_output(&mut channel).await
}

pub(crate) async fn exec_ssh_silent_with_stdin(
    session: &russh::client::Handle<crate::ssh::Client>,
    cmd: &str,
    input: &[u8],
) -> Result<String, String> {
    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("SSH channel error: {}", e))?;

    channel
        .exec(true, cmd)
        .await
        .map_err(|e| format!("SSH exec error: {}", e))?;

    channel
        .data(input)
        .await
        .map_err(|e| format!("SSH stdin send error: {}", e))?;
    channel
        .eof()
        .await
        .map_err(|e| format!("SSH stdin EOF error: {}", e))?;

    collect_ssh_output(&mut channel).await
}

async fn collect_ssh_output(
    channel: &mut russh::Channel<russh::client::Msg>,
) -> Result<String, String> {
    let mut output = String::new();
    let mut exit_code: Option<u32> = None;

    loop {
        match channel.wait().await {
            Some(russh::ChannelMsg::Data { data }) => {
                output.push_str(&String::from_utf8_lossy(&data));
            }
            Some(russh::ChannelMsg::ExtendedData { data, .. }) => {
                output.push_str(&String::from_utf8_lossy(&data));
            }
            Some(russh::ChannelMsg::ExitStatus { exit_status }) => {
                exit_code = Some(exit_status);
            }
            None => break,
            _ => {}
        }
    }

    let mut result = cap_output(output);
    if let Some(code) = exit_code {
        if code != 0 {
            result.push_str(&format!("\n[Exit code: {}]", code));
        }
    }
    Ok(result)
}

async fn exec_local(
    app: &tauri::AppHandle,
    cmd: &str,
    run_id: &str,
    tool_call_id: &str,
) -> Result<String, String> {
    let out = run_local_process(cmd).await?;
    if !out.is_empty() {
        emit_output(app, run_id, tool_call_id, &out);
    }
    Ok(cap_output(out))
}

async fn exec_local_silent(cmd: &str) -> Result<String, String> {
    run_local_process(cmd).await.map(cap_output)
}

fn combine_process_output(stdout: String, stderr: String, success: bool, code: i32) -> Result<String, String> {
    let combined = if stderr.is_empty() {
        stdout
    } else if stdout.is_empty() {
        stderr
    } else {
        format!("{}\n{}", stdout.trim_end(), stderr.trim_end())
    };

    if !success {
        let combined_with_exit_info = if combined.is_empty() {
            format!("[Exit code: {}]", code)
        } else {
            format!("{} [Exit code: {}]", combined.trim_end(), code)
        };
        return Ok(combined_with_exit_info);
    }

    Ok(combined)
}

async fn run_local_process(cmd: &str) -> Result<String, String> {
    let output = if cfg!(target_os = "windows") {
        tokio::process::Command::new("cmd")
            .args(["/C", cmd])
            .output()
            .await
    } else {
        tokio::process::Command::new("sh")
            .args(["-c", cmd])
            .output()
            .await
    }
    .map_err(|e| format!("Failed to spawn process: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    combine_process_output(stdout, stderr, output.status.success(), output.status.code().unwrap_or(-1))
}

#[cfg(test)]
mod tests {
    use super::combine_process_output;

    #[test]
    fn combines_successful_stdout_and_stderr() {
        let combined = combine_process_output("out".into(), "err".into(), true, 0).unwrap();
        assert_eq!(combined, "out\nerr");
    }

    #[test]
    fn returns_combined_output_for_failed_process() {
        let output = combine_process_output("out".into(), "err".into(), false, 12).unwrap();
        assert_eq!(output, "out\nerr [Exit code: 12]");
    }
}
