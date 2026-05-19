use serde::{Deserialize, Serialize};
use std::str::FromStr;

pub const PROVIDER_GOOGLE: &str = "google";
#[allow(dead_code)]
pub const DOMAIN_VAULT: &str = "vault";
#[allow(dead_code)]
pub const DOMAIN_HOSTS: &str = "hosts";
#[allow(dead_code)]
pub const DOMAIN_TUNNELS: &str = "tunnels";
#[allow(dead_code)]
pub const DOMAIN_SNIPPETS: &str = "snippets";
#[allow(dead_code)]
pub const DOMAIN_SETTINGS: &str = "settings";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncProviderKind {
    Google,
}

impl SyncProviderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Google => PROVIDER_GOOGLE,
        }
    }

    pub fn parse(input: &str) -> Option<Self> {
        match input.trim().to_ascii_lowercase().as_str() {
            "google" | "google_drive" | "gdrive" => Some(Self::Google),
            _ => None,
        }
    }
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncDomain {
    Vault,
    Hosts,
    Tunnels,
    Snippets,
    Settings,
}

#[allow(dead_code)]
impl SyncDomain {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Vault => DOMAIN_VAULT,
            Self::Hosts => DOMAIN_HOSTS,
            Self::Tunnels => DOMAIN_TUNNELS,
            Self::Snippets => DOMAIN_SNIPPETS,
            Self::Settings => DOMAIN_SETTINGS,
        }
    }

    pub fn parse(input: &str) -> Option<Self> {
        match input.trim().to_ascii_lowercase().as_str() {
            DOMAIN_VAULT => Some(Self::Vault),
            DOMAIN_HOSTS => Some(Self::Hosts),
            DOMAIN_TUNNELS => Some(Self::Tunnels),
            DOMAIN_SNIPPETS => Some(Self::Snippets),
            DOMAIN_SETTINGS => Some(Self::Settings),
            _ => None,
        }
    }
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncPolicyMode {
    Manual,
    OnChange,
    Interval,
}

impl Default for SyncPolicyMode {
    fn default() -> Self {
        Self::Manual
    }
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDomainPolicy {
    pub domain: SyncDomain,
    #[serde(default = "default_enabled_true")]
    pub enabled: bool,
    #[serde(default)]
    pub mode: SyncPolicyMode,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDomainStatus {
    pub domain: SyncDomain,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sync: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error_code: Option<String>,
}

#[allow(dead_code)]
const fn default_enabled_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EncryptionMode {
    ProviderEncrypted,
    AppEncryptedOnly,
}

impl Default for EncryptionMode {
    fn default() -> Self {
        Self::AppEncryptedOnly
    }
}

impl FromStr for EncryptionMode {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "provider_encrypted" => Ok(Self::ProviderEncrypted),
            "app_encrypted_only" => Ok(Self::AppEncryptedOnly),
            _ => Err(()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Base64EncodedData(String);

impl Base64EncodedData {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for Base64EncodedData {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode(&value)
            .map_err(|e| format!("invalid base64 value: {e}"))?;
        Ok(Self(value))
    }
}

impl From<Base64EncodedData> for String {
    fn from(value: Base64EncodedData) -> Self {
        value.0
    }
}

impl Serialize for Base64EncodedData {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for Base64EncodedData {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Base64EncodedData::try_from(raw).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities {
    pub supports_autosync: bool,
    pub supports_incremental: bool,
    pub supports_etag: bool,
    pub supports_domains: bool,
    pub max_object_size: Option<u64>,
    pub encryption_mode: EncryptionMode,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProviderStatus {
    pub provider: String,
    pub connected: bool,
    // NOTE(PII): kept for current UX (show connected account email in UI).
    // Do not log directly; use redacted Debug impl / safe logging wrappers.
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    pub last_sync: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub domain_statuses: Vec<SyncDomainStatus>,
    pub capabilities: ProviderCapabilities,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SyncKeyPolicyMode {
    LocalPassphrase,
    CustomPassphrase,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCollectionManifest {
    pub version: u32,
    pub provider: String,
    pub sync_collection_id: String,
    pub key_policy_mode: SyncKeyPolicyMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_wrap_salt: Option<Base64EncodedData>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_wrap_nonce: Option<Base64EncodedData>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_wrap_ciphertext: Option<Base64EncodedData>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_key_wrap_salt: Option<Base64EncodedData>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_key_wrap_nonce: Option<Base64EncodedData>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_key_wrap_ciphertext: Option<Base64EncodedData>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_cache_unlocked_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_cache_ttl_secs: Option<u64>,
    pub has_recovery_key: bool,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCollectionStatus {
    pub provider: String,
    pub configured: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_collection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_policy_mode: Option<SyncKeyPolicyMode>,
    pub has_recovery_key: bool,
    #[serde(default)]
    pub key_cached: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_cache_ttl_secs: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCollectionSetupResult {
    pub status: SyncCollectionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCollectionSetupArgs {
    pub key_policy_mode: SyncKeyPolicyMode,
    #[serde(default)]
    pub passphrase: Option<String>,
    #[serde(default)]
    pub has_recovery_key: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCollectionUnlockArgs {
    #[serde(default)]
    pub passphrase: Option<String>,
    #[serde(default)]
    pub recovery_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncUploadCredentialArgs {
    pub item_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncUploadCredentialResult {
    pub provider: String,
    pub logical_id: String,
    pub revision: u64,
    pub object_name: String,
    pub synced_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRestoreCredentialsArgs {
    #[serde(default)]
    pub logical_ids: Option<Vec<String>>,
    #[serde(default)]
    pub resolve_conflict_logical_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRestoreCredentialsResult {
    pub provider: String,
    pub scanned: u64,
    pub restored: u64,
    pub updated: u64,
    pub tombstones_applied: u64,
    pub skipped: u64,
    pub conflicts: u64,
    pub failed: u64,
    pub synced_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRestorePreviewResult {
    pub provider: String,
    pub scanned: u64,
    pub restorable: u64,
    pub updatable: u64,
    pub tombstoned: u64,
    pub stale: u64,
    pub conflicts: u64,
    pub failed: u64,
    #[serde(default)]
    pub conflict_items: Vec<SyncRestoreConflictItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRestoreConflictItem {
    pub logical_id: String,
    pub kind: String,
    pub label: String,
    pub local_revision: u64,
    pub local_updated_at: u64,
    pub remote_revision: u64,
    pub remote_updated_at: u64,
    pub remote_deleted: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProfile {
    pub provider: String,
    pub connected: bool,
    // NOTE(PII): intentionally stored for current UX continuity.
    // Future hardening can move this to a stricter non-serialized identity path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sync: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub domain_policies: Vec<SyncDomainPolicy>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub domain_statuses: Vec<SyncDomainStatus>,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProfilesStore {
    pub version: u32,
    #[serde(default)]
    pub profiles: Vec<SyncProfile>,
}

impl Default for SyncProfilesStore {
    fn default() -> Self {
        Self {
            version: 1,
            profiles: Vec::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ProviderIdentity {
    pub email: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCredentialObject {
    pub object_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ProviderStatusSnapshot {
    pub connected: bool,
    pub email: Option<String>,
    pub avatar_url: Option<String>,
    pub last_sync: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct SyncError {
    pub code: &'static str,
    pub message: String,
}

impl SyncError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for SyncError {}

pub type SyncResult<T> = Result<T, SyncError>;

impl std::fmt::Debug for SyncProviderStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SyncProviderStatus")
            .field("provider", &self.provider)
            .field("connected", &self.connected)
            .field(
                "email",
                &self.email.as_ref().map(|_| "<redacted>"),
            )
            .field("avatar_url", &self.avatar_url.as_ref().map(|_| "<redacted>"))
            .field("last_sync", &self.last_sync)
            .field("last_error", &self.last_error)
            .field("last_error_code", &self.last_error_code)
            .field("capabilities", &self.capabilities)
            .finish()
    }
}

impl std::fmt::Debug for SyncProfile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SyncProfile")
            .field("provider", &self.provider)
            .field("connected", &self.connected)
            .field("email", &self.email.as_ref().map(|_| "<redacted>"))
            .field("avatar_url", &self.avatar_url.as_ref().map(|_| "<redacted>"))
            .field("last_sync", &self.last_sync)
            .field("last_error", &self.last_error)
            .field("last_error_code", &self.last_error_code)
            .field("updated_at", &self.updated_at)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_domain_parse_accepts_expected_values() {
        assert_eq!(SyncDomain::parse("vault"), Some(SyncDomain::Vault));
        assert_eq!(SyncDomain::parse("hosts"), Some(SyncDomain::Hosts));
        assert_eq!(SyncDomain::parse("tunnels"), Some(SyncDomain::Tunnels));
        assert_eq!(SyncDomain::parse("snippets"), Some(SyncDomain::Snippets));
        assert_eq!(SyncDomain::parse("settings"), Some(SyncDomain::Settings));
    }

    #[test]
    fn sync_domain_parse_rejects_unknown_values() {
        assert_eq!(SyncDomain::parse("unknown"), None);
        assert_eq!(SyncDomain::parse(""), None);
    }
}
