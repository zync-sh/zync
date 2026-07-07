use std::collections::HashSet;

use crate::ghost::parser::extract_search_prefix;

const DIRECTORY_ONLY_COMMANDS: &[&str] = &["cd", "pushd", "popd"];

const FILE_AWARE_COMMANDS: &[&str] = &[
    "cat", "ls", "less", "more", "head", "tail", "grep", "vim", "nvim", "nano", "cp", "mv", "rm",
    "mkdir", "rmdir", "touch", "find", "stat", "chmod", "chown",
];

const WRAPPER_COMMANDS: &[&str] = &["sudo", "env", "time", "nohup", "command"];

const FLAGS_WITH_ARG: &[&str] = &[
    "-u", "--user", "-g", "--group", "-o", "-p", "-t", "-c", "-s", "-f", "-k", "-m", "-n", "-d",
];

fn shell_tokenize(line: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut token = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0usize;

    while i < chars.len() {
        let ch = chars[i];
        if escaped {
            token.push(ch);
            escaped = false;
            i += 1;
            continue;
        }
        if ch == '\\' && !in_single {
            escaped = true;
            i += 1;
            continue;
        }
        if ch == '\'' && !in_double {
            in_single = !in_single;
            i += 1;
            continue;
        }
        if ch == '"' && !in_single {
            in_double = !in_double;
            i += 1;
            continue;
        }
        if ch == ' ' && !in_single && !in_double {
            if !token.is_empty() {
                tokens.push(std::mem::take(&mut token));
            }
            i += 1;
            continue;
        }
        token.push(ch);
        i += 1;
    }
    if !token.is_empty() {
        tokens.push(token);
    }
    tokens
}

/// Extract the last shell argument from a command line.
pub fn get_last_arg(line: &str) -> String {
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;
    let mut start = 0usize;
    let chars: Vec<char> = line.chars().collect();

    for (i, &ch) in chars.iter().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '\'' && !in_double {
            in_single = !in_single;
            continue;
        }
        if ch == '"' && !in_single {
            in_double = !in_double;
            continue;
        }
        if ch == ' ' && !in_single && !in_double {
            start = i + 1;
        }
    }

    chars[start..].iter().collect()
}

pub fn strip_leading_unmatched_quote(arg: &str) -> &str {
    if let Some(q) = arg.chars().next() {
        if (q == '"' || q == '\'') && !arg[1..].contains(q) {
            return &arg[1..];
        }
    }
    arg
}

pub fn get_command_name(line: &str) -> String {
    let trimmed = line.trim_start();
    if trimmed.is_empty() {
        return String::new();
    }
    let wrappers: HashSet<&str> = WRAPPER_COMMANDS.iter().copied().collect();
    let flags: HashSet<&str> = FLAGS_WITH_ARG.iter().copied().collect();
    let parts = shell_tokenize(trimmed);
    let mut i = 0usize;
    while i < parts.len() {
        let part_lower = parts[i].to_ascii_lowercase();
        if wrappers.contains(part_lower.as_str()) {
            while i + 1 < parts.len() {
                let next = &parts[i + 1];
                let next_lower = next.to_ascii_lowercase();
                if flags.contains(next_lower.as_str()) {
                    i += 2;
                    continue;
                }
                if next.starts_with('-') {
                    i += 1;
                    continue;
                }
                if part_lower == "env" && looks_like_env_assignment(next) {
                    i += 1;
                    continue;
                }
                break;
            }
            i += 1;
            continue;
        }
        if looks_like_env_assignment(&parts[i]) {
            i += 1;
            continue;
        }
        return part_lower;
    }
    String::new()
}

fn looks_like_env_assignment(token: &str) -> bool {
    let Some(eq_idx) = token.find('=') else {
        return false;
    };
    if eq_idx == 0 {
        return false;
    }
    let key = &token[..eq_idx];
    let mut chars = key.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first == '_' || first.is_ascii_alphabetic()) {
        return false;
    }
    chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

pub fn line_for_suggestion_parsing(line: &str) -> String {
    extract_search_prefix(line).unwrap_or_else(|| line.to_string())
}

pub fn has_unmatched_quote_on_active_token(line: &str) -> bool {
    let parse_line = line_for_suggestion_parsing(line);
    let arg = get_last_arg(&parse_line);
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;

    for ch in arg.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '\'' && !in_double {
            in_single = !in_single;
            continue;
        }
        if ch == '"' && !in_single {
            in_double = !in_double;
            continue;
        }
    }

    in_single || in_double
}

pub fn is_bare_directory_listing_line(line: &str) -> bool {
    let parse_line = line_for_suggestion_parsing(line);
    let trimmed = parse_line.trim_end();
    let command = get_command_name(trimmed);
    if !DIRECTORY_ONLY_COMMANDS.contains(&command.as_str()) {
        return false;
    }
    let last_arg = get_last_arg(trimmed);
    last_arg.is_empty() || last_arg.to_ascii_lowercase() == command
}

pub fn should_use_ghost_for_line(line: &str) -> bool {
    !get_command_name(&line_for_suggestion_parsing(line)).is_empty()
}

pub fn has_path_separator(arg: &str) -> bool {
    arg.contains('/') || arg.contains('\\')
}

pub fn is_directory_command(command: &str) -> bool {
    DIRECTORY_ONLY_COMMANDS.contains(&command)
}

pub fn is_file_aware_command(command: &str) -> bool {
    FILE_AWARE_COMMANDS.contains(&command)
}

pub fn should_prefer_path_suggestion(line: &str) -> bool {
    let parse_line = line_for_suggestion_parsing(line);
    let command = get_command_name(&parse_line);
    if is_directory_command(&command) || is_file_aware_command(&command) {
        return true;
    }
    let last_arg = get_last_arg(&parse_line);
    has_path_separator(&last_arg)
}

const LEAKED_SECRET_SYMBOLS: &str = "!#$%^&*()+{}[]|\\`";

const COMMON_COMMAND_FRAGMENTS: &[&str] = &[
    "make", "install", "build", "run", "test", "start", "stop", "clean", "deploy", "compile",
    "check", "lint", "format", "docker", "compose", "script", "exec", "setup", "config", "status",
];

/// Reject single-token secrets accidentally committed from password prompts.
pub fn history_entry_safe_to_store(cmd: &str) -> bool {
    !looks_like_leaked_secret(cmd)
}

fn looks_like_path_or_target(token: &str) -> bool {
    token.starts_with('~')
        || token.starts_with("./")
        || token.starts_with("../")
        || token.starts_with('/')
        || token.contains('/')
        || token.contains('.')
}

fn looks_like_credential_snake_case(token: &str) -> bool {
    if token.len() < 10 || !token.contains('_') || token != token.to_lowercase() {
        return false;
    }
    if token.starts_with("git_") || token.starts_with("npm_") {
        return false;
    }
    if looks_like_path_or_target(token) {
        return false;
    }
    let parts: Vec<&str> = token.split('_').filter(|part| !part.is_empty()).collect();
    if parts.len() < 2 || parts.iter().any(|part| part.len() < 3) {
        return false;
    }
    if !parts
        .iter()
        .all(|part| part.chars().all(|c| c.is_ascii_alphabetic()))
    {
        return false;
    }
    !parts
        .iter()
        .any(|part| COMMON_COMMAND_FRAGMENTS.contains(part))
}

fn looks_like_leaked_secret(cmd: &str) -> bool {
    let trimmed = cmd.trim();
    if trimmed.is_empty() || trimmed.contains(char::is_whitespace) {
        return false;
    }
    if looks_like_env_assignment(trimmed) || looks_like_path_or_target(trimmed) {
        return false;
    }
    if trimmed.chars().any(|c| LEAKED_SECRET_SYMBOLS.contains(c)) {
        return true;
    }
    looks_like_credential_snake_case(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipeline_active_segment_command_name() {
        let parse_line = line_for_suggestion_parsing("echo hi && git che");
        assert_eq!(get_command_name(&parse_line), "git");
    }

    #[test]
    fn bare_cd_is_directory_listing() {
        assert!(is_bare_directory_listing_line("cd"));
        assert!(is_bare_directory_listing_line("echo hi && cd"));
        assert!(!is_bare_directory_listing_line("cd Doc"));
    }

    #[test]
    fn leaked_secret_heuristic_filters_password_like_tokens() {
        assert!(!history_entry_safe_to_store("P@ssw0rd!"));
        assert!(!history_entry_safe_to_store("mertech_admin"));
        assert!(history_entry_safe_to_store("git status"));
        assert!(history_entry_safe_to_store("clear"));
        assert!(history_entry_safe_to_store("~/scripts/deploy.sh"));
        assert!(history_entry_safe_to_store("NODE_ENV=production"));
        assert!(history_entry_safe_to_store("make_install"));
    }
}