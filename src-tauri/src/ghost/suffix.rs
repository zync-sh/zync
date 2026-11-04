#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedSuffix {
    pub suffix: String,
    pub spacing_reason: &'static str,
}

/// Normalize ghost suffix spacing against the full typed line.
///
/// Providers own word boundaries:
/// - History mid-token: no leading space (`ls` + `blk` → `lsblk`)
/// - History new word: leading space (`ssh` + ` 172…`)
/// - Path mid-token: no leading space (`cd Doc` + `uments/`)
/// - Path new arg: leading space from path suggest (`cd` + ` Documents/`)
///
/// Normalize only strips a duplicate leading space when the line already ends
/// with whitespace. It never invents a leading space (that caused `ls blk`).
#[cfg(test)]
pub fn normalize_suggestion_suffix(line: &str, suffix: &str) -> String {
    normalize_suggestion_suffix_with_reason(line, suffix).suffix
}

pub fn normalize_suggestion_suffix_with_reason(line: &str, suffix: &str) -> NormalizedSuffix {
    if suffix.is_empty() {
        return NormalizedSuffix {
            suffix: String::new(),
            spacing_reason: "empty_suffix",
        };
    }

    let ends_with_space = line.ends_with(' ') || line.ends_with('\t');
    if ends_with_space {
        return NormalizedSuffix {
            suffix: suffix.trim_start_matches([' ', '\t']).to_string(),
            spacing_reason: "strip_duplicate_leading_space",
        };
    }

    // Provider-encoded boundary or mid-token continuation — pass through as-is.
    NormalizedSuffix {
        suffix: suffix.to_string(),
        spacing_reason: if suffix.starts_with(' ') || suffix.starts_with('\t') {
            "keep_provider_leading_space"
        } else {
            "glue_provider_suffix"
        },
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_suggestion_suffix;
    use crate::ghost::token::line_for_suggestion_parsing;

    #[test]
    fn pipeline_active_segment_is_tail_command_only() {
        assert_eq!(line_for_suggestion_parsing("echo hi && git"), "git");
    }

    #[test]
    fn keeps_history_leading_space_for_new_word() {
        assert_eq!(
            normalize_suggestion_suffix("echo hi && git", " checkout staging"),
            " checkout staging"
        );
        assert_eq!(
            normalize_suggestion_suffix("ssh", " 172.16.9.9"),
            " 172.16.9.9"
        );
        assert_eq!(
            normalize_suggestion_suffix("git status", " modified"),
            " modified"
        );
    }

    #[test]
    fn never_invents_leading_space_for_mid_token() {
        // History `lsblk` after typing `ls` — must not become `ls blk`.
        assert_eq!(normalize_suggestion_suffix("ls", "blk"), "blk");
        assert_eq!(normalize_suggestion_suffix("lsb", "lk"), "lk");
        assert_eq!(
            normalize_suggestion_suffix("s", "sh 172.16.9.9"),
            "sh 172.16.9.9"
        );
        assert_eq!(normalize_suggestion_suffix("c", "lear"), "lear");
        assert_eq!(
            normalize_suggestion_suffix("git che", "ckout staging"),
            "ckout staging"
        );
        assert_eq!(normalize_suggestion_suffix("cd Doc", "uments/"), "uments/");
        assert_eq!(normalize_suggestion_suffix("cd /usr/l", "ocal/"), "ocal/");
        // Path provider forgot a space: we still don't invent one (path must emit it).
        assert_eq!(
            normalize_suggestion_suffix("echo hi && git", "checkout staging"),
            "checkout staging"
        );
    }

    #[test]
    fn strips_leading_space_when_line_ends_with_space() {
        assert_eq!(
            normalize_suggestion_suffix("echo hi && git ", "checkout staging"),
            "checkout staging"
        );
        assert_eq!(
            normalize_suggestion_suffix("cd ", " Documents/"),
            "Documents/"
        );
    }

    #[test]
    fn keeps_path_provider_leading_space_on_bare_cd() {
        assert_eq!(
            normalize_suggestion_suffix("cd", " Documents/"),
            " Documents/"
        );
        assert_eq!(normalize_suggestion_suffix("cd", " /usr"), " /usr");
        assert_eq!(normalize_suggestion_suffix("cd", " ~/src"), " ~/src");
        assert_eq!(
            normalize_suggestion_suffix("cd", " .acme.sh/"),
            " .acme.sh/"
        );
    }

    #[test]
    fn mid_token_dot_path_glues_without_space() {
        assert_eq!(normalize_suggestion_suffix("cd .acme", "sh/"), "sh/");
        assert_eq!(normalize_suggestion_suffix("cd .", "acme.sh/"), "acme.sh/");
    }
}
