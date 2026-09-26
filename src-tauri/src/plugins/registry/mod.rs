use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const MAX_REGISTRY_BYTES: u64 = 2 * 1024 * 1024;
const MAX_CLOCK_SKEW_MS: u64 = 5 * 60 * 1_000;
const MAX_REGISTRY_PLUGINS: usize = 10_000;
const MAX_REGISTRY_REVOCATIONS: usize = 10_000;
const MAX_SERIALIZED_REVOCATION_BYTES: usize = 4 * 1024;
const MAX_REGISTRY_STATE_BYTES: u64 =
    4 * 1024 + MAX_REGISTRY_REVOCATIONS as u64 * (MAX_SERIALIZED_REVOCATION_BYTES as u64 + 1);
const MAX_TRUSTED_ROOT_KEYS: usize = 4;
const SIGNING_DOMAIN: &str = "zync-plugin-registry-v1\n";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistrySignature {
    pub key_id: String,
    pub signature: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SignedRegistryEnvelope {
    signed: Value,
    signatures: Vec<RegistrySignature>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistryPayload {
    #[serde(rename = "_type")]
    pub metadata_type: String,
    pub version: u64,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    pub plugins: Vec<TrustedRegistryPlugin>,
    #[serde(default)]
    pub revocations: Vec<RegistryRevocation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum RegistryRevocationKind {
    PublisherKey,
    PluginRelease,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistryRevocation {
    pub kind: RegistryRevocationKind,
    pub publisher: String,
    #[serde(default)]
    pub key_id: Option<String>,
    #[serde(default)]
    pub plugin_id: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub package_digest: Option<String>,
    pub revoked_at_ms: u64,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustedRegistryPlugin {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub channel: PluginReleaseChannel,
    pub description: String,
    pub publisher: String,
    pub download_url: String,
    pub package_digest: String,
    pub publisher_key_id: String,
    pub publisher_public_key: String,
    pub publisher_verified: bool,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub thumbnail_url: Option<String>,
    #[serde(default)]
    pub plugin_type: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginReleaseChannel {
    #[default]
    Stable,
    Beta,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedRegistrySnapshot {
    pub version: u64,
    pub expires_at_ms: u64,
    pub plugins: Vec<TrustedRegistryPlugin>,
    pub revocations: Vec<RegistryRevocation>,
}

impl TrustedRegistrySnapshot {
    pub fn release_revocation_reason(&self, release: &TrustedRegistryPlugin) -> Option<&str> {
        self.revocations.iter().find_map(|revocation| {
            let matches = match revocation.kind {
                RegistryRevocationKind::PublisherKey => {
                    revocation.publisher == release.publisher
                        && revocation.key_id.as_deref() == Some(&release.publisher_key_id)
                }
                RegistryRevocationKind::PluginRelease => {
                    revocation.publisher == release.publisher
                        && revocation.plugin_id.as_deref() == Some(&release.id)
                        && revocation.version.as_deref() == Some(&release.version)
                        && revocation.package_digest.as_deref() == Some(&release.package_digest)
                }
            };
            matches.then_some(revocation.reason.as_str())
        })
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistryState {
    highest_version: u64,
    #[serde(default)]
    revocations: Vec<RegistryRevocation>,
}

pub async fn load(app: &AppHandle) -> Result<TrustedRegistrySnapshot> {
    let registry_url = option_env!("ZYNC_PLUGIN_REGISTRY_URL")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow!("Trusted plugin marketplace is not configured in this build"))?;
    let root_public_keys = option_env!("ZYNC_PLUGIN_REGISTRY_ROOT_KEYS")
        .or(option_env!("ZYNC_PLUGIN_REGISTRY_ROOT_KEY"))
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow!("Trusted plugin marketplace root key is not configured"))?;
    let requested_url = validate_https_url(registry_url, "registry")?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()?;
    let response = client.get(requested_url).send().await?;
    if !response.status().is_success() {
        return Err(anyhow!(
            "Trusted plugin marketplace returned status {}",
            response.status()
        ));
    }
    if response.url().scheme() != "https" {
        return Err(anyhow!(
            "Trusted plugin marketplace redirected away from HTTPS"
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_REGISTRY_BYTES)
    {
        return Err(anyhow!("Trusted plugin marketplace metadata exceeds 2 MiB"));
    }
    let bytes = response.bytes().await?;
    if bytes.len() as u64 > MAX_REGISTRY_BYTES {
        return Err(anyhow!("Trusted plugin marketplace metadata exceeds 2 MiB"));
    }

    let state_path = app
        .path()
        .app_config_dir()
        .context("Failed to resolve app config directory")?
        .join("plugin-registry-state.json");
    let state = read_state(&state_path)?;
    let mut snapshot = verify_registry(&bytes, root_public_keys, state.highest_version, now_ms()?)?;
    snapshot.revocations = merge_revocations(&state.revocations, &snapshot.revocations)?;
    write_state(
        &state_path,
        &RegistryState {
            highest_version: snapshot.version,
            revocations: snapshot.revocations.clone(),
        },
    )?;
    Ok(snapshot)
}

pub fn verify_registry(
    bytes: &[u8],
    trusted_root_public_keys: &str,
    minimum_version: u64,
    current_time_ms: u64,
) -> Result<TrustedRegistrySnapshot> {
    if bytes.len() as u64 > MAX_REGISTRY_BYTES {
        return Err(anyhow!("Trusted plugin marketplace metadata exceeds 2 MiB"));
    }
    let envelope: SignedRegistryEnvelope =
        serde_json::from_slice(bytes).context("Trusted plugin marketplace metadata is invalid")?;
    if envelope.signatures.len() != 1 {
        return Err(anyhow!(
            "Trusted plugin marketplace requires exactly one root signature"
        ));
    }

    let registry_signature = &envelope.signatures[0];
    let public_key = decode_trusted_root_keys(trusted_root_public_keys)?
        .into_iter()
        .find(|key| key_id(key.as_bytes()) == registry_signature.key_id)
        .ok_or_else(|| anyhow!("Plugin marketplace root key id is not trusted"))?;
    let signature_bytes = STANDARD
        .decode(&registry_signature.signature)
        .context("Plugin marketplace signature is not valid base64")?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| anyhow!("Plugin marketplace signature must be 64 bytes"))?;
    let canonical = canonical_json(&envelope.signed)?;
    public_key
        .verify(
            format!("{SIGNING_DOMAIN}{canonical}").as_bytes(),
            &signature,
        )
        .map_err(|_| anyhow!("Plugin marketplace signature is invalid"))?;

    let payload: RegistryPayload = serde_json::from_value(envelope.signed)
        .context("Plugin marketplace signed payload is invalid")?;
    validate_payload(&payload, minimum_version, current_time_ms)?;
    Ok(TrustedRegistrySnapshot {
        version: payload.version,
        expires_at_ms: payload.expires_at_ms,
        plugins: payload.plugins,
        revocations: payload.revocations,
    })
}

fn decode_trusted_root_keys(value: &str) -> Result<Vec<VerifyingKey>> {
    let encoded = value
        .split(',')
        .map(str::trim)
        .filter(|candidate| !candidate.is_empty())
        .collect::<Vec<_>>();
    if encoded.is_empty() || encoded.len() > MAX_TRUSTED_ROOT_KEYS {
        return Err(anyhow!(
            "Trusted plugin marketplace must configure between 1 and {MAX_TRUSTED_ROOT_KEYS} root keys"
        ));
    }
    encoded
        .into_iter()
        .map(|candidate| decode_public_key(candidate, "registry root"))
        .collect()
}

fn validate_payload(payload: &RegistryPayload, minimum_version: u64, now: u64) -> Result<()> {
    if payload.metadata_type != "zync.plugin-registry" || payload.version == 0 {
        return Err(anyhow!("Unsupported plugin marketplace metadata"));
    }
    if payload.version < minimum_version {
        return Err(anyhow!("Plugin marketplace metadata rollback was rejected"));
    }
    if payload.issued_at_ms > now.saturating_add(MAX_CLOCK_SKEW_MS) {
        return Err(anyhow!(
            "Plugin marketplace metadata is dated in the future"
        ));
    }
    if payload.expires_at_ms <= now || payload.expires_at_ms <= payload.issued_at_ms {
        return Err(anyhow!("Plugin marketplace metadata has expired"));
    }
    if payload.plugins.len() > MAX_REGISTRY_PLUGINS {
        return Err(anyhow!("Plugin marketplace contains too many entries"));
    }
    if payload.revocations.len() > MAX_REGISTRY_REVOCATIONS {
        return Err(anyhow!("Plugin marketplace contains too many revocations"));
    }

    let mut releases = HashSet::new();
    for plugin in &payload.plugins {
        validate_plugin(plugin)?;
        if !releases.insert((plugin.id.clone(), plugin.version.clone())) {
            return Err(anyhow!("Plugin marketplace contains a duplicate release"));
        }
    }
    let mut revocations = HashSet::new();
    for revocation in &payload.revocations {
        validate_revocation(revocation, now)?;
        if !revocations.insert(revocation_identity(revocation)) {
            return Err(anyhow!(
                "Plugin marketplace contains a duplicate revocation"
            ));
        }
    }
    Ok(())
}

fn validate_revocation(revocation: &RegistryRevocation, now: u64) -> Result<()> {
    if serde_json::to_vec(revocation)?.len() > MAX_SERIALIZED_REVOCATION_BYTES {
        return Err(anyhow!(
            "Plugin marketplace revocation metadata is too large"
        ));
    }
    if revocation.publisher.trim().is_empty()
        || revocation.reason.trim().is_empty()
        || revocation.revoked_at_ms == 0
        || revocation.revoked_at_ms > now.saturating_add(MAX_CLOCK_SKEW_MS)
    {
        return Err(anyhow!("Plugin marketplace contains an invalid revocation"));
    }
    match revocation.kind {
        RegistryRevocationKind::PublisherKey => {
            let key_id = revocation
                .key_id
                .as_deref()
                .ok_or_else(|| anyhow!("Publisher-key revocation is missing its key id"))?;
            validate_sha256(key_id, "revoked publisher key id")?;
            if revocation.plugin_id.is_some()
                || revocation.version.is_some()
                || revocation.package_digest.is_some()
            {
                return Err(anyhow!("Publisher-key revocation has release fields"));
            }
        }
        RegistryRevocationKind::PluginRelease => {
            let plugin_id = revocation
                .plugin_id
                .as_deref()
                .ok_or_else(|| anyhow!("Plugin-release revocation is missing its plugin id"))?;
            if !plugin_id.starts_with(&format!("{}.", revocation.publisher))
                || revocation.version.as_deref().is_none_or(str::is_empty)
            {
                return Err(anyhow!("Plugin-release revocation identity is invalid"));
            }
            validate_sha256(
                revocation.package_digest.as_deref().ok_or_else(|| {
                    anyhow!("Plugin-release revocation is missing its package digest")
                })?,
                "revoked package digest",
            )?;
            if revocation.key_id.is_some() {
                return Err(anyhow!(
                    "Plugin-release revocation has a publisher key field"
                ));
            }
        }
    }
    Ok(())
}

fn revocation_identity(revocation: &RegistryRevocation) -> String {
    match revocation.kind {
        RegistryRevocationKind::PublisherKey => format!(
            "publisher-key\0{}\0{}",
            revocation.publisher,
            revocation.key_id.as_deref().unwrap_or_default()
        ),
        RegistryRevocationKind::PluginRelease => format!(
            "plugin-release\0{}\0{}\0{}",
            revocation.plugin_id.as_deref().unwrap_or_default(),
            revocation.version.as_deref().unwrap_or_default(),
            revocation.package_digest.as_deref().unwrap_or_default()
        ),
    }
}

fn merge_revocations(
    previous: &[RegistryRevocation],
    current: &[RegistryRevocation],
) -> Result<Vec<RegistryRevocation>> {
    let mut merged = Vec::with_capacity(previous.len() + current.len());
    let mut seen = HashSet::new();
    for revocation in previous.iter().chain(current) {
        if seen.insert(revocation_identity(revocation)) {
            merged.push(revocation.clone());
        }
    }
    if merged.len() > MAX_REGISTRY_REVOCATIONS {
        return Err(anyhow!(
            "Plugin marketplace contains too many retained revocations"
        ));
    }
    Ok(merged)
}

pub fn package_revocation_reason(
    app: &AppHandle,
    minimum_registry_version: u64,
    publisher: &str,
    plugin_id: &str,
    version: &str,
    package_digest: &str,
    publisher_key_id: Option<&str>,
) -> Result<Option<String>> {
    let state = read_state(
        &app.path()
            .app_config_dir()?
            .join("plugin-registry-state.json"),
    )?;
    if state.highest_version < minimum_registry_version {
        return Err(anyhow!(
            "Marketplace trust state is missing or older than this plugin approval"
        ));
    }
    for revocation in state.revocations {
        let matches = match revocation.kind {
            RegistryRevocationKind::PublisherKey => {
                revocation.publisher == publisher
                    && publisher_key_id
                        .is_some_and(|key_id| revocation.key_id.as_deref() == Some(key_id))
            }
            RegistryRevocationKind::PluginRelease => {
                revocation.publisher == publisher
                    && revocation.plugin_id.as_deref() == Some(plugin_id)
                    && revocation.version.as_deref() == Some(version)
                    && revocation.package_digest.as_deref() == Some(package_digest)
            }
        };
        if matches {
            return Ok(Some(revocation.reason));
        }
    }
    Ok(None)
}

fn validate_plugin(plugin: &TrustedRegistryPlugin) -> Result<()> {
    if plugin.id.trim().is_empty()
        || plugin.name.trim().is_empty()
        || plugin.version.trim().is_empty()
        || plugin.publisher.trim().is_empty()
        || !plugin.id.starts_with(&format!("{}.", plugin.publisher))
    {
        return Err(anyhow!(
            "Plugin marketplace contains an invalid plugin identity"
        ));
    }
    let version = semver::Version::parse(&plugin.version)
        .context("Plugin marketplace release version must use semantic versioning")?;
    if version.pre.is_empty() != (plugin.channel == PluginReleaseChannel::Stable) {
        return Err(anyhow!("Plugin release channel does not match its version"));
    }
    if plugin.channel == PluginReleaseChannel::Beta
        && version.pre.as_str() != "beta"
        && !version.pre.as_str().starts_with("beta.")
    {
        return Err(anyhow!(
            "Beta plugin versions must use a beta prerelease suffix"
        ));
    }
    validate_https_url(&plugin.download_url, "plugin download")?;
    validate_sha256(&plugin.package_digest, "package digest")?;
    validate_sha256(&plugin.publisher_key_id, "publisher key id")?;
    let public_key = decode_public_key(&plugin.publisher_public_key, "publisher")?;
    if key_id(public_key.as_bytes()) != plugin.publisher_key_id {
        return Err(anyhow!(
            "Plugin publisher key id does not match its public key"
        ));
    }
    Ok(())
}

fn validate_https_url(value: &str, label: &str) -> Result<url::Url> {
    let url = url::Url::parse(value).with_context(|| format!("Invalid {label} URL"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(anyhow!(
            "{label} URL must use HTTPS without credentials or fragments"
        ));
    }
    Ok(url)
}

fn decode_public_key(value: &str, label: &str) -> Result<VerifyingKey> {
    let bytes = STANDARD
        .decode(value)
        .with_context(|| format!("Plugin {label} public key is not valid base64"))?;
    let array: [u8; 32] = bytes
        .try_into()
        .map_err(|_| anyhow!("Plugin {label} public key must be 32 bytes"))?;
    VerifyingKey::from_bytes(&array)
        .with_context(|| format!("Plugin {label} public key is invalid"))
}

fn validate_sha256(value: &str, label: &str) -> Result<()> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(anyhow!("Plugin marketplace {label} must use sha256"));
    };
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(anyhow!("Plugin marketplace {label} is invalid"));
    }
    Ok(())
}

fn key_id(public_key: &[u8]) -> String {
    let encoded = Sha256::digest(public_key)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("sha256:{encoded}")
}

fn canonical_json(value: &Value) -> Result<String> {
    match value {
        Value::Null => Ok("null".into()),
        Value::Bool(value) => Ok(value.to_string()),
        Value::Number(value) => Ok(value.to_string()),
        Value::String(value) => serde_json::to_string(value).map_err(Into::into),
        Value::Array(values) => Ok(format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Result<Vec<_>>>()?
                .join(",")
        )),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            let entries = keys
                .into_iter()
                .map(|key| {
                    Ok(format!(
                        "{}:{}",
                        serde_json::to_string(key)?,
                        canonical_json(&values[key])?
                    ))
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(format!("{{{}}}", entries.join(",")))
        }
    }
}

fn read_state(path: &Path) -> Result<RegistryState> {
    let backup = path.with_extension("backup.json");
    let mut highest_version: Option<u64> = None;
    let mut revocations = Vec::new();
    let mut first_error = None;
    for candidate in [path, backup.as_path()] {
        if !candidate.exists() {
            continue;
        }
        match read_state_file(candidate) {
            Ok(state) => {
                highest_version = Some(
                    highest_version
                        .unwrap_or_default()
                        .max(state.highest_version),
                );
                revocations = merge_revocations(&revocations, &state.revocations)?;
            }
            Err(error) if first_error.is_none() => first_error = Some(error),
            Err(_) => {}
        }
    }
    if let Some(highest_version) = highest_version {
        return Ok(RegistryState {
            highest_version,
            revocations,
        });
    }
    if let Some(error) = first_error {
        return Err(error);
    }
    Ok(RegistryState::default())
}

fn read_state_file(path: &Path) -> Result<RegistryState> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_REGISTRY_STATE_BYTES
    {
        return Err(anyhow!("Plugin marketplace state is invalid"));
    }
    let state: RegistryState =
        serde_json::from_slice(&fs::read(path)?).context("Plugin marketplace state is invalid")?;
    validate_state_shape(&state)?;
    Ok(state)
}

fn write_state(path: &Path, state: &RegistryState) -> Result<()> {
    validate_state_shape(state)?;
    let bytes = serde_json::to_vec(state)?;
    if bytes.len() as u64 > MAX_REGISTRY_STATE_BYTES {
        return Err(anyhow!(
            "Plugin marketplace state exceeds its retention limit"
        ));
    }
    let backup = path.with_extension("backup.json");
    // Keep a durable recovery copy: read_state accepts either file and retains
    // the highest verified version and every revocation after an interrupted write.
    crate::atomic_io::durable_replace(&backup, &bytes)
        .context("Failed to save plugin marketplace state backup")?;
    crate::atomic_io::durable_replace(path, &bytes)
        .context("Failed to save plugin marketplace state")?;
    Ok(())
}

fn validate_state_shape(state: &RegistryState) -> Result<()> {
    if state.revocations.len() > MAX_REGISTRY_REVOCATIONS
        || state.revocations.iter().any(|revocation| {
            serde_json::to_vec(revocation)
                .map(|bytes| bytes.len() > MAX_SERIALIZED_REVOCATION_BYTES)
                .unwrap_or(true)
        })
    {
        return Err(anyhow!("Plugin marketplace state is invalid"));
    }
    Ok(())
}

fn now_ms() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("System clock is before the Unix epoch")?
        .as_millis()
        .try_into()
        .map_err(|_| anyhow!("System clock is out of range"))?)
}

#[cfg(test)]
mod tests;
