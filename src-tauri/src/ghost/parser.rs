use crate::ghost::types::MIN_PREFIX_LEN;

/// Strip leading shell keywords/wrappers that should not anchor history lookup.
/// e.g. "and git status" → "git status", "sudo git status" → "git status"
fn strip_shell_keywords_once(s: &str) -> &str {
    const KEYWORDS: &[&str] = &[
        "and ", "or ", "not ", "if ", "while ", "begin ", "command ", "builtin ", "exec ",
        "sudo ", "doas ", "time ", "env ", "noglob ",
    ];
    for kw in KEYWORDS {
        if s.starts_with(kw) {
            return s[kw.len()..].trim_start();
        }
    }
    s
}

fn strip_shell_keywords_recursive(mut s: &str) -> &str {
    loop {
        let next = strip_shell_keywords_once(s);
        if next.len() == s.len() {
            return s;
        }
        s = next;
    }
}

fn looks_like_env_assignment(token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
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

fn strip_leading_assignments(mut s: &str) -> &str {
    loop {
        let trimmed = s.trim_start();
        if trimmed.is_empty() {
            return trimmed;
        }
        let next_ws = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
        let token = &trimmed[..next_ws];
        if !looks_like_env_assignment(token) {
            return trimmed;
        }
        s = &trimmed[next_ws..];
    }
}

/// Extract the active command segment for inline suggestions.
/// - Keeps only text after the last unquoted command separator (`;`, `|`, `&&`, `||`, newline)
/// - Strips leading shell wrappers (`sudo`, `env`, etc.)
/// - Returns None when the segment is empty or not suitable for inline suggestion.
pub fn extract_search_prefix(input: &str) -> Option<String> {
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;
    let mut segment_start = 0usize;
    let chars: Vec<char> = input.chars().collect();

    let mut i = 0usize;
    while i < chars.len() {
        let ch = chars[i];

        if escaped {
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

        if !in_single && !in_double {
            if ch == '\n' || ch == '\r' || ch == ';' {
                segment_start = i + 1;
            } else if ch == '|' {
                segment_start = i + 1;
                if i + 1 < chars.len() && chars[i + 1] == '|' {
                    segment_start = i + 2;
                    i += 1;
                }
            } else if ch == '&' && i + 1 < chars.len() && chars[i + 1] == '&' {
                segment_start = i + 2;
                i += 1;
            }
        }

        i += 1;
    }

    // Reject unterminated quoted contexts: an unmatched opening quote anywhere in
    // the segment means the user is still inside a string literal.
    if in_single || in_double {
        return None;
    }

    let segment: String = chars[segment_start..].iter().collect();
    let mut s = segment.trim_start();
    s = strip_shell_keywords_recursive(s);
    s = strip_leading_assignments(s);
    if s.len() < MIN_PREFIX_LEN {
        return None;
    }
    if matches!(s.chars().next_back(), Some('\'') | Some('"') | Some('\\')) {
        return None;
    }
    Some(s.to_string())
}

fn prefix_matches(candidate: &str, prefix: &str, case_insensitive: bool) -> bool {
    if case_insensitive {
        let candidate_lower = candidate.to_lowercase();
        let prefix_lower = prefix.to_lowercase();
        candidate_lower.starts_with(&prefix_lower) && candidate_lower != prefix_lower
    } else {
        candidate.starts_with(prefix) && candidate != prefix
    }
}

fn suffix_after_prefix(candidate: &str, prefix: &str) -> Option<String> {
    let prefix_chars = prefix.chars().count();
    let byte_idx = candidate
        .char_indices()
        .nth(prefix_chars)
        .map(|(i, _)| i)
        .unwrap_or(candidate.len());
    candidate.get(byte_idx..).map(|s| s.to_string())
}

/// Suffix to append to the user's line when `prefix` matches a history command.
/// Tries the full stored command first, then the command's active tail segment.
pub fn history_suffix_for_command(
    cmd: &str,
    prefix: &str,
    case_insensitive: bool,
) -> Option<String> {
    if prefix_matches(cmd, prefix, case_insensitive) {
        return suffix_after_prefix(cmd, prefix);
    }
    if let Some(segment) = extract_search_prefix(cmd) {
        if prefix_matches(&segment, prefix, case_insensitive) {
            return suffix_after_prefix(&segment, prefix);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{extract_search_prefix, history_suffix_for_command};

    #[test]
    fn strips_shell_wrappers() {
        assert_eq!(
            extract_search_prefix("sudo env git sta"),
            Some("git sta".to_string())
        );
    }

    #[test]
    fn strips_env_assignments_after_wrappers() {
        assert_eq!(
            extract_search_prefix("env FOO=1 BAR_baz=ok git sta"),
            Some("git sta".to_string())
        );
    }

    #[test]
    fn respects_last_segment_after_separators() {
        assert_eq!(
            extract_search_prefix("echo hi && git che"),
            Some("git che".to_string())
        );
        assert_eq!(
            extract_search_prefix("ls -la | grep x\ncd /va"),
            Some("cd /va".to_string())
        );
    }

    #[test]
    fn suppresses_unstable_quote_context() {
        assert_eq!(extract_search_prefix("git commit -m \""), None);
        assert_eq!(extract_search_prefix("cd /var/\\"), None);
        // Quote is not the last char but still unterminated — must also suppress.
        assert_eq!(extract_search_prefix("git commit -m \"foo bar"), None);
        assert_eq!(extract_search_prefix("echo 'hello world"), None);
    }

    #[test]
    fn history_suffix_matches_pipeline_tail_with_spacing() {
        let cmd = "echo hi && git checkout staging";
        assert_eq!(
            history_suffix_for_command(cmd, "git", false),
            Some(" checkout staging".to_string())
        );
        assert_eq!(
            history_suffix_for_command(cmd, "git ", false),
            Some("checkout staging".to_string())
        );
        assert_eq!(
            history_suffix_for_command(cmd, "git che", false),
            Some("ckout staging".to_string())
        );
    }
}
