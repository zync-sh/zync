use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// Score decays by 50% every 72 hours.
pub const HALF_LIFE_HOURS: f64 = 72.0;
/// Maximum history entries kept in memory and on disk.
pub const MAX_HISTORY: usize = 1_000;
/// Persist to disk every N commits (saves I/O; accepts always save immediately).
pub const SAVE_INTERVAL: u32 = 5;
/// Minimum prefix length before we attempt a suggestion.
pub const MIN_PREFIX_LEN: usize = 1;

/// Shared Ghost-only command budget; terminal delivery is never truncated by this policy.
pub static MAX_GHOST_COMMAND_BYTES: LazyLock<usize> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../src/lib/ghostSuggestions/inputBudgetBytes.json"
    ))
    .expect("bundled Ghost command byte budget must be valid")
});

/// Native strings are already UTF-8, so budget admission needs no scan or encoded copy.
pub fn ghost_input_within_budget(text: &str) -> bool {
    text.len() <= *MAX_GHOST_COMMAND_BYTES
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrecencyEntry {
    /// Compressed usage history, decayed to `reference_secs`.
    stored_score: f64,
    /// Unix timestamp (seconds) of the last update.
    reference_secs: u64,
}

impl FrecencyEntry {
    pub fn new_with_bump() -> Self {
        Self {
            stored_score: 1.0,
            reference_secs: now_secs(),
        }
    }

    fn live_score_at(&self, now: u64) -> f64 {
        let elapsed_secs = now.saturating_sub(self.reference_secs);
        let elapsed_hours = elapsed_secs as f64 / 3600.0;
        self.stored_score / 2f64.powf(elapsed_hours / HALF_LIFE_HOURS)
    }

    /// Compute the live (decayed) score at the current moment.
    pub fn live_score(&self) -> f64 {
        self.live_score_at(now_secs())
    }

    /// Decay score to now and add 1.0 usage point.
    pub fn bump(&mut self) {
        let now = now_secs();
        let current = self.live_score_at(now);
        self.stored_score = current + 1.0;
        self.reference_secs = now;
    }
}

/// Returns the current unix timestamp in seconds.
/// If the system clock is before UNIX_EPOCH, this falls back to `0`.
pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ScopeHistory {
    /// Most-recent-first ordered list of unique commands.
    pub history: Vec<String>,
    /// Per-command frecency scores.
    pub scores: HashMap<String, FrecencyEntry>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct GhostData {
    /// Per-scope history buckets (scope = connection_id or "local").
    pub scopes: HashMap<String, ScopeHistory>,
    /// Scopes that already received a one-time remote shell-history import (P7).
    #[serde(default)]
    pub imported_scopes: HashSet<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct LegacyGhostData {
    pub history: Vec<String>,
    pub scores: HashMap<String, FrecencyEntry>,
}
