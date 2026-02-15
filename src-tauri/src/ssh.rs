use anyhow::{anyhow, Result};
use russh::*;
use russh_keys::*; // Re-adding this for key loading
use std::sync::Arc;

use crate::tunnel::TunnelManager;
use crate::types::{ConnectionConfig, AuthMethod};
use tokio::net::TcpStream;
use russh::client::Msg;

#[derive(Clone)]
pub struct Client {
    pub tunnel_manager: Arc<TunnelManager>,
    pub kept_alive_session: Option<Arc<Box<client::Handle<Client>>>>,
    pub agent_keys: Arc<std::sync::Mutex<Vec<russh_keys::key::KeyPair>>>,
}

impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Client")
         .field("tunnel_manager", &"TunnelManager")
         .field("kept_alive_session", &self.kept_alive_session.is_some())
         .field("agent_keys", &"Vec<KeyPair>")
         .finish()
    }
}

#[async_trait::async_trait]
impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh_keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // Validation is done during connect if strict checking is enabled, 
        // but for now we trust (or could implement known_hosts check here)
        Ok(true) 
    }

    async fn server_channel_open_agent_forward(
        &mut self,
        channel: Channel<Msg>,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        println!("[SSH] Virtual Agent Request from server!");
        let mut stream = channel.into_stream();
        let agent_keys = self.agent_keys.clone();
        
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            
            loop {
                // 1. Read Message Length (4 bytes BE)
                let mut len_buf = [0u8; 4];
                if stream.read_exact(&mut len_buf).await.is_err() { break; }
                let len = u32::from_be_bytes(len_buf) as usize;

                // 2. Read Payload
                let mut payload = vec![0u8; len];
                if stream.read_exact(&mut payload).await.is_err() { break; }

                // 3. Process Request
                let response = handle_agent_request(&agent_keys, &payload);

                // 4. Write Response (Len + Payload)
                let resp_len = (response.len() as u32).to_be_bytes();
                if stream.write_all(&resp_len).await.is_err() { break; }
                if stream.write_all(&response).await.is_err() { break; }
            }
            println!("[SSH] Virtual Agent channel closed.");
        });
        Ok(())
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        // ... (existing implementation) ...
        println!("[TUNNEL] Incoming forwarded connection on {}:{}", connected_address, connected_port);
        
        let target = {
            let map: tokio::sync::MutexGuard<'_, std::collections::HashMap<u16, (String, u16, String)>> = self.tunnel_manager.remote_forwards.lock().await;
            map.get(&(connected_port as u16)).cloned()
        };

        if let Some((target_host, target_port, _bind_addr)) = target {
             println!("[TUNNEL] Forwarding to {}:{}", target_host, target_port);
             
             let target_addr = format!("{}:{}", target_host, target_port);
             
             tokio::spawn(async move {
                 match TcpStream::connect(&target_addr).await {
                     Ok(mut local_stream) => {
                         let mut channel_stream = channel.into_stream();
                         if let Err(_e) = tokio::io::copy_bidirectional(&mut channel_stream, &mut local_stream).await {
                             // log error
                         }
                     },
                     Err(e) => eprintln!("[TUNNEL] Failed to connect to local target {}: {}", target_addr, e),
                 }
             });
             
             Ok(())
        } else {
             eprintln!("[TUNNEL] No tunnel found for port {}", connected_port);
             Ok(())
        }
    }
}

// Minimal SSH Agent Protocol Handler
fn handle_agent_request(keys_mutex: &Arc<std::sync::Mutex<Vec<russh_keys::key::KeyPair>>>, payload: &[u8]) -> Vec<u8> {
    if payload.is_empty() { return vec![5]; } // SSH_AGENT_FAILURE
    let msg_type = payload[0];
    let mut cursor = &payload[1..];

    // Helpers for parsing
    fn read_u32(cursor: &mut &[u8]) -> Option<u32> {
        if cursor.len() < 4 { return None; }
        let (val, rest) = cursor.split_at(4);
        *cursor = rest;
        Some(u32::from_be_bytes(val.try_into().unwrap()))
    }

    fn read_string<'a>(cursor: &mut &'a [u8]) -> Option<&'a [u8]> {
        let len = read_u32(cursor)? as usize;
        if cursor.len() < len { return None; }
        let (str_bytes, rest) = cursor.split_at(len);
        *cursor = rest;
        Some(str_bytes)
    }

    fn write_string(buf: &mut Vec<u8>, data: &[u8]) {
        buf.extend_from_slice(&(data.len() as u32).to_be_bytes());
        buf.extend_from_slice(data);
    }

    match msg_type {
        11 => { // SSH_AGENTC_REQUEST_IDENTITIES
            // Response: SSH_AGENT_IDENTITIES_ANSWER (12) + u32 count + (string blob + string comment) * count
            let keys = keys_mutex.lock().unwrap();
            let mut buf = vec![12]; 
            buf.extend_from_slice(&(keys.len() as u32).to_be_bytes());
            
            for k in keys.iter() {
                let blob = k.public_key_bytes(); 
                // Temporary Fix: Filter out non-Ed25519 keys because russh ECDSA blobs seem malformed (4 parts instead of 3)
                // causing "elliptic curve does not match" on the remote OpenSSH client.
                if !blob.windows(11).any(|w| w == b"ssh-ed25519") {
                    continue;
                }

                 write_string(&mut buf, &blob);
                 write_string(&mut buf, b"virtual-agent");
            }
            // Update the count at the beginning of the buffer
            let count = keys.iter().filter(|k| k.public_key_bytes().windows(11).any(|w| w == b"ssh-ed25519")).count();
            buf[1..5].copy_from_slice(&(count as u32).to_be_bytes());
            buf
        },
        13 => { // SSH_AGENTC_SIGN_REQUEST
            // Format: string key_blob, string data, u32 flags
            if let (Some(req_blob), Some(data), Some(_flags)) = (read_string(&mut cursor), read_string(&mut cursor), read_u32(&mut cursor)) {
                let keys = keys_mutex.lock().unwrap();
                for k in keys.iter() {
                     let blob = k.public_key_bytes();
                     if blob == req_blob {
                         // Sign
                             if let Ok(sig) = k.sign_detached(data) {
                                  // Serialize signature blob manually
                                  let mut sig_blob = Vec::new();
                                  match sig {
                                      russh_keys::key::Signature::Ed25519(ref bytes) => {
                                          write_string(&mut sig_blob, b"ssh-ed25519");
                                          write_string(&mut sig_blob, &bytes.0);
                                      }
                                      russh_keys::key::Signature::RSA { ref hash, ref bytes } => {
                                          write_string(&mut sig_blob, hash.name().0.as_bytes());
                                          write_string(&mut sig_blob, bytes);
                                      }
                                      russh_keys::key::Signature::ECDSA { algorithm, ref signature } => {
                                          write_string(&mut sig_blob, algorithm.as_bytes());
                                          write_string(&mut sig_blob, signature);
                                      }
                                  }
                                  let mut buf = vec![14]; // SSH_AGENT_SIGN_RESPONSE
                                  write_string(&mut buf, &sig_blob);
                                  return buf;
                             }
                         }
                }
            }
            vec![5] // Failure
        },
        _ => vec![5]
    }
}

pub struct SshManager {
    // Shared keys for virtual agent
    pub agent_keys: Arc<std::sync::Mutex<Vec<russh_keys::key::KeyPair>>>,
}

impl SshManager {
    pub fn new() -> Self {
        Self {
            agent_keys: Arc::new(std::sync::Mutex::new(Vec::new())),
        }
    }

    pub async fn connect(
        &self,
        config: ConnectionConfig,
        tunnel_manager: Arc<crate::tunnel::TunnelManager>,
    ) -> Result<client::Handle<Client>> {
        let client_config = client::Config::default();
        let client_config = Arc::new(client_config);
        
        // Recursive Jump Host Logic
        if let Some(ref jump_host_config) = config.jump_host {
            println!("[SSH] Connecting via Jump Host: {} -> {}", jump_host_config.host, config.host);
            
            // 1. Connect to Jump Host (Recursive)
            let jump_session = Box::pin(self.connect((**jump_host_config).clone(), tunnel_manager.clone())).await
                .map_err(|e| anyhow!("Failed to connect to jump host: {}", e))?;

            println!("[SSH] Jump Host Connected. Opening tunnel to target...");

            // 2. Open Direct TCP/IP Channel through Jump Host
            let channel = jump_session.channel_open_direct_tcpip(
                config.host.clone(),
                config.port as u32,
                "0.0.0.0", // Originator IP (dummy)
                0,         // Originator port (dummy)
            ).await
            .map_err(|e| anyhow!("Failed to open direct-tcpip channel on jump host: {}", e))?;

            // 3. Establish SSH Session over the Channel
            println!("[SSH] Tunnel established. Handshaking with target...");
            let stream = channel.into_stream();
            
            // 4. Create handler with agent keys
            let client_handler = Client {
                tunnel_manager: tunnel_manager.clone(),
                kept_alive_session: Some(Arc::new(Box::new(jump_session))),
                agent_keys: self.agent_keys.clone(),
            };

            // russh::client::connect_stream takes stream and handler
            let mut session = russh::client::connect_stream(client_config, stream, client_handler).await?;
            
            // 5. Authenticate (Target)
            return self.authenticate_session(&mut session, &config).await.map(|_| session);
        }

        // Direct Connection Logic
        let client_handler = Client {
            tunnel_manager: tunnel_manager.clone(),
            kept_alive_session: None,
            agent_keys: self.agent_keys.clone(),
        };

        println!("[SSH] Connecting directly to {}:{}...", config.host, config.port);
        let mut session = client::connect(client_config, (config.host.as_str(), config.port), client_handler).await?;
        
        self.authenticate_session(&mut session, &config).await.map(|_| session)
    }

    async fn authenticate_session(
        &self,
        session: &mut client::Handle<Client>,
        config: &ConnectionConfig,
    ) -> Result<()> {
        println!("[SSH] Connected, authenticating as {}...", config.username);
        
        let (pwd, pk, passphrase) = match &config.auth_method {
            AuthMethod::Password { password } => (Some(password.clone()), None, None),
            AuthMethod::PrivateKey { key_path, passphrase } => (None, Some(key_path.clone()), passphrase.clone()),
        };

        let auth_res = if let Some(pk_path) = pk {
             let mut expanded_path = pk_path.clone();
             if expanded_path.starts_with("~") {
                 if let Some(home) = dirs::home_dir() {
                     expanded_path = expanded_path.replacen("~", &home.to_string_lossy(), 1);
                 }
             }
             println!("[SSH] Loading private key from: {}", expanded_path);
             let key_data = std::fs::read_to_string(&expanded_path)
                 .map_err(|e| anyhow!("Failed to read private key file: {}", e))?;
             
             let key = decode_secret_key(&key_data, passphrase.as_deref())
                 .map_err(|e| anyhow!("Failed to decode private key: {}", e))?;
             
             // Add key to Global Virtual Agent
             {
                 let mut keys = self.agent_keys.lock().unwrap();
                 keys.push(key.clone());
             }

             let key = Arc::new(key);
             session.authenticate_publickey(&config.username, key).await?
        } else if let Some(pwd) = pwd {
             session.authenticate_password(&config.username, pwd).await?
        } else {
             false
        };

        if !auth_res {
             return Err(anyhow!("Authentication failed"));
        }

        println!("[SSH] Authentication successful!");
        Ok(())
    }
}
