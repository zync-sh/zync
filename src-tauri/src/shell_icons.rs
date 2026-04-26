use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::RwLock;
use base64::Engine as _;

/// In-memory icon cache shared across the app session.
/// Key: distro name lowercased. Value: `Some("png:{b64}")` / `Some("ico:{b64}")` / `None` (no icon found).
/// Populated from disk on first use; new distros are appended and re-saved automatically.
pub type IconCache = Arc<RwLock<HashMap<String, Option<String>>>>;

pub fn new_cache() -> IconCache {
    Arc::new(RwLock::new(HashMap::new()))
}

/// Prefetch icons for ALL installed WSL distros.
///
/// Flow on first call (cold memory cache):
///   1. Load disk cache → populate memory cache (no file I/O for known distros)
///   2. Read Lxss registry once → find distros not yet in cache (new installs)
///   3. Resolve shortcut.ico concurrently for new distros only
///   4. Write new entries to memory cache + save full cache to disk (fire-and-forget)
///
/// Subsequent calls (warm memory cache):
///   - Registry read to detect new distros, skip everything else if none found.
#[cfg(target_os = "windows")]
pub async fn prefetch_all_wsl_icons(cache: &IconCache, cache_path: &Path) {
    // Step 1: load disk cache into memory on first call.
    // Keep write lock held across initial load to avoid concurrent duplicate loads.
    {
        let mut guard = cache.write().await;
        if guard.is_empty() {
            let path = cache_path.to_path_buf();
            let disk = tokio::task::spawn_blocking(move || load_disk_cache(&path))
                .await
                .unwrap_or_default();
            if !disk.is_empty() {
                guard.extend(disk);
            }
        }
    }

    // Step 2: read registry once to discover all current distros.
    let entries = tokio::task::spawn_blocking(read_all_lxss_entries)
        .await
        .unwrap_or_default();

    if entries.is_empty() {
        return;
    }

    // Step 3: find distros not yet in memory cache (new since last save).
    let uncached: Vec<(String, String)> = {
        let guard = cache.read().await;
        entries
            .into_iter()
            .filter(|(key, _)| !guard.contains_key(key))
            .collect()
    };

    if uncached.is_empty() {
        return;
    }

    // Step 4: resolve icons for new distros concurrently.
    const MAX_CONCURRENT_ICON_READS: usize = 8;
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_ICON_READS));
    let tasks: Vec<_> = uncached
        .iter()
        .map(|(_, base_path)| {
            let path = base_path.clone();
            let semaphore = semaphore.clone();
            tokio::spawn(async move {
                let _permit = semaphore.acquire_owned().await.ok()?;
                tokio::task::spawn_blocking(move || read_icon_from_base_path(&path))
                    .await
                    .ok()
                    .flatten()
            })
        })
        .collect();

    let mut results = Vec::with_capacity(tasks.len());
    for task in tasks {
        results.push(task.await.ok().flatten());
    }

    // Step 5: write new entries to memory cache.
    {
        let mut guard = cache.write().await;
        for ((key, _), icon) in uncached.into_iter().zip(results) {
            guard.insert(key, icon);
        }
    }

    // Step 6: persist full cache to disk.
    let snapshot: HashMap<String, Option<String>> = cache.read().await.clone();
    let path = cache_path.to_path_buf();
    let persist_handle = tokio::task::spawn_blocking(move || save_disk_cache(&path, &snapshot));
    match tokio::time::timeout(std::time::Duration::from_secs(3), persist_handle).await {
        Ok(Ok(Ok(()))) => {}
        Ok(Ok(Err(err))) => log::debug!("[ShellIcons] Failed to persist shell icon cache: {}", err),
        Ok(Err(err)) => log::debug!("[ShellIcons] Cache persist task join failure: {}", err),
        Err(_) => log::debug!("[ShellIcons] Timed out persisting shell icon cache"),
    }
}

// ──────────────────────────────────────────────────────────
// Disk cache helpers
// ──────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn load_disk_cache(path: &Path) -> HashMap<String, Option<String>> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => return HashMap::new(),
    };
    match serde_json::from_slice(&bytes) {
        Ok(cache) => cache,
        Err(error) => {
            eprintln!(
                "[ShellIcons] Failed to deserialize disk cache at {}: {}",
                path.display(),
                error
            );
            HashMap::new()
        }
    }
}

#[cfg(target_os = "windows")]
fn save_disk_cache(path: &Path, data: &HashMap<String, Option<String>>) -> std::io::Result<()> {
    use std::io::Write;

    let json = serde_json::to_vec_pretty(data)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or("shell-icon-cache.json");
    let tmp_path = parent.join(format!("{}.tmp", file_name));
    let backup_path = parent.join(format!("{}.bak", file_name));

    let mut tmp = std::fs::File::create(&tmp_path)?;
    tmp.write_all(&json)?;
    tmp.flush()?;
    tmp.sync_all()?;
    drop(tmp);

    match std::fs::rename(&tmp_path, path) {
        Ok(()) => Ok(()),
        Err(rename_err) => {
            if path.exists() {
                if backup_path.exists() {
                    let _ = std::fs::remove_file(&backup_path);
                }

                match std::fs::rename(path, &backup_path) {
                    Ok(()) => {}
                    Err(err) => {
                        let _ = std::fs::remove_file(&tmp_path);
                        return Err(err);
                    }
                }

                match std::fs::rename(&tmp_path, path) {
                    Ok(()) => {
                        let _ = std::fs::remove_file(&backup_path);
                        Ok(())
                    }
                    Err(err) => {
                        let restore_result = std::fs::rename(&backup_path, path);
                        let _ = std::fs::remove_file(&tmp_path);
                        match restore_result {
                            Ok(()) => Err(err),
                            Err(restore_err) => Err(std::io::Error::new(
                                restore_err.kind(),
                                format!(
                                    "Failed to replace cache file ({}) and failed to restore backup ({})",
                                    err, restore_err
                                ),
                            )),
                        }
                    }
                }
            } else {
                let _ = std::fs::remove_file(&tmp_path);
                Err(rename_err)
            }
        }
    }
}

// ──────────────────────────────────────────────────────────
// Windows implementations
// ──────────────────────────────────────────────────────────

/// Read every entry under HKCU\Lxss and return { distro_name_lower → BasePath }.
/// Handles distros installed to custom locations — the registry always has the real path.
#[cfg(target_os = "windows")]
fn read_all_lxss_entries() -> HashMap<String, String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};

    let mut map = HashMap::new();
    let lxss = match RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Lxss")
    {
        Ok(k) => k,
        Err(_) => return map,
    };

    for key_name in lxss.enum_keys().filter_map(|k| k.ok()) {
        let subkey = match lxss.open_subkey(&key_name) {
            Ok(k) => k,
            Err(_) => continue,
        };
        let name: String = subkey.get_value("DistributionName").unwrap_or_default();
        let base_path: String = subkey.get_value("BasePath").unwrap_or_default();
        let name_lower = name.to_lowercase();
        if !name.is_empty() && !base_path.is_empty() && !name_lower.starts_with("docker-") {
            log::debug!("[ShellIcons] Lxss '{}' → '{}'", name, base_path);
            map.insert(name_lower, base_path);
        }
    }

    map
}

/// Read `shortcut.ico` from `base_path` and return a tagged base64 string.
/// Returns `None` for any failure: missing path, missing file, I/O error.
/// Returns `"png:{base64}"` when a PNG frame is found, `"ico:{base64}"` for BMP-only ICOs.
#[cfg(target_os = "windows")]
fn read_icon_from_base_path(base_path: &str) -> Option<String> {
    if base_path.is_empty() {
        return None;
    }

    // Strip Windows extended-path prefix (\\?\ or \\?/).
    let clean = base_path
        .trim_start_matches(r"\\?\")
        .trim_start_matches(r"\\?/");

    let dir = Path::new(clean);
    if !dir.exists() {
        log::debug!("[ShellIcons] BasePath not found: '{}'", clean);
        return None;
    }

    let ico_path = dir.join("shortcut.ico");
    let bytes = match std::fs::read(&ico_path) {
        Ok(b) => b,
        Err(e) => {
            log::debug!("[ShellIcons] shortcut.ico not readable at '{}': {}", ico_path.display(), e);
            return None;
        }
    };

    // Prefer an embedded PNG frame (modern ICOs); fall back to raw ICO bytes.
    if let Some(png) = extract_png_from_ico(&bytes) {
        log::debug!("[ShellIcons] extracted {} byte PNG from '{}'", png.len(), ico_path.display());
        Some(format!("png:{}", base64::engine::general_purpose::STANDARD.encode(&png)))
    } else {
        log::debug!("[ShellIcons] BMP-only ICO at '{}', serving raw ICO", ico_path.display());
        Some(format!("ico:{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
    }
}

/// Parse an ICO file and return the raw bytes of the largest embedded PNG frame.
/// Returns `None` for BMP-only ICOs.
#[cfg(target_os = "windows")]
fn extract_png_from_ico(ico: &[u8]) -> Option<Vec<u8>> {
    if ico.len() < 6 {
        return None;
    }

    let count = u16::from_le_bytes([ico[4], ico[5]]) as usize;
    let mut best: Option<Vec<u8>> = None;
    let mut best_area: u32 = 0;

    for i in 0..count {
        let base = 6 + i * 16;
        if base + 16 > ico.len() {
            break;
        }
        let w = if ico[base] == 0 { 256u32 } else { ico[base] as u32 };
        let h = if ico[base + 1] == 0 { 256u32 } else { ico[base + 1] as u32 };
        let size = match ico.get(base + 8..base + 12).and_then(|bytes| bytes.try_into().ok()) {
            Some(raw) => u32::from_le_bytes(raw) as usize,
            None => continue,
        };
        let offset = match ico.get(base + 12..base + 16).and_then(|bytes| bytes.try_into().ok()) {
            Some(raw) => u32::from_le_bytes(raw) as usize,
            None => continue,
        };

        if offset.saturating_add(size) > ico.len() {
            continue;
        }
        let frame = &ico[offset..offset + size];
        if frame.starts_with(b"\x89PNG\r\n\x1a\n") && w * h > best_area {
            best_area = w * h;
            best = Some(frame.to_vec());
        }
    }

    best
}

// ──────────────────────────────────────────────────────────
// Non-Windows stub
// ──────────────────────────────────────────────────────────

#[cfg(not(target_os = "windows"))]
pub async fn prefetch_all_wsl_icons(_cache: &IconCache, _cache_path: &Path) {}
