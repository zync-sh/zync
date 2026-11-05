use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::sync::{Arc, OnceLock};
use std::time::UNIX_EPOCH;
use tokio::sync::Semaphore;

// Keep slow disks from occupying Tokio's entire blocking pool.
const LOCAL_IO_CONCURRENCY: usize = 4;
static LOCAL_IO_GATE: OnceLock<Arc<Semaphore>> = OnceLock::new();
// Reserve separate admission for long copies, deletes and transfer size scans.
const LOCAL_BULK_IO_CONCURRENCY: usize = 2;
static LOCAL_BULK_IO_GATE: OnceLock<Arc<Semaphore>> = OnceLock::new();

/// Runs interactive local I/O on bounded blocking workers; running work owns its permit.
pub(crate) async fn run_local_io<T, F>(operation: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    let gate = LOCAL_IO_GATE
        .get_or_init(|| Arc::new(Semaphore::new(LOCAL_IO_CONCURRENCY)))
        .clone();
    run_local_io_with_gate(gate, operation).await
}

/// Bounds bulk local work independently so it cannot consume interactive I/O permits.
pub(crate) async fn run_local_bulk_io<T, F>(operation: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    let gate = LOCAL_BULK_IO_GATE
        .get_or_init(|| Arc::new(Semaphore::new(LOCAL_BULK_IO_CONCURRENCY)))
        .clone();
    run_local_io_with_gate(gate, operation).await
}

/// Keeps the admission permit with running work so caller cancellation cannot admit excess work.
async fn run_local_io_with_gate<T, F>(gate: Arc<Semaphore>, operation: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    let permit = gate
        .acquire_owned()
        .await
        .map_err(|_| anyhow!("Local filesystem worker pool closed"))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        operation()
    })
    .await
    .map_err(|error| anyhow!("Local filesystem worker failed: {error}"))?
}

/// Decode the complete SFTP entry kind, not overlapping mode-bit predicates.
fn remote_entry_is_directory(attributes: &russh_sftp::protocol::FileAttributes) -> bool {
    attributes.file_type().is_dir()
}

/// Creates a transfer destination without treating inaccessible or symlink paths as directories.
pub async fn ensure_remote_transfer_directory(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
) -> Result<(), String> {
    crate::transfers::ensure_directory(
        async {
            sftp.create_dir(path)
                .await
                .map_err(|error| format!("Failed to create remote directory '{}': {}", path, error))
        },
        async {
            let attributes = sftp
                .symlink_metadata(path)
                .await
                .map_err(|error| error.to_string())?;
            Ok(remote_entry_is_directory(&attributes))
        },
    )
    .await
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub r#type: String, // "d" for directory, "-" for file, "l" for symlink
    pub size: u64,
    pub last_modified: u64,
    pub permissions: String,
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub group: String,
}

/// `/etc/passwd` and `/etc/group` lines: `name:*:id:...`
fn parse_unix_name_map(contents: &str) -> HashMap<u32, String> {
    let mut map = HashMap::new();
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split(':');
        let name = parts.next().unwrap_or("");
        let _ = parts.next();
        let Some(id) = parts.next().and_then(|value| value.parse::<u32>().ok()) else {
            continue;
        };
        if !name.is_empty() {
            map.entry(id).or_insert_with(|| name.to_string());
        }
    }
    map
}

fn identity_label(name: Option<&str>, id: Option<u32>, map: &HashMap<u32, String>) -> String {
    if let Some(name) = name.map(str::trim).filter(|value| !value.is_empty()) {
        return name.to_string();
    }
    if let Some(id) = id {
        if let Some(mapped) = map.get(&id) {
            return mapped.clone();
        }
        return id.to_string();
    }
    String::new()
}

#[cfg(unix)]
fn load_local_name_map(path: &str) -> HashMap<u32, String> {
    fs::read_to_string(path)
        .map(|contents| parse_unix_name_map(&contents))
        .unwrap_or_default()
}

async fn load_sftp_name_map(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
) -> HashMap<u32, String> {
    match sftp.read(path).await {
        Ok(bytes) => parse_unix_name_map(&String::from_utf8_lossy(&bytes)),
        Err(_) => HashMap::new(),
    }
}

pub type SftpIdentityMaps = (HashMap<u32, String>, HashMap<u32, String>);

pub async fn cached_sftp_identity_maps<'a>(
    sftp: &russh_sftp::client::SftpSession,
    cache: &'a tokio::sync::OnceCell<SftpIdentityMaps>,
) -> &'a SftpIdentityMaps {
    cache
        .get_or_init(|| async {
            (
                load_sftp_name_map(sftp, "/etc/passwd").await,
                load_sftp_name_map(sftp, "/etc/group").await,
            )
        })
        .await
}

fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

fn local_home_dir() -> String {
    #[cfg(windows)]
    {
        env_nonempty("USERPROFILE")
            .or_else(|| env_nonempty("HOME"))
            .unwrap_or_else(|| "C:\\".to_string())
    }
    #[cfg(not(windows))]
    {
        env_nonempty("HOME").unwrap_or_else(|| "/".to_string())
    }
}

/// Uses the same home-directory fallback for full listings and lightweight completions.
fn local_listing_path(path: &str) -> String {
    if path.is_empty() {
        local_home_dir()
    } else {
        path.to_string()
    }
}

/// Preserves the existing directory/symlink-first listing order for local callers.
fn sort_local_entries(entries: &mut [FileEntry]) {
    entries.sort_by(|a, b| {
        let a_dir = a.r#type == "d" || a.r#type == "l";
        let b_dir = b.r#type == "d" || b.r#type == "l";
        if a_dir && !b_dir {
            std::cmp::Ordering::Less
        } else if !a_dir && b_dir {
            std::cmp::Ordering::Greater
        } else {
            a.name.cmp(&b.name)
        }
    });
}

pub struct FileSystem;

fn editor_file_too_large(max_bytes: u64) -> anyhow::Error {
    anyhow!("FILE_TOO_LARGE: File exceeds the editor's {max_bytes}-byte limit")
}

fn limited_text(content: Vec<u8>, max_bytes: u64) -> Result<String> {
    if content.len() as u64 > max_bytes {
        return Err(editor_file_too_large(max_bytes));
    }
    Ok(String::from_utf8_lossy(&content).to_string())
}

impl FileSystem {
    pub fn new() -> Self {
        Self
    }

    /// Dispatches legacy local listings through the bounded blocking worker boundary.
    #[allow(dead_code)]
    pub async fn list_dir(&self, connection_id: &str, path: &str) -> Result<Vec<FileEntry>> {
        // Deprecated: logic moved to commands.rs for proper dispatch
        if connection_id == "local" {
            self.list_local_async(path).await
        } else {
            Err(anyhow!(
                "Remote connection not handled in list_dir, use list_remote"
            ))
        }
    }

    /// Lists full local metadata synchronously for callers already running off the async executor.
    pub fn list_local(&self, path: &str) -> Result<Vec<FileEntry>> {
        let path = local_listing_path(path);

        let dir = fs::read_dir(&path).map_err(|e| anyhow!("Failed to read directory: {}", e))?;
        let mut entries = Vec::new();
        #[cfg(unix)]
        let user_map = load_local_name_map("/etc/passwd");
        #[cfg(unix)]
        let group_map = load_local_name_map("/etc/group");

        for entry in dir {
            let entry = entry.map_err(|e| anyhow!("Failed to read entry: {}", e))?;
            let metadata = fs::symlink_metadata(entry.path())
                .map_err(|e| anyhow!("Failed to read metadata: {}", e))?;
            let file_name = entry.file_name().to_string_lossy().to_string();

            let file_type = if metadata.file_type().is_symlink() {
                "l"
            } else if metadata.is_dir() {
                "d"
            } else {
                "-"
            }
            .to_string();
            let size = metadata.len();
            let last_modified = metadata.modified()?.duration_since(UNIX_EPOCH)?.as_millis() as u64;

            // Permissions handling
            #[cfg(unix)]
            let permissions = format!("{:o}", metadata.mode() & 0o777);

            #[cfg(windows)]
            let permissions = if metadata.permissions().readonly() {
                "444".to_string()
            } else {
                "666".to_string()
            };

            #[cfg(unix)]
            let owner = identity_label(None, Some(metadata.uid()), &user_map);
            #[cfg(unix)]
            let group = identity_label(None, Some(metadata.gid()), &group_map);
            #[cfg(windows)]
            let owner = String::new();
            #[cfg(windows)]
            let group = String::new();

            entries.push(FileEntry {
                name: file_name,
                path: entry.path().to_string_lossy().to_string(),
                r#type: file_type,
                size,
                last_modified,
                permissions,
                owner,
                group,
            });
        }

        sort_local_entries(&mut entries);

        Ok(entries)
    }

    /// Collects a full local listing without blocking an async runtime worker.
    pub async fn list_local_async(&self, path: &str) -> Result<Vec<FileEntry>> {
        let path = path.to_owned();
        run_local_io(move || FileSystem::new().list_local(&path)).await
    }

    /// Lists completion names and kinds without loading owners, sizes or modification times.
    pub async fn list_local_names_async(&self, path: &str) -> Result<Vec<FileEntry>> {
        let path = path.to_owned();
        run_local_io(move || {
            let path = local_listing_path(&path);
            let directory =
                fs::read_dir(path).map_err(|error| anyhow!("Failed to read directory: {error}"))?;
            let mut entries = Vec::new();
            for entry in directory {
                let entry = entry.map_err(|error| anyhow!("Failed to read entry: {error}"))?;
                let kind = entry
                    .file_type()
                    .map_err(|error| anyhow!("Failed to read file type: {error}"))?;
                entries.push(FileEntry {
                    name: entry.file_name().to_string_lossy().to_string(),
                    path: entry.path().to_string_lossy().to_string(),
                    r#type: if kind.is_symlink() {
                        "l"
                    } else if kind.is_dir() {
                        "d"
                    } else {
                        "-"
                    }
                    .into(),
                    size: 0,
                    last_modified: 0,
                    permissions: String::new(),
                    owner: String::new(),
                    group: String::new(),
                });
            }
            sort_local_entries(&mut entries);
            Ok(entries)
        })
        .await
    }

    pub async fn list_remote(
        &self,
        sftp: &russh_sftp::client::SftpSession,
        path: &str,
        identity_cache: &tokio::sync::OnceCell<SftpIdentityMaps>,
    ) -> Result<Vec<FileEntry>> {
        let path = if path.is_empty() { "." } else { path }; // Default to current dir if empty, usually Home

        let entries_iter = sftp
            .read_dir(path)
            .await
            .map_err(|e| anyhow!("SFTP read_dir failed: {}", e))?;
        let entries: Vec<_> = entries_iter.collect();
        let mut result = Vec::new();
        let identity_maps = cached_sftp_identity_maps(sftp, identity_cache).await;

        for entry in entries {
            let name = entry.file_name();
            // println!("[FS] Entry: {}", name); // Optional verbose log
            // Skip . and ..
            if name == "." || name == ".." {
                continue;
            }

            let attrs = entry.metadata();
            let size = attrs.size.unwrap_or(0);
            let mtime = attrs.mtime.unwrap_or(0) as u64 * 1000; // ms
            let perms = attrs.permissions.unwrap_or(0);

            // Check file-type bits: mask to 0o170000 and compare exact constants.
            // 0o120000 = symlink, 0o040000 = directory, anything else = regular file.
            let type_str = if (perms & 0o170000) == 0o120000 {
                "l"
            } else if (perms & 0o170000) == 0o040000 {
                "d"
            } else {
                "-"
            };

            // Construct path manually
            let full_path = if path == "/" {
                format!("/{}", name)
            } else if path.ends_with('/') {
                format!("{}{}", path, name)
            } else {
                format!("{}/{}", path, name)
            };

            result.push(FileEntry {
                name,
                path: full_path,
                r#type: type_str.to_string(),
                size,
                last_modified: mtime,
                permissions: format!("{:o}", perms & 0o777),
                owner: identity_label(attrs.user.as_deref(), attrs.uid, &identity_maps.0),
                group: identity_label(attrs.group.as_deref(), attrs.gid, &identity_maps.1),
            });
        }

        // Sort: directories and symlinks first, then files
        result.sort_by(|a, b| {
            let a_dir = a.r#type == "d" || a.r#type == "l";
            let b_dir = b.r#type == "d" || b.r#type == "l";
            if a_dir && !b_dir {
                std::cmp::Ordering::Less
            } else if !a_dir && b_dir {
                std::cmp::Ordering::Greater
            } else {
                a.name.cmp(&b.name)
            }
        });

        Ok(result)
    }

    pub fn get_home_dir(&self, connection_id: &str) -> Result<String> {
        if connection_id == "local" {
            Ok(local_home_dir())
        } else {
            Err(anyhow!("Remote connection not yet implemented"))
        }
    }

    /// Reads local text with the existing lossy UTF-8 conversion on a blocking worker.
    pub async fn read_file(&self, _connection_id: &str, path: &str) -> Result<String> {
        let path = path.to_owned();
        run_local_io(move || {
            let content = fs::read(path).map_err(|e| anyhow!("Failed to read file: {}", e))?;
            Ok(String::from_utf8_lossy(&content).to_string())
        })
        .await
    }

    pub fn read_local_limited(&self, path: &str, max_bytes: u64) -> Result<String> {
        let file = fs::File::open(path).map_err(|e| anyhow!("Failed to open file: {}", e))?;
        if file.metadata()?.len() > max_bytes {
            return Err(editor_file_too_large(max_bytes));
        }
        let mut content = Vec::new();
        file.take(max_bytes + 1).read_to_end(&mut content)?;
        limited_text(content, max_bytes)
    }

    /// Runs the bounded editor reader without blocking the async executor.
    pub async fn read_local_limited_async(&self, path: &str, max_bytes: u64) -> Result<String> {
        let path = path.to_owned();
        run_local_io(move || FileSystem::new().read_local_limited(&path, max_bytes)).await
    }

    /// Writes local text through the bounded worker pool, preserving remote dispatch errors.
    pub async fn write_file(&self, connection_id: &str, path: &str, content: &str) -> Result<()> {
        if connection_id == "local" {
            let path = path.to_owned();
            let content = content.to_owned();
            run_local_io(move || {
                fs::write(path, content).map_err(|e| anyhow!("Failed to write file: {}", e))
            })
            .await
        } else {
            Err(anyhow!("Remote connection not yet implemented"))
        }
    }
    /// Creates a new local file atomically on a worker without overwriting existing entries.
    pub async fn create_file(&self, connection_id: &str, path: &str) -> Result<()> {
        if connection_id == "local" {
            let path = path.to_owned();
            run_local_io(move || {
                std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(path)
                    .map_err(|e| anyhow!("Failed to create file: {}", e))?;
                Ok(())
            })
            .await
        } else {
            Err(anyhow!("Remote connection not yet implemented"))
        }
    }

    /// Creates the local directory tree as one bounded worker operation.
    pub async fn create_dir(&self, connection_id: &str, path: &str) -> Result<()> {
        if connection_id == "local" {
            let path = path.to_owned();
            run_local_io(move || {
                fs::create_dir_all(path).map_err(|e| anyhow!("Failed to create directory: {}", e))
            })
            .await
        } else {
            Err(anyhow!("Remote connection not yet implemented"))
        }
    }

    /// Performs the existing local rename on a bounded worker.
    pub async fn rename(&self, connection_id: &str, old_path: &str, new_path: &str) -> Result<()> {
        if connection_id == "local" {
            let old_path = old_path.to_owned();
            let new_path = new_path.to_owned();
            run_local_io(move || {
                fs::rename(old_path, new_path).map_err(|e| anyhow!("Failed to rename: {}", e))
            })
            .await
        } else {
            Err(anyhow!("Remote connection not yet implemented"))
        }
    }

    /// Runs complete local deletion, including recursive work, on a bounded bulk worker.
    pub async fn delete(&self, connection_id: &str, path: &str) -> Result<()> {
        if connection_id == "local" {
            let path = path.to_owned();
            run_local_bulk_io(move || {
                let metadata =
                    fs::metadata(&path).map_err(|e| anyhow!("Failed to read metadata: {}", e))?;
                if metadata.is_dir() {
                    fs::remove_dir_all(path)
                        .map_err(|e| anyhow!("Failed to delete directory: {}", e))
                } else {
                    fs::remove_file(path).map_err(|e| anyhow!("Failed to delete file: {}", e))
                }
            })
            .await
        } else {
            Err(anyhow!("Remote connection not yet implemented"))
        }
    }

    /// Copies a local file or complete recursive tree as one bounded bulk worker operation.
    pub async fn copy(&self, connection_id: &str, from: &str, to: &str) -> Result<()> {
        if connection_id == "local" {
            let from = from.to_owned();
            let to = to.to_owned();
            run_local_bulk_io(move || {
                let metadata =
                    fs::metadata(&from).map_err(|e| anyhow!("Source not found: {}", e))?;
                if metadata.is_dir() {
                    Self::copy_dir_recursive(&from, &to)
                } else {
                    fs::copy(from, to).map_err(|e| anyhow!("Failed to copy file: {}", e))?;
                    Ok(())
                }
            })
            .await
        } else {
            Err(anyhow!("Remote connection not yet implemented"))
        }
    }

    /// Checks local existence on a worker while retaining the existing inaccessible-path behavior.
    pub async fn exists(&self, connection_id: &str, path: &str) -> Result<bool> {
        if connection_id == "local" {
            let path = path.to_owned();
            run_local_io(move || Ok(std::path::Path::new(&path).exists())).await
        } else {
            Err(anyhow!(
                "Remote connection not yet implemented in exists() - use exists_remote"
            ))
        }
    }

    // --- Remote Operations ---

    pub async fn read_remote(
        &self,
        sftp: &russh_sftp::client::SftpSession,
        path: &str,
    ) -> Result<String> {
        let content = sftp
            .read(path)
            .await
            .map_err(|e| anyhow!("Failed to read remote file: {}", e))?;
        Ok(String::from_utf8_lossy(&content).to_string())
    }

    /// Reads at most the editor limit plus one byte, rejecting files that exceed the limit.
    pub async fn read_remote_limited(
        &self,
        sftp: &russh_sftp::client::SftpSession,
        path: &str,
        max_bytes: u64,
    ) -> Result<String> {
        use russh_sftp::protocol::OpenFlags;
        use tokio::io::AsyncReadExt;

        if sftp
            .metadata(path)
            .await?
            .size
            .is_some_and(|size| size > max_bytes)
        {
            return Err(editor_file_too_large(max_bytes));
        }
        let file = sftp
            .open_with_flags(path, OpenFlags::READ)
            .await
            .map_err(|e| anyhow!("Failed to open remote file: {}", e))?;
        let mut content = Vec::new();
        file.take(max_bytes + 1).read_to_end(&mut content).await?;
        limited_text(content, max_bytes)
    }

    pub async fn write_remote(
        &self,
        sftp: &russh_sftp::client::SftpSession,
        path: &str,
        content: &[u8],
    ) -> Result<()> {
        use russh_sftp::protocol::OpenFlags;
        let mut file = sftp
            .open_with_flags(
                path,
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
            )
            .await
            .map_err(|e| anyhow!("Failed to open file for writing '{}': {}", path, e))?;

        use tokio::io::AsyncWriteExt;
        file.write_all(content)
            .await
            .map_err(|e| anyhow!("Failed to write content to '{}': {}", path, e))?;
        Ok(())
    }

    pub async fn create_file_remote(
        &self,
        sftp: &russh_sftp::client::SftpSession,
        path: &str,
    ) -> Result<()> {
        use russh_sftp::protocol::OpenFlags;
        let _file = sftp
            .open_with_flags(
                path,
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
            )
            .await
            .map_err(|e| anyhow!("Failed to create file '{}': {}", path, e))?;
        Ok(())
    }

    pub async fn create_dir_remote(
        &self,
        sftp: &russh_sftp::client::SftpSession,
        path: &str,
    ) -> Result<()> {
        sftp.create_dir(path)
            .await
            .map_err(|e| anyhow!("Failed to create remote directory '{}': {}", path, e))
    }

    pub async fn rename_remote(
        &self,
        sftp: &russh_sftp::client::SftpSession,
        old_path: &str,
        new_path: &str,
    ) -> Result<()> {
        sftp.rename(old_path, new_path)
            .await
            .map_err(|e| anyhow!("Failed to rename remote file: {}", e))
    }

    pub async fn delete_remote(
        &self,
        sftp: &russh_sftp::client::SftpSession,
        path: &str,
    ) -> Result<()> {
        let metadata = sftp
            .symlink_metadata(path)
            .await
            .map_err(|e| anyhow!("Failed to stat file: {}", e))?;
        if remote_entry_is_directory(&metadata) {
            self.delete_dir_recursive_remote(sftp, path).await
        } else {
            sftp.remove_file(path)
                .await
                .map_err(|e| anyhow!("Failed to remove file: {}", e))
        }
    }

    fn delete_dir_recursive_remote<'a>(
        &'a self,
        sftp: &'a russh_sftp::client::SftpSession,
        path: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            let entries = sftp
                .read_dir(path)
                .await
                .map_err(|e| anyhow!("Failed to list dir '{}': {}", path, e))?;

            for entry in entries {
                let name = entry.file_name();
                if name == "." || name == ".." {
                    continue;
                }

                let full_path = if path.ends_with('/') {
                    format!("{}{}", path, name)
                } else {
                    format!("{}/{}", path, name)
                };

                // Check if directory
                let is_dir = entry.file_type().is_dir();

                if is_dir && !entry.file_type().is_symlink() {
                    self.delete_dir_recursive_remote(sftp, &full_path).await?;
                } else {
                    sftp.remove_file(&full_path)
                        .await
                        .map_err(|e| anyhow!("Failed to remove file '{}': {}", full_path, e))?;
                }
            }

            sftp.remove_dir(path)
                .await
                .map_err(|e| anyhow!("Failed to remove dir '{}': {}", path, e))?;
            Ok(())
        })
    }

    pub async fn copy_remote(
        &self,
        sftp: &russh_sftp::client::SftpSession,
        from: &str,
        to: &str,
    ) -> Result<()> {
        let metadata = sftp
            .metadata(from)
            .await
            .map_err(|e| anyhow!("Failed to stat source '{}': {}", from, e))?;

        if remote_entry_is_directory(&metadata) {
            self.copy_dir_recursive_remote(sftp, from, to).await
        } else {
            self.copy_file_remote(sftp, from, to).await
        }
    }

    /// Streams one remote file and completes destination flushing/close before reporting success.
    async fn copy_file_remote(
        &self,
        sftp: &russh_sftp::client::SftpSession,
        from: &str,
        to: &str,
    ) -> Result<()> {
        use russh_sftp::protocol::OpenFlags;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        println!("[FS] Copying file from '{}' to '{}'", from, to);

        // Read
        let mut source = sftp
            .open_with_flags(from, OpenFlags::READ)
            .await
            .map_err(|e| anyhow!("Failed to open source '{}': {}", from, e))?;

        // Write
        let mut dest = sftp
            .open_with_flags(
                to,
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
            )
            .await
            .map_err(|e| anyhow!("Failed to open dest '{}': {}", to, e))?;

        // Manual copy loop with 4MB buffer to maximize throughput on high-latency links
        let mut buffer = vec![0u8; 4194304];
        let mut total_bytes = 0;

        let copy_result = async {
            loop {
                let n = source
                    .read(&mut buffer)
                    .await
                    .map_err(|e| format!("Read error at {} bytes: {}", total_bytes, e))?;

                if n == 0 {
                    break;
                }

                dest.write_all(&buffer[..n])
                    .await
                    .map_err(|e| format!("Write error at {} bytes: {}", total_bytes, e))?;

                total_bytes += n;
            }

            // Preserve the existing optional remote fsync, then always await CLOSE.
            dest.flush()
                .await
                .map_err(|error| format!("Flush error: {error}"))?;
            Ok(())
        }
        .await;
        crate::transfers::finish_destination(&mut dest, copy_result)
            .await
            .map_err(|error| anyhow!(error))?;

        println!("[FS] Copied {} bytes", total_bytes);
        Ok(())
    }

    /// Recursively copies remote entries using a boxed future while preserving directory checks.
    fn copy_dir_recursive_remote<'a>(
        &'a self,
        sftp: &'a russh_sftp::client::SftpSession,
        from: &'a str,
        to: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            println!("[FS] Copying directory from '{}' to '{}'", from, to);

            ensure_remote_transfer_directory(sftp, to)
                .await
                .map_err(|error| anyhow!(error))?;

            // List source
            let entries = sftp
                .read_dir(from)
                .await
                .map_err(|e| anyhow!("Failed to list source dir '{}': {}", from, e))?;

            for entry in entries {
                let file_name = entry.file_name();
                if file_name == "." || file_name == ".." {
                    continue;
                }

                // Robust path joining
                let source_path = if from.ends_with('/') {
                    format!("{}{}", from, file_name)
                } else {
                    format!("{}/{}", from, file_name)
                };

                let dest_path = if to.ends_with('/') {
                    format!("{}{}", to, file_name)
                } else {
                    format!("{}/{}", to, file_name)
                };

                // Recursive call
                let is_dir = entry.file_type().is_dir();

                if is_dir && !entry.file_type().is_symlink() {
                    self.copy_dir_recursive_remote(sftp, &source_path, &dest_path)
                        .await?;
                } else {
                    // If it is a symlink, treated as file (might fail read if dangling, or copy content if valid)
                    // Ideally we should recreate the symlink, but copying content (dereference) is safer than infinite recursion.
                    // Or better: Just SKIP symlinks for now or try copy. If it's a symlink to dir, we don't recurse.
                    self.copy_file_remote(sftp, &source_path, &dest_path)
                        .await?;
                }
            }

            Ok(())
        })
    }

    pub async fn exists_remote(
        &self,
        sftp: &russh_sftp::client::SftpSession,
        path: &str,
    ) -> Result<bool> {
        sftp.try_exists(path)
            .await
            .map_err(|e| anyhow!("Failed to check existence: {}", e))
    }

    pub async fn get_unique_path_remote(
        &self,
        sftp: &russh_sftp::client::SftpSession,
        path: &str,
    ) -> Result<String> {
        if !self.exists_remote(sftp, path).await? {
            return Ok(path.to_string());
        }

        let path_buf = std::path::PathBuf::from(path);
        let parent = path_buf
            .parent()
            .unwrap_or_else(|| std::path::Path::new(""));
        let file_stem = path_buf.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let extension = path_buf.extension().and_then(|s| s.to_str()).unwrap_or("");

        if file_stem.is_empty() {
            return Err(anyhow!(
                "Cannot generate unique path for root or invalid path"
            ));
        }

        let mut counter = 1;
        while counter <= 100 {
            let new_name = if extension.is_empty() {
                format!("{} ({})", file_stem, counter)
            } else {
                format!("{} ({}).{}", file_stem, counter, extension)
            };

            let new_path = parent
                .join(new_name)
                .to_string_lossy()
                .to_string()
                .replace("\\", "/");

            if !self.exists_remote(sftp, &new_path).await? {
                return Ok(new_path);
            }
            counter += 1;
        }

        Err(anyhow!("Too many duplicate files (limit 100)"))
    }

    fn copy_dir_recursive(from: &str, to: &str) -> Result<()> {
        fs::create_dir_all(to).map_err(|e| anyhow!("Failed to create destination dir: {}", e))?;
        for entry in fs::read_dir(from).map_err(|e| anyhow!("Failed to read source dir: {}", e))? {
            let entry = entry.map_err(|e| anyhow!("Failed to read entry: {}", e))?;
            let ft = entry
                .file_type()
                .map_err(|e| anyhow!("Failed to read file type: {}", e))?;
            let dest_path = std::path::Path::new(to).join(entry.file_name());
            if ft.is_dir() {
                Self::copy_dir_recursive(
                    &entry.path().to_string_lossy(),
                    &dest_path.to_string_lossy(),
                )?;
            } else {
                fs::copy(entry.path(), dest_path)
                    .map_err(|e| anyhow!("Failed to copy file: {}", e))?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Duration;
    use tokio::time::timeout;

    const TEST_DEADLINE: Duration = Duration::from_secs(5);

    #[tokio::test]
    async fn bulk_and_interactive_local_io_have_independent_admission() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_str().unwrap();
        let source = directory.path().join("source.txt");
        let destination = directory.path().join("copy.txt");
        std::fs::write(&source, b"contents").unwrap();
        let fs = FileSystem::new();
        let bulk_gate = LOCAL_BULK_IO_GATE
            .get_or_init(|| Arc::new(Semaphore::new(LOCAL_BULK_IO_CONCURRENCY)))
            .clone();
        let held_bulk = bulk_gate
            .acquire_many_owned(LOCAL_BULK_IO_CONCURRENCY as u32)
            .await
            .unwrap();
        let mut pending_bulk = Box::pin(run_local_bulk_io(|| Ok(())));
        assert!(futures_util::poll!(&mut pending_bulk).is_pending());

        timeout(TEST_DEADLINE, async {
            assert_eq!(fs.list_local_async(root).await.unwrap().len(), 1);
            assert_eq!(fs.list_local_names_async(root).await.unwrap().len(), 1);
            assert_eq!(
                fs.read_local_limited_async(source.to_str().unwrap(), 8)
                    .await
                    .unwrap(),
                "contents"
            );
            assert!(fs.exists("local", source.to_str().unwrap()).await.unwrap());
        })
        .await
        .expect("bulk saturation must not block interactive reads");
        drop(held_bulk);
        timeout(TEST_DEADLINE, pending_bulk).await.unwrap().unwrap();

        let interactive_gate = LOCAL_IO_GATE
            .get_or_init(|| Arc::new(Semaphore::new(LOCAL_IO_CONCURRENCY)))
            .clone();
        let _held_interactive = interactive_gate
            .acquire_many_owned(LOCAL_IO_CONCURRENCY as u32)
            .await
            .unwrap();
        timeout(TEST_DEADLINE, async {
            fs.copy(
                "local",
                source.to_str().unwrap(),
                destination.to_str().unwrap(),
            )
            .await
            .unwrap();
            assert_eq!(std::fs::read(&destination).unwrap(), b"contents");
            fs.delete("local", destination.to_str().unwrap())
                .await
                .unwrap();
            assert!(!destination.exists());
        })
        .await
        .expect("bulk mutations must use their own admission pool");
    }

    #[tokio::test]
    async fn blocking_work_keeps_executor_responsive_and_owns_permit_after_cancellation() {
        let gate = Arc::new(Semaphore::new(1));
        let (started, started_rx) = tokio::sync::oneshot::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        let first_gate = gate.clone();
        let first = tokio::spawn(run_local_io_with_gate(first_gate, move || {
            let _ = started.send(());
            let _ = release_rx.recv_timeout(TEST_DEADLINE);
            Ok(())
        }));
        timeout(TEST_DEADLINE, started_rx).await.unwrap().unwrap();
        assert!(
            !first.is_finished(),
            "executor must observe the blocked worker before it finishes"
        );
        timeout(
            Duration::from_millis(250),
            tokio::time::sleep(Duration::from_millis(5)),
        )
        .await
        .unwrap();
        first.abort();
        assert!(first.await.unwrap_err().is_cancelled());
        assert_eq!(
            gate.available_permits(),
            0,
            "the running worker retains admission"
        );

        let second_started = Arc::new(AtomicBool::new(false));
        let observed = second_started.clone();
        let mut second = Box::pin(run_local_io_with_gate(gate.clone(), move || {
            observed.store(true, Ordering::SeqCst);
            Ok(7)
        }));
        assert!(futures_util::poll!(&mut second).is_pending());
        assert!(!second_started.load(Ordering::SeqCst));
        release.send(()).unwrap();
        assert_eq!(timeout(TEST_DEADLINE, second).await.unwrap().unwrap(), 7);
        assert_eq!(gate.available_permits(), 1);
    }

    #[tokio::test]
    async fn cancelled_admission_does_not_enqueue_detached_work() {
        let gate = Arc::new(Semaphore::new(1));
        let held = gate.clone().acquire_owned().await.unwrap();
        let called = Arc::new(AtomicBool::new(false));
        let observed = called.clone();
        let mut pending = Box::pin(run_local_io_with_gate(gate.clone(), move || {
            observed.store(true, Ordering::SeqCst);
            Ok(())
        }));
        assert!(futures_util::poll!(&mut pending).is_pending());
        drop(pending);
        drop(held);
        run_local_io_with_gate(gate, || Ok(())).await.unwrap();
        assert!(!called.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn concurrent_local_operations_respect_worker_capacity() {
        let gate = Arc::new(Semaphore::new(2));
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let (started, mut started_rx) = tokio::sync::mpsc::unbounded_channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        let release_rx = Arc::new(std::sync::Mutex::new(release_rx));
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..6 {
            let active = active.clone();
            let peak = peak.clone();
            let started = started.clone();
            let release_rx = release_rx.clone();
            tasks.spawn(run_local_io_with_gate(gate.clone(), move || {
                let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(current, Ordering::SeqCst);
                let _ = started.send(());
                let released = release_rx.lock().unwrap().recv_timeout(TEST_DEADLINE);
                active.fetch_sub(1, Ordering::SeqCst);
                released.map_err(|error| anyhow!("fixture release failed: {error}"))?;
                Ok(())
            }));
        }
        for _ in 0..2 {
            timeout(TEST_DEADLINE, started_rx.recv())
                .await
                .unwrap()
                .unwrap();
        }
        assert_eq!(gate.available_permits(), 0);
        assert_eq!(active.load(Ordering::SeqCst), 2);
        for _ in 0..6 {
            release.send(()).unwrap();
        }
        timeout(TEST_DEADLINE, async {
            while let Some(result) = tasks.join_next().await {
                result.unwrap().unwrap();
            }
        })
        .await
        .unwrap();
        assert_eq!(peak.load(Ordering::SeqCst), 2);
        assert_eq!(gate.available_permits(), 2);
    }

    #[tokio::test]
    async fn worker_panic_reports_failure_and_releases_admission() {
        let gate = Arc::new(Semaphore::new(1));
        let result = run_local_io_with_gate(gate.clone(), || -> Result<()> {
            panic!("fixture worker panic")
        })
        .await;
        assert!(result
            .unwrap_err()
            .to_string()
            .starts_with("Local filesystem worker failed:"));
        assert_eq!(gate.available_permits(), 1);
        assert_eq!(run_local_io_with_gate(gate, || Ok(42)).await.unwrap(), 42);
    }

    #[tokio::test]
    async fn local_worker_crud_preserves_existing_operations_and_errors() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let fs = FileSystem::new();
        let nested = root.join("source").join("nested");
        let source = nested.join("source.txt");
        fs.create_dir("local", nested.to_str().unwrap())
            .await
            .unwrap();
        fs.create_file("local", source.to_str().unwrap())
            .await
            .unwrap();
        fs.write_file("local", source.to_str().unwrap(), "abcd")
            .await
            .unwrap();
        assert!(fs
            .create_file("local", source.to_str().unwrap())
            .await
            .is_err());
        assert_eq!(
            fs.read_file("local", source.to_str().unwrap())
                .await
                .unwrap(),
            "abcd"
        );
        assert_eq!(
            fs.read_local_limited_async(source.to_str().unwrap(), 4)
                .await
                .unwrap(),
            "abcd"
        );
        assert!(fs
            .read_local_limited_async(source.to_str().unwrap(), 3)
            .await
            .unwrap_err()
            .to_string()
            .starts_with("FILE_TOO_LARGE:"));
        let renamed = nested.join("renamed.txt");
        fs.rename("local", source.to_str().unwrap(), renamed.to_str().unwrap())
            .await
            .unwrap();
        assert!(!fs.exists("local", source.to_str().unwrap()).await.unwrap());
        assert!(fs.exists("local", renamed.to_str().unwrap()).await.unwrap());
        let file_copy = root.join("file-copy.txt");
        fs.copy(
            "local",
            renamed.to_str().unwrap(),
            file_copy.to_str().unwrap(),
        )
        .await
        .unwrap();
        let tree_copy = root.join("tree-copy");
        fs.copy(
            "local",
            root.join("source").to_str().unwrap(),
            tree_copy.to_str().unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::read(tree_copy.join("nested/renamed.txt")).unwrap(),
            b"abcd"
        );
        fs.delete("local", file_copy.to_str().unwrap())
            .await
            .unwrap();
        fs.delete("local", tree_copy.to_str().unwrap())
            .await
            .unwrap();
        assert!(!file_copy.exists());
        assert!(!tree_copy.exists());
        assert!(fs
            .delete("local", file_copy.to_str().unwrap())
            .await
            .unwrap_err()
            .to_string()
            .starts_with("Failed to read metadata:"));
        assert!(fs
            .write_file("remote", source.to_str().unwrap(), "untouched")
            .await
            .unwrap_err()
            .to_string()
            .contains("Remote connection not yet implemented"));
        assert_eq!(std::fs::read(renamed).unwrap(), b"abcd");
    }

    #[tokio::test]
    async fn lightweight_listings_keep_names_kinds_and_order_without_full_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        std::fs::create_dir(root.join("z-directory")).unwrap();
        std::fs::write(root.join("a-file"), b"\xffdata").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("a-file"), root.join("m-link")).unwrap();
        let fs = FileSystem::new();
        let full = fs.list_local_async(root.to_str().unwrap()).await.unwrap();
        let names = fs
            .list_local_names_async(root.to_str().unwrap())
            .await
            .unwrap();
        let expected: Vec<_> = full
            .iter()
            .map(|entry| (&entry.name, &entry.path, &entry.r#type))
            .collect();
        let actual: Vec<_> = names
            .iter()
            .map(|entry| (&entry.name, &entry.path, &entry.r#type))
            .collect();
        assert_eq!(actual, expected);
        assert_eq!(names.last().unwrap().name, "a-file");
        for entry in names {
            assert_eq!((entry.size, entry.last_modified), (0, 0));
            assert!(
                entry.owner.is_empty() && entry.group.is_empty() && entry.permissions.is_empty()
            );
        }
        assert_eq!(
            fs.read_file("local", root.join("a-file").to_str().unwrap())
                .await
                .unwrap(),
            "\u{fffd}data"
        );
        let legacy = fs.list_dir("local", root.to_str().unwrap()).await.unwrap();
        assert_eq!(legacy.len(), full.len());
        let missing = root.join("missing");
        assert!(fs
            .list_local_async(missing.to_str().unwrap())
            .await
            .unwrap_err()
            .to_string()
            .starts_with("Failed to read directory:"));
    }

    #[test]
    fn remote_directory_routing_requires_exact_directory_kind() {
        use russh_sftp::protocol::FileAttributes;
        for (mode, expected) in [
            (Some(0o040755), true),
            (Some(0o100644), false),
            (Some(0o120777), false),
            (Some(0o060600), false),
            (Some(0o140600), false),
            (Some(0o020600), false),
            (Some(0o010600), false),
            (None, false),
        ] {
            let mut attributes = FileAttributes::default();
            attributes.permissions = mode;
            assert_eq!(
                remote_entry_is_directory(&attributes),
                expected,
                "mode {mode:?}"
            );
        }
    }

    #[test]
    fn parse_unix_name_map_reads_passwd_lines() {
        let map = parse_unix_name_map(
            "root:x:0:0:root:/root:/bin/bash\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n",
        );
        assert_eq!(map.get(&0).map(String::as_str), Some("root"));
        assert_eq!(map.get(&65534).map(String::as_str), Some("nobody"));
    }

    #[test]
    fn identity_label_prefers_name_then_map_then_id() {
        let mut map = HashMap::new();
        map.insert(1000, "gajen".to_string());
        assert_eq!(identity_label(Some("alice"), Some(1), &map), "alice");
        assert_eq!(identity_label(None, Some(1000), &map), "gajen");
        assert_eq!(identity_label(None, Some(42), &map), "42");
        assert_eq!(identity_label(None, None, &map), "");
    }

    #[test]
    fn limited_text_accepts_boundary_and_rejects_growth() {
        assert_eq!(limited_text(b"abcd".to_vec(), 4).unwrap(), "abcd");
        assert!(limited_text(b"abcde".to_vec(), 4)
            .unwrap_err()
            .to_string()
            .starts_with("FILE_TOO_LARGE:"));
    }

    #[test]
    fn local_editor_read_checks_current_file_size() {
        let path = std::env::temp_dir().join(format!("zync-editor-read-{}", uuid::Uuid::new_v4()));
        let result = (|| {
            fs::write(&path, b"abcd")?;
            let reader = FileSystem::new();
            assert_eq!(
                reader.read_local_limited(path.to_str().unwrap(), 4)?,
                "abcd"
            );
            fs::write(&path, b"abcde")?;
            assert!(reader
                .read_local_limited(path.to_str().unwrap(), 4)
                .unwrap_err()
                .to_string()
                .starts_with("FILE_TOO_LARGE:"));
            Ok::<(), anyhow::Error>(())
        })();
        let _ = fs::remove_file(&path);
        result.unwrap();
    }
}
