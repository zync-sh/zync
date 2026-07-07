use crate::ghost::context::RankingContext;
use crate::ghost::parser::extract_search_prefix;
use crate::ghost::ranking::{best_suffix_for_prefix, ranked_candidates_for_prefix};
use crate::ghost::types::{
    FrecencyEntry, GhostData, LegacyGhostData, ScopeHistory, MAX_HISTORY, MIN_PREFIX_LEN,
    SAVE_INTERVAL,
};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use tokio::sync::Mutex;

pub struct GhostManager {
    data: Mutex<GhostData>,
    persist_path: PathBuf,
    commit_count: Mutex<u32>,
    /// Serializes concurrent save_inner calls so tmp files never clobber each other.
    save_lock: Mutex<()>,
}

impl GhostManager {
    /// Create a manager, loading persisted history from `data_dir` if available.
    pub fn new(data_dir: &PathBuf) -> Self {
        let persist_path = data_dir.join("ghost_history.json");

        let data = std::fs::read_to_string(&persist_path)
            .ok()
            .and_then(|s| {
                serde_json::from_str::<GhostData>(&s).ok().or_else(|| {
                    serde_json::from_str::<LegacyGhostData>(&s).ok().map(|legacy| {
                        let mut scopes = HashMap::new();
                        scopes.insert(
                            "local".to_string(),
                            ScopeHistory {
                                history: legacy.history,
                                scores: legacy.scores,
                            },
                        );
                        GhostData {
                            scopes,
                            imported_scopes: Default::default(),
                        }
                    })
                })
            })
            .unwrap_or_default();

        Self {
            data: Mutex::new(data),
            persist_path,
            commit_count: Mutex::new(0),
            save_lock: Mutex::new(()),
        }
    }

    /// Serialize to disk atomically: write to a unique temp file then rename so
    /// a crash mid-write never leaves a partial/corrupt history file.
    /// The save_lock serializes concurrent callers so tmp files never clobber each other.
    async fn save_inner(&self, data: &GhostData) {
        let json = match serde_json::to_string(data) {
            Ok(j) => j,
            Err(e) => {
                eprintln!("[Ghost] Failed to serialize history: {}", e);
                return;
            }
        };

        let _guard = self.save_lock.lock().await;

        // Unique tmp path per save: pid + monotonic counter via timestamp.
        let unique = format!(
            "tmp.{}.{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0),
        );
        let tmp_path = self.persist_path.with_extension(unique);

        if let Err(e) = tokio::fs::write(&tmp_path, &json).await {
            eprintln!("[Ghost] Failed to write tmp history: {}", e);
            return;
        }

        if let Err(e) = tokio::fs::rename(&tmp_path, &self.persist_path).await {
            eprintln!("[Ghost] Failed to rename tmp history: {}", e);
            let _ = tokio::fs::remove_file(&tmp_path).await;
        }
    }

    /// Remove score entries for commands that are no longer in `history` so the
    /// scores map stays bounded alongside the history ring buffer.
    fn prune_evicted_scores(scope: &mut crate::ghost::types::ScopeHistory) {
        let in_history: std::collections::HashSet<&String> = scope.history.iter().collect();
        scope.scores.retain(|cmd, _| in_history.contains(cmd));
    }

    fn normalize_scope(scope: Option<&str>) -> String {
        let s = scope.unwrap_or("local").trim();
        if s.is_empty() {
            "local".to_string()
        } else {
            s.to_string()
        }
    }

    /// Add `command` to history and bump its frecency score.
    pub async fn commit(&self, command: String, scope: Option<&str>) {
        let trimmed = command.trim().to_string();
        if trimmed.len() < MIN_PREFIX_LEN {
            return;
        }
        if !crate::ghost::token::history_entry_safe_to_store(&trimmed) {
            return;
        }

        let mut data = self.data.lock().await;
        let scope_key = Self::normalize_scope(scope);
        let scope_data = data.scopes.entry(scope_key).or_default();

        // Dedup — remove existing, prepend so most-recent is always index 0.
        scope_data.history.retain(|e| e != &trimmed);
        scope_data.history.insert(0, trimmed.clone());
        if scope_data.history.len() > MAX_HISTORY {
            scope_data.history.truncate(MAX_HISTORY);
            Self::prune_evicted_scores(scope_data);
        }

        // Frecency bump.
        scope_data
            .scores
            .entry(trimmed)
            .or_insert_with(FrecencyEntry::new_with_bump)
            .bump();

        // Periodic save.
        let should_save = {
            let mut count = self.commit_count.lock().await;
            *count += 1;
            if *count >= SAVE_INTERVAL {
                *count = 0;
                true
            } else {
                false
            }
        };

        let snapshot = if should_save {
            Some(data.clone())
        } else {
            None
        };
        drop(data);

        if let Some(snapshot) = snapshot {
            self.save_inner(&snapshot).await;
        }
    }

    /// Return the best-scoring suffix that completes `prefix`, or `None`.
    ///
    /// Matching runs in two tiers (fish-style inline autosuggest):
    ///   Tier 1 — case-sensitive prefix
    ///   Tier 2 — case-insensitive prefix
    pub async fn suggest(&self, prefix: String, scope: Option<&str>) -> Option<String> {
        self.suggest_with_context(prefix, scope, RankingContext::empty())
            .await
    }

    pub async fn suggest_with_context(
        &self,
        prefix: String,
        scope: Option<&str>,
        context: RankingContext<'_>,
    ) -> Option<String> {
        let Some(trimmed_prefix) = extract_search_prefix(&prefix) else {
            return None;
        };

        let data = self.data.lock().await;
        let scope_key = Self::normalize_scope(scope);
        let Some(scope_data) = data.scopes.get(&scope_key) else {
            return None;
        };

        // ── Tier 1: case-sensitive prefix ────────────────────────────────────────
        if let Some(suffix) = best_suffix_for_prefix(scope_data, &trimmed_prefix, false, context) {
            return Some(suffix);
        }

        // ── Tier 2: case-insensitive prefix ──────────────────────────────────────
        best_suffix_for_prefix(scope_data, &trimmed_prefix, true, context)
    }

    /// Called when the user explicitly accepts a suggestion (Tab / →).
    /// Gives an extra frecency bump and saves immediately.
    pub async fn accept(&self, command: String, scope: Option<&str>) {
        let trimmed = command.trim().to_string();
        if trimmed.len() < MIN_PREFIX_LEN {
            return;
        }
        if !crate::ghost::token::history_entry_safe_to_store(&trimmed) {
            return;
        }

        let mut data = self.data.lock().await;
        let scope_key = Self::normalize_scope(scope);
        let scope_data = data.scopes.entry(scope_key).or_default();

        let entry = scope_data
            .scores
            .entry(trimmed.clone())
            .or_insert_with(FrecencyEntry::new_with_bump);
        entry.bump(); // one extra bump on top of the commit bump

        // Guarantee it's in history.
        if !scope_data.history.contains(&trimmed) {
            scope_data.history.insert(0, trimmed);
            if scope_data.history.len() > MAX_HISTORY {
                scope_data.history.truncate(MAX_HISTORY);
                Self::prune_evicted_scores(scope_data);
            }
        }

        let snapshot = data.clone();
        drop(data);

        // Always persist on explicit accept.
        self.save_inner(&snapshot).await;
    }

    /// Returns true when this scope already received a remote shell-history import.
    pub async fn is_scope_imported(&self, scope: Option<&str>) -> bool {
        let data = self.data.lock().await;
        let scope_key = Self::normalize_scope(scope);
        data.imported_scopes.contains(&scope_key)
    }

    /// One-time seed from parsed remote shell history (P7). Never logs command text.
    pub async fn seed_shell_history(&self, scope: Option<&str>, commands: &[String]) -> u32 {
        let scope_key = Self::normalize_scope(scope);
        let mut data = self.data.lock().await;
        if data.imported_scopes.contains(&scope_key) {
            return 0;
        }

        let scope_data = data.scopes.entry(scope_key.clone()).or_default();
        let mut known: HashSet<String> = scope_data.history.iter().cloned().collect();
        let mut to_prepend: Vec<String> = Vec::new();

        // Oldest first so newer file entries end up closer to index 0.
        for cmd in commands.iter().rev() {
            let trimmed = cmd.trim().to_string();
            if trimmed.len() < MIN_PREFIX_LEN || !known.insert(trimmed.clone()) {
                continue;
            }
            to_prepend.push(trimmed);
        }

        if to_prepend.is_empty() {
            return 0;
        }

        for trimmed in &to_prepend {
            scope_data.history.insert(0, trimmed.clone());
            scope_data
                .scores
                .entry(trimmed.clone())
                .or_insert_with(FrecencyEntry::new_with_bump);
        }
        let imported = to_prepend.len() as u32;

        if scope_data.history.len() > MAX_HISTORY {
            scope_data.history.truncate(MAX_HISTORY);
            Self::prune_evicted_scores(scope_data);
        }

        data.imported_scopes.insert(scope_key);
        let snapshot = data.clone();
        drop(data);

        self.save_inner(&snapshot).await;
        imported
    }

    pub async fn candidates(
        &self,
        prefix: String,
        scope: Option<&str>,
        limit: usize,
    ) -> Vec<String> {
        let Some(trimmed_prefix) = extract_search_prefix(&prefix) else {
            return Vec::new();
        };

        let data = self.data.lock().await;
        let scope_key = Self::normalize_scope(scope);
        let Some(scope_data) = data.scopes.get(&scope_key) else {
            return Vec::new();
        };

        let lim = limit.clamp(1, 64);
        let ctx = RankingContext::empty();
        let mut out = ranked_candidates_for_prefix(scope_data, &trimmed_prefix, false, lim, ctx);
        if out.len() < lim {
            let more = ranked_candidates_for_prefix(
                scope_data,
                &trimmed_prefix,
                true,
                lim.saturating_sub(out.len()),
                ctx,
            );
            for suffix in more {
                if !out.contains(&suffix) {
                    out.push(suffix);
                    if out.len() >= lim {
                        break;
                    }
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::GhostManager;
    use std::path::PathBuf;

    fn test_dir(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("zync-ghost-test-{}-{}", name, std::process::id()));
        let _ = std::fs::create_dir_all(&p);
        p
    }

    #[tokio::test]
    async fn scope_isolation_for_suggestions() {
        let dir = test_dir("scope-isolation");
        let mgr = GhostManager::new(&dir);

        mgr.commit("git status".to_string(), Some("server-a")).await;
        mgr.commit("kubectl get pods".to_string(), Some("server-b"))
            .await;

        let a = mgr.suggest("git st".to_string(), Some("server-a")).await;
        let b = mgr.suggest("git st".to_string(), Some("server-b")).await;

        // Assert Option directly so None and Some("") are distinguishable.
        assert_eq!(a, Some("atus".to_string()));
        assert_eq!(b, None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_scope_normalizes_to_local() {
        let local = GhostManager::normalize_scope(Some("  "));
        assert_eq!(local, "local");
        let explicit = GhostManager::normalize_scope(Some("server-x"));
        assert_eq!(explicit, "server-x");
    }

    #[tokio::test]
    async fn seed_shell_history_imports_once_per_scope() {
        let dir = test_dir("seed-history");
        let mgr = GhostManager::new(&dir);

        let imported = mgr
            .seed_shell_history(
                Some("server-a"),
                &["clear".to_string(), "git status".to_string()],
            )
            .await;
        assert_eq!(imported, 2);

        let suggestion = mgr
            .suggest("c".to_string(), Some("server-a"))
            .await
            .expect("expected clear suffix");
        assert_eq!(suggestion, "lear");

        let second = mgr
            .seed_shell_history(Some("server-a"), &["npm test".to_string()])
            .await;
        assert_eq!(second, 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn empty_seed_does_not_mark_scope_imported() {
        let dir = test_dir("seed-empty");
        let mgr = GhostManager::new(&dir);

        let imported = mgr.seed_shell_history(Some("server-b"), &[]).await;
        assert_eq!(imported, 0);
        assert!(!mgr.is_scope_imported(Some("server-b")).await);

        let retry = mgr
            .seed_shell_history(Some("server-b"), &["git status".to_string()])
            .await;
        assert_eq!(retry, 1);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
