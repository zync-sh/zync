use super::types::ProviderCredentialObject;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};

static UPLOAD_GATES: OnceLock<Mutex<HashMap<PathBuf, Weak<tokio::sync::Mutex<()>>>>> =
    OnceLock::new();

/// Serialize the data-root checkpoint with its uploads; abandoned roots retain no live gate.
pub(super) fn upload_gate(root: &Path) -> Arc<tokio::sync::Mutex<()>> {
    let mut gates = UPLOAD_GATES
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    gates.retain(|_, value| value.strong_count() > 0);
    if let Some(gate) = gates.get(root).and_then(Weak::upgrade) {
        return gate;
    }
    let gate = Arc::new(tokio::sync::Mutex::new(()));
    gates.insert(root.into(), Arc::downgrade(&gate));
    gate
}

#[derive(Default, Serialize, Deserialize)]
pub(super) struct UploadState {
    #[serde(default)]
    pub collections: BTreeMap<String, BTreeMap<String, UploadedCredential>>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct UploadedCredential {
    pub fingerprint: String,
    pub encrypted_checksum: String,
}

impl UploadState {
    /// Missing or unreadable optimization state causes a full upload, never a skipped credential.
    pub fn load(root: &Path) -> Self {
        std::fs::read(root.join("credential-upload-state.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    /// Publish only successful checkpoints, with the same durability boundary as other local metadata.
    pub fn save(&self, root: &Path) -> std::io::Result<()> {
        let bytes = serde_json::to_vec(self).map_err(std::io::Error::other)?;
        crate::atomic_io::durable_replace(&root.join("credential-upload-state.json"), &bytes)
    }
}

/// Match the lowercase hexadecimal SHA-256 representation returned by Drive.
pub(super) fn encrypted_checksum(payload: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(payload);
    let mut output = String::with_capacity(digest.len() * 2);
    for &byte in digest.as_slice() {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 15) as usize] as char);
    }
    output
}

/// Skip only an exact local snapshot whose last ciphertext is still present in fresh inventory.
pub(super) fn unchanged(
    checkpoint: &UploadedCredential,
    fingerprint: &str,
    remote: &[&ProviderCredentialObject],
) -> bool {
    checkpoint.fingerprint == fingerprint
        && remote.len() == 1
        && remote[0].content_checksum.as_deref() == Some(checkpoint.encrypted_checksum.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn skipping_requires_local_and_remote_equality_and_unique_inventory() {
        let entry = UploadedCredential {
            fingerprint: "keyed-local".into(),
            encrypted_checksum: "ciphertext".into(),
        };
        let mut remote = ProviderCredentialObject {
            object_name: "fixture".into(),
            object_id: Some("id".into()),
            content_checksum: Some("ciphertext".into()),
        };
        assert!(unchanged(&entry, "keyed-local", &[&remote]));
        assert!(!unchanged(&entry, "changed", &[&remote]));
        assert!(!unchanged(&entry, "keyed-local", &[]));
        assert!(!unchanged(&entry, "keyed-local", &[&remote, &remote]));
        remote.content_checksum = Some("externally modified".into());
        assert!(!unchanged(&entry, "keyed-local", &[&remote]));
        remote.content_checksum = None;
        assert!(!unchanged(&entry, "keyed-local", &[&remote]));
    }

    #[test]
    fn encrypted_checksum_uses_drive_hex_format() {
        assert_eq!(
            encrypted_checksum(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
