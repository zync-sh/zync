use super::*;

fn parse_manifest(json: &str) -> Manifest {
    serde_json::from_str(json).expect("test manifest should parse")
}

#[test]
fn repository_manifest_v2_example_stays_installable() {
    let manifest = parse_manifest(include_str!(
        "../../../../tests/fixtures/plugins/manifest-v2-demo/manifest.json"
    ));

    manifest
        .validate()
        .expect("the repository example must remain a valid manifest v2 plugin");
    assert_eq!(manifest.runtime_entry(), Some("worker.js"));
    manifest
        .validate_host_compatibility()
        .expect("the repository example must support the current host");
}

#[test]
fn host_rejects_incompatible_or_malformed_engine_ranges() {
    let mut manifest = parse_manifest(include_str!(
        "../../../../tests/fixtures/plugins/manifest-v2-demo/manifest.json"
    ));
    let host = semver::Version::parse("2.32.2").unwrap();
    let api = semver::Version::parse(PLUGIN_API_VERSION).unwrap();
    manifest.validate_compatibility_with(&host, &api).unwrap();
    manifest.extensions.engines.as_mut().unwrap().zync = Some(">=2.32.0 <3.0.0".into());
    manifest.validate_compatibility_with(&host, &api).unwrap();

    manifest.extensions.engines.as_mut().unwrap().zync = Some(">= 2.32.0, < 3.0.0".into());
    manifest.validate_compatibility_with(&host, &api).unwrap();

    manifest.extensions.engines.as_mut().unwrap().zync = Some(">=".into());
    assert!(manifest.validate_compatibility_with(&host, &api).is_err());

    manifest.extensions.engines.as_mut().unwrap().zync = Some(">=3.0.0".into());
    let error = manifest
        .validate_compatibility_with(&host, &api)
        .unwrap_err();
    assert!(error.to_string().contains("engines.zync"));

    manifest.extensions.engines.as_mut().unwrap().zync = Some(">=2.32.0".into());
    manifest.extensions.engines.as_mut().unwrap().plugin_api = Some("^3.0.0".into());
    let error = manifest
        .validate_compatibility_with(&host, &api)
        .unwrap_err();
    assert!(error.to_string().contains("engines.pluginApi"));

    manifest.extensions.engines.as_mut().unwrap().plugin_api = Some("not-a-range".into());
    let error = manifest
        .validate_compatibility_with(&host, &api)
        .unwrap_err();
    assert!(error.to_string().contains("Invalid engines.pluginApi"));
}

#[test]
fn legacy_manifest_remains_valid() {
    let manifest = parse_manifest(
        r#"{
            "id":"com.zync.legacy",
            "name":"Legacy plugin",
            "version":"1",
            "main":"worker.js"
        }"#,
    );
    assert_eq!(manifest.manifest_version(), 1);
    manifest
        .validate()
        .expect("legacy manifest should remain compatible");
}

#[test]
fn validates_manifest_v2_permissions_and_contributions() {
    let manifest = parse_manifest(
        r#"{
            "manifestVersion":2,
            "id":"dev.example.monitor",
            "name":"Monitor",
            "version":"2.0.0",
            "publisher":"dev.example",
            "engines":{"zync":">=3 <4","pluginApi":"^2"},
            "runtime":{"entry":"dist/worker.js"},
            "contributes":{"paneKinds":[{"id":"monitor.main","title":"Monitor","entry":"ui/index.html","allowMultiple":true}]},
            "permissions":{"required":[{"id":"ui.pane.register","reason":"Show the monitor."}]}
        }"#,
    );
    assert_eq!(manifest.runtime_entry(), Some("dist/worker.js"));
    manifest.validate().expect("manifest v2 should validate");
}

#[test]
fn rejects_unknown_required_permissions() {
    let manifest = parse_manifest(
        r#"{
            "manifestVersion":2,
            "id":"dev.example.monitor",
            "name":"Monitor",
            "version":"2.0.0",
            "publisher":"dev.example",
            "engines":{"zync":">=3 <4","pluginApi":"^2"},
            "permissions":{"required":[{"id":"vault.secret.read","reason":"Read everything."}]}
        }"#,
    );
    let error = manifest
        .validate()
        .expect_err("unknown permission must fail");
    assert!(error.to_string().contains("Unknown required permission"));
}

#[test]
fn unknown_optional_permissions_are_forward_compatible_but_not_known() {
    let manifest = parse_manifest(
        r#"{
            "manifestVersion":2,
            "id":"dev.example.future",
            "name":"Future permission",
            "version":"2.0.0",
            "publisher":"dev.example",
            "engines":{"zync":">=3 <4","pluginApi":"^2"},
            "permissions":{"optional":[{"id":"future.secret.read","reason":"Use a future API."}]}
        }"#,
    );
    manifest
        .validate()
        .expect("unknown optional permissions remain forward compatible");
    assert!(!super::is_known_permission_id("future.secret.read"));
}

#[test]
fn rejects_duplicate_permission_declarations() {
    let manifest = parse_manifest(
        r#"{
            "manifestVersion":2,
            "id":"dev.example.monitor",
            "name":"Monitor",
            "version":"2.0.0",
            "publisher":"dev.example",
            "engines":{"zync":">=3 <4","pluginApi":"^2"},
            "permissions":{
                "required":[{"id":"ui.pane.register","reason":"Show a pane."}],
                "optional":[{"id":"ui.pane.register","reason":"Show another pane."}]
            }
        }"#,
    );
    let error = manifest.validate().expect_err("duplicates must fail");
    assert!(error.to_string().contains("declared more than once"));
}

#[test]
fn rejects_network_host_scope_smuggling() {
    for host in [
        "127.0.0.1",
        "[::1]",
        "example.com:443",
        "example.com/path",
        "user@example.com",
        "https://example.com",
        "*example.com",
        "*.",
    ] {
        let manifest: Manifest = serde_json::from_value(serde_json::json!({
            "manifestVersion": 2,
            "id": "dev.example.network",
            "name": "Network scope",
            "version": "1.0.0",
            "publisher": "dev.example",
            "engines": {"zync": ">=3 <4", "pluginApi": "^2"},
            "permissions": {
                "required": [{
                    "id": "network.fetch",
                    "reason": "Test a network scope.",
                    "hosts": [host]
                }]
            }
        }))
        .expect("parse manifest");
        let error = match manifest.validate() {
            Ok(()) => panic!("host scope smuggling was accepted: {host}"),
            Err(error) => error,
        };
        assert!(
            error.to_string().contains("Invalid permission host"),
            "unexpected error for {host}: {error}"
        );
    }
}

#[test]
fn rejects_case_insensitive_duplicate_network_hosts() {
    let manifest: Manifest = serde_json::from_value(serde_json::json!({
        "manifestVersion": 2,
        "id": "dev.example.network",
        "name": "Network scope",
        "version": "1.0.0",
        "publisher": "dev.example",
        "engines": {"zync": ">=3 <4", "pluginApi": "^2"},
        "permissions": {
            "required": [{
                "id": "network.fetch",
                "reason": "Test duplicate scopes.",
                "hosts": ["api.example.com", "API.EXAMPLE.COM"]
            }]
        }
    }))
    .expect("parse manifest");
    assert!(manifest.validate().is_err());
}

#[test]
fn rejects_package_escape_paths() {
    let manifest = parse_manifest(
        r#"{
            "manifestVersion":2,
            "id":"dev.example.monitor",
            "name":"Monitor",
            "version":"2.0.0",
            "publisher":"dev.example",
            "engines":{"zync":">=3 <4","pluginApi":"^2"},
            "runtime":{"entry":"../outside.js"}
        }"#,
    );
    let error = manifest.validate().expect_err("escaping entry must fail");
    assert!(error.to_string().contains("inside the plugin package"));
}

#[test]
fn requires_contribution_permissions() {
    let manifest = parse_manifest(
        r#"{
            "manifestVersion":2,
            "id":"dev.example.monitor",
            "name":"Monitor",
            "version":"2.0.0",
            "publisher":"dev.example",
            "engines":{"zync":">=3 <4","pluginApi":"^2"},
            "contributes":{"commands":[{"id":"monitor.refresh","title":"Refresh"}]}
        }"#,
    );
    let error = manifest
        .validate()
        .expect_err("contributions without their permission must fail");
    assert!(error.to_string().contains("ui.commands.register"));
}

#[test]
fn requires_publisher_namespace() {
    let manifest = parse_manifest(
        r#"{
            "manifestVersion":2,
            "id":"someone.else.monitor",
            "name":"Monitor",
            "version":"2.0.0",
            "publisher":"dev.example",
            "engines":{"zync":">=3 <4","pluginApi":"^2"}
        }"#,
    );
    let error = manifest
        .validate()
        .expect_err("publisher must own the plugin namespace");
    assert!(error.to_string().contains("namespaced to publisher"));
}
