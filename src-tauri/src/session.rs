use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;
use tauri::AppHandle;

mod docking;
mod main_tab_presentation;
mod recovery;

#[cfg(test)]
use main_tab_presentation::is_pinned as main_tab_is_pinned;
use main_tab_presentation::{
    ensure_supported as ensure_supported_main_tab_presentation,
    normalize_tabs as normalize_main_tab_presentations,
    BACKUP_NAME as MAIN_TAB_PRESENTATION_BACKUP,
};
use recovery::secure_session_backup;

const SESSION_VERSION: u32 = 1;
/// Maximum terminal tabs persisted per connection scope.
const MAX_TABS_PER_SCOPE: usize = 20;
const UNSUPPORTED_VERSION: &str = "SESSION_UNSUPPORTED_VERSION";
const CONTENT_PRESENTATION_VERSION: u64 = 3;
const MAX_PRESENTATION_SCOPES: usize = 256;
const MAX_PRESENTATION_ITEMS_PER_SCOPE: usize = 256;

/// Each metadata upgrade gets its own bounded recovery copy; older copies stay untouched.
fn presentation_backup_name() -> String {
    format!("session.pre-content-presentation-v{CONTENT_PRESENTATION_VERSION}.json")
}

/// Serializes the on-disk version check and atomic replacement across native callers.
static SESSION_MUTATION_LOCK: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));

// ─── Data types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TerminalTabSnapshot {
    pub id: String,
    pub title: String,
    pub cwd: Option<String>,
    pub initial_path: Option<String>,
    pub is_synced: Option<bool>,
    pub shell_override: Option<String>,
    /// `false` for extra shells in a split (omitted / `None` = visible tab).
    pub tab_visible: Option<bool>,
}

/// Snapshot of a sidebar connection tab.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TabSnapshot {
    pub id: String,
    pub tab_type: String,
    pub title: String,
    pub connection_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vault_profile_id: Option<String>,
    /// Device-local VNC profile identity. Restoring a tab never restores its transport.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vnc_profile_id: Option<String>,
    /// Device-local serial profile identity; a restored tab waits for an explicit hardware open.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial_profile_id: Option<String>,
    /// User-facing alias only; never changes connection or content identity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_alias: Option<String>,
    /// Keep the raw envelope until validation, including an explicitly invalid null.
    #[serde(
        default,
        deserialize_with = "deserialize_present_json",
        skip_serializing_if = "Option::is_none"
    )]
    pub presentation: Option<serde_json::Value>,
    pub view: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionData {
    /// Incremented when the schema changes to allow forward-only migrations.
    pub version: u32,
    pub show_welcome_screen: Option<bool>,
    pub active_tab_id: Option<String>,
    pub active_connection_id: Option<String>,
    /// Full snapshots of open sidebar tabs in order.
    pub tabs: Vec<TabSnapshot>,
    /// Terminal tabs keyed by connection scope ("local" or connection ID).
    pub terminals: HashMap<String, Vec<TerminalTabSnapshot>>,
    /// Active terminal ID per connection scope.
    pub active_terminal_ids: HashMap<String, String>,
    /// Optional split groups per connection scope (`ownerTermId` → layout). Missing = one pane.
    #[serde(default)]
    pub pane_layouts: HashMap<String, serde_json::Value>,
    /// Versioned decoration only. Keep the envelope intact until its schema is checked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_presentation: Option<serde_json::Value>,
    /// Preserve the raw allocation envelope, including invalid explicit null, until validation.
    #[serde(
        default,
        deserialize_with = "deserialize_present_json",
        skip_serializing_if = "Option::is_none"
    )]
    pub workspace_docking: Option<serde_json::Value>,
}

// ─── Schema migration ────────────────────────────────────────────────────────

fn migrate(mut data: SessionData) -> Result<SessionData, String> {
    // v0 → v1: no structural changes needed, just stamp the version.
    if data.version == 0 {
        data.version = 1;
    }
    normalize_main_tab_presentations(&mut data.tabs)?;
    Ok(data)
}

fn deserialize_present_json<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<serde_json::Value>, D::Error> {
    serde_json::Value::deserialize(deserializer).map(Some)
}

fn ensure_supported_version(version: u64) -> Result<(), String> {
    if version > u64::from(SESSION_VERSION) {
        return Err(format!(
            "{}: session version {} is newer than supported version {}. \
             Session saving is disabled to preserve the existing file; use a newer Zync version.",
            UNSUPPORTED_VERSION, version, SESSION_VERSION
        ));
    }
    Ok(())
}

/// Reject metadata this reader cannot preserve rather than quietly dropping newer fields.
/// These bounded rules mirror v1 aliases, v2 instance pins/order and v3 visibility.
fn ensure_supported_presentation(raw: Option<&serde_json::Value>) -> Result<(), String> {
    let Some(raw) = raw.filter(|value| !value.is_null()) else {
        return Ok(());
    };
    let unsupported = || {
        format!("{}: unsupported content presentation metadata. Session saving is disabled to preserve the existing file.", UNSUPPORTED_VERSION)
    };
    let scopes = raw.as_object().ok_or_else(unsupported)?;
    if scopes.len() > MAX_PRESENTATION_SCOPES {
        return Err(unsupported());
    }
    for (scope_id, scope) in scopes {
        if scope_id.trim().is_empty() || scope_id.encode_utf16().count() > 256 {
            return Err(unsupported());
        }
        let scope = scope.as_object().ok_or_else(unsupported)?;
        let version = scope
            .get("version")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(unsupported)?;
        if !(1..=CONTENT_PRESENTATION_VERSION).contains(&version)
            || scope
                .keys()
                .any(|key| key != "version" && key != "items" && !(version >= 2 && key == "order"))
        {
            return Err(unsupported());
        }
        let items = scope
            .get("items")
            .and_then(serde_json::Value::as_object)
            .ok_or_else(unsupported)?;
        if items.len() > MAX_PRESENTATION_ITEMS_PER_SCOPE {
            return Err(unsupported());
        }
        let mut known_keys: HashSet<&str> = items.keys().map(String::as_str).collect();
        if let Some(order) = scope.get("order") {
            let order = order.as_array().ok_or_else(unsupported)?;
            if order.len() > MAX_PRESENTATION_ITEMS_PER_SCOPE {
                return Err(unsupported());
            }
            let mut ordered_keys = HashSet::new();
            for key in order {
                let key = key.as_str().ok_or_else(unsupported)?;
                if !is_presentation_key(key) || !ordered_keys.insert(key) {
                    return Err(unsupported());
                }
                known_keys.insert(key);
            }
        }
        if known_keys.len() > MAX_PRESENTATION_ITEMS_PER_SCOPE {
            return Err(unsupported());
        }
        for (key, item) in items {
            if !is_presentation_key(key) {
                return Err(unsupported());
            }
            let item = item.as_object().ok_or_else(unsupported)?;
            if item.keys().any(|field| {
                field != "displayAlias"
                    && !(version >= 2 && field == "pinned")
                    && !(version >= 3 && field == "hidden")
            }) || item
                .get("displayAlias")
                .is_some_and(|alias| !alias.is_null() && !alias.is_string())
                || item
                    .get("pinned")
                    .is_some_and(|pinned| !pinned.is_boolean())
                || item
                    .get("hidden")
                    .is_some_and(|hidden| !hidden.is_boolean())
            {
                return Err(unsupported());
            }
        }
    }
    Ok(())
}

fn is_presentation_key(key: &str) -> bool {
    if key.encode_utf16().count() > 1024 {
        return false;
    }
    let Ok(identity) = serde_json::from_str::<Vec<String>>(key) else {
        return false;
    };
    serde_json::to_string(&identity).ok().as_deref() == Some(key)
        && identity.iter().all(|part| !part.trim().is_empty())
        && (matches!(identity.first().map(String::as_str), Some("term") if identity.len() == 2)
            || matches!(identity.first().map(String::as_str), Some("feature" | "plugin") if identity.len() == 3))
}

/// Check the envelope before typed parsing can drop fields or reject a future shape.
/// Corrupt JSON retains the existing empty-session fallback; an unknown version
/// is preserved rather than being treated as an empty, writable session.
fn decode_session(json: &str) -> Result<Option<SessionData>, String> {
    let Ok(raw) = serde_json::from_str::<serde_json::Value>(json) else {
        return Ok(None);
    };
    if let Some(version) = raw.get("version") {
        let version = version.as_u64().ok_or_else(|| {
            format!(
                "{}: session version is not a supported non-negative integer. \
                 Session saving is disabled to preserve the existing file.",
                UNSUPPORTED_VERSION
            )
        })?;
        ensure_supported_version(version)?;
    }
    ensure_supported_presentation(raw.get("contentPresentation"))?;
    docking::ensure_supported(raw.get("workspaceDocking"))?;
    if let Some(tabs) = raw.get("tabs").and_then(serde_json::Value::as_array) {
        for tab in tabs {
            ensure_supported_main_tab_presentation(tab.get("presentation"))?;
        }
    }
    serde_json::from_value::<SessionData>(raw)
        .ok()
        .map(migrate)
        .transpose()
}

async fn load_session_file(path: &Path) -> Result<Option<SessionData>, String> {
    match read_session_json(path).await? {
        Some(json) => decode_session(&json),
        None => Ok(None),
    }
}

async fn read_session_json(path: &Path) -> Result<Option<String>, String> {
    match tokio::fs::read_to_string(path).await {
        Ok(json) => Ok(Some(json)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn needs_presentation_backup(previous: &SessionData, next: &SessionData) -> bool {
    let next_has_current = next
        .content_presentation
        .as_ref()
        .and_then(serde_json::Value::as_object)
        .is_some_and(|scopes| {
            scopes.values().any(|scope| {
                scope.get("version").and_then(serde_json::Value::as_u64)
                    == Some(CONTENT_PRESENTATION_VERSION)
                    && (scope
                        .get("items")
                        .and_then(serde_json::Value::as_object)
                        .is_some_and(|items| !items.is_empty())
                        || scope
                            .get("order")
                            .and_then(serde_json::Value::as_array)
                            .is_some_and(|order| !order.is_empty()))
            })
        });
    let previous_is_legacy = previous
        .content_presentation
        .as_ref()
        .and_then(serde_json::Value::as_object)
        .is_none_or(|scopes| {
            scopes.is_empty()
                || scopes.values().any(|scope| {
                    scope
                        .get("version")
                        .and_then(serde_json::Value::as_u64)
                        .is_some_and(|version| version < CONTENT_PRESENTATION_VERSION)
                })
        });
    next_has_current && previous_is_legacy
}

/// Secure the original bytes once before upgrading presentation metadata.
/// This is a manual recovery copy, never an automatic rollback source.
async fn secure_presentation_backup(dir: &Path, original: &str) -> Result<(), String> {
    secure_session_backup(dir, original, &presentation_backup_name()).await
}

// ─── Tauri commands ───────────────────────────────────────────────────────────

/// Load the session snapshot from disk.
/// Returns `None` when no session file exists yet.
/// Corrupt content returns `None`; unknown versions return a stable error so the
/// frontend can start without restoring or overwriting an unsupported snapshot.
#[tauri::command]
pub async fn session_load(app: AppHandle) -> Result<Option<SessionData>, String> {
    load_session_file(&crate::commands::get_data_dir(&app).join("session.json")).await
}

/// Persist the session snapshot atomically (write to tmp → rename).
/// Enforces MAX_TABS_PER_SCOPE before writing.
#[tauri::command]
pub async fn session_save(app: AppHandle, data: SessionData) -> Result<(), String> {
    save_session_file(&crate::commands::get_data_dir(&app), data).await
}

/// Recheck the persisted envelope under the write lock, including saves before
/// startup restoration. Frontend suppression is not the data-loss boundary.
async fn save_session_file(dir: &Path, mut data: SessionData) -> Result<(), String> {
    let _guard = SESSION_MUTATION_LOCK.lock().await;
    ensure_supported_version(u64::from(data.version))?;
    ensure_supported_presentation(data.content_presentation.as_ref())?;
    docking::ensure_supported(data.workspace_docking.as_ref())?;
    for tab in &data.tabs {
        ensure_supported_main_tab_presentation(tab.presentation.as_ref())?;
    }
    let original = read_session_json(&dir.join("session.json")).await?;
    let previous = original
        .as_deref()
        .map(decode_session)
        .transpose()?
        .flatten();

    // Enforce per-scope tab cap before writing.
    for (scope, tabs) in data.terminals.iter_mut() {
        if tabs.len() > MAX_TABS_PER_SCOPE {
            eprintln!(
                "[Session] Truncating {} terminal tabs to {} for scope '{}'",
                tabs.len(),
                MAX_TABS_PER_SCOPE,
                scope
            );
            tabs.truncate(MAX_TABS_PER_SCOPE);
        }
    }
    data.version = SESSION_VERSION;
    normalize_main_tab_presentations(&mut data.tabs)?;

    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| format!("failed to create session directory {:?}: {}", dir, e))?;

    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    if let (Some(original), Some(previous)) = (original.as_deref(), previous.as_ref()) {
        if needs_presentation_backup(previous, &data) {
            secure_presentation_backup(dir, original).await?;
        }
        if docking::needs_backup(
            previous.workspace_docking.as_ref(),
            data.workspace_docking.as_ref(),
        ) {
            secure_session_backup(dir, original, docking::BACKUP_NAME).await?;
        }
        if main_tab_presentation::needs_backup(original, &data.tabs)? {
            secure_session_backup(dir, original, MAIN_TAB_PRESENTATION_BACKUP).await?;
        }
    }

    // Atomic write: write to a temp file then rename so a crash mid-write never
    // leaves a corrupt session.json. On Windows, tokio::fs::rename replaces an
    // existing destination atomically (same as POSIX on the same volume).
    let tmp = dir.join("session.tmp");
    tokio::fs::write(&tmp, &json)
        .await
        .map_err(|e| e.to_string())?;
    tokio::fs::rename(&tmp, dir.join("session.json"))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each fixture owns only its UUID-named temporary directory.
    struct SessionFixture(std::path::PathBuf);

    impl SessionFixture {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("zync-session-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for SessionFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn legacy_and_current_snapshots_remain_supported() {
        for json in [r#"{}"#, r#"{"version":0}"#, r#"{"version":1}"#] {
            assert_eq!(
                decode_session(json).unwrap().unwrap().version,
                SESSION_VERSION
            );
        }
        assert!(decode_session("not-json").unwrap().is_none());
    }

    #[test]
    fn version_is_checked_before_deserializing_future_fields() {
        for json in [
            r#"{"version":2,"tabs":{"newShape":true}}"#,
            r#"{"version":4294967296,"unknownFutureData":[1,2]}"#,
            r#"{"version":"future"}"#,
            r#"{"version":-1}"#,
        ] {
            assert!(decode_session(json)
                .unwrap_err()
                .starts_with(UNSUPPORTED_VERSION));
        }
    }

    #[tokio::test]
    async fn loading_and_saving_preserve_an_unsupported_file_byte_for_byte() {
        let fixture = SessionFixture::new();
        let path = fixture.0.join("session.json");
        let original = r#"{ "version": 2, "tabs": {"future":true}, "extra": [1,2,3] }"#;
        tokio::fs::write(&path, original).await.unwrap();
        assert!(load_session_file(&path)
            .await
            .unwrap_err()
            .starts_with(UNSUPPORTED_VERSION));
        assert!(save_session_file(&fixture.0, SessionData::default())
            .await
            .unwrap_err()
            .starts_with(UNSUPPORTED_VERSION));
        assert_eq!(tokio::fs::read_to_string(path).await.unwrap(), original);
        assert!(!fixture.0.join("session.tmp").exists());
    }

    #[tokio::test]
    async fn future_input_and_unreadable_destination_do_not_replace_existing_data() {
        let fixture = SessionFixture::new();
        let future = SessionData {
            version: SESSION_VERSION + 1,
            ..Default::default()
        };
        assert!(save_session_file(&fixture.0, future)
            .await
            .unwrap_err()
            .starts_with(UNSUPPORTED_VERSION));
        assert!(!fixture.0.join("session.json").exists());
        // A directory at the file path is an unreadable destination on all supported platforms.
        tokio::fs::create_dir(fixture.0.join("session.json"))
            .await
            .unwrap();
        assert!(save_session_file(&fixture.0, SessionData::default())
            .await
            .is_err());
        assert!(fixture.0.join("session.json").is_dir());
    }

    #[tokio::test]
    async fn supported_snapshots_roundtrip_metadata_and_enforce_the_terminal_cap() {
        let fixture = SessionFixture::new();
        let mut data = SessionData::default();
        data.tabs.push(TabSnapshot {
            id: "tab".into(),
            vault_profile_id: Some("fixture-profile".into()),
            display_alias: Some("My workspace".into()),
            ..Default::default()
        });
        data.tabs.push(TabSnapshot {
            id: "viewer".into(),
            tab_type: "vnc".into(),
            vnc_profile_id: Some("vnc-profile".into()),
            ..Default::default()
        });
        data.tabs.push(TabSnapshot {
            id: "serial".into(),
            tab_type: "serial".into(),
            serial_profile_id: Some("serial-profile".into()),
            ..Default::default()
        });
        data.terminals.insert(
            "local".into(),
            (0..MAX_TABS_PER_SCOPE + 3)
                .map(|i| TerminalTabSnapshot {
                    id: format!("term-{i}"),
                    ..Default::default()
                })
                .collect(),
        );
        save_session_file(&fixture.0, data).await.unwrap();
        let restored = load_session_file(&fixture.0.join("session.json"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(restored.version, SESSION_VERSION);
        assert_eq!(
            restored.tabs[0].vault_profile_id.as_deref(),
            Some("fixture-profile")
        );
        assert_eq!(
            restored.tabs[0].display_alias.as_deref(),
            Some("My workspace")
        );
        assert_eq!(
            restored.tabs[1].vnc_profile_id.as_deref(),
            Some("vnc-profile")
        );
        assert!(restored.tabs[1].connection_id.is_none());
        assert_eq!(restored.tabs[2].serial_profile_id.as_deref(), Some("serial-profile"));
        assert!(restored.tabs[2].connection_id.is_none());
        assert_eq!(restored.terminals["local"].len(), MAX_TABS_PER_SCOPE);
    }

    #[tokio::test]
    async fn concurrent_native_saves_do_not_race_on_the_temporary_file() {
        let fixture = SessionFixture::new();
        let first = SessionData {
            active_tab_id: Some("first".into()),
            ..Default::default()
        };
        let second = SessionData {
            active_tab_id: Some("second".into()),
            ..Default::default()
        };
        let (first_result, second_result) = tokio::join!(
            save_session_file(&fixture.0, first),
            save_session_file(&fixture.0, second),
        );
        first_result.unwrap();
        second_result.unwrap();
        let restored = load_session_file(&fixture.0.join("session.json"))
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            restored.active_tab_id.as_deref(),
            Some("first" | "second")
        ));
    }

    #[tokio::test]
    async fn content_presentation_roundtrips_without_creating_runtime_inventory() {
        let fixture = SessionFixture::new();
        let presentation = serde_json::json!({"local":{"version":1,"items":{"[\"term\",\"shell\"]":{"displayAlias":"Build shell"}}}});
        let data = SessionData {
            content_presentation: Some(presentation.clone()),
            ..Default::default()
        };
        save_session_file(&fixture.0, data).await.unwrap();
        let restored = load_session_file(&fixture.0.join("session.json"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(restored.content_presentation, Some(presentation));
        assert!(restored.terminals.is_empty());
        assert!(restored.pane_layouts.is_empty());
    }

    #[tokio::test]
    async fn unsupported_nested_presentation_is_preserved_on_load_and_save() {
        for presentation in [
            serde_json::json!({"local":{"version":4,"items":{}}}),
            serde_json::json!({"local":{"version":1,"items":{},"order":[]}}),
            serde_json::json!({"local":{"version":1,"items":{"[\"term\",\"shell\"]":{"pinned":true}}}}),
            serde_json::json!({"local":{"version":2,"items":{"[\"term\",\"shell\"]":{"hidden":true}}}}),
        ] {
            let fixture = SessionFixture::new();
            let path = fixture.0.join("session.json");
            let original =
                serde_json::json!({"version":1,"contentPresentation":presentation}).to_string();
            tokio::fs::write(&path, &original).await.unwrap();
            assert!(load_session_file(&path)
                .await
                .unwrap_err()
                .starts_with(UNSUPPORTED_VERSION));
            assert!(save_session_file(&fixture.0, SessionData::default())
                .await
                .unwrap_err()
                .starts_with(UNSUPPORTED_VERSION));
            assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), original);
            assert!(!fixture.0.join(presentation_backup_name()).exists());
        }
    }

    #[tokio::test]
    async fn v2_pins_and_dormant_order_roundtrip_without_live_instances() {
        let fixture = SessionFixture::new();
        let presentation = serde_json::json!({"local":{"version":2,"items":{"[\"term\",\"shell\"]":{"displayAlias":"Build","pinned":true}},"order":["[\"plugin\",\"owner:panel\",\"absent\"]","[\"term\",\"shell\"]"]}});
        save_session_file(
            &fixture.0,
            SessionData {
                content_presentation: Some(presentation.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let restored = load_session_file(&fixture.0.join("session.json"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(restored.content_presentation, Some(presentation));
        assert!(restored.terminals.is_empty());
        assert!(restored.pane_layouts.is_empty());
    }

    #[test]
    fn v2_rejects_invalid_flags_and_order_and_enforces_one_combined_key_budget() {
        let key = r#"["term","shell"]"#;
        for scope in [
            serde_json::json!({"version":2,"items":{key:{"pinned":null}}}),
            serde_json::json!({"version":2,"items":{key:{"pinned":"true"}}}),
            serde_json::json!({"version":2,"items":{},"order":null}),
            serde_json::json!({"version":2,"items":{},"order":[key,key]}),
            serde_json::json!({"version":2,"items":{},"order":["not-a-key"]}),
            serde_json::json!({"version":2,"items":{key:{"pinned":true}},"order":(0..MAX_PRESENTATION_ITEMS_PER_SCOPE).map(|i| format!("[\"term\",\"absent-{i}\"]")).collect::<Vec<_>>()}),
        ] {
            assert!(
                ensure_supported_presentation(Some(&serde_json::json!({"local":scope}))).is_err()
            );
        }
        assert!(ensure_supported_presentation(Some(
            &serde_json::json!({"local":{"version":2,"items":{key:{"pinned":false}}}})
        ))
        .is_ok());
    }

    fn current_presentation_snapshot() -> SessionData {
        SessionData {
            content_presentation: Some(
                serde_json::json!({"local":{"version":CONTENT_PRESENTATION_VERSION,"items":{"[\"term\",\"shell\"]":{"pinned":true,"hidden":true}}}}),
            ),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn v3_visibility_roundtrips_without_changing_runtime_inventory() {
        for hidden in [false, true] {
            let fixture = SessionFixture::new();
            let presentation = serde_json::json!({"local":{"version":3,"items":{"[\"term\",\"shell\"]":{"displayAlias":"Build","pinned":true,"hidden":hidden}},"order":["[\"term\",\"shell\"]"]}});
            save_session_file(
                &fixture.0,
                SessionData {
                    content_presentation: Some(presentation.clone()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            let restored = load_session_file(&fixture.0.join("session.json"))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(restored.content_presentation, Some(presentation));
            assert!(restored.terminals.is_empty());
            assert!(restored.pane_layouts.is_empty());
        }
    }

    #[test]
    fn visibility_flags_require_the_supported_schema_and_boolean_values() {
        let key = r#"["term","shell"]"#;
        for scope in [
            serde_json::json!({"version":1,"items":{key:{"hidden":true}}}),
            serde_json::json!({"version":2,"items":{key:{"hidden":false}}}),
            serde_json::json!({"version":3,"items":{key:{"hidden":null}}}),
            serde_json::json!({"version":3,"items":{key:{"hidden":"true"}}}),
            serde_json::json!({"version":4,"items":{key:{"hidden":true}}}),
        ] {
            assert!(
                ensure_supported_presentation(Some(&serde_json::json!({"local":scope}))).is_err()
            );
        }
    }

    #[tokio::test]
    async fn v2_upgrade_keeps_original_bytes_in_v3_copy_without_touching_v2_copy() {
        let fixture = SessionFixture::new();
        let original = "{ \"version\": 1, \"contentPresentation\": {\"local\": {\"version\":2, \"items\": {\"[\\\"term\\\",\\\"shell\\\"]\": {\"pinned\":true}}, \"order\":[\"[\\\"term\\\",\\\"shell\\\"]\"]}} }\r\n";
        let older_original = "{ \"version\": 1, \"activeTabId\": \"before-pinning\" }\n";
        let path = fixture.0.join("session.json");
        let older_backup = fixture.0.join("session.pre-content-presentation-v2.json");
        tokio::fs::write(&path, original).await.unwrap();
        tokio::fs::write(&older_backup, older_original)
            .await
            .unwrap();
        save_session_file(&fixture.0, current_presentation_snapshot())
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read(fixture.0.join("session.pre-content-presentation-v3.json"))
                .await
                .unwrap(),
            original.as_bytes()
        );
        assert_eq!(
            tokio::fs::read(older_backup).await.unwrap(),
            older_original.as_bytes()
        );
        assert_eq!(
            load_session_file(&path)
                .await
                .unwrap()
                .unwrap()
                .content_presentation,
            current_presentation_snapshot().content_presentation
        );
    }

    #[tokio::test]
    async fn first_upgrade_keeps_exact_original_bytes_and_never_replaces_the_backup() {
        let fixture = SessionFixture::new();
        let original = "{ \"version\": 1, \"contentPresentation\": {\"local\": {\"version\":1, \"items\": {\"[\\\"term\\\",\\\"shell\\\"]\": {\"displayAlias\":\"Original\"}}}} }\r\n";
        let path = fixture.0.join("session.json");
        tokio::fs::write(&path, original).await.unwrap();
        save_session_file(&fixture.0, current_presentation_snapshot())
            .await
            .unwrap();
        let backup = fixture.0.join(presentation_backup_name());
        assert_eq!(tokio::fs::read(&backup).await.unwrap(), original.as_bytes());
        save_session_file(&fixture.0, current_presentation_snapshot())
            .await
            .unwrap();
        // Even a later restored legacy snapshot cannot replace the first recovery copy.
        tokio::fs::write(&path, r#"{"version":0,"activeTabId":"later"}"#)
            .await
            .unwrap();
        save_session_file(&fixture.0, current_presentation_snapshot())
            .await
            .unwrap();
        assert_eq!(tokio::fs::read(&backup).await.unwrap(), original.as_bytes());
    }

    #[tokio::test]
    async fn backup_failure_preserves_the_original_and_invalid_existing_backup() {
        for directory in [false, true] {
            let fixture = SessionFixture::new();
            let path = fixture.0.join("session.json");
            let original = r#"{"version":1,"activeTabId":"original"}"#;
            tokio::fs::write(&path, original).await.unwrap();
            let backup = fixture.0.join(presentation_backup_name());
            if directory {
                tokio::fs::create_dir(&backup).await.unwrap();
            } else {
                tokio::fs::write(&backup, "not-json").await.unwrap();
            }
            assert!(
                save_session_file(&fixture.0, current_presentation_snapshot())
                    .await
                    .unwrap_err()
                    .starts_with("SESSION_BACKUP_FAILED")
            );
            assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), original);
            if directory {
                assert!(backup.is_dir());
            } else {
                assert_eq!(
                    tokio::fs::read_to_string(&backup).await.unwrap(),
                    "not-json"
                );
            }
            assert!(!fixture.0.join("session.tmp").exists());
        }
    }

    #[tokio::test]
    async fn current_version_and_fresh_sessions_do_not_access_the_recovery_destination() {
        let fixture = SessionFixture::new();
        // An unreadable backup path proves these cases do not inspect or replace it.
        let backup = fixture.0.join(presentation_backup_name());
        tokio::fs::create_dir(&backup).await.unwrap();
        save_session_file(&fixture.0, current_presentation_snapshot())
            .await
            .unwrap();
        save_session_file(&fixture.0, current_presentation_snapshot())
            .await
            .unwrap();
        assert!(backup.is_dir());
        assert!(load_session_file(&fixture.0.join("session.json"))
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn concurrent_backup_publication_preserves_one_complete_first_winner() {
        let fixture = SessionFixture::new();
        let first = "{ \"version\": 1, \"activeTabId\": \"first\" }\n";
        let second = "{ \"version\": 1, \"activeTabId\": \"second\" }\r\n";
        let (a, b) = tokio::join!(
            secure_presentation_backup(&fixture.0, first),
            secure_presentation_backup(&fixture.0, second)
        );
        a.unwrap();
        b.unwrap();
        let backup = fixture.0.join(presentation_backup_name());
        let winner = tokio::fs::read_to_string(&backup).await.unwrap();
        assert!(winner == first || winner == second);
        secure_presentation_backup(&fixture.0, r#"{"version":0}"#)
            .await
            .unwrap();
        assert_eq!(tokio::fs::read_to_string(backup).await.unwrap(), winner);
        let files: Vec<_> = std::fs::read_dir(&fixture.0).unwrap().collect();
        assert_eq!(
            files.len(),
            1,
            "Every staging name is removed after publication"
        );
    }

    fn pinned_tab_snapshot() -> SessionData {
        SessionData {
            tabs: vec![TabSnapshot {
                id: "pinned".into(),
                presentation: Some(serde_json::json!({"version":2,"pinned":true})),
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    #[test]
    fn main_tab_metadata_normalizes_flags_and_stably_partitions_order() {
        let data = decode_session(
            r#"{"version":1,"tabs":[
            {"id":"a"},{"id":"b","presentation":{"version":1,"pinned":true}},
            {"id":"c","presentation":{"version":1,"pinned":false}},
            {"id":"d","presentation":{"version":1,"pinned":true}},
            {"id":"e","presentation":{"version":1}}]}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            data.tabs
                .iter()
                .map(|tab| tab.id.as_str())
                .collect::<Vec<_>>(),
            ["b", "d", "a", "c", "e"]
        );
        assert!(data.tabs[..2].iter().all(main_tab_is_pinned));
        assert!(data.tabs[2..].iter().all(|tab| tab.presentation.is_none()));
    }

    #[tokio::test]
    async fn unsupported_main_tab_metadata_preserves_disk_and_rejects_input() {
        let cases: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../tests/fixtures/mainTabPresentation.json"
        ))
        .unwrap();
        for metadata in cases
            .into_iter()
            .filter(|case| case["valid"] == false)
            .map(|case| case["value"].clone())
        {
            let fixture = SessionFixture::new();
            let path = fixture.0.join("session.json");
            let original =
                serde_json::json!({"version":1,"tabs":[{"id":"future","presentation":metadata}]})
                    .to_string();
            tokio::fs::write(&path, &original).await.unwrap();
            assert!(load_session_file(&path)
                .await
                .unwrap_err()
                .starts_with(UNSUPPORTED_VERSION));
            assert!(save_session_file(&fixture.0, SessionData::default())
                .await
                .unwrap_err()
                .starts_with(UNSUPPORTED_VERSION));
            assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), original);
            // Exercise the Tauri typed-input boundary, including explicit null.
            let input: SessionData = serde_json::from_str(&original).unwrap();
            let fresh = SessionFixture::new();
            assert!(save_session_file(&fresh.0, input)
                .await
                .unwrap_err()
                .starts_with(UNSUPPORTED_VERSION));
            assert!(!fresh.0.join("session.json").exists());
        }
    }

    #[tokio::test]
    async fn main_tab_upgrade_secures_separate_exact_backup_once() {
        let fixture = SessionFixture::new();
        let original = "{ \"version\": 1, \"tabs\": [{\"id\":\"original\"}] }\r\n";
        tokio::fs::write(fixture.0.join("session.json"), original)
            .await
            .unwrap();
        let content_backup = fixture.0.join(presentation_backup_name());
        tokio::fs::write(&content_backup, "{\"earlier\":true}")
            .await
            .unwrap();
        save_session_file(&fixture.0, pinned_tab_snapshot())
            .await
            .unwrap();
        let backup = fixture.0.join(MAIN_TAB_PRESENTATION_BACKUP);
        assert_eq!(tokio::fs::read(&backup).await.unwrap(), original.as_bytes());
        assert_eq!(
            tokio::fs::read_to_string(&content_backup).await.unwrap(),
            "{\"earlier\":true}"
        );
        assert!(load_session_file(&fixture.0.join("session.json"))
            .await
            .unwrap()
            .unwrap()
            .tabs
            .iter()
            .any(main_tab_is_pinned));
        save_session_file(&fixture.0, SessionData::default())
            .await
            .unwrap();
        save_session_file(&fixture.0, pinned_tab_snapshot())
            .await
            .unwrap();
        assert_eq!(tokio::fs::read(&backup).await.unwrap(), original.as_bytes());
    }

    #[tokio::test]
    async fn main_tab_v1_upgrade_backs_up_original_before_decoded_migration() {
        let fixture = SessionFixture::new();
        let path = fixture.0.join("session.json");
        let original = "{ \"version\":1, \"tabs\":[{\"id\":\"legacy\",\"presentation\":{\"version\":1,\"pinned\":true}}] }\r\n";
        tokio::fs::write(&path, original).await.unwrap();
        let old_backup = fixture.0.join("session.pre-main-tab-presentation-v1.json");
        let old_bytes = b"{\"version\":1,\"tabs\":[]}\n";
        tokio::fs::write(&old_backup, old_bytes).await.unwrap();
        let decoded = load_session_file(&path).await.unwrap().unwrap();
        assert_eq!(decoded.tabs[0].presentation.as_ref().unwrap()["version"], 2);
        // Loading alone is read-only; saving must still recognize original v1 bytes.
        assert_eq!(tokio::fs::read(&path).await.unwrap(), original.as_bytes());
        save_session_file(&fixture.0, decoded.clone())
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read(fixture.0.join(MAIN_TAB_PRESENTATION_BACKUP))
                .await
                .unwrap(),
            original.as_bytes()
        );
        assert_eq!(tokio::fs::read(old_backup).await.unwrap(), old_bytes);
        save_session_file(&fixture.0, decoded).await.unwrap();
        assert_eq!(
            tokio::fs::read(fixture.0.join(MAIN_TAB_PRESENTATION_BACKUP))
                .await
                .unwrap(),
            original.as_bytes()
        );
    }

    #[tokio::test]
    async fn unpinned_main_tab_decoration_round_trips_without_changing_resource_identity() {
        let fixture = SessionFixture::new();
        let path = fixture.0.join("session.json");
        let original =
            r#"{"version":1,"tabs":[{"id":"same","connectionId":"host","title":"Host"}]}"#;
        tokio::fs::write(&path, original).await.unwrap();
        let mut data = load_session_file(&path).await.unwrap().unwrap();
        data.tabs[0].presentation = Some(
            serde_json::json!({"version":2,"pinned":false,"icon":"star","accent":"#ABCDEF","closeButton":"hidden"}),
        );
        save_session_file(&fixture.0, data).await.unwrap();
        let restored = load_session_file(&path).await.unwrap().unwrap();
        assert_eq!(restored.tabs[0].id, "same");
        assert_eq!(restored.tabs[0].connection_id.as_deref(), Some("host"));
        assert_eq!(restored.tabs[0].title, "Host");
        assert_eq!(
            restored.tabs[0].presentation,
            Some(
                serde_json::json!({"version":2,"icon":"star","accent":"#abcdef","closeButton":"hidden"})
            )
        );
        assert_eq!(
            tokio::fs::read(fixture.0.join(MAIN_TAB_PRESENTATION_BACKUP))
                .await
                .unwrap(),
            original.as_bytes()
        );
    }

    #[tokio::test]
    async fn main_tab_invalid_backup_fails_without_replacing_session() {
        for invalid in ["not-json", "[]", "null"] {
            let fixture = SessionFixture::new();
            let path = fixture.0.join("session.json");
            let original = r#"{"version":1,"tabs":[]}"#;
            tokio::fs::write(&path, original).await.unwrap();
            let backup = fixture.0.join(MAIN_TAB_PRESENTATION_BACKUP);
            tokio::fs::write(&backup, invalid).await.unwrap();
            assert!(save_session_file(&fixture.0, pinned_tab_snapshot())
                .await
                .unwrap_err()
                .starts_with("SESSION_BACKUP_FAILED"));
            assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), original);
            assert_eq!(tokio::fs::read_to_string(&backup).await.unwrap(), invalid);
            assert!(!fixture.0.join("session.tmp").exists());
        }
    }

    #[tokio::test]
    async fn fresh_and_already_pinned_snapshots_need_no_upgrade_copy() {
        let fixture = SessionFixture::new();
        save_session_file(&fixture.0, pinned_tab_snapshot())
            .await
            .unwrap();
        save_session_file(&fixture.0, pinned_tab_snapshot())
            .await
            .unwrap();
        assert!(!fixture.0.join(MAIN_TAB_PRESENTATION_BACKUP).exists());
        let restored = load_session_file(&fixture.0.join("session.json"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            restored.tabs[0].presentation,
            pinned_tab_snapshot().tabs[0].presentation
        );
    }

    fn docked_snapshot() -> SessionData {
        SessionData {
            version: SESSION_VERSION,
            workspace_docking: Some(
                serde_json::json!({"local":{"version":1,"placements":{"[\"term\",\"shell\"]":"bottom-panel"}}}),
            ),
            ..SessionData::default()
        }
    }

    #[tokio::test]
    async fn first_docking_save_secures_exact_original_once_and_roundtrips() {
        let fixture = SessionFixture::new();
        let path = fixture.0.join("session.json");
        let original = "{ \"version\": 1, \"tabs\": [] }\r\n";
        tokio::fs::write(&path, original).await.unwrap();
        save_session_file(&fixture.0, docked_snapshot())
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read_to_string(fixture.0.join(docking::BACKUP_NAME))
                .await
                .unwrap(),
            original
        );
        save_session_file(&fixture.0, docked_snapshot())
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read_to_string(fixture.0.join(docking::BACKUP_NAME))
                .await
                .unwrap(),
            original
        );
        assert_eq!(
            load_session_file(&path)
                .await
                .unwrap()
                .unwrap()
                .workspace_docking,
            docked_snapshot().workspace_docking
        );
        assert!(!fixture.0.join(MAIN_TAB_PRESENTATION_BACKUP).exists());
    }

    #[tokio::test]
    async fn invalid_docking_backup_preserves_original_session() {
        let fixture = SessionFixture::new();
        let path = fixture.0.join("session.json");
        let original = "{\"version\":1}";
        tokio::fs::write(&path, original).await.unwrap();
        tokio::fs::write(fixture.0.join(docking::BACKUP_NAME), "partial")
            .await
            .unwrap();
        assert!(save_session_file(&fixture.0, docked_snapshot())
            .await
            .unwrap_err()
            .starts_with("SESSION_BACKUP_FAILED"));
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), original);
        assert_eq!(
            tokio::fs::read_to_string(fixture.0.join(docking::BACKUP_NAME))
                .await
                .unwrap(),
            "partial"
        );
        assert!(!fixture.0.join("session.tmp").exists());
    }

    #[tokio::test]
    async fn future_or_null_docking_is_preserved_on_load_and_save() {
        for metadata in [
            serde_json::Value::Null,
            serde_json::json!({"local":{"version":2,"placements":{}}}),
        ] {
            let fixture = SessionFixture::new();
            let path = fixture.0.join("session.json");
            let original = serde_json::json!({"version":1,"workspaceDocking":metadata}).to_string();
            tokio::fs::write(&path, &original).await.unwrap();
            assert!(load_session_file(&path)
                .await
                .unwrap_err()
                .starts_with(UNSUPPORTED_VERSION));
            assert!(save_session_file(&fixture.0, SessionData::default())
                .await
                .unwrap_err()
                .starts_with(UNSUPPORTED_VERSION));
            assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), original);
            let fresh = SessionFixture::new();
            let incoming: SessionData = serde_json::from_str(&original).unwrap();
            assert!(save_session_file(&fresh.0, incoming)
                .await
                .unwrap_err()
                .starts_with(UNSUPPORTED_VERSION));
            assert!(!fresh.0.join("session.json").exists());
        }
    }

    #[tokio::test]
    async fn fresh_docking_snapshot_needs_no_recovery_copy() {
        let fixture = SessionFixture::new();
        save_session_file(&fixture.0, docked_snapshot())
            .await
            .unwrap();
        assert!(!fixture.0.join(docking::BACKUP_NAME).exists());
    }
}
