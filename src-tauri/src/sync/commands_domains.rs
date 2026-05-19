use super::commands::{
    record_sync_error, sync_error_to_string, SyncHostsEncryptedV1,
};
use super::provider::VaultProviderV1;
use super::types::{SyncCollectionManifest, SyncProviderKind};
use crate::vault::crypto::{decrypt_record, encrypt_record, SecretKey};
use base64::Engine;
use std::path::Path;

pub(crate) struct DomainUploadMeta<'a> {
    pub domain: &'a str,
    pub logical_id: &'a str,
    pub revision: u64,
    pub updated_at: u64,
    pub extension: &'a str,
}

pub(crate) struct DomainCollectResult<T> {
    pub scanned: u64,
    pub skipped: u64,
    pub failed: u64,
    pub records: Vec<T>,
}

pub(crate) fn default_revision(updated_at: u64) -> u64 {
    if updated_at == 0 { 1 } else { updated_at }
}

pub(crate) fn domain_object_name(sync_collection_id: &str, domain: &str, logical_id: &str, ext: &str) -> String {
    format!("zync-sync-{}-{}-{}.{}", sync_collection_id, domain, logical_id, ext)
}

pub(crate) fn domain_aad(sync_collection_id: &str, domain: &str, logical_id: &str, revision: u64) -> String {
    format!(
        "zync:sync-{domain}:v1|collection:{sync_collection_id}|logical:{logical_id}|revision:{revision}"
    )
}

pub(crate) fn is_domain_object_name(object_name: &str, domain: &str, extension: &str) -> bool {
    object_name.contains(&format!("-{}-", domain)) && object_name.ends_with(extension)
}

pub(crate) async fn upload_domain_record<T: serde::Serialize>(
    provider_impl: &dyn VaultProviderV1,
    app: &tauri::AppHandle,
    provider: SyncProviderKind,
    manifest: &SyncCollectionManifest,
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
            record_sync_error(data_dir, provider, error.code, error.message.clone());
            sync_error_to_string(&error)
        })
}

pub(crate) async fn collect_domain_records<T>(
    provider_impl: &dyn VaultProviderV1,
    app: &tauri::AppHandle,
    manifest: &SyncCollectionManifest,
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
        let envelope = super::commands::decode_sync_hosts_envelope(&encrypted)?;
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

