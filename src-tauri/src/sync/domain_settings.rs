#![allow(dead_code)]

use super::profiles::now_secs;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSyncRecord {
    pub logical_id: String,
    pub payload: serde_json::Value,
    pub updated_at: u64,
}

pub const SETTINGS_ALLOWLIST_KEYS: &[&str] = &[
    "theme",
    "fontFamily",
    "fontSize",
    "showHiddenFiles",
    "confirmOnExit",
    "editorTheme",
    "terminalFontSize",
];

pub async fn load_allowlisted_settings(app: &tauri::AppHandle) -> Result<SettingsSyncRecord, String> {
    let settings: serde_json::Value = crate::commands::settings_get(app.clone()).await?;
    let mut payload = serde_json::Map::new();
    let obj = settings.as_object().cloned().unwrap_or_default();
    for key in SETTINGS_ALLOWLIST_KEYS {
        if let Some(value) = obj.get(*key) {
            payload.insert((*key).to_string(), value.clone());
        }
    }
    Ok(SettingsSyncRecord {
        logical_id: "app-settings-default".to_string(),
        payload: serde_json::Value::Object(payload),
        updated_at: now_secs(),
    })
}

