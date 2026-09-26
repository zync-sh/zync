use anyhow::{anyhow, Result};
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::Path;

pub(super) fn atomic_replace_external(path: &Path, content: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("Selected file has no parent folder"))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow!("Selected file name is invalid"))?;
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
