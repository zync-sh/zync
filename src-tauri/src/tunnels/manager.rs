use crate::ssh::Client;
use crate::tunnels::dynamic;
use crate::tunnels::session_failure::{is_ssh_session_fatal_error, SessionFailureSender};
use crate::types::SavedTunnel;
use anyhow::{anyhow, Result};
use log::warn;
use russh::client::Handle;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::Mutex;

const SESSION_PROBE_INTERVAL_SECS: u64 = 15;
pub(crate) const SSH_SESSION_PROBE_TIMEOUT: Duration = Duration::from_secs(8);

/// Bounded liveness probe — opens and closes a session channel without wedging on stalled transports.
pub(crate) async fn probe_ssh_session(session: &Arc<Mutex<Handle<Client>>>) -> bool {
    let probe = async {
        let channel_result = {
            let guard = session.lock().await;
            guard.channel_open_session().await
        };
        match channel_result {
            Ok(channel) => {
                let _ = channel.close().await;
                true
            }
            Err(_) => false,
        }
    };
    tokio::time::timeout(SSH_SESSION_PROBE_TIMEOUT, probe)
        .await
        .unwrap_or(false)
}

/// Stable runtime key for a saved tunnel config (unique per connection + endpoints).
pub fn tunnel_runtime_id(tunnel: &SavedTunnel) -> String {
    if tunnel.tunnel_type == "dynamic" {
        let bind = tunnel
            .bind_address
            .as_deref()
            .unwrap_or("127.0.0.1")
            .replace(':', "_");
        return format!(
            "dynamic:{}:{}:{}",
            tunnel.connection_id, tunnel.local_port, bind
        );
    }

    let remote_host = tunnel.remote_host.replace(':', "_");
    if tunnel.tunnel_type == "local" {
        format!(
            "local:{}:{}:{}:{}",
            tunnel.connection_id, tunnel.local_port, remote_host, tunnel.remote_port
        )
    } else {
        format!(
            "remote:{}:{}:{}:{}",
            tunnel.connection_id, tunnel.remote_port, remote_host, tunnel.local_port
        )
    }
}

fn uses_local_listener(tunnel_type: &str) -> bool {
    tunnel_type == "local" || tunnel_type == "dynamic"
}

/// Scoped key for remote forward lookup (per SSH connection).
pub fn remote_forward_map_key(connection_id: &str, remote_port: u16) -> String {
    format!("{connection_id}:{remote_port}")
}

#[derive(Clone, Debug)]
pub struct TunnelManager {
    /// `{connection_id}:{remote_port}` -> (local_host, local_port, bind_address)
    pub remote_forwards: Arc<Mutex<HashMap<String, (String, u16, String)>>>,
    /// `tunnel_runtime_id` -> listener abort handle + cancel sender
    pub local_listeners:
        Arc<Mutex<HashMap<String, (tokio::task::AbortHandle, tokio::sync::broadcast::Sender<()>)>>>,
    failure_tx: SessionFailureSender,
}

impl TunnelManager {
    pub fn new(failure_tx: SessionFailureSender) -> Self {
        Self {
            remote_forwards: Arc::new(Mutex::new(HashMap::new())),
            local_listeners: Arc::new(Mutex::new(HashMap::new())),
            failure_tx,
        }
    }

    pub async fn start_local_forwarding(
        &self,
        session: Arc<Mutex<Handle<Client>>>,
        connection_id: String,
        runtime_id: String,
        bind_address: String,
        local_port: u16,
        remote_host: String,
        remote_port: u16,
    ) -> Result<String> {
        {
            let listeners = self.local_listeners.lock().await;
            if listeners.contains_key(&runtime_id) {
                println!(
                    "[TUNNEL] Tunnel {} already active, skipping start",
                    runtime_id
                );
                return Ok(runtime_id);
            }
        }

        let listener = match TcpListener::bind(format!("{}:{}", bind_address, local_port)).await {
            Ok(listener) => listener,
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                let process_info = find_process_using_port(local_port).await;
                let suggested_port = find_next_available_port(local_port, 10).await;

                let error_msg = if let Some(port) = suggested_port {
                    format!(
                        "Port {} is already in use{}. Port {} is available.",
                        local_port,
                        process_info.map(|p| format!(" {}", p)).unwrap_or_default(),
                        port
                    )
                } else {
                    format!(
                        "Port {} is already in use{}. Please choose a different port.",
                        local_port,
                        process_info.map(|p| format!(" {}", p)).unwrap_or_default()
                    )
                };

                return Err(anyhow!(error_msg));
            }
            Err(e) => return Err(e.into()),
        };
        let session = session.clone();
        let failure_tx = self.failure_tx.clone();

        println!(
            "[TUNNEL] Starting local forwarding {} on port {} to {}:{} (bind {})",
            runtime_id, local_port, remote_host, remote_port, bind_address
        );

        let (tx, _rx) = tokio::sync::broadcast::channel(1);
        let tx_for_store = tx.clone();

        let handle = tokio::spawn(async move {
            let mut session_probe =
                tokio::time::interval(Duration::from_secs(SESSION_PROBE_INTERVAL_SECS));
            session_probe.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

            loop {
                let accept_fut = listener.accept();
                let mut rx = tx.subscribe();

                tokio::select! {
                    Ok((mut incoming_stream, _)) = accept_fut => {
                         let session = session.clone();
                         let remote_host = remote_host.clone();
                         let mut inner_rx = tx.subscribe();
                         let stop_tx = tx.clone();
                         let failure_tx = failure_tx.clone();
                         let connection_id = connection_id.clone();

                         tokio::spawn(async move {
                            let channel = {
                                let session_guard = session.lock().await;
                                match session_guard.channel_open_direct_tcpip(remote_host, remote_port as u32, "127.0.0.1", 0).await {
                                     Ok(c) => Some(c),
                                     Err(e) => {
                                         eprintln!("[TUNNEL] Failed to open direct-tcpip channel: {}", e);
                                         if is_ssh_session_fatal_error(&e) {
                                             println!(
                                                 "[TUNNEL] SSH session lost for {}; stopping tunnels",
                                                 connection_id
                                             );
                                             let _ = stop_tx.send(());
                                             let _ = failure_tx.send(connection_id);
                                         }
                                         None
                                     }
                                }
                            };

                            if let Some(channel) = channel {
                                 let mut stream = channel.into_stream();

                                 tokio::select! {
                                     res = tokio::io::copy_bidirectional(&mut incoming_stream, &mut stream) => {
                                         if let Err(e) = res {
                                             println!("[TUNNEL] Error copying: {}", e);
                                         }
                                     }
                                     _ = inner_rx.recv() => {
                                         println!("[TUNNEL] Aborting active connection due to stop request");
                                     }
                                 }
                            }
                         });
                    }
                    _ = rx.recv() => {
                        println!("[TUNNEL] Listener stopped via signal");
                        break;
                    }
                    _ = session_probe.tick() => {
                        if !probe_ssh_session(&session).await {
                            println!(
                                "[TUNNEL] SSH session probe failed for {}; stopping tunnels",
                                connection_id
                            );
                            let _ = tx.send(());
                            let _ = failure_tx.send(connection_id.clone());
                            break;
                        }
                    }
                }
            }
        });

        self.local_listeners
            .lock()
            .await
            .insert(runtime_id.clone(), (handle.abort_handle(), tx_for_store));

        Ok(runtime_id)
    }

    /// SOCKS5 dynamic forward (`ssh -D`) — one local port, per-connection remote targets.
    pub async fn start_dynamic_forwarding(
        &self,
        session: Arc<Mutex<Handle<Client>>>,
        connection_id: String,
        runtime_id: String,
        bind_address: String,
        local_port: u16,
    ) -> Result<String> {
        {
            let listeners = self.local_listeners.lock().await;
            if listeners.contains_key(&runtime_id) {
                println!(
                    "[TUNNEL] Dynamic tunnel {} already active, skipping start",
                    runtime_id
                );
                return Ok(runtime_id);
            }
        }

        let listener = match TcpListener::bind(format!("{}:{}", bind_address, local_port)).await {
            Ok(listener) => listener,
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                let process_info = find_process_using_port(local_port).await;
                let suggested_port = find_next_available_port(local_port, 10).await;

                let error_msg = if let Some(port) = suggested_port {
                    format!(
                        "Port {} is already in use{}. Port {} is available.",
                        local_port,
                        process_info.map(|p| format!(" {}", p)).unwrap_or_default(),
                        port
                    )
                } else {
                    format!(
                        "Port {} is already in use{}. Please choose a different port.",
                        local_port,
                        process_info.map(|p| format!(" {}", p)).unwrap_or_default()
                    )
                };

                return Err(anyhow!(error_msg));
            }
            Err(e) => return Err(e.into()),
        };

        println!(
            "[TUNNEL] Starting dynamic SOCKS {} on {}:{}",
            runtime_id, bind_address, local_port
        );

        let (tx, _rx) = tokio::sync::broadcast::channel(1);
        let tx_for_store = tx.clone();
        let session = session.clone();
        let failure_tx = self.failure_tx.clone();

        let handle = tokio::spawn(async move {
            let mut session_probe =
                tokio::time::interval(Duration::from_secs(SESSION_PROBE_INTERVAL_SECS));
            session_probe.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

            loop {
                let accept_fut = listener.accept();
                let mut rx = tx.subscribe();

                tokio::select! {
                    Ok((client_stream, _)) = accept_fut => {
                        let session = session.clone();
                        let client_rx = tx.subscribe();
                        let stop_tx = tx.clone();
                        let failure_tx = failure_tx.clone();
                        let connection_id = connection_id.clone();
                        tokio::spawn(async move {
                            dynamic::handle_socks5_client(
                                client_stream,
                                session,
                                connection_id,
                                failure_tx,
                                stop_tx,
                                client_rx,
                            )
                            .await;
                        });
                    }
                    _ = rx.recv() => {
                        println!("[TUNNEL] Dynamic listener stopped via signal");
                        break;
                    }
                    _ = session_probe.tick() => {
                        if !probe_ssh_session(&session).await {
                            println!(
                                "[TUNNEL] SSH session probe failed for {}; stopping tunnels",
                                connection_id
                            );
                            let _ = tx.send(());
                            let _ = failure_tx.send(connection_id.clone());
                            break;
                        }
                    }
                }
            }
        });

        self.local_listeners
            .lock()
            .await
            .insert(runtime_id.clone(), (handle.abort_handle(), tx_for_store));

        Ok(runtime_id)
    }

    pub async fn start_remote_forwarding(
        &self,
        session: Arc<Mutex<Handle<Client>>>,
        connection_id: String,
        runtime_id: String,
        bind_address: String,
        remote_port: u16,
        local_host: String,
        local_port: u16,
    ) -> Result<String> {
        let map_key = remote_forward_map_key(&connection_id, remote_port);
        {
            let mut map = self.remote_forwards.lock().await;
            if map.contains_key(&map_key) {
                println!(
                    "[TUNNEL] Remote tunnel {} already active",
                    map_key
                );
                return Ok(runtime_id);
            }
            map.insert(
                map_key.clone(),
                (local_host.clone(), local_port, bind_address.clone()),
            );
        }

        let res = {
            let mut session_handle = session.lock().await;
            session_handle
                .tcpip_forward(bind_address.clone(), remote_port as u32)
                .await
        };

        if let Err(e) = res {
            let mut map = self.remote_forwards.lock().await;
            map.remove(&map_key);
            return Err(anyhow!("Remote forwarding error: {}", e));
        }

        println!(
            "[TUNNEL] Remote forwarding {} enabled on remote port {} -> {}:{} (bind {})",
            runtime_id, remote_port, local_host, local_port, bind_address
        );

        Ok(runtime_id)
    }

    pub async fn stop_tunnel(
        &self,
        session: Option<Arc<Mutex<Handle<Client>>>>,
        tunnel: &SavedTunnel,
    ) -> Result<()> {
        let runtime_id = tunnel_runtime_id(tunnel);
        println!("[TUNNEL MANAGER] Stopping {}", runtime_id);

        if uses_local_listener(&tunnel.tunnel_type) {
            let mut listeners = self.local_listeners.lock().await;
            if let Some((handle, tx)) = listeners.remove(&runtime_id) {
                let _ = tx.send(());
                handle.abort();
                println!("[TUNNEL] Stop signal sent for {}", runtime_id);
            } else {
                println!(
                    "[TUNNEL] Local-side tunnel {} not found in listeners",
                    runtime_id
                );
            }
        } else {
            let map_key = remote_forward_map_key(&tunnel.connection_id, tunnel.remote_port);
            let found_entry = {
                let remote_forwards_guard = self.remote_forwards.lock().await;
                remote_forwards_guard.get(&map_key).cloned()
            };

            if let Some((_, _, saved_bind_address)) = found_entry {
                if let Some(session) = session {
                    let handle = session.lock().await;
                    let bind_addr = tunnel
                        .bind_address
                        .clone()
                        .unwrap_or(saved_bind_address);
                    let res = handle
                        .cancel_tcpip_forward(bind_addr.clone(), tunnel.remote_port as u32)
                        .await;

                    if res.is_ok() {
                        let mut remote_forwards_guard = self.remote_forwards.lock().await;
                        remote_forwards_guard.remove(&map_key);
                        println!(
                            "[TUNNEL] Cancelled remote forwarding {} (bind {})",
                            map_key, bind_addr
                        );
                    } else {
                        println!(
                            "[TUNNEL ERROR] Failed to cancel remote forwarding {}: {:?}",
                            map_key,
                            res.err()
                        );
                    }
                } else {
                    let mut remote_forwards_guard = self.remote_forwards.lock().await;
                    remote_forwards_guard.remove(&map_key);
                }
            } else if let Some(session) = session {
                let handle = session.lock().await;
                let bind_addr = tunnel
                    .bind_address
                    .clone()
                    .unwrap_or_else(|| "0.0.0.0".to_string());
                let _ = handle
                    .cancel_tcpip_forward(bind_addr.clone(), tunnel.remote_port as u32)
                    .await;
                warn!(
                    "[TUNNEL] Attempted to cancel unknown remote forwarding {} (bind {})",
                    map_key, bind_addr
                );
            }
        }
        Ok(())
    }
}

/// Attempts to find which process is using the specified port.
async fn find_process_using_port(port: u16) -> Option<String> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        use tokio::process::Command;

        let output = Command::new("lsof")
            .args(["-i", &format!(":{}", port), "-t", "-sTCP:LISTEN"])
            .output()
            .await
            .ok()?;

        if output.status.success() {
            let pid_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if let Ok(pid) = pid_str.parse::<u32>() {
                let name_output = Command::new("ps")
                    .args(["-p", &pid.to_string(), "-o", "comm="])
                    .output()
                    .await
                    .ok()?;

                if name_output.status.success() {
                    let process_name = String::from_utf8_lossy(&name_output.stdout)
                        .trim()
                        .to_string();
                    if !process_name.is_empty() {
                        return Some(format!("by '{}' (PID: {})", process_name, pid));
                    }
                }
                return Some(format!("by PID {}", pid));
            }
        }
        None
    }

    #[cfg(target_os = "windows")]
    {
        use tokio::process::Command;

        let output = Command::new("netstat").args(["-ano"]).output().await.ok()?;

        if output.status.success() {
            let output_str = String::from_utf8_lossy(&output.stdout);
            for line in output_str.lines() {
                if line.contains(&format!(":{}", port)) && line.contains("LISTENING") {
                    if let Some(pid_str) = line.split_whitespace().last() {
                        if let Ok(pid) = pid_str.parse::<u32>() {
                            let name_output = Command::new("tasklist")
                                .args(["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"])
                                .output()
                                .await
                                .ok()?;

                            if name_output.status.success() {
                                let name_str = String::from_utf8_lossy(&name_output.stdout);
                                if let Some(first_field) = name_str.split(',').next() {
                                    let process_name = first_field.trim_matches('"').trim();
                                    if !process_name.is_empty() {
                                        return Some(format!(
                                            "by '{}' (PID: {})",
                                            process_name, pid
                                        ));
                                    }
                                }
                            }
                            return Some(format!("by PID {}", pid));
                        }
                    }
                }
            }
        }
        None
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

async fn find_next_available_port(start_port: u16, max_attempts: u8) -> Option<u16> {
    for offset in 1..=max_attempts {
        let candidate_port = start_port.saturating_add(offset.into());
        if candidate_port == 0 || candidate_port == start_port {
            continue;
        }

        match TcpListener::bind(format!("127.0.0.1:{}", candidate_port)).await {
            Ok(listener) => {
                drop(listener);
                return Some(candidate_port);
            }
            Err(_) => continue,
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_tunnel(tunnel_type: &str, connection_id: &str) -> SavedTunnel {
        SavedTunnel {
            id: "t1".to_string(),
            connection_id: connection_id.to_string(),
            name: "test".to_string(),
            tunnel_type: tunnel_type.to_string(),
            local_port: 8080,
            remote_host: "127.0.0.1".to_string(),
            remote_port: 5432,
            bind_address: Some("127.0.0.1".to_string()),
            bind_to_any: None,
            auto_start: None,
            status: None,
            original_port: None,
            group: None,
            created_at: None,
            updated_at: None,
        }
    }

    #[test]
    fn tunnel_runtime_id_includes_connection_for_local() {
        let t = sample_tunnel("local", "conn-a");
        assert_eq!(tunnel_runtime_id(&t), "local:conn-a:8080:127.0.0.1:5432");
    }

    #[test]
    fn tunnel_runtime_id_includes_connection_for_remote() {
        let t = sample_tunnel("remote", "conn-b");
        assert_eq!(tunnel_runtime_id(&t), "remote:conn-b:5432:127.0.0.1:8080");
    }

    #[test]
    fn remote_forward_map_key_scopes_by_connection() {
        assert_eq!(remote_forward_map_key("host-1", 9000), "host-1:9000");
        assert_ne!(
            remote_forward_map_key("host-1", 9000),
            remote_forward_map_key("host-2", 9000)
        );
    }

    #[test]
    fn tunnel_runtime_id_for_dynamic() {
        let mut t = sample_tunnel("dynamic", "conn-d");
        t.remote_host = "*".to_string();
        t.remote_port = 0;
        assert_eq!(
            tunnel_runtime_id(&t),
            "dynamic:conn-d:8080:127.0.0.1"
        );
    }
}