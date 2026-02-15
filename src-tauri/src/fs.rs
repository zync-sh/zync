use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::time::UNIX_EPOCH;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub r#type: String, // "d" for directory, "-" for file
    pub size: u64,
    pub last_modified: u64,
    pub permissions: String,
}

pub struct FileSystem;

impl FileSystem {
    pub fn new() -> Self {
        Self
    }

    #[allow(dead_code)]
    pub async fn list_dir(&self, connection_id: &str, path: &str) -> Result<Vec<FileEntry>> {
        // Deprecated: logic moved to commands.rs for proper dispatch
        if connection_id == "local" {
            self.list_local(path)
        } else {
            Err(anyhow!("Remote connection not handled in list_dir, use list_remote"))
        }
    }

    pub fn list_local(&self, path: &str) -> Result<Vec<FileEntry>> {
        let path = if path.is_empty() {
             std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
        } else {
            path.to_string()
        };

        let dir = fs::read_dir(&path).map_err(|e| anyhow!("Failed to read directory: {}", e))?;
        let mut entries = Vec::new();

        for entry in dir {
            let entry = entry.map_err(|e| anyhow!("Failed to read entry: {}", e))?;
            let metadata = entry.metadata().map_err(|e| anyhow!("Failed to read metadata: {}", e))?;
            let file_name = entry.file_name().to_string_lossy().to_string();
            
            let file_type = if metadata.is_dir() { "d" } else { "-" }.to_string();
            let size = metadata.len();
            let last_modified = metadata
                .modified()?
                .duration_since(UNIX_EPOCH)?
                .as_millis() as u64;

            // Permissions handling
            #[cfg(unix)]
            let permissions = format!("{:o}", metadata.mode() & 0o777);

            #[cfg(windows)]
            let permissions = if metadata.permissions().readonly() {
                "444".to_string() 
            } else {
                "666".to_string()
            };

            entries.push(FileEntry {
                name: file_name,
                path: entry.path().to_string_lossy().to_string(),
                r#type: file_type,
                size,
                last_modified,
                permissions,
            });
        }

        // Sort directories first, then files
        entries.sort_by(|a, b| {
            if a.r#type == "d" && b.r#type != "d" {
                std::cmp::Ordering::Less
            } else if a.r#type != "d" && b.r#type == "d" {
                std::cmp::Ordering::Greater
            } else {
                a.name.cmp(&b.name)
            }
        });

        Ok(entries)
    }

    pub async fn list_remote(&self, sftp: &russh_sftp::client::SftpSession, path: &str) -> Result<Vec<FileEntry>> {
        let path = if path.is_empty() { "." } else { path }; // Default to current dir if empty, usually Home
        println!("[FS] SFTP listing: {}", path);

        let entries_iter = sftp.read_dir(path).await.map_err(|e| anyhow!("SFTP read_dir failed: {}", e))?;
        let entries: Vec<_> = entries_iter.collect();
        println!("[FS] SFTP read_dir returned {} entries", entries.len());
        let mut result = Vec::new();

        for entry in entries {
            let name = entry.file_name();
            // println!("[FS] Entry: {}", name); // Optional verbose log
            // Skip . and ..
             if name == "." || name == ".." { continue; }

            let attrs = entry.metadata();
            let size = attrs.size.unwrap_or(0);
            let mtime = attrs.mtime.unwrap_or(0) as u64 * 1000; // ms
            let perms = attrs.permissions.unwrap_or(0);
            
            // Check for directory bit (0o040000)
            let is_dir = (perms & 0o040000) != 0;
            
            let type_str = if is_dir { "d" } else { "-" };
            
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
            });
        }
        
        // Sort
        result.sort_by(|a, b| {
             if a.r#type == "d" && b.r#type != "d" {
                 std::cmp::Ordering::Less
             } else if a.r#type != "d" && b.r#type == "d" {
                 std::cmp::Ordering::Greater
             } else {
                 a.name.cmp(&b.name)
             }
        });

        Ok(result)
    }

    pub fn get_home_dir(&self, connection_id: &str) -> Result<String> {
        if connection_id == "local" {
            Ok(std::env::var("HOME").unwrap_or_else(|_| "/".to_string()))
        } else {
            Err(anyhow!("Remote connection not yet implemented"))
        }
    }

    pub async fn read_file(&self, _connection_id: &str, path: &str) -> Result<String> {
        let content = fs::read(path).map_err(|e| anyhow!("Failed to read file: {}", e))?;
        Ok(String::from_utf8_lossy(&content).to_string())
    }

    pub async fn write_file(&self, connection_id: &str, path: &str, content: &str) -> Result<()> {
         if connection_id == "local" {
            fs::write(path, content).map_err(|e| anyhow!("Failed to write file: {}", e))
        } else {
             Err(anyhow!("Remote connection not yet implemented"))
        }
    }
    pub async fn create_dir(&self, connection_id: &str, path: &str) -> Result<()> {
        if connection_id == "local" {
            fs::create_dir_all(path).map_err(|e| anyhow!("Failed to create directory: {}", e))
        } else {
             Err(anyhow!("Remote connection not yet implemented"))
        }
    }

    pub async fn rename(&self, connection_id: &str, old_path: &str, new_path: &str) -> Result<()> {
        if connection_id == "local" {
            fs::rename(old_path, new_path).map_err(|e| anyhow!("Failed to rename: {}", e))
        } else {
             Err(anyhow!("Remote connection not yet implemented"))
        }
    }

    pub async fn delete(&self, connection_id: &str, path: &str) -> Result<()> {
        if connection_id == "local" {
            let metadata = fs::metadata(path).map_err(|e| anyhow!("Failed to read metadata: {}", e))?;
            if metadata.is_dir() {
                fs::remove_dir_all(path).map_err(|e| anyhow!("Failed to delete directory: {}", e))
            } else {
                fs::remove_file(path).map_err(|e| anyhow!("Failed to delete file: {}", e))
            }
        } else {
             Err(anyhow!("Remote connection not yet implemented"))
        }
    }

    pub async fn copy(&self, connection_id: &str, from: &str, to: &str) -> Result<()> {
        if connection_id == "local" {
            let metadata = fs::metadata(from).map_err(|e| anyhow!("Source not found: {}", e))?;
            if metadata.is_dir() {
                Self::copy_dir_recursive(from, to)
            } else {
                fs::copy(from, to).map_err(|e| anyhow!("Failed to copy file: {}", e))?;
                Ok(())
            }
        } else {
             Err(anyhow!("Remote connection not yet implemented"))
        }
    }

    pub async fn exists(&self, connection_id: &str, path: &str) -> Result<bool> {
        if connection_id == "local" {
            Ok(std::path::Path::new(path).exists())
        } else {
             // TODO: Remote check
             Err(anyhow!("Remote connection not yet implemented"))
        }
    }

    // --- Remote Operations ---

    pub async fn read_remote(&self, sftp: &russh_sftp::client::SftpSession, path: &str) -> Result<String> {
        let content = sftp.read(path).await.map_err(|e| anyhow!("Failed to read remote file: {}", e))?;
        Ok(String::from_utf8_lossy(&content).to_string())
    }

    pub async fn write_remote(&self, sftp: &russh_sftp::client::SftpSession, path: &str, content: &[u8]) -> Result<()> {
        use russh_sftp::protocol::OpenFlags;
        let mut file = sftp.open_with_flags(path, OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE)
            .await.map_err(|e| anyhow!("Failed to open file for writing '{}': {}", path, e))?;
        
        use tokio::io::AsyncWriteExt;
        file.write_all(content).await.map_err(|e| anyhow!("Failed to write content to '{}': {}", path, e))?;
        Ok(())
    }

    pub async fn create_dir_remote(&self, sftp: &russh_sftp::client::SftpSession, path: &str) -> Result<()> {
        sftp.create_dir(path).await.map_err(|e| anyhow!("Failed to create remote directory '{}': {}", path, e))
    }

    pub async fn rename_remote(&self, sftp: &russh_sftp::client::SftpSession, old_path: &str, new_path: &str) -> Result<()> {
        sftp.rename(old_path, new_path).await.map_err(|e| anyhow!("Failed to rename remote file: {}", e))
    }

    pub async fn delete_remote(&self, sftp: &russh_sftp::client::SftpSession, path: &str) -> Result<()> {
        let metadata = sftp.metadata(path).await.map_err(|e| anyhow!("Failed to stat file: {}", e))?;
        if metadata.is_dir() {
            self.delete_dir_recursive_remote(sftp, path).await
        } else {
            sftp.remove_file(path).await.map_err(|e| anyhow!("Failed to remove file: {}", e))
        }
    }

    fn delete_dir_recursive_remote<'a>(&'a self, sftp: &'a russh_sftp::client::SftpSession, path: &'a str) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            let entries = sftp.read_dir(path).await.map_err(|e| anyhow!("Failed to list dir '{}': {}", path, e))?;
            
            for entry in entries {
                let name = entry.file_name();
                if name == "." || name == ".." { continue; }

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
                    sftp.remove_file(&full_path).await.map_err(|e| anyhow!("Failed to remove file '{}': {}", full_path, e))?;
                }
            }

            sftp.remove_dir(path).await.map_err(|e| anyhow!("Failed to remove dir '{}': {}", path, e))?;
            Ok(())
        })
    }

    pub async fn copy_remote(&self, sftp: &russh_sftp::client::SftpSession, from: &str, to: &str) -> Result<()> {
        let metadata = sftp.metadata(from).await.map_err(|e| anyhow!("Failed to stat source '{}': {}", from, e))?;
        
        if metadata.is_dir() {
            self.copy_dir_recursive_remote(sftp, from, to).await
        } else {
            self.copy_file_remote(sftp, from, to).await
        }
    }

    // Helper for streaming file copy
    async fn copy_file_remote(&self, sftp: &russh_sftp::client::SftpSession, from: &str, to: &str) -> Result<()> {
        use russh_sftp::protocol::OpenFlags;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        println!("[FS] Copying file from '{}' to '{}'", from, to);

        // Read
        let mut source = sftp.open_with_flags(from, OpenFlags::READ)
            .await.map_err(|e| anyhow!("Failed to open source '{}': {}", from, e))?;
        
        // Write
        let mut dest = sftp.open_with_flags(to, OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE)
            .await.map_err(|e| anyhow!("Failed to open dest '{}': {}", to, e))?;

        // Manual copy loop with 4MB buffer to maximize throughput on high-latency links
        let mut buffer = vec![0u8; 4194304]; 
        let mut total_bytes = 0;

        loop {
            let n = source.read(&mut buffer).await
                .map_err(|e| anyhow!("Read error at {} bytes: {}", total_bytes, e))?;
            
            if n == 0 {
                break;
            }

            dest.write_all(&buffer[..n]).await
                .map_err(|e| anyhow!("Write error at {} bytes: {}", total_bytes, e))?;
            
            total_bytes += n;
        }

        dest.flush().await.map_err(|e| anyhow!("Flush error: {}", e))?;
        
        println!("[FS] Copied {} bytes", total_bytes);
        Ok(())
    }

    // Helper for recursive dir copy - Manually boxed for recursion
    fn copy_dir_recursive_remote<'a>(&'a self, sftp: &'a russh_sftp::client::SftpSession, from: &'a str, to: &'a str) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            println!("[FS] Copying directory from '{}' to '{}'", from, to);

            // Create dest dir
            // Ignore error if it already exists (could be merging)
            let _ = sftp.create_dir(to).await;
    
            // List source
            let entries = sftp.read_dir(from).await.map_err(|e| anyhow!("Failed to list source dir '{}': {}", from, e))?;
    
            for entry in entries {
                let file_name = entry.file_name();
                if file_name == "." || file_name == ".." { continue; }
                
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
                     self.copy_dir_recursive_remote(sftp, &source_path, &dest_path).await?;
                 } else {
                     // If it is a symlink, treated as file (might fail read if dangling, or copy content if valid)
                     // Ideally we should recreate the symlink, but copying content (dereference) is safer than infinite recursion.
                     // Or better: Just SKIP symlinks for now or try copy. If it's a symlink to dir, we don't recurse.
                     self.copy_file_remote(sftp, &source_path, &dest_path).await?;
                 }
            }
    
            Ok(())
        })
    }

    pub async fn exists_remote(&self, sftp: &russh_sftp::client::SftpSession, path: &str) -> Result<bool> {
        sftp.try_exists(path).await.map_err(|e| anyhow!("Failed to check existence: {}", e))
    }

    fn copy_dir_recursive(from: &str, to: &str) -> Result<()> {
        fs::create_dir_all(to).map_err(|e| anyhow!("Failed to create destination dir: {}", e))?;
        for entry in fs::read_dir(from).map_err(|e| anyhow!("Failed to read source dir: {}", e))? {
            let entry = entry.map_err(|e| anyhow!("Failed to read entry: {}", e))?;
            let ft = entry.file_type().map_err(|e| anyhow!("Failed to read file type: {}", e))?;
            let dest_path = std::path::Path::new(to).join(entry.file_name());
            if ft.is_dir() {
                Self::copy_dir_recursive(&entry.path().to_string_lossy(), &dest_path.to_string_lossy())?;
            } else {
                fs::copy(entry.path(), dest_path).map_err(|e| anyhow!("Failed to copy file: {}", e))?;
            }
        }
        Ok(())
    }
}
