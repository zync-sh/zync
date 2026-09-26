use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const RECOVERY_VERSION: u32 = 1;
const MAX_FAILURES_PER_PLUGIN: usize = 8;
const MAX_PLUGIN_ID_CHARS: usize = 160;
const MAX_FAILURE_AGE_MS: u64 = 24 * 60 * 60 * 1_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedPluginFailure {
    at_ms: u64,
    kind: String,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryFile {
    version: u32,
    session_open: bool,
    safe_mode: bool,
    failures: BTreeMap<String, Vec<PersistedPluginFailure>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRecoveryDiagnostic {
    pub plugin_id: String,
    pub failures: Vec<PluginRecoveryFailure>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRecoveryFailure {
    pub at_ms: u64,
    pub kind: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRecoveryStatus {
    pub safe_mode: bool,
    pub diagnostics: Vec<PluginRecoveryDiagnostic>,
}

pub struct PluginRecoveryState {
    file: Mutex<RecoveryFile>,
    path: PathBuf,
}

impl PluginRecoveryState {
    pub fn load_and_begin(app: &AppHandle) -> Result<Self> {
        let path = recovery_path(app)?;
        let mut file = load_recovery_file(&path).unwrap_or_else(|error| {
            log::warn!("[Plugins] Recovery state was unreadable; starting in safe mode: {error}");
            RecoveryFile {
                version: RECOVERY_VERSION,
                safe_mode: true,
                ..RecoveryFile::default()
            }
        });
        file.safe_mode |= file.session_open;
        file.session_open = true;
        prune_failures(&mut file, now_ms());
        save_recovery_file(&path, &file)?;
        Ok(Self {
            file: Mutex::new(file),
            path,
        })
    }

    pub fn status(&self) -> Result<PluginRecoveryStatus> {
        let mut file = self
            .file
            .lock()
            .map_err(|_| anyhow!("Plugin recovery state is unavailable"))?;
        prune_failures(&mut file, now_ms());
        Ok(status_from_file(&file))
    }

    pub fn record_failure(&self, plugin_id: &str, kind: &str) -> Result<()> {
        validate_plugin_id(plugin_id)?;
        if !matches!(kind, "worker-error" | "heartbeat-timeout" | "start-failure") {
            return Err(anyhow!("Unknown plugin runtime failure kind"));
        }
        let mut file = self
            .file
            .lock()
            .map_err(|_| anyhow!("Plugin recovery state is unavailable"))?;
        let now = now_ms();
        prune_failures(&mut file, now);
        let failures = file.failures.entry(plugin_id.to_string()).or_default();
        failures.push(PersistedPluginFailure {
            at_ms: now,
            kind: kind.to_string(),
        });
        if failures.len() > MAX_FAILURES_PER_PLUGIN {
            failures.drain(0..failures.len() - MAX_FAILURES_PER_PLUGIN);
        }
        save_recovery_file(&self.path, &file)
    }

    pub fn clear_safe_mode(&self) -> Result<()> {
        let mut file = self
            .file
            .lock()
            .map_err(|_| anyhow!("Plugin recovery state is unavailable"))?;
        file.safe_mode = false;
        save_recovery_file(&self.path, &file)
    }

    pub fn clear_plugin_failures(&self, plugin_id: &str) -> Result<()> {
        validate_plugin_id(plugin_id)?;
        let mut file = self
            .file
            .lock()
            .map_err(|_| anyhow!("Plugin recovery state is unavailable"))?;
        file.failures.remove(plugin_id);
        save_recovery_file(&self.path, &file)
    }

    pub fn mark_clean_exit(&self) -> Result<()> {
        let mut file = self
            .file
            .lock()
            .map_err(|_| anyhow!("Plugin recovery state is unavailable"))?;
        file.session_open = false;
        save_recovery_file(&self.path, &file)
    }
}

fn recovery_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_config_dir()
        .context("Failed to resolve app config directory")?
        .join("plugin-runtime-recovery.json"))
}

fn load_recovery_file(path: &Path) -> Result<RecoveryFile> {
    if !path.exists() {
        return Ok(RecoveryFile {
            version: RECOVERY_VERSION,
            ..RecoveryFile::default()
        });
    }
    let bytes = fs::read(path).context("Failed to read plugin recovery state")?;
    let file: RecoveryFile =
        serde_json::from_slice(&bytes).context("Plugin recovery state is corrupt")?;
    if file.version != RECOVERY_VERSION {
        return Err(anyhow!("Unsupported plugin recovery state version"));
    }
    Ok(file)
}

fn save_recovery_file(path: &Path, file: &RecoveryFile) -> Result<()> {
    let bytes = serde_json::to_vec(file).context("Failed to serialize plugin recovery state")?;
    crate::atomic_io::durable_replace(path, &bytes).context("Failed to save plugin recovery state")
}

fn prune_failures(file: &mut RecoveryFile, now: u64) {
    let cutoff = now.saturating_sub(MAX_FAILURE_AGE_MS);
    file.failures.retain(|_, failures| {
        failures.retain(|failure| failure.at_ms >= cutoff);
        !failures.is_empty()
    });
}

fn status_from_file(file: &RecoveryFile) -> PluginRecoveryStatus {
    PluginRecoveryStatus {
        safe_mode: file.safe_mode,
        diagnostics: file
            .failures
            .iter()
            .map(|(plugin_id, failures)| PluginRecoveryDiagnostic {
                plugin_id: plugin_id.clone(),
                failures: failures
                    .iter()
                    .map(|failure| PluginRecoveryFailure {
                        at_ms: failure.at_ms,
                        kind: failure.kind.clone(),
                    })
                    .collect(),
            })
            .collect(),
    }
}

fn validate_plugin_id(plugin_id: &str) -> Result<()> {
    let chars = plugin_id.chars().count();
    if chars == 0 || chars > MAX_PLUGIN_ID_CHARS || plugin_id.chars().any(char::is_control) {
        return Err(anyhow!("Invalid plugin id"));
    }
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn previous_open_session_enables_safe_mode() {
        let file = RecoveryFile {
            version: RECOVERY_VERSION,
            session_open: true,
            safe_mode: false,
            failures: BTreeMap::new(),
        };
        let mut restarted = file;
        restarted.safe_mode |= restarted.session_open;
        assert!(restarted.safe_mode);
    }

    #[test]
    fn diagnostics_contain_only_plugin_id_time_and_kind() {
        let file = RecoveryFile {
            version: RECOVERY_VERSION,
            session_open: true,
            safe_mode: false,
            failures: BTreeMap::from([(
                "dev.example.counter".into(),
                vec![PersistedPluginFailure {
                    at_ms: 42,
                    kind: "worker-error".into(),
                }],
            )]),
        };
        let status = status_from_file(&file);
        assert_eq!(status.diagnostics[0].plugin_id, "dev.example.counter");
        assert_eq!(status.diagnostics[0].failures[0].at_ms, 42);
        assert_eq!(status.diagnostics[0].failures[0].kind, "worker-error");
    }

    #[test]
    fn pruning_drops_old_events_and_empty_plugins() {
        let mut file = RecoveryFile {
            version: RECOVERY_VERSION,
            session_open: true,
            safe_mode: false,
            failures: BTreeMap::from([
                (
                    "old".into(),
                    vec![PersistedPluginFailure {
                        at_ms: 1,
                        kind: "worker-error".into(),
                    }],
                ),
                (
                    "new".into(),
                    vec![PersistedPluginFailure {
                        at_ms: MAX_FAILURE_AGE_MS + 10,
                        kind: "heartbeat-timeout".into(),
                    }],
                ),
            ]),
        };
        prune_failures(&mut file, MAX_FAILURE_AGE_MS + 20);
        assert!(!file.failures.contains_key("old"));
        assert!(file.failures.contains_key("new"));
    }
}
