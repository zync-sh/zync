use serde::{Deserialize, Serialize};
use std::fs;
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use anyhow::{Context, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub main: Option<String>,
    pub style: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Plugin {
    pub path: String,
    pub manifest: Manifest,
    pub script: Option<String>,
    pub style: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct PluginState {
    enabled_plugins: HashMap<String, bool>,
}

pub struct PluginScanner;

impl PluginScanner {
    /// Scans the plugins directory and returns a list of loaded plugins.
    /// Plugins are located in `app_config_dir/plugins`.
    pub fn scan(app: &AppHandle) -> Result<Vec<Plugin>> {
        // Resolve configuration directory (e.g. ~/.config/zync on Linux)
        let config_dir = app.path().app_config_dir()
            .context("Failed to resolve app config directory")?;
        
        let plugins_dir = config_dir.join("plugins");
        let state = Self::load_state(app).unwrap_or_default();

        // Load User Plugins
        let mut plugins = Vec::new();
        if plugins_dir.exists() {
             for entry in fs::read_dir(plugins_dir)? {
                let entry = entry?;
                let path = entry.path();

                if path.is_dir() {
                    if let Ok(mut plugin) = Self::load_plugin(&path) {
                        // Check if enabled (default true if not present)
                        plugin.enabled = *state.enabled_plugins.get(&plugin.manifest.id).unwrap_or(&true);
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

        inject(Self::builtin_theme_manager());
        inject(Self::builtin_dracula());
        inject(Self::builtin_monokai());
        inject(Self::builtin_midnight());
        inject(Self::builtin_warm());
        inject(Self::builtin_light());
        inject(Self::builtin_light_warm());

        Ok(plugins)
    }

    fn load_state(app: &AppHandle) -> Result<PluginState> {
        let config_dir = app.path().app_config_dir()
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

    pub fn save_state(app: &AppHandle, id: String, enabled: bool) -> Result<()> {
        let config_dir = app.path().app_config_dir()
            .context("Failed to resolve app config directory")?;
        if !config_dir.exists() {
            fs::create_dir_all(&config_dir)?;
        }
        
        let state_path = config_dir.join("plugins.json");
        let mut state = Self::load_state(app).unwrap_or_default();
        
        state.enabled_plugins.insert(id, enabled);
        
        let content = serde_json::to_string_pretty(&state)?;
        fs::write(state_path, content)?;
        
        Ok(())
    }

    fn builtin_theme_manager() -> Plugin {
        Plugin {
            path: "builtin://theme-manager".to_string(),
            manifest: Manifest {
                id: "com.zync.theme.manager".to_string(),
                name: "Theme Manager".to_string(),
                version: "1.0.0".to_string(),
                main: None,
                style: None,
            },
            script: Some(r#"
                zync.on('ready', () => {
                    zync.commands.register('workbench.action.selectTheme', 'Preferences: Color Theme', async () => {
                        const themes = [
                            { label: 'Dark (Default)', id: 'dark' },
                            { label: 'Dracula', id: 'dracula' },
                            { label: 'Monokai', id: 'monokai' },
                            { label: 'Midnight', id: 'midnight' },
                            { label: 'Warm', id: 'warm' },
                            { label: 'Light', id: 'light' },
                            { label: 'Light Warm', id: 'light-warm' }
                        ];
                        const selected = await zync.window.showQuickPick(themes, { placeHolder: 'Select Color Theme' });
                        if (selected) {
                            zync.theme.set(selected.id);
                        }
                    });
                });
            "#.to_string()),
            style: None,
            enabled: true, // Default, will be overwritten by scan
        }
    }

    fn builtin_dracula() -> Plugin {
        Plugin {
            path: "builtin://dracula".to_string(),
            manifest: Manifest {
                id: "com.zync.theme.dracula".to_string(),
                name: "Dracula Theme".to_string(),
                version: "1.0.0".to_string(),
                main: None,
                style: Some("theme.css".to_string()),
            },
            script: None,
            style: Some(r#"
                [data-theme='dracula'] {
                    --color-app-bg: #282a36;
                    --color-app-panel: #282a36;
                    --color-app-surface: #44475a;
                    --color-app-border: #6272a4;
                    --color-app-text: #f8f8f2;
                    --color-app-muted: #6272a4;
                    --color-app-accent: #d282af;
                }
            "#.to_string()),
            enabled: true,
        }
    }

    fn builtin_monokai() -> Plugin {
        Plugin {
            path: "builtin://monokai".to_string(),
            manifest: Manifest {
                id: "com.zync.theme.monokai".to_string(),
                name: "Monokai Theme".to_string(),
                version: "1.0.0".to_string(),
                main: None,
                style: Some("theme.css".to_string()),
            },
            script: None,
            style: Some(r#"
                [data-theme='monokai'] {
                    --color-app-bg: #272822;
                    --color-app-panel: #272822;
                    --color-app-surface: #3e3d32;
                    --color-app-border: #49483e;
                    --color-app-text: #f8f8f2;
                    --color-app-muted: #75715e;
                    --color-app-accent: #9ebf52;
                }
            "#.to_string()),
            enabled: true,
        }
    }

    fn builtin_midnight() -> Plugin {
        Plugin {
            path: "builtin://midnight".to_string(),
            manifest: Manifest {
                id: "com.zync.theme.midnight".to_string(),
                name: "Midnight Theme".to_string(),
                version: "1.0.0".to_string(),
                main: None,
                style: Some("theme.css".to_string()),
            },
            script: None,
            style: Some(r#"
                [data-theme='midnight'] {
                    --color-app-bg: #0f111a;
                    --color-app-panel: #1a1d2d;
                    --color-app-surface: #262a3b;
                    --color-app-border: #2f344a;
                    --color-app-text: #e2e8f0;
                    --color-app-muted: #94a3b8;
                    --color-app-accent: #797bce;
                }
            "#.to_string()),
            enabled: true,
        }
    }

    fn builtin_warm() -> Plugin {
        Plugin {
            path: "builtin://warm".to_string(),
            manifest: Manifest {
                id: "com.zync.theme.warm".to_string(),
                name: "Warm Theme".to_string(),
                version: "1.0.0".to_string(),
                main: None,
                style: Some("theme.css".to_string()),
            },
            script: None,
            style: Some(r#"
                [data-theme='warm'] {
                    --color-app-bg: #1c1917;
                    --color-app-panel: #292524;
                    --color-app-surface: #44403c;
                    --color-app-border: #57534e;
                    --color-app-text: #f5f5f4;
                    --color-app-muted: #a8a29e;
                    --color-app-accent: #c08535;
                }
            "#.to_string()),
            enabled: true,
        }
    }

    fn builtin_light() -> Plugin {
        Plugin {
            path: "builtin://light".to_string(),
            manifest: Manifest {
                id: "com.zync.theme.light".to_string(),
                name: "Light Theme".to_string(),
                version: "1.0.0".to_string(),
                main: None,
                style: Some("theme.css".to_string()),
            },
            script: None,
            style: Some(r#"
                [data-theme='light'] {
                    --color-app-bg: #ffffff;
                    --color-app-panel: #f3f4f6;
                    --color-app-surface: #e5e7eb;
                    --color-app-border: #e5e7eb;
                    --color-app-text: #24292f;
                    --color-app-muted: #57606a;
                    --color-app-accent: #4c82c9;
                }
            "#.to_string()),
            enabled: true,
        }
    }

    fn builtin_light_warm() -> Plugin {
        Plugin {
            path: "builtin://light-warm".to_string(),
            manifest: Manifest {
                id: "com.zync.theme.light-warm".to_string(),
                name: "Light Warm Theme".to_string(),
                version: "1.0.0".to_string(),
                main: None,
                style: Some("theme.css".to_string()),
            },
            script: None,
            style: Some(r#"
                [data-theme='light-warm'] {
                    --color-app-bg: #f9f5eb;
                    --color-app-panel: #f0ebe2;
                    --color-app-surface: #e6e0d5;
                    --color-app-border: #dcd6cb;
                    --color-app-text: #44403c;
                    --color-app-muted: #a8a29e;
                    --color-app-accent: #c08535;
                }
            "#.to_string()),
            enabled: true,
        }
    }

    fn load_plugin(dir: &PathBuf) -> Result<Plugin> {
        let manifest_path = dir.join("manifest.json");
        let manifest_content = fs::read_to_string(&manifest_path)
            .context(format!("Missing manifest.json in {:?}", dir))?;
        
        let manifest: Manifest = serde_json::from_str(&manifest_content)
            .context("Failed to parse manifest.json")?;

        // Load Main Script (worker.js or specified entry)
        let script = if let Some(main_file) = &manifest.main {
            let script_path = dir.join(main_file);
            fs::read_to_string(script_path).ok()
        } else {
            // Default to worker.js if not specified, or None
            fs::read_to_string(dir.join("worker.js")).ok()
        };

        // Load Styles (if any)
        let style = if let Some(style_file) = &manifest.style {
            let style_path = dir.join(style_file);
            fs::read_to_string(style_path).ok()
        } else {
            None
        };

        Ok(Plugin {
            path: dir.to_string_lossy().to_string(),
            manifest,
            script,
            style,
            enabled: true, // Default, overwritten by scan
        })
    }
}
