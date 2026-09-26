use super::sanitize_plugin_dir_name;
use crate::plugins::integrity::{verify_package_signature, PackageSignatureStatus};
use crate::plugins::manifest::PluginPermissionDeclarations;
use crate::plugins::package::{
    begin_staged_package_activation, copy_directory, digest_directory, extract_archive,
    read_manifest_file, rollback_package_activation,
};
use crate::plugins::{Manifest, PluginScanner};
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallInspection {
    pub inspection_id: String,
    pub package_digest: String,
    pub source_label: String,
    pub trust_label: String,
    pub signature_status: Option<PackageSignatureStatus>,
    #[serde(default)]
    pub registry_version: Option<u64>,
    #[serde(default)]
    pub publisher_verified: bool,
    #[serde(default)]
    pub previous_version: Option<String>,
    #[serde(default)]
    pub previous_package_digest: Option<String>,
    #[serde(default)]
    pub previous_permissions: Option<PluginPermissionDeclarations>,
    #[serde(default)]
    pub previously_granted_optional: Vec<String>,
    pub manifest: Manifest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginActivationTransaction {
    pub activation_id: String,
    pub plugin_id: String,
    pub previous_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingActivationMetadata {
    activation_id: String,
    plugin_id: String,
    had_previous: bool,
    #[serde(default)]
    previous_version: Option<String>,
    #[serde(default)]
    previous_package_digest: Option<String>,
    previous_approval: Option<crate::plugins::grants::PluginGrant>,
}

impl PluginScanner {
    pub fn cleanup_stale_inspections(app: &AppHandle) {
        let activations_recovered = recover_pending_activations(app)
            .map_err(|error| {
                eprintln!("Failed to recover an interrupted plugin activation: {error:#}");
            })
            .is_ok();
        let Ok(config_dir) = app.path().app_config_dir() else {
            return;
        };
        // Reviews cannot survive an app restart, so no staged executable code should either.
        let _ = fs::remove_dir_all(config_dir.join("plugin-staging"));
        let _ = fs::remove_dir_all(config_dir.join("plugin-rollback-staging"));
        if activations_recovered {
            let _ = fs::remove_dir_all(config_dir.join("plugin-activation-backups"));
        }
    }

    pub fn inspect_local_plugin(app: &AppHandle, path: &str) -> Result<PluginInstallInspection> {
        Self::require_developer_mode(app)?;
        let candidate_path = PathBuf::from(path);
        let source_path = fs::canonicalize(&candidate_path)
            .with_context(|| format!("Failed to resolve path: {}", candidate_path.display()))?;
        let inspection_id = uuid::Uuid::new_v4().to_string();
        let staging_dir = inspection_path(app, &inspection_id)?;
        fs::create_dir_all(&staging_dir)?;

        let stage_result = if source_path.is_file() {
            let file = fs::File::open(&source_path).with_context(|| {
                format!("Failed to open plugin archive: {}", source_path.display())
            })?;
            let mut archive = zip::ZipArchive::new(file)
                .with_context(|| format!("Invalid plugin archive: {}", source_path.display()))?;
            extract_archive(&mut archive, &staging_dir)
        } else if source_path.is_dir() {
            copy_directory(&source_path, &staging_dir)
        } else {
            Err(anyhow!(
                "Unsupported plugin source. Expected a zip file or plugin directory."
            ))
        };
        if let Err(error) = stage_result {
            let _ = fs::remove_dir_all(&staging_dir);
            return Err(error);
        }

        let result = inspect_staged_package(inspection_id, &source_path, &staging_dir);
        match result {
            Ok(mut inspection) => {
                if let Err(error) = attach_installed_update_context(app, &mut inspection) {
                    let _ = fs::remove_dir_all(&staging_dir);
                    return Err(error);
                }
                if let Err(error) = write_inspection_metadata(app, &inspection) {
                    let _ = fs::remove_dir_all(&staging_dir);
                    return Err(error);
                }
                Ok(inspection)
            }
            Err(error) => {
                let _ = fs::remove_dir_all(&staging_dir);
                Err(error)
            }
        }
    }

    pub async fn inspect_marketplace_plugin(
        app: &AppHandle,
        plugin_id: &str,
        version: &str,
    ) -> Result<PluginInstallInspection> {
        let snapshot = crate::plugins::registry::load(app).await?;
        let release = snapshot
            .plugins
            .iter()
            .find(|release| release.id == plugin_id && release.version == version)
            .cloned()
            .ok_or_else(|| anyhow!("Plugin release is not present in the trusted marketplace"))?;
        if release.channel == crate::plugins::registry::PluginReleaseChannel::Beta
            && !Self::beta_enabled(app, plugin_id)?
        {
            return Err(anyhow!("Beta releases are not enabled for this plugin"));
        }
        if let Some(reason) = snapshot.release_revocation_reason(&release) {
            return Err(anyhow!(
                "Plugin release was revoked by the marketplace: {reason}"
            ));
        }
        let archive_bytes = super::download_plugin_archive(&release.download_url).await?;
        let app_handle = app.clone();
        tokio::task::spawn_blocking(move || {
            inspect_marketplace_archive(&app_handle, archive_bytes, release, snapshot.version)
        })
        .await
        .context("Marketplace plugin inspection task failed")?
    }

    pub fn install_inspected_plugin(
        app: &AppHandle,
        inspection_id: &str,
        expected_digest: &str,
        optional_permission_ids: Vec<String>,
    ) -> Result<PluginActivationTransaction> {
        let staging_dir = inspection_path(app, inspection_id)?;
        if !staging_dir.is_dir() {
            return Err(anyhow!(
                "Plugin inspection expired. Choose the package again."
            ));
        }
        let inspection = read_inspection_metadata(app, inspection_id)?;
        if inspection.registry_version.is_none() {
            Self::require_developer_mode(app)?;
        } else if !semver::Version::parse(&inspection.manifest.version)
            .context("Reviewed marketplace version is invalid")?
            .pre
            .is_empty()
            && !Self::beta_enabled(app, &inspection.manifest.id)?
        {
            return Err(anyhow!("Beta releases are not enabled for this plugin"));
        }
        if inspection.package_digest != expected_digest {
            return Err(anyhow!("Plugin review no longer matches this package"));
        }
        let manifest_content = read_manifest_file(&staging_dir.join("manifest.json"))?;
        let manifest: Manifest = serde_json::from_str(&manifest_content)
            .context("Invalid manifest.json in staged plugin")?;
        manifest
            .validate()
            .context("Plugin manifest validation failed")?;
        manifest.validate_host_compatibility()?;
        let actual_digest = digest_directory(&staging_dir)?;
        if actual_digest != expected_digest {
            let _ = fs::remove_dir_all(&staging_dir);
            return Err(anyhow!(
                "The staged plugin changed after review. Choose it again."
            ));
        }
        let approved_optional = crate::plugins::grants::validate_optional_selection(
            &manifest,
            optional_permission_ids,
        )?;
        let signature_status = verify_package_signature(&staging_dir, &manifest)?;
        if manifest.id != inspection.manifest.id
            || manifest.version != inspection.manifest.version
            || manifest.extensions.publisher != inspection.manifest.extensions.publisher
            || !signature_status_matches(&signature_status, &inspection.signature_status)
        {
            let _ = fs::remove_dir_all(&staging_dir);
            return Err(anyhow!("The staged plugin identity changed after review"));
        }

        let config_dir = app
            .path()
            .app_config_dir()
            .context("Failed to get config dir")?;
        let target_dir = config_dir
            .join("plugins")
            .join(sanitize_plugin_dir_name(&manifest.id)?);
        ensure_update_target_unchanged(&target_dir, inspection.previous_package_digest.as_deref())?;
        if let Some(parent) = target_dir.parent() {
            fs::create_dir_all(parent)?;
        }
        let activation_id = uuid::Uuid::new_v4().to_string();
        let backup_dir = activation_backup_path(app, &activation_id)?;
        if let Some(parent) = backup_dir.parent() {
            fs::create_dir_all(parent)?;
        }
        let previous_approval = crate::plugins::grants::snapshot_approval(app, &manifest.id)?;
        let pending = PendingActivationMetadata {
            activation_id: activation_id.clone(),
            plugin_id: manifest.id.clone(),
            had_previous: target_dir.exists(),
            previous_version: inspection.previous_version.clone(),
            previous_package_digest: inspection.previous_package_digest.clone(),
            previous_approval,
        };
        write_activation_metadata(app, &pending)?;

        let activation =
            match begin_staged_package_activation(&target_dir, &staging_dir, &backup_dir) {
                Ok(activation) => activation,
                Err(error) => {
                    let _ = remove_activation_metadata(app, &activation_id);
                    return Err(error);
                }
            };
        if let Err(error) =
            crate::plugins::grants::save_install_approval(app, &inspection, &approved_optional)
        {
            let rollback_error = activation.rollback().err();
            let grant_error = crate::plugins::grants::restore_approval(
                app,
                &manifest.id,
                pending.previous_approval.clone(),
            )
            .err();
            let _ = remove_activation_metadata(app, &activation_id);
            return Err(anyhow!(
                "Plugin approval could not be saved: {error}. Package rollback: {}. Approval rollback: {}",
                rollback_error.map_or_else(|| "ok".into(), |value| value.to_string()),
                grant_error.map_or_else(|| "ok".into(), |value| value.to_string()),
            ));
        }
        let _ = fs::remove_file(inspection_metadata_path(app, inspection_id)?);
        Ok(PluginActivationTransaction {
            activation_id,
            plugin_id: manifest.id,
            previous_version: inspection.previous_version,
        })
    }

    pub fn commit_plugin_activation(app: &AppHandle, activation_id: &str) -> Result<bool> {
        let pending = read_activation_metadata(app, activation_id)?;
        let backup_dir = activation_backup_path(app, activation_id)?;
        // Removing the recovery marker commits the active package. A crash after this point
        // may leave an inert backup directory, but it must never restore an old approval.
        remove_activation_metadata(app, activation_id)?;
        if !pending.had_previous || !backup_dir.exists() {
            return Ok(false);
        }
        let (Some(previous_version), Some(previous_digest)) =
            (pending.previous_version, pending.previous_package_digest)
        else {
            return Ok(false);
        };
        match crate::plugins::rollback::retain(
            app,
            &pending.plugin_id,
            &previous_version,
            &previous_digest,
            &backup_dir,
            pending.previous_approval,
        ) {
            Ok(()) => Ok(true),
            Err(error) => {
                eprintln!("Failed to retain plugin rollback copy: {error:#}");
                Ok(false)
            }
        }
    }

    pub fn rollback_plugin_activation(app: &AppHandle, activation_id: &str) -> Result<()> {
        rollback_pending_activation(app, read_activation_metadata(app, activation_id)?)
    }

    pub fn discard_plugin_inspection(app: &AppHandle, inspection_id: &str) -> Result<()> {
        let staging_dir = inspection_path(app, inspection_id)?;
        if staging_dir.exists() {
            fs::remove_dir_all(staging_dir)?;
        }
        let metadata_path = inspection_metadata_path(app, inspection_id)?;
        if metadata_path.exists() {
            fs::remove_file(metadata_path)?;
        }
        Ok(())
    }
}

fn inspect_marketplace_archive(
    app: &AppHandle,
    archive_bytes: Vec<u8>,
    release: crate::plugins::registry::TrustedRegistryPlugin,
    registry_version: u64,
) -> Result<PluginInstallInspection> {
    let inspection_id = uuid::Uuid::new_v4().to_string();
    let staging_dir = inspection_path(app, &inspection_id)?;
    fs::create_dir_all(&staging_dir)?;

    let result = (|| {
        let cursor = std::io::Cursor::new(archive_bytes);
        let mut archive = zip::ZipArchive::new(cursor).context("Invalid plugin archive")?;
        extract_archive(&mut archive, &staging_dir)?;

        let mut inspection = inspect_marketplace_staged_package(
            inspection_id,
            &staging_dir,
            &release,
            registry_version,
        )?;
        attach_installed_update_context(app, &mut inspection)?;
        write_inspection_metadata(app, &inspection)?;
        Ok(inspection)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging_dir);
    }
    result
}

fn inspect_staged_package(
    inspection_id: String,
    source_path: &std::path::Path,
    staging_dir: &std::path::Path,
) -> Result<PluginInstallInspection> {
    let manifest_content = read_manifest_file(&staging_dir.join("manifest.json"))?;
    let manifest: Manifest =
        serde_json::from_str(&manifest_content).context("Invalid manifest.json in local plugin")?;
    manifest
        .validate()
        .context("Plugin manifest validation failed")?;
    manifest.validate_host_compatibility()?;
    let signature_status = verify_package_signature(staging_dir, &manifest)?;
    Ok(PluginInstallInspection {
        inspection_id,
        package_digest: digest_directory(staging_dir)?,
        source_label: source_path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "Local plugin".to_string()),
        trust_label: signature_status.as_ref().map_or_else(
            || "Local development".to_string(),
            |_| "Signed package".to_string(),
        ),
        signature_status,
        registry_version: None,
        publisher_verified: false,
        previous_version: None,
        previous_package_digest: None,
        previous_permissions: None,
        previously_granted_optional: Vec::new(),
        manifest,
    })
}

fn inspect_marketplace_staged_package(
    inspection_id: String,
    staging_dir: &std::path::Path,
    release: &crate::plugins::registry::TrustedRegistryPlugin,
    registry_version: u64,
) -> Result<PluginInstallInspection> {
    let manifest_content = read_manifest_file(&staging_dir.join("manifest.json"))?;
    let manifest: Manifest = serde_json::from_str(&manifest_content)
        .context("Invalid manifest.json in marketplace plugin")?;
    manifest
        .validate()
        .context("Plugin manifest validation failed")?;
    manifest.validate_host_compatibility()?;
    if manifest.manifest_version() < 2 {
        return Err(anyhow!("Marketplace plugins must use Manifest v2"));
    }
    if manifest.id != release.id
        || manifest.version != release.version
        || manifest.extensions.publisher.as_deref() != Some(release.publisher.as_str())
    {
        return Err(anyhow!(
            "Marketplace package identity does not match its registry release"
        ));
    }
    let package_digest = digest_directory(staging_dir)?;
    if package_digest != release.package_digest {
        return Err(anyhow!(
            "Marketplace package digest does not match the signed registry"
        ));
    }
    let signature_status = verify_package_signature(staging_dir, &manifest)?
        .ok_or_else(|| anyhow!("Marketplace plugins must contain a publisher signature"))?;
    if signature_status.publisher != release.publisher
        || signature_status.key_id != release.publisher_key_id
    {
        return Err(anyhow!(
            "Marketplace package was not signed by the registered publisher key"
        ));
    }

    Ok(PluginInstallInspection {
        inspection_id,
        package_digest,
        source_label: "Zync Marketplace".into(),
        trust_label: if release.publisher_verified {
            "Verified publisher".into()
        } else {
            "Signed community publisher".into()
        },
        signature_status: Some(signature_status),
        registry_version: Some(registry_version),
        publisher_verified: release.publisher_verified,
        previous_version: None,
        previous_package_digest: None,
        previous_permissions: None,
        previously_granted_optional: Vec::new(),
        manifest,
    })
}

fn attach_installed_update_context(
    app: &AppHandle,
    inspection: &mut PluginInstallInspection,
) -> Result<()> {
    let target_dir = app
        .path()
        .app_config_dir()?
        .join("plugins")
        .join(sanitize_plugin_dir_name(&inspection.manifest.id)?);
    if !target_dir.is_dir() {
        return Ok(());
    }

    let manifest_text = read_manifest_file(&target_dir.join("manifest.json"))?;
    let installed_manifest: Manifest =
        serde_json::from_str(&manifest_text).context("Installed plugin manifest is invalid")?;
    if installed_manifest.id != inspection.manifest.id {
        return Err(anyhow!(
            "Installed plugin identity does not match its directory"
        ));
    }
    let installed_digest = digest_directory(&target_dir)?;
    if inspection.registry_version.is_some() && requires_marketplace_version_check(&installed_manifest) {
        validate_marketplace_update(
            &installed_manifest.version,
            &installed_digest,
            &inspection.manifest.version,
            &inspection.package_digest,
        )?;
    }
    inspection.previous_version = Some(installed_manifest.version.clone());
    inspection.previous_package_digest = Some(installed_digest);
    inspection.previous_permissions = installed_manifest.extensions.permissions.clone();
    inspection.previously_granted_optional =
        crate::plugins::grants::approval_summary(app, &inspection.manifest.id)?
            .map(|grant| grant.optional_permissions)
            .unwrap_or_default();
    Ok(())
}

fn requires_marketplace_version_check(installed_manifest: &Manifest) -> bool {
    installed_manifest.manifest_version() >= 2
        && semver::Version::parse(&installed_manifest.version).is_ok()
}

fn validate_marketplace_update(
    installed_version: &str,
    installed_digest: &str,
    candidate_version: &str,
    candidate_digest: &str,
) -> Result<()> {
    let installed =
        semver::Version::parse(installed_version).context("Installed plugin version is invalid")?;
    let candidate = semver::Version::parse(candidate_version)
        .context("Marketplace plugin version is invalid")?;
    if candidate < installed {
        return Err(anyhow!(
            "Marketplace downgrade was rejected. Use the retained-version rollback action instead."
        ));
    }
    if candidate == installed && candidate_digest != installed_digest {
        return Err(anyhow!(
            "Marketplace release changed without a version increase"
        ));
    }
    Ok(())
}

fn ensure_update_target_unchanged(
    target_dir: &std::path::Path,
    previous_digest: Option<&str>,
) -> Result<()> {
    match previous_digest {
        Some(expected) if target_dir.is_dir() && digest_directory(target_dir)? == expected => {
            Ok(())
        }
        Some(_) => Err(anyhow!(
            "The installed plugin changed after update review. Review the update again."
        )),
        None if target_dir.exists() => Err(anyhow!(
            "A plugin with this id was installed after review. Review the package again."
        )),
        None => Ok(()),
    }
}

fn installed_plugin_path(app: &AppHandle, plugin_id: &str) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_config_dir()
        .context("Failed to get config dir")?
        .join("plugins")
        .join(sanitize_plugin_dir_name(plugin_id)?))
}

fn activation_backup_path(app: &AppHandle, activation_id: &str) -> Result<PathBuf> {
    let activation_id =
        uuid::Uuid::parse_str(activation_id).context("Invalid plugin activation identifier")?;
    Ok(app
        .path()
        .app_config_dir()
        .context("Failed to get config dir")?
        .join("plugin-activation-backups")
        .join(activation_id.simple().to_string()))
}

fn activation_metadata_path(app: &AppHandle, activation_id: &str) -> Result<PathBuf> {
    let activation_id =
        uuid::Uuid::parse_str(activation_id).context("Invalid plugin activation identifier")?;
    Ok(app
        .path()
        .app_config_dir()
        .context("Failed to get config dir")?
        .join("plugin-activations")
        .join(format!("{activation_id}.json")))
}

fn write_activation_metadata(app: &AppHandle, pending: &PendingActivationMetadata) -> Result<()> {
    let path = activation_metadata_path(app, &pending.activation_id)?;
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("Plugin activation metadata path has no parent"))?;
    fs::create_dir_all(parent)?;
    crate::atomic_io::durable_replace(&path, &serde_json::to_vec_pretty(pending)?)
        .context("Failed to save plugin activation transaction")
}

fn read_activation_metadata(
    app: &AppHandle,
    activation_id: &str,
) -> Result<PendingActivationMetadata> {
    let path = activation_metadata_path(app, activation_id)?;
    let metadata =
        fs::symlink_metadata(&path).context("Plugin activation transaction is missing")?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 512 * 1024 {
        return Err(anyhow!("Plugin activation transaction is invalid"));
    }
    let pending: PendingActivationMetadata = serde_json::from_slice(&fs::read(path)?)
        .context("Plugin activation transaction is invalid")?;
    if pending.activation_id != activation_id {
        return Err(anyhow!("Plugin activation transaction identity changed"));
    }
    Ok(pending)
}

fn remove_activation_metadata(app: &AppHandle, activation_id: &str) -> Result<()> {
    let path = activation_metadata_path(app, activation_id)?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn rollback_pending_activation(app: &AppHandle, pending: PendingActivationMetadata) -> Result<()> {
    let target_dir = installed_plugin_path(app, &pending.plugin_id)?;
    let backup_dir = activation_backup_path(app, &pending.activation_id)?;

    // Metadata is written before the package move. For updates, the backup appearing is
    // the durable signal that activation started. For first installs, staging disappears
    // only after it has been moved into the active package directory.
    if pending.had_previous {
        if backup_dir.exists() {
            rollback_package_activation(&target_dir, Some(&backup_dir))?;
        }
    } else if target_dir.exists() {
        rollback_package_activation(&target_dir, None)?;
    }
    crate::plugins::grants::restore_approval(app, &pending.plugin_id, pending.previous_approval)?;
    remove_activation_metadata(app, &pending.activation_id)
}

fn recover_pending_activations(app: &AppHandle) -> Result<()> {
    let directory = app
        .path()
        .app_config_dir()
        .context("Failed to get config dir")?
        .join("plugin-activations");
    if !directory.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(&directory)? {
        let entry = entry?;
        let path = entry.path();
        if !entry.file_type()?.is_file()
            || path.extension().and_then(|value| value.to_str()) != Some("json")
        {
            continue;
        }
        let Some(activation_id) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        let pending = read_activation_metadata(app, activation_id)?;
        rollback_pending_activation(app, pending)?;
    }
    Ok(())
}

fn signature_status_matches(
    actual: &Option<PackageSignatureStatus>,
    reviewed: &Option<PackageSignatureStatus>,
) -> bool {
    match (actual, reviewed) {
        (None, None) => true,
        (Some(actual), Some(reviewed)) => {
            actual.publisher == reviewed.publisher
                && actual.key_id == reviewed.key_id
                && actual.published_at_ms == reviewed.published_at_ms
                && actual.integrity_root == reviewed.integrity_root
                && actual.verified == reviewed.verified
        }
        _ => false,
    }
}

fn write_inspection_metadata(app: &AppHandle, inspection: &PluginInstallInspection) -> Result<()> {
    let path = inspection_metadata_path(app, &inspection.inspection_id)?;
    fs::write(path, serde_json::to_vec_pretty(inspection)?)?;
    Ok(())
}

fn read_inspection_metadata(
    app: &AppHandle,
    inspection_id: &str,
) -> Result<PluginInstallInspection> {
    let path = inspection_metadata_path(app, inspection_id)?;
    let metadata = fs::symlink_metadata(&path)
        .context("Plugin inspection expired. Review the package again.")?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 512 * 1024 {
        return Err(anyhow!("Plugin inspection metadata is invalid"));
    }
    serde_json::from_slice(&fs::read(path)?).context("Plugin inspection metadata is invalid")
}

fn inspection_path(app: &AppHandle, inspection_id: &str) -> Result<PathBuf> {
    let parsed =
        uuid::Uuid::parse_str(inspection_id).context("Invalid plugin inspection identifier")?;
    let config_dir = app
        .path()
        .app_config_dir()
        .context("Failed to get config dir")?;
    Ok(config_dir.join("plugin-staging").join(parsed.to_string()))
}

fn inspection_metadata_path(app: &AppHandle, inspection_id: &str) -> Result<PathBuf> {
    let parsed =
        uuid::Uuid::parse_str(inspection_id).context("Invalid plugin inspection identifier")?;
    let config_dir = app
        .path()
        .app_config_dir()
        .context("Failed to get config dir")?;
    Ok(config_dir
        .join("plugin-staging")
        .join(format!("{}.json", parsed)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unsigned_marketplace_fixture() -> (PathBuf, crate::plugins::registry::TrustedRegistryPlugin)
    {
        let root =
            std::env::temp_dir().join(format!("zync-marketplace-review-{}", uuid::Uuid::new_v4()));
        copy_directory(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../tests/fixtures/plugins/manifest-v2-demo")
                .as_path(),
            &root,
        )
        .expect("copy marketplace fixture");
        let digest = digest_directory(&root).expect("digest fixture");
        (
            root,
            crate::plugins::registry::TrustedRegistryPlugin {
                id: "dev.zync.examples.manifest-v2-demo".into(),
                name: "Manifest v2 Demo".into(),
                version: "1.4.0".into(),
                channel: crate::plugins::registry::PluginReleaseChannel::Stable,
                description: "test".into(),
                publisher: "dev.zync.examples".into(),
                download_url: "https://plugins.example.test/demo.zip".into(),
                package_digest: digest,
                publisher_key_id: format!("sha256:{}", "11".repeat(32)),
                publisher_public_key: "test".into(),
                publisher_verified: false,
                icon: None,
                thumbnail_url: None,
                plugin_type: Some("tool".into()),
            },
        )
    }

    #[test]
    fn optional_approval_accepts_only_declared_permissions() {
        let manifest: Manifest = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/plugins/manifest-v2-demo/manifest.json"
        ))
        .expect("parse example manifest");

        let approved = crate::plugins::grants::validate_optional_selection(&manifest, Vec::new())
            .expect("empty optional selection is valid");
        assert!(approved.is_empty());
        let approved = crate::plugins::grants::validate_optional_selection(
            &manifest,
            vec!["network.fetch".into()],
        )
        .expect("declared optional permission is valid");
        assert_eq!(approved, ["network.fetch"]);
        let error = crate::plugins::grants::validate_optional_selection(
            &manifest,
            vec!["clipboard.read".into()],
        )
        .expect_err("undeclared optional permission must fail");
        assert!(error.to_string().contains("not declared as optional"));
    }

    #[test]
    fn marketplace_review_rejects_registry_identity_mismatch() {
        let (root, mut release) = unsigned_marketplace_fixture();
        release.id = "dev.zync.examples.other".into();
        let error = inspect_marketplace_staged_package("review".into(), &root, &release, 7)
            .expect_err("registry identity mismatch must fail");
        assert!(error.to_string().contains("identity does not match"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn marketplace_review_requires_a_publisher_signature() {
        let (root, release) = unsigned_marketplace_fixture();
        let error = inspect_marketplace_staged_package("review".into(), &root, &release, 7)
            .expect_err("unsigned marketplace package must fail");
        assert!(error.to_string().contains("publisher signature"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn local_review_rejects_an_incompatible_plugin_before_permission_review() {
        let (root, _) = unsigned_marketplace_fixture();
        let manifest_path = root.join("manifest.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        manifest["engines"]["pluginApi"] = serde_json::json!("^3.0.0");
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        let error = inspect_staged_package("review".into(), &root, &root)
            .expect_err("an incompatible plugin must not reach permission review");
        assert!(error.to_string().contains("engines.pluginApi"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn update_review_is_bound_to_the_installed_package_digest() {
        let root = std::env::temp_dir().join(format!(
            "zync-update-review-digest-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("create installed package");
        fs::write(root.join("manifest.json"), "original").expect("write package");
        let digest = digest_directory(&root).expect("digest installed package");
        ensure_update_target_unchanged(&root, Some(&digest)).expect("unchanged package");

        fs::write(root.join("manifest.json"), "changed").expect("change package");
        assert!(ensure_update_target_unchanged(&root, Some(&digest)).is_err());
        assert!(ensure_update_target_unchanged(&root, None).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn marketplace_updates_reject_downgrades_and_mutated_versions() {
        let downgrade = validate_marketplace_update("2.0.0", "sha256:old", "1.9.9", "sha256:new")
            .expect_err("marketplace downgrade must fail");
        assert!(downgrade.to_string().contains("downgrade"));

        let mutation = validate_marketplace_update("2.0.0", "sha256:old", "2.0.0", "sha256:new")
            .expect_err("same-version package replacement must fail");
        assert!(mutation.to_string().contains("without a version increase"));

        validate_marketplace_update("2.0.0", "sha256:old", "2.1.0", "sha256:new")
            .expect("higher marketplace version");
        validate_marketplace_update("2.0.0", "sha256:same", "2.0.0", "sha256:same")
            .expect("idempotent reinstall");
    }

    #[test]
    fn marketplace_migration_accepts_legacy_installed_versions() {
        let mut installed: Manifest = serde_json::from_str(
            r#"{"id":"dev.example.demo","name":"Demo","version":"1"}"#,
        )
        .unwrap();
        assert!(!requires_marketplace_version_check(&installed));

        installed.extensions.manifest_version = Some(2);
        assert!(!requires_marketplace_version_check(&installed));

        installed.version = "1.0.0".into();
        assert!(requires_marketplace_version_check(&installed));
    }
}
