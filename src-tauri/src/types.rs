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
}

#[derive(Debug, Serialize)]
pub struct ConnectionResponse {
    pub success: bool,
    pub message: String,
    pub term_id: Option<String>,
    pub detected_os: Option<String>,
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
