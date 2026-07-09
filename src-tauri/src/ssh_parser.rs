use regex::Regex;
use serde::Serialize;
use std::collections::HashSet;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ParsedTunnel {
    #[serde(rename = "type")]
    pub tunnel_type: String, // "local", "remote", or "dynamic"
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

    // Optional bind prefix: IPv4, bracketed IPv6, or hostname (e.g. localhost:1080).
    const BIND_PREFIX: &str = r"(?:(?:\d+\.\d+\.\d+\.\d+|\[[:a-fA-F0-9:]+\]|[^:\s]+):)?";

    // Regex for -L (Local Forwarding)
    // Matches: -L [bind_address:]local_port:remote_host:remote_port
    let local_re =
        Regex::new(&format!(r"-L\s+{BIND_PREFIX}(\d+):([^:\s]+):(\d+)"))
            .unwrap();

    // Regex for -R (Remote Forwarding)
    // Matches: -R [bind_address:]remote_port:local_host:local_port
    let remote_re =
        Regex::new(&format!(r"-R\s+{BIND_PREFIX}(\d+):([^:\s]+):(\d+)"))
            .unwrap();

    // Regex for -D (Dynamic / SOCKS forwarding)
    // Matches: -D [bind_address:]local_port
    let dynamic_re =
        Regex::new(&format!(r"-D\s+{BIND_PREFIX}(\d+)"))
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

    // Extract Dynamic (SOCKS) Tunnels
    for cap in dynamic_re.captures_iter(&cleaned) {
        if let Some(local_port_str) = cap.get(1) {
            if let Ok(local_port) = local_port_str.as_str().parse::<u16>() {
                tunnels.push(ParsedTunnel {
                    tunnel_type: "dynamic".to_string(),
                    local_port,
                    remote_host: "*".to_string(),
                    remote_port: 0,
                    name: Some(format!("SOCKS {local_port}")),
                });
            } else {
                errors.push(format!(
                    "Invalid port number in -D flag: {}",
                    local_port_str.as_str()
                ));
            }
        }
    }

    if tunnels.is_empty() {
        errors.push("No -L, -R, or -D tunnel flags found in command".to_string());
    }

    // Check for duplicate ports
    let mut seen_ports = HashSet::new();
    for tunnel in &tunnels {
        let port = if tunnel.tunnel_type == "remote" {
            tunnel.remote_port
        } else {
            tunnel.local_port
        };
        let key = format!("{}:{}", tunnel.tunnel_type, port);
        if seen_ports.contains(&key) {
            errors.push(format!(
                "Duplicate {} port: {}",
                tunnel.tunnel_type, port
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

#[cfg(test)]
mod tests {
    use super::parse_ssh_command;

    #[test]
    fn parses_dynamic_forward_flag() {
        let result = parse_ssh_command("ssh -D 1080 user@host");
        assert!(result.success);
        assert_eq!(result.tunnels.len(), 1);
        assert_eq!(result.tunnels[0].tunnel_type, "dynamic");
        assert_eq!(result.tunnels[0].local_port, 1080);
        assert_eq!(result.tunnels[0].remote_host, "*");
        assert_eq!(result.tunnels[0].remote_port, 0);
    }

    #[test]
    fn parses_mixed_local_and_dynamic() {
        let result =
            parse_ssh_command("ssh -L 8080:localhost:80 -D 1080 -R 9000:localhost:3000 user@host");
        assert!(result.success);
        assert_eq!(result.tunnels.len(), 3);
    }

    #[test]
    fn parses_dynamic_forward_with_hostname_bind() {
        let result = parse_ssh_command("ssh -D localhost:1080 user@host");
        assert!(result.success);
        assert_eq!(result.tunnels.len(), 1);
        assert_eq!(result.tunnels[0].tunnel_type, "dynamic");
        assert_eq!(result.tunnels[0].local_port, 1080);
    }

    #[test]
    fn parses_dynamic_forward_with_ipv4_bind() {
        let result = parse_ssh_command("ssh -D 0.0.0.0:1080 user@host");
        assert!(result.success);
        assert_eq!(result.tunnels[0].local_port, 1080);
    }

    #[test]
    fn parses_dynamic_forward_with_ipv6_bind() {
        let result = parse_ssh_command("ssh -D [::1]:1080 user@host");
        assert!(result.success);
        assert_eq!(result.tunnels[0].local_port, 1080);
    }
}
