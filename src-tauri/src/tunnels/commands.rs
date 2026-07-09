use crate::commands::{get_data_dir, AppState};
use super::manager::probe_ssh_session;
use super::{remote_forward_map_key, tunnel_runtime_id};
use crate::types::{SavedTunnel, SavedTunnelsData};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

#[derive(Debug, Serialize, Clone)]
pub struct TunnelStatusChange {
    pub id: String,
    pub status: String,
    pub error: Option<String>,
}

fn connection_has_live_session(
    connections: &std::collections::HashMap<String, crate::commands::ConnectionHandle>,
    connection_id: &str,
) -> bool {
    connections
        .get(connection_id)
        .and_then(|handle| handle.session.as_ref())
        .is_some()
}

/// Tear down runtime listeners when the SSH session is gone but listeners were left behind.
pub(crate) async fn reconcile_stale_tunnel_runtime(
    app: &AppHandle,
    state: &AppState,
    connection_ids: &[String],
) {
    if connection_ids.is_empty() {
        return;
    }

    let data_dir = get_data_dir(app);
    let file_path = data_dir.join("tunnels.json");
    if !file_path.exists() {
        return;
    }

    let saved_data: SavedTunnelsData = match std::fs::read_to_string(&file_path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
    {
        Some(data) => data,
        None => return,
    };

    let id_set: HashSet<&str> = connection_ids.iter().map(String::as_str).collect();

    let session_alive_by_connection: HashMap<String, bool> = {
        let connections = state.connections.lock().await;
        connection_ids
            .iter()
            .map(|connection_id| {
                (
                    connection_id.clone(),
                    connection_has_live_session(&connections, connection_id),
                )
            })
            .collect()
    };

    let (local_runtime_keys, remote_runtime_keys) = {
        let local_listeners = state.tunnel_manager.local_listeners.lock().await;
        let remote_forwards = state.tunnel_manager.remote_forwards.lock().await;
        (
            local_listeners.keys().cloned().collect::<HashSet<_>>(),
            remote_forwards.keys().cloned().collect::<HashSet<_>>(),
        )
    };

    let stale_tunnels: Vec<SavedTunnel> = saved_data
        .tunnels
        .into_iter()
        .filter(|tunnel| {
            if !id_set.contains(tunnel.connection_id.as_str()) {
                return false;
            }
            let has_session = session_alive_by_connection
                .get(&tunnel.connection_id)
                .copied()
                .unwrap_or(false);
            !has_session
                && tunnel_is_active_runtime(
                    tunnel,
                    &local_runtime_keys,
                    &remote_runtime_keys,
                )
        })
        .collect();

    for tunnel in stale_tunnels {
        let _ = state.tunnel_manager.stop_tunnel(None, &tunnel).await;
        let _ = app.emit(
            "tunnel:status-change",
            TunnelStatusChange {
                id: tunnel.id,
                status: "stopped".to_string(),
                error: None,
            },
        );
    }
}

async fn apply_runtime_tunnel_status(
    app: &AppHandle,
    state: &AppState,
    tunnels: &mut [SavedTunnel],
) {
    if tunnels.is_empty() {
        return;
    }

    let connection_ids: Vec<String> = tunnels
        .iter()
        .map(|tunnel| tunnel.connection_id.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();

    reconcile_stale_tunnel_runtime(app, state, &connection_ids).await;

    let sessions_by_connection: HashMap<String, Arc<Mutex<russh::client::Handle<crate::ssh::Client>>>> =
        {
            let connections = state.connections.lock().await;
            connection_ids
                .iter()
                .filter_map(|connection_id| {
                    connections
                        .get(connection_id)
                        .and_then(|handle| handle.session.clone())
                        .map(|session| (connection_id.clone(), session))
                })
                .collect()
        };

    let (local_runtime_keys, remote_runtime_keys) = {
        let local_listeners = state.tunnel_manager.local_listeners.lock().await;
        let remote_forwards = state.tunnel_manager.remote_forwards.lock().await;
        (
            local_listeners.keys().cloned().collect::<HashSet<_>>(),
            remote_forwards.keys().cloned().collect::<HashSet<_>>(),
        )
    };

    let active_connection_ids: HashSet<String> = tunnels
        .iter()
        .filter(|tunnel| {
            tunnel_is_active_runtime(tunnel, &local_runtime_keys, &remote_runtime_keys)
        })
        .map(|tunnel| tunnel.connection_id.clone())
        .collect();

    let mut dead_connections = Vec::new();
    for connection_id in active_connection_ids {
        let usable = match sessions_by_connection.get(&connection_id) {
            Some(session) => probe_ssh_session(session).await,
            None => false,
        };
        if !usable {
            dead_connections.push(connection_id);
        }
    }

    for connection_id in dead_connections {
        let _ = stop_tunnels_for_connections(app, state, &[connection_id]).await;
    }

    let session_alive_by_connection: HashMap<String, bool> = {
        let connections = state.connections.lock().await;
        connection_ids
            .iter()
            .map(|connection_id| {
                (
                    connection_id.clone(),
                    connection_has_live_session(&connections, connection_id),
                )
            })
            .collect()
    };

    let (local_runtime_keys, remote_runtime_keys) = {
        let local_listeners = state.tunnel_manager.local_listeners.lock().await;
        let remote_forwards = state.tunnel_manager.remote_forwards.lock().await;
        (
            local_listeners.keys().cloned().collect::<HashSet<_>>(),
            remote_forwards.keys().cloned().collect::<HashSet<_>>(),
        )
    };

    for tunnel in tunnels.iter_mut() {
        let has_session = session_alive_by_connection
            .get(&tunnel.connection_id)
            .copied()
            .unwrap_or(false);
        tunnel.status = Some(
            if has_session
                && tunnel_is_active_runtime(tunnel, &local_runtime_keys, &remote_runtime_keys)
            {
                "active".to_string()
            } else {
                "stopped".to_string()
            },
        );
    }
}

pub(crate) async fn stop_tunnels_for_connections(
    app: &AppHandle,
    state: &AppState,
    connection_ids: &[String],
) -> Result<(), String> {
    if connection_ids.is_empty() {
        return Ok(());
    }

    let data_dir = get_data_dir(app);
    let file_path = data_dir.join("tunnels.json");
    if !file_path.exists() {
        return Ok(());
    }

    let data = std::fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    let saved_data: SavedTunnelsData = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    let connection_id_set: HashSet<&str> = connection_ids.iter().map(String::as_str).collect();
    let tunnels_for_connection: Vec<SavedTunnel> = saved_data
        .tunnels
        .into_iter()
        .filter(|t| connection_id_set.contains(t.connection_id.as_str()))
        .collect();

    let (local_runtime_keys, remote_runtime_keys) = {
        let local_listeners = state.tunnel_manager.local_listeners.lock().await;
        let remote_forwards = state.tunnel_manager.remote_forwards.lock().await;
        (
            local_listeners.keys().cloned().collect::<HashSet<_>>(),
            remote_forwards.keys().cloned().collect::<HashSet<_>>(),
        )
    };

    let tunnels = tunnels_for_connection
        .into_iter()
        .filter(|tunnel| {
            tunnel_is_active_runtime(tunnel, &local_runtime_keys, &remote_runtime_keys)
        })
        .collect::<Vec<_>>();

    for tunnel in tunnels {
        let session = {
            let connections = state.connections.lock().await;
            connections
                .get(&tunnel.connection_id)
                .and_then(|c| c.session.clone())
        };
        let result = state
            .tunnel_manager
            .stop_tunnel(session, &tunnel)
            .await;

        let (status, error) = match result {
            Ok(()) => ("stopped".to_string(), None),
            Err(error) => ("error".to_string(), Some(error.to_string())),
        };
        let _ = app.emit(
            "tunnel:status-change",
            TunnelStatusChange {
                id: tunnel.id,
                status,
                error,
            },
        );
    }

    Ok(())
}

#[tauri::command]
pub async fn tunnel_start_local(
    connection_id: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
    bind_address: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let session = {
        let connections = state.connections.lock().await;
        connections
            .get(&connection_id)
            .and_then(|c| c.session.clone())
            .ok_or_else(|| format!("Connection {} not found", connection_id))?
    };

    let bind_addr = bind_address.unwrap_or_else(|| "127.0.0.1".to_string());
    let runtime_id = format!(
        "local:{}:{}:{}:{}",
        connection_id,
        local_port,
        remote_host.replace(':', "_"),
        remote_port
    );

    let res: anyhow::Result<String> = state
        .tunnel_manager
        .start_local_forwarding(
            session,
            connection_id,
            runtime_id,
            bind_addr,
            local_port,
            remote_host,
            remote_port,
        )
        .await;
    res.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tunnel_start_remote(
    connection_id: String,
    remote_port: u16,
    local_host: String,
    local_port: u16,
    bind_address: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let session = {
        let connections = state.connections.lock().await;
        connections
            .get(&connection_id)
            .and_then(|c| c.session.clone())
            .ok_or_else(|| format!("Connection {} not found", connection_id))?
    };

    let bind_addr = bind_address.unwrap_or_else(|| "0.0.0.0".to_string());
    let runtime_id = format!(
        "remote:{}:{}:{}:{}",
        connection_id,
        remote_port,
        local_host.replace(':', "_"),
        local_port
    );

    let res: anyhow::Result<String> = state
        .tunnel_manager
        .start_remote_forwarding(
            session,
            connection_id,
            runtime_id,
            bind_addr,
            remote_port,
            local_host,
            local_port,
        )
        .await;
    res.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tunnel_stop(
    app: AppHandle,
    id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let data_dir = get_data_dir(&app);
    let file_path = data_dir.join("tunnels.json");
    if !file_path.exists() {
        return Ok(());
    }
    let data = std::fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    let saved_data: SavedTunnelsData = serde_json::from_str(&data).map_err(|e| e.to_string())?;

    let tunnel = saved_data
        .tunnels
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| "Tunnel key not found".to_string())?;

    let session = {
        let connections = state.connections.lock().await;
        connections
            .get(&tunnel.connection_id)
            .and_then(|c| c.session.clone())
    };

    println!(
        "[TUNNEL CMD] Stopping tunnel: runtime_id={}",
        tunnel_runtime_id(&tunnel)
    );
    let res = state
        .tunnel_manager
        .stop_tunnel(session, &tunnel)
        .await;

    if let Err(ref e) = res {
        let _ = app.emit(
            "tunnel:status-change",
            TunnelStatusChange {
                id: id.clone(),
                status: "error".to_string(),
                error: Some(e.to_string()),
            },
        );
    } else {
        let _ = app.emit(
            "tunnel:status-change",
            TunnelStatusChange {
                id: id.clone(),
                status: "stopped".to_string(),
                error: None,
            },
        );
    }

    res.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tunnel_list(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<SavedTunnel>, String> {
    let data_dir = get_data_dir(&app);
    let file_path = data_dir.join("tunnels.json");

    if !file_path.exists() {
        return Ok(vec![]);
    }

    let data = std::fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    let saved_data: SavedTunnelsData = serde_json::from_str(&data).map_err(|e| e.to_string())?;

    let mut tunnels: Vec<SavedTunnel> = saved_data
        .tunnels
        .into_iter()
        .filter(|t| t.connection_id == connection_id)
        .collect();

    apply_runtime_tunnel_status(&app, &state, &mut tunnels).await;

    Ok(tunnels)
}

#[tauri::command]
pub async fn tunnel_reconcile_connection(
    app: AppHandle,
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    stop_tunnels_for_connections(&app, &state, &[connection_id]).await
}

fn tunnel_is_active_runtime(
    tunnel: &SavedTunnel,
    local_runtime_keys: &HashSet<String>,
    remote_runtime_keys: &HashSet<String>,
) -> bool {
    if tunnel.tunnel_type == "local" || tunnel.tunnel_type == "dynamic" {
        local_runtime_keys.contains(&tunnel_runtime_id(tunnel))
    } else {
        let key = remote_forward_map_key(&tunnel.connection_id, tunnel.remote_port);
        remote_runtime_keys.contains(&key)
    }
}

#[tauri::command]
pub async fn tunnel_save(app: AppHandle, tunnel_val: serde_json::Value) -> Result<(), String> {
    let mut tunnel: SavedTunnel = serde_json::from_value(tunnel_val).map_err(|e| e.to_string())?;
    let data_dir = get_data_dir(&app);
    if !data_dir.exists() {
        std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    }
    let file_path = data_dir.join("tunnels.json");

    let _guard = crate::sync::domain_tunnels::TUNNELS_MUTATION_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    let mut saved = crate::sync::domain_tunnels::load_saved_tunnels(&file_path)
        .map_err(|error| error.to_string())?;

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    if let Some(idx) = saved.tunnels.iter().position(|t| t.id == tunnel.id) {
        tunnel.created_at = saved.tunnels[idx]
            .created_at
            .or(tunnel.created_at)
            .or(Some(now_ms));
        tunnel.updated_at = Some(now_ms);
        saved.tunnels[idx] = tunnel;
    } else {
        tunnel.created_at = tunnel.created_at.or(Some(now_ms));
        tunnel.updated_at = Some(now_ms);
        saved.tunnels.push(tunnel);
    }

    crate::sync::domain_tunnels::write_saved_tunnels_atomic(&file_path, &saved)
        .map_err(|error| error.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn tunnel_delete(app: AppHandle, id: String) -> Result<(), String> {
    let data_dir = get_data_dir(&app);
    let file_path = data_dir.join("tunnels.json");

    if !file_path.exists() {
        return Ok(());
    }

    let _guard = crate::sync::domain_tunnels::TUNNELS_MUTATION_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    let mut saved = crate::sync::domain_tunnels::load_saved_tunnels(&file_path)
        .map_err(|error| error.to_string())?;

    saved.tunnels.retain(|t| t.id != id);

    crate::sync::domain_tunnels::write_saved_tunnels_atomic(&file_path, &saved)
        .map_err(|error| error.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn tunnel_start(
    app: AppHandle,
    id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let data_dir = get_data_dir(&app);
    let file_path = data_dir.join("tunnels.json");
    if !file_path.exists() {
        return Err("Tunnels file not found".to_string());
    }
    let data = std::fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    let saved_data: SavedTunnelsData = serde_json::from_str(&data).map_err(|e| e.to_string())?;

    let tunnel = saved_data
        .tunnels
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| "Tunnel not found".to_string())?;

    let session = {
        let connections = state.connections.lock().await;
        connections
            .get(&tunnel.connection_id)
            .and_then(|c| c.session.clone())
            .ok_or_else(|| {
                format!(
                    "Connection {} not found or session closed",
                    tunnel.connection_id
                )
            })?
    };

    let runtime_id = tunnel_runtime_id(&tunnel);
    let res = if tunnel.tunnel_type == "dynamic" {
        let bind_addr = tunnel
            .bind_address
            .clone()
            .unwrap_or_else(|| "127.0.0.1".to_string());
        state
            .tunnel_manager
            .start_dynamic_forwarding(
                session,
                tunnel.connection_id.clone(),
                runtime_id,
                bind_addr,
                tunnel.local_port,
            )
            .await
    } else if tunnel.tunnel_type == "local" {
        let bind_addr = tunnel
            .bind_address
            .clone()
            .unwrap_or_else(|| "127.0.0.1".to_string());
        state
            .tunnel_manager
            .start_local_forwarding(
                session,
                tunnel.connection_id.clone(),
                runtime_id,
                bind_addr,
                tunnel.local_port,
                tunnel.remote_host.clone(),
                tunnel.remote_port,
            )
            .await
    } else {
        let bind_addr = tunnel
            .bind_address
            .clone()
            .unwrap_or_else(|| "0.0.0.0".to_string());
        state
            .tunnel_manager
            .start_remote_forwarding(
                session,
                tunnel.connection_id.clone(),
                runtime_id,
                bind_addr,
                tunnel.remote_port,
                tunnel.remote_host.clone(),
                tunnel.local_port,
            )
            .await
    };

    if let Err(ref e) = res {
        let _ = app.emit(
            "tunnel:status-change",
            TunnelStatusChange {
                id: id.clone(),
                status: "error".to_string(),
                error: Some(e.to_string()),
            },
        );
    } else {
        let _ = app.emit(
            "tunnel:status-change",
            TunnelStatusChange {
                id: id.clone(),
                status: "active".to_string(),
                error: None,
            },
        );
    }

    res.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tunnel_get_all(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<SavedTunnel>, String> {
    let data_dir = get_data_dir(&app);
    let file_path = data_dir.join("tunnels.json");

    if !file_path.exists() {
        return Ok(vec![]);
    }

    let data = std::fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    let saved_data: SavedTunnelsData = serde_json::from_str(&data).map_err(|e| e.to_string())?;

    let mut tunnels = saved_data.tunnels;

    apply_runtime_tunnel_status(&app, &state, &mut tunnels).await;

    Ok(tunnels)
}