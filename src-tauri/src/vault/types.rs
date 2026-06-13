use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

use super::credential::CredentialEnvelope;

/// Stored in redb vault_meta table under key "meta".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultMeta {
    pub vault_id: String,
    pub schema_version: u32,
    pub crypto_suite: String,
    /// Base64-encoded 32-byte Argon2id salt.
    pub salt: String,
    pub kdf_m_cost: u32,
    pub kdf_t_cost: u32,
    pub kdf_p_cost: u32,
    #[serde(default)]
    pub live_records: Option<u64>,
    pub created_at: u64,
    pub updated_at: u64,
}

/// Returned by vault IPC status/initialize/unlock commands.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum VaultStatus {
    Uninitialized,
    Locked { vault_id: String, item_count: u64 },
    Unlocked { vault_id: String, item_count: u64 },
}

/// Plaintext record payload — only exists in memory after decryption.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaintextRecord {
    pub id: String,
    /// Stable logical credential identity. New records get this at creation
    /// time; legacy records may omit it and fall back to `id` for compatibility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logical_id: Option<String>,
    /// e.g. "ssh-password", "ssh-private-key", "api-key", "secure-note"
    pub kind: String,
    pub label: String,
    /// Legacy single-secret payload. It is accepted while reading old vaults
    /// and IPC compatibility calls, then migrated into `secret_values`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub secret: String,
    /// Canonical named secret values for this credential. BTreeMap provides a
    /// deterministic serialized form for sync comparisons and fingerprints.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub secret_values: BTreeMap<String, String>,
    pub notes: Option<String>,
    /// Typed credential envelope persisted with the record. Legacy vault
    /// records may not contain this field and are hydrated at read time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<CredentialEnvelope>,
    pub revision: u64,
    pub created_at: u64,
    pub updated_at: u64,
}

impl Zeroize for PlaintextRecord {
    fn zeroize(&mut self) {
        self.id.zeroize();
        self.logical_id.zeroize();
        self.kind.zeroize();
        self.label.zeroize();
        self.secret.zeroize();
        for (mut name, mut value) in std::mem::take(&mut self.secret_values) {
            name.zeroize();
            value.zeroize();
        }
        self.notes.zeroize();
        if let Some(credential) = self.credential.as_mut() {
            credential.zeroize();
        }
        self.credential = None;
        self.revision.zeroize();
        self.created_at.zeroize();
        self.updated_at.zeroize();
    }
}

impl Drop for PlaintextRecord {
    fn drop(&mut self) {
        self.zeroize();
    }
}

impl ZeroizeOnDrop for PlaintextRecord {}

/// Metadata-only vault item DTO for renderer list views.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultItemMeta {
    pub id: String,
    /// Stable logical credential identity used by hosts. This may differ from
    /// `id`, which is the current physical vault item id.
    pub logical_id: String,
    pub kind: String,
    pub label: String,
    /// Stable keyed fingerprint of the decrypted secret for equality-only UI workflows.
    /// The plaintext secret is never serialized by the list API.
    pub secret_fingerprint: String,
    pub schema_version: u32,
    pub secret_field_count: u32,
    pub has_passphrase_field: bool,
    pub revision: u64,
    pub created_at: u64,
    pub updated_at: u64,
}

/// Non-secret detail DTO for renderer edit/history views. Normal secret use
/// remains inside trusted Rust adapters rather than crossing IPC.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultItemDetail {
    pub id: String,
    pub logical_id: String,
    pub kind: String,
    pub label: String,
    pub notes: Option<String>,
    pub credential: Option<CredentialEnvelope>,
    pub revision: u64,
    pub created_at: u64,
    pub updated_at: u64,
}

/// Stored in redb records and key_slots tables as JSON bytes.
/// Contains encrypted payload; `id` and `kind` are minimal plaintext index.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredEnvelope {
    pub id: String,
    pub kind: String,
    pub revision: u64,
    pub deleted: bool,
    pub crypto_suite: String,
    pub aad_version: u32,
    /// Base64-encoded 24-byte XChaCha20 nonce.
    pub nonce: String,
    /// Base64-encoded ciphertext + 16-byte Poly1305 tag.
    pub ciphertext: String,
}

/// Metadata-only summary of a single historical revision, returned to the UI.
/// The encrypted snapshot envelope is stored in `REVISION_HISTORY`; this is
/// the decrypted header that the renderer needs to display the history list.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionMeta {
    /// The physical item id this snapshot belongs to.
    pub item_id: String,
    /// Revision number of this snapshot (the revision *before* the rotation that superseded it).
    pub revision: u64,
    /// Label at the time of this revision.
    pub label: String,
    /// Kind at the time of this revision.
    pub kind: String,
    /// Keyed fingerprint of the secret at this revision (for equality-only UI).
    pub secret_fingerprint: String,
    /// When this revision was created (unix seconds).
    pub created_at: u64,
    /// When this revision was superseded / rotated away (unix seconds).
    pub rotated_at: u64,
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::PlaintextRecord;

    #[test]
    fn plaintext_record_deserializes_legacy_without_logical_id() {
        let raw = r#"{
            "id": "item-1",
            "kind": "ssh-password",
            "label": "legacy",
            "secret": "secret",
            "revision": 1,
            "createdAt": 1,
            "updatedAt": 1
        }"#;

        let parsed: PlaintextRecord = serde_json::from_str(raw).expect("legacy vault record");

        assert_eq!(parsed.id, "item-1");
        assert_eq!(parsed.logical_id, None);
    }

    #[test]
    fn plaintext_record_serializes_without_logical_id_when_none() {
        let record = PlaintextRecord {
            id: "item-2".to_string(),
            logical_id: None,
            kind: "ssh-password".to_string(),
            label: "test".to_string(),
            secret: "s3cr3t".to_string(),
            secret_values: BTreeMap::new(),
            notes: None,
            credential: None,
            revision: 1,
            created_at: 1,
            updated_at: 1,
        };

        let json = serde_json::to_string(&record).expect("serialize PlaintextRecord");
        assert!(
            !json.contains("logicalId"),
            "logicalId must not appear in JSON when None, got: {json}"
        );
    }
}
