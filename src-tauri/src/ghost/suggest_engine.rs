use std::future::Future;

use crate::commands::AppState;
use crate::ghost::context::RankingContext;
use crate::ghost::manager::GhostManager;
use crate::ghost::path_suggest::{
    path_suggestion, shell_id_indicates_wsl, uses_windows_paths, PathSuggestParams, PathSuggestion,
};
use crate::ghost::suffix::{normalize_suggestion_suffix, normalize_suggestion_suffix_with_reason};
use crate::ghost::suggest_types::{GhostSuggestV2Request, GhostSuggestV2Response};
use crate::ghost::token::{
    has_active_path_argument, has_unmatched_quote_on_active_token, is_bare_directory_listing_line,
    should_prefer_path_suggestion, should_use_ghost_for_line,
};

const HISTORY_CONFIDENCE: f32 = 0.72;
const PATH_CONFIDENCE: f32 = 0.84;

pub async fn suggest_v2(
    request: GhostSuggestV2Request,
    manager: &GhostManager,
    state: &AppState,
) -> GhostSuggestV2Response {
    let fs_connection_id = request
        .fs_connection_id
        .as_deref()
        .or(request.scope.as_deref())
        .unwrap_or("local");
    let wsl_shell_id = request
        .shell_id
        .as_deref()
        .filter(|id| fs_connection_id == "local" && shell_id_indicates_wsl(id));

    let recent_commands = request.recent_commands.as_deref().unwrap_or(&[]);
    suggest_with_path_provider(
        &request,
        manager,
        uses_windows_paths(fs_connection_id, wsl_shell_id),
        fetch_path_suggestion(
            &request.prefix,
            request.cwd.as_deref(),
            fs_connection_id,
            wsl_shell_id,
            recent_commands,
            state,
        ),
    )
    .await
}

async fn suggest_with_path_provider(
    request: &GhostSuggestV2Request,
    manager: &GhostManager,
    windows: bool,
    path: impl Future<Output = PathSuggestion>,
) -> GhostSuggestV2Response {
    let line = &request.prefix;
    if !should_use_ghost_for_line(line) {
        return GhostSuggestV2Response::empty("no_command");
    }
    let scope = request.scope.as_deref();
    let cwd = request.cwd.as_deref();
    let history_enabled = request.providers.history_enabled();
    let filesystem_enabled = request.providers.filesystem_enabled();
    let prefer_path = should_prefer_path_suggestion(line, windows);
    let recent_commands = request.recent_commands.as_deref().unwrap_or(&[]);
    let ranking_context = RankingContext {
        cwd,
        recent_commands,
    };
    let debug = request.debug.unwrap_or(false);
    tokio::pin!(path);
    let mut path_suppression = "path_unavailable";

    if prefer_path && filesystem_enabled {
        match path.as_mut().await {
            PathSuggestion::Match(suffix) => {
                return hit_normalized(line, &suffix, PATH_CONFIDENCE, "path", debug);
            }
            PathSuggestion::Miss => path_suppression = "no_path_match",
            PathSuggestion::Unknown => {}
        }
        // A stale history path is not evidence that the target still exists in
        // this directory. Keep ordinary command/flag history available below.
        if has_active_path_argument(line, windows) {
            return GhostSuggestV2Response::empty(path_suppression);
        }
    }

    let skip_history_for_bare_cd =
        prefer_path && filesystem_enabled && is_bare_directory_listing_line(line);
    let skip_history_for_open_quote = has_unmatched_quote_on_active_token(line);

    if history_enabled && !skip_history_for_bare_cd && !skip_history_for_open_quote {
        if let Some(suffix) = manager
            .suggest_with_context(line.clone(), scope, ranking_context)
            .await
        {
            // History after a bare file-aware command can introduce a path too
            // (`cat` -> `cat removed.txt`), not just continue a command name.
            if prefer_path
                && filesystem_enabled
                && has_active_path_argument(&format!("{line}{suffix}"), windows)
            {
                return GhostSuggestV2Response::empty(path_suppression);
            }
            return hit_normalized(line, &suffix, HISTORY_CONFIDENCE, "history", debug);
        }
    }

    if !prefer_path && filesystem_enabled {
        if let PathSuggestion::Match(suffix) = path.await {
            return hit_normalized(line, &suffix, PATH_CONFIDENCE, "path_fallback", debug);
        }
    }

    GhostSuggestV2Response::empty("no_match")
}

fn hit_normalized(
    line: &str,
    raw_suffix: &str,
    confidence: f32,
    source: &str,
    debug: bool,
) -> GhostSuggestV2Response {
    if debug {
        let normalized = normalize_suggestion_suffix_with_reason(line, raw_suffix);
        GhostSuggestV2Response::hit_with_debug(
            normalized.suffix,
            confidence,
            Some(raw_suffix.to_string()),
            Some(format!("{}:{}", source, normalized.spacing_reason)),
        )
    } else {
        GhostSuggestV2Response::hit(normalize_suggestion_suffix(line, raw_suffix), confidence)
    }
}

/// Keeps filesystem state lazy and indirect so the IPC command's by-value future stays small.
async fn fetch_path_suggestion(
    line: &str,
    cwd: Option<&str>,
    connection_id: &str,
    wsl_shell_id: Option<&str>,
    recent_commands: &[String],
    state: &AppState,
) -> PathSuggestion {
    // Keep large filesystem state out of the main-thread IPC future. Allocate it
    // only if provider selection actually polls this filesystem lookup.
    Box::pin(path_suggestion(PathSuggestParams {
        line,
        cwd,
        connection_id,
        wsl_shell_id,
        recent_commands,
        state,
    }))
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ghost::GhostManager;
    use std::path::PathBuf;

    fn test_dir(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("zync-ghost-p5-{}-{}", name, uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&p);
        p
    }

    fn request(prefix: &str) -> GhostSuggestV2Request {
        GhostSuggestV2Request {
            prefix: prefix.into(),
            scope: Some("local".into()),
            cwd: Some("/current".into()),
            shell_id: None,
            fs_connection_id: None,
            recent_commands: None,
            providers: Default::default(),
            debug: Some(true),
        }
    }

    #[tokio::test]
    async fn history_suggest_via_v2_engine() {
        let dir = test_dir("history");
        let mgr = GhostManager::new(&dir);
        mgr.commit("git checkout staging".to_string(), Some("local"))
            .await;

        let suggestion = suggest_with_path_provider(&request("git che"), &mgr, false, async {
            panic!("generic history must not issue a filesystem request");
        })
        .await;
        assert_eq!(suggestion.suffix, "ckout staging");
        assert!(suggestion.spacing_reason.unwrap().starts_with("history:"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn missing_path_does_not_revive_history_from_another_directory() {
        let dir = test_dir("missing-path");
        let mgr = GhostManager::new(&dir);
        for command in ["cat removed.txt", "cd removed", "echo ./removed"] {
            mgr.commit(command.into(), Some("local")).await;
        }
        for prefix in ["cat rem", "cat ", "cat", "cd rem", "echo ./rem"] {
            let suggestion = suggest_with_path_provider(&request(prefix), &mgr, false, async {
                PathSuggestion::Miss
            })
            .await;
            assert!(suggestion.suffix.is_empty(), "{prefix}");
            assert_eq!(suggestion.suppress_reason.as_deref(), Some("no_path_match"));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn unavailable_path_evidence_is_not_reported_as_a_confirmed_miss() {
        let dir = test_dir("unavailable-path");
        let mgr = GhostManager::new(&dir);
        for command in ["cat removed.txt", "cd removed", "echo ./removed"] {
            mgr.commit(command.into(), Some("local")).await;
        }
        // Missing CWD and a failed listing with known CWD are both unknown,
        // not evidence that a historical filename is valid or absent.
        for cwd in [None, Some("/current")] {
            for prefix in ["cat rem", "cat ", "cat", "cd rem", "echo ./rem"] {
                let mut request = request(prefix);
                request.cwd = cwd.map(String::from);
                let suggestion = suggest_with_path_provider(&request, &mgr, false, async {
                    PathSuggestion::Unknown
                })
                .await;
                assert!(suggestion.suffix.is_empty(), "{prefix}");
                assert_eq!(
                    suggestion.suppress_reason.as_deref(),
                    Some("path_unavailable"),
                    "{prefix}"
                );
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn explicit_path_evidence_is_used_without_a_cwd() {
        let dir = test_dir("explicit-path");
        let mgr = GhostManager::new(&dir);
        for prefix in ["cat /tmp/rem", "cat ~/rem"] {
            mgr.commit(format!("{prefix}oved.txt"), Some("local")).await;
            let mut request = request(prefix);
            request.cwd = None;
            let miss =
                suggest_with_path_provider(&request, &mgr, false, async { PathSuggestion::Miss })
                    .await;
            assert_eq!(miss.suppress_reason.as_deref(), Some("no_path_match"));
            let matched = suggest_with_path_provider(&request, &mgr, false, async {
                PathSuggestion::Match("aining.txt".into())
            })
            .await;
            assert_eq!(matched.suffix, "aining.txt");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn valid_path_wins_but_command_and_flag_history_remain_available() {
        let dir = test_dir("path-and-history");
        let mgr = GhostManager::new(&dir);
        for command in ["cat removed.txt", "lsblk", "ls -la"] {
            mgr.commit(command.into(), Some("local")).await;
        }
        let valid_path = suggest_with_path_provider(&request("cat re"), &mgr, false, async {
            PathSuggestion::Match("al.txt".into())
        })
        .await;
        assert_eq!(valid_path.suffix, "al.txt");
        assert!(valid_path.spacing_reason.unwrap().starts_with("path:"));
        for (prefix, suffix) in [("ls", "blk"), ("ls -l", "a")] {
            for outcome in [PathSuggestion::Miss, PathSuggestion::Unknown] {
                let suggestion =
                    suggest_with_path_provider(&request(prefix), &mgr, false, async { outcome })
                        .await;
                assert_eq!(suggestion.suffix, suffix, "{prefix}");
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn history_only_setting_does_not_add_filesystem_requests() {
        let dir = test_dir("history-only");
        let mgr = GhostManager::new(&dir);
        mgr.commit("cat remembered.txt".into(), Some("local")).await;
        let mut request = request("cat rem");
        request.providers.filesystem = Some(false);
        let suggestion = suggest_with_path_provider(&request, &mgr, false, async {
            panic!("disabled filesystem provider must not be polled");
        })
        .await;
        assert_eq!(suggestion.suffix, "embered.txt");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
