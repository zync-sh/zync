use anyhow::{anyhow, Context, Result};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};

pub const MAX_PACKAGE_DOWNLOAD_BYTES: u64 = 25 * 1024 * 1024;
const MAX_PACKAGE_EXPANDED_BYTES: u64 = 100 * 1024 * 1024;
const MAX_PACKAGE_FILE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_PACKAGE_ENTRIES: usize = 2_048;
const MAX_PACKAGE_PATH_BYTES: usize = 512;
const MAX_PACKAGE_COMPRESSION_RATIO: u64 = 200;
const COMPRESSION_RATIO_CHECK_BYTES: u64 = 1024 * 1024;

pub fn read_manifest_file(path: &Path) -> Result<String> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("Plugin directory is missing {}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err(anyhow!("Plugin manifest must be a regular file"));
    }
    if metadata.len() > MAX_MANIFEST_BYTES {
        return Err(anyhow!("Plugin manifest exceeds 256 KiB"));
    }

    let mut file = fs::File::open(path)?;
    let mut content = String::new();
    (&mut file)
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_string(&mut content)
        .context("Plugin manifest is not valid UTF-8 text")?;
    if content.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(anyhow!("Plugin manifest exceeds 256 KiB"));
    }
    Ok(content)
}

pub fn extract_archive<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    destination: &Path,
) -> Result<()> {
    if archive.len() > MAX_PACKAGE_ENTRIES {
        return Err(anyhow!(
            "Plugin archive contains more than {MAX_PACKAGE_ENTRIES} entries"
        ));
    }

    let mut paths = HashSet::new();
    let mut expanded_bytes = 0u64;
    let mut copied_bytes = 0u64;

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let entry_name = entry.name().to_string();
        validate_archive_entry_name(&entry_name)?;
        reject_special_archive_entry(&entry)?;

        let relative_path = entry
            .enclosed_name()
            .ok_or_else(|| anyhow!("Plugin archive entry escapes its package: {entry_name}"))?
            .to_path_buf();
        let normalized = normalized_package_path(&relative_path)?;
        if !paths.insert(normalized) {
            return Err(anyhow!(
                "Plugin archive contains a duplicate path: {entry_name}"
            ));
        }

        let declared_size = entry.size();
        if declared_size > MAX_PACKAGE_FILE_BYTES {
            return Err(anyhow!("Plugin file exceeds 20 MiB: {entry_name}"));
        }
        if declared_size >= COMPRESSION_RATIO_CHECK_BYTES
            && declared_size
                > entry
                    .compressed_size()
                    .saturating_mul(MAX_PACKAGE_COMPRESSION_RATIO)
        {
            return Err(anyhow!(
                "Plugin file has an unsafe compression ratio: {entry_name}"
            ));
        }
        expanded_bytes = expanded_bytes
            .checked_add(declared_size)
            .ok_or_else(|| anyhow!("Plugin expanded size overflow"))?;
        if expanded_bytes > MAX_PACKAGE_EXPANDED_BYTES {
            return Err(anyhow!("Plugin expands beyond 100 MiB"));
        }

        let output_path = destination.join(&relative_path);
        if entry.is_dir() {
            fs::create_dir_all(&output_path)?;
            continue;
        }

        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output_path)
            .with_context(|| format!("Failed to create {}", output_path.display()))?;
        let copied = std::io::copy(
            &mut (&mut entry).take(MAX_PACKAGE_FILE_BYTES + 1),
            &mut output,
        )?;
        if copied > MAX_PACKAGE_FILE_BYTES {
            return Err(anyhow!("Plugin file exceeds 20 MiB: {entry_name}"));
        }
        copied_bytes = copied_bytes
            .checked_add(copied)
            .ok_or_else(|| anyhow!("Plugin expanded size overflow"))?;
        if copied_bytes > MAX_PACKAGE_EXPANDED_BYTES {
            return Err(anyhow!("Plugin expands beyond 100 MiB"));
        }
        output.flush()?;
    }

    Ok(())
}

pub fn copy_directory(source: &Path, destination: &Path) -> Result<()> {
    let source = fs::canonicalize(source)
        .with_context(|| format!("Failed to resolve plugin directory: {}", source.display()))?;
    let mut budget = CopyBudget::default();
    copy_directory_inner(&source, &source, destination, &mut budget)
}

/// Hash a validated package tree in a stable order so approval follows the exact bytes reviewed.
pub fn digest_directory(root: &Path) -> Result<String> {
    let canonical_root = fs::canonicalize(root)?;
    let mut files = Vec::new();
    let mut budget = CopyBudget::default();
    collect_digest_files(&canonical_root, &canonical_root, &mut files, &mut budget)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));

    let mut digest = Sha256::new();
    for (relative, path) in files {
        let mut file = fs::File::open(&path)?;
        let size = file.metadata()?.len();
        if size > MAX_PACKAGE_FILE_BYTES {
            return Err(anyhow!("Plugin file exceeds 20 MiB: {}", path.display()));
        }
        digest.update((relative.len() as u64).to_le_bytes());
        digest.update(relative.as_bytes());
        digest.update(size.to_le_bytes());

        let copied = std::io::copy(
            &mut (&mut file).take(MAX_PACKAGE_FILE_BYTES + 1),
            &mut DigestWriter(&mut digest),
        )?;
        if copied != size {
            return Err(anyhow!(
                "Plugin file changed while its package was being verified: {}",
                path.display()
            ));
        }
    }
    let encoded = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("sha256:{encoded}"))
}

fn collect_digest_files(
    root: &Path,
    current: &Path,
    files: &mut Vec<(String, std::path::PathBuf)>,
    budget: &mut CopyBudget,
) -> Result<()> {
    for entry in fs::read_dir(current)? {
        budget.entries += 1;
        if budget.entries > MAX_PACKAGE_ENTRIES {
            return Err(anyhow!(
                "Plugin directory contains more than {MAX_PACKAGE_ENTRIES} entries"
            ));
        }

        let entry = entry?;
        let file_type = entry.file_type()?;
        let path = entry.path();
        if file_type.is_symlink() || (!file_type.is_file() && !file_type.is_dir()) {
            return Err(anyhow!(
                "Plugin package contains an unsupported file: {}",
                path.display()
            ));
        }
        if file_type.is_dir() {
            collect_digest_files(root, &path, files, budget)?;
        } else {
            let relative = path
                .strip_prefix(root)?
                .to_string_lossy()
                .replace('\\', "/");
            validate_package_path(&relative)?;
            let size = entry.metadata()?.len();
            if size > MAX_PACKAGE_FILE_BYTES {
                return Err(anyhow!("Plugin file exceeds 20 MiB: {}", path.display()));
            }
            budget.bytes = budget
                .bytes
                .checked_add(size)
                .ok_or_else(|| anyhow!("Plugin directory size overflow"))?;
            if budget.bytes > MAX_PACKAGE_EXPANDED_BYTES {
                return Err(anyhow!("Plugin directory exceeds 100 MiB"));
            }
            files.push((relative, path));
        }
    }
    Ok(())
}

struct DigestWriter<'a>(&'a mut Sha256);

impl Write for DigestWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[derive(Debug)]
pub struct PendingPackageActivation {
    target: PathBuf,
    backup: Option<PathBuf>,
}

impl PendingPackageActivation {
    #[cfg(test)]
    pub(crate) fn had_previous(&self) -> bool {
        self.backup.is_some()
    }

    pub fn commit(self) -> Result<()> {
        if let Some(backup) = self.backup {
            if backup.exists() {
                fs::remove_dir_all(&backup).with_context(|| {
                    format!("Failed to remove plugin rollback copy {}", backup.display())
                })?;
            }
        }
        Ok(())
    }

    pub fn rollback(self) -> Result<()> {
        rollback_package_activation(&self.target, self.backup.as_deref())
    }
}

/// Keep the previous package beside the active one until its runtime passes the health check.
pub fn begin_staged_package_activation(
    target: &Path,
    staged: &Path,
    backup: &Path,
) -> Result<PendingPackageActivation> {
    let had_previous = target.exists();

    if had_previous {
        fs::rename(target, &backup).with_context(|| {
            format!(
                "Failed to stage existing plugin {} for replacement",
                target.display()
            )
        })?;
    }

    if let Err(activation_error) = fs::rename(staged, target) {
        let rollback_error = if had_previous {
            fs::rename(&backup, target).err()
        } else {
            None
        };
        return match rollback_error {
            Some(rollback_error) => Err(anyhow!(
                "Plugin activation failed ({activation_error}); rollback also failed ({rollback_error})"
            )),
            None if had_previous => {
                Err(activation_error).context("Plugin activation failed; previous version restored")
            }
            None => Err(activation_error).context("Plugin activation failed"),
        };
    }

    Ok(PendingPackageActivation {
        target: target.to_path_buf(),
        backup: had_previous.then(|| backup.to_path_buf()),
    })
}

pub fn rollback_package_activation(target: &Path, backup: Option<&Path>) -> Result<()> {
    if target.exists() {
        fs::remove_dir_all(target)
            .with_context(|| format!("Failed to remove unhealthy plugin {}", target.display()))?;
    }
    if let Some(backup) = backup {
        fs::rename(backup, target).with_context(|| {
            format!(
                "Failed to restore plugin rollback copy {}",
                backup.display()
            )
        })?;
    }
    Ok(())
}

/// Activating through a sibling backup makes replacement recoverable on every supported platform.
pub fn activate_staged_package(target: &Path, staged: &Path) -> Result<()> {
    let backup = target.with_file_name(format!(".plugin-backup-{}", uuid::Uuid::new_v4().simple()));
    begin_staged_package_activation(target, staged, &backup)?.commit()
}

#[derive(Default)]
struct CopyBudget {
    entries: usize,
    bytes: u64,
}

fn copy_directory_inner(
    root: &Path,
    source: &Path,
    destination: &Path,
    budget: &mut CopyBudget,
) -> Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        budget.entries += 1;
        if budget.entries > MAX_PACKAGE_ENTRIES {
            return Err(anyhow!(
                "Plugin directory contains more than {MAX_PACKAGE_ENTRIES} entries"
            ));
        }

        let entry = entry?;
        let file_type = entry.file_type()?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let relative = source_path
            .strip_prefix(root)?
            .to_string_lossy()
            .replace('\\', "/");
        validate_package_path(&relative)?;

        if file_type.is_symlink() {
            return Err(anyhow!(
                "Plugin directory may not contain links: {}",
                source_path.display()
            ));
        }
        if file_type.is_dir() {
            copy_directory_inner(root, &source_path, &destination_path, budget)?;
            continue;
        }
        if !file_type.is_file() {
            return Err(anyhow!(
                "Plugin directory contains an unsupported file type: {}",
                source_path.display()
            ));
        }

        let size = entry.metadata()?.len();
        if size > MAX_PACKAGE_FILE_BYTES {
            return Err(anyhow!(
                "Plugin file exceeds 20 MiB: {}",
                source_path.display()
            ));
        }
        budget.bytes = budget
            .bytes
            .checked_add(size)
            .ok_or_else(|| anyhow!("Plugin directory size overflow"))?;
        if budget.bytes > MAX_PACKAGE_EXPANDED_BYTES {
            return Err(anyhow!("Plugin directory exceeds 100 MiB"));
        }
        fs::copy(&source_path, &destination_path)
            .with_context(|| format!("Failed to copy {}", source_path.display()))?;
    }
    Ok(())
}

fn validate_archive_entry_name(name: &str) -> Result<()> {
    validate_package_path(name.trim_end_matches('/'))
        .with_context(|| format!("Invalid plugin archive path: {name}"))
}

fn validate_package_path(path: &str) -> Result<()> {
    if path.is_empty()
        || path.len() > MAX_PACKAGE_PATH_BYTES
        || path.contains('\\')
        || path.starts_with('/')
    {
        return Err(anyhow!("Invalid plugin package path: {path}"));
    }

    for component in path.split('/') {
        if component.is_empty()
            || component == "."
            || component == ".."
            || component.ends_with(['.', ' '])
            || component.contains(':')
            || component.chars().any(char::is_control)
            || is_windows_device_name(component)
        {
            return Err(anyhow!("Invalid plugin package path: {path}"));
        }
    }
    Ok(())
}

fn is_windows_device_name(component: &str) -> bool {
    let stem = component
        .split_once('.')
        .map_or(component, |(stem, _extension)| stem)
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$")
        || stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|suffix| suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9'))
}

fn normalized_package_path(path: &Path) -> Result<String> {
    let rendered = path
        .to_str()
        .ok_or_else(|| anyhow!("Plugin archive path is not valid UTF-8"))?
        .replace('\\', "/");
    // Reject case-only duplicates so the same package behaves consistently on Windows and Unix.
    Ok(rendered.to_ascii_lowercase())
}

fn reject_special_archive_entry(entry: &zip::read::ZipFile<'_>) -> Result<()> {
    if let Some(mode) = entry.unix_mode() {
        let kind = mode & 0o170000;
        if kind != 0 && kind != 0o100000 && kind != 0o040000 {
            return Err(anyhow!(
                "Plugin archive contains a link or special file: {}",
                entry.name()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
