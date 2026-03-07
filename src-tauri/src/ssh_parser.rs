use regex::Regex;
use serde::Serialize;
use std::collections::HashSet;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ParsedTunnel {
    #[serde(rename = "type")]
    pub tunnel_type: String, // "local" or "remote"
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ParseResult {
    pub success: bool,
    pub tunnels: Vec<ParsedTunnel>,
    pub errors: Vec<String>,
}

pub fn parse_ssh_command(command: &str) -> ParseResult {
    let mut tunnels = Vec::new();
    let mut errors = Vec::new();

    // Clean the command string
    let cleaned = command
        .replace("\\\n", " ")
        .replace('\n', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    // Regex for -L (Local Forwarding)
    // Matches: -L [bind_address:]local_port:remote_host:remote_port
    let local_re =
        Regex::new(r"-L\s+(?:(?:\d+\.\d+\.\d+\.\d+|\[[:a-fA-F0-9]+\]):)?(\d+):([^:\s]+):(\d+)")
            .unwrap();

    // Regex for -R (Remote Forwarding)
    // Matches: -R [bind_address:]remote_port:local_host:local_port
    let remote_re =
        Regex::new(r"-R\s+(?:(?:\d+\.\d+\.\d+\.\d+|\[[:a-fA-F0-9]+\]):)?(\d+):([^:\s]+):(\d+)")
            .unwrap();

    // Extract Local Tunnels
    for cap in local_re.captures_iter(&cleaned) {
        if let (Some(local_port_str), Some(remote_host), Some(remote_port_str)) =
            (cap.get(1), cap.get(2), cap.get(3))
        {
            if let (Ok(local_port), Ok(remote_port)) = (
                local_port_str.as_str().parse::<u16>(),
                remote_port_str.as_str().parse::<u16>(),
            ) {
                tunnels.push(ParsedTunnel {
                    tunnel_type: "local".to_string(),
                    local_port,
                    remote_host: remote_host.as_str().to_string(),
                    remote_port,
                    name: Some(format!(
                        "Local {} → {}:{}",
                        local_port,
                        remote_host.as_str(),
                        remote_port
                    )),
                });
            } else {
                errors.push(format!(
                    "Invalid port numbers in -L flag: {}:{}:{}",
                    local_port_str.as_str(),
                    remote_host.as_str(),
                    remote_port_str.as_str()
                ));
            }
        }
    }

    // Extract Remote Tunnels
    for cap in remote_re.captures_iter(&cleaned) {
        if let (Some(remote_port_str), Some(local_host), Some(local_port_str)) =
            (cap.get(1), cap.get(2), cap.get(3))
        {
            if let (Ok(remote_port), Ok(local_port)) = (
                remote_port_str.as_str().parse::<u16>(),
                local_port_str.as_str().parse::<u16>(),
            ) {
                // Map SSH -R syntax to our internal schema
                // SSH: remote_port:local_host:local_port
                // Zync: type="remote", localPort=local_port, remoteHost=local_host, remotePort=remote_port
                tunnels.push(ParsedTunnel {
                    tunnel_type: "remote".to_string(),
                    local_port, // The port on the local machine (target)
                    remote_host: local_host.as_str().to_string(), // Usually 'localhost' or internal ip
                    remote_port, // The port opened on the remote server
                    name: Some(format!(
                        "Remote {} → {}:{}",
                        remote_port,
                        local_host.as_str(),
                        local_port
                    )),
                });
            } else {
                errors.push(format!(
                    "Invalid port numbers in -R flag: {}:{}:{}",
                    remote_port_str.as_str(),
                    local_host.as_str(),
                    local_port_str.as_str()
                ));
            }
        }
    }

    if tunnels.is_empty() {
        errors.push("No -L or -R tunnel flags found in command".to_string());
    }

    // Check for duplicate ports
    let mut seen_ports = HashSet::new();
    for tunnel in &tunnels {
        let key = format!(
            "{}:{}",
            tunnel.tunnel_type,
            if tunnel.tunnel_type == "local" {
                tunnel.local_port
            } else {
                tunnel.remote_port
            }
        );
        if seen_ports.contains(&key) {
            errors.push(format!(
                "Duplicate {} port: {}",
                tunnel.tunnel_type,
                if tunnel.tunnel_type == "local" {
                    tunnel.local_port
                } else {
                    tunnel.remote_port
                }
            ));
        }
        seen_ports.insert(key);
    }

    ParseResult {
        success: !tunnels.is_empty() && errors.is_empty(),
        tunnels,
        errors,
    }
}
