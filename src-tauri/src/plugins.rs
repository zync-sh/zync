pub(crate) mod broker;
mod builtins;
pub(crate) mod filesystem;
mod grants;
pub(crate) mod install;
mod integrity;
pub(crate) mod management;
mod manifest;
pub(crate) mod network;
mod package;
pub(crate) mod pane_document;
pub(crate) mod recovery;
pub(crate) mod registry;
pub(crate) mod rollback;
pub(crate) mod ssh_command;
pub(crate) mod ssh_filesystem;
pub(crate) mod storage;
pub(crate) mod terminal;

pub use self::manifest::{EditorManifest, Manifest, ManifestExtensions};
use self::package::read_manifest_file;
use anyhow::{anyhow, Context, Result};
use log::info;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize)]
pub struct Plugin {
    pub path: String,
    pub manifest: Manifest,
    pub script: Option<String>,
    pub style: Option<String>,
    #[serde(rename = "editorHtml")]
    pub editor_html: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct PluginState {
    enabled_plugins: HashMap<String, bool>,
    developer_mode: bool,
    beta_plugins: std::collections::HashSet<String>,
}

pub struct PluginScanner;

impl PluginScanner {
    /// Load only the selected runtime package while retaining scan ordering and approval rules.
    /// Other packages contribute manifest identities, never payload reads or integrity hashes.
    pub(crate) fn load_runtime_plugin(
        app: &AppHandle,
        plugin_id: &str,
    ) -> Result<(Plugin, String)> {
        let config_dir = app
            .path()
            .app_config_dir()
            .context("Failed to resolve app config directory")?;
        let state = Self::load_state(app)?;
        let mut plugin = match load_matching_plugin(
            &config_dir.join("plugins"),
            plugin_id,
            Self::load_plugin,
        )? {
            Some(plugin) => plugin,
            None => {
                // Built-ins have no package tree. Reuse the scanner's complete built-in catalog.
                Self::builtin_plugins()
                    .into_iter()
                    .find(|plugin| plugin.manifest.id == plugin_id)
                    .ok_or_else(|| anyhow!("Plugin is not installed"))?
            }
        };
        let builtin = plugin.path.starts_with("builtin://");
        let digest = if builtin {
            format!("builtin:{}:{}", plugin.manifest.id, plugin.manifest.version)
        } else {
            package::digest_directory(Path::new(&plugin.path))
                .context("Failed to verify plugin package contents")?
        };
        let approved = builtin
            || user_plugin_enabled_by_policy(
                plugin.manifest.manifest_version(),
                state.developer_mode,
                plugin.manifest.manifest_version() >= 2
                    && grants::is_package_approved(
                        app,
                        &plugin.manifest,
                        &digest,
                        state.developer_mode,
                    ),
            );
        plugin.enabled = approved && *state.enabled_plugins.get(plugin_id).unwrap_or(&true);
        Ok((plugin, digest))
    }

    /// Build the same ordered built-in inventory used by discovery and targeted runtime loading.
    fn builtin_plugins() -> Vec<Plugin> {
        let mut plugins = vec![
            builtins::builtin_theme_manager(),
            builtins::builtin_codemirror_editor_provider(),
            builtins::builtin_plain_editor_provider(),
            builtins::builtin_dark(),
            builtins::builtin_dracula(),
            builtins::builtin_oxide(),
            builtins::builtin_monokai(),
            builtins::builtin_midnight(),
            builtins::builtin_monokai_pro(),
            builtins::builtin_light(),
            builtins::builtin_gruvbox_light(),
            builtins::builtin_solarized_light(),
            builtins::builtin_catppuccin_latte(),
            builtins::builtin_tokyo_light(),
            builtins::builtin_synthwave(),
            builtins::builtin_nordic(),
        ];
        plugins.extend(builtins::builtin_icon_themes());
        plugins
    }

    /// Scans the plugins directory and returns a list of loaded plugins.
    /// Plugins are located in `app_config_dir/plugins`.
    pub fn scan(app: &AppHandle) -> Result<Vec<Plugin>> {
        // Resolve configuration directory (e.g. ~/.config/zync on Linux)
        let config_dir = app
            .path()
            .app_config_dir()
            .context("Failed to resolve app config directory")?;

        let plugins_dir = config_dir.join("plugins");
        let state = Self::load_state(app)?;

        // Load User Plugins
        let mut plugins = Vec::new();
        if plugins_dir.exists() {
            for entry in fs::read_dir(plugins_dir)? {
                let entry = entry?;
                if !should_scan_plugin_dir(&entry.file_name()) {
                    continue;
                }
                let path = entry.path();

                if path.is_dir() {
                    if let Ok(mut plugin) = Self::load_plugin(&path) {
                        let manifest_version = plugin.manifest.manifest_version();
                        let package_approved = manifest_version >= 2
                            && package::digest_directory(&path).ok().is_some_and(|digest| {
                                grants::is_package_approved(
                                    app,
                                    &plugin.manifest,
                                    &digest,
                                    state.developer_mode,
                                )
                            });
                        let approved = user_plugin_enabled_by_policy(
                            manifest_version,
                            state.developer_mode,
                            package_approved,
                        );
                        // Check if enabled (default true if not present)
                        plugin.enabled = approved
                            && *state
                                .enabled_plugins
                                .get(&plugin.manifest.id)
                                .unwrap_or(&true);
                        plugins.push(plugin);
                    }
                }
            }
        }

        // Inject Built-in Plugins
        // Helper to inject and set enabled state
        let mut inject = |mut p: Plugin| {
            p.enabled = *state.enabled_plugins.get(&p.manifest.id).unwrap_or(&true);
            plugins.push(p);
        };

        for plugin in Self::builtin_plugins() {
            inject(plugin);
        }

        Ok(plugins)
    }

    fn load_state(app: &AppHandle) -> Result<PluginState> {
        let config_dir = app
            .path()
            .app_config_dir()
            .context("Failed to resolve app config directory")?;
        let state_path = config_dir.join("plugins.json");

        if state_path.exists() {
            let content = fs::read_to_string(state_path)?;
            let state: PluginState = serde_json::from_str(&content)?;
            Ok(state)
        } else {
            Ok(PluginState::default())
        }
    }

    pub(super) fn is_enabled(app: &AppHandle, plugin_id: &str) -> Result<bool> {
        let state = Self::load_state(app)?;
        Ok(*state.enabled_plugins.get(plugin_id).unwrap_or(&true))
    }

    pub(crate) fn developer_mode_enabled(app: &AppHandle) -> Result<bool> {
        Ok(Self::load_state(app)?.developer_mode)
    }

    pub fn set_developer_mode(app: &AppHandle, enabled: bool) -> Result<()> {
        let mut state = Self::load_state(app)?;
        state.developer_mode = enabled;
        Self::write_state(app, &state)
    }

    pub fn beta_enabled(app: &AppHandle, plugin_id: &str) -> Result<bool> {
        Ok(Self::load_state(app)?.beta_plugins.contains(plugin_id))
    }

    pub fn beta_plugins(app: &AppHandle) -> Result<Vec<String>> {
        Ok(Self::load_state(app)?.beta_plugins.into_iter().collect())
    }

    pub fn set_beta_enabled(app: &AppHandle, plugin_id: &str, enabled: bool) -> Result<()> {
        if plugin_id.is_empty()
            || plugin_id.len() > 128
            || !plugin_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
        {
            return Err(anyhow!("Invalid plugin id"));
        }
        let mut state = Self::load_state(app)?;
        if enabled {
            state.beta_plugins.insert(plugin_id.to_string());
        } else {
            state.beta_plugins.remove(plugin_id);
        }
        Self::write_state(app, &state)
    }

    pub(crate) fn require_developer_mode(app: &AppHandle) -> Result<()> {
        if Self::developer_mode_enabled(app)? {
            Ok(())
        } else {
            Err(anyhow!(
                "Developer Mode is off. Enable it in Settings > Plugins > Developer before using local or legacy plugins."
            ))
        }
    }

    pub fn save_state(app: &AppHandle, id: String, enabled: bool) -> Result<()> {
        if enabled {
            grants::ensure_installed_plugin_is_approved(app, &id)?;
        }
        let mut state = Self::load_state(app)?;

        state.enabled_plugins.insert(id, enabled);

        Self::write_state(app, &state)
    }

    fn write_state(app: &AppHandle, state: &PluginState) -> Result<()> {
        let config_dir = app
            .path()
            .app_config_dir()
            .context("Failed to resolve app config directory")?;
        if !config_dir.exists() {
            fs::create_dir_all(&config_dir)?;
        }
        let state_path = config_dir.join("plugins.json");
        crate::atomic_io::durable_replace(&state_path, &serde_json::to_vec_pretty(state)?)
            .context("Failed to save plugin state")
    }

    fn load_plugin(dir: &PathBuf) -> Result<Plugin> {
        let manifest_path = dir.join("manifest.json");
        let manifest_content = read_manifest_file(&manifest_path)
            .with_context(|| format!("Failed to read manifest.json in {dir:?}"))?;

        let manifest: Manifest =
            serde_json::from_str(&manifest_content).context("Failed to parse manifest.json")?;
        manifest
            .validate()
            .context("Plugin manifest validation failed")?;
        manifest.validate_host_compatibility()?;

        // Signed metadata is never advisory: if present, it must still match every payload byte
        // before the package can be loaded. Unsigned packages remain a Developer Mode concern.
        integrity::verify_package_signature(dir, &manifest)
            .context("Plugin package signature verification failed")?;

        let canonical_root = fs::canonicalize(dir)?;
        manifest.validate_package_assets(&canonical_root)?;

        // Load Main Script (worker.js or specified entry)
        let script = if manifest.extensions.icon_theme.is_some() {
            None // Declarative packs must never discover an implicit worker.js.
        } else if let Some(main_file) = manifest.runtime_entry() {
            Some(Self::read_plugin_text_asset(
                dir,
                &canonical_root,
                main_file,
                "manifest.main",
            )?)
        } else {
            let default_script = dir.join("worker.js");
            if default_script.exists() {
                let script_path = fs::canonicalize(default_script)?;
                if script_path.starts_with(&canonical_root) {
                    let content = fs::read_to_string(&script_path).with_context(|| {
                        format!(
                            "Failed to read default worker script from {}",
                            script_path.display()
                        )
                    })?;
                    info!(
                        "[Plugins] Loaded default worker script from: {}",
                        script_path.display()
                    );
                    Some(content)
                } else {
                    None
                }
            } else {
                None
            }
        };

        // Load Styles (if any)
        let style = if let Some(style_file) = &manifest.style {
            Some(Self::read_plugin_text_asset(
                dir,
                &canonical_root,
                style_file,
                "manifest.style",
            )?)
        } else {
            None
        };

        // Load editor panel HTML (if this plugin declares an editor-provider entry)
        let editor_html = if manifest.manifest_type.as_deref() == Some("editor-provider") {
            if let Some(entry_file) = manifest
                .editor
                .as_ref()
                .and_then(|editor| editor.entry.as_ref())
            {
                Some(Self::read_plugin_text_asset(
                    dir,
                    &canonical_root,
                    entry_file,
                    "manifest.editor.entry",
                )?)
            } else {
                None
            }
        } else {
            None
        };

        Ok(Plugin {
            path: dir.to_string_lossy().to_string(),
            manifest,
            script,
            style,
            editor_html,
            enabled: true, // Default, overwritten by scan
        })
    }

    fn read_plugin_text_asset(
        dir: &Path,
        canonical_root: &Path,
        relative_path: &str,
        field_name: &str,
    ) -> Result<String> {
        let asset_path = fs::canonicalize(dir.join(relative_path))
            .with_context(|| format!("Failed to resolve {field_name} path"))?;

        if !asset_path.starts_with(canonical_root) {
            return Err(anyhow!("Illegal {field_name} path: outside plugin root"));
        }

        let content = fs::read_to_string(&asset_path)
            .with_context(|| format!("Failed to read asset file from {}", asset_path.display()))?;
        info!(
            "[Plugins] Loaded {field_name} from: {}",
            asset_path.display()
        );
        Ok(content)
    }
}

/// Find the first loadable matching manifest without opening unrelated package payloads.
fn load_matching_plugin<T>(
    root: &Path,
    plugin_id: &str,
    mut load: impl FnMut(&PathBuf) -> Result<T>,
) -> Result<Option<T>> {
    if !root.exists() {
        return Ok(None);
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if !should_scan_plugin_dir(&entry.file_name()) {
            continue;
        }
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let matches = read_manifest_file(&path.join("manifest.json"))
            .ok()
            .and_then(|source| serde_json::from_str::<Manifest>(&source).ok())
            .is_some_and(|manifest| manifest.id == plugin_id);
        if matches {
            if let Ok(plugin) = load(&path) {
                return Ok(Some(plugin));
            }
        }
    }
    Ok(None)
}

fn should_scan_plugin_dir(name: &OsStr) -> bool {
    let name = name.to_string_lossy();
    !name.starts_with('.') && !name.starts_with("tmp-")
}

fn user_plugin_enabled_by_policy(
    manifest_version: u32,
    developer_mode: bool,
    package_approved: bool,
) -> bool {
    if manifest_version < 2 {
        developer_mode
    } else {
        package_approved
    }
}

#[cfg(test)]
mod scanner_tests {
    use super::{
        load_matching_plugin, should_scan_plugin_dir, user_plugin_enabled_by_policy, PluginScanner,
    };
    use std::ffi::OsStr;

    #[test]
    fn ignores_hidden_and_temporary_plugin_directories() {
        assert!(!should_scan_plugin_dir(OsStr::new(".plugin-rollback-123")));
        assert!(!should_scan_plugin_dir(OsStr::new("tmp-extract-123")));
        assert!(should_scan_plugin_dir(OsStr::new("dev.example.tool")));
    }

    #[test]
    fn legacy_activation_requires_developer_mode() {
        assert!(!user_plugin_enabled_by_policy(1, false, true));
        assert!(user_plugin_enabled_by_policy(1, true, false));
        assert!(user_plugin_enabled_by_policy(2, false, true));
        assert!(!user_plugin_enabled_by_policy(2, true, false));
    }

    #[test]
    fn runtime_lookup_opens_only_matching_package_payloads_and_accepts_legacy_folder_names() {
        let root = tempfile::tempdir().unwrap();
        let manifest: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/plugins/manifest-v2-demo/manifest.json"
        ))
        .unwrap();
        for (name, id) in [
            ("arbitrary-legacy-folder", "dev.fixture.selected"),
            ("unrelated", "dev.fixture.other"),
            (".hidden", "dev.fixture.selected"),
            ("tmp-staging", "dev.fixture.selected"),
        ] {
            let dir = root.path().join(name);
            std::fs::create_dir(&dir).unwrap();
            let mut value = manifest.clone();
            value["id"] = id.into();
            std::fs::write(
                dir.join("manifest.json"),
                serde_json::to_vec(&value).unwrap(),
            )
            .unwrap();
            std::fs::write(dir.join("worker.js"), [0xff]).unwrap();
        }
        let mut loads = Vec::new();
        let selected = load_matching_plugin(root.path(), "dev.fixture.selected", |dir| {
            loads.push(dir.file_name().unwrap().to_string_lossy().into_owned());
            Ok(dir.clone())
        })
        .unwrap()
        .unwrap();
        assert_eq!(selected.file_name().unwrap(), "arbitrary-legacy-folder");
        assert_eq!(loads, vec!["arbitrary-legacy-folder"]);
    }

    #[test]
    fn runtime_lookup_keeps_the_scan_rule_for_invalid_duplicate_candidates() {
        let root = tempfile::tempdir().unwrap();
        let manifest = include_str!("../../tests/fixtures/plugins/manifest-v2-demo/manifest.json");
        for name in ["one", "two"] {
            let dir = root.path().join(name);
            std::fs::create_dir(&dir).unwrap();
            std::fs::write(dir.join("manifest.json"), manifest).unwrap();
        }
        let mut attempts = 0;
        let selected =
            load_matching_plugin(root.path(), "dev.zync.examples.manifest-v2-demo", |dir| {
                attempts += 1;
                if attempts == 1 {
                    return Err(anyhow::anyhow!("invalid signature or package"));
                }
                Ok(dir.clone())
            })
            .unwrap();
        assert!(selected.is_some());
        assert_eq!(attempts, 2);
    }

    #[test]
    fn targeted_and_discovery_builtin_catalogs_have_unique_identical_identities() {
        let plugins = PluginScanner::builtin_plugins();
        let ids = plugins
            .iter()
            .map(|plugin| plugin.manifest.id.as_str())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(ids.len(), plugins.len());
        assert!(ids.contains("com.zync.theme.manager"));
        assert!(ids.contains("com.zync.editor.codemirror"));
        assert!(ids.contains("com.zync.editor.plain-plugin"));
    }

    #[test]
    fn declarative_icons_ignore_implicit_workers_and_recheck_assets_without_changing_legacy_loading(
    ) {
        let root = tempfile::tempdir().unwrap();
        let package = root.path().to_path_buf();
        let manifest_path = package.join("manifest.json");
        let manifest = include_str!("../../tests/fixtures/plugins/icon-theme/manifest.json");
        std::fs::write(&manifest_path, manifest).unwrap();
        std::fs::create_dir(package.join("icons")).unwrap();
        for name in ["file", "folder", "source"] {
            std::fs::write(package.join(format!("icons/{name}.svg")), "<svg/>").unwrap();
        }
        // Even an undeclared, unreadable-as-text worker is never discovered by a data-only pack.
        std::fs::write(package.join("worker.js"), [0xff]).unwrap();
        let loaded = PluginScanner::load_plugin(&package).unwrap();
        assert!(loaded.script.is_none());
        assert!(loaded.style.is_none());
        assert!(loaded.editor_html.is_none());

        let mut legacy: serde_json::Value = serde_json::from_str(manifest).unwrap();
        legacy.as_object_mut().unwrap().remove("iconTheme");
        legacy["iconsPath"] = serde_json::json!("icons");
        std::fs::write(&manifest_path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        std::fs::write(package.join("worker.js"), "legacy worker").unwrap();
        assert_eq!(
            PluginScanner::load_plugin(&package)
                .unwrap()
                .script
                .as_deref(),
            Some("legacy worker")
        );

        std::fs::write(manifest_path, manifest).unwrap();
        std::fs::remove_file(package.join("icons/file.svg")).unwrap();
        assert!(PluginScanner::load_plugin(&package).is_err());
    }
}
