use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    pub jump_host: Option<Box<ConnectionConfig>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AuthMethod {
    Password {
        password: String,
    },
    PrivateKey {
        key_path: String,
        passphrase: Option<String>,
    },
    /// Sent by the frontend when the connection uses a vault credential.
    /// The backend resolves this to Password or PrivateKeyData before authenticating.
    VaultRef {
        item_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        credential_id: Option<String>,
    },
    /// Internal only — constructed by the backend after vault resolution.
    /// Never accepted from IPC input; VaultRef is the on-wire form.
    #[serde(skip_deserializing, skip_serializing)]
    PrivateKeyData {
        key_data: String,
        passphrase: Option<String>,
    },
}

#[derive(Debug, Serialize)]
pub struct ConnectionResponse {
    pub success: bool,
    pub message: String,
    pub term_id: Option<String>,
    pub detected_os: Option<String>,
}

/// A reference to a vault item used as SSH credentials.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialRef {
    pub vault_id: String,
    /// Stable logical credential identity. When present, this survives vault
    /// item recreation/import and `item_id` is only the current fast-path item.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_id: Option<String>,
    pub item_id: String,
    pub item_kind: CredentialItemKind,
    pub purpose: CredentialPurpose,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CredentialItemKind {
    SshPassword,
    SshPrivateKey,
    SshAgentKey,
}

impl CredentialItemKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::SshPassword => "ssh-password",
            Self::SshPrivateKey => "ssh-private-key",
            Self::SshAgentKey => "ssh-agent-key",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[non_exhaustive]
pub enum CredentialPurpose {
    SshAuth,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")] // Match TS interface
pub struct SavedConnection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub private_key_path: Option<String>, // TS: privateKeyPath
    pub jump_server_id: Option<String>,
    pub last_connected: Option<u64>,
    pub icon: Option<String>,
    pub folder: Option<String>,
    pub theme: Option<String>,
    pub tags: Option<Vec<String>>,
    pub created_at: Option<u64>,
    pub is_favorite: Option<bool>,
    pub pinned_features: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_ref: Option<CredentialRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Folder {
    pub name: String,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SavedData {
    pub connections: Vec<SavedConnection>,
    pub folders: Vec<Folder>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTunnel {
    pub id: String,
    pub connection_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub tunnel_type: String, // "local" or "remote"
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub bind_address: Option<String>,
    pub bind_to_any: Option<bool>,
    pub auto_start: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_port: Option<u16>, // Tracks original port when auto-switched
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SavedTunnelsData {
    pub tunnels: Vec<SavedTunnel>,
}

#[cfg(test)]
mod tests {
    use super::CredentialRef;

    #[test]
    fn credential_ref_deserializes_legacy_without_credential_id() {
        let raw = r#"{
            "vaultId": "vault-1",
            "itemId": "item-1",
            "itemKind": "ssh-private-key",
            "purpose": "ssh-auth"
        }"#;

        let parsed: CredentialRef = serde_json::from_str(raw).expect("legacy authRef");

        assert_eq!(parsed.credential_id, None);
        assert_eq!(parsed.item_id, "item-1");
    }
}
