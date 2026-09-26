use super::super::{Manifest, ManifestExtensions, Plugin};

pub(crate) fn builtin_theme_manager() -> Plugin {
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
            extensions: ManifestExtensions::default(),
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
