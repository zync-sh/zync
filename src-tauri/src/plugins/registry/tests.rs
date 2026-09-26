use super::*;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::json;

const NOW: u64 = 1_800_000_000_000;

fn signed_registry(version: u64, expires_at_ms: u64) -> (Vec<u8>, String) {
    let root_key = SigningKey::from_bytes(&[11u8; 32]);
    let publisher_key = SigningKey::from_bytes(&[22u8; 32]).verifying_key();
    let publisher_public_key = STANDARD.encode(publisher_key.as_bytes());
    let signed = serde_json::to_value(RegistryPayload {
        metadata_type: "zync.plugin-registry".into(),
        version,
        issued_at_ms: NOW - 1_000,
        expires_at_ms,
        plugins: vec![TrustedRegistryPlugin {
            id: "dev.example.monitor".into(),
            name: "Monitor".into(),
            version: "1.2.3".into(),
            channel: PluginReleaseChannel::Stable,
            description: "A signed test plugin".into(),
            publisher: "dev.example".into(),
            download_url: "https://plugins.example.dev/monitor-1.2.3.zip".into(),
            package_digest: format!("sha256:{}", "11".repeat(32)),
            publisher_key_id: key_id(publisher_key.as_bytes()),
            publisher_public_key,
            publisher_verified: false,
            icon: None,
            thumbnail_url: None,
            plugin_type: Some("tool".into()),
        }],
        revocations: Vec::new(),
    })
    .unwrap();
    let signature =
        root_key.sign(format!("{SIGNING_DOMAIN}{}", canonical_json(&signed).unwrap()).as_bytes());
    let envelope = json!({
        "signed": signed,
        "signatures": [{
            "keyId": key_id(root_key.verifying_key().as_bytes()),
            "signature": STANDARD.encode(signature.to_bytes()),
        }],
    });
    (
        serde_json::to_vec_pretty(&envelope).unwrap(),
        STANDARD.encode(root_key.verifying_key().as_bytes()),
    )
}

#[test]
fn verifies_registry_and_binds_publisher_key() {
    let (bytes, root_key) = signed_registry(4, NOW + 60_000);
    let snapshot = verify_registry(&bytes, &root_key, 3, NOW).expect("verify registry");
    assert_eq!(snapshot.version, 4);
    assert_eq!(snapshot.plugins[0].publisher, "dev.example");
    assert!(snapshot.plugins[0]
        .id
        .starts_with(&format!("{}.", snapshot.plugins[0].publisher)));
}

#[test]
fn beta_release_requires_a_prerelease_version_and_explicit_channel() {
    let (bytes, root_key) = signed_registry(4, NOW + 60_000);
    let mut envelope: Value = serde_json::from_slice(&bytes).unwrap();
    envelope["signed"]["plugins"][0]["channel"] = json!("beta");
    envelope["signed"]["plugins"][0]["version"] = json!("1.3.0-beta.1");
    let signing_key = SigningKey::from_bytes(&[11u8; 32]);
    let signed = envelope["signed"].clone();
    envelope["signatures"][0]["signature"] = json!(STANDARD.encode(
        signing_key
            .sign(format!("{SIGNING_DOMAIN}{}", canonical_json(&signed).unwrap()).as_bytes())
            .to_bytes()
    ));
    let valid = serde_json::to_vec(&envelope).unwrap();
    let snapshot = verify_registry(&valid, &root_key, 0, NOW).expect("beta release");
    assert_eq!(snapshot.plugins[0].channel, PluginReleaseChannel::Beta);

    envelope["signed"]["plugins"][0]["channel"] = json!("stable");
    let signed = envelope["signed"].clone();
    envelope["signatures"][0]["signature"] = json!(STANDARD.encode(
        signing_key
            .sign(format!("{SIGNING_DOMAIN}{}", canonical_json(&signed).unwrap()).as_bytes())
            .to_bytes()
    ));
    let invalid = serde_json::to_vec(&envelope).unwrap();
    assert!(verify_registry(&invalid, &root_key, 0, NOW)
        .unwrap_err()
        .to_string()
        .contains("channel"));
}

#[test]
fn accepts_a_registry_signed_by_either_key_during_root_rotation() {
    let (bytes, new_root_key) = signed_registry(4, NOW + 60_000);
    let old_root_key = STANDARD.encode(
        SigningKey::from_bytes(&[44u8; 32])
            .verifying_key()
            .as_bytes(),
    );
    let trust_bundle = format!("{old_root_key}, {new_root_key}");
    let snapshot = verify_registry(&bytes, &trust_bundle, 3, NOW).expect("verify rotating root");
    assert_eq!(snapshot.version, 4);
}

#[test]
fn rejects_an_oversized_root_trust_bundle() {
    let (bytes, root_key) = signed_registry(4, NOW + 60_000);
    let trust_bundle = std::iter::repeat_n(root_key, MAX_TRUSTED_ROOT_KEYS + 1)
        .collect::<Vec<_>>()
        .join(",");
    let error = verify_registry(&bytes, &trust_bundle, 3, NOW)
        .expect_err("oversized trust bundle must fail");
    assert!(error.to_string().contains("between 1 and 4"));
}

#[test]
fn rejects_forged_registry_signature() {
    let (bytes, root_key) = signed_registry(1, NOW + 60_000);
    let mut envelope: Value = serde_json::from_slice(&bytes).unwrap();
    envelope["signed"]["plugins"][0]["name"] = Value::String("Forged".into());
    let forged = serde_json::to_vec(&envelope).unwrap();
    let error = verify_registry(&forged, &root_key, 0, NOW).expect_err("forgery must fail");
    assert!(error.to_string().contains("signature is invalid"));
}

#[test]
fn rejects_expired_and_rolled_back_metadata() {
    let (expired, root_key) = signed_registry(4, NOW);
    let error = verify_registry(&expired, &root_key, 4, NOW).expect_err("expiry must fail");
    assert!(error.to_string().contains("expired"));

    let (older, root_key) = signed_registry(3, NOW + 60_000);
    let error = verify_registry(&older, &root_key, 4, NOW).expect_err("rollback must fail");
    assert!(error.to_string().contains("rollback"));
}

#[test]
fn rejects_publisher_namespace_or_key_mismatch() {
    let (bytes, root_key) = signed_registry(1, NOW + 60_000);
    let mut envelope: Value = serde_json::from_slice(&bytes).unwrap();
    envelope["signed"]["plugins"][0]["publisherKeyId"] =
        Value::String(format!("sha256:{}", "00".repeat(32)));

    let root_signing_key = SigningKey::from_bytes(&[11u8; 32]);
    let signed = envelope["signed"].clone();
    envelope["signatures"][0]["signature"] = Value::String(
        STANDARD.encode(
            root_signing_key
                .sign(format!("{SIGNING_DOMAIN}{}", canonical_json(&signed).unwrap()).as_bytes())
                .to_bytes(),
        ),
    );
    let invalid = serde_json::to_vec(&envelope).unwrap();
    let error = verify_registry(&invalid, &root_key, 0, NOW).expect_err("key mismatch must fail");
    assert!(error.to_string().contains("does not match"));
}

#[test]
fn publisher_key_rotation_keeps_new_key_installable_and_revokes_old_key() {
    let (bytes, root_key) = signed_registry(5, NOW + 60_000);
    let mut envelope: Value = serde_json::from_slice(&bytes).unwrap();
    let old_key_id = envelope["signed"]["plugins"][0]["publisherKeyId"]
        .as_str()
        .unwrap()
        .to_string();
    let new_key = SigningKey::from_bytes(&[33u8; 32]).verifying_key();
    let mut new_release = envelope["signed"]["plugins"][0].clone();
    new_release["version"] = Value::String("2.0.0".into());
    new_release["downloadUrl"] =
        Value::String("https://plugins.example.dev/monitor-2.0.0.zip".into());
    new_release["packageDigest"] = Value::String(format!("sha256:{}", "22".repeat(32)));
    new_release["publisherKeyId"] = Value::String(key_id(new_key.as_bytes()));
    new_release["publisherPublicKey"] = Value::String(STANDARD.encode(new_key.as_bytes()));
    envelope["signed"]["plugins"]
        .as_array_mut()
        .unwrap()
        .push(new_release);
    envelope["signed"]["revocations"] = json!([{
        "kind": "publisherKey",
        "publisher": "dev.example",
        "keyId": old_key_id,
        "revokedAtMs": NOW - 500,
        "reason": "Publisher rotated a compromised release key"
    }]);
    let root_signing_key = SigningKey::from_bytes(&[11u8; 32]);
    let signed = envelope["signed"].clone();
    envelope["signatures"][0]["signature"] = Value::String(
        STANDARD.encode(
            root_signing_key
                .sign(format!("{SIGNING_DOMAIN}{}", canonical_json(&signed).unwrap()).as_bytes())
                .to_bytes(),
        ),
    );

    let snapshot = verify_registry(&serde_json::to_vec(&envelope).unwrap(), &root_key, 4, NOW)
        .expect("rotated registry");
    assert!(snapshot
        .release_revocation_reason(&snapshot.plugins[0])
        .is_some());
    assert!(snapshot
        .release_revocation_reason(&snapshot.plugins[1])
        .is_none());
}

#[test]
fn retained_revocations_cannot_be_removed_by_a_later_registry() {
    let revocation = RegistryRevocation {
        kind: RegistryRevocationKind::PublisherKey,
        publisher: "dev.example".into(),
        key_id: Some(format!("sha256:{}", "44".repeat(32))),
        plugin_id: None,
        version: None,
        package_digest: None,
        revoked_at_ms: NOW,
        reason: "Compromised key".into(),
    };
    let merged =
        merge_revocations(std::slice::from_ref(&revocation), &[]).expect("retain revocation");
    assert_eq!(merged, [revocation]);
}

#[test]
fn rejects_malformed_revocation() {
    let (bytes, root_key) = signed_registry(6, NOW + 60_000);
    let mut envelope: Value = serde_json::from_slice(&bytes).unwrap();
    envelope["signed"]["revocations"] = json!([{
        "kind": "pluginRelease",
        "publisher": "dev.example",
        "pluginId": "other.publisher.monitor",
        "version": "1.2.3",
        "packageDigest": format!("sha256:{}", "11".repeat(32)),
        "revokedAtMs": NOW,
        "reason": "Unsafe release"
    }]);
    let root_signing_key = SigningKey::from_bytes(&[11u8; 32]);
    let signed = envelope["signed"].clone();
    envelope["signatures"][0]["signature"] = Value::String(
        STANDARD.encode(
            root_signing_key
                .sign(format!("{SIGNING_DOMAIN}{}", canonical_json(&signed).unwrap()).as_bytes())
                .to_bytes(),
        ),
    );
    let error = verify_registry(&serde_json::to_vec(&envelope).unwrap(), &root_key, 0, NOW)
        .expect_err("malformed revocation must fail");
    assert!(error.to_string().contains("identity is invalid"));
}

#[test]
fn rejects_a_revocation_too_large_for_persisted_state() {
    let revocation = RegistryRevocation {
        kind: RegistryRevocationKind::PublisherKey,
        publisher: "dev.example".into(),
        key_id: Some(format!("sha256:{}", "11".repeat(32))),
        plugin_id: None,
        version: None,
        package_digest: None,
        revoked_at_ms: NOW,
        reason: "x".repeat(MAX_SERIALIZED_REVOCATION_BYTES),
    };
    let error =
        validate_revocation(&revocation, NOW).expect_err("oversized revocation metadata must fail");
    assert!(error.to_string().contains("too large"));
}

#[test]
fn state_backup_recovers_the_latest_version_and_revocations() {
    let root = std::env::temp_dir().join(format!("zync-registry-state-{}", uuid::Uuid::new_v4()));
    let path = root.join("plugin-registry-state.json");
    let initial = RegistryState {
        highest_version: 4,
        revocations: Vec::new(),
    };
    write_state(&path, &initial).expect("write initial state");

    let latest = RegistryState {
        highest_version: 5,
        revocations: vec![RegistryRevocation {
            kind: RegistryRevocationKind::PublisherKey,
            publisher: "dev.example".into(),
            key_id: Some(format!("sha256:{}", "44".repeat(32))),
            plugin_id: None,
            version: None,
            package_digest: None,
            revoked_at_ms: NOW,
            reason: "Compromised key".into(),
        }],
    };
    write_state(&path, &latest).expect("write updated state");
    fs::write(&path, serde_json::to_vec(&initial).unwrap()).expect("restore stale primary");
    let interrupted = read_state(&path).expect("recover interrupted replacement");
    assert_eq!(interrupted.highest_version, latest.highest_version);
    assert_eq!(interrupted.revocations, latest.revocations);

    fs::write(&path, b"corrupt primary").expect("damage primary state");

    let recovered = read_state(&path).expect("recover from backup");
    assert_eq!(recovered.highest_version, latest.highest_version);
    assert_eq!(recovered.revocations, latest.revocations);
    fs::remove_dir_all(root).expect("remove test state");
}
