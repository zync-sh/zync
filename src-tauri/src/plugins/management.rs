use super::broker::PluginRuntimePrincipal;
use super::grants;
pub use super::grants::PluginGrantSummary;
use super::integrity::{verify_package_signature, PackageSignatureStatus};
use super::package::digest_directory;
use super::storage::{PluginStorageState, PluginStorageUsage};
use super::{Manifest, Plugin, PluginScanner};
use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::path::Path;
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManagementDetails {
    pub plugin_id: String,
    pub publisher: Option<String>,
    pub version: String,
    pub manifest_version: u32,
    pub source_label: String,
    pub trust_label: String,
    pub package_digest: Option<String>,
    pub signature_status: Option<PackageSignatureStatus>,
    pub grant: Option<PluginGrantSummary>,
    pub storage: PluginStorageUsage,
    pub rollback: Option<super::rollback::PluginRollbackInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUninstallResult {
    pub data_deleted: bool,
    pub data_delete_error: Option<String>,
}

pub fn details(
    app: &AppHandle,
    storage: &PluginStorageState,
    plugin_id: &str,
) -> Result<PluginManagementDetails> {
    let plugin = find_plugin(app, plugin_id)?;
    let builtin = plugin.path.starts_with("builtin://");
    let (package_digest, signature_status) = if builtin {
        (None, None)
    } else {
        (
            Some(
                digest_directory(Path::new(&plugin.path))
                    .context("Failed to verify installed plugin contents")?,
            ),
            verify_package_signature(Path::new(&plugin.path), &plugin.manifest)?,
        )
    };
    let grant = if builtin {
        None
    } else {
        grants::approval_summary(app, plugin_id)?
    };
    let principal = principal_for(&plugin.manifest);

    let source_label = grant
        .as_ref()
        .and_then(|grant| grant.source_label.clone())
        .unwrap_or_else(|| {
            if builtin {
                "Bundled with Zync".into()
            } else {
                "Local installation".into()
            }
        });
    let trust_label = grant
        .as_ref()
        .and_then(|grant| grant.trust_label.clone())
        .unwrap_or_else(|| {
            if builtin {
                "Built in".into()
            } else if signature_status.is_some() {
                "Signed package".into()
            } else {
                "Local development".into()
            }
        });

    Ok(PluginManagementDetails {
        plugin_id: plugin.manifest.id.clone(),
        publisher: plugin.manifest.extensions.publisher.clone(),
        version: plugin.manifest.version.clone(),
        manifest_version: plugin.manifest.manifest_version(),
        source_label,
        trust_label,
        package_digest,
        signature_status,
        grant,
        storage: storage.usage(app, &principal)?,
        rollback: if builtin {
            None
        } else {
            super::rollback::info(app, plugin_id)?
        },
    })
}

pub fn set_optional_permissions(
    app: &AppHandle,
    plugin_id: &str,
    optional_permission_ids: Vec<String>,
) -> Result<PluginGrantSummary> {
    let plugin = find_plugin(app, plugin_id)?;
    if plugin.path.starts_with("builtin://") {
        return Err(anyhow!("Built-in plugin permissions are managed by Zync"));
    }
    if plugin.manifest.manifest_version() < 2 {
        return Err(anyhow!(
            "Legacy plugin permissions cannot be changed individually"
        ));
    }
    let digest = digest_directory(Path::new(&plugin.path))
        .context("Failed to verify installed plugin contents")?;
    grants::set_optional_permissions(app, &plugin.manifest, &digest, optional_permission_ids)
}

pub fn clear_storage(
    app: &AppHandle,
    storage: &PluginStorageState,
    plugin_id: &str,
) -> Result<bool> {
    let plugin = find_plugin(app, plugin_id)?;
    if plugin.path.starts_with("builtin://") {
        return Err(anyhow!("Built-in plugin data cannot be cleared here"));
    }
    storage.clear(app, &principal_for(&plugin.manifest))
}

pub fn uninstall(
    app: &AppHandle,
    storage: &PluginStorageState,
    plugin_id: &str,
    delete_data: bool,
) -> Result<PluginUninstallResult> {
    let plugin = find_plugin(app, plugin_id)?;
    if plugin.path.starts_with("builtin://") {
        return Err(anyhow!("Built-in plugins cannot be uninstalled"));
    }
    let principal = principal_for(&plugin.manifest);
    super::rollback::remove(app, plugin_id)?;
    PluginScanner::uninstall_plugin(app, plugin_id)?;

    if !delete_data {
        return Ok(PluginUninstallResult {
            data_deleted: false,
            data_delete_error: None,
        });
    }

    match storage.clear(app, &principal) {
        Ok(_) => Ok(PluginUninstallResult {
            data_deleted: true,
            data_delete_error: None,
        }),
        Err(error) => Ok(PluginUninstallResult {
            data_deleted: false,
            data_delete_error: Some(error.to_string()),
        }),
    }
}

fn find_plugin(app: &AppHandle, plugin_id: &str) -> Result<Plugin> {
    PluginScanner::scan(app)?
        .into_iter()
        .find(|plugin| plugin.manifest.id == plugin_id)
        .ok_or_else(|| anyhow!("Plugin is not installed"))
}

fn principal_for(manifest: &Manifest) -> PluginRuntimePrincipal {
    PluginRuntimePrincipal {
        plugin_id: manifest.id.clone(),
        publisher_id: manifest
            .extensions
            .publisher
            .clone()
            .unwrap_or_else(|| "_legacy".into()),
    }
}
