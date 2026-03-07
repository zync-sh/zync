use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ParsedSshConnection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub username: String,
    pub port: u16,
    pub private_key_path: Option<String>,
    pub jump_server_alias: Option<String>,
    pub jump_server_id: Option<String>,
}

pub fn parse_config(path: &Path) -> Result<Vec<ParsedSshConnection>> {
    if !path.exists() {
        return Ok(vec![]);
    }

    let content = fs::read_to_string(path)?;
    let mut connections = Vec::new();

    let mut current_host: Option<ParsedSshConnection> = None;

    for line in content.lines() {
        let line = strip_inline_comments(line).trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.is_empty() {
            continue;
        }

        // let key = parts[0].to_lowercase();
        // Handle "Key = Value" or "Key Value"
        // We'll simplisticly join the rest, assuming space separation without '=' for now,
        // or simplistic handling. The standard allows both.
        // Let's perform a cleaner value extraction.

        // Re-split strictly
        let (key_str, value_str) =
            if let Some(idx) = line.find(|c: char| c.is_whitespace() || c == '=') {
                let k = &line[..idx];
                let mut remainder = &line[idx..];
                // consume delimiter
                remainder = remainder.trim_start_matches(|c: char| c.is_whitespace() || c == '=');
                (k, remainder.trim())
            } else {
                (line, "")
            };

        if key_str.to_lowercase() == "host" {
            // Push previous
            if let Some(mut host) = current_host.take() {
                if !host.name.contains('*') && !host.name.contains('?') {
                    // Generate ID
                    host.id = format!("ssh_{}", uuid::Uuid::new_v4());
                    connections.push(host);
                }
            }

            // Start new - handle potential multiple aliases on Host line
            let primary_alias = value_str.split_whitespace().next().unwrap_or(value_str);

            current_host = Some(ParsedSshConnection {
                id: String::new(),               // Will be set on push
                name: primary_alias.to_string(), // First alias
                host: primary_alias.to_string(), // Default host to alias name
                username: whoami::username(),
                port: 22,
                private_key_path: None,
                jump_server_alias: None,
                jump_server_id: None,
            });
        } else if let Some(host) = current_host.as_mut() {
            match key_str.to_lowercase().as_str() {
                "hostname" => host.host = value_str.to_string(),
                "user" => host.username = value_str.to_string(),
                "port" => {
                    if let Ok(p) = value_str.parse() {
                        host.port = p;
                    }
                }
                "identityfile" => {
                    // expansion of ~ is tricky in rust std, but crucial
                    // Strip quotes FIRST
                    let mut path = value_str.trim_matches('"').trim_matches('\'').to_string();

                    // Then expand ~
                    if path.starts_with("~") {
                        if let Some(home) = dirs::home_dir() {
                            path = path.replacen("~", &home.to_string_lossy(), 1);
                        }
                    }
                    host.private_key_path = Some(path);
                }
                "proxyjump" => host.jump_server_alias = Some(value_str.to_string()),
                _ => {}
            }
        }
    }

    // Push last
    if let Some(mut host) = current_host.take() {
        if !host.name.contains('*') && !host.name.contains('?') {
            host.id = format!("ssh_{}", uuid::Uuid::new_v4());
            connections.push(host);
        }
    }

    // Pass 2: Resolve Jump Server Aliases to IDs
    let alias_map: std::collections::HashMap<String, String> = connections
        .iter()
        .map(|c| (c.name.clone(), c.id.clone()))
        .collect();

    for conn in &mut connections {
        if let Some(alias) = &conn.jump_server_alias {
            if let Some(jump_id) = alias_map.get(alias) {
                conn.jump_server_id = Some(jump_id.clone());
            }
        }
    }

    Ok(connections)
}

fn strip_inline_comments(line: &str) -> &str {
    let mut in_quotes = false;
    let mut quote_char = ' ';
    let mut escaped = false;

    for (i, c) in line.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if c == '\\' {
            escaped = true;
            continue;
        }
        if c == '"' || c == '\'' {
            if in_quotes {
                if c == quote_char {
                    in_quotes = false;
                }
            } else {
                in_quotes = true;
                quote_char = c;
            }
        }
        if c == '#' && !in_quotes {
            return &line[..i];
        }
    }
    line
}
