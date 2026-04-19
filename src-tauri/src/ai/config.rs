use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use crate::ai::AiConfig;
use crate::commands::read_effective_settings;

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
    match read_effective_settings(app) {
        Ok(settings) => {
            if let Some(ai) = settings.get("ai") {
                match serde_json::from_value::<AiConfig>(ai.clone()) {
                    Ok(config) => return merge_secret_keys(app, config),
                    #[cfg(debug_assertions)]
                    Err(e) => eprintln!("[zync/ai] Failed to parse AI config from effective settings: {e}"),
                    #[cfg(not(debug_assertions))]
                    Err(_) => {}
                }
            } else {
                #[cfg(debug_assertions)]
                eprintln!("[zync/ai] effective settings has no 'ai' key, using defaults");
            }
        }
        #[cfg(debug_assertions)]
        Err(e) => eprintln!("[zync/ai] Failed to read effective settings: {e}"),
        #[cfg(not(debug_assertions))]
        Err(_) => {}
    }

    merge_secret_keys(app, default_ai_config())
}
