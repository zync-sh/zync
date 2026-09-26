use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::AppHandle;

mod atomic_write;
mod path_policy;

use atomic_write::atomic_replace_external;
use path_policy::{
    has_multiple_hard_links, reject_sensitive_path, resolve_target, resolve_write_target,
};

const MAX_HANDLES_PER_RUNTIME: usize = 32;
const MAX_RELATIVE_PATH_BYTES: usize = 1024;
const MAX_TEXT_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES: usize = 500;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PluginFilesystemPickKind {
    File,
    Directory,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PluginFilesystemHandleAccess {
    Read,
    Write,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFilesystemPickRequest {
    pub kind: PluginFilesystemPickKind,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFilesystemHandle {
    pub handle: String,
    pub kind: PluginFilesystemPickKind,
    pub access: PluginFilesystemHandleAccess,
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFilesystemEntry {
    pub name: String,
    pub kind: &'static str,
    pub size: Option<u64>,
}

#[derive(Clone)]
struct HandleRecord {
    runtime_instance_id: String,
    root: PathBuf,
    kind: PluginFilesystemPickKind,
    access: PluginFilesystemHandleAccess,
}

pub struct PluginFilesystemState {
    handles: Mutex<HashMap<String, HandleRecord>>,
}

impl PluginFilesystemState {
    pub fn new() -> Self {
        Self {
            handles: Mutex::new(HashMap::new()),
        }
    }

    pub fn issue_handle(
        &self,
        app: &AppHandle,
        runtime_instance_id: &str,
        selected_path: &Path,
        kind: PluginFilesystemPickKind,
    ) -> Result<PluginFilesystemHandle> {
        let root = fs::canonicalize(selected_path).context("Failed to resolve selected item")?;
        let metadata = fs::metadata(&root).context("Failed to inspect selected item")?;
        let expected_kind = match kind {
            PluginFilesystemPickKind::File => metadata.is_file(),
            PluginFilesystemPickKind::Directory => metadata.is_dir(),
        };
        if !expected_kind {
            return Err(anyhow!("The selected item has an unexpected type"));
        }
        reject_sensitive_path(app, &root)?;
        if metadata.is_file() && has_multiple_hard_links(&root, &metadata)? {
            return Err(anyhow!("Hard-linked files cannot be shared with plugins"));
        }

        let name = root
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or(if kind == PluginFilesystemPickKind::File {
                "Selected file"
            } else {
                "Selected folder"
            })
            .to_string();
        let mut handles = self
            .handles
            .lock()
            .map_err(|_| anyhow!("Plugin filesystem handles are unavailable"))?;
        ensure_handle_capacity(&handles, runtime_instance_id)?;
        let handle = format!("pfh_{}", uuid::Uuid::new_v4().simple());
        handles.insert(
            handle.clone(),
            HandleRecord {
                runtime_instance_id: runtime_instance_id.to_string(),
                root,
                kind,
                access: PluginFilesystemHandleAccess::Read,
            },
        );
        Ok(PluginFilesystemHandle {
            handle,
            kind,
            access: PluginFilesystemHandleAccess::Read,
            name,
        })
    }

    pub fn issue_write_file_handle(
        &self,
        app: &AppHandle,
        runtime_instance_id: &str,
        selected_path: &Path,
    ) -> Result<PluginFilesystemHandle> {
        let target = resolve_write_target(app, selected_path)?;
        let name = target
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| anyhow!("Selected file name is not valid Unicode"))?
            .to_string();
        let mut handles = self
            .handles
            .lock()
            .map_err(|_| anyhow!("Plugin filesystem handles are unavailable"))?;
        ensure_handle_capacity(&handles, runtime_instance_id)?;
        let handle = format!("pfh_{}", uuid::Uuid::new_v4().simple());
        handles.insert(
            handle.clone(),
            HandleRecord {
                runtime_instance_id: runtime_instance_id.to_string(),
                root: target,
                kind: PluginFilesystemPickKind::File,
                access: PluginFilesystemHandleAccess::Write,
            },
        );
        Ok(PluginFilesystemHandle {
            handle,
            kind: PluginFilesystemPickKind::File,
            access: PluginFilesystemHandleAccess::Write,
            name,
        })
    }

    pub fn read_text(
        &self,
        app: &AppHandle,
        runtime_instance_id: &str,
        handle: &str,
        relative_path: Option<&str>,
    ) -> Result<String> {
        let record = self.record_for(runtime_instance_id, handle)?;
        require_access(&record, PluginFilesystemHandleAccess::Read)?;
        let target = resolve_target(&record, relative_path)?;
        reject_sensitive_path(app, &target)?;
        let metadata = fs::metadata(&target).context("Failed to inspect selected file")?;
        if !metadata.is_file() {
            return Err(anyhow!("The selected item is not a file"));
        }
        if has_multiple_hard_links(&target, &metadata)? {
            return Err(anyhow!("Hard-linked files cannot be read by plugins"));
        }
        if metadata.len() > MAX_TEXT_FILE_BYTES {
            return Err(anyhow!(
                "Selected file exceeds the {MAX_TEXT_FILE_BYTES}-byte text limit"
            ));
        }
        let bytes = fs::read(&target).context("Failed to read selected file")?;
        String::from_utf8(bytes).map_err(|_| anyhow!("Selected file is not UTF-8 text"))
    }

    pub fn list(
        &self,
        app: &AppHandle,
        runtime_instance_id: &str,
        handle: &str,
        relative_path: Option<&str>,
    ) -> Result<Vec<PluginFilesystemEntry>> {
        let record = self.record_for(runtime_instance_id, handle)?;
        require_access(&record, PluginFilesystemHandleAccess::Read)?;
        if record.kind != PluginFilesystemPickKind::Directory {
            return Err(anyhow!("Only folder handles can be listed"));
        }
        let target = resolve_target(&record, relative_path)?;
        reject_sensitive_path(app, &target)?;
        if !fs::metadata(&target)
            .context("Failed to inspect selected folder")?
            .is_dir()
        {
            return Err(anyhow!("The selected item is not a folder"));
        }

        let mut entries = Vec::new();
        for entry in fs::read_dir(&target).context("Failed to list selected folder")? {
            if entries.len() >= MAX_DIRECTORY_ENTRIES {
                return Err(anyhow!(
                    "Selected folder contains more than {MAX_DIRECTORY_ENTRIES} visible entries"
                ));
            }
            let entry = entry.context("Failed to inspect a selected folder entry")?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow!("Selected folder contains a non-Unicode name"))?;
            let metadata = fs::symlink_metadata(entry.path())
                .context("Failed to inspect a selected folder entry")?;
            let (kind, size) = if metadata.file_type().is_symlink() {
                ("unavailable", None)
            } else if metadata.is_file() {
                ("file", Some(metadata.len()))
            } else if metadata.is_dir() {
                ("directory", None)
            } else {
                ("unavailable", None)
            };
            entries.push(PluginFilesystemEntry { name, kind, size });
        }
        entries.sort_by(|left, right| {
            left.name
                .to_ascii_lowercase()
                .cmp(&right.name.to_ascii_lowercase())
                .then_with(|| left.name.cmp(&right.name))
        });
        Ok(entries)
    }

    pub fn write_text(
        &self,
        app: &AppHandle,
        runtime_instance_id: &str,
        handle: &str,
        content: &str,
    ) -> Result<()> {
        if content.len() > MAX_TEXT_FILE_BYTES as usize {
            return Err(anyhow!(
                "Plugin file content exceeds the {MAX_TEXT_FILE_BYTES}-byte text limit"
            ));
        }
        let record = self.record_for(runtime_instance_id, handle)?;
        require_access(&record, PluginFilesystemHandleAccess::Write)?;
        if record.kind != PluginFilesystemPickKind::File {
            return Err(anyhow!("Only file handles can be written"));
        }
        let target = resolve_write_target(app, &record.root)?;
        if target != record.root {
            return Err(anyhow!("Selected file destination changed after approval"));
        }
        atomic_replace_external(&target, content.as_bytes())
            .context("Failed to replace selected file")
    }

    pub fn revoke_runtime(&self, runtime_instance_id: &str) {
        if let Ok(mut handles) = self.handles.lock() {
            handles.retain(|_, record| record.runtime_instance_id != runtime_instance_id);
        }
    }

    pub fn reset(&self) {
        if let Ok(mut handles) = self.handles.lock() {
            handles.clear();
        }
    }

    fn record_for(&self, runtime_instance_id: &str, handle: &str) -> Result<HandleRecord> {
        if !handle.starts_with("pfh_") || handle.len() > 64 {
            return Err(anyhow!("Invalid plugin filesystem handle"));
        }
        let handles = self
            .handles
            .lock()
            .map_err(|_| anyhow!("Plugin filesystem handles are unavailable"))?;
        let record = handles
            .get(handle)
            .ok_or_else(|| anyhow!("Plugin filesystem handle is missing or expired"))?;
        if record.runtime_instance_id != runtime_instance_id {
            return Err(anyhow!(
                "Plugin filesystem handle belongs to another runtime"
            ));
        }
        Ok(record.clone())
    }
}

fn ensure_handle_capacity(
    handles: &HashMap<String, HandleRecord>,
    runtime_instance_id: &str,
) -> Result<()> {
    let runtime_handle_count = handles
        .values()
        .filter(|record| record.runtime_instance_id == runtime_instance_id)
        .count();
    if runtime_handle_count >= MAX_HANDLES_PER_RUNTIME {
        return Err(anyhow!(
            "A plugin runtime may hold at most {MAX_HANDLES_PER_RUNTIME} external items"
        ));
    }
    Ok(())
}

fn require_access(record: &HandleRecord, expected: PluginFilesystemHandleAccess) -> Result<()> {
    if record.access != expected {
        return Err(anyhow!(
            "Plugin filesystem handle does not allow this operation"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
