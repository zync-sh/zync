use tauri::AppHandle;
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
    let data_dir = get_data_dir(app);
    if data_dir.as_os_str().is_empty() {
        #[cfg(debug_assertions)]
        eprintln!("[zync/ai] get_data_dir() returned an empty path, using defaults");
        return merge_secret_keys(app, default_ai_config());
    }
    let settings_path = data_dir.join("settings.json");

    if let Ok(data) = std::fs::read_to_string(settings_path) {
        match serde_json::from_str::<serde_json::Value>(&data) {
            Ok(settings) => {
                if let Some(ai) = settings.get("ai") {
                    match serde_json::from_value::<AiConfig>(ai.clone()) {
                        Ok(config) => return merge_secret_keys(app, config),
                        #[cfg(debug_assertions)]
                        Err(e) => eprintln!("[zync/ai] Failed to parse AI config: {e}"),
                        #[cfg(not(debug_assertions))]
                        Err(_) => {}
                    }
                } else {
                    #[cfg(debug_assertions)]
                    eprintln!("[zync/ai] settings.json has no 'ai' key, using defaults");
                }
            }
            #[cfg(debug_assertions)]
            Err(e) => eprintln!("[zync/ai] settings.json is not valid JSON: {e}"),
            #[cfg(not(debug_assertions))]
            Err(_) => {}
        }
    }

    merge_secret_keys(app, default_ai_config())
}
