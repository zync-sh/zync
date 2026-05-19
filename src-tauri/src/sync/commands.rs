use super::collection::{
    clear_collection_key_cache, enforce_collection_key_cache_ttl, has_recovery_key_slot,
    is_collection_key_cached, load_collection_key, load_manifest, regenerate_recovery_key,
    save_manifest, set_collection_key_cache_ttl, setup_manifest, SYNC_COLLECTION_KEY_CACHE_TTL_SECS,
    unlock_collection_key_with_passphrase, unlock_collection_key_with_recovery_key,
};
use super::domain_hosts::{apply_hosts_restore_records, load_hosts_sync_records, HostSyncRecord};
use super::domain_settings::{load_allowlisted_settings, SettingsSyncRecord, SETTINGS_ALLOWLIST_KEYS};
use super::domain_snippets::{apply_snippet_restore_records, load_snippet_sync_records, SnippetSyncRecord};
use super::domain_tunnels::{apply_tunnel_restore_records, load_tunnel_sync_records, TunnelSyncRecord};
use super::profiles::{get_profile, now_secs, upsert_profile};
use super::provider::{validate_provider_contract, VaultProviderV1};
use super::providers::google::{legacy_google_token_snapshot, GoogleVaultProvider};
use super::types::{
    ProviderCapabilities, ProviderStatusSnapshot, SyncCollectionSetupArgs, SyncCollectionSetupResult,
    SyncCollectionStatus, SyncCollectionUnlockArgs, SyncDomain, SyncDomainPolicy, SyncDomainStatus, SyncError,
    SyncKeyPolicyMode, SyncPolicyMode, SyncProfile, SyncProviderKind,
    SyncProviderStatus, SyncResult, SyncRestoreConflictItem,
    SyncRestoreCredentialsArgs, SyncRestoreCredentialsResult, SyncRestorePreviewResult,
    SyncUploadCredentialArgs, SyncUploadCredentialResult,
};
use crate::vault::crypto::{decrypt_record, encrypt_record, EncryptedEnvelope, SecretKey};
use crate::vault::types::PlaintextRecord;
use crate::vault::store::VaultService;
use crate::vault::types::VaultStatus;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
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
        SyncDomainPolicy { domain: SyncDomain::Tunnels, enabled: false, mode: SyncPolicyMode::Manual },
        SyncDomainPolicy { domain: SyncDomain::Snippets, enabled: false, mode: SyncPolicyMode::Manual },
        SyncDomainPolicy { domain: SyncDomain::Settings, enabled: false, mode: SyncPolicyMode::Manual },
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
    }
    if profile.domain_statuses.is_empty() {
        profile.domain_statuses = default_domain_statuses();
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
    pub skipped: u64,
    pub failed: u64,
    pub synced_at: u64,
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
    secret: String,
    notes: Option<String>,
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

fn default_revision(updated_at: u64) -> u64 {
    if updated_at == 0 { 1 } else { updated_at }
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
        .list_credential_records(app, &manifest.sync_collection_id)
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
        let plaintext = match decrypt_record(secret_key, &envelope, encrypted.aad.as_bytes()) {
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
        && existing.secret == remote.secret
        && existing.notes == remote.notes
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
    let plaintext_bytes = decrypt_record(secret_key, &envelope, encrypted.aad.as_bytes())
        .map_err(|e| format!("[sync_decrypt_failed] Failed to decrypt provider record: {e}"))?;
    let mut plaintext = serde_json::from_slice::<SyncCredentialPlaintextV1>(&plaintext_bytes)
        .map_err(|e| format!("[sync_parse_failed] Failed to parse decrypted payload: {e}"))?;
    if plaintext.logical_id.trim().is_empty() {
        plaintext.logical_id = logical_id.clone();
    }
    if plaintext.logical_id != logical_id {
        return Err("[sync_logical_id_mismatch] Provider header/payload logical id mismatch".to_string());
    }
    Ok((logical_id, plaintext))
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
    let since = profile.as_ref().and_then(|p| p.last_sync);
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

    let changes = sync_hosts_changes(app.clone(), provider.clone(), args).await?;
    let mut uploaded = 0u64;
    let mut latest_synced_at = 0u64;
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
        let synced_at = provider_impl
            .upload_credential_record(&app, &object_name, payload)
            .await
            .map_err(|error| {
                record_sync_error(&provider_data_dir, kind, error.code, error.message.clone());
                sync_error_to_string(&error)
            })?;
        latest_synced_at = latest_synced_at.max(synced_at);
        uploaded = uploaded.saturating_add(1);
    }

    let skipped = changes.count.saturating_sub(uploaded);
    let profile_sync_at = if uploaded > 0 { latest_synced_at } else { now_secs() };
    record_domain_sync_success(&provider_data_dir, kind, SyncDomain::Hosts, profile_sync_at)
        .map_err(|e| sync_error_to_string(&e))?;

    Ok(SyncHostsUploadResult {
        domain: "hosts".to_string(),
        uploaded,
        skipped,
        synced_at: profile_sync_at,
    })
}

#[tauri::command]
pub async fn sync_hosts_restore(
    app: tauri::AppHandle,
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

    let remote_objects = provider_impl
        .list_credential_records(&app, &manifest.sync_collection_id)
        .await
        .map_err(|error| {
            record_sync_error(&provider_data_dir, kind, error.code, error.message.clone());
            sync_error_to_string(&error)
        })?;

    let mut scanned = 0u64;
    let mut skipped = 0u64;
    let mut failed = 0u64;
    let mut records = Vec::<HostSyncRecord>::new();

    for object in remote_objects {
        if !object.object_name.contains("-hosts-") || !object.object_name.ends_with(".zhost") {
            continue;
        }
        scanned = scanned.saturating_add(1);
        let payload = match provider_impl.read_credential_record(&app, &object).await {
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
            || encrypted.provider != kind.as_str()
        {
            skipped = skipped.saturating_add(1);
            continue;
        }
        if let Some(filter) = logical_id_filter.as_ref() {
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
        let plaintext = match decrypt_record(&secret_key, &envelope, encrypted.aad.as_bytes()) {
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
        records.push(record);
    }

    let (restored, updated) =
        apply_hosts_restore_records(&provider_data_dir, &records).map_err(|e| sync_error_to_string(&e))?;
    let synced_at = now_secs();
    record_domain_sync_success(&provider_data_dir, kind, SyncDomain::Hosts, synced_at)
        .map_err(|e| sync_error_to_string(&e))?;

    Ok(SyncHostsRestoreResult {
        domain: "hosts".to_string(),
        scanned,
        restored,
        updated,
        skipped,
        failed,
        synced_at,
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
pub async fn sync_snippets_restore(app: tauri::AppHandle, provider: String) -> Result<SyncDomainRestoreResult, String> {
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
    let records = collected
        .records
        .into_iter()
        .map(|mut record| {
            if record.logical_id.trim().is_empty() {
                record.logical_id = format!(
                    "{}:{}",
                    record.name.trim().to_ascii_lowercase(),
                    record.command.len()
                );
            }
            record
        })
        .collect::<Vec<_>>();
    let (restored, updated) = apply_snippet_restore_records(&data_dir, &records).map_err(|e| sync_error_to_string(&e))?;
    let synced_at = now_secs();
    record_domain_sync_success(&data_dir, kind, SyncDomain::Snippets, synced_at)
        .map_err(|e| sync_error_to_string(&e))?;
    Ok(SyncDomainRestoreResult {
        domain: "snippets".into(),
        scanned: collected.scanned,
        restored,
        updated,
        skipped: collected.skipped,
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
    let record = load_allowlisted_settings(&app).await?;
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
pub async fn sync_collection_setup(
    app: tauri::AppHandle,
    vault: State<'_, Mutex<VaultService>>,
    provider: String,
    args: SyncCollectionSetupArgs,
) -> Result<SyncCollectionSetupResult, String> {
    let kind = parse_provider(&provider)?;
    let provider_data_dir = crate::commands::get_data_dir(&app);

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
                svc.unlock(&passphrase).map_err(|_| {
                    "[sync_collection_passphrase_mismatch] Local Vault passphrase did not unlock this vault."
                        .to_string()
                })?;
            }
        }
    }

    let outcome = setup_manifest(
        &provider_data_dir,
        kind,
        args.key_policy_mode,
        &passphrase,
        args.has_recovery_key,
    )
    .map_err(|e| sync_error_to_string(&e))?;

    let status = collection_status_from_manifest(kind, Some(outcome.manifest));
    Ok(SyncCollectionSetupResult {
        status,
        recovery_key: outcome.recovery_key,
    })
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

    upsert_profile(&provider_data_dir, kind, |existing| {
        let mut profile = existing.unwrap_or_else(|| default_profile(kind));
        profile.connected = true;
        profile.last_sync = Some(ts);
        profile.last_error = None;
        profile.last_error_code = None;
        profile
    })
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

    let logical_id = VaultService::record_logical_id(&record);
    let plaintext = SyncCredentialPlaintextV1 {
        logical_id: logical_id.clone(),
        kind: record.kind.clone(),
        label: record.label.clone(),
        secret: record.secret.clone(),
        notes: record.notes.clone(),
        revision: record.revision,
        updated_at: record.updated_at,
        deleted: false,
    };

    let plaintext_bytes = serde_json::to_vec(&plaintext)
        .map_err(|e| format!("[sync_serialize_failed] Failed to serialize credential: {e}"))?;
    let aad = credential_aad(&manifest.sync_collection_id, &logical_id, record.revision);
    let envelope = encrypt_record(&secret_key, &plaintext_bytes, aad.as_bytes()).map_err(|e| {
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

    let synced_at = provider_impl
        .upload_credential_record(&app, &object_name, payload)
        .await
        .map_err(|error| {
            record_sync_error(&provider_data_dir, kind, error.code, error.message.clone());
            sync_error_to_string(&error)
        })?;

    upsert_profile(&provider_data_dir, kind, |existing| {
        let mut profile = existing.unwrap_or_else(|| default_profile(kind));
        profile.connected = true;
        profile.last_sync = Some(synced_at);
        profile.last_error = None;
        profile.last_error_code = None;
        profile
    })
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
    let remote_objects = provider_impl
        .list_credential_records(&app, &manifest.sync_collection_id)
        .await
        .map_err(|error| {
            record_sync_error(&provider_data_dir, kind, error.code, error.message.clone());
            sync_error_to_string(&error)
        })?;

    let mut scanned = 0u64;
    let mut restored = 0u64;
    let mut updated = 0u64;
    let mut tombstones_applied = 0u64;
    let mut skipped = 0u64;
    let mut conflicts = 0u64;
    let mut failed = 0u64;

    for object in remote_objects {
        scanned = scanned.saturating_add(1);

        let payload = match provider_impl.read_credential_record(&app, &object).await {
            Ok(bytes) => bytes,
            Err(error) => {
                failed = failed.saturating_add(1);
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
            &secret_key,
        ) {
            Ok(parsed) => parsed,
            Err(error) => {
                if error.starts_with("[sync_collection_mismatch]") {
                    skipped = skipped.saturating_add(1);
                } else {
                    failed = failed.saturating_add(1);
                    eprintln!(
                        "[sync] Failed to parse provider object '{}': {}",
                        object.object_name, error
                    );
                }
                continue;
            }
        };

        if let Some(filter) = requested_logical_ids.as_ref() {
            if !filter.contains(&logical_id) {
                skipped = skipped.saturating_add(1);
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
                                &plaintext.secret,
                                plaintext.notes.as_deref(),
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
                                &plaintext.secret,
                                plaintext.notes.as_deref(),
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
                                &plaintext.secret,
                                plaintext.notes.as_deref(),
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
            Ok(RestoreDecision::RestoreNew) => restored = restored.saturating_add(1),
            Ok(RestoreDecision::UpdateExisting) => updated = updated.saturating_add(1),
            Ok(RestoreDecision::ApplyDelete) => {
                tombstones_applied = tombstones_applied.saturating_add(1)
            }
            Ok(RestoreDecision::SkipStale | RestoreDecision::SkipAlreadyDeleted) => {
                skipped = skipped.saturating_add(1)
            }
            Ok(RestoreDecision::Conflict) => {
                conflicts = conflicts.saturating_add(1);
                eprintln!(
                    "[sync] Conflict detected for '{}' (same revision/timestamp with divergent payload)",
                    logical_id
                );
            }
            Err(error) => {
                failed = failed.saturating_add(1);
                eprintln!(
                    "[sync] Failed applying provider object '{}': {}",
                    object.object_name, error
                );
            }
        }
    }

    let ts = now_secs();
    upsert_profile(&provider_data_dir, kind, |existing| {
        let mut profile = existing.unwrap_or_else(|| default_profile(kind));
        profile.connected = true;
        profile.last_sync = Some(ts);
        profile.last_error = None;
        profile.last_error_code = None;
        profile
    })
    .map_err(|e| sync_error_to_string(&e))?;

    Ok(SyncRestoreCredentialsResult {
        provider: kind.as_str().to_string(),
        scanned,
        restored,
        updated,
        tombstones_applied,
        skipped,
        conflicts,
        failed,
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
        VaultStatus::Locked { item_count, vault_id } => (item_count, Some(vault_id)),
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
            secret: secret.to_string(),
            notes: None,
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
            secret: secret.to_string(),
            notes: None,
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
            Some(false)
        );
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
}
