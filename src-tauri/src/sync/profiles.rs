use super::types::{SyncError, SyncProfile, SyncProfilesStore, SyncProviderKind, SyncResult};
use std::fs::OpenOptions;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

const SYNC_PROFILES_FILE: &str = "sync-profiles.json";
const SYNC_PROFILES_LOCK_STALE_SECS: u64 = 120;
static SYNC_PROFILES_IO_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static SYNC_PROFILES_ASYNC_GATE: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();

/// Admit one profile I/O worker without blocking async runtime threads during lock contention.
/// Running work owns the permit until it exits, even if its awaiting caller is cancelled.
pub async fn run_profile_io<T, F>(operation: F) -> SyncResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> SyncResult<T> + Send + 'static,
{
    let permit = SYNC_PROFILES_ASYNC_GATE
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1)))
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| {
            SyncError::new(
                "sync_profile_write_failed",
                "sync profile I/O owner is unavailable",
            )
        })?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        operation()
    })
    .await
    .map_err(|error| {
        SyncError::new(
            "sync_profile_write_failed",
            format!("Sync profile I/O task failed: {error}"),
        )
    })?
}

/// Read one provider profile through the bounded blocking owner.
pub async fn get_profile_async(
    data_dir: &Path,
    provider: SyncProviderKind,
) -> SyncResult<Option<SyncProfile>> {
    let data_dir = data_dir.to_path_buf();
    run_profile_io(move || get_profile(&data_dir, provider)).await
}

/// Await a serialized profile mutation without running filesystem locks or retries on async workers.
pub async fn upsert_profile_async<F>(
    data_dir: &Path,
    provider: SyncProviderKind,
    build: F,
) -> SyncResult<SyncProfile>
where
    F: FnMut(Option<SyncProfile>) -> SyncProfile + Send + 'static,
{
    let data_dir = data_dir.to_path_buf();
    run_profile_io(move || upsert_profile(&data_dir, provider, build)).await
}

/// Returns current unix timestamp in seconds.
/// If system clock is misconfigured and appears before UNIX_EPOCH,
/// this returns 0 and callers should treat it as unknown.
pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn profiles_path(data_dir: &Path) -> PathBuf {
    data_dir.join(SYNC_PROFILES_FILE)
}

fn profiles_lock_path(data_dir: &Path) -> PathBuf {
    data_dir.join(format!("{}.lock", SYNC_PROFILES_FILE))
}

struct ProcessFileLock {
    lock_path: PathBuf,
    owner_token: String,
}

impl Drop for ProcessFileLock {
    fn drop(&mut self) {
        // NOTE: accepted TOCTOU window — another process can replace `lock_path`
        // between read and remove in this best-effort owner check. We tolerate
        // this because acquire_process_file_lock() has a retry loop + stale-lock
        // recovery, so transient cleanup races self-heal.
        if let Ok(current) = std::fs::read_to_string(&self.lock_path) {
            if current.trim() == self.owner_token {
                let _ = std::fs::remove_file(&self.lock_path);
            }
        }
    }
}

fn lock_owner_token() -> String {
    let pid = std::process::id();
    let ts = now_secs();
    format!("pid={pid};ts={ts}")
}

fn lock_file_is_stale(lock_path: &Path) -> bool {
    // Time-based heuristic only: on shared filesystems with divergent clocks,
    // this may produce false positives. Keep SYNC_PROFILES_LOCK_STALE_SECS
    // conservative for your environment.
    let Ok(content) = std::fs::read_to_string(lock_path) else {
        return false;
    };
    let ts = content
        .split(';')
        .find_map(|part| part.strip_prefix("ts="))
        .and_then(|raw| raw.parse::<u64>().ok());
    let Some(ts) = ts else {
        return false;
    };
    now_secs().saturating_sub(ts) > SYNC_PROFILES_LOCK_STALE_SECS
}

fn acquire_process_file_lock(data_dir: &Path) -> SyncResult<ProcessFileLock> {
    std::fs::create_dir_all(data_dir).map_err(|e| {
        SyncError::new(
            "sync_profile_write_failed",
            format!("Failed to create sync profile directory: {e}"),
        )
    })?;

    let lock_path = profiles_lock_path(data_dir);
    let owner_token = lock_owner_token();
    // Lightweight cross-process lock without extra deps:
    // acquire by atomically creating a lock file, retry briefly on contention.
    for _ in 0..200 {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
        {
            Ok(mut file) => {
                use std::io::Write;
                if let Err(error) = file.write_all(owner_token.as_bytes()) {
                    let _ = std::fs::remove_file(&lock_path);
                    return Err(SyncError::new(
                        "sync_profile_write_failed",
                        format!("Failed to initialize sync profile file lock: {error}"),
                    ));
                }
                return Ok(ProcessFileLock {
                    lock_path,
                    owner_token,
                });
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                if lock_file_is_stale(&lock_path) {
                    let _ = std::fs::remove_file(&lock_path);
                    continue;
                }
                thread::sleep(Duration::from_millis(25));
            }
            Err(error) => {
                return Err(SyncError::new(
                    "sync_profile_write_failed",
                    format!("Failed to acquire sync profile file lock: {error}"),
                ));
            }
        }
    }

    Err(SyncError::new(
        "sync_profile_write_failed",
        "Timed out waiting for sync profile file lock",
    ))
}

pub fn load_profiles_store(data_dir: &Path) -> SyncResult<SyncProfilesStore> {
    let path = profiles_path(data_dir);
    if !path.exists() {
        return Ok(SyncProfilesStore::default());
    }

    let raw = std::fs::read_to_string(&path).map_err(|e| {
        SyncError::new(
            "sync_profile_read_failed",
            format!("Failed to read sync profiles file: {e}"),
        )
    })?;

    serde_json::from_str::<SyncProfilesStore>(&raw).map_err(|e| {
        SyncError::new(
            "sync_profile_parse_failed",
            format!("Failed to parse sync profiles file: {e}"),
        )
    })
}

pub fn save_profiles_store(data_dir: &Path, store: &SyncProfilesStore) -> SyncResult<()> {
    std::fs::create_dir_all(data_dir).map_err(|e| {
        SyncError::new(
            "sync_profile_write_failed",
            format!("Failed to create sync profile directory: {e}"),
        )
    })?;

    let json = serde_json::to_string_pretty(store).map_err(|e| {
        SyncError::new(
            "sync_profile_write_failed",
            format!("Failed to serialize sync profiles: {e}"),
        )
    })?;

    let final_path = profiles_path(data_dir);
    let temp_path = final_path.with_extension("tmp");

    std::fs::write(&temp_path, json).map_err(|e| {
        SyncError::new(
            "sync_profile_write_failed",
            format!("Failed to write sync profiles file: {e}"),
        )
    })?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp_path, std::fs::Permissions::from_mode(0o600)).map_err(
            |e| {
                let _ = std::fs::remove_file(&temp_path);
                SyncError::new(
                    "sync_profile_write_failed",
                    format!("Failed to set sync profiles file permissions: {e}"),
                )
            },
        )?;
    }

    match std::fs::rename(&temp_path, &final_path) {
        Ok(()) => Ok(()),
        Err(rename_err) => {
            if rename_err.kind() == ErrorKind::AlreadyExists && final_path.exists() {
                match std::fs::remove_file(&final_path) {
                    Ok(()) => {
                        if let Err(retry_err) = std::fs::rename(&temp_path, &final_path) {
                            let _ = std::fs::remove_file(&temp_path);
                            return Err(SyncError::new(
                                "sync_profile_write_failed",
                                format!("Failed to finalize sync profiles file after replace retry: {retry_err}"),
                            ));
                        }
                        return Ok(());
                    }
                    Err(remove_err) if remove_err.kind() == ErrorKind::NotFound => {
                        if std::fs::rename(&temp_path, &final_path).is_ok() {
                            return Ok(());
                        }
                    }
                    Err(remove_err) => {
                        let _ = std::fs::remove_file(&temp_path);
                        return Err(SyncError::new(
                            "sync_profile_write_failed",
                            format!("Failed to replace existing sync profiles file: {remove_err}"),
                        ));
                    }
                }
            }
            let _ = std::fs::remove_file(&temp_path);
            Err(SyncError::new(
                "sync_profile_write_failed",
                format!("Failed to finalize sync profiles file: {rename_err}"),
            ))
        }
    }
}

pub fn get_profile(data_dir: &Path, provider: SyncProviderKind) -> SyncResult<Option<SyncProfile>> {
    let store = load_profiles_store(data_dir)?;
    Ok(store
        .profiles
        .into_iter()
        .find(|profile| profile.provider == provider.as_str()))
}

/// Mutate one profile atomically under the existing process lock; unchanged content retains its timestamp.
/// Async callers must enter through the blocking owner rather than calling this boundary directly.
pub fn upsert_profile<F>(
    data_dir: &Path,
    provider: SyncProviderKind,
    mut build: F,
) -> SyncResult<SyncProfile>
where
    F: FnMut(Option<SyncProfile>) -> SyncProfile,
{
    // `build` should mutate provider-specific fields only.
    // Any values it sets for `updated.provider` and `updated.updated_at`
    // are intentionally overwritten below with `provider.as_str()` and `now_secs()`.
    let lock = SYNC_PROFILES_IO_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock
        .lock()
        .map_err(|_| SyncError::new("sync_profile_write_failed", "sync profile lock poisoned"))?;
    let _process_lock = acquire_process_file_lock(data_dir)?;

    let mut store = load_profiles_store(data_dir)?;

    let index = store
        .profiles
        .iter()
        .position(|profile| profile.provider == provider.as_str());

    let current = index.map(|idx| store.profiles[idx].clone());
    let mut updated = build(current.clone());
    updated.provider = provider.as_str().to_string();
    if let Some(current) = current {
        updated.updated_at = current.updated_at;
        let serialize = |profile: &SyncProfile| {
            serde_json::to_value(profile).map_err(|error| {
                SyncError::new(
                    "sync_profile_write_failed",
                    format!("Failed to compare sync profiles: {error}"),
                )
            })
        };
        if serialize(&updated)? == serialize(&current)? {
            return Ok(current);
        }
    }
    updated.updated_at = now_secs();

    if let Some(idx) = index {
        store.profiles[idx] = updated.clone();
    } else {
        store.profiles.push(updated.clone());
    }

    save_profiles_store(data_dir, &store)?;
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_profile() -> SyncProfile {
        SyncProfile {
            provider: "google".into(),
            connected: true,
            email: None,
            avatar_url: None,
            last_sync: None,
            last_error: None,
            last_error_code: None,
            domain_policies: Vec::new(),
            domain_statuses: Vec::new(),
            updated_at: 0,
        }
    }

    #[test]
    fn unchanged_profile_keeps_timestamp_and_does_not_rewrite_the_file() {
        let root = tempfile::tempdir().unwrap();
        let created =
            upsert_profile(root.path(), SyncProviderKind::Google, |_| fixture_profile()).unwrap();
        let path = profiles_path(root.path());
        let old_time = std::time::UNIX_EPOCH + Duration::from_secs(100);
        OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(old_time))
            .unwrap();
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        let unchanged = upsert_profile(root.path(), SyncProviderKind::Google, |existing| {
            let mut profile = existing.unwrap();
            profile.updated_at = u64::MAX; // Builder timestamps are not a meaningful data change.
            profile
        })
        .unwrap();
        assert_eq!(unchanged.updated_at, created.updated_at);
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            modified
        );
        let changed = upsert_profile(root.path(), SyncProviderKind::Google, |existing| {
            let mut profile = existing.unwrap();
            profile.last_error = Some("fixture failure".into());
            profile
        })
        .unwrap();
        assert_eq!(changed.last_error.as_deref(), Some("fixture failure"));
        assert_ne!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            modified
        );
    }

    #[tokio::test]
    async fn file_lock_contention_does_not_stall_the_async_runtime() {
        let root = tempfile::tempdir().unwrap();
        let lock = profiles_lock_path(root.path());
        std::fs::write(&lock, lock_owner_token()).unwrap();
        let directory = root.path().to_path_buf();
        let writer = tokio::spawn(async move {
            upsert_profile_async(&directory, SyncProviderKind::Google, |_| fixture_profile()).await
        });
        let start = std::time::Instant::now();
        tokio::time::sleep(Duration::from_millis(30)).await;
        let elapsed = start.elapsed();
        std::fs::remove_file(lock).unwrap();
        let result = writer.await.unwrap();
        assert!(
            elapsed < Duration::from_secs(1),
            "profile file lock must wait on a blocking worker"
        );
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn cancelled_waiter_does_not_release_a_running_profile_owner() {
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, resume) = std::sync::mpsc::channel();
        let first = tokio::spawn(run_profile_io(move || {
            let _ = started.send(());
            resume.recv().unwrap();
            Ok(())
        }));
        ready.await.unwrap();
        first.abort();
        assert!(first.await.unwrap_err().is_cancelled());
        let admitted = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let second_flag = admitted.clone();
        let second = tokio::spawn(run_profile_io(move || {
            second_flag.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }));
        tokio::time::sleep(Duration::from_millis(20)).await;
        let ran_early = admitted.load(std::sync::atomic::Ordering::SeqCst);
        release.send(()).unwrap();
        second.await.unwrap().unwrap();
        assert!(
            !ran_early,
            "the running operation must retain the one-worker admission permit"
        );
        assert!(admitted.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn upsert_profile_creates_and_updates_provider_entry() {
        let unique = format!(
            "zync-sync-profile-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let data_dir_path = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&data_dir_path).expect("create temp test dir");
        let data_dir = data_dir_path.as_path();

        let created = upsert_profile(data_dir, SyncProviderKind::Google, |existing| {
            assert!(existing.is_none());
            SyncProfile {
                provider: "google".into(),
                connected: true,
                email: Some("first@example.com".into()),
                avatar_url: Some("https://example.com/avatar.png".into()),
                last_sync: Some(10),
                last_error: None,
                last_error_code: None,
                domain_policies: Vec::new(),
                domain_statuses: Vec::new(),
                updated_at: 0,
            }
        })
        .expect("create profile");

        assert_eq!(created.provider, "google");
        assert!(created.connected);

        let updated = upsert_profile(data_dir, SyncProviderKind::Google, |existing| {
            let mut profile = existing.expect("existing profile");
            profile.connected = false;
            profile.last_error_code = Some("disconnected".into());
            profile
        })
        .expect("update profile");

        assert!(!updated.connected);
        assert_eq!(updated.last_error_code.as_deref(), Some("disconnected"));

        let stored = get_profile(data_dir, SyncProviderKind::Google)
            .expect("load profile")
            .expect("stored profile");
        assert!(!stored.connected);

        std::fs::remove_dir_all(data_dir).expect("cleanup test dir");
    }

    #[test]
    fn lock_file_is_stale_recent_timestamp_is_not_stale() {
        let unique = format!(
            "zync-sync-profile-lock-stale-recent-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let path = std::env::temp_dir().join(unique);
        std::fs::write(
            &path,
            format!("pid={};ts={}", std::process::id(), now_secs()),
        )
        .expect("write lock file");
        assert!(!lock_file_is_stale(&path));
        std::fs::remove_file(&path).expect("cleanup lock file");
    }

    #[test]
    fn lock_file_is_stale_old_timestamp_is_stale() {
        let unique = format!(
            "zync-sync-profile-lock-stale-old-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let path = std::env::temp_dir().join(unique);
        let old = now_secs().saturating_sub(SYNC_PROFILES_LOCK_STALE_SECS + 1);
        std::fs::write(&path, format!("pid={};ts={old}", std::process::id()))
            .expect("write lock file");
        assert!(lock_file_is_stale(&path));
        std::fs::remove_file(&path).expect("cleanup lock file");
    }

    #[test]
    fn lock_file_is_stale_malformed_token_is_not_stale() {
        let unique = format!(
            "zync-sync-profile-lock-stale-malformed-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let path = std::env::temp_dir().join(unique);
        std::fs::write(&path, "not-a-valid-lock-file").expect("write lock file");
        assert!(!lock_file_is_stale(&path));
        std::fs::remove_file(&path).expect("cleanup lock file");
    }

    #[test]
    fn lock_file_is_stale_missing_file_is_not_stale() {
        let unique = format!(
            "zync-sync-profile-lock-stale-missing-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let path = std::env::temp_dir().join(unique);
        assert!(!lock_file_is_stale(&path));
    }
}
