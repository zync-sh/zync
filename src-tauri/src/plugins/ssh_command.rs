//! Manifest v2 commands use the pane's connection, never a plugin-supplied host.
//! The grant permits remote code execution; argv quoting is not a command sandbox.
use super::broker::PluginBrokerState;
use crate::commands::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::{atomic::Ordering, LazyLock, Mutex};
use std::time::Duration;
use tauri::{AppHandle, State};
mod output;

const DEADLINE: Duration = Duration::from_secs(20);
static RUNNING: LazyLock<Mutex<HashSet<(String, String)>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommandRequest {
    program: String,
    args: Vec<String>,
    expected_connection_token: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    stdout: String,
    stderr: String,
    exit_code: u32,
    connection_token: String,
}

struct RunningCommand((String, String));

impl RunningCommand {
    fn acquire(runtime: &str, pane: &str) -> Result<Self, String> {
        let key = (runtime.to_string(), pane.to_string());
        let mut running = RUNNING.lock().map_err(|_| "Command limiter unavailable")?;
        if running.len() >= 8 || running.contains(&key) {
            return Err(
                "A command is already running in this pane, or the command limit was reached"
                    .into(),
            );
        }
        running.insert(key.clone());
        Ok(Self(key))
    }
}

impl Drop for RunningCommand {
    fn drop(&mut self) {
        if let Ok(mut running) = RUNNING.lock() {
            running.remove(&self.0);
        }
    }
}

fn command_line(request: &CommandRequest) -> Result<String, String> {
    if request.program.is_empty() || request.program.starts_with('-') || request.args.len() > 64 {
        return Err("Invalid command program or argument count".into());
    }
    let values = std::iter::once(&request.program).chain(request.args.iter());
    let mut size = 0;
    let mut quoted = Vec::new();
    for value in values {
        size += value.len();
        if size > 16 * 1024 || value.chars().any(char::is_control) {
            return Err("Command arguments contain control characters or exceed 16 KiB".into());
        }
        quoted.push(format!("'{}'", value.replace('\'', "'\\''")));
    }
    Ok(quoted.join(" "))
}

#[tauri::command]
pub async fn plugins_ssh_command_execute(
    app: AppHandle,
    state: State<'_, AppState>,
    broker: State<'_, PluginBrokerState>,
    runtime_instance_id: String,
    pane_instance_id: String,
    request: CommandRequest,
) -> Result<CommandResult, String> {
    let command = command_line(&request)?;
    let connection_id = broker
        .authorize_pane_connection(
            &app,
            &runtime_instance_id,
            &pane_instance_id,
            "ssh.command.execute",
        )
        .map_err(|error| error.to_string())?;
    if connection_id == "local" {
        return Err("Open this plugin in an SSH workspace to run server commands".into());
    }
    let (binding_token, lease) = broker
        .pane_connection_lease(&runtime_instance_id, &pane_instance_id, &connection_id)
        .map_err(|error| error.to_string())?;
    let _running = RunningCommand::acquire(&runtime_instance_id, &pane_instance_id)?;
    let (session, generation) = {
        let connections = state.connections.lock().await;
        let connection = connections
            .get(&connection_id)
            .ok_or("The server is disconnected")?;
        (
            connection
                .session
                .clone()
                .ok_or("The server is disconnected")?,
            connection.reconnect_generation,
        )
    };
    let connection_token = format!("{binding_token}:{generation}");
    if request
        .expected_connection_token
        .as_ref()
        .is_some_and(|expected| expected != &connection_token)
    {
        return Err("The pane's server connection changed. Refresh before trying again".into());
    }
    let mut channel = tokio::time::timeout(Duration::from_secs(5), async {
        session.lock().await.channel_open_session().await
    })
    .await
    .map_err(|_| "Timed out opening server command")?
    .map_err(|error| error.to_string())?;

    let operation = async {
        if !lease.load(Ordering::Acquire) {
            return Err("Plugin pane connection changed".to_string());
        }
        channel
            .exec(true, command)
            .await
            .map_err(|error| error.to_string())?;
        let mut output = output::CommandOutput::default();
        let mut check = tokio::time::interval(Duration::from_millis(250));
        loop {
            tokio::select! {
                _ = check.tick() => {
                    let connections = state.connections.lock().await;
                    let same_session = connections.get(&connection_id)
                        .and_then(|connection| connection.session.as_ref())
                        .is_some_and(|current| std::sync::Arc::ptr_eq(current, &session));
                    if !lease.load(Ordering::Acquire) || !same_session {
                        return Err("Plugin runtime or server connection changed; command canceled".into());
                    }
                }
                message = channel.wait() => match message {
                    Some(russh::ChannelMsg::Data { data }) => output.push(&data, false)?,
                    Some(russh::ChannelMsg::ExtendedData { data, .. }) => output.push(&data, true)?,
                    Some(russh::ChannelMsg::ExitStatus { exit_status }) => output.exit_status(exit_status),
                    Some(russh::ChannelMsg::ExitSignal { .. }) => return Err("Server command terminated by a signal".into()),
                    Some(russh::ChannelMsg::Close) | None => break,
                    _ => {}, // EOF can precede exit status; wait for channel close.
                }
            }
        }
        if !lease.load(Ordering::Acquire) {
            return Err("Plugin pane connection changed".into());
        }
        let same_session = state
            .connections
            .lock()
            .await
            .get(&connection_id)
            .and_then(|connection| connection.session.as_ref())
            .is_some_and(|current| std::sync::Arc::ptr_eq(current, &session));
        if !same_session {
            return Err("The server session changed during this command".into());
        }
        // Revalidate grants and package identity before returning server data.
        broker
            .authorize(&app, &runtime_instance_id, "ssh.command.execute")
            .map_err(|error| error.to_string())?;
        output.finish(connection_token)
    };
    let result = tokio::time::timeout(DEADLINE, operation)
        .await
        .unwrap_or_else(|_| {
            Err(
                "Server command timed out after 20 seconds; its remote outcome may be unknown"
                    .into(),
            )
        });
    // Closing the SSH channel does not promise to kill a daemonized remote process.
    let _ = tokio::time::timeout(Duration::from_secs(1), channel.close()).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argv_is_quoted_not_interpolated() {
        let request = CommandRequest {
            program: "pm2".into(),
            args: vec!["restart".into(), "a'; $(touch /tmp/no)".into(), "".into()],
            expected_connection_token: None,
        };
        assert_eq!(
            command_line(&request).unwrap(),
            "'pm2' 'restart' 'a'\\''; $(touch /tmp/no)' ''"
        );
    }

    #[test]
    fn plugin_cannot_supply_a_connection_id_or_non_string_arguments() {
        for request in [
            serde_json::json!({"program":"pm2","args":[],"connectionId":"other-server"}),
            serde_json::json!({"program":"pm2","args":[0]}),
            serde_json::json!({"program":"pm2","args":[],"expectedConnectionToken":12}),
        ] {
            assert!(serde_json::from_value::<CommandRequest>(request).is_err());
        }
    }

    #[test]
    fn rejects_controls_and_unbounded_requests() {
        for value in ["bad\nname".to_string(), "\0".into(), "a".repeat(16385)] {
            assert!(command_line(&CommandRequest {
                program: "pm2".into(),
                args: vec![value],
                expected_connection_token: None
            })
            .is_err());
        }
        assert!(command_line(&CommandRequest {
            program: "-bad".into(),
            args: vec![],
            expected_connection_token: None
        })
        .is_err());
        assert!(command_line(&CommandRequest {
            program: "pm2".into(),
            args: vec!["x".into(); 65],
            expected_connection_token: None
        })
        .is_err());
    }

    #[test]
    fn one_command_per_pane_and_guard_releases_on_drop() {
        let guard = RunningCommand::acquire("test-runtime", "test-pane").unwrap();
        assert!(RunningCommand::acquire("test-runtime", "test-pane").is_err());
        drop(guard);
        assert!(RunningCommand::acquire("test-runtime", "test-pane").is_ok());
    }
}
