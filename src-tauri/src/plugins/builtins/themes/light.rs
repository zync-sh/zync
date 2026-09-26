use super::super::super::{Manifest, ManifestExtensions, Plugin};

pub(crate) fn builtin_light() -> Plugin {
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
            extensions: ManifestExtensions::default(),
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

pub(crate) fn builtin_gruvbox_light() -> Plugin {
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
            extensions: ManifestExtensions::default(),
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

pub(crate) fn builtin_solarized_light() -> Plugin {
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
            extensions: ManifestExtensions::default(),
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

pub(crate) fn builtin_catppuccin_latte() -> Plugin {
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
            extensions: ManifestExtensions::default(),
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

pub(crate) fn builtin_tokyo_light() -> Plugin {
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
            extensions: ManifestExtensions::default(),
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
