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
    pub mode: Option<String>, // "dark" | "light"
    pub preview_bg: Option<String>,
    pub preview_accent: Option<String>,
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
        inject(Self::builtin_monokai_pro());
        inject(Self::builtin_light());
        inject(Self::builtin_gruvbox_light());
        inject(Self::builtin_solarized_light());
        inject(Self::builtin_catppuccin_latte());
        inject(Self::builtin_tokyo_light());
        inject(Self::builtin_synthwave());
        inject(Self::builtin_nordic());

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
                mode: None,
                preview_bg: None,
                preview_accent: None,
            },
            script: Some(r#"
                zync.on('ready', () => {
                    zync.commands.register('workbench.action.selectTheme', 'Preferences: Color Theme', async () => {
                        const builtInThemes = [
                            { label: 'System Default', id: 'system' },
                            { kind: 'separator', label: 'separator' },
                            { label: 'Light', id: 'light', mode: 'light' },
                            { label: 'Gruvbox Light', id: 'gruvbox-light', mode: 'light' },
                            { label: 'Solarized Light', id: 'solarized-light', mode: 'light' },
                            { label: 'Catppuccin Latte', id: 'catppuccin-latte', mode: 'light' },
                            { label: 'Tokyo Light', id: 'tokyo-light', mode: 'light' },
                            { kind: 'separator', label: 'separator' },
                            { label: 'Dark (Default)', id: 'dark', mode: 'dark' },
                            { label: 'Dracula', id: 'dracula', mode: 'dark' },
                            { label: 'Monokai', id: 'monokai', mode: 'dark' },
                            { label: 'Midnight', id: 'midnight', mode: 'dark' },
                            { label: 'Monokai Pro', id: 'monokai-pro', mode: 'dark' },
                            { label: 'Synthwave', id: 'synthwave', mode: 'dark' },
                            { label: 'Nordic', id: 'nordic', mode: 'dark' },
                            { label: 'Night Owl', id: 'night-owl', mode: 'dark' },
                            { label: 'Kanagawa', id: 'kanagawa', mode: 'dark' },
                            { label: 'Tokyo Night', id: 'tokyo-night', mode: 'dark' },
                        ];

                        let userThemes = [];

                        try {
                            if (zync.plugins && zync.plugins.list) {
                                let plugins = await zync.plugins.list();
                                
                                // Helper to process a plugin into a QuickPick item
                                const processPlugin = (p) => {
                                    if (!p.manifest || (!p.manifest.style && !p.manifest.mode)) return;
                                    if (p.manifest.id === 'com.zync.theme.manager') return;
                                    
                                    // Check if it's a built-in theme to avoid duplicates
                                    const simpleId = p.manifest.id.replace('com.zync.theme.', '');
                                    if (builtInThemes.some(t => t.id === simpleId)) return;

                                    const item = {
                                        label: p.manifest.name.replace(' Theme', ''),
                                        id: simpleId,
                                        description: 'User',
                                        mode: p.manifest.mode || 'custom'
                                    };
                                    userThemes.push(item);
                                };

                                if (plugins && Array.isArray(plugins)) {
                                    plugins.forEach(processPlugin);
                                }
                            }
                        } catch (e) {
                            console.error('Failed to load user themes:', e);
                        }

                        // Merge logic: Insert user themes into correct groups
                        // We'll reconstruct the list to keep headers
                        const finalThemes = [];
                        
                        // Add System
                        finalThemes.push(builtInThemes[0]); // System
                        finalThemes.push(builtInThemes[1]); // Separator

                        // Add Light Themes (Built-in + User)
                        builtInThemes.filter(t => t.mode === 'light').forEach(t => finalThemes.push(t));
                        userThemes.filter(t => t.mode === 'light').forEach(t => finalThemes.push(t));

                        finalThemes.push({ kind: 'separator', label: 'separator' });

                        // Add Dark Themes (Built-in + User)
                        builtInThemes.filter(t => t.mode === 'dark').forEach(t => finalThemes.push(t));
                        userThemes.filter(t => t.mode === 'dark').forEach(t => finalThemes.push(t));
                        
                        // Add any undefined mode themes at the end
                        userThemes.filter(t => !t.mode || (t.mode !== 'light' && t.mode !== 'dark')).forEach(t => {
                            finalThemes.push(t);
                        });

                        const selected = await zync.window.showQuickPick(finalThemes, { placeHolder: 'Select Color Theme' });
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
                mode: Some("dark".to_string()),
                preview_bg: Some("#282a36".to_string()),
                preview_accent: Some("#d282af".to_string()),
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
                mode: Some("dark".to_string()),
                preview_bg: Some("#272822".to_string()),
                preview_accent: Some("#9ebf52".to_string()),
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
                mode: Some("dark".to_string()),
                preview_bg: Some("#0f111a".to_string()),
                preview_accent: Some("#797bce".to_string()),
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

    fn builtin_monokai_pro() -> Plugin {
        Plugin {
            path: "builtin://monokai-pro".to_string(),
            manifest: Manifest {
                id: "com.zync.theme.monokai-pro".to_string(),
                name: "Monokai Pro Theme".to_string(),
                version: "1.0.0".to_string(),
                main: None,
                style: Some("theme.css".to_string()),
                mode: Some("dark".to_string()),
                preview_bg: Some("#2d2a2e".to_string()),
                preview_accent: Some("#ffd866".to_string()),
            },
            script: None,
            style: Some(r#"
                [data-theme='monokai-pro'] {
                    --color-app-bg: #2d2a2e;
                    --color-app-panel: #2d2a2e;
                    --color-app-surface: #403e41;
                    --color-app-border: #5b595c;
                    --color-app-text: #fcfcfa;
                    --color-app-muted: #939293;
                    --color-app-accent: #ffd866;
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
                mode: Some("light".to_string()),
                preview_bg: Some("#f4f4f5".to_string()),
                preview_accent: Some("#2563eb".to_string()),
            },
            script: None,
            style: Some(r#"
                [data-theme='light'] {
                    --color-app-bg: #f4f4f5;
                    --color-app-panel: #ffffff;
                    --color-app-surface: #ffffff;
                    --color-app-border: #e4e4e7;
                    --color-app-text: #18181b;
                    --color-app-muted: #71717a;
                    --color-app-accent: #2563eb;
                }
            "#.to_string()),
            enabled: true,
        }
    }

    fn builtin_gruvbox_light() -> Plugin {
        Plugin {
            path: "builtin://gruvbox-light".to_string(),
            manifest: Manifest {
                id: "com.zync.theme.gruvbox-light".to_string(),
                name: "Gruvbox Light Theme".to_string(),
                version: "1.0.0".to_string(),
                main: None,
                style: Some("theme.css".to_string()),
                mode: Some("light".to_string()),
                preview_bg: Some("#fbf1c7".to_string()),
                preview_accent: Some("#d65d0e".to_string()),
            },
            script: None,
            style: Some(r#"
                [data-theme='gruvbox-light'] {
                    --color-app-bg: #fbf1c7;
                    --color-app-panel: #f2e5bc;
                    --color-app-surface: #ebdbb2;
                    --color-app-border: #d5c4a1;
                    --color-app-text: #3c3836;
                    --color-app-muted: #7c6f64;
                    --color-app-accent: #d65d0e;
                }
            "#.to_string()),
            enabled: true,
        }
    }

    fn builtin_solarized_light() -> Plugin {
        Plugin {
            path: "builtin://solarized-light".to_string(),
            manifest: Manifest {
                id: "com.zync.theme.solarized-light".to_string(),
                name: "Solarized Light Theme".to_string(),
                version: "1.0.0".to_string(),
                main: None,
                style: Some("theme.css".to_string()),
                mode: Some("light".to_string()),
                preview_bg: Some("#fdf6e3".to_string()),
                preview_accent: Some("#268bd2".to_string()),
            },
            script: None,
            style: Some(r#"
                [data-theme='solarized-light'] {
                    --color-app-bg: #fdf6e3;
                    --color-app-panel: #eee8d5;
                    --color-app-surface: #eee8d5;
                    --color-app-border: #93a1a1;
                    --color-app-text: #657b83;
                    --color-app-muted: #586e75;
                    --color-app-accent: #268bd2;
                }
            "#.to_string()),
            enabled: true,
        }
    }

    fn builtin_catppuccin_latte() -> Plugin {
        Plugin {
            path: "builtin://catppuccin-latte".to_string(),
            manifest: Manifest {
                id: "com.zync.theme.catppuccin-latte".to_string(),
                name: "Catppuccin Latte Theme".to_string(),
                version: "1.0.0".to_string(),
                main: None,
                style: Some("theme.css".to_string()),
                mode: Some("light".to_string()),
                preview_bg: Some("#eff1f5".to_string()),
                preview_accent: Some("#ea76cb".to_string()),
            },
            script: None,
            style: Some(r#"
                [data-theme='catppuccin-latte'] {
                    --color-app-bg: #eff1f5;
                    --color-app-panel: #e6e9ef;
                    --color-app-surface: #ccd0da;
                    --color-app-border: #bcc0cc;
                    --color-app-text: #4c4f69;
                    --color-app-muted: #6c6f85;
                    --color-app-accent: #ea76cb;
                }
            "#.to_string()),
            enabled: true,
        }
    }

    fn builtin_tokyo_light() -> Plugin {
        Plugin {
            path: "builtin://tokyo-light".to_string(),
            manifest: Manifest {
                id: "com.zync.theme.tokyo-light".to_string(),
                name: "Tokyo Light Theme".to_string(),
                version: "1.0.0".to_string(),
                main: None,
                style: Some("theme.css".to_string()),
                mode: Some("light".to_string()),
                preview_bg: Some("#e1e2e7".to_string()),
                preview_accent: Some("#3760bf".to_string()),
            },
            script: None,
            style: Some(r#"
                [data-theme='tokyo-light'] {
                    --color-app-bg: #e1e2e7;
                    --color-app-panel: #d5d6db;
                    --color-app-surface: #e9ecf2;
                    --color-app-border: #9aa5ce;
                    --color-app-text: #343b58;
                    --color-app-muted: #565a6e;
                    --color-app-accent: #3760bf;
                }
            "#.to_string()),
            enabled: true,
        }
    }

    fn builtin_synthwave() -> Plugin {
        Plugin {
            path: "builtin://synthwave".to_string(),
            manifest: Manifest {
                id: "com.zync.theme.synthwave".to_string(),
                name: "Synthwave Theme".to_string(),
                version: "1.0.0".to_string(),
                main: None,
                style: Some("theme.css".to_string()),
                mode: Some("dark".to_string()),
                preview_bg: Some("#2b213a".to_string()),
                preview_accent: Some("#ff7edb".to_string()),
            },
            script: None,
            style: Some(r#"
                [data-theme='synthwave'] {
                    --color-app-bg: #2b213a;
                    --color-app-panel: #241b31;
                    --color-app-surface: #34294f;
                    --color-app-border: #453a66;
                    --color-app-text: #fff0f5;
                    --color-app-muted: #b6a0d6;
                    --color-app-accent: #ff7edb;
                }
            "#.to_string()),
            enabled: true,
        }
    }

    fn builtin_nordic() -> Plugin {
        Plugin {
            path: "builtin://nordic".to_string(),
            manifest: Manifest {
                id: "com.zync.theme.nordic".to_string(),
                name: "Nordic Theme".to_string(),
                version: "1.0.0".to_string(),
                main: None,
                style: Some("theme.css".to_string()),
                mode: Some("dark".to_string()),
                preview_bg: Some("#2e3440".to_string()),
                preview_accent: Some("#88c0d0".to_string()),
            },
            script: None,
            style: Some(r#"
                [data-theme='nordic'] {
                    --color-app-bg: #2e3440;
                    --color-app-panel: #3b4252;
                    --color-app-surface: #434c5e;
                    --color-app-border: #4c566a;
                    --color-app-text: #d8dee9;
                    --color-app-muted: #88c0d0;
                    --color-app-accent: #88c0d0;
                }
            "#.to_string()),
            enabled: true,
        }
    }

    pub async fn install_plugin(app: &AppHandle, url: &str) -> Result<String> {
        println!("[Plugins] Installing from: {}", url);
        
        // 1. Download
        let client = reqwest::Client::new();
        let response = client.get(url).send().await?;
        
        if !response.status().is_success() {
            return Err(anyhow::anyhow!("Failed to download plugin: status {}", response.status()));
        }
        
        let bytes = response.bytes().await?;
        let cursor = std::io::Cursor::new(bytes);
        
        // 2. Unzip
        let mut archive = zip::ZipArchive::new(cursor)?;
        
        // Find manifest to get ID/Directory Name
        let mut manifest_content = String::new();
        {
            let mut manifest_file = archive.by_name("manifest.json")
                .context("Plugin zip is missing manifest.json")?;
            std::io::Read::read_to_string(&mut manifest_file, &mut manifest_content)?;
        }
        
        let manifest: Manifest = serde_json::from_str(&manifest_content)
            .context("Invalid manifest.json in plugin zip")?;
            
        // 3. Extract to plugins dir
        let config_dir = app.path().app_config_dir()
            .context("Failed to get config dir")?;
        let plugins_dir = config_dir.join("plugins");
        
        if !plugins_dir.exists() {
            fs::create_dir_all(&plugins_dir)?;
        }
        
        // Use manifest ID or safe name for directory
        // Sanitize ID for path
        let dir_name = manifest.id.replace(|c: char| !c.is_alphanumeric() && c != '.' && c != '-', "_");
        let target_dir = plugins_dir.join(&dir_name);
        
        if target_dir.exists() {
            // Check if we should overwrite? For now, yes, it's an update/reinstall
            fs::remove_dir_all(&target_dir)?; 
        }
        
        fs::create_dir_all(&target_dir)?;
        
        println!("[Plugins] Extracting to: {:?}", target_dir);
        archive.extract(&target_dir)?;
        
        Ok(manifest.id)
    }
    
    pub fn uninstall_plugin(app: &AppHandle, plugin_id: &str) -> Result<()> {
        let config_dir = app.path().app_config_dir()?;
        let plugins_dir = config_dir.join("plugins");
        
        // Need to find the directory - scanning or guessing
        // Since we name dirs by ID (sanitized), we can try that first
        let dir_name = plugin_id.replace(|c: char| !c.is_alphanumeric() && c != '.' && c != '-', "_");
        let target_dir = plugins_dir.join(&dir_name);
        
        if target_dir.exists() {
            fs::remove_dir_all(target_dir)?;
            Ok(())
        } else {
            // Fallback: scan to find directory with matching manifest ID?
            // For now, assume consistent naming
            Err(anyhow::anyhow!("Plugin directory not found for ID: {}", plugin_id))
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
