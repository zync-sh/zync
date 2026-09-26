use super::super::super::{Manifest, ManifestExtensions, Plugin};

pub(crate) fn builtin_dark() -> Plugin {
    Plugin {
        path: "builtin://dark".to_string(),
        manifest: Manifest {
            id: "com.zync.theme.dark".to_string(),
            name: "Dark Theme".to_string(),
            version: "1.0.0".to_string(),
            main: None,
            style: Some("theme.css".to_string()),
            mode: Some("dark".to_string()),
            preview_bg: Some("#09090b".to_string()),
            preview_accent: Some("#797bce".to_string()),
            icon: None,
            manifest_type: None,
            icons_path: None,
            editor: None,
            extensions: ManifestExtensions::default(),
        },
        script: None,
        style: Some(
            r#"
            [data-theme='dark'] {
                --color-app-bg: #09090b;
                --color-app-panel: #18181b;
                --color-app-surface: #27272a;
                --color-app-border: #27272a;
                --color-app-text: #e4e4e7;
                --color-app-muted: #a1a1aa;
                --color-app-accent: #797bce;
            }
        "#
            .to_string(),
        ),
        editor_html: None,
        enabled: true,
    }
}

pub(crate) fn builtin_dracula() -> Plugin {
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
            extensions: ManifestExtensions::default(),
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

pub(crate) fn builtin_monokai() -> Plugin {
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
            extensions: ManifestExtensions::default(),
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

pub(crate) fn builtin_midnight() -> Plugin {
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
            extensions: ManifestExtensions::default(),
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

pub(crate) fn builtin_monokai_pro() -> Plugin {
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
            extensions: ManifestExtensions::default(),
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
