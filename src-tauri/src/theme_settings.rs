//! Portable theme colors and fixed-field atomic application; no arbitrary CSS or settings writes.
use serde_json::{json, Map, Value};
use std::sync::LazyLock;

static PALETTE: LazyLock<Map<String, Value>> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../src/features/appearance/domain/themePaletteCatalog.json"
    ))
    .expect("bundled theme palette must be valid")
});

// Deliberately do not use Rust's Unicode trim: U+0085 and U+FEFF differ from JS.
static NAME_WHITESPACE: LazyLock<String> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../src/features/appearance/domain/themeNameWhitespace.json"))
        .expect("bundled theme name whitespace must be valid")
});

pub(crate) fn normalize(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    if object.len() != 6
        || value["format"].as_str() != Some("zync-theme")
        || value["version"].as_f64() != Some(1.0)
    {
        return None;
    }
    let name = value["name"].as_str()?;
    if name.chars().any(|c| c.is_ascii_control()) {
        return None;
    }
    let name = name.trim_matches(|ch| NAME_WHITESPACE.contains(ch));
    if name.is_empty() || name.encode_utf16().count() > 80 {
        return None;
    }
    let mode = value["mode"].as_str()?;
    if !matches!(mode, "light" | "dark") {
        return None;
    }
    let input = value["palette"].as_object()?;
    if input.len() != PALETTE.len() {
        return None;
    }
    let mut palette = Map::new();
    for key in PALETTE.keys() {
        let color = input.get(key)?.as_str()?;
        if color.len() != 7
            || !color.starts_with('#')
            || !color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
        {
            return None;
        }
        palette.insert(key.clone(), Value::String(color.to_ascii_lowercase()));
    }
    let elements = crate::element_color_settings::normalize(object.get("elements")?)?;
    Some(
        json!({"format":"zync-theme","version":1,"name":name,"mode":mode,"palette":palette,"elements":elements}),
    )
}

fn snapshot(settings: &Value) -> Value {
    json!({"theme":settings.get("theme").cloned().unwrap_or(json!("dark")),
        "accentColor":settings.get("accentColor").cloned().unwrap_or(Value::Null),
        "customTheme":settings.get("customTheme").cloned().unwrap_or(Value::Null),
        "elementColors":settings.get("elementColors").cloned().unwrap_or(Value::Null)})
}
fn normalize_snapshot(value: &Value) -> Option<Value> {
    if value.as_object()?.len() != 4
        || !value["theme"].is_string()
        || !(value["accentColor"].is_null() || value["accentColor"].is_string())
    {
        return None;
    }
    let custom = value.get("customTheme")?;
    let elements = value.get("elementColors")?;
    Some(
        json!({"theme":value["theme"],"accentColor":value.get("accentColor")?,
        "customTheme":if custom.is_null() { Value::Null } else { normalize(custom)? },
        "elementColors":if elements.is_null() { Value::Null } else { crate::element_color_settings::normalize(elements)? }}),
    )
}

pub(crate) fn validate_managed_patch(current: &Value, patch: &Value) -> Result<(), String> {
    if let Some(next) = patch.get("customTheme") {
        if current.get("customTheme") != Some(next) {
            return Err("Use theme import to change the custom theme.".into());
        }
    }
    Ok(())
}

/// Derive an explicit theme's global colors after validating the caller's original patch.
/// Keep the saved custom document and all non-theme fields; the caller replaces the
/// derived element envelope atomically rather than deep-merging its override map.
pub(crate) fn prepare_theme_selection_patch(
    current: &Value,
    mut patch: Value,
) -> Result<Value, String> {
    let Some(theme) = patch.get("theme") else {
        return Ok(patch);
    };
    let theme = theme.as_str().ok_or("Choose a valid theme.")?;
    if current.get("elementColors").is_some_and(|value| {
        !value.is_null() && crate::element_color_settings::normalize(value).is_none()
    }) {
        return Err("Element colors use an unsupported format. Review settings.json before changing the theme.".into());
    }
    let elements = if theme == "custom" {
        current
            .get("customTheme")
            .and_then(normalize)
            .ok_or("Import a valid custom theme first.")?["elements"]
            .clone()
    } else {
        json!({"version": 1, "overrides": {}})
    };
    patch["accentColor"] = Value::Null;
    patch["elementColors"] = elements;
    Ok(patch)
}

/// Ordinary theme/accent edits participate in the same boundary so an earlier request
/// cannot overwrite a later import. Other generic settings remain outside this contract.
pub(crate) fn validate_theme_patch(
    current: &Value,
    patch: &Value,
    expected: Option<&Value>,
) -> Result<(), String> {
    if patch.get("theme").is_none() && patch.get("accentColor").is_none() {
        return Ok(());
    }
    let expected = expected.ok_or("Theme edits require the current theme snapshot.")?;
    let now = snapshot(current);
    if expected
        .as_object()
        .map_or(true, |object| object.len() != 4)
        || !expected["theme"].is_string()
        || !(expected["accentColor"].is_string() || expected["accentColor"].is_null())
        || expected.get("accentColor").is_none()
        || expected.get("customTheme").is_none()
        || expected.get("elementColors").is_none()
    {
        return Err("Theme/colors changed. Refresh settings before saving again.".into());
    }
    // A lost acknowledgement may be retried against its original snapshot only
    // when the exact derived selection is still current. A later import or color
    // edit must never be erased by that retry.
    let identical_retry = now["customTheme"] == expected["customTheme"]
        && if patch.get("theme").is_some() {
            prepare_theme_selection_patch(expected, patch.clone()).is_ok_and(|selected| {
                selected["theme"] == now["theme"]
                    && selected["accentColor"] == now["accentColor"]
                    && selected["elementColors"] == now["elementColors"]
            })
        } else {
            now["theme"] == expected["theme"]
                && now["elementColors"] == expected["elementColors"]
                && patch.get("accentColor").unwrap_or(&expected["accentColor"])
                    == &now["accentColor"]
        };
    if expected != &now && !identical_retry {
        return Err("Theme/colors changed. Refresh settings before saving again.".into());
    }
    if patch.get("theme").and_then(Value::as_str) == Some("custom")
        && current.get("customTheme").and_then(normalize).is_none()
    {
        return Err("Import a valid custom theme first.".into());
    }
    Ok(())
}

/// Caller owns SETTINGS_MUTATION_LOCK. Four fields persist together, preserving unrelated data.
pub(crate) fn replacement(
    current: &Value,
    expected: &Value,
    value: &Value,
) -> Result<Option<Value>, String> {
    if !current.is_object() {
        return Err("Settings must be an object.".into());
    }
    if current
        .get("customTheme")
        .is_some_and(|v| normalize(v).is_none())
        || current
            .get("elementColors")
            .is_some_and(|v| crate::element_color_settings::normalize(v).is_none())
    {
        return Err("Unsupported theme/color preferences; nothing was replaced.".into());
    }
    let theme = normalize(value).ok_or("Invalid Zync theme.")?;
    let now = normalize_snapshot(&snapshot(current)).ok_or("Invalid current theme settings.")?;
    let expected = normalize_snapshot(expected).ok_or("Invalid expected theme settings.")?;
    let next = json!({"theme":"custom","accentColor":null,"customTheme":theme,"elementColors":theme["elements"]});
    if now == next {
        return Ok(None);
    } // Safe retry after lost acknowledgement.
    if now != expected {
        return Err("Theme/colors changed. Refresh settings before applying again.".into());
    }
    let mut merged = current.clone();
    for (key, value) in next.as_object().unwrap() {
        merged[key] = value.clone();
    }
    Ok(Some(merged))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../tests/fixtures/themeDocument.json")).unwrap()
    }

    #[test]
    fn shared_name_normalization_keeps_import_and_later_theme_edits_equivalent() {
        let fixture = fixture();
        for sample in fixture["names"].as_array().unwrap() {
            let mut theme = fixture["theme"].clone(); theme["name"] = sample["input"].clone();
            assert_eq!(normalize(&theme).unwrap()["name"], sample["output"]);
            let original = json!({"theme":"dark"});
            let saved = replacement(&original, &snapshot(&original), &theme).unwrap().unwrap();
            assert!(validate_theme_patch(&saved, &json!({"theme":"light"}), Some(&snapshot(&saved))).is_ok());
        }
        for edge in NAME_WHITESPACE.chars() {
            let mut theme = fixture["theme"].clone(); theme["name"] = json!(format!("{edge}Ocean{edge}"));
            assert_eq!(normalize(&theme).unwrap()["name"], "Ocean");
        }
    }

    #[test]
    fn identical_theme_retry_is_safe_but_never_crosses_a_newer_import() {
        let before = json!({"theme":"dark"}); let after = json!({"theme":"light","accentColor":null,"elementColors":{"version":1,"overrides":{}}});
        let patch = json!({"theme":"light","accentColor":null});
        assert!(validate_theme_patch(&after, &patch, Some(&snapshot(&before))).is_ok());
        let imported = replacement(&after, &snapshot(&after), &fixture()["theme"]).unwrap().unwrap();
        assert!(validate_theme_patch(&imported, &patch, Some(&snapshot(&before))).is_err());
        assert!(validate_theme_patch(&after, &patch, Some(&json!({"theme":"dark","accentColor":null,"extra":null,"elementColors":null}))).is_err());
    }

    #[test]
    fn renderer_and_native_share_color_contract() {
        let fixture = fixture();
        let valid = normalize(&fixture["theme"]).unwrap();
        assert_eq!(valid["elements"]["overrides"]["terminal.cursor"], "#abcdef");
        assert_eq!(normalize(&valid), Some(valid));
        for case in fixture["invalid"].as_array().unwrap() {
            let mut value = fixture["theme"].clone();
            let path = case["path"].as_array().unwrap();
            let mut parent = &mut value;
            for key in &path[..path.len() - 1] {
                parent = &mut parent[key.as_str().unwrap()];
            }
            parent[path.last().unwrap().as_str().unwrap()] = case["value"].clone();
            assert!(normalize(&value).is_none(), "{}", case);
        }
        for key in ["format", "version", "name", "mode", "palette", "elements"] {
            let mut value = fixture["theme"].clone();
            value.as_object_mut().unwrap().remove(key);
            assert!(normalize(&value).is_none());
        }
        let mut value = fixture["theme"].clone();
        value["name"] = json!("😀".repeat(41));
        assert!(normalize(&value).is_none());
    }

    #[test]
    fn atomic_import_preserves_unrelated_fields_and_accepts_identical_retries() {
        let current = json!({"terminal":{"fontSize":17},"future":{"opaque":true},"workspaceNavigation":{"version":99}});
        let theme = fixture()["theme"].clone();
        let expected = snapshot(&current);
        let next = replacement(&current, &expected, &theme).unwrap().unwrap();
        assert_eq!(next["theme"], "custom");
        assert_eq!(next["accentColor"], Value::Null);
        assert_eq!(next["customTheme"], normalize(&theme).unwrap());
        assert_eq!(next["elementColors"], next["customTheme"]["elements"]);
        assert_eq!(next["terminal"], current["terminal"]);
        assert_eq!(next["future"], current["future"]);
        assert_eq!(next["workspaceNavigation"], current["workspaceNavigation"]);
        assert_eq!(replacement(&next, &expected, &theme).unwrap(), None);
        assert!(current.get("customTheme").is_none());
    }

    #[test]
    fn stale_or_future_data_never_gets_replaced() {
        let theme = fixture()["theme"].clone();
        let expected = snapshot(&json!({}));
        for current in [
            json!({"theme":"light"}),
            json!({"accentColor":"#abcdef"}),
            json!({"elementColors":{"version":1,"overrides":{"terminal.cursor":"#000000"}}}),
            json!({"customTheme":{"version":99}}),
            json!({"elementColors":{"version":99}}),
            json!({"customTheme":null}),
        ] {
            assert!(replacement(&current, &expected, &theme).is_err());
        }
        assert!(replacement(&json!({}), &json!({}), &theme).is_err());
        assert!(replacement(&json!({}), &expected, &json!({"version":99})).is_err());
        assert!(validate_managed_patch(&json!({}), &json!({"customTheme":theme})).is_err());
        assert!(validate_managed_patch(
            &json!({"customTheme":{"version":99}}),
            &json!({"customTheme":{"version":99},"compactMode":true})
        )
        .is_ok());
    }

    #[test]
    fn generic_theme_edits_cannot_race_an_import_but_unrelated_edits_still_work() {
        let current = json!({});
        let expected = snapshot(&current);
        assert!(validate_theme_patch(
            &current,
            &json!({"theme":"light","accentColor":null}),
            Some(&expected)
        )
        .is_ok());
        let imported = replacement(&current, &expected, &fixture()["theme"])
            .unwrap()
            .unwrap();
        assert!(
            validate_theme_patch(&imported, &json!({"theme":"light"}), Some(&expected)).is_err()
        );
        assert!(validate_theme_patch(&imported, &json!({"compactMode":true}), None).is_ok());
        assert!(
            validate_theme_patch(&current, &json!({"theme":"custom"}), Some(&expected)).is_err()
        );
        // Unsupported saved imports may still be left for a builtin theme without replacing data.
        let future = json!({"theme":"custom","customTheme":{"version":99}});
        assert!(
            validate_theme_patch(&future, &json!({"theme":"dark"}), Some(&snapshot(&future)))
                .is_ok()
        );
    }

    #[test]
    fn explicit_selection_resets_global_overrides_without_replacing_the_saved_custom_theme() {
        let current = json!({
            "theme": "custom", "accentColor": "#ffcc00", "customTheme": fixture()["theme"],
            "elementColors": {"version": 1, "overrides": {
                "mainTabs.activeBackground": "#ffc0cb", "contentTabs.activeBackground": "#abcdef"
            }},
            "terminal": {"fontSize": 17}, "workspaceNavigation": {"version": 99}
        });
        let before = current.clone();
        let patch = prepare_theme_selection_patch(
            &current,
            json!({"theme": "oxide", "accentColor": "#123456", "compactMode": true}),
        )
        .unwrap();
        assert_eq!(patch["theme"], "oxide");
        assert_eq!(patch["accentColor"], Value::Null);
        assert_eq!(
            patch["elementColors"],
            json!({"version": 1, "overrides": {}})
        );
        assert_eq!(patch["compactMode"], true);
        assert!(patch.get("customTheme").is_none());
        assert_eq!(current, before);
    }

    #[test]
    fn selecting_custom_restores_its_saved_elements_instead_of_current_overrides() {
        let current = json!({
            "theme": "dark", "accentColor": "#ffcc00", "customTheme": fixture()["theme"],
            "elementColors": {"version": 1, "overrides": {"mainTabs.activeBackground": "#123456"}}
        });
        let patch = prepare_theme_selection_patch(&current, json!({"theme": "custom"})).unwrap();
        assert_eq!(
            patch["elementColors"],
            normalize(&current["customTheme"]).unwrap()["elements"]
        );
        assert_eq!(patch["accentColor"], Value::Null);
        assert!(patch.get("customTheme").is_none());
    }

    #[test]
    fn accent_only_edits_leave_known_and_future_element_preferences_untouched() {
        for elements in [
            json!({"version": 1, "overrides": {"terminal.cursor": "#123456"}}),
            json!({"version": 99, "opaque": ["preserve"]}),
        ] {
            let current = json!({"theme": "dark", "elementColors": elements});
            let patch = json!({"accentColor": "#abcdef", "compactMode": true});
            assert_eq!(
                prepare_theme_selection_patch(&current, patch.clone()).unwrap(),
                patch
            );
            assert!(validate_theme_patch(&current, &patch, Some(&snapshot(&current))).is_ok());
        }
    }

    #[test]
    fn explicit_selection_preserves_unknown_data_by_rejecting_future_element_envelopes() {
        for elements in [json!({"version": 99}), json!("opaque"), json!({})] {
            let current = json!({"theme": "dark", "elementColors": elements});
            assert!(prepare_theme_selection_patch(&current, json!({"theme": "light"})).is_err());
        }
        for current in [json!({}), json!({"elementColors": null})] {
            assert!(prepare_theme_selection_patch(&current, json!({"theme": "light"})).is_ok());
        }
        let future = json!({"theme": "custom", "customTheme": {"version": 99}});
        assert!(prepare_theme_selection_patch(&future, json!({"theme": "dark"})).is_ok());
        assert!(prepare_theme_selection_patch(&future, json!({"theme": "custom"})).is_err());
    }

    #[test]
    fn selection_retries_match_derived_colors_and_cannot_erase_later_color_edits_or_imports() {
        let before = json!({
            "theme": "custom", "customTheme": fixture()["theme"],
            "elementColors": {"version": 1, "overrides": {"mainTabs.activeBackground": "#ffcc00"}}
        });
        let expected = snapshot(&before);
        for theme in ["oxide", "custom"] {
            let patch = json!({"theme": theme});
            let selected = prepare_theme_selection_patch(&before, patch.clone()).unwrap();
            let mut after = before.clone();
            for (key, value) in selected.as_object().unwrap() {
                after[key] = value.clone();
            }
            assert!(validate_theme_patch(&after, &patch, Some(&expected)).is_ok());
            let mut edited = after.clone();
            edited["elementColors"]["overrides"]["terminal.cursor"] = json!("#123456");
            assert!(validate_theme_patch(&edited, &patch, Some(&expected)).is_err());
            let mut next_theme = fixture()["theme"].clone();
            next_theme["name"] = json!("New imported theme");
            let imported = replacement(&after, &snapshot(&after), &next_theme)
                .unwrap()
                .unwrap();
            assert!(validate_theme_patch(&imported, &patch, Some(&expected)).is_err());
        }
    }

    #[test]
    fn trusted_selection_derivation_does_not_relax_original_caller_managed_guards() {
        let current = json!({"theme": "dark"});
        let original = json!({"theme": "light", "elementColors": {"version": 1, "overrides": {}}});
        assert!(
            crate::element_color_settings::validate_managed_patch(&current, &original).is_err()
        );
        assert!(prepare_theme_selection_patch(&current, original).is_ok());
        assert!(prepare_theme_selection_patch(&current, json!({"theme": null})).is_err());
    }
}
