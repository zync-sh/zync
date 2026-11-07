//! Durable atomic file replacement: temp write + fsync, rename, optional backup rollback.

use std::fs::{self, OpenOptions};
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

const LEGACY_BACKUP_EXTENSION: &str = "bak";

/// Remove only the invocation-owned staging file on every unpublished/error exit.
struct TempCleanup(Option<PathBuf>);

impl Drop for TempCleanup {
    /// A published file has already been renamed away; recovery backups remain untouched.
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = fs::remove_file(path);
        }
    }
}

/// Build a unique staging path owned by one atomic replacement attempt.
fn unique_temp_path(path: &Path, unique_suffix: &Uuid) -> PathBuf {
    path.with_extension(format!("json.tmp.{unique_suffix}"))
}

fn unique_backup_path(path: &Path, unique_suffix: &Uuid) -> PathBuf {
    path.with_extension(format!("json.bak.{unique_suffix}"))
}

/// Replace `path` with `content` using a durable temp-write + rename flow.
///
/// - Writes to a per-invocation temp file (`*.json.tmp.<uuid>`), flushes with `sync_all`
/// - Renames into place; on `AlreadyExists`, stages `path` to a unique backup and retries
/// - Clears legacy fixed `.tmp`/`.bak` siblings from older writers before rename
/// - Flushes the final file and parent directory metadata (parent sync skipped on Windows)
pub fn durable_replace(path: &Path, content: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "invalid file path"))?;
    fs::create_dir_all(parent)?;

    let unique_suffix = Uuid::new_v4();
    let temp_path = unique_temp_path(path, &unique_suffix);
    let mut cleanup = write_temp_durable(&temp_path, content)?;

    // Windows may replace an existing destination on rename without staging; clear legacy backups first.
    remove_stale_backup_file(&path.with_extension(LEGACY_BACKUP_EXTENSION))?;

    let backup_path = unique_backup_path(path, &unique_suffix);

    match fs::rename(&temp_path, path) {
        Ok(()) => {
            cleanup.0 = None;
            finalize_durable(path)
        }
        Err(rename_err) if rename_err.kind() == ErrorKind::AlreadyExists && path.exists() => {
            replace_with_backup(path, &temp_path, &backup_path, &mut cleanup)
        }
        Err(rename_err) => Err(rename_err),
    }
}

/// Write and sync staging bytes before making them visible at the destination.
fn write_temp_durable(temp_path: &Path, content: &[u8]) -> io::Result<TempCleanup> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temp_path)?;
    let cleanup = TempCleanup(Some(temp_path.to_path_buf()));
    let result = file.write_all(content).and_then(|()| file.sync_all());
    drop(file);
    result?;
    Ok(cleanup)
}

/// Stage the prior destination, preserving its recovery copy if rollback itself fails.
fn replace_with_backup(
    path: &Path,
    temp_path: &Path,
    backup_path: &Path,
    cleanup: &mut TempCleanup,
) -> io::Result<()> {
    remove_stale_backup_file(backup_path)?;
    fs::rename(path, backup_path)?;

    match fs::rename(temp_path, path) {
        Ok(()) => {
            cleanup.0 = None;
            let _ = fs::remove_file(&backup_path);
            finalize_durable(path)
        }
        Err(retry_err) => {
            if let Err(restore_err) = fs::rename(&backup_path, path) {
                return Err(io::Error::other(format!(
                    "failed to finalize durable replace ({retry_err}); failed to restore backup: {restore_err}"
                )));
            }
            if let Err(remove_err) = fs::remove_file(temp_path) {
                return Err(io::Error::other(format!(
                    "failed to finalize durable replace ({retry_err}); failed to remove temp file: {remove_err}"
                )));
            }
            cleanup.0 = None;
            Err(retry_err)
        }
    }
}

fn remove_stale_backup_file(backup_path: &Path) -> io::Result<()> {
    if backup_path.exists() {
        fs::remove_file(backup_path)?;
    }
    Ok(())
}

fn finalize_durable(path: &Path) -> io::Result<()> {
    sync_file(path)?;
    sync_parent_dir(path)
}

fn sync_file(path: &Path) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "windows")]
    {
        // Windows may reject sync_all on read-only handles.
        options.write(true);
    }
    options.open(path).and_then(|file| file.sync_all())
}

#[cfg(not(target_os = "windows"))]
fn sync_parent_dir(path: &Path) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        OpenOptions::new()
            .read(true)
            .open(parent)
            .and_then(|file| file.sync_all())?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn sync_parent_dir(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(prefix: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("zync-atomic-io-{prefix}-{nanos}"))
    }

    #[test]
    fn durable_replace_writes_and_replaces_file() {
        let dir = temp_dir("write-replace");
        fs::create_dir_all(&dir).expect("create dir");
        let path = dir.join("data.json");

        durable_replace(&path, br#"{"version":1}"#).expect("initial write");
        let first = fs::read_to_string(&path).expect("read first");
        assert_eq!(first, r#"{"version":1}"#);

        durable_replace(&path, br#"{"version":2}"#).expect("replace write");
        let second = fs::read_to_string(&path).expect("read second");
        assert_eq!(second, r#"{"version":2}"#);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn durable_replace_recovers_when_stale_backup_exists() {
        let dir = temp_dir("stale-backup");
        fs::create_dir_all(&dir).expect("create dir");
        let path = dir.join("data.json");
        let legacy_backup_path = path.with_extension(LEGACY_BACKUP_EXTENSION);

        fs::write(&path, r#"{"version":1}"#).expect("seed primary");
        fs::write(&legacy_backup_path, r#"{"version":"backup"}"#).expect("seed stale backup");

        durable_replace(&path, br#"{"version":2}"#).expect("replace with stale backup present");
        let updated = fs::read_to_string(&path).expect("read updated");
        assert_eq!(updated, r#"{"version":2}"#);
        assert!(!legacy_backup_path.exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn failed_stale_backup_cleanup_removes_staging_but_preserves_destination() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        fs::write(&path, b"original").unwrap();
        let backup = path.with_extension(LEGACY_BACKUP_EXTENSION);
        fs::create_dir(&backup).unwrap();
        fs::write(backup.join("recovery"), b"keep").unwrap();
        assert!(durable_replace(&path, b"replacement").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"original");
        assert_eq!(fs::read(backup.join("recovery")).unwrap(), b"keep");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[test]
    fn unpublished_temp_guard_removes_partially_written_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("partial.tmp");
        let result: io::Result<()> = (|| {
            let _cleanup = TempCleanup(Some(path.clone()));
            fs::write(&path, b"partial")?;
            Err(io::Error::other("injected write/sync failure"))
        })();
        assert!(result.is_err());
        assert!(!path.exists());
    }

    #[test]
    fn staging_collision_never_truncates_or_removes_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("collision.tmp");
        fs::write(&path, b"keep").unwrap();
        assert!(write_temp_durable(&path, b"new").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"keep");
    }
}

/// Atomically replace a user-selected file without deleting unrelated backup siblings.
pub(crate) fn atomic_replace_external(path: &Path, content: &[u8]) -> anyhow::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err(anyhow::anyhow!(
                "Selected destination is not a regular file"
            ))
        }
        Err(error) if error.kind() != ErrorKind::NotFound => return Err(error.into()),
        _ => {}
    }
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Selected file has no parent folder"))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow::anyhow!("Selected file name is invalid"))?;
    let suffix = uuid::Uuid::new_v4().simple();
    let temp_path = parent.join(format!(".{file_name}.zync-plugin-tmp-{suffix}"));
    let backup_path = parent.join(format!(".{file_name}.zync-plugin-bak-{suffix}"));

    let write_result = (|| -> std::io::Result<()> {
        let mut temp = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        temp.write_all(content)?;
        temp.sync_all()?;
        drop(temp);

        match fs::rename(&temp_path, path) {
            Ok(()) => sync_external_file(path),
            Err(error)
                if path.exists()
                    && matches!(
                        error.kind(),
                        ErrorKind::AlreadyExists | ErrorKind::PermissionDenied
                    ) =>
            {
                fs::rename(path, &backup_path)?;
                match fs::rename(&temp_path, path) {
                    Ok(()) => {
                        let _ = fs::remove_file(&backup_path);
                        sync_external_file(path)
                    }
                    Err(replace_error) => {
                        let restore_error = fs::rename(&backup_path, path).err();
                        let _ = fs::remove_file(&temp_path);
                        if let Some(restore_error) = restore_error {
                            Err(std::io::Error::other(format!(
                                "replacement failed ({replace_error}); backup restoration failed ({restore_error})"
                            )))
                        } else {
                            Err(replace_error)
                        }
                    }
                }
            }
            Err(error) => Err(error),
        }
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    write_result.map_err(Into::into)
}

fn sync_external_file(path: &Path) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    options.write(true);
    options.open(path)?.sync_all()?;
    sync_external_parent(path)
}

#[cfg(not(windows))]
fn sync_external_parent(path: &Path) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        OpenOptions::new().read(true).open(parent)?.sync_all()?;
    }
    Ok(())
}

#[cfg(windows)]
fn sync_external_parent(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod external_export_tests {
    use super::*;
    /// A malformed file-dialog destination must never stage, rename or replace an existing directory.
    #[test]
    fn export_rejects_directory_without_touching_its_contents() {
        let folder = tempfile::tempdir().unwrap();
        let destination = folder.path().join("keep");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("original.txt"), b"original").unwrap();
        assert!(atomic_replace_external(&destination, b"export").is_err());
        assert_eq!(
            fs::read(destination.join("original.txt")).unwrap(),
            b"original"
        );
        assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 1);
    }
}
