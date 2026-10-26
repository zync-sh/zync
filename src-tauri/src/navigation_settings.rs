//! Managed global/host navigation preferences are chrome, never executable layout data.
use crate::preference_settings::Policy;
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde_json::Value;

const POLICY: Policy = Policy {
    key: "workspaceNavigation",
    supported,
    equivalent,
};

/// JSON schema versions written as integers or floats compare like JavaScript numbers.
fn equivalent(left: &Value, right: &Value) -> bool {
    let normalized = |value: &Value| {
        let mut value = value.clone();
        if let Some(version) = value.get("version").and_then(Value::as_f64) {
            value["version"] = Value::from(version as u64);
        }
        value
    };
    normalized(left) == normalized(right)
}

// Match encodeURIComponent's safe alphabet. Canonical round trips prevent alias IDs.
const COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

pub(crate) fn plugin_id(id: &str) -> bool {
    if id.len() > 4328 {
        return false;
    }
    let parts: Vec<_> = id.split(':').collect();
    if parts.len() != 3 || parts[0] != "plugin" {
        return false;
    }
    parts[1..].iter().zip([160, 320]).all(|(part, limit)| {
        let Ok(decoded) = percent_decode_str(part).decode_utf8() else { return false; };
        !decoded.is_empty() && decoded.encode_utf16().count() <= limit
            && !decoded.chars().any(|c| c.is_whitespace() || c == '\u{feff}'
                || matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}' | '\u{61c}' | '\u{200b}'
                    | '\u{200e}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}' | '\u{2066}'..='\u{2069}'))
            && utf8_percent_encode(&decoded, COMPONENT).to_string() == *part
    })
}

const IDS: [&str; 8] = [
    "hosts",
    "files",
    "tunnels",
    "snippets",
    "dashboard",
    "ai",
    "commands",
    "settings",
];
const GLOBAL_IDS: [&str; 10] = [
    "hosts",
    "workspace",
    "public-urls",
    "tunnels",
    "snippets",
    "commands",
    "vaults",
    "plugins",
    "settings",
    "profile",
];
// Additive destinations do not invalidate orders saved by earlier v3 builds.
const OPTIONAL_GLOBAL_IDS: [&str; 1] = ["security-audits"];

fn valid_ids(value: Option<&Value>, version: u64, complete: bool) -> bool {
    let Some(items) = value.and_then(Value::as_array) else {
        return false;
    };
    let known = if version == 3 {
        GLOBAL_IDS.as_slice()
    } else {
        IDS.as_slice()
    };
    if items.len()
        > (if version == 1 {
            IDS.len()
        } else if version == 2 {
            264
        } else {
            267
        })
    {
        return false;
    }
    let mut seen = std::collections::HashSet::new();
    items.iter().all(|item| {
        item.as_str().is_some_and(|id| {
            (known.contains(&id)
                || (version == 3 && OPTIONAL_GLOBAL_IDS.contains(&id))
                || (version >= 2 && plugin_id(id)))
                && seen.insert(id)
        })
    }) && (!complete || known.iter().all(|id| seen.contains(id)))
}

/// Strictly recognize this version without normalizing or dropping future fields.
pub(crate) fn supported(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    // JavaScript recognizes 1 and 1.0 as the same supported schema version.
    let Some(version) = object
        .get("version")
        .and_then(Value::as_f64)
        .filter(|version| *version == 1.0 || *version == 2.0 || *version == 3.0)
        .map(|version| version as u64)
    else {
        return false;
    };
    object.len() == (if version == 3 { 7 } else { 6 })
        && object.keys().all(|key| {
            [
                "version",
                "visible",
                "position",
                "showLabels",
                "order",
                "hidden",
                "workspaceTabsPosition",
            ]
            .contains(&key.as_str())
        })
        && object.get("visible").is_some_and(Value::is_boolean)
        && object.get("showLabels").is_some_and(Value::is_boolean)
        && matches!(
            object.get("position").and_then(Value::as_str),
            Some("left" | "right" | "top" | "bottom")
        )
        && (version != 3
            || (matches!(object["position"].as_str(), Some("left" | "right"))
                && matches!(
                    object["workspaceTabsPosition"].as_str(),
                    Some("default" | "left" | "right")
                )))
        && (version == 3 || !object.contains_key("workspaceTabsPosition"))
        && valid_ids(object.get("order"), version, true)
        && valid_ids(object.get("hidden"), version, false)
        && (version != 3
            || object["hidden"]
                .as_array()
                .is_some_and(|items| !items.iter().any(|id| id == "settings" || id == "profile")))
        && object["hidden"].as_array().is_some_and(|hidden| {
            hidden.iter().all(|id| {
                object["order"]
                    .as_array()
                    .is_some_and(|order| order.contains(id))
            })
        })
}

/// Check under the settings mutation lock before merge; unrelated patches preserve raw future data.
/// Explicit JSON-editor writes retain their own concurrency/recovery workflow.
pub(crate) fn validate_patch(current: &Value, patch: &Value) -> Result<(), String> {
    POLICY.validate_managed_patch(current, patch)
}

/// Fixed-key confirmed replacement: supports legacy data without granting dynamic settings writes.
pub(crate) fn replacement(
    current: &Value,
    expected: &Value,
    next: &Value,
) -> Result<Option<Value>, String> {
    POLICY.replacement(current, expected, next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn settings() -> Value {
        json!({"version":1,"visible":true,"position":"left","showLabels":false,"order":IDS,"hidden":[]})
    }
    #[test]
    fn accepts_known_placements_and_optional_first_use() {
        for position in ["left", "right", "top", "bottom"] {
            let mut next = settings();
            next["position"] = json!(position);
            assert!(replacement(&json!({}), &json!({"exists":false}), &next).is_ok());
        }
    }
    #[test]
    fn rejects_malformed_and_future_envelopes() {
        for bad in [Value::Null, json!([]), json!({"version":2}), json!({})] {
            assert!(!supported(&bad));
        }
        for (key, value) in [
            ("version", json!(3)),
            ("visible", json!(1)),
            ("position", json!("floating")),
            ("order", json!(["hosts"])),
            ("hidden", json!(["hosts", "hosts"])),
            ("unknown", json!(true)),
        ] {
            let mut bad = settings();
            bad[key] = value;
            assert!(!supported(&bad));
        }
    }
    #[test]
    fn unknown_current_is_preserved_by_unrelated_updates_but_cannot_be_downgraded() {
        for future in [json!({"version":2}), Value::Null] {
            let current = json!({"workspaceNavigation":future});
            let before = current.clone();
            assert!(validate_patch(&current, &json!({"sidebarCollapsed":true})).is_ok());
            assert!(validate_patch(&current, &json!({"workspaceNavigation":settings()})).is_err());
            assert_eq!(current, before);
        }
    }
    #[test]
    fn rejects_partial_patches_before_deep_merge() {
        assert!(validate_patch(
            &json!({"workspaceNavigation":settings()}),
            &json!({"workspaceNavigation":{"visible":false}})
        )
        .is_err());
    }

    #[test]
    fn recognizes_only_canonical_bounded_plugin_ids() {
        for id in [
            "plugin:owner:owner%3Apanel",
            "plugin:%C3%A4%F0%9F%98%80:%E9%9D%A2%E6%9D%BF%2Fone",
            "plugin:o!'()*~:a%3Ab%25",
        ] {
            assert!(plugin_id(id), "{id}");
        }
        for id in [
            "plugin:owner:owner:panel",
            "plugin::pane",
            "plugin:owner:%ff",
            "plugin:owner:%2f",
            "plugin:owner:%70ane",
            "plugin:owner:with%20space",
            "plugin:owner:%E2%80%AE",
        ] {
            assert!(!plugin_id(id), "{id}");
        }
        assert!(!plugin_id(&format!("plugin:{}:pane", "a".repeat(161))));
        assert!(!plugin_id(&format!("plugin:owner:{}", "a".repeat(321))));
    }

    #[test]
    fn v2_retains_dormant_plugins_and_v1_can_upgrade_without_accepting_future_data() {
        let mut next = settings();
        next["version"] = json!(2);
        next["order"]
            .as_array_mut()
            .unwrap()
            .push(json!("plugin:owner:owner%3Apanel"));
        next["hidden"] = json!(["plugin:owner:owner%3Apanel"]);
        assert!(replacement(
            &json!({"workspaceNavigation":settings()}),
            &json!({"exists":true,"value":settings()}),
            &next
        )
        .is_ok());
        assert!(supported(&next));
        next["hidden"] = json!(["plugin:other:pane"]);
        assert!(!supported(&next));
        next["hidden"] = json!([]);
        next["version"] = json!(1);
        assert!(!supported(&next));
    }

    #[test]
    fn audit_destination_is_additive_to_existing_v3_orders() {
        let original = json!({"version":3,"visible":false,"position":"right","showLabels":false,
            "order":GLOBAL_IDS,"hidden":["tunnels"],"workspaceTabsPosition":"default"});
        assert!(supported(&original));
        let mut next = original.clone();
        next["order"]
            .as_array_mut()
            .unwrap()
            .push(json!("security-audits"));
        next["hidden"]
            .as_array_mut()
            .unwrap()
            .push(json!("security-audits"));
        assert!(supported(&next));
        assert!(replacement(
            &json!({"workspaceNavigation":original}),
            &json!({"exists":true,"value":original}),
            &next
        )
        .unwrap()
        .is_some());
        next["order"]
            .as_array_mut()
            .unwrap()
            .push(json!("security-audits"));
        assert!(
            !supported(&next),
            "duplicate additive destinations remain invalid"
        );
        assert!(!original["order"]
            .as_array()
            .unwrap()
            .contains(&json!("security-audits")));
    }

    #[test]
    fn global_v3_requires_complete_scope_and_supported_host_tab_placements() {
        let mut next = json!({"version":3,"visible":true,"position":"left","showLabels":false,
            "order":GLOBAL_IDS,"hidden":[],"workspaceTabsPosition":"default"});
        for placement in ["default", "left", "right"] {
            next["workspaceTabsPosition"] = json!(placement);
            assert!(supported(&next));
            assert!(replacement(
                &json!({"workspaceNavigation":settings()}),
                &json!({"exists":true,"value":settings()}),
                &next
            )
            .unwrap()
            .is_some());
        }
        for (key, value) in [
            ("workspaceTabsPosition", json!("bottom")),
            // Keep the native boundary strict even when a renderer might coerce JSON.
            ("workspaceTabsPosition", json!(["default"])),
            ("workspaceTabsPosition", json!(["left"])),
            ("workspaceTabsPosition", json!(["right"])),
            ("position", json!("top")),
            ("hidden", json!(["settings"])),
            ("hidden", json!(["profile"])),
            ("order", json!(["hosts"])),
        ] {
            let mut invalid = next.clone();
            invalid[key] = value;
            assert!(!supported(&invalid));
        }
        let current = json!({"workspaceNavigation":next,"unrelated":{"keep":true}});
        assert!(
            replacement(&current, &json!({"exists":true,"value":settings()}), &next)
                .unwrap()
                .is_none(),
            "identical retry does not rewrite backups"
        );
        let mut different = next.clone();
        different["visible"] = json!(false);
        assert!(replacement(
            &current,
            &json!({"exists":true,"value":settings()}),
            &different
        )
        .is_err());
        assert!(validate_patch(&current, &json!({"workspaceNavigation":different})).is_err());
        assert!(validate_patch(&current, &json!({"theme":"light"})).is_ok());
    }

    #[test]
    fn compare_and_save_matches_javascript_numeric_versions() {
        let mut current = settings();
        current["version"] = json!(1.0);
        let mut next = settings();
        next["visible"] = json!(false);
        assert!(replacement(
            &json!({"workspaceNavigation":current}),
            &json!({"exists":true,"value":settings()}),
            &next
        )
        .unwrap()
        .is_some());
        assert!(equivalent(&json!({"version":3.0}), &json!({"version":3})));
    }
}
