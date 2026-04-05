use crate::ai::types::ToolCall;

pub(super) fn is_conversational_question(question: &str) -> bool {
    let lower = question.to_lowercase();
    let patterns = [
        "what would you like",
        "what else would you",
        "what do you want",
        "what next",
        "is there anything else",
        "anything else i can",
        "would you like me to",
        "shall i continue",
        "do you want me to continue",
    ];
    patterns.iter().any(|pattern| lower.contains(pattern))
}

pub(super) fn needs_destructive_approval(command: &str) -> bool {
    let lower = command.to_lowercase();
    let tokens: Vec<&str> = lower.split_whitespace().collect();

    if tokens.iter().any(|token| *token == "rm" || *token == "unlink" || token.ends_with("/rm")) {
        return true;
    }
    if tokens.iter().any(|token| *token == "rmdir" || token.ends_with("/rmdir")) {
        return true;
    }
    for tool in &["shred", "srm", "wipe", "secure-delete"] {
        if tokens.iter().any(|token| *token == *tool || token.ends_with(&format!("/{}", tool))) {
            return true;
        }
    }
    if tokens.iter().any(|token| *token == "truncate" || token.ends_with("/truncate")) {
        return true;
    }
    if lower.contains("dd ") && lower.contains("of=") {
        return true;
    }
    false
}

pub(super) fn needs_service_approval(command: &str) -> bool {
    let lower = command.to_lowercase();
    let tokens: Vec<&str> = lower.split_whitespace().collect();

    if lower.contains("systemctl") {
        let verbs = ["stop", "disable", "mask", "kill", "reset-failed", "restart", "reload", "start"];
        if verbs.iter().any(|verb| lower.contains(verb)) {
            return true;
        }
    }
    if lower.contains("service ")
        && (lower.contains(" stop")
            || lower.contains(" restart")
            || lower.contains(" reload")
            || lower.contains(" start"))
    {
        return true;
    }
    for killer in &["kill", "pkill", "killall"] {
        if tokens.iter().any(|token| *token == *killer || token.ends_with(&format!("/{}", killer))) {
            return true;
        }
    }
    let halt_commands = ["reboot", "shutdown", "halt", "poweroff"];
    if halt_commands.iter().any(|name| tokens.iter().any(|token| *token == *name || token.ends_with(&format!("/{}", name)))) {
        return true;
    }
    for name in &["userdel", "groupdel", "usermod", "passwd", "visudo"] {
        if tokens.iter().any(|token| *token == *name || token.ends_with(&format!("/{}", name))) {
            return true;
        }
    }
    if lower.contains("crontab") && lower.contains("-r") {
        return true;
    }
    if (lower.contains("iptables") || lower.contains("ip6tables"))
        && (lower.contains("-f")
            || lower.contains("--flush")
            || lower.contains("-x")
            || lower.contains("-z")
            || lower.contains(" -D ")
            || lower.contains(" -D")
            || lower.contains("--delete"))
    {
        return true;
    }
    if lower.contains("ufw") && (lower.contains("delete") || lower.contains("reset") || lower.contains("disable")) {
        return true;
    }
    if (lower.contains("ip link") || lower.contains("ifconfig")) && (lower.contains(" down") || lower.contains(" delete")) {
        return true;
    }
    false
}

pub(super) fn needs_package_approval(command: &str) -> bool {
    let lower = command.to_lowercase();
    let tokens: Vec<&str> = lower
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '-'))
        .filter(|token| !token.is_empty())
        .collect();
    let managers = ["apt", "apt-get", "yum", "dnf", "pacman", "brew", "snap", "pip", "pip3", "npm", "gem"];
    let actions = ["install", "remove", "purge", "uninstall", "erase", "upgrade", "dist-upgrade", "update"];
    managers.iter().any(|manager| tokens.iter().any(|token| token == manager))
        && actions.iter().any(|action| tokens.iter().any(|token| token == action))
}

pub(super) fn parse_text_tool_calls(text: &str) -> Option<Vec<ToolCall>> {
    let trimmed = text.trim();
    if !trimmed.starts_with('[') {
        return None;
    }

    let arr = serde_json::from_str::<serde_json::Value>(trimmed).ok()?;
    let items = arr.as_array()?;
    if items.is_empty() {
        return None;
    }

    let calls: Vec<ToolCall> = items
        .iter()
        .filter_map(|item| {
            let name = item.get("name")?.as_str()?.to_string();
            let input = item.get("arguments").or_else(|| item.get("parameters")).cloned().unwrap_or(serde_json::json!({}));
            Some(ToolCall {
                id: uuid::Uuid::new_v4().simple().to_string()[..9].to_string(),
                name,
                input,
                thought_signature: None,
            })
        })
        .collect();

    if calls.is_empty() { None } else { Some(calls) }
}

pub(super) fn build_action_entry(tool_name: &str, input: &serde_json::Value, success: bool) -> Option<String> {
    match tool_name {
        "run_command" => {
            let command = input.get("command").and_then(|value| value.as_str()).unwrap_or("?");
            let truncated = if command.len() > 70 {
                let preview: String = command.chars().take(70).collect();
                format!("{}?", preview)
            } else {
                command.to_string()
            };
            Some(if success {
                format!("? {}", truncated)
            } else {
                format!("? Failed: {}", truncated)
            })
        }
        "write_file" => {
            let path = input.get("path").and_then(|value| value.as_str()).unwrap_or("?");
            Some(if success {
                format!("? Wrote: {}", path)
            } else {
                format!("? Write failed: {}", path)
            })
        }
        _ => None,
    }
}

pub(super) fn is_capability_refusal(text: &str) -> bool {
    let lower = text.to_lowercase();
    let patterns = [
        "i don't have the capability",
        "i currently don't have",
        "i'm unable to",
        "i am unable to",
        "cannot access or modify",
        "don't have direct access",
        "i cannot perform",
        "cannot directly",
        "i can guide you on how",
        "here are the steps you can follow",
        "you can use the following",
        "you would need to",
    ];
    patterns.iter().any(|pattern| lower.contains(pattern))
}

pub(super) fn is_sensitive_write_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    if lower.starts_with("/etc/") || lower.starts_with("/boot/") || lower.starts_with("/usr/") {
        return true;
    }
    let shell_files = [
        ".bashrc", ".bash_profile", ".profile", ".zshrc", ".zprofile",
        ".zshenv", ".bash_logout", ".inputrc", ".cshrc", ".tcshrc",
    ];
    if shell_files.iter().any(|file| lower.ends_with(file)) {
        return true;
    }
    if lower.contains("/.ssh/") || lower.ends_with("authorized_keys") || lower.ends_with("known_hosts") {
        return true;
    }
    if lower.contains("/cron") || lower.ends_with("crontab") {
        return true;
    }
    if lower.contains("/systemd/") || lower.ends_with(".service") || lower.ends_with(".timer") || lower.ends_with(".socket") {
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversational_questions_are_detected() {
        assert!(is_conversational_question("What would you like me to do next?"));
        assert!(!is_conversational_question("Allow restarting nginx?"));
    }

    #[test]
    fn destructive_commands_require_approval() {
        assert!(needs_destructive_approval("rm -rf /tmp/build"));
        assert!(needs_destructive_approval("truncate -s 0 app.log"));
        assert!(!needs_destructive_approval("ls -la"));
    }

    #[test]
    fn service_commands_require_approval() {
        assert!(needs_service_approval("systemctl restart nginx"));
        assert!(needs_service_approval("killall node"));
        assert!(!needs_service_approval("systemctl status nginx"));
    }

    #[test]
    fn package_commands_require_approval() {
        assert!(needs_package_approval("apt-get install nginx"));
        assert!(needs_package_approval("npm update react"));
        assert!(!needs_package_approval("npm run build"));
        assert!(!needs_package_approval("capture diagnostics"));
    }

    #[test]
    fn text_tool_calls_are_parsed() {
        let text = r#"[{"name":"run_command","arguments":{"command":"ls -la","reason":"inspect"}}]"#;
        let calls = parse_text_tool_calls(text).expect("tool calls");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "run_command");
        assert_eq!(calls[0].input["command"], "ls -la");
        assert_eq!(calls[0].id.len(), 9);
    }

    #[test]
    fn action_entries_are_human_readable() {
        let run_entry = build_action_entry("run_command", &serde_json::json!({"command":"ls -la"}), true);
        let write_entry = build_action_entry("write_file", &serde_json::json!({"path":"/etc/nginx.conf"}), false);
        assert_eq!(run_entry.as_deref(), Some("? ls -la"));
        assert_eq!(write_entry.as_deref(), Some("? Write failed: /etc/nginx.conf"));
    }

    #[test]
    fn capability_refusals_are_detected() {
        assert!(is_capability_refusal("I don't have the capability to access the server directly."));
        assert!(!is_capability_refusal("I inspected the server and restarted nginx."));
    }

    #[test]
    fn sensitive_paths_are_detected() {
        assert!(is_sensitive_write_path("/etc/nginx/nginx.conf"));
        assert!(is_sensitive_write_path("/home/user/.bashrc"));
        assert!(!is_sensitive_write_path("/tmp/scratch.txt"));
    }
}
