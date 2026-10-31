use crate::ghost::token::{
    get_command_name, get_last_arg, is_directory_command, is_file_aware_command,
    line_for_suggestion_parsing,
};

/// Per-request signals for P6 context-aware ranking.
#[derive(Debug, Clone, Copy, Default)]
pub struct RankingContext<'a> {
    pub cwd: Option<&'a str>,
    pub recent_commands: &'a [String],
}

impl<'a> RankingContext<'a> {
    pub fn empty() -> Self {
        Self {
            cwd: None,
            recent_commands: &[],
        }
    }
}

fn normalize_slashes(path: &str) -> String {
    path.replace('\\', "/")
}

fn normalize_cwd_for_compare(cwd: &str) -> String {
    let mut norm = normalize_slashes(cwd.trim());
    // Preserve Windows/WSL drive roots like `C:/`.
    if norm.len() == 3 && norm.as_bytes().get(1) == Some(&b':') && norm.ends_with('/') {
        return norm;
    }
    while norm.len() > 1 && norm.ends_with('/') {
        norm.pop();
    }
    norm
}

fn is_windows_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
}

fn is_relative_path_arg(arg: &str) -> bool {
    let trimmed = arg.trim();
    !trimmed.is_empty()
        && !trimmed.starts_with('/')
        && !trimmed.starts_with('~')
        && !is_windows_absolute(trimmed)
}

pub fn path_arg_from_history_command(cmd: &str) -> Option<String> {
    let segment = line_for_suggestion_parsing(cmd);
    let command = get_command_name(&segment);
    if !is_directory_command(&command) && !is_file_aware_command(&command) {
        return None;
    }
    let arg = get_last_arg(&segment);
    if arg.is_empty() || arg.eq_ignore_ascii_case(&command) {
        return None;
    }
    Some(arg)
}

fn path_starts_with_cwd(path: &str, cwd_norm: &str) -> bool {
    if path == cwd_norm {
        return true;
    }
    let prefix = if cwd_norm.ends_with('/') {
        cwd_norm.to_string()
    } else {
        format!("{cwd_norm}/")
    };
    path.starts_with(&prefix)
}

pub fn path_resolves_under_cwd(path_arg: &str, cwd: &str) -> bool {
    if is_relative_path_arg(path_arg) {
        return true;
    }
    let path = normalize_slashes(path_arg.trim());
    let path_norm = normalize_cwd_for_compare(&path);
    let cwd_norm = normalize_cwd_for_compare(cwd);
    if path == "~" || path.starts_with("~/") {
        return true;
    }
    if path.starts_with('/') {
        return path_starts_with_cwd(&path_norm, &cwd_norm);
    }
    if is_windows_absolute(&path) {
        return path_starts_with_cwd(&path_norm, &cwd_norm);
    }
    false
}

pub fn cwd_context_bonus(prefix: &str, history_cmd: &str, cwd: Option<&str>) -> i32 {
    let Some(cwd) = cwd.filter(|c| !c.trim().is_empty()) else {
        return 0;
    };
    let prefix_cmd = get_command_name(&line_for_suggestion_parsing(prefix));
    if !is_directory_command(&prefix_cmd) && prefix_cmd != "ls" {
        return 0;
    }
    let Some(arg) = path_arg_from_history_command(history_cmd) else {
        return 0;
    };
    if is_relative_path_arg(&arg) {
        return 4;
    }
    if path_resolves_under_cwd(&arg, cwd) {
        return 3;
    }
    -2
}

pub fn recent_session_bonus(history_cmd: &str, recent_commands: &[String]) -> i32 {
    if recent_commands.is_empty() {
        return 0;
    }
    let history_lower = history_cmd.to_ascii_lowercase();
    let family = get_command_name(history_cmd);
    let mut bonus = 0;
    for line in recent_commands {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.eq_ignore_ascii_case(history_cmd) {
            bonus = bonus.max(5);
            continue;
        }
        let line_lower = trimmed.to_ascii_lowercase();
        if line_lower == family {
            bonus = bonus.max(3);
        } else if line_lower.starts_with(&format!("{family} ")) {
            bonus = bonus.max(2);
        } else if history_lower.contains(&line_lower) || line_lower.contains(&history_lower) {
            bonus = bonus.max(1);
        }
    }
    bonus
}

/// Prepared recent-command evidence shared by every candidate in one path request.
pub struct RecentEntryContext {
    commands_lowercase: Vec<String>,
}

impl RecentEntryContext {
    /// Applies the existing ASCII normalization once per recent command, outside sorting.
    pub fn new(recent_commands: &[String]) -> Self {
        Self {
            commands_lowercase: recent_commands
                .iter()
                .map(|line| line.to_ascii_lowercase())
                .collect(),
        }
    }

    /// Preserves the existing name-substring bonus while normalizing each candidate once.
    pub fn name_bonus(&self, name: &str) -> i32 {
        if self.commands_lowercase.is_empty() {
            return 0;
        }
        let name_lower = name.to_ascii_lowercase();
        if self
            .commands_lowercase
            .iter()
            .any(|line| line.contains(&name_lower))
        {
            2
        } else {
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_cd_history_gets_cwd_bonus() {
        let bonus = cwd_context_bonus("cd Doc", "cd Documents", Some("/home/me/projects"));
        assert_eq!(bonus, 4);
    }

    #[test]
    fn absolute_outside_cwd_gets_penalty() {
        let bonus = cwd_context_bonus("cd ", "cd /var/log", Some("/home/me/projects"));
        assert_eq!(bonus, -2);
    }

    #[test]
    fn sudo_cd_history_uses_wrapper_aware_command() {
        let bonus = cwd_context_bonus("cd Doc", "sudo cd Documents", Some("/home/me/projects"));
        assert_eq!(bonus, 4);
    }

    #[test]
    fn windows_drive_root_cwd_matching() {
        assert!(path_resolves_under_cwd("C:/Users/me", "C:/"));
        assert!(!path_resolves_under_cwd("D:/data", "C:/"));
    }

    #[test]
    fn recent_exact_command_boosts() {
        let recent = vec!["git status".to_string()];
        assert_eq!(recent_session_bonus("git status", &recent), 5);
        assert_eq!(recent_session_bonus("git stash", &recent), 2);
    }
}
