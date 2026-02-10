use crate::ssh::Client;
use anyhow::{anyhow, Result};
use russh::client::Handle;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct TunnelManager {
    // remote_port -> (local_host, local_port, bind_address)
    pub remote_forwards: Arc<Mutex<HashMap<u16, (String, u16, String)>>>,
    // tunnel_id -> (Listener AbortHandle, Kill Signal Sender)
    pub local_listeners: Arc<Mutex<HashMap<String, (tokio::task::AbortHandle, tokio::sync::broadcast::Sender<()>)>>>,
}

impl TunnelManager {
    pub fn new() -> Self {
        Self {
            remote_forwards: Arc::new(Mutex::new(HashMap::new())),
            local_listeners: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    // Local Forwarding: Listen on local_port, forward to remote_host:remote_port via SSH
    pub async fn start_local_forwarding(
        &self,
        session: Arc<Mutex<Handle<Client>>>, 
        bind_address: String,
        local_port: u16,
        remote_host: String,
        remote_port: u16,
    ) -> Result<String> {
        let tunnel_id = format!("local:{}:{}", local_port, remote_port);
        
        // Idempotency check
        {
            let listeners = self.local_listeners.lock().await;
            if listeners.contains_key(&tunnel_id) {
                println!("[TUNNEL] Tunnel {} already active, skipping start", tunnel_id);
                return Ok(tunnel_id);
            }
        }

        let listener = match TcpListener::bind(format!("{}:{}", bind_address, local_port)).await {
            Ok(listener) => listener,
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                let process_info = find_process_using_port(local_port).await;
                return Err(anyhow!(
                    "Port {} is already in use{}. Please stop this process or choose a different port.",
                    local_port,
                    process_info.map(|p| format!(" {}", p)).unwrap_or_default()
                ));
            }
            Err(e) => return Err(e.into()),
        };
        let session = session.clone();

        println!("[TUNNEL] Starting local forwarding on port {} to {}:{} with bind address {}", local_port, remote_host, remote_port, bind_address);

        let (tx, _rx) = tokio::sync::broadcast::channel(1);
        let tx_for_store = tx.clone();

        let handle = tokio::spawn(async move {
            loop {
                let accept_fut = listener.accept();
                let mut rx = tx.subscribe();

                tokio::select! {
                    Ok((mut incoming_stream, _)) = accept_fut => {
                         let session = session.clone();
                         let remote_host = remote_host.clone();
                         let mut inner_rx = tx.subscribe(); // Subscribe for inner task
                         
                         tokio::spawn(async move {
                            // Open channel - CRITICAL: Lock must be dropped before streaming
                            let channel = {
                                let session_guard = session.lock().await;
                                match session_guard.channel_open_direct_tcpip(remote_host, remote_port as u32, "127.0.0.1", 0).await {
                                     Ok(c) => Some(c),
                                     Err(e) => {
                                         eprintln!("[TUNNEL] Failed to open direct-tcpip channel: {}", e);
                                         None
                                     }
                                }
                            };

                            if let Some(channel) = channel {
                                 let mut stream = channel.into_stream();
                                 
                                 // Select between copy and cancellation
                                 tokio::select! {
                                     res = tokio::io::copy_bidirectional(&mut incoming_stream, &mut stream) => {
                                         if let Err(e) = res {
                                             // log error
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
                }
            }
        });
        
        // Store cancellation handle and sender
        self.local_listeners.lock().await.insert(tunnel_id.clone(), (handle.abort_handle(), tx_for_store));

        Ok(tunnel_id)
    }

    pub async fn start_remote_forwarding(
         &self,
         session: Arc<Mutex<Handle<Client>>>,
         bind_address: String,
         remote_port: u16,
         local_host: String,
         local_port: u16,
    ) -> Result<String> {
        // Register map FIRST so handler can find it
        let tunnel_id = format!("remote:{}:{}", remote_port, local_port);
        {
            let mut map = self.remote_forwards.lock().await;
            if map.contains_key(&remote_port) {
                println!("[TUNNEL] Remote tunnel on port {} already active", remote_port);
                return Ok(tunnel_id);
            }
            map.insert(remote_port, (local_host.clone(), local_port, bind_address.clone()));
        }

        let mut session_handle = session.lock().await;
        // Check docs: tcpip_forward returns impl Future<Output = Result<bool, Error>> usually? 
        // 0.46 might return u32 if allocating port 0.
        // Assuming Result<bool> based on previous checks or similar.
        // Actually, let's treat it as result.
        let _ = session_handle.tcpip_forward(bind_address.clone(), remote_port as u32).await
             .map_err(|e| {
                 anyhow!("Remote forwarding error: {}", e)
             })?;
        
        println!("[TUNNEL] Remote forwarding enabled on remote port {} -> {}:{} (bound to {})", remote_port, local_host, local_port, bind_address);
        
        let tunnel_id = format!("remote:{}:{}", remote_port, local_port);
        // Note: We don't have separate abort handle for remote, it's session state + map.
        // To stop, we call cancel_tcpip_forward
        
        Ok(tunnel_id)
    }

    pub async fn stop_tunnel(&self, session: Option<Arc<Mutex<Handle<Client>>>>, tunnel_id: String, bind_address_override: Option<String>) -> Result<()> {
        println!("[TUNNEL MANAGER] Stopping {}", tunnel_id);
        // Parse ID to determine type
        if tunnel_id.starts_with("local:") {
            let mut listeners = self.local_listeners.lock().await;
            // Atomic remove - no race condition
            if let Some((handle, tx)) = listeners.remove(&tunnel_id) {
                // Send kill signal to children
                let _ = tx.send(());
                // Abort the listener thread itself (redundant if using select but safe)
                handle.abort();
                println!("[TUNNEL MARKER] Stop signal sent for {}", tunnel_id);
            } else {
                println!("[TUNNEL ERROR] Key {} not found in local_listeners. Available: {:?}", tunnel_id, listeners.keys());
            }
        } else if tunnel_id.starts_with("remote:") {
             // format: remote:{remote_port}:{local_port}
             let parts: Vec<&str> = tunnel_id.split(':').collect();
             if parts.len() == 3 {
                 if let Ok(remote_port) = parts[1].parse::<u16>() {
                     let mut remote_forwards_guard = self.remote_forwards.lock().await;
                     if let Some((_, _, saved_bind_address)) = remote_forwards_guard.remove(&remote_port) {
                         if let Some(session) = session {
                             let handle = session.lock().await;
                             let bind_addr = bind_address_override.unwrap_or_else(|| saved_bind_address);
                             let _ = handle.cancel_tcpip_forward(bind_addr.clone(), remote_port as u32).await;
                             println!("[TUNNEL] Cancelled remote forwarding on port {} (bind address: {})", remote_port, bind_addr);
                         }
                     } else {
                         println!("[TUNNEL ERROR] Remote tunnel on port {} not found in manager.", remote_port);
                         // If not found in manager, but session is provided, try to cancel with default bind_address_override
                         if let Some(session) = session {
                             let handle = session.lock().await;
                             let bind_addr = bind_address_override.unwrap_or_else(|| "0.0.0.0".to_string());
                             let _ = handle.cancel_tcpip_forward(bind_addr.clone(), remote_port as u32).await;
                             println!("[TUNNEL] Attempted to cancel unknown remote forwarding on port {} with bind_address {}", remote_port, bind_addr);
                         }
                     }
                 }
             }
        }
        Ok(())
    }
}

/// Attempts to find which process is using the specified port.
/// Returns a formatted string like "by 'node' (PID: 1234)" or None if not found.
async fn find_process_using_port(port: u16) -> Option<String> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        use tokio::process::Command;
        
        // Try lsof command (available on Linux and macOS)
        let output = Command::new("lsof")
            .args(["-i", &format!(":{}", port), "-t", "-sTCP:LISTEN"])
            .output()
            .await
            .ok()?;
        
        if output.status.success() {
            let pid_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if let Ok(pid) = pid_str.parse::<u32>() {
                // Get process name from PID
                let name_output = Command::new("ps")
                    .args(["-p", &pid.to_string(), "-o", "comm="])
                    .output()
                    .await
                    .ok()?;
                
                if name_output.status.success() {
                    let process_name = String::from_utf8_lossy(&name_output.stdout).trim().to_string();
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
        
        // Use netstat on Windows
        let output = Command::new("netstat")
            .args(["-ano"])
            .output()
            .await
            .ok()?;
        
        if output.status.success() {
            let output_str = String::from_utf8_lossy(&output.stdout);
            for line in output_str.lines() {
                if line.contains(&format!(":{}", port)) && line.contains("LISTENING") {
                    // Extract PID (last column in netstat output)
                    if let Some(pid_str) = line.split_whitespace().last() {
                        if let Ok(pid) = pid_str.parse::<u32>() {
                            // Try to get process name using tasklist
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
                                        return Some(format!("by '{}' (PID: {})", process_name, pid));
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
