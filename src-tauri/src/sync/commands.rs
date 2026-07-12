use super::collection::{
    clear_collection_key_cache, collection_key_wrap_object_name, enforce_collection_key_cache_ttl,
    has_recovery_key_slot, is_collection_key_cached, load_collection_key, load_manifest,
    regenerate_recovery_key, remote_key_wrap_from_manifest, save_manifest, set_collection_key_cache_ttl,
    setup_manifest, RemoteCollectionKeyWrapV1, SYNC_COLLECTION_KEY_CACHE_TTL_SECS,
    unlock_collection_key_with_passphrase, unlock_collection_key_with_recovery_key,
};
use super::domain_hosts::{apply_hosts_restore_records, load_hosts_sync_records, HostSyncRecord};
use super::domain_settings::{load_allowlisted_settings, SettingsSyncRecord, SETTINGS_ALLOWLIST_KEYS};
use super::domain_snippets::{
    apply_snippet_restore_records, load_snippet_sync_records, snippet_record_logical_id,
    SnippetSyncRecord,
};
use super::domain_tunnels::{apply_tunnel_restore_records, load_tunnel_sync_records, TunnelSyncRecord};
use super::profiles::{get_profile, now_secs, upsert_profile};
use super::provider::{validate_provider_contract, ProviderUploadRecord, VaultProviderV1};
use super::providers::google::{legacy_google_token_snapshot, GoogleVaultProvider};
use super::types::{
    ProviderCapabilities, ProviderCredentialObject, ProviderStatusSnapshot, SyncCollectionDiscoverResult,
    SyncCollectionManifest, SyncCollectionSetupArgs, SyncCollectionSetupResult, SyncCollectionStatus,
    SyncCollectionUnlockArgs, SyncDomain,
    SyncDomainPolicy, SyncDomainStatus, SyncError, SyncKeyPolicyMode, SyncPolicyMode, SyncProfile, SyncProviderKind,
    SyncProviderStatus, SyncResult, SyncRestoreConflictItem,
    SyncRestoreCredentialsArgs, SyncRestoreCredentialsResult, SyncRestorePreviewResult,
    SyncUploadCredentialArgs, SyncUploadCredentialResult, SyncUploadCredentialsResult,
};
use crate::vault::credential::{normalize_record_credential, CredentialEnvelope};
use crate::vault::crypto::{decrypt_record, encrypt_record, EncryptedEnvelope, SecretKey};
use crate::vault::types::PlaintextRecord;
use crate::vault::store::VaultService;
use crate::vault::types::VaultStatus;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use tauri::State;
use tokio::sync::Mutex;

fn sync_error_to_string(error: &SyncError) -> String {
    if error.code.eq_ignore_ascii_case("LOCAL_DISCONNECT_ONLY") {
        return error.message.clone();
    }
    format!("[{}] {}", error.code, error.message)
}

fn sync_local_error(code: &'static str, message: impl Into<String>) -> String {
    format!("[{code}] {}", message.into())
}

fn parse_provider(provider: &str) -> Result<SyncProviderKind, String> {
    SyncProviderKind::parse(provider)
        .ok_or_else(|| format!("[unknown_provider] Unknown provider: {provider}"))
}

fn provider_for(kind: SyncProviderKind) -> SyncResult<Box<dyn VaultProviderV1>> {
    let provider: Box<dyn VaultProviderV1> = match kind {
        SyncProviderKind::Google => Box::new(GoogleVaultProvider),
    };
    validate_provider_contract(provider.as_ref())?;
    Ok(provider)
}

fn default_profile(kind: SyncProviderKind) -> SyncProfile {
    SyncProfile {
        provider: kind.as_str().to_string(),
        connected: false,
        email: None,
        avatar_url: None,
        last_sync: None,
        last_error: None,
        last_error_code: None,
        domain_policies: default_domain_policies(),
        domain_statuses: default_domain_statuses(),
        updated_at: 0,
    }
}

fn default_domain_policies() -> Vec<SyncDomainPolicy> {
    vec![
        SyncDomainPolicy { domain: SyncDomain::Vault, enabled: true, mode: SyncPolicyMode::Manual },
        SyncDomainPolicy { domain: SyncDomain::Hosts, enabled: true, mode: SyncPolicyMode::Manual },
        SyncDomainPolicy { domain: SyncDomain::Tunnels, enabled: true, mode: SyncPolicyMode::Manual },
        SyncDomainPolicy { domain: SyncDomain::Snippets, enabled: true, mode: SyncPolicyMode::Manual },
        SyncDomainPolicy { domain: SyncDomain::Settings, enabled: true, mode: SyncPolicyMode::Manual },
    ]
}

fn default_domain_statuses() -> Vec<SyncDomainStatus> {
    default_domain_policies()
        .into_iter()
        .map(|p| SyncDomainStatus {
            domain: p.domain,
            enabled: p.enabled,
            last_sync: None,
            last_error: None,
            last_error_code: None,
        })
        .collect()
}

fn ensure_domain_collections(profile: &mut SyncProfile) {
    if profile.domain_policies.is_empty() {
        profile.domain_policies = default_domain_policies();
    } else {
        for default_policy in default_domain_policies() {
            if profile
                .domain_policies
                .iter()
                .all(|policy| policy.domain != default_policy.domain)
            {
                profile.domain_policies.push(default_policy);
            }
        }
    }
    if profile.domain_statuses.is_empty() {
        profile.domain_statuses = default_domain_statuses();
    } else {
        for policy in &profile.domain_policies {
            if profile
                .domain_statuses
                .iter()
                .all(|status| status.domain != policy.domain)
            {
                profile.domain_statuses.push(SyncDomainStatus {
                    domain: policy.domain,
                    enabled: policy.enabled,
                    last_sync: None,
                    last_error: None,
                    last_error_code: None,
                });
            }
        }
        for status in &mut profile.domain_statuses {
            if let Some(policy) = profile
                .domain_policies
                .iter()
                .find(|policy| policy.domain == status.domain)
            {
                status.enabled = policy.enabled;
            }
        }
    }
    migrate_legacy_opt_in_domain_defaults(profile);
}

fn migrate_legacy_opt_in_domain_defaults(profile: &mut SyncProfile) {
    let app_data_domains = [
        SyncDomain::Tunnels,
        SyncDomain::Snippets,
        SyncDomain::Settings,
    ];
    let looks_like_old_defaults = app_data_domains.iter().all(|domain| {
        let policy_disabled = profile
            .domain_policies
            .iter()
            .find(|policy| policy.domain == *domain)
            .map(|policy| !policy.enabled)
            .unwrap_or(false);
        let status_is_untouched = profile
            .domain_statuses
            .iter()
            .find(|status| status.domain == *domain)
            .map(|status| {
                status.last_sync.is_none()
                    && status.last_error.is_none()
                    && status.last_error_code.is_none()
            })
            .unwrap_or(true);
        policy_disabled && status_is_untouched
    });

    if !looks_like_old_defaults {
        return;
    }

    for domain in app_data_domains {
        if let Some(policy) = profile
            .domain_policies
            .iter_mut()
            .find(|policy| policy.domain == domain)
        {
            policy.enabled = true;
        }
        if let Some(status) = profile
            .domain_statuses
            .iter_mut()
            .find(|status| status.domain == domain)
        {
            status.enabled = true;
        }
    }
}

fn is_domain_enabled(profile: &SyncProfile, domain: SyncDomain) -> bool {
    profile
        .domain_policies
        .iter()
        .find(|p| p.domain == domain)
        .map(|p| p.enabled)
        .unwrap_or(true)
}

fn domain_last_sync(profile: &SyncProfile, domain: SyncDomain) -> Option<u64> {
    profile
        .domain_statuses
        .iter()
        .find(|status| status.domain == domain)
        .and_then(|status| status.last_sync)
}

fn ensure_domain_enabled_for_provider(
    data_dir: &Path,
    provider: SyncProviderKind,
    domain: SyncDomain,
) -> Result<(), String> {
    let mut profile = get_profile(data_dir, provider)
        .map_err(|e| sync_error_to_string(&e))?
        .unwrap_or_else(|| default_profile(provider));
    ensure_domain_collections(&mut profile);
    if is_domain_enabled(&profile, domain) {
        Ok(())
    } else {
        Err(format!(
            "[sync_domain_disabled] {} sync is disabled for this provider profile.",
            domain.as_str()
        ))
    }
}

fn status_from_profile(
    mut profile: SyncProfile,
    provider_kind: SyncProviderKind,
    capabilities: ProviderCapabilities,
) -> SyncProviderStatus {
    ensure_domain_collections(&mut profile);
    SyncProviderStatus {
        provider: provider_kind.as_str().to_string(),
        connected: profile.connected,
        email: profile.email,
        avatar_url: profile.avatar_url,
        last_sync: profile.last_sync,
        last_error: profile.last_error,
        last_error_code: profile.last_error_code,
        domain_statuses: profile.domain_statuses,
        capabilities,
    }
}

fn sync_profile_from_snapshot(
    kind: SyncProviderKind,
    snapshot: ProviderStatusSnapshot,
    existing: Option<SyncProfile>,
) -> SyncProfile {
    let mut profile = existing.unwrap_or_else(|| default_profile(kind));
    ensure_domain_collections(&mut profile);
    profile.connected = snapshot.connected;
    profile.email = snapshot.email.or(profile.email);
    profile.avatar_url = snapshot.avatar_url.or(profile.avatar_url);
    profile.last_sync = snapshot.last_sync.or(profile.last_sync);
    profile.last_error = None;
    profile.last_error_code = None;
    profile
}

fn snapshot_from_legacy(provider: SyncProviderKind, data_dir: &Path) -> Option<ProviderStatusSnapshot> {
    match provider {
        SyncProviderKind::Google => legacy_google_token_snapshot(data_dir),
    }
}

fn record_sync_error(
    data_dir: &Path,
    provider: SyncProviderKind,
    code: &'static str,
    message: impl Into<String>,
) {
    let message = message.into();
    let _ = upsert_profile(data_dir, provider, |existing| {
        let mut profile = existing.unwrap_or_else(|| default_profile(provider));
        ensure_domain_collections(&mut profile);
        profile.last_error_code = Some(code.to_string());
        profile.last_error = Some(message.clone());
        profile
    });
}

fn record_domain_sync_error(
    data_dir: &Path,
    provider: SyncProviderKind,
    domain: SyncDomain,
    code: &'static str,
    message: impl Into<String>,
) {
    let message = message.into();
    let _ = upsert_profile(data_dir, provider, |existing| {
        let mut profile = existing.unwrap_or_else(|| default_profile(provider));
        ensure_domain_collections(&mut profile);
        profile.last_error_code = Some(code.to_string());
        profile.last_error = Some(message.clone());
        if let Some(status) = profile.domain_statuses.iter_mut().find(|s| s.domain == domain) {
            status.last_error_code = Some(code.to_string());
            status.last_error = Some(message.clone());
        }
        profile
    });
}

fn record_domain_sync_success(
    data_dir: &Path,
    provider: SyncProviderKind,
    domain: SyncDomain,
    synced_at: u64,
) -> Result<(), SyncError> {
    upsert_profile(data_dir, provider, |existing| {
        let mut profile = existing.unwrap_or_else(|| default_profile(provider));
        ensure_domain_collections(&mut profile);
        profile.connected = true;
        profile.last_sync = Some(synced_at);
        profile.last_error = None;
        profile.last_error_code = None;
        let enabled = is_domain_enabled(&profile, domain);
        if let Some(status) = profile.domain_statuses.iter_mut().find(|s| s.domain == domain) {
            status.enabled = enabled;
            status.last_sync = Some(synced_at);
            status.last_error = None;
            status.last_error_code = None;
        }
        profile
    })?;
    Ok(())
}

fn clear_sync_error(data_dir: &Path, provider: SyncProviderKind) {
    let _ = upsert_profile(data_dir, provider, |existing| {
        let mut profile = existing.unwrap_or_else(|| default_profile(provider));
        ensure_domain_collections(&mut profile);
        profile.last_error = None;
        profile.last_error_code = None;
        profile
    });
}

const SYNC_COLLECTION_PASSPHRASE_MIN_LENGTH: usize = 12;

fn resolve_discovered_sync_collection_id(
    mut collection_ids: Vec<String>,
    preferred_sync_collection_id: Option<&str>,
    provider_label: &str,
) -> Result<Option<String>, String> {
    collection_ids.sort();
    collection_ids.dedup();

    let preferred = preferred_sync_collection_id
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let Some(id) = preferred {
        if collection_ids.iter().any(|existing| existing == id) {
            return Ok(Some(id.to_string()));
        }
        return Err(
            "[sync_collection_id_not_found] Selected encrypted sync collection was not found on google."
                .to_string(),
        );
    }

    match collection_ids.len() {
        0 => Ok(None),
        1 => Ok(collection_ids.into_iter().next()),
        count => Err(format!(
            "[sync_collection_ambiguous_remote] Found {count} existing encrypted sync collections in {provider_label}. Choose which backup to link on this device."
        )),
    }
}

fn collection_status_from_manifest(
    provider: SyncProviderKind,
    manifest: Option<super::types::SyncCollectionManifest>,
) -> SyncCollectionStatus {
    match manifest {
        Some(m) => SyncCollectionStatus {
            provider: provider.as_str().to_string(),
            configured: true,
            sync_collection_id: Some(m.sync_collection_id.clone()),
            key_policy_mode: Some(m.key_policy_mode),
            has_recovery_key: has_recovery_key_slot(&m),
            key_cached: is_collection_key_cached(&m),
            key_cache_ttl_secs: Some(m.key_cache_ttl_secs.unwrap_or(SYNC_COLLECTION_KEY_CACHE_TTL_SECS)),
        },
        None => SyncCollectionStatus {
            provider: provider.as_str().to_string(),
            configured: false,
            sync_collection_id: None,
            key_policy_mode: None,
            has_recovery_key: false,
            key_cached: false,
            key_cache_ttl_secs: None,
        },
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncHostsSnapshotResult {
    pub domain: String,
    pub count: u64,
    pub records: Vec<HostSyncRecord>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncHostsChangesArgs {
    #[serde(default)]
    pub logical_ids: Option<Vec<String>>,
    #[serde(default)]
    pub include_all: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncHostsChangesResult {
    pub domain: String,
    pub count: u64,
    pub since: Option<u64>,
    pub records: Vec<HostSyncRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncHostsUploadResult {
    pub domain: String,
    pub uploaded: u64,
    pub credentials_uploaded: u64,
    pub skipped: u64,
    pub synced_at: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncHostsRestoreArgs {
    #[serde(default)]
    pub logical_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncHostsRestoreResult {
    pub domain: String,
    pub scanned: u64,
    pub restored: u64,
    pub updated: u64,
    pub credentials_scanned: u64,
    pub credentials_restored: u64,
    pub credentials_updated: u64,
    pub credentials_skipped: u64,
    pub credentials_conflicts: u64,
    pub credentials_failed: u64,
    pub credential_refs_relinked: u64,
    pub skipped: u64,
    pub failed: u64,
    pub synced_at: u64,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConnectionsRestoreArgs {
    #[serde(default)]
    pub host_logical_ids: Option<Vec<String>>,
    #[serde(default = "default_true")]
    pub include_host_definitions: bool,
    #[serde(default = "default_true")]
    pub include_tunnels: bool,
    #[serde(default = "default_true")]
    pub include_host_snippets: bool,
    #[serde(default = "default_true")]
    pub include_referenced_credentials: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConnectionsBundledDomainResult {
    pub domain: String,
    pub scanned: u64,
    pub restored: u64,
    pub updated: u64,
    pub skipped: u64,
    pub skipped_orphaned: u64,
    pub failed: u64,
    pub synced_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConnectionsRestoreResult {
    pub hosts: SyncHostsRestoreResult,
    pub tunnels: Option<SyncConnectionsBundledDomainResult>,
    pub host_snippets: Option<SyncConnectionsBundledDomainResult>,
    pub synced_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConnectionsRestorePreviewResult {
    pub provider: String,
    pub hosts_selected: u64,
    pub hosts_new: u64,
    pub hosts_existing: u64,
    pub referenced_credentials: u64,
    pub hosts_failed: u64,
    pub tunnels_scanned: Option<u64>,
    pub tunnels_restorable: Option<u64>,
    pub tunnels_orphaned: Option<u64>,
    pub host_snippets_scanned: Option<u64>,
    pub host_snippets_restorable: Option<u64>,
    pub host_snippets_orphaned: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncSnippetsRestoreArgs {
    #[serde(default)]
    pub global_only: bool,
    #[serde(default)]
    pub host_connection_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRemoteHostInventoryItem {
    pub provider: String,
    pub collection_id: String,
    pub logical_id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub folder: Option<String>,
    pub tags: Vec<String>,
    pub is_favorite: bool,
    pub updated_at: u64,
    pub revision: u64,
    pub has_auth_ref: bool,
    pub credential_id: Option<String>,
    pub local_exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncHostsRemoteInventoryResult {
    pub provider: String,
    pub collection_id: String,
    pub scanned: u64,
    pub hosts: Vec<SyncRemoteHostInventoryItem>,
    pub skipped: u64,
    pub failed: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTunnelsSnapshotResult {
    pub domain: String,
    pub count: u64,
    pub records: Vec<TunnelSyncRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSnippetsSnapshotResult {
    pub domain: String,
    pub count: u64,
    pub records: Vec<SnippetSyncRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDomainUploadResult {
    pub domain: String,
    pub uploaded: u64,
    pub skipped: u64,
    pub synced_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDomainRestoreResult {
    pub domain: String,
    pub scanned: u64,
    pub restored: u64,
    pub updated: u64,
    pub skipped: u64,
    pub failed: u64,
    pub synced_at: u64,
}


#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDomainPoliciesResult {
    pub provider: String,
    pub policies: Vec<SyncDomainPolicy>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDomainPolicySetArgs {
    pub domain: String,
    pub enabled: bool,
    #[serde(default)]
    pub mode: Option<SyncPolicyMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncCredentialPlaintextV1 {
    logical_id: String,
    kind: String,
    label: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    secret: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    secret_values: BTreeMap<String, String>,
    notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    credential: Option<CredentialEnvelope>,
    revision: u64,
    updated_at: u64,
    #[serde(default)]
    deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncCredentialEncryptedV1 {
    version: u32,
    provider: String,
    sync_collection_id: String,
    logical_id: String,
    revision: u64,
    updated_at: u64,
    aad: String,
    nonce: String,
    ciphertext: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncHostsEncryptedV1 {
    version: u32,
    domain: String,
    provider: String,
    sync_collection_id: String,
    logical_id: String,
    revision: u64,
    updated_at: u64,
    aad: String,
    nonce: String,
    ciphertext: String,
}

fn credential_object_name(sync_collection_id: &str, logical_id: &str) -> String {
    format!(
        "zync-sync-{}-credential-{}.zcred",
        sync_collection_id, logical_id
    )
}

fn credential_aad(sync_collection_id: &str, logical_id: &str, revision: u64) -> String {
    format!(
        "zync:sync-credential:v1|collection:{sync_collection_id}|logical:{logical_id}|revision:{revision}"
    )
}

fn hosts_object_name(sync_collection_id: &str, logical_id: &str) -> String {
    format!(
        "zync-sync-{}-hosts-{}.zhost",
        sync_collection_id, logical_id
    )
}

fn hosts_aad(sync_collection_id: &str, logical_id: &str, revision: u64) -> String {
    format!(
        "zync:sync-hosts:v1|collection:{sync_collection_id}|logical:{logical_id}|revision:{revision}"
    )
}

fn domain_object_name(sync_collection_id: &str, domain: &str, logical_id: &str, ext: &str) -> String {
    format!("zync-sync-{}-{}-{}.{}", sync_collection_id, domain, logical_id, ext)
}

fn domain_aad(sync_collection_id: &str, domain: &str, logical_id: &str, revision: u64) -> String {
    format!(
        "zync:sync-{domain}:v1|collection:{sync_collection_id}|logical:{logical_id}|revision:{revision}"
    )
}

/// App-data domains currently derive their upload revision from `updated_at`;
/// vault credential revisions remain independent monotonic counters.
fn default_revision(updated_at: u64) -> u64 {
    if updated_at == 0 { 1 } else { updated_at }
}

fn is_credential_object_name(object_name: &str) -> bool {
    object_name.contains("-credential-") && object_name.ends_with(".zcred")
}

fn is_domain_object_name(object_name: &str, domain: &str, extension: &str) -> bool {
    object_name.contains(&format!("-{}-", domain)) && object_name.ends_with(extension)
}

struct DomainUploadMeta<'a> {
    domain: &'a str,
    logical_id: &'a str,
    revision: u64,
    updated_at: u64,
    extension: &'a str,
}

async fn upload_domain_record<T: serde::Serialize>(
    provider_impl: &dyn VaultProviderV1,
    app: &tauri::AppHandle,
    provider: SyncProviderKind,
    manifest: &super::types::SyncCollectionManifest,
    secret_key: &SecretKey,
    data_dir: &Path,
    payload: &T,
    meta: DomainUploadMeta<'_>,
) -> Result<u64, String> {
    let plaintext_bytes = serde_json::to_vec(payload)
        .map_err(|e| format!("[sync_serialize_failed] Failed to serialize {} record: {e}", meta.domain))?;
    let aad = domain_aad(
        &manifest.sync_collection_id,
        meta.domain,
        meta.logical_id,
        meta.revision,
    );
    let envelope = encrypt_record(secret_key, &plaintext_bytes, aad.as_bytes())
        .map_err(|e| format!("[sync_encrypt_failed] Failed to encrypt {} record: {e}", meta.domain))?;
    let encrypted = SyncHostsEncryptedV1 {
        version: 1,
        domain: meta.domain.to_string(),
        provider: provider.as_str().to_string(),
        sync_collection_id: manifest.sync_collection_id.clone(),
        logical_id: meta.logical_id.to_string(),
        revision: meta.revision,
        updated_at: meta.updated_at,
        aad,
        nonce: base64::engine::general_purpose::STANDARD.encode(envelope.nonce),
        ciphertext: base64::engine::general_purpose::STANDARD.encode(envelope.ciphertext),
    };
    let payload_bytes = serde_json::to_vec(&encrypted).map_err(|e| {
        format!(
            "[sync_serialize_failed] Failed to serialize encrypted {} record: {e}",
            meta.domain
        )
    })?;
    let object_name = domain_object_name(
        &manifest.sync_collection_id,
        meta.domain,
        meta.logical_id,
        meta.extension,
    );
    provider_impl
        .upload_credential_record(app, &object_name, payload_bytes)
        .await
        .map_err(|error| {
            if let Some(domain) = SyncDomain::parse(meta.domain) {
                record_domain_sync_error(data_dir, provider, domain, error.code, error.message.clone());
            } else {
                record_sync_error(data_dir, provider, error.code, error.message.clone());
            }
            sync_error_to_string(&error)
        })
}

struct DomainCollectResult<T> {
    scanned: u64,
    skipped: u64,
    failed: u64,
    records: Vec<T>,
}

async fn collect_domain_records<T>(
    provider_impl: &dyn VaultProviderV1,
    app: &tauri::AppHandle,
    manifest: &super::types::SyncCollectionManifest,
    secret_key: &SecretKey,
    domain: &str,
    extension: &str,
) -> Result<DomainCollectResult<T>, String>
where
    T: serde::de::DeserializeOwned,
{
    let remote_objects = provider_impl
        .list_collection_records(app, &manifest.sync_collection_id)
        .await
        .map_err(|e| sync_error_to_string(&e))?;

    let mut scanned = 0u64;
    let mut skipped = 0u64;
    let mut failed = 0u64;
    let mut records = Vec::<T>::new();

    for object in remote_objects {
        if !is_domain_object_name(&object.object_name, domain, extension) {
            continue;
        }
        scanned = scanned.saturating_add(1);
        let payload = match provider_impl.read_credential_record(app, &object).await {
            Ok(v) => v,
            Err(_) => {
                failed += 1;
                continue;
            }
        };
        let encrypted: SyncHostsEncryptedV1 = match serde_json::from_slice(&payload) {
            Ok(v) => v,
            Err(_) => {
                failed += 1;
                continue;
            }
        };
        if encrypted.domain != domain || encrypted.sync_collection_id != manifest.sync_collection_id {
            skipped += 1;
            continue;
        }
        let envelope = match decode_sync_hosts_envelope(&encrypted) {
            Ok(v) => v,
            Err(_) => {
                failed += 1;
                continue;
            }
        };
        let expected_aad = domain_aad(
            &manifest.sync_collection_id,
            domain,
            &encrypted.logical_id,
            encrypted.revision,
        );
        let plaintext = match decrypt_record(secret_key, &envelope, expected_aad.as_bytes()) {
            Ok(v) => v,
            Err(_) => {
                failed += 1;
                continue;
            }
        };
        let record: T = match serde_json::from_slice(&plaintext) {
            Ok(v) => v,
            Err(_) => {
                failed += 1;
                continue;
            }
        };
        records.push(record);
    }

    Ok(DomainCollectResult {
        scanned,
        skipped,
        failed,
        records,
    })
}

impl SyncCredentialPlaintextV1 {
    fn normalize(&mut self) {
        let mut record = PlaintextRecord {
            id: self.logical_id.clone(),
            logical_id: Some(self.logical_id.clone()),
            kind: self.kind.clone(),
            label: self.label.clone(),
            secret: self.secret.clone(),
            secret_values: self.secret_values.clone(),
            notes: self.notes.clone(),
            credential: self.credential.clone(),
            revision: self.revision,
            created_at: self.updated_at,
            updated_at: self.updated_at,
        };
        normalize_record_credential(&mut record);
        self.kind = record.kind.clone();
        self.secret.clear();
        self.secret_values = record.secret_values.clone();
        self.credential = record.credential.clone();
    }
}

struct RemoteHostCollectResult {
    scanned: u64,
    skipped: u64,
    failed: u64,
    records: Vec<(HostSyncRecord, u64)>,
}

/// Resolve which provider host objects to download.
/// When a logical-id filter is present, download only those named files (O(filter)),
/// not every host in the collection (was O(all hosts) — made Keep-and-open very slow).
fn host_objects_for_collect(
    collection_id: &str,
    logical_id_filter: Option<&HashSet<String>>,
    listed: Vec<ProviderCredentialObject>,
) -> Vec<ProviderCredentialObject> {
    if let Some(filter) = logical_id_filter {
        if !filter.is_empty() {
            return filter
                .iter()
                .map(|logical_id| ProviderCredentialObject {
                    object_name: hosts_object_name(collection_id, logical_id),
                    object_id: None,
                })
                .collect();
        }
    }
    listed
        .into_iter()
        .filter(|object| is_domain_object_name(&object.object_name, "hosts", ".zhost"))
        .collect()
}

fn credential_objects_for_restore(
    collection_id: &str,
    requested_logical_ids: Option<&HashSet<String>>,
    listed: Vec<ProviderCredentialObject>,
) -> Vec<ProviderCredentialObject> {
    if let Some(filter) = requested_logical_ids {
        if !filter.is_empty() {
            return filter
                .iter()
                .map(|logical_id| ProviderCredentialObject {
                    object_name: credential_object_name(collection_id, logical_id),
                    object_id: None,
                })
                .collect();
        }
    }
    listed
        .into_iter()
        .filter(|object| is_credential_object_name(&object.object_name))
        .collect()
}

async fn collect_remote_host_records(
    provider_impl: &dyn VaultProviderV1,
    app: &tauri::AppHandle,
    provider: SyncProviderKind,
    manifest: &super::types::SyncCollectionManifest,
    secret_key: &SecretKey,
    logical_id_filter: Option<&HashSet<String>>,
) -> Result<RemoteHostCollectResult, String> {
    // Full listing only when we need every host (inventory / unfiltered restore).
    // Filtered restore constructs object names and downloads those files only.
    let listed = if logical_id_filter.map(|f| !f.is_empty()).unwrap_or(false) {
        Vec::new()
    } else {
        provider_impl
            .list_collection_records(app, &manifest.sync_collection_id)
            .await
            .map_err(|e| sync_error_to_string(&e))?
    };

    let remote_objects = host_objects_for_collect(
        &manifest.sync_collection_id,
        logical_id_filter,
        listed,
    );

    let mut scanned = 0u64;
    let mut skipped = 0u64;
    let mut failed = 0u64;
    let mut records = Vec::<(HostSyncRecord, u64)>::new();

    for object in remote_objects {
        scanned = scanned.saturating_add(1);
        let payload = match provider_impl.read_credential_record(app, &object).await {
            Ok(bytes) => bytes,
            Err(_) => {
                failed = failed.saturating_add(1);
                continue;
            }
        };
        let encrypted: SyncHostsEncryptedV1 = match serde_json::from_slice(&payload) {
            Ok(parsed) => parsed,
            Err(_) => {
                failed = failed.saturating_add(1);
                continue;
            }
        };
        if encrypted.sync_collection_id != manifest.sync_collection_id
            || encrypted.domain != "hosts"
            || encrypted.provider != provider.as_str()
        {
            skipped = skipped.saturating_add(1);
            continue;
        }
        if let Some(filter) = logical_id_filter {
            if !filter.contains(&encrypted.logical_id) {
                skipped = skipped.saturating_add(1);
                continue;
            }
        }
        let envelope = match decode_sync_hosts_envelope(&encrypted) {
            Ok(env) => env,
            Err(_) => {
                failed = failed.saturating_add(1);
                continue;
            }
        };
        let expected_aad = hosts_aad(
            &manifest.sync_collection_id,
            &encrypted.logical_id,
            encrypted.revision,
        );
        let plaintext = match decrypt_record(secret_key, &envelope, expected_aad.as_bytes()) {
            Ok(bytes) => bytes,
            Err(_) => {
                failed = failed.saturating_add(1);
                continue;
            }
        };
        let mut record: HostSyncRecord = match serde_json::from_slice(&plaintext) {
            Ok(parsed) => parsed,
            Err(_) => {
                failed = failed.saturating_add(1);
                continue;
            }
        };
        if record.logical_id.trim().is_empty() {
            record.logical_id = encrypted.logical_id;
        }
        records.push((record, encrypted.revision));
    }

    Ok(RemoteHostCollectResult {
        scanned,
        skipped,
        failed,
        records,
    })
}


fn decode_sync_envelope(record: &SyncCredentialEncryptedV1) -> Result<EncryptedEnvelope, String> {
    let nonce_bytes = base64::engine::general_purpose::STANDARD
        .decode(&record.nonce)
        .map_err(|e| format!("[sync_decode_failed] Invalid nonce encoding: {e}"))?;
    let nonce: [u8; 24] = nonce_bytes
        .as_slice()
        .try_into()
        .map_err(|_| "[sync_decode_failed] Invalid nonce size in provider record".to_string())?;

    let ciphertext = base64::engine::general_purpose::STANDARD
        .decode(&record.ciphertext)
        .map_err(|e| format!("[sync_decode_failed] Invalid ciphertext encoding: {e}"))?;

    Ok(EncryptedEnvelope { nonce, ciphertext })
}

fn decode_sync_hosts_envelope(record: &SyncHostsEncryptedV1) -> Result<EncryptedEnvelope, String> {
    let nonce_bytes = base64::engine::general_purpose::STANDARD
        .decode(&record.nonce)
        .map_err(|e| format!("[sync_decode_failed] Invalid nonce encoding: {e}"))?;
    let ciphertext = base64::engine::general_purpose::STANDARD
        .decode(&record.ciphertext)
        .map_err(|e| format!("[sync_decode_failed] Invalid ciphertext encoding: {e}"))?;

    let nonce: [u8; 24] = nonce_bytes
        .try_into()
        .map_err(|_| "[sync_decode_failed] Invalid nonce length".to_string())?;

    Ok(EncryptedEnvelope { nonce, ciphertext })
}

fn normalize_requested_logical_ids(args: &SyncRestoreCredentialsArgs) -> Option<HashSet<String>> {
    args.logical_ids.as_ref().map(|ids| {
        ids.iter()
            .map(|id| id.trim())
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .collect()
    })
}

fn normalize_resolve_conflict_ids(args: &SyncRestoreCredentialsArgs) -> HashSet<String> {
    args.resolve_conflict_logical_ids
        .as_ref()
        .map(|ids| {
            ids.iter()
                .map(|id| id.trim())
                .filter(|id| !id.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RestoreDecision {
    RestoreNew,
    UpdateExisting,
    ApplyDelete,
    SkipStale,
    SkipAlreadyDeleted,
    Conflict,
}

fn same_payload(existing: &PlaintextRecord, remote: &SyncCredentialPlaintextV1) -> bool {
    existing.kind == remote.kind
        && existing.label == remote.label
        && existing.secret_values == remote.secret_values
        && existing.notes == remote.notes
        && existing.credential == remote.credential
}

fn decide_restore_action(
    existing: Option<&PlaintextRecord>,
    remote: &SyncCredentialPlaintextV1,
) -> RestoreDecision {
    let Some(local) = existing else {
        return if remote.deleted {
            RestoreDecision::SkipAlreadyDeleted
        } else {
            RestoreDecision::RestoreNew
        };
    };

    if remote.deleted {
        if remote.revision > local.revision
            || (remote.revision == local.revision && remote.updated_at >= local.updated_at)
        {
            return RestoreDecision::ApplyDelete;
        }
        return RestoreDecision::SkipAlreadyDeleted;
    }

    if remote.revision > local.revision {
        return RestoreDecision::UpdateExisting;
    }
    if remote.revision < local.revision {
        return RestoreDecision::SkipStale;
    }

    // Same revision: compare payload and timestamps.
    if same_payload(local, remote) {
        return RestoreDecision::SkipStale;
    }
    if remote.updated_at > local.updated_at {
        return RestoreDecision::UpdateExisting;
    }
    if remote.updated_at < local.updated_at {
        return RestoreDecision::SkipStale;
    }

    RestoreDecision::Conflict
}

fn parse_remote_sync_record(
    payload: &[u8],
    expected_collection_id: &str,
    secret_key: &SecretKey,
) -> Result<(String, SyncCredentialPlaintextV1), String> {
    let encrypted = serde_json::from_slice::<SyncCredentialEncryptedV1>(payload)
        .map_err(|e| format!("[sync_parse_failed] Failed to parse encrypted record: {e}"))?;

    if encrypted.version != 1 {
        return Err(format!(
            "[sync_schema_unsupported] Unsupported provider record version: {}",
            encrypted.version
        ));
    }
    if encrypted.sync_collection_id != expected_collection_id {
        return Err("[sync_collection_mismatch] Provider record belongs to a different sync collection"
            .to_string());
    }

    let logical_id = encrypted.logical_id.trim().to_string();
    if logical_id.is_empty() {
        return Err("[sync_logical_id_missing] Provider record missing logical id".to_string());
    }

    let envelope = decode_sync_envelope(&encrypted)?;
    let expected_aad = credential_aad(expected_collection_id, &logical_id, encrypted.revision);
    let plaintext_bytes = decrypt_record(secret_key, &envelope, expected_aad.as_bytes())
        .map_err(|e| format!("[sync_decrypt_failed] Failed to decrypt provider record: {e}"))?;
    let mut plaintext = serde_json::from_slice::<SyncCredentialPlaintextV1>(&plaintext_bytes)
        .map_err(|e| format!("[sync_parse_failed] Failed to parse decrypted payload: {e}"))?;
    plaintext.normalize();
    if plaintext.logical_id.trim().is_empty() {
        plaintext.logical_id = logical_id.clone();
    }
    if plaintext.logical_id != logical_id {
        return Err("[sync_logical_id_mismatch] Provider header/payload logical id mismatch".to_string());
    }
    Ok((logical_id, plaintext))
}

fn build_credential_provider_record(
    kind: SyncProviderKind,
    manifest: &SyncCollectionManifest,
    secret_key: &SecretKey,
    record: &PlaintextRecord,
) -> Result<(String, ProviderUploadRecord), String> {
    let logical_id = VaultService::record_logical_id(record);
    let plaintext = SyncCredentialPlaintextV1 {
        logical_id: logical_id.clone(),
        kind: record.kind.clone(),
        label: record.label.clone(),
        secret: String::new(),
        secret_values: record.secret_values.clone(),
        notes: record.notes.clone(),
        credential: record.credential.clone(),
        revision: record.revision,
        updated_at: record.updated_at,
        deleted: false,
    };

    let plaintext_bytes = serde_json::to_vec(&plaintext)
        .map_err(|e| format!("[sync_serialize_failed] Failed to serialize credential: {e}"))?;
    let aad = credential_aad(&manifest.sync_collection_id, &logical_id, record.revision);
    let envelope = encrypt_record(secret_key, &plaintext_bytes, aad.as_bytes()).map_err(|e| {
        format!("[sync_encrypt_failed] Failed to encrypt credential for provider sync: {e}")
    })?;

    let encrypted = SyncCredentialEncryptedV1 {
        version: 1,
        provider: kind.as_str().to_string(),
        sync_collection_id: manifest.sync_collection_id.clone(),
        logical_id: logical_id.clone(),
        revision: record.revision,
        updated_at: record.updated_at,
        aad,
        nonce: base64::engine::general_purpose::STANDARD.encode(envelope.nonce),
        ciphertext: base64::engine::general_purpose::STANDARD.encode(envelope.ciphertext),
    };
    let payload = serde_json::to_vec(&encrypted)
        .map_err(|e| format!("[sync_serialize_failed] Failed to serialize encrypted record: {e}"))?;
    let object_name = credential_object_name(&manifest.sync_collection_id, &logical_id);

    Ok((logical_id, ProviderUploadRecord { object_name, payload }))
}

#[derive(Debug, Default, Clone, Copy)]
struct CredentialRestoreStats {
    scanned: u64,
    restored: u64,
    updated: u64,
    tombstones_applied: u64,
    skipped: u64,
    conflicts: u64,
    failed: u64,
}

fn host_auth_credential_ids(records: &[HostSyncRecord]) -> HashSet<String> {
    records
        .iter()
        .filter_map(|record| record.auth_ref.as_ref())
        .filter_map(|auth_ref| auth_ref.credential_id.as_deref())
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .collect()
}

fn normalize_host_connection_id(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn host_connection_id_set(records: &[HostSyncRecord]) -> HashSet<String> {
    records
        .iter()
        .map(|record| normalize_host_connection_id(&record.logical_id))
        .collect()
}

fn local_host_connection_id_set(provider_data_dir: &Path) -> Result<HashSet<String>, String> {
    Ok(load_hosts_sync_records(provider_data_dir)
        .map_err(|e| sync_error_to_string(&e))?
        .into_iter()
        .map(|record| normalize_host_connection_id(&record.logical_id))
        .collect())
}

fn resolve_bundle_eligible_host_ids(
    remote_records: &[HostSyncRecord],
    local_host_ids: &HashSet<String>,
    include_host_definitions: bool,
) -> HashSet<String> {
    let remote_ids = host_connection_id_set(remote_records);
    if include_host_definitions {
        return remote_ids;
    }
    remote_ids
        .into_iter()
        .filter(|id| local_host_ids.contains(id))
        .collect()
}

fn host_connection_id_matches(set: &HashSet<String>, connection_id: &str) -> bool {
    set.contains(&normalize_host_connection_id(connection_id))
}

fn filter_host_records_for_eligible_hosts(
    records: Vec<HostSyncRecord>,
    eligible_host_ids: &HashSet<String>,
) -> Vec<HostSyncRecord> {
    records
        .into_iter()
        .filter(|record| host_connection_id_matches(eligible_host_ids, &record.logical_id))
        .collect()
}

fn filter_tunnel_records_for_hosts(
    records: Vec<TunnelSyncRecord>,
    eligible_host_ids: &HashSet<String>,
) -> (Vec<TunnelSyncRecord>, u64) {
    let mut skipped_orphaned = 0u64;
    let filtered = records
        .into_iter()
        .filter(|record| {
            if host_connection_id_matches(eligible_host_ids, &record.connection_id) {
                true
            } else {
                skipped_orphaned = skipped_orphaned.saturating_add(1);
                false
            }
        })
        .collect();
    (filtered, skipped_orphaned)
}

fn filter_host_scoped_snippet_records(
    records: Vec<SnippetSyncRecord>,
    eligible_host_ids: &HashSet<String>,
) -> (Vec<SnippetSyncRecord>, u64) {
    let mut skipped_orphaned = 0u64;
    let filtered = records
        .into_iter()
        .filter(|record| {
            let Some(connection_id) = record
                .connection_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                // Global snippets (no connection_id) are excluded from host-scoped restore
                // but are not orphaned host references.
                return false;
            };
            if host_connection_id_matches(eligible_host_ids, connection_id) {
                true
            } else {
                skipped_orphaned = skipped_orphaned.saturating_add(1);
                false
            }
        })
        .collect();
    (filtered, skipped_orphaned)
}

fn filter_global_snippet_records(records: Vec<SnippetSyncRecord>) -> (Vec<SnippetSyncRecord>, u64) {
    let mut skipped_host_scoped = 0u64;
    let filtered = records
        .into_iter()
        .filter(|record| {
            let is_global = record
                .connection_id
                .as_deref()
                .map(str::trim)
                .is_none_or(|value| value.is_empty());
            if is_global {
                true
            } else {
                skipped_host_scoped = skipped_host_scoped.saturating_add(1);
                false
            }
        })
        .collect();
    (filtered, skipped_host_scoped)
}

fn normalize_tunnel_records(records: Vec<TunnelSyncRecord>) -> Vec<TunnelSyncRecord> {
    records
        .into_iter()
        .map(|mut record| {
            if record.logical_id.trim().is_empty() {
                record.logical_id = format!(
                    "{}:{}:{}:{}",
                    record.connection_id.trim().to_ascii_lowercase(),
                    record.local_port,
                    record.remote_host.trim().to_ascii_lowercase(),
                    record.remote_port
                );
            }
            record
        })
        .collect()
}

fn normalize_snippet_records(records: Vec<SnippetSyncRecord>) -> Vec<SnippetSyncRecord> {
    records
        .into_iter()
        .map(|mut record| {
            if record.logical_id.trim().is_empty() {
                record.logical_id = snippet_record_logical_id(&record);
            }
            record
        })
        .collect()
}

async fn execute_hosts_restore_step(
    app: &tauri::AppHandle,
    vault: &Mutex<VaultService>,
    provider_impl: &dyn VaultProviderV1,
    provider_data_dir: &Path,
    kind: SyncProviderKind,
    manifest: &SyncCollectionManifest,
    secret_key: &SecretKey,
    scanned: u64,
    skipped: u64,
    failed: u64,
    records: Vec<HostSyncRecord>,
    include_referenced_credentials: bool,
    apply_host_records: bool,
) -> Result<SyncHostsRestoreResult, String> {
    let credential_ids = host_auth_credential_ids(&records);
    let credential_stats = if !include_referenced_credentials || credential_ids.is_empty() {
        CredentialRestoreStats::default()
    } else {
        restore_credentials_from_provider_records(
            app,
            vault,
            provider_impl,
            provider_data_dir,
            kind,
            manifest,
            secret_key,
            Some(&credential_ids),
            &HashSet::new(),
        )
        .await?
    };

    let (restored, updated) = if apply_host_records {
        apply_hosts_restore_records(provider_data_dir, &records).map_err(|e| sync_error_to_string(&e))?
    } else {
        (0, 0)
    };
    let credential_refs_relinked = if include_referenced_credentials && !credential_ids.is_empty() {
        let svc = vault.lock().await;
        crate::vault::commands::repair_connection_refs(provider_data_dir, &svc)
            .map(|result| result.relinked_item_ids as u64)
            .map_err(|e| sync_local_error("vault_ref_repair_failed", e.to_string()))?
    } else {
        0
    };
    let synced_at = now_secs();
    if apply_host_records {
        record_domain_sync_success(provider_data_dir, kind, SyncDomain::Hosts, synced_at)
            .map_err(|e| sync_error_to_string(&e))?;
    }

    Ok(SyncHostsRestoreResult {
        domain: "hosts".to_string(),
        scanned,
        restored,
        updated,
        credentials_scanned: credential_stats.scanned,
        credentials_restored: credential_stats.restored,
        credentials_updated: credential_stats.updated,
        credentials_skipped: credential_stats.skipped,
        credentials_conflicts: credential_stats.conflicts,
        credentials_failed: credential_stats.failed,
        credential_refs_relinked,
        skipped,
        failed,
        synced_at,
    })
}

async fn ensure_unlocked_vault_for_credential_restore(
    vault: &Mutex<VaultService>,
    context: &str,
) -> Result<(), String> {
    let mut svc = vault.lock().await;
    match svc
        .status()
        .map_err(|e| sync_local_error("vault_status_failed", e.to_string()))?
    {
        VaultStatus::Unlocked { .. } => Ok(()),
        VaultStatus::Locked { .. } => Err(format!(
            "[vault_locked] Unlock the local vault before restoring {context}."
        )),
        VaultStatus::Uninitialized => Err(format!(
            "[vault_uninitialized] Initialize the local vault before restoring {context}."
        )),
    }
}

async fn restore_credentials_from_provider_records(
    app: &tauri::AppHandle,
    vault: &Mutex<VaultService>,
    provider_impl: &dyn VaultProviderV1,
    provider_data_dir: &Path,
    kind: SyncProviderKind,
    manifest: &SyncCollectionManifest,
    secret_key: &SecretKey,
    requested_logical_ids: Option<&HashSet<String>>,
    resolve_conflict_logical_ids: &HashSet<String>,
) -> Result<CredentialRestoreStats, String> {
    ensure_unlocked_vault_for_credential_restore(vault, "provider credentials").await?;

    // When restoring specific credential ids (e.g. Keep-and-open), skip full Drive
    // listing + download of every .zcred — fetch only the named objects.
    let listed = if requested_logical_ids.map(|f| !f.is_empty()).unwrap_or(false) {
        Vec::new()
    } else {
        provider_impl
            .list_credential_records(app, &manifest.sync_collection_id)
            .await
            .map_err(|error| {
                record_sync_error(provider_data_dir, kind, error.code, error.message.clone());
                sync_error_to_string(&error)
            })?
    };

    let remote_objects = credential_objects_for_restore(
        &manifest.sync_collection_id,
        requested_logical_ids,
        listed,
    );

    let mut stats = CredentialRestoreStats::default();

    for object in remote_objects {
        stats.scanned = stats.scanned.saturating_add(1);

        let payload = match provider_impl.read_credential_record(app, &object).await {
            Ok(bytes) => bytes,
            Err(error) => {
                stats.failed = stats.failed.saturating_add(1);
                eprintln!(
                    "[sync] Failed to read provider object '{}': [{}] {}",
                    object.object_name, error.code, error.message
                );
                continue;
            }
        };

        let (logical_id, plaintext) = match parse_remote_sync_record(
            &payload,
            &manifest.sync_collection_id,
            secret_key,
        ) {
            Ok(parsed) => parsed,
            Err(error) => {
                if error.starts_with("[sync_collection_mismatch]") {
                    stats.skipped = stats.skipped.saturating_add(1);
                } else {
                    stats.failed = stats.failed.saturating_add(1);
                    eprintln!(
                        "[sync] Failed to parse provider object '{}': {}",
                        object.object_name, error
                    );
                }
                continue;
            }
        };

        if let Some(filter) = requested_logical_ids {
            if !filter.contains(&logical_id) {
                stats.skipped = stats.skipped.saturating_add(1);
                continue;
            }
        }

        let outcome = {
            let svc = vault.lock().await;
            match svc.item_get_by_logical_id(&logical_id) {
                Ok(existing) => {
                    let decision = decide_restore_action(Some(&existing), &plaintext);
                    match decision {
                        RestoreDecision::UpdateExisting => svc
                            .item_apply_sync_restore(
                                &existing.id,
                                &logical_id,
                                &plaintext.label,
                                &plaintext.kind,
                                &plaintext.secret_values,
                                plaintext.notes.as_deref(),
                                plaintext.credential.as_ref(),
                                plaintext.revision,
                                plaintext.updated_at,
                            )
                            .map(|_| decision)
                            .map_err(|e| format!("[vault_update_failed] {e}")),
                        RestoreDecision::ApplyDelete => svc
                            .item_delete(&existing.id)
                            .map(|_| decision)
                            .map_err(|e| format!("[vault_delete_failed] {e}")),
                        RestoreDecision::Conflict
                            if resolve_conflict_logical_ids.contains(&logical_id) =>
                        {
                            svc.item_apply_sync_restore(
                                &existing.id,
                                &logical_id,
                                &plaintext.label,
                                &plaintext.kind,
                                &plaintext.secret_values,
                                plaintext.notes.as_deref(),
                                plaintext.credential.as_ref(),
                                plaintext.revision,
                                plaintext.updated_at,
                            )
                            .map(|_| RestoreDecision::UpdateExisting)
                            .map_err(|e| format!("[vault_update_failed] {e}"))
                        }
                        _ => Ok::<_, String>(decision),
                    }
                }
                Err(crate::vault::error::VaultError::RecordNotFound(_)) => {
                    let decision = decide_restore_action(None, &plaintext);
                    match decision {
                        RestoreDecision::RestoreNew => svc
                            .item_create_from_sync(
                                &plaintext.label,
                                &plaintext.kind,
                                &plaintext.secret_values,
                                plaintext.notes.as_deref(),
                                plaintext.credential.as_ref(),
                                &logical_id,
                                plaintext.revision,
                                plaintext.updated_at,
                            )
                            .map(|_| decision)
                            .map_err(|e| format!("[vault_create_failed] {e}")),
                        _ => Ok::<_, String>(decision),
                    }
                }
                Err(error) => Err(format!("[vault_lookup_failed] {error}")),
            }
        };

        match outcome {
            Ok(RestoreDecision::RestoreNew) => {
                stats.restored = stats.restored.saturating_add(1)
            }
            Ok(RestoreDecision::UpdateExisting) => {
                stats.updated = stats.updated.saturating_add(1)
            }
            Ok(RestoreDecision::ApplyDelete) => {
                stats.tombstones_applied = stats.tombstones_applied.saturating_add(1)
            }
            Ok(RestoreDecision::SkipStale | RestoreDecision::SkipAlreadyDeleted) => {
                stats.skipped = stats.skipped.saturating_add(1)
            }
            Ok(RestoreDecision::Conflict) => {
                stats.conflicts = stats.conflicts.saturating_add(1);
                eprintln!(
                    "[sync] Conflict detected for '{}' (same revision/timestamp with divergent payload)",
                    logical_id
                );
            }
            Err(error) => {
                stats.failed = stats.failed.saturating_add(1);
                eprintln!(
                    "[sync] Failed applying provider object '{}': {}",
                    object.object_name, error
                );
            }
        }
    }

    Ok(stats)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDownloadResult {
    pub item_count: u64,
    pub vault_id: Option<String>,
}

#[tauri::command]
pub async fn sync_hosts_snapshot(
    app: tauri::AppHandle,
) -> Result<SyncHostsSnapshotResult, String> {
    let data_dir = crate::commands::get_data_dir(&app);
    let records = load_hosts_sync_records(&data_dir).map_err(|e| sync_error_to_string(&e))?;
    Ok(SyncHostsSnapshotResult {
        domain: "hosts".to_string(),
        count: records.len() as u64,
        records,
    })
}

#[tauri::command]
pub async fn sync_hosts_changes(
    app: tauri::AppHandle,
    provider: String,
    args: SyncHostsChangesArgs,
) -> Result<SyncHostsChangesResult, String> {
    let kind = parse_provider(&provider)?;
    let data_dir = crate::commands::get_data_dir(&app);
    let mut records = load_hosts_sync_records(&data_dir).map_err(|e| sync_error_to_string(&e))?;

    let id_filter: Option<HashSet<String>> = args.logical_ids.as_ref().map(|ids| {
        ids.iter()
            .map(|id| id.trim())
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .collect()
    });
    if let Some(filter) = id_filter.as_ref() {
        records.retain(|record| filter.contains(&record.logical_id));
    }

    let profile = get_profile(&data_dir, kind).map_err(|e| sync_error_to_string(&e))?;
    let since = profile
        .as_ref()
        .and_then(|profile| domain_last_sync(profile, SyncDomain::Hosts));
    if !args.include_all {
        if let Some(watermark) = since {
            records.retain(|record| record.updated_at > watermark);
        }
    }

    Ok(SyncHostsChangesResult {
        domain: "hosts".to_string(),
        count: records.len() as u64,
        since,
        records,
    })
}

#[tauri::command]
pub async fn sync_hosts_upload(
    app: tauri::AppHandle,
    vault: State<'_, Mutex<VaultService>>,
    provider: String,
    args: SyncHostsChangesArgs,
) -> Result<SyncHostsUploadResult, String> {
    let kind = parse_provider(&provider)?;
    let provider_impl = provider_for(kind).map_err(|e| sync_error_to_string(&e))?;
    let provider_data_dir = crate::commands::get_data_dir(&app);
    ensure_domain_enabled_for_provider(&provider_data_dir, kind, SyncDomain::Hosts)?;
    let manifest = load_manifest(&provider_data_dir, kind)
        .map_err(|e| sync_error_to_string(&e))?
        .ok_or_else(|| {
            "[sync_collection_not_configured] Sync collection is not configured. Set up sync key first."
                .to_string()
        })?;
    let collection_key = load_collection_key(&manifest).map_err(|e| sync_error_to_string(&e))?;
    let secret_key = SecretKey::from_bytes(collection_key);

    let mut changes = sync_hosts_changes(app.clone(), provider.clone(), args).await?;
    let host_records_with_auth = changes
        .records
        .iter()
        .filter(|record| record.auth_ref.is_some())
        .count();
    let mut credential_upload_records = Vec::with_capacity(host_records_with_auth);
    let mut skipped_host_logical_ids = HashSet::<String>::new();
    if host_records_with_auth > 0 {
        let mut records_by_logical_id = HashMap::<String, PlaintextRecord>::new();

        let mut svc = vault.lock().await;
        match svc
            .status()
            .map_err(|e| sync_local_error("vault_status_failed", e.to_string()))?
        {
            VaultStatus::Unlocked { .. } => {}
            VaultStatus::Locked { .. } => {
                return Err("[vault_locked] Unlock the Local Vault before syncing hosts with vault-backed credentials.".to_string())
            }
            VaultStatus::Uninitialized => {
                return Err("[vault_uninitialized] Initialize the Local Vault before syncing hosts with vault-backed credentials.".to_string())
            }
        }
        let active_vault_id = svc.vault_id();

        for host_record in &mut changes.records {
            let Some(auth_ref) = host_record.auth_ref.as_mut() else {
                continue;
            };
            let requested_credential_id = auth_ref
                .credential_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let item_id = auth_ref.item_id.trim();

            let resolved_record = requested_credential_id
                .and_then(|credential_id| svc.item_get_by_logical_id(credential_id).ok())
                .or_else(|| {
                    if item_id.is_empty() {
                        None
                    } else {
                        svc.item_get(item_id).ok()
                    }
                });

            let Some(record) = resolved_record else {
                skipped_host_logical_ids.insert(host_record.logical_id.clone());
                continue;
            };

            let logical_id = VaultService::record_logical_id(&record);
            if logical_id.trim().is_empty() {
                skipped_host_logical_ids.insert(host_record.logical_id.clone());
                continue;
            }

            auth_ref.credential_id = Some(logical_id.clone());
            auth_ref.item_id = record.id.clone();
            if let Some(vault_id) = active_vault_id.as_ref() {
                auth_ref.vault_id = vault_id.clone();
            }
            records_by_logical_id.entry(logical_id).or_insert(record);
        }

        if !skipped_host_logical_ids.is_empty() {
            changes
                .records
                .retain(|record| !skipped_host_logical_ids.contains(&record.logical_id));
        }

        let mut records_to_upload = records_by_logical_id.into_iter().collect::<Vec<_>>();
        records_to_upload.sort_by(|(left, _), (right, _)| left.cmp(right));
        for (_, record) in records_to_upload {
            let (_, upload_record) =
                build_credential_provider_record(kind, &manifest, &secret_key, &record)?;
            credential_upload_records.push(upload_record);
        }
    }

    let mut upload_records = Vec::with_capacity(changes.records.len());
    for record in &changes.records {
        let revision = if record.updated_at == 0 { 1 } else { record.updated_at };
        let plaintext_bytes = serde_json::to_vec(record)
            .map_err(|e| format!("[sync_serialize_failed] Failed to serialize host record: {e}"))?;
        let aad = hosts_aad(&manifest.sync_collection_id, &record.logical_id, revision);
        let envelope = encrypt_record(&secret_key, &plaintext_bytes, aad.as_bytes())
            .map_err(|e| format!("[sync_encrypt_failed] Failed to encrypt host record: {e}"))?;

        let encrypted = SyncHostsEncryptedV1 {
            version: 1,
            domain: "hosts".to_string(),
            provider: kind.as_str().to_string(),
            sync_collection_id: manifest.sync_collection_id.clone(),
            logical_id: record.logical_id.clone(),
            revision,
            updated_at: record.updated_at,
            aad,
            nonce: base64::engine::general_purpose::STANDARD.encode(envelope.nonce),
            ciphertext: base64::engine::general_purpose::STANDARD.encode(envelope.ciphertext),
        };
        let payload = serde_json::to_vec(&encrypted).map_err(|e| {
            format!("[sync_serialize_failed] Failed to serialize encrypted host record: {e}")
        })?;
        let object_name = hosts_object_name(&manifest.sync_collection_id, &record.logical_id);
        upload_records.push(ProviderUploadRecord {
            object_name,
            payload,
        });
    }

    let credentials_uploaded = credential_upload_records.len() as u64;
    let credential_synced_at = if credential_upload_records.is_empty() {
        0
    } else {
        provider_impl
            .upload_credential_records(&app, credential_upload_records)
            .await
            .map_err(|error| {
                record_sync_error(&provider_data_dir, kind, error.code, error.message.clone());
                sync_error_to_string(&error)
            })?
    };
    let uploaded = upload_records.len() as u64;
    let host_synced_at = if upload_records.is_empty() {
        0
    } else {
        provider_impl
            .upload_credential_records(&app, upload_records)
            .await
            .map_err(|error| {
                record_sync_error(&provider_data_dir, kind, error.code, error.message.clone());
                sync_error_to_string(&error)
            })?
    };
    let latest_synced_at = credential_synced_at.max(host_synced_at);
    let skipped = changes.count.saturating_sub(uploaded);
    let profile_sync_at = if uploaded > 0 || credentials_uploaded > 0 { latest_synced_at } else { now_secs() };
    record_domain_sync_success(&provider_data_dir, kind, SyncDomain::Hosts, profile_sync_at)
        .map_err(|e| sync_error_to_string(&e))?;

    Ok(SyncHostsUploadResult {
        domain: "hosts".to_string(),
        uploaded,
        credentials_uploaded,
        skipped,
        synced_at: profile_sync_at,
    })
}

#[tauri::command]
pub async fn sync_hosts_remote_inventory(
    app: tauri::AppHandle,
    provider: String,
) -> Result<SyncHostsRemoteInventoryResult, String> {
    let kind = parse_provider(&provider)?;
    let provider_impl = provider_for(kind).map_err(|e| sync_error_to_string(&e))?;
    let provider_data_dir = crate::commands::get_data_dir(&app);
    ensure_domain_enabled_for_provider(&provider_data_dir, kind, SyncDomain::Hosts)?;
    let manifest = load_manifest(&provider_data_dir, kind)
        .map_err(|e| sync_error_to_string(&e))?
        .ok_or_else(|| {
            "[sync_collection_not_configured] Sync collection is not configured. Set up sync key first."
                .to_string()
        })?;
    let collection_key = load_collection_key(&manifest).map_err(|e| sync_error_to_string(&e))?;
    let secret_key = SecretKey::from_bytes(collection_key);
    let local_host_ids = load_hosts_sync_records(&provider_data_dir)
        .map_err(|e| sync_error_to_string(&e))?
        .into_iter()
        .map(|record| record.logical_id)
        .collect::<HashSet<_>>();

    let collected = collect_remote_host_records(
        provider_impl.as_ref(),
        &app,
        kind,
        &manifest,
        &secret_key,
        None,
    )
    .await
    .map_err(|message| {
        record_sync_error(&provider_data_dir, kind, "sync_hosts_inventory_failed", message.clone());
        message
    })?;

    let mut hosts = collected
        .records
        .into_iter()
        .map(|(record, revision)| {
            let credential_id = record
                .auth_ref
                .as_ref()
                .and_then(|auth_ref| auth_ref.credential_id.clone());
            SyncRemoteHostInventoryItem {
                provider: kind.as_str().to_string(),
                collection_id: manifest.sync_collection_id.clone(),
                logical_id: record.logical_id.clone(),
                name: record.name,
                host: record.host,
                port: record.port,
                username: record.username,
                folder: record.folder,
                tags: record.tags,
                is_favorite: record.is_favorite,
                updated_at: record.updated_at,
                revision,
                has_auth_ref: record.auth_ref.is_some(),
                credential_id,
                local_exists: local_host_ids.contains(&record.logical_id),
            }
        })
        .collect::<Vec<_>>();
    hosts.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then_with(|| left.host.cmp(&right.host))
            .then_with(|| left.logical_id.cmp(&right.logical_id))
    });

    Ok(SyncHostsRemoteInventoryResult {
        provider: kind.as_str().to_string(),
        collection_id: manifest.sync_collection_id,
        scanned: collected.scanned,
        hosts,
        skipped: collected.skipped,
        failed: collected.failed,
    })
}

#[tauri::command]
pub async fn sync_hosts_restore(
    app: tauri::AppHandle,
    vault: State<'_, Mutex<VaultService>>,
    provider: String,
    args: SyncHostsRestoreArgs,
) -> Result<SyncHostsRestoreResult, String> {
    let kind = parse_provider(&provider)?;
    let provider_impl = provider_for(kind).map_err(|e| sync_error_to_string(&e))?;
    let provider_data_dir = crate::commands::get_data_dir(&app);
    ensure_domain_enabled_for_provider(&provider_data_dir, kind, SyncDomain::Hosts)?;
    let manifest = load_manifest(&provider_data_dir, kind)
        .map_err(|e| sync_error_to_string(&e))?
        .ok_or_else(|| {
            "[sync_collection_not_configured] Sync collection is not configured. Set up sync key first."
                .to_string()
        })?;
    let collection_key = load_collection_key(&manifest).map_err(|e| sync_error_to_string(&e))?;
    let secret_key = SecretKey::from_bytes(collection_key);
    let logical_id_filter = args.logical_ids.map(|ids| {
        ids.into_iter()
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty())
            .collect::<HashSet<_>>()
    });

    let collected = collect_remote_host_records(
        provider_impl.as_ref(),
        &app,
        kind,
        &manifest,
        &secret_key,
        logical_id_filter.as_ref(),
    )
    .await
    .map_err(|message| {
        record_sync_error(&provider_data_dir, kind, "sync_hosts_restore_failed", message.clone());
        message
    })?;
    let scanned = collected.scanned;
    let skipped = collected.skipped;
    let failed = collected.failed;
    let records = collected
        .records
        .into_iter()
        .map(|(record, _revision)| record)
        .collect::<Vec<_>>();

    execute_hosts_restore_step(
        &app,
        &vault,
        provider_impl.as_ref(),
        &provider_data_dir,
        kind,
        &manifest,
        &secret_key,
        scanned,
        skipped,
        failed,
        records,
        true,
        true,
    )
    .await
}

struct ConnectionsRestoreScope {
    records: Vec<HostSyncRecord>,
    scanned: u64,
    skipped: u64,
    failed: u64,
}

fn normalize_host_logical_id_filter(ids: Option<Vec<String>>) -> Option<HashSet<String>> {
    ids.map(|ids| {
        ids.into_iter()
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty())
            .collect::<HashSet<_>>()
    })
}

async fn prepare_connections_restore_scope(
    provider_impl: &dyn VaultProviderV1,
    app: &tauri::AppHandle,
    kind: SyncProviderKind,
    provider_data_dir: &Path,
    manifest: &super::types::SyncCollectionManifest,
    secret_key: &SecretKey,
    host_logical_ids: Option<Vec<String>>,
    error_code: &'static str,
) -> Result<ConnectionsRestoreScope, String> {
    let initial_filter = normalize_host_logical_id_filter(host_logical_ids);
    let local_ids = local_host_connection_id_set(provider_data_dir).unwrap_or_default();

    // Unfiltered restore: single full collect (existing behavior).
    if initial_filter.is_none() {
        let collected = collect_remote_host_records(
            provider_impl,
            app,
            kind,
            manifest,
            secret_key,
            None,
        )
        .await
        .map_err(|message| {
            record_sync_error(provider_data_dir, kind, error_code, message.clone());
            message
        })?;
        let records = collected
            .records
            .into_iter()
            .map(|(record, _revision)| record)
            .collect::<Vec<_>>();
        return Ok(ConnectionsRestoreScope {
            records,
            scanned: collected.scanned,
            skipped: collected.skipped,
            failed: collected.failed,
        });
    }

    // Filtered restore (Keep / Keep-and-open): also pull jump-host chain so connect works.
    let mut pending: HashSet<String> = initial_filter.unwrap_or_default();
    let mut fetched: HashSet<String> = HashSet::new();
    let mut by_logical_id: HashMap<String, HostSyncRecord> = HashMap::new();
    let mut scanned = 0u64;
    let mut skipped = 0u64;
    let mut failed = 0u64;

    for _depth in 0..10 {
        let to_fetch: HashSet<String> = pending
            .difference(&fetched)
            .cloned()
            .collect();
        if to_fetch.is_empty() {
            break;
        }

        let collected = collect_remote_host_records(
            provider_impl,
            app,
            kind,
            manifest,
            secret_key,
            Some(&to_fetch),
        )
        .await
        .map_err(|message| {
            record_sync_error(provider_data_dir, kind, error_code, message.clone());
            message
        })?;

        scanned = scanned.saturating_add(collected.scanned);
        skipped = skipped.saturating_add(collected.skipped);
        failed = failed.saturating_add(collected.failed);

        pending.clear();
        for (record, _revision) in collected.records {
            fetched.insert(record.logical_id.clone());
            if let Some(jump_id) = record
                .jump_server_id
                .as_ref()
                .map(|id| id.trim().to_string())
                .filter(|id| !id.is_empty())
            {
                let jump_key = normalize_host_connection_id(&jump_id);
                let already_local = local_ids.contains(&jump_key) || local_ids.contains(&jump_id);
                let already_batch =
                    fetched.contains(&jump_id) || by_logical_id.contains_key(&jump_id);
                if !already_local && !already_batch {
                    pending.insert(jump_id);
                }
            }
            by_logical_id.insert(record.logical_id.clone(), record);
        }
    }

    Ok(ConnectionsRestoreScope {
        records: by_logical_id.into_values().collect(),
        scanned,
        skipped,
        failed,
    })
}

struct BundledDomainRestoreCounts {
    scanned: u64,
    restorable: u64,
    orphaned: u64,
}

async fn preview_bundled_tunnel_counts_for_hosts(
    provider_impl: &dyn VaultProviderV1,
    app: &tauri::AppHandle,
    manifest: &super::types::SyncCollectionManifest,
    secret_key: &SecretKey,
    eligible_host_ids: &HashSet<String>,
) -> Result<BundledDomainRestoreCounts, String> {
    let collected = collect_domain_records::<TunnelSyncRecord>(
        provider_impl,
        app,
        manifest,
        secret_key,
        "tunnels",
        ".ztun",
    )
    .await?;
    let normalized = normalize_tunnel_records(collected.records);
    let (filtered, skipped_orphaned) = filter_tunnel_records_for_hosts(normalized, eligible_host_ids);
    Ok(BundledDomainRestoreCounts {
        scanned: collected.scanned,
        restorable: filtered.len() as u64,
        orphaned: skipped_orphaned,
    })
}

async fn preview_bundled_host_snippet_counts_for_hosts(
    provider_impl: &dyn VaultProviderV1,
    app: &tauri::AppHandle,
    manifest: &super::types::SyncCollectionManifest,
    secret_key: &SecretKey,
    eligible_host_ids: &HashSet<String>,
) -> Result<BundledDomainRestoreCounts, String> {
    let collected = collect_domain_records::<SnippetSyncRecord>(
        provider_impl,
        app,
        manifest,
        secret_key,
        "snippets",
        ".zsnp",
    )
    .await?;
    let normalized = normalize_snippet_records(collected.records);
    let (filtered, skipped_orphaned) =
        filter_host_scoped_snippet_records(normalized, eligible_host_ids);
    Ok(BundledDomainRestoreCounts {
        scanned: collected.scanned,
        restorable: filtered.len() as u64,
        orphaned: skipped_orphaned,
    })
}

#[tauri::command]
pub async fn sync_connections_restore(
    app: tauri::AppHandle,
    vault: State<'_, Mutex<VaultService>>,
    provider: String,
    args: SyncConnectionsRestoreArgs,
) -> Result<SyncConnectionsRestoreResult, String> {
    let kind = parse_provider(&provider)?;
    let provider_impl = provider_for(kind).map_err(|e| sync_error_to_string(&e))?;
    let provider_data_dir = crate::commands::get_data_dir(&app);
    ensure_domain_enabled_for_provider(&provider_data_dir, kind, SyncDomain::Hosts)?;
    let manifest = load_manifest(&provider_data_dir, kind)
        .map_err(|e| sync_error_to_string(&e))?
        .ok_or_else(|| {
            "[sync_collection_not_configured] Sync collection is not configured. Set up sync key first."
                .to_string()
        })?;
    let collection_key = load_collection_key(&manifest).map_err(|e| sync_error_to_string(&e))?;
    let secret_key = SecretKey::from_bytes(collection_key);
    let scope = prepare_connections_restore_scope(
        provider_impl.as_ref(),
        &app,
        kind,
        &provider_data_dir,
        &manifest,
        &secret_key,
        args.host_logical_ids.clone(),
        "sync_connections_restore_failed",
    )
    .await?;
    let records = scope.records;
    let local_host_ids = local_host_connection_id_set(&provider_data_dir)?;
    let eligible_host_ids = resolve_bundle_eligible_host_ids(
        &records,
        &local_host_ids,
        args.include_host_definitions,
    );

    let eligible_records =
        filter_host_records_for_eligible_hosts(records, &eligible_host_ids);
    let hosts = execute_hosts_restore_step(
        &app,
        &vault,
        provider_impl.as_ref(),
        &provider_data_dir,
        kind,
        &manifest,
        &secret_key,
        scope.scanned,
        scope.skipped,
        scope.failed,
        eligible_records,
        args.include_referenced_credentials,
        args.include_host_definitions,
    )
    .await?;

    let mut latest_synced_at = hosts.synced_at;

    let tunnels = if args.include_tunnels {
        ensure_domain_enabled_for_provider(&provider_data_dir, kind, SyncDomain::Tunnels)?;
        let collected = collect_domain_records::<TunnelSyncRecord>(
            provider_impl.as_ref(),
            &app,
            &manifest,
            &secret_key,
            "tunnels",
            ".ztun",
        )
        .await?;
        let normalized = normalize_tunnel_records(collected.records);
        let (filtered, skipped_orphaned) =
            filter_tunnel_records_for_hosts(normalized, &eligible_host_ids);
        let (restored, updated) = apply_tunnel_restore_records(&provider_data_dir, &filtered)
            .map_err(|e| sync_error_to_string(&e))?;
        let synced_at = now_secs();
        record_domain_sync_success(&provider_data_dir, kind, SyncDomain::Tunnels, synced_at)
            .map_err(|e| sync_error_to_string(&e))?;
        latest_synced_at = latest_synced_at.max(synced_at);
        Some(SyncConnectionsBundledDomainResult {
            domain: "tunnels".to_string(),
            scanned: collected.scanned,
            restored,
            updated,
            skipped: collected.skipped,
            skipped_orphaned,
            failed: collected.failed,
            synced_at,
        })
    } else {
        None
    };

    let host_snippets = if args.include_host_snippets {
        ensure_domain_enabled_for_provider(&provider_data_dir, kind, SyncDomain::Snippets)?;
        let collected = collect_domain_records::<SnippetSyncRecord>(
            provider_impl.as_ref(),
            &app,
            &manifest,
            &secret_key,
            "snippets",
            ".zsnp",
        )
        .await?;
        let normalized = normalize_snippet_records(collected.records);
        let (filtered, skipped_orphaned) =
            filter_host_scoped_snippet_records(normalized, &eligible_host_ids);
        let (restored, updated) = apply_snippet_restore_records(&provider_data_dir, &filtered)
            .map_err(|e| sync_error_to_string(&e))?;
        let synced_at = now_secs();
        record_domain_sync_success(&provider_data_dir, kind, SyncDomain::Snippets, synced_at)
            .map_err(|e| sync_error_to_string(&e))?;
        latest_synced_at = latest_synced_at.max(synced_at);
        Some(SyncConnectionsBundledDomainResult {
            domain: "snippets".to_string(),
            scanned: collected.scanned,
            restored,
            updated,
            skipped: collected.skipped,
            skipped_orphaned,
            failed: collected.failed,
            synced_at,
        })
    } else {
        None
    };

    Ok(SyncConnectionsRestoreResult {
        hosts,
        tunnels,
        host_snippets,
        synced_at: latest_synced_at,
    })
}

#[tauri::command]
pub async fn sync_connections_restore_preview(
    app: tauri::AppHandle,
    provider: String,
    args: SyncConnectionsRestoreArgs,
) -> Result<SyncConnectionsRestorePreviewResult, String> {
    let kind = parse_provider(&provider)?;
    let provider_impl = provider_for(kind).map_err(|e| sync_error_to_string(&e))?;
    let provider_data_dir = crate::commands::get_data_dir(&app);
    ensure_domain_enabled_for_provider(&provider_data_dir, kind, SyncDomain::Hosts)?;
    let manifest = load_manifest(&provider_data_dir, kind)
        .map_err(|e| sync_error_to_string(&e))?
        .ok_or_else(|| {
            "[sync_collection_not_configured] Sync collection is not configured. Set up sync key first."
                .to_string()
        })?;
    let collection_key = load_collection_key(&manifest).map_err(|e| sync_error_to_string(&e))?;
    let secret_key = SecretKey::from_bytes(collection_key);
    let local_host_ids = local_host_connection_id_set(&provider_data_dir)?;
    let scope = prepare_connections_restore_scope(
        provider_impl.as_ref(),
        &app,
        kind,
        &provider_data_dir,
        &manifest,
        &secret_key,
        args.host_logical_ids.clone(),
        "sync_connections_restore_preview_failed",
    )
    .await?;
    let eligible_host_ids = resolve_bundle_eligible_host_ids(
        &scope.records,
        &local_host_ids,
        args.include_host_definitions,
    );
    let hosts_selected = if args.include_host_definitions {
        scope.records.len() as u64
    } else {
        eligible_host_ids.len() as u64
    };
    let mut hosts_new = 0u64;
    let mut hosts_existing = 0u64;
    if args.include_host_definitions {
        for record in &scope.records {
            if host_connection_id_matches(&local_host_ids, &record.logical_id) {
                hosts_existing = hosts_existing.saturating_add(1);
            } else {
                hosts_new = hosts_new.saturating_add(1);
            }
        }
    }
    let referenced_credentials = if args.include_referenced_credentials {
        let eligible_records = filter_host_records_for_eligible_hosts(
            scope.records.clone(),
            &eligible_host_ids,
        );
        host_auth_credential_ids(&eligible_records).len() as u64
    } else {
        0
    };

    let (tunnels_scanned, tunnels_restorable, tunnels_orphaned) = if args.include_tunnels {
        ensure_domain_enabled_for_provider(&provider_data_dir, kind, SyncDomain::Tunnels)?;
        let counts = preview_bundled_tunnel_counts_for_hosts(
            provider_impl.as_ref(),
            &app,
            &manifest,
            &secret_key,
            &eligible_host_ids,
        )
        .await?;
        (
            Some(counts.scanned),
            Some(counts.restorable),
            Some(counts.orphaned),
        )
    } else {
        (None, None, None)
    };

    let (host_snippets_scanned, host_snippets_restorable, host_snippets_orphaned) =
        if args.include_host_snippets {
            ensure_domain_enabled_for_provider(&provider_data_dir, kind, SyncDomain::Snippets)?;
            let counts = preview_bundled_host_snippet_counts_for_hosts(
                provider_impl.as_ref(),
                &app,
                &manifest,
                &secret_key,
                &eligible_host_ids,
            )
            .await?;
            (
                Some(counts.scanned),
                Some(counts.restorable),
                Some(counts.orphaned),
            )
        } else {
            (None, None, None)
        };

    Ok(SyncConnectionsRestorePreviewResult {
        provider: kind.as_str().to_string(),
        hosts_selected,
        hosts_new,
        hosts_existing,
        referenced_credentials,
        hosts_failed: scope.failed,
        tunnels_scanned,
        tunnels_restorable,
        tunnels_orphaned,
        host_snippets_scanned,
        host_snippets_restorable,
        host_snippets_orphaned,
    })
}

#[tauri::command]
pub async fn sync_tunnels_snapshot(app: tauri::AppHandle) -> Result<SyncTunnelsSnapshotResult, String> {
    let data_dir = crate::commands::get_data_dir(&app);
    let records = load_tunnel_sync_records(&data_dir).map_err(|e| sync_error_to_string(&e))?;
    Ok(SyncTunnelsSnapshotResult {
        domain: "tunnels".to_string(),
        count: records.len() as u64,
        records,
    })
}

#[tauri::command]
pub async fn sync_snippets_snapshot(app: tauri::AppHandle) -> Result<SyncSnippetsSnapshotResult, String> {
    let data_dir = crate::commands::get_data_dir(&app);
    let records = load_snippet_sync_records(&data_dir).map_err(|e| sync_error_to_string(&e))?;
    Ok(SyncSnippetsSnapshotResult {
        domain: "snippets".to_string(),
        count: records.len() as u64,
        records,
    })
}

#[tauri::command]
pub async fn sync_tunnels_upload(app: tauri::AppHandle, provider: String) -> Result<SyncDomainUploadResult, String> {
    let kind = parse_provider(&provider)?;
    let provider_impl = provider_for(kind).map_err(|e| sync_error_to_string(&e))?;
    let data_dir = crate::commands::get_data_dir(&app);
    ensure_domain_enabled_for_provider(&data_dir, kind, SyncDomain::Tunnels)?;
    let manifest = load_manifest(&data_dir, kind)
        .map_err(|e| sync_error_to_string(&e))?
        .ok_or_else(|| "[sync_collection_not_configured] Sync collection is not configured. Set up sync key first.".to_string())?;
    let collection_key = load_collection_key(&manifest).map_err(|e| sync_error_to_string(&e))?;
    let secret_key = SecretKey::from_bytes(collection_key);
    let records = load_tunnel_sync_records(&data_dir).map_err(|e| sync_error_to_string(&e))?;
    let mut uploaded = 0u64;
    let mut latest_synced_at = 0u64;
    for record in records {
        let revision = default_revision(record.updated_at);
        let synced_at = upload_domain_record(
            provider_impl.as_ref(),
            &app,
            kind,
            &manifest,
            &secret_key,
            &data_dir,
            &record,
            DomainUploadMeta {
                domain: "tunnels",
                logical_id: &record.logical_id,
                revision,
                updated_at: record.updated_at,
                extension: "ztun",
            },
        ).await?;
        latest_synced_at = latest_synced_at.max(synced_at);
        uploaded = uploaded.saturating_add(1);
    }
    let synced_at = if uploaded > 0 { latest_synced_at } else { now_secs() };
    record_domain_sync_success(&data_dir, kind, SyncDomain::Tunnels, synced_at)
        .map_err(|e| sync_error_to_string(&e))?;
    Ok(SyncDomainUploadResult { domain: "tunnels".to_string(), uploaded, skipped: 0, synced_at })
}

#[tauri::command]
pub async fn sync_snippets_upload(app: tauri::AppHandle, provider: String) -> Result<SyncDomainUploadResult, String> {
    let kind = parse_provider(&provider)?;
    let provider_impl = provider_for(kind).map_err(|e| sync_error_to_string(&e))?;
    let data_dir = crate::commands::get_data_dir(&app);
    ensure_domain_enabled_for_provider(&data_dir, kind, SyncDomain::Snippets)?;
    let manifest = load_manifest(&data_dir, kind)
        .map_err(|e| sync_error_to_string(&e))?
        .ok_or_else(|| "[sync_collection_not_configured] Sync collection is not configured. Set up sync key first.".to_string())?;
    let collection_key = load_collection_key(&manifest).map_err(|e| sync_error_to_string(&e))?;
    let secret_key = SecretKey::from_bytes(collection_key);
    let records = load_snippet_sync_records(&data_dir).map_err(|e| sync_error_to_string(&e))?;
    let mut uploaded = 0u64;
    let mut latest_synced_at = 0u64;
    for record in records {
        let revision = default_revision(record.updated_at);
        let synced_at = upload_domain_record(
            provider_impl.as_ref(),
            &app,
            kind,
            &manifest,
            &secret_key,
            &data_dir,
            &record,
            DomainUploadMeta {
                domain: "snippets",
                logical_id: &record.logical_id,
                revision,
                updated_at: record.updated_at,
                extension: "zsnp",
            },
        ).await?;
        latest_synced_at = latest_synced_at.max(synced_at);
        uploaded = uploaded.saturating_add(1);
    }
    let synced_at = if uploaded > 0 { latest_synced_at } else { now_secs() };
    record_domain_sync_success(&data_dir, kind, SyncDomain::Snippets, synced_at)
        .map_err(|e| sync_error_to_string(&e))?;
    Ok(SyncDomainUploadResult { domain: "snippets".to_string(), uploaded, skipped: 0, synced_at })
}

#[tauri::command]
pub async fn sync_tunnels_restore(app: tauri::AppHandle, provider: String) -> Result<SyncDomainRestoreResult, String> {
    let kind = parse_provider(&provider)?;
    let provider_impl = provider_for(kind).map_err(|e| sync_error_to_string(&e))?;
    let data_dir = crate::commands::get_data_dir(&app);
    ensure_domain_enabled_for_provider(&data_dir, kind, SyncDomain::Tunnels)?;
    let manifest = load_manifest(&data_dir, kind)
        .map_err(|e| sync_error_to_string(&e))?
        .ok_or_else(|| "[sync_collection_not_configured] Sync collection is not configured. Set up sync key first.".to_string())?;
    let collection_key = load_collection_key(&manifest).map_err(|e| sync_error_to_string(&e))?;
    let secret_key = SecretKey::from_bytes(collection_key);
    let collected = collect_domain_records::<TunnelSyncRecord>(
        provider_impl.as_ref(),
        &app,
        &manifest,
        &secret_key,
        "tunnels",
        ".ztun",
    )
    .await?;
    let records = collected
        .records
        .into_iter()
        .map(|mut record| {
            if record.logical_id.trim().is_empty() {
                record.logical_id = format!(
                    "{}:{}:{}:{}",
                    record.connection_id.trim().to_ascii_lowercase(),
                    record.local_port,
                    record.remote_host.trim().to_ascii_lowercase(),
                    record.remote_port
                );
            }
            record
        })
        .collect::<Vec<_>>();
    let (restored, updated) = apply_tunnel_restore_records(&data_dir, &records).map_err(|e| sync_error_to_string(&e))?;
    let synced_at = now_secs();
    record_domain_sync_success(&data_dir, kind, SyncDomain::Tunnels, synced_at)
        .map_err(|e| sync_error_to_string(&e))?;
    Ok(SyncDomainRestoreResult {
        domain: "tunnels".into(),
        scanned: collected.scanned,
        restored,
        updated,
        skipped: collected.skipped,
        failed: collected.failed,
        synced_at,
    })
}

#[tauri::command]
pub async fn sync_snippets_restore(
    app: tauri::AppHandle,
    provider: String,
    args: SyncSnippetsRestoreArgs,
) -> Result<SyncDomainRestoreResult, String> {
    let kind = parse_provider(&provider)?;
    let provider_impl = provider_for(kind).map_err(|e| sync_error_to_string(&e))?;
    let data_dir = crate::commands::get_data_dir(&app);
    ensure_domain_enabled_for_provider(&data_dir, kind, SyncDomain::Snippets)?;
    let manifest = load_manifest(&data_dir, kind)
        .map_err(|e| sync_error_to_string(&e))?
        .ok_or_else(|| "[sync_collection_not_configured] Sync collection is not configured. Set up sync key first.".to_string())?;
    let collection_key = load_collection_key(&manifest).map_err(|e| sync_error_to_string(&e))?;
    let secret_key = SecretKey::from_bytes(collection_key);
    let collected = collect_domain_records::<SnippetSyncRecord>(
        provider_impl.as_ref(),
        &app,
        &manifest,
        &secret_key,
        "snippets",
        ".zsnp",
    )
    .await?;
    let mut records = normalize_snippet_records(collected.records);
    let mut skipped = collected.skipped;
    if args.global_only {
        let (filtered, skipped_host_scoped) = filter_global_snippet_records(records);
        records = filtered;
        skipped = skipped.saturating_add(skipped_host_scoped);
    } else if let Some(host_connection_ids) = args.host_connection_ids {
        let eligible_host_ids = host_connection_ids
            .into_iter()
            .map(|id| normalize_host_connection_id(&id))
            .filter(|id| !id.is_empty())
            .collect::<HashSet<_>>();
        let (filtered, skipped_orphaned) =
            filter_host_scoped_snippet_records(records, &eligible_host_ids);
        records = filtered;
        skipped = skipped.saturating_add(skipped_orphaned);
    }
    let (restored, updated) = apply_snippet_restore_records(&data_dir, &records).map_err(|e| sync_error_to_string(&e))?;
    let synced_at = now_secs();
    record_domain_sync_success(&data_dir, kind, SyncDomain::Snippets, synced_at)
        .map_err(|e| sync_error_to_string(&e))?;
    Ok(SyncDomainRestoreResult {
        domain: "snippets".into(),
        scanned: collected.scanned,
        restored,
        updated,
        skipped,
        failed: collected.failed,
        synced_at,
    })
}

#[tauri::command]
pub async fn sync_settings_upload(app: tauri::AppHandle, provider: String) -> Result<SyncDomainUploadResult, String> {
    let kind = parse_provider(&provider)?;
    let provider_impl = provider_for(kind).map_err(|e| sync_error_to_string(&e))?;
    let data_dir = crate::commands::get_data_dir(&app);
    ensure_domain_enabled_for_provider(&data_dir, kind, SyncDomain::Settings)?;
    let manifest = load_manifest(&data_dir, kind)
        .map_err(|e| sync_error_to_string(&e))?
        .ok_or_else(|| "[sync_collection_not_configured] Sync collection is not configured. Set up sync key first.".to_string())?;
    let collection_key = load_collection_key(&manifest).map_err(|e| sync_error_to_string(&e))?;
    let secret_key = SecretKey::from_bytes(collection_key);
    let existing = collect_domain_records::<SettingsSyncRecord>(
        provider_impl.as_ref(),
        &app,
        &manifest,
        &secret_key,
        "settings",
        ".zset",
    )
    .await?
    .records
    .into_iter()
    .max_by_key(|record| record.updated_at);
    let record = load_allowlisted_settings(&app, existing.as_ref()).await?;
    let revision = default_revision(record.updated_at);
    let synced_at = upload_domain_record(
        provider_impl.as_ref(),
        &app,
        kind,
        &manifest,
        &secret_key,
        &data_dir,
        &record,
        DomainUploadMeta {
            domain: "settings",
            logical_id: &record.logical_id,
            revision,
            updated_at: record.updated_at,
            extension: "zset",
        },
    ).await?;
    record_domain_sync_success(&data_dir, kind, SyncDomain::Settings, synced_at)
        .map_err(|e| sync_error_to_string(&e))?;
    Ok(SyncDomainUploadResult { domain: "settings".to_string(), uploaded: 1, skipped: 0, synced_at })
}

#[tauri::command]
pub async fn sync_settings_restore(app: tauri::AppHandle, provider: String) -> Result<SyncDomainRestoreResult, String> {
    let kind = parse_provider(&provider)?;
    let provider_impl = provider_for(kind).map_err(|e| sync_error_to_string(&e))?;
    let data_dir = crate::commands::get_data_dir(&app);
    ensure_domain_enabled_for_provider(&data_dir, kind, SyncDomain::Settings)?;
    let manifest = load_manifest(&data_dir, kind)
        .map_err(|e| sync_error_to_string(&e))?
        .ok_or_else(|| "[sync_collection_not_configured] Sync collection is not configured. Set up sync key first.".to_string())?;
    let collection_key = load_collection_key(&manifest).map_err(|e| sync_error_to_string(&e))?;
    let secret_key = SecretKey::from_bytes(collection_key);
    let collected = collect_domain_records::<SettingsSyncRecord>(
        provider_impl.as_ref(),
        &app,
        &manifest,
        &secret_key,
        "settings",
        ".zset",
    )
    .await?;
    for parsed in collected.records {
        let settings: serde_json::Value = crate::commands::settings_get(app.clone()).await?;
        let mut merged = settings.as_object().cloned().unwrap_or_default();
        if let Some(obj) = parsed.payload.as_object() {
            for key in SETTINGS_ALLOWLIST_KEYS {
                if let Some(value) = obj.get(*key) {
                    merged.insert((*key).to_string(), value.clone());
                }
            }
        }
        crate::commands::settings_set(app.clone(), serde_json::Value::Object(merged)).await?;
    }

    let synced_at = now_secs();
    record_domain_sync_success(&data_dir, kind, SyncDomain::Settings, synced_at)
        .map_err(|e| sync_error_to_string(&e))?;
    Ok(SyncDomainRestoreResult {
        domain: "settings".to_string(),
        scanned: collected.scanned,
        restored: if collected.scanned > 0 { 1 } else { 0 },
        updated: 0,
        skipped: collected.skipped,
        failed: collected.failed,
        synced_at,
    })
}

#[tauri::command]
pub async fn sync_collection_status(
    app: tauri::AppHandle,
    provider: String,
) -> Result<SyncCollectionStatus, String> {
    let kind = parse_provider(&provider)?;
    let provider_data_dir = crate::commands::get_data_dir(&app);
    let mut manifest = load_manifest(&provider_data_dir, kind).map_err(|e| sync_error_to_string(&e))?;
    if let Some(ref mut m) = manifest {
        let _ = enforce_collection_key_cache_ttl(&provider_data_dir, m)
            .map_err(|e| sync_error_to_string(&e))?;
    }
    Ok(collection_status_from_manifest(kind, manifest))
}

#[tauri::command]
pub async fn sync_collection_discover_remote(
    app: tauri::AppHandle,
    provider: String,
) -> Result<SyncCollectionDiscoverResult, String> {
    let kind = parse_provider(&provider)?;
    let provider_impl = provider_for(kind).map_err(|e| sync_error_to_string(&e))?;
    let collections = provider_impl
        .discover_sync_collection_summaries(&app)
        .await
        .map_err(|e| sync_error_to_string(&e))?;
    Ok(SyncCollectionDiscoverResult { collections })
}

#[tauri::command]
pub async fn sync_collection_setup(
    app: tauri::AppHandle,
    vault: State<'_, Mutex<VaultService>>,
    provider: String,
    args: SyncCollectionSetupArgs,
) -> Result<SyncCollectionSetupResult, String> {
    let kind = parse_provider(&provider)?;
    let provider_data_dir = crate::commands::get_data_dir(&app);
    let provider_impl = provider_for(kind).map_err(|e| sync_error_to_string(&e))?;

    let passphrase = args
        .passphrase
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    if passphrase.len() < SYNC_COLLECTION_PASSPHRASE_MIN_LENGTH {
        let label = if matches!(args.key_policy_mode, SyncKeyPolicyMode::LocalPassphrase) {
            "Local Vault passphrase"
        } else {
            "Sync passphrase"
        };
        return Err(format!(
            "[invalid_sync_passphrase_length] {label} must be at least {} characters.",
            SYNC_COLLECTION_PASSPHRASE_MIN_LENGTH
        ));
    }
    if matches!(args.key_policy_mode, SyncKeyPolicyMode::LocalPassphrase) {
        let mut svc = vault.lock().await;
        match svc
            .status()
            .map_err(|e| sync_local_error("vault_status_failed", e.to_string()))?
        {
            VaultStatus::Uninitialized => {
                return Err(
                    "[vault_uninitialized] Initialize the local vault before setting up provider sync."
                        .to_string(),
                )
            }
            VaultStatus::Locked { .. } | VaultStatus::Unlocked { .. } => {
                svc.verify_passphrase(&passphrase).map_err(|_| {
                    "[sync_collection_passphrase_mismatch] Local Vault passphrase did not unlock this vault."
                        .to_string()
                })?;
            }
        }
    }

    let existing_manifest = load_manifest(&provider_data_dir, kind)
        .map_err(|e| sync_error_to_string(&e))?;
    let discovered_sync_collection_id = if existing_manifest.is_none() {
        let collection_ids = provider_impl
            .discover_sync_collection_ids(&app)
            .await
            .map_err(|e| sync_error_to_string(&e))?;
        resolve_discovered_sync_collection_id(
            collection_ids,
            args.sync_collection_id.as_deref(),
            kind.as_str(),
        )?
    } else {
        None
    };

    // Passphrase recovery after local wipe: download key-wrap blob from Drive first.
    // Ok(None) = wrap not found (older backups). Err = propagate so callers see
    // network/auth failures instead of sync_collection_key_unrecoverable.
    let remote_key_wrap = if existing_manifest.is_none() {
        if let Some(collection_id) = discovered_sync_collection_id.as_deref() {
            match download_remote_collection_key_wrap(
                provider_impl.as_ref(),
                &app,
                collection_id,
            )
            .await
            {
                Ok(wrap) => wrap,
                Err(error) => {
                    eprintln!(
                        "[sync] Failed to download collection key wrap from provider: {error}"
                    );
                    return Err(error);
                }
            }
        } else {
            None
        }
    } else {
        None
    };

    let outcome = setup_manifest(
        &provider_data_dir,
        kind,
        args.key_policy_mode,
        &passphrase,
        args.has_recovery_key,
        discovered_sync_collection_id,
        remote_key_wrap,
    )
    .map_err(|e| sync_error_to_string(&e))?;

    // Always push wrap to Drive so future devices/resets can recover with passphrase.
    if let Err(error) =
        upload_remote_collection_key_wrap(provider_impl.as_ref(), &app, &outcome.manifest).await
    {
        eprintln!(
            "[sync] Failed to upload collection key wrap to provider (passphrase recovery may not work after wipe): {}",
            error
        );
    }

    let status = collection_status_from_manifest(kind, Some(outcome.manifest));
    Ok(SyncCollectionSetupResult {
        status,
        recovery_key: outcome.recovery_key,
    })
}

async fn download_remote_collection_key_wrap(
    provider_impl: &dyn VaultProviderV1,
    app: &tauri::AppHandle,
    sync_collection_id: &str,
) -> Result<Option<RemoteCollectionKeyWrapV1>, String> {
    let object_name = collection_key_wrap_object_name(sync_collection_id);
    let object = ProviderCredentialObject {
        object_name: object_name.clone(),
        object_id: None,
    };
    let bytes = match provider_impl.read_credential_record(app, &object).await {
        Ok(bytes) => bytes,
        Err(error) if error.code == "provider_object_not_found" => return Ok(None),
        Err(error) => {
            // Older collections may not have a wrap file yet.
            if error.message.contains("not found") || error.code.contains("not_found") {
                return Ok(None);
            }
            return Err(sync_error_to_string(&error));
        }
    };
    let wrap: RemoteCollectionKeyWrapV1 = serde_json::from_slice(&bytes).map_err(|e| {
        format!("[sync_collection_key_wrap_parse_failed] Invalid remote key wrap: {e}")
    })?;
    Ok(Some(wrap))
}

async fn upload_remote_collection_key_wrap(
    provider_impl: &dyn VaultProviderV1,
    app: &tauri::AppHandle,
    manifest: &super::types::SyncCollectionManifest,
) -> Result<(), String> {
    let wrap = remote_key_wrap_from_manifest(manifest).ok_or_else(|| {
        "[sync_collection_key_wrap_missing] Local manifest has no key wrap to upload.".to_string()
    })?;
    let payload = serde_json::to_vec_pretty(&wrap).map_err(|e| {
        format!("[sync_collection_key_wrap_encode_failed] Failed to serialize key wrap: {e}")
    })?;
    let object_name = collection_key_wrap_object_name(&manifest.sync_collection_id);
    provider_impl
        .upload_credential_record(app, &object_name, payload)
        .await
        .map_err(|e| sync_error_to_string(&e))?;
    Ok(())
}

#[tauri::command]
pub async fn sync_collection_unlock(
    app: tauri::AppHandle,
    provider: String,
    args: SyncCollectionUnlockArgs,
) -> Result<SyncCollectionStatus, String> {
    let kind = parse_provider(&provider)?;
    let provider_data_dir = crate::commands::get_data_dir(&app);
    let mut manifest = load_manifest(&provider_data_dir, kind)
        .map_err(|e| sync_error_to_string(&e))?
        .ok_or_else(|| {
            "[sync_collection_not_configured] Sync collection is not configured. Set up sync key first."
                .to_string()
        })?;

    let recovery_key = args
        .recovery_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(recovery_key) = recovery_key {
        unlock_collection_key_with_recovery_key(&provider_data_dir, &mut manifest, recovery_key)
            .map_err(|e| sync_error_to_string(&e))?;
    } else {
        let passphrase = args
            .passphrase
            .as_deref()
            .map(str::trim)
            .unwrap_or_default();
        if passphrase.len() < SYNC_COLLECTION_PASSPHRASE_MIN_LENGTH {
            return Err(format!(
                "[invalid_sync_passphrase_length] Sync passphrase must be at least {} characters.",
                SYNC_COLLECTION_PASSPHRASE_MIN_LENGTH
            ));
        }
        unlock_collection_key_with_passphrase(&provider_data_dir, &mut manifest, passphrase)
            .map_err(|e| sync_error_to_string(&e))?;
    }

    Ok(collection_status_from_manifest(kind, Some(manifest)))
}

#[tauri::command]
pub async fn sync_collection_regenerate_recovery_key(
    app: tauri::AppHandle,
    provider: String,
) -> Result<SyncCollectionSetupResult, String> {
    let kind = parse_provider(&provider)?;
    let provider_data_dir = crate::commands::get_data_dir(&app);
    let outcome =
        regenerate_recovery_key(&provider_data_dir, kind).map_err(|e| sync_error_to_string(&e))?;
    let status = collection_status_from_manifest(kind, Some(outcome.manifest));
    Ok(SyncCollectionSetupResult {
        status,
        recovery_key: outcome.recovery_key,
    })
}

#[tauri::command]
pub async fn sync_collection_lock(
    app: tauri::AppHandle,
    provider: String,
) -> Result<SyncCollectionStatus, String> {
    let kind = parse_provider(&provider)?;
    let provider_data_dir = crate::commands::get_data_dir(&app);
    let manifest = load_manifest(&provider_data_dir, kind).map_err(|e| sync_error_to_string(&e))?;
    let mut manifest = manifest.ok_or_else(|| {
        "[sync_collection_not_configured] Sync collection is not configured. Set up sync key first."
            .to_string()
    })?;
    clear_collection_key_cache(&manifest).map_err(|e| sync_error_to_string(&e))?;
    manifest.key_cache_unlocked_at = None;
    manifest.updated_at = now_secs();
    save_manifest(&provider_data_dir, &manifest).map_err(|e| sync_error_to_string(&e))?;
    Ok(collection_status_from_manifest(kind, Some(manifest)))
}

#[tauri::command]
pub async fn sync_collection_forget_key(
    app: tauri::AppHandle,
    provider: String,
) -> Result<SyncCollectionStatus, String> {
    sync_collection_lock(app, provider).await
}

#[tauri::command]
pub async fn sync_collection_set_cache_ttl(
    app: tauri::AppHandle,
    provider: String,
    ttl_secs: u64,
) -> Result<SyncCollectionStatus, String> {
    if !(300..=604800).contains(&ttl_secs) {
        return Err("[invalid_sync_cache_ttl] Cache TTL must be between 300 and 604800 seconds.".to_string());
    }
    let kind = parse_provider(&provider)?;
    let provider_data_dir = crate::commands::get_data_dir(&app);
    let manifest =
        set_collection_key_cache_ttl(&provider_data_dir, kind, ttl_secs).map_err(|e| sync_error_to_string(&e))?;
    Ok(collection_status_from_manifest(kind, Some(manifest)))
}

#[tauri::command]
pub async fn sync_status(
    app: tauri::AppHandle,
    provider: String,
) -> Result<SyncProviderStatus, String> {
    let kind = parse_provider(&provider)?;
    let provider_impl = provider_for(kind).map_err(|e| sync_error_to_string(&e))?;
    let provider_data_dir = crate::commands::get_data_dir(&app);

    let existing = get_profile(&provider_data_dir, kind)
        .map_err(|e| sync_error_to_string(&e))?;

    let profile = if existing.is_none() {
        if let Some(snapshot) = snapshot_from_legacy(kind, &provider_data_dir) {
            upsert_profile(&provider_data_dir, kind, |old| {
                sync_profile_from_snapshot(kind, snapshot.clone(), old)
            })
            .map_err(|e| sync_error_to_string(&e))?
        } else {
            default_profile(kind)
        }
    } else {
        existing.expect("checked is_some")
    };

    match provider_impl.status(&app).await {
        Ok(snapshot) => {
            let profile = upsert_profile(&provider_data_dir, kind, |old| {
                sync_profile_from_snapshot(kind, snapshot.clone(), old)
            })
            .map_err(|e| sync_error_to_string(&e))?;
            Ok(status_from_profile(
                profile,
                provider_impl.kind(),
                provider_impl.capabilities(),
            ))
        }
        Err(error) => {
            record_sync_error(&provider_data_dir, kind, error.code, error.message.clone());
            let mut degraded = profile;
            degraded.last_error_code = Some(error.code.to_string());
            degraded.last_error = Some(error.message);
            Ok(status_from_profile(
                degraded,
                provider_impl.kind(),
                provider_impl.capabilities(),
            ))
        }
    }
}

#[tauri::command]
pub async fn sync_domain_policies(
    app: tauri::AppHandle,
    provider: String,
) -> Result<SyncDomainPoliciesResult, String> {
    let kind = parse_provider(&provider)?;
    let provider_data_dir = crate::commands::get_data_dir(&app);
    let mut profile = get_profile(&provider_data_dir, kind)
        .map_err(|e| sync_error_to_string(&e))?
        .unwrap_or_else(|| default_profile(kind));
    ensure_domain_collections(&mut profile);
    Ok(SyncDomainPoliciesResult {
        provider: kind.as_str().to_string(),
        policies: profile.domain_policies,
    })
}

#[tauri::command]
pub async fn sync_domain_policy_set(
    app: tauri::AppHandle,
    provider: String,
    args: SyncDomainPolicySetArgs,
) -> Result<SyncDomainPoliciesResult, String> {
    let kind = parse_provider(&provider)?;
    let domain = SyncDomain::parse(&args.domain)
        .ok_or_else(|| format!("[invalid_domain] Unknown domain: {}", args.domain))?;
    let provider_data_dir = crate::commands::get_data_dir(&app);
    let mode = args.mode.unwrap_or(SyncPolicyMode::Manual);
    let updated = upsert_profile(&provider_data_dir, kind, |existing| {
        let mut profile = existing.unwrap_or_else(|| default_profile(kind));
        ensure_domain_collections(&mut profile);
        if let Some(policy) = profile.domain_policies.iter_mut().find(|p| p.domain == domain) {
            policy.enabled = args.enabled;
            policy.mode = mode;
        }
        if let Some(status) = profile.domain_statuses.iter_mut().find(|s| s.domain == domain) {
            status.enabled = args.enabled;
        }
        profile
    })
    .map_err(|e| sync_error_to_string(&e))?;
    Ok(SyncDomainPoliciesResult {
        provider: kind.as_str().to_string(),
        policies: updated.domain_policies,
    })
}

#[tauri::command]
pub async fn sync_connect(
    app: tauri::AppHandle,
    provider: String,
) -> Result<SyncProviderStatus, String> {
    let kind = parse_provider(&provider)?;
    let provider_impl = provider_for(kind).map_err(|e| sync_error_to_string(&e))?;
    let provider_data_dir = crate::commands::get_data_dir(&app);

    let identity = provider_impl
        .connect(&app)
        .await
        .map_err(|error| {
            record_sync_error(&provider_data_dir, kind, error.code, error.message.clone());
            sync_error_to_string(&error)
        })?;

    let status_snapshot = provider_impl
        .status(&app)
        .await
        .unwrap_or(ProviderStatusSnapshot {
            connected: true,
            email: identity.email.clone(),
            avatar_url: identity.avatar_url.clone(),
            last_sync: None,
        });

    let profile = upsert_profile(&provider_data_dir, kind, |existing| {
        let mut profile = sync_profile_from_snapshot(kind, status_snapshot.clone(), existing);
        profile.connected = true;
        profile.email = identity.email.clone().or(profile.email);
        profile.avatar_url = identity.avatar_url.clone().or(profile.avatar_url);
        profile
    })
    .map_err(|e| sync_error_to_string(&e))?;

    clear_sync_error(&provider_data_dir, kind);
    Ok(status_from_profile(
        profile,
        provider_impl.kind(),
        provider_impl.capabilities(),
    ))
}

#[tauri::command]
pub async fn sync_disconnect(app: tauri::AppHandle, provider: String) -> Result<(), String> {
    let kind = parse_provider(&provider)?;
    let provider_impl = provider_for(kind).map_err(|e| sync_error_to_string(&e))?;
    let provider_data_dir = crate::commands::get_data_dir(&app);

    match provider_impl.disconnect(&app).await {
        Ok(()) => {
            if let Ok(Some(mut manifest)) = load_manifest(&provider_data_dir, kind) {
                let _ = clear_collection_key_cache(&manifest);
                manifest.key_cache_unlocked_at = None;
                manifest.updated_at = now_secs();
                let _ = save_manifest(&provider_data_dir, &manifest);
            }
            let _ = upsert_profile(&provider_data_dir, kind, |existing| {
                let mut profile = existing.unwrap_or_else(|| default_profile(kind));
                profile.connected = false;
                profile.email = None;
                profile.avatar_url = None;
                profile
            });
            clear_sync_error(&provider_data_dir, kind);
            Ok(())
        }
        Err(error) => {
            let _ = upsert_profile(&provider_data_dir, kind, |existing| {
                let mut profile = existing.unwrap_or_else(|| default_profile(kind));
                profile.connected = false;
                profile.email = None;
                profile.avatar_url = None;
                profile.last_error = Some(error.message.clone());
                profile.last_error_code = Some(error.code.to_string());
                profile
            });
            Err(sync_error_to_string(&error))
        }
    }
}

#[tauri::command]
pub async fn sync_upload(
    app: tauri::AppHandle,
    vault: State<'_, Mutex<VaultService>>,
    provider: String,
) -> Result<u64, String> {
    let kind = parse_provider(&provider)?;
    let provider_impl = provider_for(kind).map_err(|e| sync_error_to_string(&e))?;
    let provider_data_dir = crate::commands::get_data_dir(&app);
    ensure_domain_enabled_for_provider(&provider_data_dir, kind, SyncDomain::Vault)?;
    let tmp_path = provider_data_dir.join("vault.redb.sync-tmp");

    {
        let mut svc = vault.lock().await;
        svc.export_vault(&tmp_path)
            .map_err(|e| sync_local_error("vault_export_failed", e.to_string()))?;
    }

    let file_bytes = match tokio::fs::read(&tmp_path).await {
        Ok(bytes) => {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            bytes
        }
        Err(error) => {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return Err(sync_local_error("sync_temp_read_failed", error.to_string()));
        }
    };

    let ts = provider_impl
        .upload_vault_blob(&app, file_bytes)
        .await
        .map_err(|error| {
            record_sync_error(&provider_data_dir, kind, error.code, error.message.clone());
            sync_error_to_string(&error)
        })?;

    record_domain_sync_success(&provider_data_dir, kind, SyncDomain::Vault, ts)
    .map_err(|e| sync_error_to_string(&e))?;

    Ok(ts)
}

#[tauri::command]
pub async fn sync_upload_credential(
    app: tauri::AppHandle,
    vault: State<'_, Mutex<VaultService>>,
    provider: String,
    args: SyncUploadCredentialArgs,
) -> Result<SyncUploadCredentialResult, String> {
    let kind = parse_provider(&provider)?;
    let provider_impl = provider_for(kind).map_err(|e| sync_error_to_string(&e))?;
    let provider_data_dir = crate::commands::get_data_dir(&app);
    ensure_domain_enabled_for_provider(&provider_data_dir, kind, SyncDomain::Vault)?;

    let manifest = load_manifest(&provider_data_dir, kind)
        .map_err(|e| sync_error_to_string(&e))?
        .ok_or_else(|| {
            "[sync_collection_not_configured] Sync collection is not configured. Set up sync key first."
                .to_string()
        })?;

    let collection_key = load_collection_key(&manifest).map_err(|e| sync_error_to_string(&e))?;
    let secret_key = SecretKey::from_bytes(collection_key);

    let record = {
        let svc = vault.lock().await;
        svc.item_get(&args.item_id)
            .map_err(|e| format!("[vault_item_load_failed] {e}"))?
    };

    let (logical_id, upload_record) =
        build_credential_provider_record(kind, &manifest, &secret_key, &record)?;
    let object_name = upload_record.object_name.clone();

    let synced_at = provider_impl
        .upload_credential_record(&app, &upload_record.object_name, upload_record.payload)
        .await
        .map_err(|error| {
            record_sync_error(&provider_data_dir, kind, error.code, error.message.clone());
            sync_error_to_string(&error)
        })?;

    record_domain_sync_success(&provider_data_dir, kind, SyncDomain::Vault, synced_at)
    .map_err(|e| sync_error_to_string(&e))?;

    Ok(SyncUploadCredentialResult {
        provider: kind.as_str().to_string(),
        logical_id,
        revision: record.revision,
        object_name,
        synced_at,
    })
}

#[tauri::command]
pub async fn sync_upload_credentials(
    app: tauri::AppHandle,
    vault: State<'_, Mutex<VaultService>>,
    provider: String,
) -> Result<SyncUploadCredentialsResult, String> {
    let kind = parse_provider(&provider)?;
    let provider_impl = provider_for(kind).map_err(|e| sync_error_to_string(&e))?;
    let provider_data_dir = crate::commands::get_data_dir(&app);
    ensure_domain_enabled_for_provider(&provider_data_dir, kind, SyncDomain::Vault)?;

    let manifest = load_manifest(&provider_data_dir, kind)
        .map_err(|e| sync_error_to_string(&e))?
        .ok_or_else(|| {
            "[sync_collection_not_configured] Sync collection is not configured. Set up sync key first."
                .to_string()
        })?;

    let collection_key = load_collection_key(&manifest).map_err(|e| sync_error_to_string(&e))?;
    let secret_key = SecretKey::from_bytes(collection_key);

    let records = {
        let mut svc = vault.lock().await;
        match svc
            .status()
            .map_err(|e| sync_local_error("vault_status_failed", e.to_string()))?
        {
            VaultStatus::Unlocked { .. } => {}
            VaultStatus::Locked { .. } => {
                return Err("[vault_locked] Unlock the local vault before syncing credentials.".to_string())
            }
            VaultStatus::Uninitialized => {
                return Err("[vault_uninitialized] Initialize the local vault before syncing credentials.".to_string())
            }
        }
        svc.item_list()
            .map_err(|e| format!("[vault_list_failed] {e}"))?
    };

    let mut upload_records = Vec::with_capacity(records.len());
    for record in &records {
        let (_, upload_record) =
            build_credential_provider_record(kind, &manifest, &secret_key, record)?;
        upload_records.push(upload_record);
    }

    let uploaded = upload_records.len() as u64;
    let synced_at = if upload_records.is_empty() {
        now_secs()
    } else {
        provider_impl
            .upload_credential_records(&app, upload_records)
            .await
            .map_err(|error| {
                record_sync_error(&provider_data_dir, kind, error.code, error.message.clone());
                sync_error_to_string(&error)
            })?
    };

    record_domain_sync_success(&provider_data_dir, kind, SyncDomain::Vault, synced_at)
        .map_err(|e| sync_error_to_string(&e))?;

    Ok(SyncUploadCredentialsResult {
        provider: kind.as_str().to_string(),
        uploaded,
        skipped: 0,
        synced_at,
    })
}

#[tauri::command]
pub async fn sync_restore_preview(
    app: tauri::AppHandle,
    vault: State<'_, Mutex<VaultService>>,
    provider: String,
    args: SyncRestoreCredentialsArgs,
) -> Result<SyncRestorePreviewResult, String> {
    let kind = parse_provider(&provider)?;
    let provider_impl = provider_for(kind).map_err(|e| sync_error_to_string(&e))?;
    let provider_data_dir = crate::commands::get_data_dir(&app);
    ensure_domain_enabled_for_provider(&provider_data_dir, kind, SyncDomain::Vault)?;

    {
        let mut svc = vault.lock().await;
        match svc
            .status()
            .map_err(|e| sync_local_error("vault_status_failed", e.to_string()))?
        {
            VaultStatus::Unlocked { .. } => {}
            VaultStatus::Locked { .. } => {
                return Err(
                    "[vault_locked] Unlock the local vault before previewing provider credentials."
                        .to_string(),
                )
            }
            VaultStatus::Uninitialized => {
                return Err(
                    "[vault_uninitialized] Initialize the local vault before previewing provider credentials."
                        .to_string(),
                )
            }
        }
    }

    let manifest = load_manifest(&provider_data_dir, kind)
        .map_err(|e| sync_error_to_string(&e))?
        .ok_or_else(|| {
            "[sync_collection_not_configured] Sync collection is not configured. Set up sync key first."
                .to_string()
        })?;
    let collection_key = load_collection_key(&manifest).map_err(|e| sync_error_to_string(&e))?;
    let secret_key = SecretKey::from_bytes(collection_key);

    let requested_logical_ids = normalize_requested_logical_ids(&args);
    let remote_objects = provider_impl
        .list_credential_records(&app, &manifest.sync_collection_id)
        .await
        .map_err(|error| {
            record_sync_error(&provider_data_dir, kind, error.code, error.message.clone());
            sync_error_to_string(&error)
        })?;
    let mut scanned = 0u64;
    let mut restorable = 0u64;
    let mut updatable = 0u64;
    let mut tombstoned = 0u64;
    let mut stale = 0u64;
    let mut conflicts = 0u64;
    let mut failed = 0u64;
    let mut conflict_items: Vec<SyncRestoreConflictItem> = Vec::new();

    for object in remote_objects {
        if !is_credential_object_name(&object.object_name) {
            continue;
        }
        scanned = scanned.saturating_add(1);

        let payload = match provider_impl.read_credential_record(&app, &object).await {
            Ok(bytes) => bytes,
            Err(error) => {
                failed = failed.saturating_add(1);
                eprintln!(
                    "[sync] Preview failed reading provider object '{}': [{}] {}",
                    object.object_name, error.code, error.message
                );
                continue;
            }
        };

        let (logical_id, plaintext) = match parse_remote_sync_record(
            &payload,
            &manifest.sync_collection_id,
            &secret_key,
        ) {
            Ok(parsed) => parsed,
            Err(error) => {
                if error.starts_with("[sync_collection_mismatch]") {
                    stale = stale.saturating_add(1);
                } else {
                    failed = failed.saturating_add(1);
                    eprintln!(
                        "[sync] Preview failed parsing provider object '{}': {}",
                        object.object_name, error
                    );
                }
                continue;
            }
        };

        if let Some(filter) = requested_logical_ids.as_ref() {
            if !filter.contains(&logical_id) {
                stale = stale.saturating_add(1);
                continue;
            }
        }

        let (decision, maybe_conflict_item) = {
            let svc = vault.lock().await;
            match svc.item_get_by_logical_id(&logical_id) {
                Ok(existing) => {
                    let decision = decide_restore_action(Some(&existing), &plaintext);
                    let conflict_item = if decision == RestoreDecision::Conflict {
                        Some(SyncRestoreConflictItem {
                            logical_id: logical_id.clone(),
                            kind: plaintext.kind.clone(),
                            label: plaintext.label.clone(),
                            local_revision: existing.revision,
                            local_updated_at: existing.updated_at,
                            remote_revision: plaintext.revision,
                            remote_updated_at: plaintext.updated_at,
                            remote_deleted: plaintext.deleted,
                        })
                    } else {
                        None
                    };
                    (decision, conflict_item)
                }
                Err(crate::vault::error::VaultError::RecordNotFound(_)) => {
                    (decide_restore_action(None, &plaintext), None)
                }
                Err(error) => {
                    failed = failed.saturating_add(1);
                    eprintln!(
                        "[sync] Preview lookup failed for logical id '{}': {}",
                        logical_id, error
                    );
                    continue;
                }
            }
        };

        match decision {
            RestoreDecision::RestoreNew => restorable = restorable.saturating_add(1),
            RestoreDecision::UpdateExisting => updatable = updatable.saturating_add(1),
            RestoreDecision::ApplyDelete => tombstoned = tombstoned.saturating_add(1),
            RestoreDecision::SkipStale | RestoreDecision::SkipAlreadyDeleted => {
                stale = stale.saturating_add(1)
            }
            RestoreDecision::Conflict => {
                conflicts = conflicts.saturating_add(1);
                if let Some(item) = maybe_conflict_item {
                    conflict_items.push(item);
                }
            }
        }
    }

    Ok(SyncRestorePreviewResult {
        provider: kind.as_str().to_string(),
        scanned,
        restorable,
        updatable,
        tombstoned,
        stale,
        conflicts,
        failed,
        conflict_items,
    })
}

#[tauri::command]
pub async fn sync_restore_credentials(
    app: tauri::AppHandle,
    vault: State<'_, Mutex<VaultService>>,
    provider: String,
    args: SyncRestoreCredentialsArgs,
) -> Result<SyncRestoreCredentialsResult, String> {
    let kind = parse_provider(&provider)?;
    let provider_impl = provider_for(kind).map_err(|e| sync_error_to_string(&e))?;
    let provider_data_dir = crate::commands::get_data_dir(&app);
    ensure_domain_enabled_for_provider(&provider_data_dir, kind, SyncDomain::Vault)?;

    {
        let mut svc = vault.lock().await;
        match svc
            .status()
            .map_err(|e| sync_local_error("vault_status_failed", e.to_string()))?
        {
            VaultStatus::Unlocked { .. } => {}
            VaultStatus::Locked { .. } => {
                return Err(
                    "[vault_locked] Unlock the local vault before restoring provider credentials."
                        .to_string(),
                )
            }
            VaultStatus::Uninitialized => {
                return Err(
                    "[vault_uninitialized] Initialize the local vault before restoring provider credentials."
                        .to_string(),
                )
            }
        }
    }

    let manifest = load_manifest(&provider_data_dir, kind)
        .map_err(|e| sync_error_to_string(&e))?
        .ok_or_else(|| {
            "[sync_collection_not_configured] Sync collection is not configured. Set up sync key first."
                .to_string()
        })?;
    let collection_key = load_collection_key(&manifest).map_err(|e| sync_error_to_string(&e))?;
    let secret_key = SecretKey::from_bytes(collection_key);

    let requested_logical_ids = normalize_requested_logical_ids(&args);
    let resolve_conflict_logical_ids = normalize_resolve_conflict_ids(&args);
    let stats = restore_credentials_from_provider_records(
        &app,
        &vault,
        provider_impl.as_ref(),
        &provider_data_dir,
        kind,
        &manifest,
        &secret_key,
        requested_logical_ids.as_ref(),
        &resolve_conflict_logical_ids,
    )
    .await?;

    let ts = now_secs();
    record_domain_sync_success(&provider_data_dir, kind, SyncDomain::Vault, ts)
        .map_err(|e| sync_error_to_string(&e))?;

    Ok(SyncRestoreCredentialsResult {
        provider: kind.as_str().to_string(),
        scanned: stats.scanned,
        restored: stats.restored,
        updated: stats.updated,
        tombstones_applied: stats.tombstones_applied,
        skipped: stats.skipped,
        conflicts: stats.conflicts,
        failed: stats.failed,
        synced_at: ts,
    })
}

#[tauri::command]
pub async fn sync_download(
    app: tauri::AppHandle,
    vault: State<'_, Mutex<VaultService>>,
    provider: String,
) -> Result<SyncDownloadResult, String> {
    let kind = parse_provider(&provider)?;
    let provider_impl = provider_for(kind).map_err(|e| sync_error_to_string(&e))?;
    let provider_data_dir = crate::commands::get_data_dir(&app);
    ensure_domain_enabled_for_provider(&provider_data_dir, kind, SyncDomain::Vault)?;

    let (bytes, ts) = provider_impl
        .download_vault_blob(&app)
        .await
        .map_err(|error| {
            record_sync_error(&provider_data_dir, kind, error.code, error.message.clone());
            sync_error_to_string(&error)
        })?;

    let tmp_path = provider_data_dir.join("vault.redb.download-tmp");
    tokio::fs::write(&tmp_path, &bytes)
        .await
        .map_err(|e| sync_local_error("sync_temp_write_failed", e.to_string()))?;

    let imported_status = {
        let mut svc = vault.lock().await;
        if let Err(e) = svc.import_vault(&tmp_path) {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return Err(sync_local_error("vault_import_failed", e.to_string()));
        }
        svc.status()
            .map_err(|e| sync_local_error("vault_status_failed", e.to_string()))?
    };
    let _ = tokio::fs::remove_file(&tmp_path).await;

    upsert_profile(&provider_data_dir, kind, |existing| {
        let mut profile = existing.unwrap_or_else(|| default_profile(kind));
        profile.connected = true;
        profile.last_sync = Some(ts);
        profile.last_error = None;
        profile.last_error_code = None;
        profile
    })
    .map_err(|e| sync_error_to_string(&e))?;

    let (item_count, vault_id) = match imported_status {
        VaultStatus::Locked { item_count, vault_id, .. } => (item_count, Some(vault_id)),
        VaultStatus::Unlocked { item_count, vault_id } => (item_count, Some(vault_id)),
        VaultStatus::Uninitialized => (0, None),
    };

    Ok(SyncDownloadResult {
        item_count,
        vault_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{CredentialItemKind, CredentialPurpose, CredentialRef};
    use crate::vault::credential::secret_values_from_legacy;
    use crate::vault::types::PlaintextRecord;

    fn local_record(
        logical_id: &str,
        revision: u64,
        updated_at: u64,
        secret: &str,
    ) -> PlaintextRecord {
        PlaintextRecord {
            id: "item-1".to_string(),
            logical_id: Some(logical_id.to_string()),
            kind: "ssh-private-key".to_string(),
            label: "test".to_string(),
            secret: String::new(),
            secret_values: secret_values_from_legacy("ssh-private-key", secret),
            notes: None,
            credential: None,
            revision,
            created_at: 1,
            updated_at,
        }
    }

    fn remote_record(
        logical_id: &str,
        revision: u64,
        updated_at: u64,
        secret: &str,
        deleted: bool,
    ) -> SyncCredentialPlaintextV1 {
        SyncCredentialPlaintextV1 {
            logical_id: logical_id.to_string(),
            kind: "ssh-private-key".to_string(),
            label: "test".to_string(),
            secret: String::new(),
            secret_values: secret_values_from_legacy("ssh-private-key", secret),
            notes: None,
            credential: None,
            revision,
            updated_at,
            deleted,
        }
    }

    fn test_capabilities() -> ProviderCapabilities {
        ProviderCapabilities {
            supports_autosync: false,
            supports_incremental: true,
            supports_etag: true,
            supports_domains: true,
            max_object_size: None,
            encryption_mode: super::super::types::EncryptionMode::AppEncryptedOnly,
        }
    }

    #[test]
    fn resolve_discovered_sync_collection_id_returns_single_match() {
        let resolved = resolve_discovered_sync_collection_id(
            vec!["collection-b".to_string()],
            None,
            "google",
        )
        .expect("single collection should resolve");
        assert_eq!(resolved.as_deref(), Some("collection-b"));
    }

    #[test]
    fn resolve_discovered_sync_collection_id_requires_selection_when_ambiguous() {
        let error = resolve_discovered_sync_collection_id(
            vec!["collection-a".to_string(), "collection-b".to_string()],
            None,
            "google",
        )
        .expect_err("ambiguous collections should fail without selection");
        assert!(error.contains("sync_collection_ambiguous_remote"));
        assert!(error.contains("Choose which backup"));
    }

    #[test]
    fn resolve_discovered_sync_collection_id_honors_preferred_selection() {
        let resolved = resolve_discovered_sync_collection_id(
            vec!["collection-a".to_string(), "collection-b".to_string()],
            Some("collection-b"),
            "google",
        )
        .expect("preferred collection should resolve");
        assert_eq!(resolved.as_deref(), Some("collection-b"));
    }

    #[test]
    fn resolve_discovered_sync_collection_id_rejects_unknown_selection() {
        let error = resolve_discovered_sync_collection_id(
            vec!["collection-a".to_string(), "collection-b".to_string()],
            Some("collection-c"),
            "google",
        )
        .expect_err("unknown selection should fail");
        assert!(error.contains("sync_collection_id_not_found"));
    }

    #[test]
    fn resolve_discovered_sync_collection_id_rejects_mismatched_single_selection() {
        let error = resolve_discovered_sync_collection_id(
            vec!["collection-a".to_string()],
            Some("collection-b"),
            "google",
        )
        .expect_err("preferred id must match the only discovered collection");
        assert!(error.contains("sync_collection_id_not_found"));
    }

    #[test]
    fn status_from_profile_exposes_default_domain_statuses() {
        let mut profile = default_profile(SyncProviderKind::Google);
        profile.domain_policies.clear();
        profile.domain_statuses.clear();

        let status = status_from_profile(profile, SyncProviderKind::Google, test_capabilities());

        assert_eq!(status.domain_statuses.len(), 5);
        assert_eq!(
            status.domain_statuses.iter().find(|s| s.domain == SyncDomain::Hosts).map(|s| s.enabled),
            Some(true)
        );
        assert_eq!(
            status.domain_statuses.iter().find(|s| s.domain == SyncDomain::Snippets).map(|s| s.enabled),
            Some(true)
        );
    }

    #[test]
    fn ensure_domain_collections_adds_new_domains_and_syncs_status_enabled_flags() {
        let mut profile = default_profile(SyncProviderKind::Google);
        profile.domain_policies = vec![SyncDomainPolicy {
            domain: SyncDomain::Hosts,
            enabled: false,
            mode: SyncPolicyMode::Manual,
        }];
        profile.domain_statuses = vec![SyncDomainStatus {
            domain: SyncDomain::Hosts,
            enabled: true,
            last_sync: None,
            last_error: None,
            last_error_code: None,
        }];

        ensure_domain_collections(&mut profile);

        assert_eq!(profile.domain_policies.len(), 5);
        assert_eq!(profile.domain_statuses.len(), 5);
        assert_eq!(
            profile.domain_statuses.iter().find(|s| s.domain == SyncDomain::Hosts).map(|s| s.enabled),
            Some(false),
        );
        assert_eq!(
            profile.domain_policies.iter().find(|p| p.domain == SyncDomain::Settings).map(|p| p.enabled),
            Some(true),
        );
    }

    #[test]
    fn ensure_domain_collections_migrates_old_app_data_defaults_to_enabled() {
        let mut profile = default_profile(SyncProviderKind::Google);
        for domain in [SyncDomain::Tunnels, SyncDomain::Snippets, SyncDomain::Settings] {
            profile
                .domain_policies
                .iter_mut()
                .find(|policy| policy.domain == domain)
                .expect("policy")
                .enabled = false;
            profile
                .domain_statuses
                .iter_mut()
                .find(|status| status.domain == domain)
                .expect("status")
                .enabled = false;
        }

        ensure_domain_collections(&mut profile);

        for domain in [SyncDomain::Tunnels, SyncDomain::Snippets, SyncDomain::Settings] {
            assert_eq!(
                profile.domain_policies.iter().find(|p| p.domain == domain).map(|p| p.enabled),
                Some(true),
            );
            assert_eq!(
                profile.domain_statuses.iter().find(|s| s.domain == domain).map(|s| s.enabled),
                Some(true),
            );
        }
    }

    #[test]
    fn ensure_domain_collections_keeps_touched_disabled_domain_policies() {
        let mut profile = default_profile(SyncProviderKind::Google);
        for domain in [SyncDomain::Tunnels, SyncDomain::Snippets, SyncDomain::Settings] {
            profile
                .domain_policies
                .iter_mut()
                .find(|policy| policy.domain == domain)
                .expect("policy")
                .enabled = false;
            let status = profile
                .domain_statuses
                .iter_mut()
                .find(|status| status.domain == domain)
                .expect("status");
            status.enabled = false;
        }
        profile
            .domain_statuses
            .iter_mut()
            .find(|status| status.domain == SyncDomain::Snippets)
            .expect("snippets status")
            .last_sync = Some(42);

        ensure_domain_collections(&mut profile);

        for domain in [SyncDomain::Tunnels, SyncDomain::Snippets, SyncDomain::Settings] {
            assert_eq!(
                profile.domain_policies.iter().find(|p| p.domain == domain).map(|p| p.enabled),
                Some(false),
            );
        }
    }

    #[test]
    fn parse_provider_accepts_google_aliases() {
        assert_eq!(parse_provider("google").unwrap(), SyncProviderKind::Google);
        assert_eq!(parse_provider("GOOGLE_DRIVE").unwrap(), SyncProviderKind::Google);
        assert_eq!(parse_provider("gdrive").unwrap(), SyncProviderKind::Google);
        assert!(parse_provider("dropbox").is_err());
    }

    #[test]
    fn sync_error_to_string_includes_code_prefix() {
        let err = SyncError::new("provider_http_failed", "request failed");
        assert_eq!(
            sync_error_to_string(&err),
            "[provider_http_failed] request failed"
        );
    }

    #[test]
    fn normalize_requested_logical_ids_trims_and_filters_blanks() {
        let args = SyncRestoreCredentialsArgs {
            logical_ids: Some(vec![
                "  cred-a  ".to_string(),
                "".to_string(),
                "   ".to_string(),
                "cred-b".to_string(),
            ]),
            resolve_conflict_logical_ids: None,
        };

        let ids = normalize_requested_logical_ids(&args).expect("ids should exist");
        assert_eq!(ids.len(), 2);
        assert!(ids.contains("cred-a"));
        assert!(ids.contains("cred-b"));
    }

    #[test]
    fn normalize_host_logical_id_filter_trims_and_filters_blanks() {
        let filter = normalize_host_logical_id_filter(Some(vec![
            " host-a ".to_string(),
            "".to_string(),
            "   ".to_string(),
            "host-b".to_string(),
        ]))
        .expect("filter should exist");
        assert_eq!(filter.len(), 2);
        assert!(filter.contains("host-a"));
        assert!(filter.contains("host-b"));
    }

    #[test]
    fn decode_sync_envelope_parses_nonce_and_ciphertext() {
        let nonce = [7u8; 24];
        let ciphertext = vec![1u8, 2u8, 3u8, 4u8];
        let record = SyncCredentialEncryptedV1 {
            version: 1,
            provider: "google".to_string(),
            sync_collection_id: "collection-1".to_string(),
            logical_id: "cred-1".to_string(),
            revision: 1,
            updated_at: 1,
            aad: "aad".to_string(),
            nonce: base64::engine::general_purpose::STANDARD.encode(nonce),
            ciphertext: base64::engine::general_purpose::STANDARD.encode(&ciphertext),
        };

        let envelope = decode_sync_envelope(&record).expect("envelope should decode");
        assert_eq!(envelope.nonce, nonce);
        assert_eq!(envelope.ciphertext, ciphertext);
    }

    #[test]
    fn parse_remote_sync_record_reconstructs_aad_from_trusted_metadata() {
        let secret_key = SecretKey::from_bytes([7u8; 32]);
        let plaintext = remote_record("cred-1", 2, 10, "secret", false);
        let plaintext_bytes = serde_json::to_vec(&plaintext).expect("serialize plaintext");
        let expected_aad = credential_aad("collection-1", "cred-1", 2);
        let envelope =
            encrypt_record(&secret_key, &plaintext_bytes, expected_aad.as_bytes()).expect("encrypt");
        let encrypted = SyncCredentialEncryptedV1 {
            version: 1,
            provider: "google".to_string(),
            sync_collection_id: "collection-1".to_string(),
            logical_id: "cred-1".to_string(),
            revision: 2,
            updated_at: 10,
            aad: "provider-controlled-aad".to_string(),
            nonce: base64::engine::general_purpose::STANDARD.encode(envelope.nonce),
            ciphertext: base64::engine::general_purpose::STANDARD.encode(envelope.ciphertext),
        };

        let payload = serde_json::to_vec(&encrypted).expect("serialize encrypted record");
        let (logical_id, parsed) =
            parse_remote_sync_record(&payload, "collection-1", &secret_key).expect("parse");
        assert_eq!(logical_id, "cred-1");
        assert_eq!(parsed.revision, 2);
    }

    #[test]
    fn decide_restore_action_prefers_remote_newer_revision() {
        let local = local_record("cred-1", 2, 200, "local");
        let remote = remote_record("cred-1", 3, 100, "remote", false);
        assert_eq!(
            decide_restore_action(Some(&local), &remote),
            RestoreDecision::UpdateExisting
        );
    }

    #[test]
    fn decide_restore_action_flags_equal_timestamp_payload_conflict() {
        let local = local_record("cred-1", 5, 300, "local-secret");
        let remote = remote_record("cred-1", 5, 300, "remote-secret", false);
        assert_eq!(
            decide_restore_action(Some(&local), &remote),
            RestoreDecision::Conflict
        );
    }

    #[test]
    fn decide_restore_action_applies_newer_tombstone() {
        let local = local_record("cred-1", 4, 250, "local");
        let tombstone = remote_record("cred-1", 5, 260, "", true);
        assert_eq!(
            decide_restore_action(Some(&local), &tombstone),
            RestoreDecision::ApplyDelete
        );
    }

    #[test]
    fn normalize_resolve_conflict_ids_handles_empty_values() {
        let args = SyncRestoreCredentialsArgs {
            logical_ids: None,
            resolve_conflict_logical_ids: Some(vec![
                "  cred-a  ".to_string(),
                "".to_string(),
                "cred-b".to_string(),
            ]),
        };
        let ids = normalize_resolve_conflict_ids(&args);
        assert_eq!(ids.len(), 2);
        assert!(ids.contains("cred-a"));
        assert!(ids.contains("cred-b"));
    }

    #[test]
    fn default_revision_maps_zero_to_one() {
        assert_eq!(default_revision(0), 1);
        assert_eq!(default_revision(42), 42);
    }

    #[test]
    fn host_objects_for_collect_uses_named_files_when_filtered() {
        let filter = HashSet::from(["host-a".to_string(), "host-b".to_string()]);
        let listed = vec![ProviderCredentialObject {
            object_name: "zync-sync-col-hosts-other.zhost".into(),
            object_id: Some("id".into()),
        }];
        let objects = host_objects_for_collect("col", Some(&filter), listed);
        assert_eq!(objects.len(), 2);
        let names: HashSet<_> = objects.into_iter().map(|o| o.object_name).collect();
        assert!(names.contains("zync-sync-col-hosts-host-a.zhost"));
        assert!(names.contains("zync-sync-col-hosts-host-b.zhost"));
    }

    #[test]
    fn credential_objects_for_restore_uses_named_files_when_filtered() {
        let filter = HashSet::from(["cred-1".to_string()]);
        let objects = credential_objects_for_restore("col", Some(&filter), Vec::new());
        assert_eq!(objects.len(), 1);
        assert_eq!(
            objects[0].object_name,
            "zync-sync-col-credential-cred-1.zcred"
        );
    }

    #[test]
    fn domain_object_matcher_checks_domain_and_extension() {
        assert!(is_domain_object_name(
            "zync-sync-col1-snippets-abc.zsnp",
            "snippets",
            ".zsnp"
        ));
        assert!(!is_domain_object_name(
            "zync-sync-col1-snippets-abc.zsnp",
            "tunnels",
            ".zsnp"
        ));
        assert!(!is_domain_object_name(
            "zync-sync-col1-snippets-abc.json",
            "snippets",
            ".zsnp"
        ));
    }

    #[test]
    fn credential_object_matcher_only_accepts_zcred_records() {
        assert!(is_credential_object_name("zync-sync-col1-credential-abc.zcred"));
        assert!(!is_credential_object_name("zync-sync-col1-hosts-abc.zhost"));
        assert!(!is_credential_object_name("zync-sync-col1-credential-abc.json"));
    }

    #[test]
    fn legacy_sync_private_key_payload_normalizes_to_named_secrets() {
        let mut record = SyncCredentialPlaintextV1 {
            logical_id: "credential-legacy-key".to_string(),
            kind: "ssh-key-with-passphrase".to_string(),
            label: "legacy key".to_string(),
            secret: serde_json::json!({
                "key": "private-key-data",
                "passphrase": "key-passphrase"
            })
            .to_string(),
            secret_values: BTreeMap::new(),
            notes: None,
            credential: None,
            revision: 1,
            updated_at: 1,
            deleted: false,
        };

        record.normalize();

        assert_eq!(record.kind, "ssh-private-key");
        assert!(record.secret.is_empty());
        assert_eq!(
            record.secret_values.get("privateKey").map(String::as_str),
            Some("private-key-data")
        );
        assert_eq!(
            record.secret_values.get("passphrase").map(String::as_str),
            Some("key-passphrase")
        );
        assert_eq!(
            record
                .credential
                .as_ref()
                .map(|credential| credential.schema_version),
            Some(crate::vault::credential::CURRENT_CREDENTIAL_SCHEMA_VERSION)
        );
    }

    #[test]
    fn build_credential_provider_record_roundtrips_logical_id_and_payload() {
        let manifest = SyncCollectionManifest {
            version: 1,
            provider: "google".to_string(),
            sync_collection_id: "collection-1".to_string(),
            key_policy_mode: SyncKeyPolicyMode::CustomPassphrase,
            key_wrap_salt: None,
            key_wrap_nonce: None,
            key_wrap_ciphertext: None,
            recovery_key_wrap_salt: None,
            recovery_key_wrap_nonce: None,
            recovery_key_wrap_ciphertext: None,
            key_cache_unlocked_at: None,
            key_cache_ttl_secs: None,
            has_recovery_key: false,
            created_at: 1,
            updated_at: 1,
        };
        let secret_key = SecretKey::from_bytes([9u8; 32]);
        let record = local_record("cred-roundtrip", 7, 11, "secret-key-data");

        let (logical_id, upload_record) = build_credential_provider_record(
            SyncProviderKind::Google,
            &manifest,
            &secret_key,
            &record,
        )
        .expect("credential upload record should build");
        let (parsed_logical_id, parsed) = parse_remote_sync_record(
            &upload_record.payload,
            &manifest.sync_collection_id,
            &secret_key,
        )
        .expect("provider record should parse");

        assert_eq!(logical_id, "cred-roundtrip");
        assert_eq!(parsed_logical_id, "cred-roundtrip");
        assert_eq!(upload_record.object_name, "zync-sync-collection-1-credential-cred-roundtrip.zcred");
        assert_eq!(
            parsed.secret_values.get("privateKey").map(String::as_str),
            Some("secret-key-data")
        );
        assert_eq!(parsed.revision, 7);
        assert_eq!(parsed.updated_at, 11);
    }

    #[test]
    fn host_auth_credential_ids_collects_unique_non_empty_refs() {
        let mut records = Vec::new();
        for credential_id in [Some(" cred-a "), Some("cred-a"), Some(""), None] {
            records.push(HostSyncRecord {
                logical_id: "host-1".to_string(),
                name: "host".to_string(),
                host: "example.com".to_string(),
                port: 22,
                username: "app".to_string(),
                jump_server_id: None,
                folder: None,
                tags: Vec::new(),
                is_favorite: false,
                updated_at: 1,
                auth_ref: Some(CredentialRef {
                    vault_id: "old-vault".to_string(),
                    credential_id: credential_id.map(str::to_string),
                    item_id: "old-item".to_string(),
                    item_kind: CredentialItemKind::SshPrivateKey,
                    purpose: CredentialPurpose::SshAuth,
                }),
            });
        }

        let ids = host_auth_credential_ids(&records);

        assert_eq!(ids.len(), 1);
        assert!(ids.contains("cred-a"));
    }

    #[test]
    fn filter_tunnel_records_for_hosts_skips_orphans() {
        let records = vec![
            TunnelSyncRecord {
                logical_id: "tun-1".to_string(),
                connection_id: "Host-A".to_string(),
                name: "db".to_string(),
                tunnel_type: "local".to_string(),
                local_port: 8080,
                remote_host: "127.0.0.1".to_string(),
                remote_port: 5432,
                bind_address: None,
                bind_to_any: false,
                auto_start: false,
                group: None,
                updated_at: 1,
            },
            TunnelSyncRecord {
                logical_id: "tun-2".to_string(),
                connection_id: "missing-host".to_string(),
                name: "orphan".to_string(),
                tunnel_type: "local".to_string(),
                local_port: 9090,
                remote_host: "127.0.0.1".to_string(),
                remote_port: 22,
                bind_address: None,
                bind_to_any: false,
                auto_start: false,
                group: None,
                updated_at: 1,
            },
        ];
        let eligible = HashSet::from([normalize_host_connection_id("host-a")]);
        let (filtered, skipped_orphaned) = filter_tunnel_records_for_hosts(records, &eligible);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].logical_id, "tun-1");
        assert_eq!(skipped_orphaned, 1);
    }

    #[test]
    fn filter_host_scoped_snippet_records_skips_global_and_orphans() {
        let records = vec![
            SnippetSyncRecord {
                logical_id: "global".to_string(),
                name: "global".to_string(),
                command: "ls".to_string(),
                category: None,
                tags: Vec::new(),
                connection_id: None,
                updated_at: 1,
            },
            SnippetSyncRecord {
                logical_id: "host-scoped".to_string(),
                name: "host".to_string(),
                command: "pwd".to_string(),
                category: None,
                tags: Vec::new(),
                connection_id: Some("host-a".to_string()),
                updated_at: 1,
            },
            SnippetSyncRecord {
                logical_id: "orphan".to_string(),
                name: "orphan".to_string(),
                command: "whoami".to_string(),
                category: None,
                tags: Vec::new(),
                connection_id: Some("missing".to_string()),
                updated_at: 1,
            },
        ];
        let eligible = HashSet::from([normalize_host_connection_id("host-a")]);
        let (filtered, skipped_orphaned) = filter_host_scoped_snippet_records(records, &eligible);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].logical_id, "host-scoped");
        assert_eq!(skipped_orphaned, 1);
    }

    #[test]
    fn filter_host_records_for_eligible_hosts_respects_local_scope() {
        let records = vec![
            test_host_record("Host-A"),
            test_host_record("host-b"),
        ];
        let eligible = HashSet::from([normalize_host_connection_id("host-a")]);
        let filtered = filter_host_records_for_eligible_hosts(records, &eligible);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].logical_id, "Host-A");
    }

    #[test]
    fn filter_global_snippet_records_keeps_only_global_entries() {
        let records = vec![
            SnippetSyncRecord {
                logical_id: "global".to_string(),
                name: "global".to_string(),
                command: "ls".to_string(),
                category: None,
                tags: Vec::new(),
                connection_id: None,
                updated_at: 1,
            },
            SnippetSyncRecord {
                logical_id: "host".to_string(),
                name: "host".to_string(),
                command: "pwd".to_string(),
                category: None,
                tags: Vec::new(),
                connection_id: Some("host-a".to_string()),
                updated_at: 1,
            },
        ];
        let (filtered, skipped_host_scoped) = filter_global_snippet_records(records);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].logical_id, "global");
        assert_eq!(skipped_host_scoped, 1);
    }

    fn test_host_record(logical_id: &str) -> HostSyncRecord {
        HostSyncRecord {
            logical_id: logical_id.to_string(),
            name: logical_id.to_string(),
            host: "example.com".to_string(),
            port: 22,
            username: "user".to_string(),
            jump_server_id: None,
            folder: None,
            tags: Vec::new(),
            is_favorite: false,
            updated_at: 1,
            auth_ref: None,
        }
    }

    #[test]
    fn resolve_bundle_eligible_host_ids_returns_all_remote_when_definitions_included() {
        let remote = vec![test_host_record("Host-A"), test_host_record("host-b")];
        let local = HashSet::from(["existing".to_string()]);
        let eligible = resolve_bundle_eligible_host_ids(&remote, &local, true);
        assert_eq!(eligible.len(), 2);
        assert!(eligible.contains("host-a"));
        assert!(eligible.contains("host-b"));
    }

    #[test]
    fn resolve_bundle_eligible_host_ids_filters_to_local_hosts_when_definitions_excluded() {
        let remote = vec![test_host_record("Host-A"), test_host_record("host-b")];
        let local = HashSet::from(["host-a".to_string()]);
        let eligible = resolve_bundle_eligible_host_ids(&remote, &local, false);
        assert_eq!(eligible.len(), 1);
        assert!(eligible.contains("host-a"));
    }

    #[test]
    fn filter_tunnel_records_for_hosts_counts_orphaned_records() {
        let records = vec![
            TunnelSyncRecord {
                logical_id: "tunnel-1".to_string(),
                connection_id: "Host-A".to_string(),
                name: "tunnel".to_string(),
                tunnel_type: "local".to_string(),
                local_port: 2222,
                remote_host: "127.0.0.1".to_string(),
                remote_port: 22,
                bind_address: None,
                bind_to_any: false,
                auto_start: false,
                group: None,
                updated_at: 1,
            },
            TunnelSyncRecord {
                logical_id: "tunnel-2".to_string(),
                connection_id: "missing-host".to_string(),
                name: "orphan".to_string(),
                tunnel_type: "local".to_string(),
                local_port: 2223,
                remote_host: "127.0.0.1".to_string(),
                remote_port: 22,
                bind_address: None,
                bind_to_any: false,
                auto_start: false,
                group: None,
                updated_at: 1,
            },
        ];
        let eligible = HashSet::from(["host-a".to_string()]);
        let (filtered, skipped_orphaned) = filter_tunnel_records_for_hosts(records, &eligible);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].logical_id, "tunnel-1");
        assert_eq!(skipped_orphaned, 1);
    }
}
