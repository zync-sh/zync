use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

use crate::ai::AiConfig;
use crate::commands::get_data_dir;

const PROVIDERS: [&str; 5] = ["gemini", "openai", "claude", "groq", "mistral"];

fn merge_secret_keys(app: &AppHandle, mut config: AiConfig) -> AiConfig {
    let mut merged_keys = config.keys.take().unwrap_or_default();
    if let Ok(store) = app.store("secrets.json") {
        for provider in PROVIDERS {
            if let Some(value) = store
                .get(provider)
                .and_then(|v| v.as_str().map(|s| s.to_string()))
            {
                if !value.is_empty() {
                    merged_keys.insert(provider.to_string(), value);
                }
            }
        }
    }
    config.keys = if merged_keys.is_empty() {
        None
    } else {
        Some(merged_keys)
    };
    config
}

fn default_ai_config() -> AiConfig {
    AiConfig {
        provider: "ollama".to_string(),
        keys: None,
        model: None,
        ollama_url: Some("http://localhost:11434".to_string()),
        enabled: true,
    }
}

pub fn read_ai_config(app: &AppHandle) -> AiConfig {
    let settings_path = match app.path().config_dir() {
        Ok(config_dir) => {
            let candidate = config_dir.join("Zync").join("User").join("settings.json");
            if candidate.exists() {
                candidate
            } else {
                get_data_dir(app).join("settings.json")
            }
        }
        Err(_) => get_data_dir(app).join("settings.json"),
    };

    if let Ok(data) = std::fs::read_to_string(&settings_path) {
        match serde_json::from_str::<serde_json::Value>(&data) {
            Ok(settings) => {
                if let Some(ai) = settings.get("ai") {
                    match serde_json::from_value::<AiConfig>(ai.clone()) {
                        Ok(config) => return merge_secret_keys(app, config),
                        #[cfg(debug_assertions)]
                        Err(e) => eprintln!(
                            "[zync/ai] Failed to parse AI config from {}: {e}",
                            settings_path.display()
                        ),
                        #[cfg(not(debug_assertions))]
                        Err(_) => {}
                    }
                } else {
                    #[cfg(debug_assertions)]
                    eprintln!(
                        "[zync/ai] settings.json at {} has no 'ai' key, using defaults",
                        settings_path.display()
                    );
                }
            }
            #[cfg(debug_assertions)]
            Err(e) => eprintln!(
                "[zync/ai] settings.json at {} is not valid JSON: {e}",
                settings_path.display()
            ),
            #[cfg(not(debug_assertions))]
            Err(_) => {}
        }
    }

    merge_secret_keys(app, default_ai_config())
}
