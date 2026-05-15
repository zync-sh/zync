use super::types::{SyncError, SyncProfile, SyncProfilesStore, SyncProviderKind, SyncResult};
use std::fs::OpenOptions;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

const SYNC_PROFILES_FILE: &str = "sync-profiles.json";
const SYNC_PROFILES_LOCK_STALE_SECS: u64 = 120;
static SYNC_PROFILES_IO_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

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
        std::fs::set_permissions(&temp_path, std::fs::Permissions::from_mode(0o600)).map_err(|e| {
            let _ = std::fs::remove_file(&temp_path);
            SyncError::new(
                "sync_profile_write_failed",
                format!("Failed to set sync profiles file permissions: {e}"),
            )
        })?;
    }

    std::fs::rename(&temp_path, &final_path).map_err(|e| {
        let _ = std::fs::remove_file(&temp_path);
        SyncError::new(
            "sync_profile_write_failed",
            format!("Failed to finalize sync profiles file: {e}"),
        )
    })
}

pub fn get_profile(data_dir: &Path, provider: SyncProviderKind) -> SyncResult<Option<SyncProfile>> {
    let store = load_profiles_store(data_dir)?;
    Ok(store
        .profiles
        .into_iter()
        .find(|profile| profile.provider == provider.as_str()))
}

pub fn upsert_profile<F>(data_dir: &Path, provider: SyncProviderKind, mut build: F) -> SyncResult<SyncProfile>
where
    F: FnMut(Option<SyncProfile>) -> SyncProfile,
{
    // `build` should mutate provider-specific fields only.
    // Any values it sets for `updated.provider` and `updated.updated_at`
    // are intentionally overwritten below with `provider.as_str()` and `now_secs()`.
    let lock = SYNC_PROFILES_IO_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().map_err(|_| {
        SyncError::new(
            "sync_profile_write_failed",
            "sync profile lock poisoned",
        )
    })?;
    let _process_lock = acquire_process_file_lock(data_dir)?;

    let mut store = load_profiles_store(data_dir)?;

    let index = store
        .profiles
        .iter()
        .position(|profile| profile.provider == provider.as_str());

    let current = index.map(|idx| store.profiles[idx].clone());
    let mut updated = build(current);
    updated.provider = provider.as_str().to_string();
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
                last_sync: Some(10),
                last_error: None,
                last_error_code: None,
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
        std::fs::write(&path, format!("pid={};ts={}", std::process::id(), now_secs()))
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
