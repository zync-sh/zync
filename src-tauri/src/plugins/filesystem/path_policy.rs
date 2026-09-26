use super::{HandleRecord, PluginFilesystemPickKind, MAX_RELATIVE_PATH_BYTES};
use anyhow::{anyhow, Context, Result};
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};

pub(super) fn resolve_write_target(app: &AppHandle, selected_path: &Path) -> Result<PathBuf> {
    let file_name = selected_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow!("Selected file name is missing or invalid"))?;
    validate_file_name(file_name)?;
    let parent = selected_path
        .parent()
        .ok_or_else(|| anyhow!("Selected file has no parent folder"))?;
    let canonical_parent = fs::canonicalize(parent).context("Failed to resolve selected folder")?;
    let target = canonical_parent.join(file_name);
    reject_sensitive_path(app, &target)?;

    if target.exists() {
        let link_metadata = fs::symlink_metadata(&target)
            .context("Failed to inspect selected write destination")?;
        if link_metadata.file_type().is_symlink() {
            return Err(anyhow!("Symbolic links cannot be changed by plugins"));
        }
        let canonical_target =
            fs::canonicalize(&target).context("Failed to resolve selected write destination")?;
        if canonical_target.parent() != Some(canonical_parent.as_path()) {
            return Err(anyhow!("Selected file escapes its approved folder"));
        }
        let metadata = fs::metadata(&canonical_target)
            .context("Failed to inspect selected write destination")?;
        if !metadata.is_file() {
            return Err(anyhow!("The selected write destination is not a file"));
        }
        if has_multiple_hard_links(&canonical_target, &metadata)? {
            return Err(anyhow!("Hard-linked files cannot be changed by plugins"));
        }
        return Ok(canonical_target);
    }
    Ok(target)
}

pub(super) fn resolve_target(
    record: &HandleRecord,
    relative_path: Option<&str>,
) -> Result<PathBuf> {
    let relative = validate_relative_path(relative_path.unwrap_or_default())?;
    if record.kind == PluginFilesystemPickKind::File {
        if relative.as_os_str().is_empty() {
            return Ok(record.root.clone());
        }
        return Err(anyhow!("File handles do not accept a relative path"));
    }

    let mut candidate = record.root.clone();
    for component in relative.components() {
        let Component::Normal(part) = component else {
            continue;
        };
        candidate.push(part);
        let metadata =
            fs::symlink_metadata(&candidate).context("Selected folder item does not exist")?;
        if metadata.file_type().is_symlink() {
            return Err(anyhow!("Symbolic links are unavailable to plugins"));
        }
    }
    let canonical =
        fs::canonicalize(&candidate).context("Failed to resolve selected folder item")?;
    if !canonical.starts_with(&record.root) {
        return Err(anyhow!("Selected folder item escapes its granted handle"));
    }
    Ok(canonical)
}

pub(super) fn validate_relative_path(value: &str) -> Result<PathBuf> {
    if value.len() > MAX_RELATIVE_PATH_BYTES || value.contains('\0') || value.contains(':') {
        return Err(anyhow!("Invalid relative path"));
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(anyhow!("Only paths inside the selected folder are allowed"));
    }
    for component in path.components() {
        if let Component::Normal(part) = component {
            let name = part.to_string_lossy();
            let stem = name.split('.').next().unwrap_or_default();
            if is_windows_device_name(stem) {
                return Err(anyhow!("Windows device paths are unavailable to plugins"));
            }
        }
    }
    Ok(path.to_path_buf())
}

pub(super) fn validate_file_name(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 255
        || value
            .chars()
            .any(|character| matches!(character, '\0' | ':' | '/' | '\\'))
        || value.ends_with('.')
        || value.ends_with(' ')
        || value.chars().any(char::is_control)
    {
        return Err(anyhow!("Invalid selected file name"));
    }
    let stem = value.split('.').next().unwrap_or_default();
    if is_windows_device_name(stem) {
        return Err(anyhow!("Windows device paths are unavailable to plugins"));
    }
    Ok(())
}

fn is_windows_device_name(value: &str) -> bool {
    let upper = value.to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || upper
            .strip_prefix("COM")
            .or_else(|| upper.strip_prefix("LPT"))
            .is_some_and(|number| {
                matches!(number, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
}

pub(super) fn reject_sensitive_path(app: &AppHandle, path: &Path) -> Result<()> {
    for root in sensitive_roots(app) {
        if path.starts_with(&root) {
            return Err(anyhow!(
                "This protected location cannot be shared with plugins"
            ));
        }
    }
    Ok(())
}

fn sensitive_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(path) = app.path().app_config_dir() {
        candidates.push(path);
    }
    if let Ok(path) = app.path().app_data_dir() {
        candidates.push(path);
    }
    if let Ok(home) = app.path().home_dir() {
        candidates.extend([
            home.join(".ssh"),
            home.join(".gnupg"),
            home.join(".aws"),
            home.join(".config/google-chrome"),
            home.join(".config/chromium"),
            home.join(".mozilla/firefox"),
            home.join("Library/Application Support/Google/Chrome"),
            home.join("Library/Application Support/Microsoft Edge"),
            home.join("Library/Application Support/Firefox/Profiles"),
            home.join("Library/Keychains"),
            home.join("AppData/Local/Google/Chrome/User Data"),
            home.join("AppData/Local/Microsoft/Edge/User Data"),
            home.join("AppData/Roaming/Microsoft/Credentials"),
        ]);
    }
    candidates
        .into_iter()
        .filter_map(|candidate| fs::canonicalize(candidate).ok())
        .collect()
}

#[cfg(unix)]
pub(super) fn has_multiple_hard_links(_path: &Path, metadata: &fs::Metadata) -> Result<bool> {
    use std::os::unix::fs::MetadataExt;
    Ok(metadata.nlink() > 1)
}

#[cfg(windows)]
pub(super) fn has_multiple_hard_links(path: &Path, _metadata: &fs::Metadata) -> Result<bool> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let file = fs::File::open(path).context("Failed to inspect selected file links")?;
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let result =
        unsafe { GetFileInformationByHandle(file.as_raw_handle() as HANDLE, &mut information) };
    if result == 0 {
        return Err(std::io::Error::last_os_error())
            .context("Failed to inspect selected file links");
    }
    Ok(information.nNumberOfLinks > 1)
}

#[cfg(not(any(unix, windows)))]
pub(super) fn has_multiple_hard_links(_path: &Path, _metadata: &fs::Metadata) -> Result<bool> {
    Ok(true)
}
