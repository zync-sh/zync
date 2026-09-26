use super::broker::PluginRuntimePrincipal;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const STORE_VERSION: u32 = 1;
const MAX_KEYS: usize = 256;
const MAX_KEY_CHARS: usize = 128;
const MAX_VALUE_BYTES: usize = 64 * 1024;
const MAX_STORE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginStorageUsage {
    pub bytes: u64,
    pub key_count: usize,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginDataStore {
    version: u32,
    entries: BTreeMap<String, String>,
}

pub struct PluginStorageState {
    // A single gate is deliberate for v1: stores are small and this prevents two plugin
    // writes from racing through read-modify-replace on the same process.
    write_gate: Mutex<()>,
}

impl PluginStorageState {
    pub fn new() -> Self {
        Self {
            write_gate: Mutex::new(()),
        }
    }

    pub fn get(
        &self,
        app: &AppHandle,
        principal: &PluginRuntimePrincipal,
        key: &str,
    ) -> Result<Option<String>> {
        validate_key(key)?;
        let store = load_store(&store_path(app, principal)?)?;
        Ok(store.entries.get(key).cloned())
    }

    pub fn keys(&self, app: &AppHandle, principal: &PluginRuntimePrincipal) -> Result<Vec<String>> {
        let store = load_store(&store_path(app, principal)?)?;
        Ok(store.entries.into_keys().collect())
    }

    pub fn set(
        &self,
        app: &AppHandle,
        principal: &PluginRuntimePrincipal,
        key: &str,
        value: &str,
    ) -> Result<()> {
        validate_key(key)?;
        if value.len() > MAX_VALUE_BYTES {
            return Err(anyhow!(
                "Plugin storage value exceeds the {MAX_VALUE_BYTES}-byte limit"
            ));
        }
        let _guard = self
            .write_gate
            .lock()
            .map_err(|_| anyhow!("Plugin storage is unavailable"))?;
        let path = store_path(app, principal)?;
        let mut store = load_store(&path)?;
        if !store.entries.contains_key(key) && store.entries.len() >= MAX_KEYS {
            return Err(anyhow!(
                "Plugin storage may contain at most {MAX_KEYS} keys"
            ));
        }
        store.entries.insert(key.to_string(), value.to_string());
        save_store(&path, &store)
    }

    pub fn delete(
        &self,
        app: &AppHandle,
        principal: &PluginRuntimePrincipal,
        key: &str,
    ) -> Result<bool> {
        validate_key(key)?;
        let _guard = self
            .write_gate
            .lock()
            .map_err(|_| anyhow!("Plugin storage is unavailable"))?;
        let path = store_path(app, principal)?;
        let mut store = load_store(&path)?;
        let removed = store.entries.remove(key).is_some();
        if removed {
            save_store(&path, &store)?;
        }
        Ok(removed)
    }

    pub fn usage(
        &self,
        app: &AppHandle,
        principal: &PluginRuntimePrincipal,
    ) -> Result<PluginStorageUsage> {
        let path = store_path(app, principal)?;
        usage_at_path(&path)
    }

    pub fn clear(&self, app: &AppHandle, principal: &PluginRuntimePrincipal) -> Result<bool> {
        let _guard = self
            .write_gate
            .lock()
            .map_err(|_| anyhow!("Plugin storage is unavailable"))?;
        let path = store_path(app, principal)?;
        clear_at_path(&path)
    }
}

fn usage_at_path(path: &Path) -> Result<PluginStorageUsage> {
    if !path.exists() {
        return Ok(PluginStorageUsage {
            bytes: 0,
            key_count: 0,
        });
    }
    let bytes = fs::metadata(path)
        .context("Failed to inspect plugin storage")?
        .len();
    let key_count = load_store(path)?.entries.len();
    Ok(PluginStorageUsage { bytes, key_count })
}

fn clear_at_path(path: &Path) -> Result<bool> {
    if !path.exists() {
        return Ok(false);
    }
    fs::remove_file(path).context("Failed to clear plugin storage")?;
    Ok(true)
}

fn store_path(app: &AppHandle, principal: &PluginRuntimePrincipal) -> Result<PathBuf> {
    let root = app
        .path()
        .app_config_dir()
        .context("Failed to resolve app config directory")?
        .join("plugin-data");
    Ok(namespace_path(&root, principal))
}

fn namespace_path(root: &Path, principal: &PluginRuntimePrincipal) -> PathBuf {
    root.join(&principal.publisher_id)
        .join(&principal.plugin_id)
        .join("storage.json")
}

fn validate_key(key: &str) -> Result<()> {
    let chars = key.chars().count();
    if chars == 0 || chars > MAX_KEY_CHARS || key.chars().any(char::is_control) {
        return Err(anyhow!("Invalid plugin storage key"));
    }
    Ok(())
}

fn load_store(path: &Path) -> Result<PluginDataStore> {
    if !path.exists() {
        return Ok(PluginDataStore {
            version: STORE_VERSION,
            entries: BTreeMap::new(),
        });
    }
    let metadata = fs::metadata(path).context("Failed to inspect plugin storage")?;
    if metadata.len() > MAX_STORE_BYTES as u64 {
        return Err(anyhow!("Plugin storage exceeds its quota"));
    }
    let bytes = fs::read(path).context("Failed to read plugin storage")?;
    let store: PluginDataStore =
        serde_json::from_slice(&bytes).context("Plugin storage is corrupt")?;
    if store.version != STORE_VERSION {
        return Err(anyhow!("Unsupported plugin storage version"));
    }
    if store.entries.len() > MAX_KEYS
        || store
            .entries
            .iter()
            .any(|(key, value)| validate_key(key).is_err() || value.len() > MAX_VALUE_BYTES)
    {
        return Err(anyhow!("Plugin storage violates its quota"));
    }
    Ok(store)
}

fn save_store(path: &Path, store: &PluginDataStore) -> Result<()> {
    let bytes = serde_json::to_vec(store).context("Failed to serialize plugin storage")?;
    if bytes.len() > MAX_STORE_BYTES {
        return Err(anyhow!("Plugin storage exceeds its quota"));
    }
    crate::atomic_io::durable_replace(path, &bytes).context("Failed to save plugin storage")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn principal() -> PluginRuntimePrincipal {
        PluginRuntimePrincipal {
            plugin_id: "dev.example.counter".into(),
            publisher_id: "dev.example".into(),
        }
    }

    #[test]
    fn namespace_is_owned_by_publisher_and_plugin() {
        assert_eq!(
            namespace_path(Path::new("root"), &principal()),
            Path::new("root")
                .join("dev.example")
                .join("dev.example.counter")
                .join("storage.json")
        );
    }

    #[test]
    fn store_round_trips_and_keeps_keys_sorted() {
        let root =
            std::env::temp_dir().join(format!("zync-plugin-storage-{}", uuid::Uuid::new_v4()));
        let path = namespace_path(&root, &principal());
        let store = PluginDataStore {
            version: STORE_VERSION,
            entries: BTreeMap::from([
                ("z-last".into(), "2".into()),
                ("a-first".into(), "1".into()),
            ]),
        };
        save_store(&path, &store).expect("save store");
        let restored = load_store(&path).expect("load store");
        assert_eq!(
            restored.entries.into_keys().collect::<Vec<_>>(),
            vec!["a-first", "z-last"]
        );
        fs::remove_dir_all(root).expect("remove test storage");
    }

    #[test]
    fn rejects_invalid_keys_and_oversized_values() {
        assert!(validate_key("").is_err());
        assert!(validate_key("line\nbreak").is_err());
        assert!(validate_key(&"x".repeat(MAX_KEY_CHARS + 1)).is_err());
        assert!(validate_key("pane.current-folder").is_ok());

        let root = std::env::temp_dir().join(format!(
            "zync-plugin-storage-quota-{}",
            uuid::Uuid::new_v4()
        ));
        let path = namespace_path(&root, &principal());
        let oversized = PluginDataStore {
            version: STORE_VERSION,
            entries: BTreeMap::from([("too-large".into(), "x".repeat(MAX_STORE_BYTES))]),
        };
        assert!(save_store(&path, &oversized).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn usage_and_clear_report_only_the_target_store() {
        let root = std::env::temp_dir().join(format!(
            "zync-plugin-storage-management-{}",
            uuid::Uuid::new_v4()
        ));
        let path = namespace_path(&root, &principal());
        save_store(
            &path,
            &PluginDataStore {
                version: STORE_VERSION,
                entries: BTreeMap::from([("one".into(), "value".into())]),
            },
        )
        .expect("save managed store");

        let usage = usage_at_path(&path).expect("inspect managed store");
        assert_eq!(usage.key_count, 1);
        assert!(usage.bytes > 0);
        assert!(clear_at_path(&path).expect("clear managed store"));
        assert!(!clear_at_path(&path).expect("clear missing store"));
        assert_eq!(
            usage_at_path(&path).expect("inspect empty store").key_count,
            0
        );
        let _ = fs::remove_dir_all(root);
    }
}
