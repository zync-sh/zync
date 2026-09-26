use super::grants::{self, PluginGrant};
use super::install::sanitize_plugin_dir_name;
use super::package::{
    activate_staged_package, begin_staged_package_activation, copy_directory, digest_directory,
    read_manifest_file,
};
use super::Manifest;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetainedPluginVersion {
    plugin_id: String,
    version: String,
    package_digest: String,
    retained_at_ms: u64,
    approval: Option<PluginGrant>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRollbackInfo {
    pub version: String,
    pub package_digest: String,
    pub retained_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRollbackResult {
    pub plugin_id: String,
    pub restored_version: String,
    pub replaced_version: String,
}

pub fn retain(
    app: &AppHandle,
    plugin_id: &str,
    version: &str,
    package_digest: &str,
    package: &Path,
    approval: Option<PluginGrant>,
) -> Result<()> {
    if digest_directory(package)? != package_digest {
        return Err(anyhow!(
            "Plugin rollback package changed before it was retained"
        ));
    }

    let staged = rollback_staging_path(app, plugin_id)?;
    fs::create_dir_all(&staged)?;
    let staged_package = staged.join("package");
    if let Err(error) = fs::rename(package, &staged_package) {
        let _ = fs::remove_dir_all(&staged);
        return Err(error).context("Failed to stage the plugin rollback copy");
    }

    let record = RetainedPluginVersion {
        plugin_id: plugin_id.to_string(),
        version: version.to_string(),
        package_digest: package_digest.to_string(),
        retained_at_ms: now_ms(),
        approval,
    };
    if let Err(error) = write_record(&staged.join("record.json"), &record) {
        let _ = fs::rename(&staged_package, package);
        let _ = fs::remove_dir_all(&staged);
        return Err(error);
    }

    let target = rollback_path(app, plugin_id)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    if let Err(error) = activate_staged_package(&target, &staged) {
        let _ = fs::rename(staged_package, package);
        let _ = fs::remove_dir_all(staged);
        return Err(error).context("Failed to retain the previous plugin version");
    }
    Ok(())
}

pub fn info(app: &AppHandle, plugin_id: &str) -> Result<Option<PluginRollbackInfo>> {
    let path = rollback_path(app, plugin_id)?;
    if !path.is_dir() {
        return Ok(None);
    }
    let record = read_validated_record(&path, plugin_id)?;
    Ok(Some(PluginRollbackInfo {
        version: record.version,
        package_digest: record.package_digest,
        retained_at_ms: record.retained_at_ms,
    }))
}

pub fn rollback(app: &AppHandle, plugin_id: &str) -> Result<PluginRollbackResult> {
    let retained_path = rollback_path(app, plugin_id)?;
    let retained = read_validated_record(&retained_path, plugin_id)?;
    let retained_package = retained_path.join("package");
    let retained_manifest: Manifest = serde_json::from_str(&read_manifest_file(
        &retained_package.join("manifest.json"),
    )?)
    .context("Retained plugin manifest is invalid")?;
    retained_manifest
        .validate()
        .context("Retained plugin manifest is invalid")?;
    retained_manifest.validate_host_compatibility()?;

    let target = installed_path(app, plugin_id)?;
    let active_manifest: Manifest =
        serde_json::from_str(&read_manifest_file(&target.join("manifest.json"))?)
            .context("Installed plugin manifest is invalid")?;
    if active_manifest.id != plugin_id {
        return Err(anyhow!(
            "Installed plugin identity does not match its directory"
        ));
    }
    let active_digest = digest_directory(&target)?;
    let active_approval = grants::snapshot_approval(app, plugin_id)?;

    let staged = rollback_staging_path(app, plugin_id)?;
    copy_directory(&retained_package, &staged)?;
    let active_backup = rollback_swap_path(app)?;
    if let Some(parent) = active_backup.parent() {
        fs::create_dir_all(parent)?;
    }
    let activation = match begin_staged_package_activation(&target, &staged, &active_backup) {
        Ok(activation) => activation,
        Err(error) => {
            let _ = fs::remove_dir_all(&staged);
            return Err(error);
        }
    };

    if let Err(error) = grants::restore_approval(app, plugin_id, retained.approval.clone()) {
        let _ = activation.rollback();
        return Err(error).context("Failed to restore rollback permission approval");
    }

    if let Err(error) = retain(
        app,
        plugin_id,
        &active_manifest.version,
        &active_digest,
        &active_backup,
        active_approval.clone(),
    ) {
        let package_error = activation.rollback().err();
        let approval_error = grants::restore_approval(app, plugin_id, active_approval).err();
        return Err(anyhow!(
            "Plugin rollback history could not be rotated: {error}. Package restore: {}. Approval restore: {}",
            package_error.map_or_else(|| "ok".into(), |value| value.to_string()),
            approval_error.map_or_else(|| "ok".into(), |value| value.to_string()),
        ));
    }
    activation.commit()?;

    Ok(PluginRollbackResult {
        plugin_id: plugin_id.to_string(),
        restored_version: retained.version,
        replaced_version: active_manifest.version,
    })
}

pub fn remove(app: &AppHandle, plugin_id: &str) -> Result<()> {
    let path = rollback_path(app, plugin_id)?;
    if path.exists() {
        fs::remove_dir_all(path)?;
    }
    Ok(())
}

fn installed_path(app: &AppHandle, plugin_id: &str) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_config_dir()?
        .join("plugins")
        .join(sanitize_plugin_dir_name(plugin_id)?))
}

fn rollback_path(app: &AppHandle, plugin_id: &str) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_config_dir()?
        .join("plugin-rollback")
        .join(sanitize_plugin_dir_name(plugin_id)?))
}

fn rollback_staging_path(app: &AppHandle, plugin_id: &str) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_config_dir()?
        .join("plugin-rollback-staging")
        .join(format!(
            "{}-{}",
            sanitize_plugin_dir_name(plugin_id)?,
            uuid::Uuid::new_v4().simple()
        )))
}

fn rollback_swap_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_config_dir()?
        .join("plugin-rollback-swap")
        .join(uuid::Uuid::new_v4().simple().to_string()))
}

fn write_record(path: &Path, record: &RetainedPluginVersion) -> Result<()> {
    crate::atomic_io::durable_replace(path, &serde_json::to_vec_pretty(record)?)
        .context("Failed to save plugin rollback record")
}

fn read_record(path: &Path) -> Result<RetainedPluginVersion> {
    let metadata = fs::symlink_metadata(path).context("No retained plugin version is available")?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 512 * 1024 {
        return Err(anyhow!("Plugin rollback record is invalid"));
    }
    serde_json::from_slice(&fs::read(path)?).context("Plugin rollback record is invalid")
}

fn read_validated_record(path: &Path, plugin_id: &str) -> Result<RetainedPluginVersion> {
    let record = read_record(&path.join("record.json"))?;
    if record.plugin_id != plugin_id {
        return Err(anyhow!("Plugin rollback record identity changed"));
    }
    if digest_directory(&path.join("package"))? != record.package_digest {
        return Err(anyhow!(
            "Retained plugin rollback package failed verification"
        ));
    }
    Ok(record)
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

    fn retained_fixture() -> (PathBuf, RetainedPluginVersion) {
        let root = std::env::temp_dir().join(format!(
            "zync-plugin-rollback-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let package = root.join("package");
        fs::create_dir_all(&package).expect("create retained package");
        fs::write(package.join("manifest.json"), "retained package")
            .expect("write retained package");
        let record = RetainedPluginVersion {
            plugin_id: "dev.example.rollback".into(),
            version: "1.0.0".into(),
            package_digest: digest_directory(&package).expect("digest retained package"),
            retained_at_ms: 1,
            approval: None,
        };
        write_record(&root.join("record.json"), &record).expect("write rollback record");
        (root, record)
    }

    #[test]
    fn retained_version_requires_matching_plugin_identity() {
        let (root, record) = retained_fixture();
        let error = read_validated_record(&root, "dev.example.other")
            .expect_err("foreign rollback identity must fail");
        assert!(error.to_string().contains("identity changed"));
        read_validated_record(&root, &record.plugin_id).expect("matching rollback identity");
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn retained_version_rejects_package_tampering() {
        let (root, record) = retained_fixture();
        fs::write(root.join("package/manifest.json"), "tampered").expect("tamper retained package");
        let error = read_validated_record(&root, &record.plugin_id)
            .expect_err("tampered rollback package must fail");
        assert!(error.to_string().contains("failed verification"));
        fs::remove_dir_all(root).expect("remove fixture");
    }
}
