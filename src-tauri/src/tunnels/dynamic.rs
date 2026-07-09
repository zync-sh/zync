//! Dynamic (SOCKS5) port forwarding — local proxy through an SSH session.

use crate::ssh::Client;
use crate::tunnels::session_failure::{is_ssh_session_fatal_error, SessionFailureSender};
use crate::tunnels::socks5::{
    self, connect_success_reply, error_reply, method_selection_reply, parse_connect_request,
    socks5_error_to_reply, Socks5Error, ATYP_DOMAIN, ATYP_IPV4, ATYP_IPV6, CMD_CONNECT, VERSION,
};
use anyhow::Result;
use russh::client::Handle;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, Mutex};

const SOCKS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

pub async fn handle_socks5_client(
    mut client: TcpStream,
    session: Arc<Mutex<Handle<Client>>>,
    connection_id: String,
    failure_tx: SessionFailureSender,
    stop_tx: broadcast::Sender<()>,
    mut cancel: broadcast::Receiver<()>,
) {
    if let Err(error) = run_socks5_client(
        &mut client,
        session,
        &connection_id,
        &failure_tx,
        &stop_tx,
        &mut cancel,
    )
    .await
    {
        eprintln!("[TUNNEL][SOCKS] client handler error: {error}");
    }
}

/// Returns `Ok(true)` when bytes were read, `Ok(false)` when cancelled.
async fn read_exact_or_cancel(
    client: &mut TcpStream,
    buf: &mut [u8],
    cancel: &mut broadcast::Receiver<()>,
) -> Result<bool> {
    tokio::select! {
        result = client.read_exact(buf) => {
            result?;
            Ok(true)
        }
        _ = cancel.recv() => Ok(false),
    }
}

async fn run_socks5_client(
    client: &mut TcpStream,
    session: Arc<Mutex<Handle<Client>>>,
    connection_id: &str,
    failure_tx: &SessionFailureSender,
    stop_tx: &broadcast::Sender<()>,
    cancel: &mut broadcast::Receiver<()>,
) -> Result<()> {
    let handshake = async {
        let mut greeting = [0u8; 2];
        if !read_exact_or_cancel(client, &mut greeting, cancel).await? {
            return Ok(());
        }

        let nmethods = greeting[1] as usize;
        let mut methods = vec![0u8; nmethods];
        if !read_exact_or_cancel(client, &mut methods, cancel).await? {
            return Ok(());
        }

        let mut full_greeting = greeting.to_vec();
        full_greeting.extend_from_slice(&methods);
        socks5::validate_client_greeting(&full_greeting)?;

        client.write_all(&method_selection_reply()).await?;

        let target = match read_connect_target(client, cancel).await {
            Ok(target) => target,
            Err(error) => {
                let _ = client
                    .write_all(&error_reply(socks5_error_to_reply(&error)))
                    .await;
                return Err(anyhow::Error::new(error));
            }
        };

        let channel = {
            let session = session.clone();
            let target_host = target.host.clone();
            let target_port = target.port;
            tokio::select! {
                result = async move {
                    let session_guard = session.lock().await;
                    session_guard
                        .channel_open_direct_tcpip(
                            target_host,
                            target_port as u32,
                            "127.0.0.1",
                            0,
                        )
                        .await
                } => result,
                _ = cancel.recv() => return Ok(()),
            }
        };

        let channel = match channel {
            Ok(channel) => channel,
            Err(error) => {
                let _ = client
                    .write_all(&error_reply(socks5::REP_GENERAL_FAILURE))
                    .await;
                if is_ssh_session_fatal_error(&error) {
                    println!(
                        "[TUNNEL][SOCKS] SSH session lost for {}; stopping tunnels",
                        connection_id
                    );
                    let _ = stop_tx.send(());
                    let _ = failure_tx.send(connection_id.to_string());
                }
                return Err(error.into());
            }
        };

        client.write_all(&connect_success_reply()).await?;

        let mut stream = channel.into_stream();
        tokio::select! {
            result = tokio::io::copy_bidirectional(client, &mut stream) => {
                if let Err(error) = result {
                    eprintln!(
                        "[TUNNEL][SOCKS] relay error to {}:{} — {error}",
                        target.host,
                        target.port
                    );
                }
            }
            _ = cancel.recv() => {}
        }

        Ok(())
    };

    match tokio::time::timeout(SOCKS_HANDSHAKE_TIMEOUT, handshake).await {
        Ok(result) => result,
        Err(_) => Ok(()),
    }
}

async fn read_connect_target(
    client: &mut TcpStream,
    cancel: &mut broadcast::Receiver<()>,
) -> Result<socks5::ConnectTarget, Socks5Error> {
    let mut header = [0u8; 4];
    if !read_exact_or_cancel(client, &mut header, cancel)
        .await
        .map_err(|_| Socks5Error::InvalidMessage("connect header"))?
    {
        return Err(Socks5Error::InvalidMessage("connect header cancelled"));
    }

    if header[0] != VERSION {
        return Err(Socks5Error::UnsupportedVersion(header[0]));
    }
    if header[1] != CMD_CONNECT {
        return Err(Socks5Error::UnsupportedCommand(header[1]));
    }

    let body = match header[3] {
        ATYP_IPV4 => {
            let mut bytes = [0u8; 6];
            if !read_exact_or_cancel(client, &mut bytes, cancel)
                .await
                .map_err(|_| Socks5Error::InvalidMessage("ipv4 target"))?
            {
                return Err(Socks5Error::InvalidMessage("ipv4 target cancelled"));
            }
            bytes.to_vec()
        }
        ATYP_DOMAIN => {
            let mut len_buf = [0u8; 1];
            if !read_exact_or_cancel(client, &mut len_buf, cancel)
                .await
                .map_err(|_| Socks5Error::InvalidMessage("domain length"))?
            {
                return Err(Socks5Error::InvalidMessage("domain length cancelled"));
            }
            let len = len_buf[0] as usize;
            let mut tail = vec![0u8; len + 2];
            if !read_exact_or_cancel(client, &mut tail, cancel)
                .await
                .map_err(|_| Socks5Error::InvalidMessage("domain target"))?
            {
                return Err(Socks5Error::InvalidMessage("domain target cancelled"));
            }
            let mut out = len_buf.to_vec();
            out.extend_from_slice(&tail);
            out
        }
        ATYP_IPV6 => {
            let mut bytes = [0u8; 18];
            if !read_exact_or_cancel(client, &mut bytes, cancel)
                .await
                .map_err(|_| Socks5Error::InvalidMessage("ipv6 target"))?
            {
                return Err(Socks5Error::InvalidMessage("ipv6 target cancelled"));
            }
            bytes.to_vec()
        }
        other => return Err(Socks5Error::UnsupportedAddressType(other)),
    };

    let mut request = header.to_vec();
    request.extend_from_slice(&body);
    parse_connect_request(&request)
}