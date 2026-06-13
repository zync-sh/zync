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

pub async fn load_allowlisted_settings(
    app: &tauri::AppHandle,
    previous: Option<&SettingsSyncRecord>,
) -> Result<SettingsSyncRecord, String> {
    let settings: serde_json::Value = crate::commands::settings_get(app.clone()).await?;
    let mut payload = serde_json::Map::new();
    let obj = settings
        .as_object()
        .ok_or_else(|| "[sync_settings_invalid] settings_get returned non-object JSON".to_string())?;
    for key in SETTINGS_ALLOWLIST_KEYS {
        if let Some(value) = obj.get(*key) {
            payload.insert((*key).to_string(), value.clone());
        }
    }
    let payload = serde_json::Value::Object(payload);
    let updated_at = previous
        .filter(|record| record.payload == payload)
        .map(|record| record.updated_at)
        .unwrap_or_else(now_secs);
    Ok(SettingsSyncRecord {
        logical_id: "app-settings-default".to_string(),
        payload,
        updated_at,
    })
}
