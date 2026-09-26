use super::super::super::{Manifest, ManifestExtensions, Plugin};

pub(crate) fn builtin_synthwave() -> Plugin {
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
            extensions: ManifestExtensions::default(),
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

pub(crate) fn builtin_nordic() -> Plugin {
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
            extensions: ManifestExtensions::default(),
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
