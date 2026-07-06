use crate::ghost::parser::history_suffix_for_command;
use crate::ghost::types::ScopeHistory;

fn command_name(prefix: &str) -> &str {
    prefix.split_whitespace().next().unwrap_or("")
}

fn has_shell_separator(s: &str) -> bool {
    s.contains(';') || s.contains('|') || s.contains('&') || s.contains('\n') || s.contains('\r')
}

fn suffix_bonus_for_command(prefix: &str, suffix: &str) -> i32 {
    let mut bonus = 0;
    let cmd = command_name(prefix).to_ascii_lowercase();
    let suffix_trimmed = suffix.trim_start();
    let has_space = suffix_trimmed.contains(' ');

    match cmd.as_str() {
        "cd" | "pushd" => {
            if suffix_trimmed.starts_with('/')
                || suffix_trimmed.starts_with("~/")
                || suffix_trimmed.starts_with("./")
                || suffix_trimmed.starts_with("../")
            {
                bonus += 3;
            }
            // Prefer single path token completions over chained command tails.
            if !has_space {
                bonus += 3;
            } else {
                bonus -= 2;
            }
        }
        "ssh" | "scp" | "sftp" | "rsync" => {
            if suffix_trimmed.contains('@') {
                bonus += 2;
            }
            if suffix_trimmed.contains('.') || suffix_trimmed.contains('-') || suffix_trimmed.contains(':') {
                bonus += 1;
            }
            if !has_space {
                bonus += 1;
            } else {
                bonus -= 2;
            }
        }
        _ => {}
    }

    if has_shell_separator(suffix) {
        bonus -= 3;
    }

    bonus
}

/// Return the best inline suffix for a prefix match, ranked by:
///   1. highest frecency score
///   2. higher command bonus
///   3. shorter suffix length
///   4. recency order in history (stable fallback)
pub fn best_suffix_for_prefix(
    scope: &ScopeHistory,
    prefix: &str,
    case_insensitive: bool,
) -> Option<String> {
    let mut best_suffix: Option<String> = None;
    let mut best_score = f64::NEG_INFINITY;
    let mut best_suffix_len = usize::MAX;
    let mut best_bonus = i32::MIN;
    let mut best_idx = usize::MAX;

    for (idx, cmd) in scope.history.iter().enumerate() {
        let Some(suffix) = history_suffix_for_command(cmd, prefix, case_insensitive) else {
            continue;
        };

        let score = scope.scores.get(cmd).map(|e| e.live_score()).unwrap_or(0.0);
        let suffix_len = suffix.chars().count();
        let bonus = suffix_bonus_for_command(prefix, &suffix);

        if score > best_score
            || (score == best_score && bonus > best_bonus)
            || (score == best_score && bonus == best_bonus && suffix_len < best_suffix_len)
            || (score == best_score
                && bonus == best_bonus
                && suffix_len == best_suffix_len
                && idx < best_idx)
        {
            best_suffix = Some(suffix);
            best_score = score;
            best_bonus = bonus;
            best_suffix_len = suffix_len;
            best_idx = idx;
        }
    }

    best_suffix
}

pub fn ranked_candidates_for_prefix(
    scope: &ScopeHistory,
    prefix: &str,
    case_insensitive: bool,
    limit: usize,
) -> Vec<String> {
    if limit == 0 {
        return Vec::new();
    }
    let mut candidates: Vec<(String, f64, i32, usize, usize)> = Vec::new();

    for (idx, cmd) in scope.history.iter().enumerate() {
        let Some(suffix) = history_suffix_for_command(cmd, prefix, case_insensitive) else {
            continue;
        };

        let score = scope.scores.get(cmd).map(|e| e.live_score()).unwrap_or(0.0);
        let suffix_len = suffix.chars().count();
        let bonus = suffix_bonus_for_command(prefix, &suffix);
        candidates.push((suffix, score, bonus, suffix_len, idx));
    }

    candidates.sort_by(|a, b| {
        // score desc, command bonus desc, suffix_len asc, recency asc(index)
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.2.cmp(&a.2))
            .then_with(|| a.3.cmp(&b.3))
            .then_with(|| a.4.cmp(&b.4))
    });

    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut seen_ci = std::collections::HashSet::new();
    for (suffix, _, _, _, _) in candidates {
        let suffix_ci = suffix.to_ascii_lowercase();
        if seen.insert(suffix.clone()) && seen_ci.insert(suffix_ci) {
            out.push(suffix);
            if out.len() >= limit {
                break;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{best_suffix_for_prefix, ranked_candidates_for_prefix};
    use crate::ghost::types::ScopeHistory;

    #[test]
    fn prefers_shorter_suffix_when_scores_equal() {
        let scope = ScopeHistory {
            history: vec![
                "git checkout main".to_string(),
                "git checkout feature/very-long-branch".to_string(),
            ],
            scores: Default::default(),
        };

        let best = best_suffix_for_prefix(&scope, "git checkout ", false)
            .expect("expected best suffix");
        assert_eq!(best, "main");
    }

    #[test]
    fn ranked_candidates_are_unique_and_stable() {
        let scope = ScopeHistory {
            history: vec![
                "git status".to_string(),
                "git stash".to_string(),
                "git status".to_string(),
            ],
            scores: Default::default(),
        };

        let out = ranked_candidates_for_prefix(&scope, "git st", false, 10);
        assert_eq!(out, vec!["ash".to_string(), "atus".to_string()]);
    }

    #[test]
    fn command_bonus_prefers_pathy_cd_suffixes() {
        let scope = ScopeHistory {
            history: vec!["cd notes".to_string(), "cd /var/log".to_string()],
            scores: Default::default(),
        };

        let best = best_suffix_for_prefix(&scope, "cd ", false).expect("expected suffix");
        assert_eq!(best, "/var/log");
    }

    #[test]
    fn command_bonus_prefers_user_host_for_ssh() {
        let scope = ScopeHistory {
            history: vec!["ssh prod".to_string(), "ssh root@prod".to_string()],
            scores: Default::default(),
        };

        let best = best_suffix_for_prefix(&scope, "ssh ", false).expect("expected suffix");
        assert_eq!(best, "root@prod");
    }

    #[test]
    fn command_bonus_penalizes_chained_cd_suffixes() {
        let scope = ScopeHistory {
            history: vec![
                "cd Documents && ls".to_string(),
                "cd Documents".to_string(),
            ],
            scores: Default::default(),
        };

        let best = best_suffix_for_prefix(&scope, "cd Doc", false).expect("expected suffix");
        assert_eq!(best, "uments");
    }

    #[test]
    fn pipeline_history_suffix_uses_active_segment_spacing() {
        let scope = ScopeHistory {
            history: vec!["echo hi && git checkout staging".to_string()],
            scores: Default::default(),
        };

        assert_eq!(
            best_suffix_for_prefix(&scope, "git", false),
            Some(" checkout staging".to_string())
        );
        assert_eq!(
            best_suffix_for_prefix(&scope, "git ", false),
            Some("checkout staging".to_string())
        );
    }

    #[test]
    fn ranked_candidates_dedup_case_insensitive() {
        let scope = ScopeHistory {
            history: vec!["git status".to_string(), "git Status".to_string()],
            scores: Default::default(),
        };

        let out = ranked_candidates_for_prefix(&scope, "git st", true, 10);
        assert_eq!(out.len(), 1);
    }
}
