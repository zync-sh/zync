use super::*;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::json;
use std::path::PathBuf;

fn test_directory(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "zync-plugin-signature-{label}-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&path).expect("create package");
    path
}

fn write_signed_package(root: &Path) -> Manifest {
    let manifest_json = r#"{"manifestVersion":2,"id":"dev.example.signed","name":"Signed","version":"1.2.3","publisher":"dev.example","runtime":{"entry":"worker.js"},"permissions":{"required":[],"optional":[]}}"#;
    fs::write(root.join("manifest.json"), manifest_json).expect("write manifest");
    fs::write(root.join("worker.js"), "self.onmessage = () => {};").expect("write worker");
    let manifest: Manifest = serde_json::from_str(manifest_json).expect("parse manifest");

    let files = BTreeMap::from([
        (
            "manifest.json".to_string(),
            digest_file(&root.join("manifest.json")).unwrap(),
        ),
        (
            "worker.js".to_string(),
            digest_file(&root.join("worker.js")).unwrap(),
        ),
    ]);
    fs::write(
        root.join(INTEGRITY_FILE),
        serde_json::to_vec_pretty(&json!({ "version": 1, "files": files })).unwrap(),
    )
    .expect("write integrity");

    let signing_key = SigningKey::from_bytes(&[7u8; 32]);
    let verifying_key = signing_key.verifying_key();
    let mut signature = PackageSignature {
        version: 1,
        algorithm: "ed25519".into(),
        publisher: "dev.example".into(),
        plugin_id: "dev.example.signed".into(),
        plugin_version: "1.2.3".into(),
        key_id: calculate_key_id(verifying_key.as_bytes()),
        public_key: STANDARD.encode(verifying_key.as_bytes()),
        published_at_ms: 1_800_000_000_000,
        manifest_digest: files.get("manifest.json").unwrap().clone(),
        integrity_root: calculate_integrity_root(&files),
        signature: String::new(),
    };
    signature.signature = STANDARD.encode(
        signing_key
            .sign(signing_payload(&signature).as_bytes())
            .to_bytes(),
    );
    fs::write(
        root.join(SIGNATURE_FILE),
        serde_json::to_vec_pretty(&json!({
            "version": signature.version,
            "algorithm": signature.algorithm,
            "publisher": signature.publisher,
            "pluginId": signature.plugin_id,
            "pluginVersion": signature.plugin_version,
            "keyId": signature.key_id,
            "publicKey": signature.public_key,
            "publishedAtMs": signature.published_at_ms,
            "manifestDigest": signature.manifest_digest,
            "integrityRoot": signature.integrity_root,
            "signature": signature.signature,
        }))
        .unwrap(),
    )
    .expect("write signature");
    manifest
}

#[test]
fn verifies_a_package_signature_bound_to_manifest_and_integrity() {
    let root = test_directory("valid");
    let manifest = write_signed_package(&root);
    let status = verify_package_signature(&root, &manifest)
        .expect("verify signed package")
        .expect("signature status");
    assert_eq!(status.publisher, "dev.example");
    assert!(status.verified);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn rejects_payload_tampering() {
    let root = test_directory("tampered");
    let manifest = write_signed_package(&root);
    fs::write(root.join("worker.js"), "tampered").expect("tamper worker");
    let error = verify_package_signature(&root, &manifest).expect_err("tampering must fail");
    assert!(error.to_string().contains("failed integrity verification"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn rejects_unlisted_payload_files() {
    let root = test_directory("unlisted");
    let manifest = write_signed_package(&root);
    fs::write(root.join("hidden.js"), "surprise").expect("write unlisted file");
    let error = verify_package_signature(&root, &manifest).expect_err("unlisted file must fail");
    assert!(error.to_string().contains("do not match"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn rejects_a_forged_signature() {
    let root = test_directory("forged-signature");
    let manifest = write_signed_package(&root);
    let signature_path = root.join(SIGNATURE_FILE);
    let mut signature: serde_json::Value =
        serde_json::from_slice(&fs::read(&signature_path).unwrap()).unwrap();
    signature["signature"] = serde_json::Value::String(STANDARD.encode([0u8; 64]));
    fs::write(
        &signature_path,
        serde_json::to_vec_pretty(&signature).unwrap(),
    )
    .unwrap();
    let error = verify_package_signature(&root, &manifest).expect_err("forged signature must fail");
    assert!(error.to_string().contains("signature is invalid"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn treats_a_package_without_signing_metadata_as_unsigned() {
    let root = test_directory("unsigned");
    let manifest_json = r#"{"manifestVersion":2,"id":"dev.example.local","name":"Local","version":"1.0.0","publisher":"dev.example"}"#;
    fs::write(root.join("manifest.json"), manifest_json).unwrap();
    let manifest: Manifest = serde_json::from_str(manifest_json).unwrap();
    assert!(verify_package_signature(&root, &manifest)
        .unwrap()
        .is_none());
    let _ = fs::remove_dir_all(root);
}
