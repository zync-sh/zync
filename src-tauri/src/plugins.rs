use anyhow::{anyhow, Context, Result};
use log::info;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

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
    pub icon: Option<String>,
    /// e.g. `"icon-theme"` for file icon packs (matches `manifest.json` key `"type"`)
    #[serde(default, rename = "type")]
    pub manifest_type: Option<String>,
    /// Relative folder under the plugin root containing SVGs (matches `manifest.json` key `iconsPath`)
    #[serde(default, rename = "iconsPath")]
    pub icons_path: Option<String>,
    #[serde(default)]
    pub editor: Option<EditorManifest>,
}

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
struct PluginState {
    enabled_plugins: HashMap<String, bool>,
}

pub struct PluginScanner;

impl PluginScanner {
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
                let path = entry.path();

                if path.is_dir() {
                    if let Ok(mut plugin) = Self::load_plugin(&path) {
                        // Check if enabled (default true if not present)
                        plugin.enabled = *state
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

        inject(Self::builtin_theme_manager());
        inject(Self::builtin_codemirror_editor_provider());
        inject(Self::builtin_plain_editor_provider());
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

    pub fn save_state(app: &AppHandle, id: String, enabled: bool) -> Result<()> {
        let config_dir = app
            .path()
            .app_config_dir()
            .context("Failed to resolve app config directory")?;
        if !config_dir.exists() {
            fs::create_dir_all(&config_dir)?;
        }

        let state_path = config_dir.join("plugins.json");
        let mut state = Self::load_state(app)?;

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
                icon: None,
                manifest_type: None,
                icons_path: None,
                editor: None,
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
            editor_html: None,
            enabled: true, // Default, will be overwritten by scan
        }
    }

    fn builtin_plain_editor_provider() -> Plugin {
        Plugin {
            path: "builtin://plain-editor-provider".to_string(),
            manifest: Manifest {
                id: "com.zync.editor.plain-plugin".to_string(),
                name: "Plugin Editor (Bridge Demo)".to_string(),
                version: "1.0.0".to_string(),
                main: None,
                style: None,
                mode: None,
                preview_bg: None,
                preview_accent: None,
                icon: None,
                manifest_type: Some("editor-provider".to_string()),
                icons_path: None,
                editor: Some(EditorManifest {
                    entry: Some("editor.html".to_string()),
                    display_name: Some("Plugin Editor (Bridge Demo)".to_string()),
                    priority: Some(10),
                    default_for: Some(vec!["text/*".to_string()]),
                    supports: vec![
                        "save".to_string(),
                    ],
                    file_extensions: None,
                    large_file_limit_mb: None,
                }),
            },
            script: None,
            style: None,
            editor_html: Some(
                r#"
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root {
      color-scheme: dark;
      --bg: #0f111a;
      --panel: #1a1d2e;
      --border: rgba(255,255,255,0.08);
      --text: #e2e8f0;
      --muted: #94a3b8;
      --accent: #6366f1;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font-family: Inter, system-ui, sans-serif; }
    body { display: flex; flex-direction: column; }
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      background: color-mix(in srgb, var(--panel) 92%, transparent);
    }
    .meta { font-size: 12px; color: var(--muted); }
    .actions { display: flex; gap: 8px; }
    button {
      border: 1px solid var(--border);
      background: var(--panel);
      color: var(--text);
      border-radius: 8px;
      padding: 8px 10px;
      cursor: pointer;
      font-size: 12px;
    }
    button.primary {
      background: var(--accent);
      color: white;
      border-color: transparent;
    }
    textarea {
      flex: 1;
      width: 100%;
      border: 0;
      outline: 0;
      resize: none;
      background: var(--bg);
      color: var(--text);
      padding: 16px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      line-height: 1.55;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="meta" id="meta">Loading editor…</div>
    <div class="actions">
      <button id="closeBtn" type="button">Close</button>
      <button id="saveBtn" class="primary" type="button">Save</button>
    </div>
  </div>
  <textarea id="editor" spellcheck="false" aria-label="Plugin editor"></textarea>
  <script>
    const editor = document.getElementById('editor');
    const meta = document.getElementById('meta');
    const saveBtn = document.getElementById('saveBtn');
    const closeBtn = document.getElementById('closeBtn');
    let currentDoc = null;
    let initialContent = '';

    function updateMeta() {
      if (!currentDoc) {
        meta.textContent = 'Loading editor…';
        return;
      }
      const dirty = editor.value !== initialContent;
      const lineCount = editor.value.length === 0 ? 1 : editor.value.split('\n').length;
      meta.textContent = `${currentDoc.filename} · ${lineCount} lines${dirty ? ' · Modified' : ''}`;
      window.zyncEditor.emitDirtyChange(dirty);
    }

    editor.addEventListener('input', () => {
      updateMeta();
      window.zyncEditor.emitChange({ docId: currentDoc?.docId, content: editor.value });
    });

    saveBtn.addEventListener('click', () => {
      window.zyncEditor.requestSave(editor.value);
      initialContent = editor.value;
      updateMeta();
    });

    closeBtn.addEventListener('click', () => {
      window.zyncEditor.requestClose();
    });

    window.zyncEditor.onMessage((message) => {
      const { type, payload } = message || {};
      if (type === 'zync:editor:open-document') {
        currentDoc = payload;
        initialContent = payload.content || '';
        editor.value = initialContent;
        updateMeta();
        setTimeout(() => editor.focus(), 0);
      }

      if (type === 'zync:editor:update-document') {
        initialContent = payload.content || '';
        editor.value = initialContent;
        updateMeta();
      }

      if (type === 'zync:editor:set-theme') {
        const colors = payload?.colors || {};
        document.documentElement.style.setProperty('--bg', colors.background || '#0f111a');
        document.documentElement.style.setProperty('--panel', colors.surface || '#1a1d2e');
        document.documentElement.style.setProperty('--border', colors.border || 'rgba(255,255,255,0.08)');
        document.documentElement.style.setProperty('--text', colors.text || '#e2e8f0');
        document.documentElement.style.setProperty('--muted', colors.muted || '#94a3b8');
        document.documentElement.style.setProperty('--accent', colors.primary || '#6366f1');
      }

      if (type === 'zync:editor:focus') {
        editor.focus();
      }
    });

    window.zyncEditor.emitReady({ supports: ['search', 'save'] });
  </script>
</body>
</html>
                "#.to_string()
            ),
            enabled: true,
        }
    }

    fn builtin_codemirror_editor_provider() -> Plugin {
        Plugin {
            path: "builtin://codemirror-editor-provider".to_string(),
            manifest: Manifest {
                id: "com.zync.editor.codemirror".to_string(),
                name: "CodeMirror Editor".to_string(),
                version: "1.0.0".to_string(),
                main: None,
                style: None,
                mode: None,
                preview_bg: None,
                preview_accent: None,
                icon: None,
                manifest_type: Some("editor-provider".to_string()),
                icons_path: None,
                editor: Some(EditorManifest {
                    entry: None,
                    display_name: Some("CodeMirror".to_string()),
                    priority: Some(100),
                    default_for: Some(vec!["text/*".to_string()]),
                    supports: vec![
                        "search".to_string(),
                        "replace".to_string(),
                        "goto-line".to_string(),
                        "syntax-highlight".to_string(),
                        "folding".to_string(),
                        "multi-selection".to_string(),
                    ],
                    file_extensions: None,
                    large_file_limit_mb: None,
                }),
            },
            script: None,
            style: None,
            editor_html: None,
            enabled: true,
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
                icon: None,
                manifest_type: None,
                icons_path: None,
                editor: None,
            },
            script: None,
            style: Some(
                r#"
                [data-theme='dracula'] {
                    --color-app-bg: #282a36;
                    --color-app-panel: #282a36;
                    --color-app-surface: #44475a;
                    --color-app-border: #6272a4;
                    --color-app-text: #f8f8f2;
                    --color-app-muted: #6272a4;
                    --color-app-accent: #d282af;
                }
            "#
                .to_string(),
            ),
            editor_html: None,
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
                icon: None,
                manifest_type: None,
                icons_path: None,
                editor: None,
            },
            script: None,
            style: Some(
                r#"
                [data-theme='monokai'] {
                    --color-app-bg: #272822;
                    --color-app-panel: #272822;
                    --color-app-surface: #3e3d32;
                    --color-app-border: #49483e;
                    --color-app-text: #f8f8f2;
                    --color-app-muted: #75715e;
                    --color-app-accent: #9ebf52;
                }
            "#
                .to_string(),
            ),
            editor_html: None,
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
                icon: None,
                manifest_type: None,
                icons_path: None,
                editor: None,
            },
            script: None,
            style: Some(
                r#"
                [data-theme='midnight'] {
                    --color-app-bg: #0f111a;
                    --color-app-panel: #1a1d2d;
                    --color-app-surface: #262a3b;
                    --color-app-border: #2f344a;
                    --color-app-text: #e2e8f0;
                    --color-app-muted: #94a3b8;
                    --color-app-accent: #797bce;
                }
            "#
                .to_string(),
            ),
            editor_html: None,
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
                icon: None,
                manifest_type: None,
                icons_path: None,
                editor: None,
            },
            script: None,
            style: Some(
                r#"
                [data-theme='monokai-pro'] {
                    --color-app-bg: #2d2a2e;
                    --color-app-panel: #2d2a2e;
                    --color-app-surface: #403e41;
                    --color-app-border: #5b595c;
                    --color-app-text: #fcfcfa;
                    --color-app-muted: #939293;
                    --color-app-accent: #ffd866;
                }
            "#
                .to_string(),
            ),
            editor_html: None,
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
                icon: None,
                manifest_type: None,
                icons_path: None,
                editor: None,
            },
            script: None,
            style: Some(
                r#"
                [data-theme='light'] {
                    --color-app-bg: #f4f4f5;
                    --color-app-panel: #ffffff;
                    --color-app-surface: #ffffff;
                    --color-app-border: #e4e4e7;
                    --color-app-text: #18181b;
                    --color-app-muted: #71717a;
                    --color-app-accent: #2563eb;
                }
            "#
                .to_string(),
            ),
            editor_html: None,
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
                icon: None,
                manifest_type: None,
                icons_path: None,
                editor: None,
            },
            script: None,
            style: Some(
                r#"
                [data-theme='gruvbox-light'] {
                    --color-app-bg: #fbf1c7;
                    --color-app-panel: #f2e5bc;
                    --color-app-surface: #ebdbb2;
                    --color-app-border: #d5c4a1;
                    --color-app-text: #3c3836;
                    --color-app-muted: #7c6f64;
                    --color-app-accent: #d65d0e;
                }
            "#
                .to_string(),
            ),
            editor_html: None,
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
                icon: None,
                manifest_type: None,
                icons_path: None,
                editor: None,
            },
            script: None,
            style: Some(
                r#"
                [data-theme='solarized-light'] {
                    --color-app-bg: #fdf6e3;
                    --color-app-panel: #eee8d5;
                    --color-app-surface: #eee8d5;
                    --color-app-border: #93a1a1;
                    --color-app-text: #657b83;
                    --color-app-muted: #586e75;
                    --color-app-accent: #268bd2;
                }
            "#
                .to_string(),
            ),
            editor_html: None,
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
                icon: None,
                manifest_type: None,
                icons_path: None,
                editor: None,
            },
            script: None,
            style: Some(
                r#"
                [data-theme='catppuccin-latte'] {
                    --color-app-bg: #eff1f5;
                    --color-app-panel: #e6e9ef;
                    --color-app-surface: #ccd0da;
                    --color-app-border: #bcc0cc;
                    --color-app-text: #4c4f69;
                    --color-app-muted: #6c6f85;
                    --color-app-accent: #ea76cb;
                }
            "#
                .to_string(),
            ),
            editor_html: None,
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
                icon: None,
                manifest_type: None,
                icons_path: None,
                editor: None,
            },
            script: None,
            style: Some(
                r#"
                [data-theme='tokyo-light'] {
                    --color-app-bg: #e1e2e7;
                    --color-app-panel: #d5d6db;
                    --color-app-surface: #e9ecf2;
                    --color-app-border: #9aa5ce;
                    --color-app-text: #343b58;
                    --color-app-muted: #565a6e;
                    --color-app-accent: #3760bf;
                }
            "#
                .to_string(),
            ),
            editor_html: None,
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
                icon: None,
                manifest_type: None,
                icons_path: None,
                editor: None,
            },
            script: None,
            style: Some(
                r#"
                [data-theme='synthwave'] {
                    --color-app-bg: #2b213a;
                    --color-app-panel: #241b31;
                    --color-app-surface: #34294f;
                    --color-app-border: #453a66;
                    --color-app-text: #fff0f5;
                    --color-app-muted: #b6a0d6;
                    --color-app-accent: #ff7edb;
                }
            "#
                .to_string(),
            ),
            editor_html: None,
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
                icon: None,
                manifest_type: None,
                icons_path: None,
                editor: None,
            },
            script: None,
            style: Some(
                r#"
                [data-theme='nordic'] {
                    --color-app-bg: #2e3440;
                    --color-app-panel: #3b4252;
                    --color-app-surface: #434c5e;
                    --color-app-border: #4c566a;
                    --color-app-text: #d8dee9;
                    --color-app-muted: #88c0d0;
                    --color-app-accent: #88c0d0;
                }
            "#
                .to_string(),
            ),
            editor_html: None,
            enabled: true,
        }
    }

    pub async fn install_plugin(app: &AppHandle, url: &str) -> Result<String> {
        println!("[Plugins] Installing from: {}", url);

        // 1. Download
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| anyhow!("Failed to create HTTP client: {}", e))?;
        let response: reqwest::Response = client.get(url).send().await?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "Failed to download plugin: status {}",
                response.status()
            ));
        }

        let bytes = response.bytes().await?;
        let cursor = std::io::Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(cursor)?;
        Self::install_from_zip_archive(app, &mut archive)
    }

    pub fn install_plugin_from_local_path(app: &AppHandle, path: &str) -> Result<String> {
        let candidate_path = PathBuf::from(path);
        let source_path = fs::canonicalize(&candidate_path)
            .with_context(|| format!("Failed to resolve path: {}", candidate_path.display()))?;

        if source_path.is_file() {
            let file = fs::File::open(&source_path)
                .with_context(|| format!("Failed to open plugin archive: {}", source_path.display()))?;
            let mut archive = zip::ZipArchive::new(file)
                .with_context(|| format!("Invalid plugin archive: {}", source_path.display()))?;
            return Self::install_from_zip_archive(app, &mut archive);
        }

        if source_path.is_dir() {
            return Self::install_from_directory(app, &source_path);
        }

        Err(anyhow!(
            "Unsupported plugin source. Expected a zip file or plugin directory."
        ))
    }

    pub fn uninstall_plugin(app: &AppHandle, plugin_id: &str) -> Result<()> {
        let config_dir = app.path().app_config_dir()
        .context("Failed to resolve app config directory")?;
        let plugins_dir = config_dir.join("plugins");

        let dir_name = sanitize_plugin_dir_name(plugin_id)?;
        let target_dir = plugins_dir.join(&dir_name);

        // Legacy Check
        let legacy_name = legacy_sanitize_id(plugin_id);
        let legacy_dir = plugins_dir.join(&legacy_name);

        if target_dir.exists() {
            fs::remove_dir_all(target_dir)?;
            if legacy_dir.exists() { let _ = fs::remove_dir_all(legacy_dir); }
            Ok(())
        } else if legacy_dir.exists() {
            fs::remove_dir_all(legacy_dir)?;
            Ok(())
        } else {
            Err(anyhow::anyhow!("Plugin directory not found for ID: {}", plugin_id))
        }
    }

    fn install_from_zip_archive<R: std::io::Read + std::io::Seek>(
        app: &AppHandle,
        archive: &mut zip::ZipArchive<R>,
    ) -> Result<String> {
        let manifest = Self::read_manifest_from_archive(archive)?;
        let (_plugins_dir, target_dir, temp_dir) = Self::prepare_install_paths(app, &manifest.id)?;

        println!("[Plugins] Extracting to temp: {:?}", temp_dir);
        if let Err(e) = archive.extract(&temp_dir) {
            let _ = fs::remove_dir_all(&temp_dir);
            return Err(e.into());
        }

        if !temp_dir.join("manifest.json").exists() {
            let _ = fs::remove_dir_all(&temp_dir);
            return Err(anyhow!("Extracted plugin is missing manifest.json"));
        }

        Self::finalize_install(&target_dir, &temp_dir)?;
        Ok(manifest.id)
    }

    fn install_from_directory(app: &AppHandle, source_dir: &Path) -> Result<String> {
        let manifest_path = source_dir.join("manifest.json");
        let manifest_content = fs::read_to_string(&manifest_path)
            .with_context(|| format!("Plugin directory is missing {}", manifest_path.display()))?;
        let manifest: Manifest =
            serde_json::from_str(&manifest_content).context("Invalid manifest.json in plugin directory")?;

        let (_plugins_dir, target_dir, temp_dir) = Self::prepare_install_paths(app, &manifest.id)?;
        Self::copy_dir_recursive(source_dir, &temp_dir)?;

        if !temp_dir.join("manifest.json").exists() {
            let _ = fs::remove_dir_all(&temp_dir);
            return Err(anyhow!("Plugin directory copy failed: missing manifest.json"));
        }

        Self::finalize_install(&target_dir, &temp_dir)?;
        Ok(manifest.id)
    }

    fn prepare_install_paths(
        app: &AppHandle,
        plugin_id: &str,
    ) -> Result<(PathBuf, PathBuf, PathBuf)> {
        let config_dir = app
            .path()
            .app_config_dir()
            .context("Failed to get config dir")?;
        let plugins_dir = config_dir.join("plugins");
        if !plugins_dir.exists() {
            fs::create_dir_all(&plugins_dir)?;
        }

        let dir_name = sanitize_plugin_dir_name(plugin_id)?;
        let target_dir = plugins_dir.join(&dir_name);
        let temp_dir_name = format!("tmp-{}", uuid::Uuid::new_v4());
        let temp_dir = plugins_dir.join(&temp_dir_name);
        fs::create_dir_all(&temp_dir)?;

        Ok((plugins_dir, target_dir, temp_dir))
    }

    fn finalize_install(target_dir: &Path, temp_dir: &Path) -> Result<()> {
        if target_dir.exists() {
            fs::remove_dir_all(target_dir)?;
        }
        fs::rename(temp_dir, target_dir)?;
        Ok(())
    }

    fn read_manifest_from_archive<R: std::io::Read + std::io::Seek>(
        archive: &mut zip::ZipArchive<R>,
    ) -> Result<Manifest> {
        let mut manifest_content = String::new();
        {
            let mut manifest_file = archive
                .by_name("manifest.json")
                .context("Plugin zip is missing manifest.json")?;
            std::io::Read::read_to_string(&mut manifest_file, &mut manifest_content)?;
        }

        let manifest: Manifest = serde_json::from_str(&manifest_content)
            .context("Invalid manifest.json in plugin zip")?;
        Ok(manifest)
    }

    fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<()> {
        if !destination.exists() {
            fs::create_dir_all(destination)?;
        }

        for entry in fs::read_dir(source)? {
            let entry = entry?;
            let source_path = entry.path();
            let destination_path = destination.join(entry.file_name());

            if source_path.is_dir() {
                Self::copy_dir_recursive(&source_path, &destination_path)?;
            } else if source_path.is_file() {
                fs::copy(&source_path, &destination_path)
                    .with_context(|| format!("Failed to copy {}", source_path.display()))?;
            }
        }

        Ok(())
    }

    fn load_plugin(dir: &PathBuf) -> Result<Plugin> {
        let manifest_path = dir.join("manifest.json");
        let manifest_content = fs::read_to_string(&manifest_path)
            .context(format!("Missing manifest.json in {:?}", dir))?;

        let manifest: Manifest =
            serde_json::from_str(&manifest_content).context("Failed to parse manifest.json")?;

        let canonical_root = fs::canonicalize(dir)?;

        // Load Main Script (worker.js or specified entry)
        let script = if let Some(main_file) = &manifest.main {
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
                      let content = fs::read_to_string(&script_path)
                          .with_context(|| format!("Failed to read default worker script from {}", script_path.display()))?;
                      info!("[Plugins] Loaded default worker script from: {}", script_path.display());
                      Some(content)
                 } else { None }
            } else { None }
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
            return Err(anyhow!(
                "Illegal {field_name} path: outside plugin root"
            ));
        }

        let content = fs::read_to_string(&asset_path)
            .with_context(|| format!("Failed to read asset file from {}", asset_path.display()))?;
        info!("[Plugins] Loaded {field_name} from: {}", asset_path.display());
        Ok(content)
    }
}

/// Collision-free sanitizer for plugin directory names.
/// Uses URL-safe Base64 of the plugin ID to ensure uniqueness.
fn sanitize_plugin_dir_name(id: &str) -> Result<String> {
    use base64::{engine::general_purpose, Engine as _};
    let encoded = general_purpose::URL_SAFE_NO_PAD.encode(id);
    
    if encoded.is_empty() || encoded == "." || encoded == ".." {
        return Err(anyhow::anyhow!("Invalid plugin ID for directory naming: {}", id));
    }

    Ok(encoded)
}

/// Legacy sanitizer used in earlier versions (v2.5.4 early rollout).
/// Replaced by Base64 encoding to prevent collisions.
fn legacy_sanitize_id(id: &str) -> String {
    let sanitized: String = id
        .trim()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    sanitized
}




