use super::install::PluginInstallInspection;
use super::manifest::Manifest;
use super::package::digest_directory;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const GRANT_STORE_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginGrant {
    plugin_id: String,
    publisher: Option<String>,
    version: String,
    package_digest: String,
    required_permissions: Vec<String>,
    optional_permissions: Vec<String>,
    legacy_access: bool,
    approved_at_ms: u64,
    #[serde(default)]
    source_label: Option<String>,
    #[serde(default)]
    trust_label: Option<String>,
    #[serde(default)]
    registry_version: Option<u64>,
    #[serde(default)]
    publisher_verified: bool,
    #[serde(default)]
    publisher_key_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginGrantSummary {
    pub required_permissions: Vec<String>,
    pub optional_permissions: Vec<String>,
    pub legacy_access: bool,
    pub approved_at_ms: u64,
    pub source_label: Option<String>,
    pub trust_label: Option<String>,
    pub registry_version: Option<u64>,
    pub publisher_verified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrantStore {
    version: u32,
    grants: BTreeMap<String, PluginGrant>,
}

impl Default for GrantStore {
    fn default() -> Self {
        Self {
            version: GRANT_STORE_VERSION,
            grants: BTreeMap::new(),
        }
    }
}

pub fn save_install_approval(
    app: &AppHandle,
    inspection: &PluginInstallInspection,
    optional_permissions: &[String],
) -> Result<()> {
    let path = grant_store_path(app)?;
    let mut store = load_store(&path)?;
    let manifest = &inspection.manifest;
    let required_permissions = manifest
        .extensions
        .permissions
        .as_ref()
        .map(|permissions| {
            permissions
                .required
                .iter()
                .map(|item| item.id.clone())
                .collect()
        })
        .unwrap_or_default();

    let approved_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX);
    store.grants.insert(
        manifest.id.clone(),
        PluginGrant {
            plugin_id: manifest.id.clone(),
            publisher: manifest.extensions.publisher.clone(),
            version: manifest.version.clone(),
            package_digest: inspection.package_digest.clone(),
            required_permissions,
            optional_permissions: optional_permissions.to_vec(),
            legacy_access: manifest.manifest_version() < 2,
            approved_at_ms,
            source_label: Some(inspection.source_label.clone()),
            trust_label: Some(inspection.trust_label.clone()),
            registry_version: inspection.registry_version,
            publisher_verified: inspection.publisher_verified,
            publisher_key_id: inspection
                .signature_status
                .as_ref()
                .map(|signature| signature.key_id.clone()),
        },
    );
    save_store(&path, &store)
}

pub fn remove_approval(app: &AppHandle, plugin_id: &str) -> Result<()> {
    let path = grant_store_path(app)?;
    let mut store = load_store(&path)?;
    if store.grants.remove(plugin_id).is_some() {
        save_store(&path, &store)?;
    }
    Ok(())
}

pub(crate) fn snapshot_approval(app: &AppHandle, plugin_id: &str) -> Result<Option<PluginGrant>> {
    Ok(load_store(&grant_store_path(app)?)?
        .grants
        .get(plugin_id)
        .cloned())
}

pub(crate) fn restore_approval(
    app: &AppHandle,
    plugin_id: &str,
    previous: Option<PluginGrant>,
) -> Result<()> {
    let path = grant_store_path(app)?;
    let mut store = load_store(&path)?;
    match previous {
        Some(grant) => {
            store.grants.insert(plugin_id.to_string(), grant);
        }
        None => {
            store.grants.remove(plugin_id);
        }
    }
    save_store(&path, &store)
}

pub fn approval_summary(app: &AppHandle, plugin_id: &str) -> Result<Option<PluginGrantSummary>> {
    let store = load_store(&grant_store_path(app)?)?;
    Ok(store.grants.get(plugin_id).map(|grant| PluginGrantSummary {
        required_permissions: grant.required_permissions.clone(),
        optional_permissions: grant.optional_permissions.clone(),
        legacy_access: grant.legacy_access,
        approved_at_ms: grant.approved_at_ms,
        source_label: grant.source_label.clone(),
        trust_label: grant.trust_label.clone(),
        registry_version: grant.registry_version,
        publisher_verified: grant.publisher_verified,
    }))
}

pub fn set_optional_permissions(
    app: &AppHandle,
    manifest: &Manifest,
    package_digest: &str,
    selected: Vec<String>,
) -> Result<PluginGrantSummary> {
    update_optional_permissions(app, manifest, package_digest, selected, false)
}

pub fn add_optional_permission(
    app: &AppHandle,
    manifest: &Manifest,
    package_digest: &str,
    capability: &str,
) -> Result<PluginGrantSummary> {
    update_optional_permissions(
        app,
        manifest,
        package_digest,
        vec![capability.to_string()],
        true,
    )
}

fn update_optional_permissions(
    app: &AppHandle,
    manifest: &Manifest,
    package_digest: &str,
    selected: Vec<String>,
    append: bool,
) -> Result<PluginGrantSummary> {
    static UPDATE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = UPDATE_LOCK
        .lock()
        .map_err(|_| anyhow!("Plugin grant store is unavailable"))?;
    let selected = validate_optional_selection(manifest, selected)?;

    let path = grant_store_path(app)?;
    let mut store = load_store(&path)?;
    let grant = store
        .grants
        .get_mut(&manifest.id)
        .ok_or_else(|| anyhow!("Plugin permission approval is missing"))?;
    if grant.package_digest != package_digest
        || grant.version != manifest.version
        || grant.publisher != manifest.extensions.publisher
    {
        return Err(anyhow!(
            "Plugin package changed; reinstall it before changing permissions"
        ));
    }
    if append {
        for permission in selected {
            if !grant.optional_permissions.contains(&permission) {
                grant.optional_permissions.push(permission);
            }
        }
    } else {
        grant.optional_permissions = selected;
    }
    let summary = PluginGrantSummary {
        required_permissions: grant.required_permissions.clone(),
        optional_permissions: grant.optional_permissions.clone(),
        legacy_access: grant.legacy_access,
        approved_at_ms: grant.approved_at_ms,
        source_label: grant.source_label.clone(),
        trust_label: grant.trust_label.clone(),
        registry_version: grant.registry_version,
        publisher_verified: grant.publisher_verified,
    };
    save_store(&path, &store)?;
    Ok(summary)
}

pub(super) fn validate_optional_selection(
    manifest: &Manifest,
    selected: Vec<String>,
) -> Result<Vec<String>> {
    let declared = manifest
        .extensions
        .permissions
        .as_ref()
        .map(|permissions| {
            permissions
                .optional
                .iter()
                .map(|permission| permission.id.as_str())
                .collect::<std::collections::HashSet<_>>()
        })
        .unwrap_or_default();
    let mut approved = Vec::new();
    let mut seen = HashSet::new();
    for permission_id in selected {
        if !super::manifest::is_known_permission_id(&permission_id) {
            return Err(anyhow!(
                "Unknown optional permission cannot be granted: {permission_id}"
            ));
        }
        if !declared.contains(permission_id.as_str()) {
            return Err(anyhow!(
                "Permission was not declared as optional: {permission_id}"
            ));
        }
        if seen.insert(permission_id.clone()) {
            approved.push(permission_id);
        }
    }
    Ok(approved)
}

pub fn is_package_approved(
    app: &AppHandle,
    manifest: &Manifest,
    digest: &str,
    developer_mode: bool,
) -> bool {
    let Ok(path) = grant_store_path(app) else {
        return false;
    };
    let Ok(store) = load_store(&path) else {
        return false;
    };
    store.grants.get(&manifest.id).is_some_and(|grant| {
        let identity_matches = grant.package_digest == digest
            && grant.version == manifest.version
            && grant.publisher == manifest.extensions.publisher;
        identity_matches
            && approval_source_allowed(grant.registry_version, developer_mode)
            && grant_revocation_reason(app, grant).is_ok_and(|reason| reason.is_none())
    })
}

fn approval_source_allowed(registry_version: Option<u64>, developer_mode: bool) -> bool {
    registry_version.is_some() || developer_mode
}

pub fn is_capability_granted(
    app: &AppHandle,
    manifest: &Manifest,
    digest: &str,
    capability: &str,
    developer_mode: bool,
) -> bool {
    let Ok(path) = grant_store_path(app) else {
        return false;
    };
    let Ok(store) = load_store(&path) else {
        return false;
    };
    store.grants.get(&manifest.id).is_some_and(|grant| {
        approval_source_allowed(grant.registry_version, developer_mode)
            && grant.package_digest == digest
            && grant.version == manifest.version
            && grant.publisher == manifest.extensions.publisher
            && (grant.required_permissions.iter().any(|id| id == capability)
                || grant.optional_permissions.iter().any(|id| id == capability))
    })
}

pub fn ensure_installed_plugin_is_approved(app: &AppHandle, plugin_id: &str) -> Result<()> {
    let config_dir = app
        .path()
        .app_config_dir()
        .context("Failed to resolve app config directory")?;
    let plugin_dir = config_dir
        .join("plugins")
        .join(super::install::sanitize_plugin_dir_name(plugin_id)?);
    if !plugin_dir.exists() {
        // Built-in plugins do not need user grant records.
        return Ok(());
    }
    let manifest_text = super::package::read_manifest_file(&plugin_dir.join("manifest.json"))?;
    let manifest: Manifest = serde_json::from_str(&manifest_text)?;
    if manifest.manifest_version() < 2 {
        return super::PluginScanner::require_developer_mode(app);
    }
    let digest = digest_directory(&plugin_dir)?;
    let store = load_store(&grant_store_path(app)?)?;
    let Some(grant) = store.grants.get(&manifest.id) else {
        return Err(anyhow!(
            "This plugin package has not been approved. Reinstall it to review its permissions."
        ));
    };
    if !approval_source_allowed(
        grant.registry_version,
        super::PluginScanner::developer_mode_enabled(app)?,
    ) {
        return Err(anyhow!(
            "Developer Mode is off. Local plugins cannot be enabled."
        ));
    }
    if grant.package_digest != digest
        || grant.version != manifest.version
        || grant.publisher != manifest.extensions.publisher
    {
        return Err(anyhow!(
            "This plugin package has not been approved. Reinstall it to review its permissions."
        ));
    }
    if let Some(reason) = grant_revocation_reason(app, grant)? {
        return Err(anyhow!(
            "This plugin was revoked by the marketplace: {reason}"
        ));
    }
    Ok(())
}

fn grant_revocation_reason(app: &AppHandle, grant: &PluginGrant) -> Result<Option<String>> {
    let Some(registry_version) = grant.registry_version else {
        return Ok(None);
    };
    let publisher = grant
        .publisher
        .as_deref()
        .ok_or_else(|| anyhow!("Marketplace plugin approval is missing its publisher"))?;
    let publisher_key_id = grant
        .publisher_key_id
        .as_deref()
        .ok_or_else(|| anyhow!("Marketplace plugin approval is missing its publisher key"))?;
    crate::plugins::registry::package_revocation_reason(
        app,
        registry_version,
        publisher,
        &grant.plugin_id,
        &grant.version,
        &grant.package_digest,
        Some(publisher_key_id),
    )
}

fn grant_store_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_config_dir()
        .context("Failed to resolve app config directory")?
        .join("plugin-grants.json"))
}

fn load_store(path: &Path) -> Result<GrantStore> {
    if !path.exists() {
        return Ok(GrantStore::default());
    }
    let bytes = fs::read(path).context("Failed to read plugin permission grants")?;
    let store: GrantStore =
        serde_json::from_slice(&bytes).context("Plugin permission grants are invalid")?;
    if store.version != GRANT_STORE_VERSION {
        return Err(anyhow!("Unsupported plugin permission grant store version"));
    }
    Ok(store)
}

fn save_store(path: &Path, store: &GrantStore) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(store)?;
    crate::atomic_io::durable_replace(path, &bytes)
        .context("Failed to save plugin permission grants")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_approvals_require_developer_mode_but_marketplace_approvals_do_not() {
        assert!(!approval_source_allowed(None, false));
        assert!(approval_source_allowed(None, true));
        assert!(approval_source_allowed(Some(7), false));
    }

    #[test]
    fn grant_store_round_trips_without_losing_optional_denials() {
        let root =
            std::env::temp_dir().join(format!("zync-plugin-grants-{}", uuid::Uuid::new_v4()));
        let path = root.join("plugin-grants.json");
        let mut store = GrantStore::default();
        store.grants.insert(
            "dev.example.demo".into(),
            PluginGrant {
                plugin_id: "dev.example.demo".into(),
                publisher: Some("dev.example".into()),
                version: "1.0.0".into(),
                package_digest: "sha256:test".into(),
                required_permissions: vec!["ui.commands.register".into()],
                optional_permissions: Vec::new(),
                legacy_access: false,
                approved_at_ms: 1,
                source_label: None,
                trust_label: None,
                registry_version: None,
                publisher_verified: false,
                publisher_key_id: None,
            },
        );

        save_store(&path, &store).expect("save grant store");
        let loaded = load_store(&path).expect("load grant store");
        let grant = loaded.grants.get("dev.example.demo").expect("stored grant");
        assert!(grant.optional_permissions.is_empty());
        assert_eq!(grant.required_permissions, ["ui.commands.register"]);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn optional_selection_is_declared_and_deduplicated() {
        let manifest: Manifest = serde_json::from_value(serde_json::json!({
            "manifestVersion": 2,
            "id": "dev.example.demo",
            "name": "Demo",
            "version": "1.0.0",
            "publisher": "dev.example",
            "permissions": {
                "optional": [{
                    "id": "ui.notifications.emit",
                    "reason": "Show completion messages."
                }]
            }
        }))
        .expect("parse manifest");

        let approved = validate_optional_selection(
            &manifest,
            vec![
                "ui.notifications.emit".into(),
                "ui.notifications.emit".into(),
            ],
        )
        .expect("declared optional permission");
        assert_eq!(approved, ["ui.notifications.emit"]);
        assert!(validate_optional_selection(&manifest, vec!["network.fetch".into()]).is_err());
    }

    #[test]
    fn unknown_optional_permissions_can_never_be_granted() {
        let manifest: Manifest = serde_json::from_value(serde_json::json!({
            "manifestVersion": 2,
            "id": "dev.example.future",
            "name": "Future permission",
            "version": "1.0.0",
            "publisher": "dev.example",
            "permissions": {
                "optional": [{
                    "id": "future.secret.read",
                    "reason": "Try a capability this host does not know."
                }]
            }
        }))
        .expect("parse manifest");

        let error = validate_optional_selection(&manifest, vec!["future.secret.read".into()])
            .expect_err("unknown optional capability must stay denied");
        assert!(error.to_string().contains("cannot be granted"));
    }
}
