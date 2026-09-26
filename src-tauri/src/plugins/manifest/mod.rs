mod validation;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use validation::{
    validate_contribution_permissions, validate_contributions, validate_identifier,
    validate_optional_asset, validate_optional_https_url, validate_optional_text,
    validate_permissions, validate_required_text, validate_text,
};

pub(crate) fn is_known_permission_id(permission_id: &str) -> bool {
    validation::is_known_permission_id(permission_id)
}

const LEGACY_MANIFEST_VERSION: u32 = 1;
const CURRENT_MANIFEST_VERSION: u32 = 2;
pub const PLUGIN_API_VERSION: &str = "2.1.0";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EditorManifest {
    #[serde(default)]
    pub entry: Option<String>,
    #[serde(default, rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(default)]
    pub priority: Option<i32>,
    #[serde(default, rename = "defaultFor")]
    pub default_for: Option<Vec<String>>,
    #[serde(default)]
    pub supports: Vec<String>,
    #[serde(default, rename = "fileExtensions")]
    pub file_extensions: Option<Vec<String>>,
    #[serde(default, rename = "largeFileLimitMb")]
    pub large_file_limit_mb: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginEngineRequirements {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zync: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_api: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PluginRuntimeManifest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPermissionRequest {
    pub id: String,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default)]
    pub hosts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PluginPermissionDeclarations {
    #[serde(default)]
    pub required: Vec<PluginPermissionRequest>,
    #[serde(default)]
    pub optional: Vec<PluginPermissionRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginCommandContribution {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSurfaceContribution {
    pub id: String,
    pub title: String,
    pub entry: String,
    #[serde(default)]
    pub allow_multiple: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginContributions {
    #[serde(default)]
    pub commands: Vec<PluginCommandContribution>,
    #[serde(default)]
    pub pane_kinds: Vec<PluginSurfaceContribution>,
    #[serde(default)]
    pub dashboard_cards: Vec<PluginSurfaceContribution>,
}

/// Manifest v2 fields stay flattened in JSON while legacy built-ins can share one default value.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ManifestExtensions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest_version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub support: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub privacy_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engines: Option<PluginEngineRequirements>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<PluginRuntimeManifest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contributes: Option<PluginContributions>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<PluginPermissionDeclarations>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub main: Option<String>,
    pub style: Option<String>,
    pub mode: Option<String>,
    pub preview_bg: Option<String>,
    pub preview_accent: Option<String>,
    pub icon: Option<String>,
    #[serde(default, rename = "type")]
    pub manifest_type: Option<String>,
    #[serde(default, rename = "iconsPath")]
    pub icons_path: Option<String>,
    #[serde(default)]
    pub editor: Option<EditorManifest>,
    #[serde(flatten)]
    pub extensions: ManifestExtensions,
}

impl Manifest {
    pub fn validate_host_compatibility(&self) -> Result<()> {
        if self.manifest_version() < CURRENT_MANIFEST_VERSION {
            return Ok(());
        }
        let zync = semver::Version::parse(env!("CARGO_PKG_VERSION"))
            .context("Zync build version is invalid")?;
        let plugin_api = semver::Version::parse(PLUGIN_API_VERSION)
            .context("Zync plugin API version is invalid")?;
        self.validate_compatibility_with(&zync, &plugin_api)
    }

    fn validate_compatibility_with(
        &self,
        zync: &semver::Version,
        plugin_api: &semver::Version,
    ) -> Result<()> {
        if self.manifest_version() < CURRENT_MANIFEST_VERSION {
            return Ok(());
        }
        let engines = self
            .extensions
            .engines
            .as_ref()
            .ok_or_else(|| anyhow!("Manifest v2 requires engines"))?;
        for (label, range, installed) in [
            ("engines.zync", engines.zync.as_deref(), zync),
            (
                "engines.pluginApi",
                engines.plugin_api.as_deref(),
                plugin_api,
            ),
        ] {
            let range = range.ok_or_else(|| anyhow!("Manifest v2 requires {label}"))?;
            let parts = range
                .split(|character: char| character == ',' || character.is_whitespace())
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>();
            let mut comparisons = Vec::new();
            let mut index = 0;
            while index < parts.len() {
                if matches!(parts[index], ">" | ">=" | "<" | "<=" | "=" | "~" | "^")
                    && index + 1 < parts.len()
                {
                    comparisons.push(format!("{}{}", parts[index], parts[index + 1]));
                    index += 2;
                } else {
                    comparisons.push(parts[index].to_string());
                    index += 1;
                }
            }
            let normalized = comparisons.join(", ");
            let requirement = semver::VersionReq::parse(&normalized)
                .with_context(|| format!("Invalid {label} version range: {range}"))?;
            if !requirement.matches(installed) {
                return Err(anyhow!(
                    "Plugin requires {label} {range}, but this Zync build provides {installed}"
                ));
            }
        }
        Ok(())
    }

    pub fn manifest_version(&self) -> u32 {
        self.extensions
            .manifest_version
            .unwrap_or(LEGACY_MANIFEST_VERSION)
    }

    pub fn runtime_entry(&self) -> Option<&str> {
        self.extensions
            .runtime
            .as_ref()
            .and_then(|runtime| runtime.entry.as_deref())
            .or(self.main.as_deref())
    }

    pub fn validate(&self) -> Result<()> {
        validate_identifier(&self.id, "plugin id")?;
        validate_text(&self.name, "plugin name", 80)?;
        validate_text(&self.version, "plugin version", 64)?;

        let manifest_version = self.manifest_version();
        if manifest_version != LEGACY_MANIFEST_VERSION
            && manifest_version != CURRENT_MANIFEST_VERSION
        {
            return Err(anyhow!(
                "Unsupported manifestVersion {manifest_version}; this Zync build supports versions 1 and 2"
            ));
        }

        validate_optional_asset(self.main.as_deref(), "manifest.main")?;
        validate_optional_asset(self.style.as_deref(), "manifest.style")?;
        validate_optional_asset(
            self.editor
                .as_ref()
                .and_then(|editor| editor.entry.as_deref()),
            "manifest.editor.entry",
        )?;

        if manifest_version == LEGACY_MANIFEST_VERSION {
            return Ok(());
        }

        semver::Version::parse(&self.version)
            .with_context(|| format!("Invalid plugin version: {}", self.version))?;

        let publisher = self
            .extensions
            .publisher
            .as_deref()
            .ok_or_else(|| anyhow!("Manifest v2 requires publisher"))?;
        validate_identifier(publisher, "publisher")?;
        let publisher_prefix = format!("{publisher}.");
        if !self.id.starts_with(&publisher_prefix) {
            return Err(anyhow!(
                "Plugin id {} must be namespaced to publisher {publisher}",
                self.id
            ));
        }

        let engines = self
            .extensions
            .engines
            .as_ref()
            .ok_or_else(|| anyhow!("Manifest v2 requires engines"))?;
        validate_required_text(engines.zync.as_deref(), "engines.zync", 80)?;
        validate_required_text(engines.plugin_api.as_deref(), "engines.pluginApi", 80)?;

        validate_optional_text(self.extensions.description.as_deref(), "description", 500)?;
        validate_optional_text(self.extensions.license.as_deref(), "license", 80)?;
        validate_optional_https_url(self.extensions.homepage.as_deref(), "homepage")?;
        validate_optional_https_url(self.extensions.support.as_deref(), "support")?;
        validate_optional_https_url(self.extensions.privacy_policy.as_deref(), "privacyPolicy")?;

        if let Some(runtime) = &self.extensions.runtime {
            validate_optional_asset(runtime.entry.as_deref(), "runtime.entry")?;
        }
        if let Some(contributions) = &self.extensions.contributes {
            validate_contributions(contributions)?;
            validate_contribution_permissions(contributions, self.extensions.permissions.as_ref())?;
        }
        validate_permissions(self.extensions.permissions.as_ref())
    }
}

#[cfg(test)]
mod tests;
