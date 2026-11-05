use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::commands::{AppState, GhostConnectionIdentity};
use crate::fs::FileEntry;
use crate::ghost::context::RecentEntryContext;
use crate::ghost::token::{
    get_command_name, get_last_arg, has_path_separator, is_directory_command_for_backend,
    is_file_aware_command_for_backend, line_for_suggestion_parsing, strip_leading_unmatched_quote,
};

const FS_LIST_CACHE_TTL_MS: u64 = 1200;
const INLINE_FS_TIMEOUT_MS: u64 = 160;
const REMOTE_FS_LIST_TIMEOUT_MS: u64 = 900;
const WSL_FS_LIST_TIMEOUT_MS: u64 = 1200;
const REMOTE_HOME_CACHE_TTL_MS: u64 = 60_000;

mod cache;
use cache::{BackendKey, ListingCache, ListingKey};

struct CachedHome {
    at: Instant,
    path: String,
}

struct CachedRemoteHome {
    identity: GhostConnectionIdentity,
    home: CachedHome,
}

static FS_LIST_CACHE: OnceLock<ListingCache> = OnceLock::new();
static REMOTE_HOME_CACHE: OnceLock<Mutex<HashMap<String, CachedRemoteHome>>> = OnceLock::new();
static WSL_HOME_CACHE: OnceLock<Mutex<HashMap<Option<String>, CachedHome>>> = OnceLock::new();

/// Provides one shared success cache and weak registry for concurrent listing requests.
fn fs_list_cache() -> &'static ListingCache {
    FS_LIST_CACHE.get_or_init(ListingCache::default)
}

/// Stores at most one generation's home value per connection id.
fn remote_home_cache() -> &'static Mutex<HashMap<String, CachedRemoteHome>> {
    REMOTE_HOME_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Requires both a fresh timestamp and the actual captured connection identity.
fn fresh_remote_home(
    cache: &Mutex<HashMap<String, CachedRemoteHome>>,
    connection_id: &str,
    expected: &GhostConnectionIdentity,
) -> Option<String> {
    cache
        .lock()
        .ok()?
        .get(connection_id)
        .filter(|entry| {
            entry.identity == *expected
                && entry.home.at.elapsed() < Duration::from_millis(REMOTE_HOME_CACHE_TTL_MS)
        })
        .map(|entry| entry.home.path.clone())
}

/// Keeps the default WSL choice distinct from an explicitly named distro.
fn wsl_home_cache() -> &'static Mutex<HashMap<Option<String>, CachedHome>> {
    WSL_HOME_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn shell_id_indicates_wsl(shell_id: &str) -> bool {
    shell_id == "wsl" || shell_id.starts_with("wsl:")
}

/// Remote and WSL paths retain POSIX casing even when Zync runs on Windows.
pub fn uses_windows_paths(connection_id: &str, shell_id: Option<&str>) -> bool {
    cfg!(windows) && connection_id == "local" && !shell_id.is_some_and(shell_id_indicates_wsl)
}

pub fn parse_wsl_distro(shell_id: &str) -> Option<String> {
    if shell_id == "wsl" {
        return None;
    }
    shell_id
        .strip_prefix("wsl:")
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
}

fn expand_tilde_path_for_remote(path: &str, home: &str) -> String {
    let trimmed = path.trim();
    if trimmed == "~" {
        return home.to_string();
    }
    if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        let rest = rest.replace('\\', "/").trim_start_matches('/').to_string();
        return if rest.is_empty() {
            home.to_string()
        } else {
            format!("{home}/{rest}")
        };
    }
    path.to_string()
}

/// Reads cached home evidence only for the captured connection and transport generation.
async fn get_remote_home_dir(
    state: &AppState,
    connection_id: &str,
    expected: &GhostConnectionIdentity,
) -> Option<String> {
    if !crate::commands::ghost_identity_is_current(state, connection_id, expected).await {
        return None;
    }
    let hit = fresh_remote_home(remote_home_cache(), connection_id, expected);
    if let Some(hit) = hit {
        return crate::commands::ghost_identity_is_current(state, connection_id, expected)
            .await
            .then_some(hit);
    }
    let home = crate::commands::ghost_fs_cwd(state, connection_id, Some(expected))
        .await
        .ok()?;
    let trimmed = home.trim();
    if !trimmed.starts_with('/')
        || !crate::commands::ghost_identity_is_current(state, connection_id, expected).await
    {
        return None;
    }
    if let Ok(mut cache) = remote_home_cache().lock() {
        cache.insert(
            connection_id.to_string(),
            CachedRemoteHome {
                identity: expected.clone(),
                home: CachedHome {
                    at: Instant::now(),
                    path: trimmed.to_string(),
                },
            },
        );
    }
    Some(trimmed.to_string())
}

/// Reuses home lookups for the selected WSL distro without string-key collisions.
async fn get_wsl_home_dir(distro: Option<String>) -> Option<String> {
    {
        let cache = wsl_home_cache().lock().ok()?;
        if let Some(entry) = cache.get(&distro) {
            if entry.at.elapsed() < Duration::from_millis(REMOTE_HOME_CACHE_TTL_MS) {
                return Some(entry.path.clone());
            }
        }
    }
    let home = crate::commands::ghost_wsl_get_cwd(distro.clone())
        .await
        .ok()?;
    let trimmed = home.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(mut cache) = wsl_home_cache().lock() {
        cache.insert(
            distro,
            CachedHome {
                at: Instant::now(),
                path: trimmed.to_string(),
            },
        );
    }
    Some(trimmed.to_string())
}

fn is_windows_path(arg: &str) -> bool {
    let bytes = arg.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
        || arg.starts_with("\\\\")
}

fn looks_like_remote_target(arg: &str) -> bool {
    if is_windows_path(arg) {
        return false;
    }
    let colon = arg.find(':');
    let Some(colon) = colon else {
        return false;
    };
    if colon == 0 {
        return false;
    }
    let slash = arg.find(['/', '\\']);
    match slash {
        None => true,
        Some(slash) => colon < slash,
    }
}

fn split_path(arg: &str) -> Option<(String, String, char)> {
    let sep = if is_windows_path(arg) { '\\' } else { '/' };
    let last_sep = arg.rfind('/').into_iter().chain(arg.rfind('\\')).max()?;
    Some((
        arg[..=last_sep].to_string(),
        arg[last_sep + 1..].to_string(),
        sep,
    ))
}

fn is_absolute_or_home_path(path: &str) -> bool {
    path.starts_with('/')
        || path.starts_with('~')
        || path.starts_with("\\\\")
        || is_windows_path(path)
}

fn resolve_dir(dir: &str, cwd: &str, sep: char) -> String {
    if is_absolute_or_home_path(dir) {
        return dir.to_string();
    }
    let base = if cwd.ends_with(sep) {
        &cwd[..cwd.len() - 1]
    } else {
        cwd
    };
    let resolved = if dir.starts_with("./") || dir.starts_with(".\\") {
        format!("{base}{sep}{}", &dir[2..])
    } else {
        format!("{base}{sep}{dir}")
    };
    if sep == '\\' {
        resolved.replace('/', "\\")
    } else {
        resolved.replace('\\', "/")
    }
}

/// Unknown terminal CWD must not turn a relative lookup into an implicit home lookup.
fn resolve_listing_dir(dir: &str, cwd: Option<&str>, sep: char) -> Option<String> {
    if is_absolute_or_home_path(dir) {
        return Some(dir.to_string());
    }
    let cwd = cwd.filter(|path| is_absolute_or_home_path(path))?;
    Some(resolve_dir(dir, cwd, sep))
}

fn strip_trailing_sep(path: &str) -> String {
    if path == "/" {
        return path.to_string();
    }
    let bytes = path.as_bytes();
    if bytes.len() == 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
    {
        return path.to_string();
    }
    path.trim_end_matches(['/', '\\']).to_string()
}

fn normalize_fs_list_path(path: &str, connection_id: &str, use_wsl: bool) -> String {
    if path == "~" {
        if connection_id != "local" || use_wsl {
            return "~".to_string();
        }
        return String::new();
    }
    if path.is_empty() && connection_id != "local" {
        return ".".to_string();
    }
    path.to_string()
}

fn infer_separator(cwd: Option<&str>) -> char {
    if cwd.is_some_and(|c| c.contains('\\')) {
        '\\'
    } else {
        '/'
    }
}

fn fs_list_timeout_ms(connection_id: &str, wsl_shell_id: Option<&str>) -> u64 {
    if wsl_shell_id.is_some_and(shell_id_indicates_wsl) {
        return WSL_FS_LIST_TIMEOUT_MS;
    }
    if connection_id != "local" {
        return REMOTE_FS_LIST_TIMEOUT_MS;
    }
    INLINE_FS_TIMEOUT_MS
}

fn normalize_entry_type(t: &str) -> &'static str {
    match t {
        "d" | "directory" => "directory",
        "l" | "symlink" => "symlink",
        _ => "file",
    }
}

/// Captures a typed backend once so later awaits cannot silently retarget this request.
async fn capture_backend(
    state: &AppState,
    connection_id: &str,
    wsl_shell_id: Option<&str>,
) -> Option<BackendKey> {
    if let Some(shell_id) = wsl_shell_id.filter(|id| shell_id_indicates_wsl(id)) {
        Some(BackendKey::Wsl(parse_wsl_distro(shell_id)))
    } else if connection_id == "local" {
        Some(BackendKey::Local)
    } else {
        Some(BackendKey::Remote {
            id: connection_id.to_string(),
            identity: crate::commands::ghost_connection_identity(state, connection_id).await?,
        })
    }
}

/// Verifies remote ownership before submission and after all cache or I/O awaits.
async fn backend_is_current(state: &AppState, backend: &BackendKey) -> bool {
    match backend {
        BackendKey::Remote { id, identity } => {
            crate::commands::ghost_identity_is_current(state, id, identity).await
        }
        BackendKey::Local | BackendKey::Wsl(_) => true,
    }
}

/// Queries the captured backend; its caller's deadline also covers shared-flight waiting.
async fn invoke_fs_list(
    state: &AppState,
    backend: &BackendKey,
    path: &str,
) -> Result<Vec<FileEntry>, String> {
    match backend {
        BackendKey::Wsl(distro) => {
            crate::commands::ghost_fs_list_wsl(distro.clone(), path.to_string()).await
        }
        BackendKey::Local => crate::commands::ghost_fs_list(state, "local", path, None).await,
        BackendKey::Remote { id, identity } => {
            crate::commands::ghost_fs_list(state, id, path, Some(identity)).await
        }
    }
}

pub struct PathSuggestParams<'a> {
    pub line: &'a str,
    pub cwd: Option<&'a str>,
    pub connection_id: &'a str,
    pub wsl_shell_id: Option<&'a str>,
    pub recent_commands: &'a [String],
    pub state: &'a AppState,
}

/// A successful empty listing/match is different from unavailable path evidence.
#[derive(Debug, PartialEq, Eq)]
pub enum PathSuggestion {
    Match(String),
    Miss,
    Unknown,
}

pub async fn path_suggestion(params: PathSuggestParams<'_>) -> PathSuggestion {
    let suggestions = path_suggestions(PathSuggestionsParams {
        line: params.line,
        cwd: params.cwd,
        connection_id: params.connection_id,
        wsl_shell_id: params.wsl_shell_id,
        recent_commands: params.recent_commands,
        state: params.state,
        limit: 1,
    })
    .await;
    match suggestions {
        Some(suggestions) => suggestions
            .into_iter()
            .next()
            .map(PathSuggestion::Match)
            .unwrap_or(PathSuggestion::Miss),
        None => PathSuggestion::Unknown,
    }
}

struct PathSuggestionsParams<'a> {
    line: &'a str,
    cwd: Option<&'a str>,
    connection_id: &'a str,
    wsl_shell_id: Option<&'a str>,
    recent_commands: &'a [String],
    state: &'a AppState,
    limit: usize,
}

fn path_entry_suffix<'a>(entry_name: &'a str, partial: &str, windows: bool) -> Option<&'a str> {
    let prefix = entry_name.get(..partial.len())?;
    if prefix == partial || (windows && prefix.eq_ignore_ascii_case(partial)) {
        entry_name.get(partial.len()..)
    } else {
        None
    }
}

/// True when the active segment is only the command token (optional trailing space).
/// `cd` / `cd ` → true; `cd cd` / `cd Doc` → false.
fn is_bare_directory_command_line(parse_line: &str) -> bool {
    parse_line.trim_end().split_whitespace().count() <= 1
}

/// Classify path partial + whether a leading space is required for a new arg.
/// Extracted for unit tests (avoids async fs listing).
fn classify_directory_path_partial(
    parse_line: &str,
    last_arg: &str,
    command_name: &str,
    is_directory_only: bool,
) -> (String, bool) {
    let mut partial = last_arg.to_string();
    let mut new_path_arg = false;
    let bare_command = is_bare_directory_command_line(parse_line);
    if is_directory_only
        && bare_command
        && !partial.is_empty()
        && partial.to_ascii_lowercase() == command_name.to_ascii_lowercase()
    {
        partial.clear();
        new_path_arg = true;
    } else if last_arg.is_empty() {
        new_path_arg = true;
    }
    (partial, new_path_arg)
}

#[derive(Debug, Eq, Ord, PartialEq, PartialOrd)]
struct PathEntryRank<'a> {
    recent: std::cmp::Reverse<i32>,
    exact_case: std::cmp::Reverse<bool>,
    directory: std::cmp::Reverse<bool>,
    name: &'a str,
}

/// Computes each ordering key once, with symlinks eligible but below real directories.
fn rank_path_entry<'a>(
    entry: &'a FileEntry,
    partial: &str,
    recent: &RecentEntryContext,
) -> PathEntryRank<'a> {
    PathEntryRank {
        recent: std::cmp::Reverse(recent.name_bonus(&entry.name)),
        exact_case: std::cmp::Reverse(!partial.is_empty() && entry.name.starts_with(partial)),
        directory: std::cmp::Reverse(normalize_entry_type(&entry.r#type) == "directory"),
        name: &entry.name,
    }
}

/// Uses one pass for inline completion and stable sorting only for multiple results.
fn select_path_entries<'a>(
    entries: &'a [FileEntry],
    partial: &str,
    windows: bool,
    directory_only: bool,
    limit: usize,
    mut rank: impl FnMut(&'a FileEntry) -> PathEntryRank<'a>,
) -> Vec<&'a FileEntry> {
    let candidates = entries
        .iter()
        .filter(|entry| {
            entry.name != "."
                && entry.name != ".."
                && entry.name != partial
                && !entry.name.ends_with('~')
                && path_entry_suffix(&entry.name, partial, windows).is_some()
                && (!directory_only
                    || matches!(normalize_entry_type(&entry.r#type), "directory" | "symlink"))
        })
        .map(|entry| (entry, rank(entry)));
    let limit = limit.max(1);
    if limit == 1 {
        let mut best: Option<(&FileEntry, PathEntryRank<'_>)> = None;
        for candidate in candidates {
            // Strict comparison preserves the first full tie, matching stable sort.
            if best
                .as_ref()
                .is_none_or(|(_, best_rank)| candidate.1 < *best_rank)
            {
                best = Some(candidate);
            }
        }
        best.into_iter().map(|(entry, _)| entry).collect()
    } else {
        let mut ranked: Vec<_> = candidates.collect();
        ranked.sort_by(|a, b| a.1.cmp(&b.1));
        ranked
            .into_iter()
            .take(limit)
            .map(|(entry, _)| entry)
            .collect()
    }
}

/// Preserves the existing suffix casing, new-argument spacing and directory separators.
fn path_suggestion_suffix(
    entry: &FileEntry,
    partial: &str,
    windows: bool,
    sep: char,
    new_path_arg: bool,
) -> String {
    let name_suffix = path_entry_suffix(&entry.name, partial, windows).unwrap_or_default();
    let trailing_sep = if matches!(normalize_entry_type(&entry.r#type), "directory" | "symlink") {
        sep.to_string()
    } else {
        String::new()
    };
    let piece = format!("{name_suffix}{trailing_sep}");
    if new_path_arg && !piece.is_empty() && !piece.starts_with([' ', '\t']) {
        format!(" {piece}")
    } else {
        piece
    }
}

/// Resolves paths within one backend deadline, then preserves existing match ordering.
async fn path_suggestions(params: PathSuggestionsParams<'_>) -> Option<Vec<String>> {
    let timeout_ms = fs_list_timeout_ms(params.connection_id, params.wsl_shell_id);
    let parse_line = line_for_suggestion_parsing(params.line);
    let last_arg = strip_leading_unmatched_quote(&get_last_arg(&parse_line)).to_string();

    if looks_like_remote_target(&last_arg) {
        return None;
    }

    let command_name = get_command_name(&parse_line);
    let windows = uses_windows_paths(params.connection_id, params.wsl_shell_id);
    let is_directory_only = is_directory_command_for_backend(&command_name, windows);
    let is_file_aware = is_file_aware_command_for_backend(&command_name, windows);

    let mut dir = String::new();
    let partial;
    let mut sep = infer_separator(params.cwd);
    // True when the completion is a brand-new path token after a bare command
    // (`cd` → ` Documents/`), not a mid-token fragment (`cd Doc` → `uments/`).
    // Path owns this leading space so history mid-token (`ls` → `blk`) never
    // gets a space invented by suffix normalize.
    let mut new_path_arg = false;

    if has_path_separator(&last_arg) {
        let Some((d, p, s)) = split_path(&last_arg) else {
            return None;
        };
        dir = d;
        partial = p;
        sep = s;
    } else {
        if command_name.is_empty() {
            return None;
        }
        if !is_directory_only && !is_file_aware {
            return None;
        }
        if last_arg.starts_with('-') {
            return None;
        }
        if !is_directory_only {
            let cwd = params.cwd.unwrap_or("");
            if params.cwd.is_none()
                || last_arg.is_empty()
                || last_arg.eq_ignore_ascii_case(&command_name)
            {
                return None;
            }
            if cwd.is_empty() {
                return None;
            }
        }
        let (classified_partial, classified_new) = classify_directory_path_partial(
            &parse_line,
            &last_arg,
            &command_name,
            is_directory_only,
        );
        partial = classified_partial;
        new_path_arg = classified_new;
    }

    let entries = tokio::time::timeout(Duration::from_millis(timeout_ms.max(50)), async {
        let backend =
            capture_backend(params.state, params.connection_id, params.wsl_shell_id).await?;
        let use_wsl = matches!(backend, BackendKey::Wsl(_));
        let mut effective_cwd = params.cwd.map(str::to_string);
        if let Some(cwd) = effective_cwd.as_ref().filter(|cwd| cwd.contains('~')) {
            let home = match &backend {
                BackendKey::Remote { id, identity } => {
                    Some(get_remote_home_dir(params.state, id, identity).await?)
                }
                BackendKey::Wsl(distro) => Some(get_wsl_home_dir(distro.clone()).await?),
                BackendKey::Local => None,
            };
            if let Some(home) = home {
                effective_cwd = Some(expand_tilde_path_for_remote(cwd, &home));
            }
        }
        let resolved_dir = resolve_listing_dir(&dir, effective_cwd.as_deref(), sep)?;
        let mut api_path = normalize_fs_list_path(
            &strip_trailing_sep(&resolved_dir),
            params.connection_id,
            use_wsl,
        );
        if api_path.contains('~') {
            let home = match &backend {
                BackendKey::Remote { id, identity } => {
                    Some(get_remote_home_dir(params.state, id, identity).await?)
                }
                BackendKey::Wsl(distro) => Some(get_wsl_home_dir(distro.clone()).await?),
                BackendKey::Local => None,
            };
            if let Some(home) = home {
                api_path = expand_tilde_path_for_remote(&api_path, &home);
            }
        }
        fs_list_cache()
            .list_if_current(
                ListingKey {
                    backend: backend.clone(),
                    path: api_path.clone(),
                },
                invoke_fs_list(params.state, &backend, &api_path),
                || backend_is_current(params.state, &backend),
            )
            .await
            .ok()
    })
    .await
    .ok()??;

    if entries.is_empty() {
        return Some(Vec::new());
    }

    let recent = RecentEntryContext::new(params.recent_commands);
    let matches = select_path_entries(
        &entries,
        &partial,
        windows,
        is_directory_only,
        params.limit,
        |entry| rank_path_entry(entry, &partial, &recent),
    );
    let out = matches
        .into_iter()
        .map(|entry| path_suggestion_suffix(entry, &partial, windows, sep, new_path_arg))
        .collect();

    Some(out)
}

#[cfg(test)]
#[path = "path_suggest/ranking_tests.rs"]
mod ranking_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_tilde_remote_paths() {
        assert_eq!(
            expand_tilde_path_for_remote("~/proj", "/home/me"),
            "/home/me/proj"
        );
        assert_eq!(expand_tilde_path_for_remote("~", "/home/me"), "/home/me");
    }

    #[test]
    fn remote_home_cache_requires_owner_and_generation_without_accumulating_generations() {
        let owner = std::sync::Arc::new(tokio::sync::Mutex::new(()));
        let replacement = std::sync::Arc::new(tokio::sync::Mutex::new(()));
        let original = GhostConnectionIdentity::from_owner(&owner, 0);
        let cache = Mutex::new(HashMap::new());
        for generation in 0..100 {
            let identity = GhostConnectionIdentity::from_owner(&owner, generation);
            cache.lock().unwrap().insert(
                "same-id".into(),
                CachedRemoteHome {
                    identity: identity.clone(),
                    home: CachedHome {
                        at: Instant::now(),
                        path: format!("/home/{generation}"),
                    },
                },
            );
            assert_eq!(
                fresh_remote_home(&cache, "same-id", &identity),
                Some(format!("/home/{generation}"))
            );
            if generation != 0 {
                assert_eq!(fresh_remote_home(&cache, "same-id", &original), None);
            }
            assert_eq!(cache.lock().unwrap().len(), 1);
        }
        let new_owner = GhostConnectionIdentity::from_owner(&replacement, 99);
        assert_eq!(fresh_remote_home(&cache, "same-id", &new_owner), None);
        cache.lock().unwrap().get_mut("same-id").unwrap().home.at =
            Instant::now() - Duration::from_millis(REMOTE_HOME_CACHE_TTL_MS + 1);
        assert_eq!(
            fresh_remote_home(
                &cache,
                "same-id",
                &GhostConnectionIdentity::from_owner(&owner, 99)
            ),
            None
        );
    }

    #[test]
    fn split_path_unix() {
        let (dir, partial, sep) = split_path("/usr/lo").unwrap();
        assert_eq!(dir, "/usr/");
        assert_eq!(partial, "lo");
        assert_eq!(sep, '/');
    }

    #[test]
    fn path_entry_suffix_preserves_entry_casing() {
        assert_eq!(path_entry_suffix("Documents", "doc", true), Some("uments"));
        assert_eq!(path_entry_suffix("Documents", "Doc", false), Some("uments"));
        assert_eq!(path_entry_suffix("Documents", "doc", false), None);
        assert_eq!(path_entry_suffix("école", "Éc", true), None);
    }

    #[test]
    fn windows_path_matching_does_not_apply_to_remote_or_wsl() {
        assert_eq!(uses_windows_paths("local", None), cfg!(windows));
        assert!(!uses_windows_paths("server", None));
        assert!(!uses_windows_paths("server", Some("powershell")));
        assert!(!uses_windows_paths("local", Some("wsl:Ubuntu")));
    }

    #[test]
    fn relative_listings_require_known_cwd_but_explicit_roots_do_not() {
        for cwd in [None, Some(""), Some("relative")] {
            assert_eq!(resolve_listing_dir("", cwd, '/'), None);
            assert_eq!(resolve_listing_dir("./src/", cwd, '/'), None);
        }
        assert_eq!(
            resolve_listing_dir("", Some("/tmp"), '/'),
            Some("/tmp/".into())
        );
        assert_eq!(
            resolve_listing_dir("/tmp/", None, '/'),
            Some("/tmp/".into())
        );
        assert_eq!(resolve_listing_dir("~/", None, '/'), Some("~/".into()));
        assert_eq!(
            resolve_listing_dir("C:\\tmp\\", None, '\\'),
            Some("C:\\tmp\\".into())
        );
    }

    #[test]
    fn bare_cd_clears_partial_and_marks_new_arg() {
        let (partial, new_arg) = classify_directory_path_partial("cd", "cd", "cd", true);
        assert_eq!(partial, "");
        assert!(new_arg);

        let (partial_sp, new_arg_sp) = classify_directory_path_partial("cd ", "", "cd", true);
        assert_eq!(partial_sp, "");
        assert!(new_arg_sp);
    }

    #[test]
    fn cd_cd_keeps_partial_without_leading_space() {
        // Argument equals command name but is a second token — not bare `cd`.
        let (partial, new_arg) = classify_directory_path_partial("cd cd", "cd", "cd", true);
        assert_eq!(partial, "cd");
        assert!(!new_arg);

        let (partial_pd, new_arg_pd) =
            classify_directory_path_partial("pushd pushd", "pushd", "pushd", true);
        assert_eq!(partial_pd, "pushd");
        assert!(!new_arg_pd);

        // Mid-token path fragment still glues without new-arg space.
        let (partial_doc, new_arg_doc) =
            classify_directory_path_partial("cd Doc", "Doc", "cd", true);
        assert_eq!(partial_doc, "Doc");
        assert!(!new_arg_doc);
    }

    #[test]
    fn path_entry_suffix_for_cd_cd_style_partial() {
        // Completing an arg that starts with "cd" should glue, not inject a space.
        assert_eq!(path_entry_suffix("cdrom", "cd", false), Some("rom"));
        assert_eq!(path_entry_suffix("cd", "cd", false), Some(""));
    }
}
