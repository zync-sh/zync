//! Background task: stop all tunnels when the SSH session becomes unusable.

use super::commands::stop_tunnels_for_connections;
use crate::commands::AppState;
use std::collections::HashSet;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, Mutex};

pub type SessionFailureSender = mpsc::UnboundedSender<String>;

pub fn session_failure_channel() -> (SessionFailureSender, mpsc::UnboundedReceiver<String>) {
    mpsc::unbounded_channel()
}

/// True when the SSH session is dead and tunnel I/O will keep failing until reconnect.
pub fn is_ssh_session_fatal_error(error: &impl std::fmt::Display) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    const FATAL_PATTERNS: &[&str] = &[
        "channel send error",
        "connection reset",
        "connection aborted",
        "broken pipe",
        "not connected",
        "transport",
        "eof",
        "session closed",
        "connection closed",
        "disconnected",
        "shut down",
    ];
    FATAL_PATTERNS.iter().any(|pattern| message.contains(pattern))
}

pub fn spawn_session_failure_watcher(
    app: AppHandle,
    mut receiver: mpsc::UnboundedReceiver<String>,
) {
    let in_flight: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));

    tauri::async_runtime::spawn(async move {
        while let Some(connection_id) = receiver.recv().await {
            {
                let mut guard = in_flight.lock().await;
                if !guard.insert(connection_id.clone()) {
                    continue;
                }
            }

            if let Some(state) = app.try_state::<AppState>() {
                let _ = stop_tunnels_for_connections(&app, &state, &[connection_id.clone()]).await;
                let _ = app.emit(
                    "connection:transport-lost",
                    serde_json::json!({ "connectionId": connection_id }),
                );
            }

            in_flight.lock().await.remove(&connection_id);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::is_ssh_session_fatal_error;

    #[test]
    fn detects_channel_send_error_as_fatal() {
        assert!(is_ssh_session_fatal_error(&"Channel send error"));
    }

    #[test]
    fn ignores_benign_copy_close() {
        assert!(!is_ssh_session_fatal_error(&"channel closed"));
    }
}