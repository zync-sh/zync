use super::Manifest;
use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::Path;

const INTEGRITY_FILE: &str = "integrity.json";
const SIGNATURE_FILE: &str = "signature.json";
const MAX_METADATA_BYTES: u64 = 512 * 1024;
const MAX_SIGNED_FILE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_SIGNED_FILES: usize = 2_048;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageSignatureStatus {
    pub publisher: String,
    pub key_id: String,
    pub published_at_ms: u64,
    pub integrity_root: String,
    pub verified: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IntegrityManifest {
    version: u32,
    files: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackageSignature {
    version: u32,
    algorithm: String,
    publisher: String,
    plugin_id: String,
    plugin_version: String,
    key_id: String,
    public_key: String,
    published_at_ms: u64,
    manifest_digest: String,
    integrity_root: String,
    signature: String,
}

/// Local development packages may be unsigned. Once either metadata file exists, the package
/// must be complete and cryptographically valid; callers decide whether unsigned is allowed.
pub fn verify_package_signature(
    package_root: &Path,
    manifest: &Manifest,
) -> Result<Option<PackageSignatureStatus>> {
    let integrity_path = package_root.join(INTEGRITY_FILE);
    let signature_path = package_root.join(SIGNATURE_FILE);
    match (integrity_path.exists(), signature_path.exists()) {
        (false, false) => return Ok(None),
        (true, false) | (false, true) => {
            return Err(anyhow!(
                "Signed plugin packages must contain both integrity.json and signature.json"
            ))
        }
        (true, true) => {}
    }

    let integrity: IntegrityManifest = read_bounded_json(&integrity_path, INTEGRITY_FILE)?;
    if integrity.version != 1 {
        return Err(anyhow!("Unsupported plugin integrity format"));
    }
    if integrity.files.is_empty() || integrity.files.len() > MAX_SIGNED_FILES {
        return Err(anyhow!("Plugin integrity file list is empty or too large"));
    }

    let actual_files = collect_payload_files(package_root)?;
    let declared_files = integrity.files.keys().cloned().collect::<BTreeSet<_>>();
    if actual_files != declared_files {
        return Err(anyhow!(
            "Plugin package contents do not match its integrity manifest"
        ));
    }

    for (relative_path, expected_digest) in &integrity.files {
        validate_relative_path(relative_path)?;
        validate_sha256(expected_digest, "integrity digest")?;
        if digest_file(&package_root.join(relative_path))? != *expected_digest {
            return Err(anyhow!(
                "Plugin file failed integrity verification: {relative_path}"
            ));
        }
    }

    let manifest_digest = integrity
        .files
        .get("manifest.json")
        .ok_or_else(|| anyhow!("Plugin integrity manifest must include manifest.json"))?;
    let integrity_root = calculate_integrity_root(&integrity.files);
    let signed: PackageSignature = read_bounded_json(&signature_path, SIGNATURE_FILE)?;
    validate_signature_metadata(&signed, manifest, manifest_digest, &integrity_root)?;

    let public_key_bytes = STANDARD
        .decode(&signed.public_key)
        .context("Plugin publisher public key is not valid base64")?;
    let public_key_array: [u8; 32] = public_key_bytes
        .try_into()
        .map_err(|_| anyhow!("Plugin publisher public key must be 32 bytes"))?;
    let verifying_key = VerifyingKey::from_bytes(&public_key_array)
        .context("Plugin publisher public key is invalid")?;
    if signed.key_id != calculate_key_id(verifying_key.as_bytes()) {
        return Err(anyhow!(
            "Plugin publisher key id does not match its public key"
        ));
    }

    let signature_bytes = STANDARD
        .decode(&signed.signature)
        .context("Plugin signature is not valid base64")?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| anyhow!("Plugin signature must be 64 bytes"))?;
    verifying_key
        .verify(signing_payload(&signed).as_bytes(), &signature)
        .map_err(|_| anyhow!("Plugin publisher signature is invalid"))?;

    Ok(Some(PackageSignatureStatus {
        publisher: signed.publisher,
        key_id: signed.key_id,
        published_at_ms: signed.published_at_ms,
        integrity_root,
        verified: true,
    }))
}

fn validate_signature_metadata(
    signed: &PackageSignature,
    manifest: &Manifest,
    manifest_digest: &str,
    integrity_root: &str,
) -> Result<()> {
    if signed.version != 1 || signed.algorithm != "ed25519" {
        return Err(anyhow!("Unsupported plugin signature format"));
    }
    let publisher = manifest
        .extensions
        .publisher
        .as_deref()
        .ok_or_else(|| anyhow!("Signed plugins require a manifest publisher"))?;
    if signed.publisher != publisher
        || signed.plugin_id != manifest.id
        || signed.plugin_version != manifest.version
    {
        return Err(anyhow!(
            "Plugin signature identity does not match its manifest"
        ));
    }
    if signed.manifest_digest != manifest_digest || signed.integrity_root != integrity_root {
        return Err(anyhow!(
            "Plugin signature does not match its integrity manifest"
        ));
    }
    if signed.published_at_ms == 0 {
        return Err(anyhow!("Plugin signature is missing its release timestamp"));
    }
    validate_sha256(&signed.key_id, "publisher key id")
}

fn signing_payload(signature: &PackageSignature) -> String {
    format!(
        "zync-plugin-signature-v1\npublisher={}\npluginId={}\nversion={}\nmanifestDigest={}\nintegrityRoot={}\npublishedAtMs={}\n",
        signature.publisher,
        signature.plugin_id,
        signature.plugin_version,
        signature.manifest_digest,
        signature.integrity_root,
        signature.published_at_ms,
    )
}

fn calculate_integrity_root(files: &BTreeMap<String, String>) -> String {
    let mut digest = Sha256::new();
    digest.update(b"zync-plugin-integrity-v1\n");
    for (path, file_digest) in files {
        digest.update(path.as_bytes());
        digest.update(b"\0");
        digest.update(file_digest.as_bytes());
        digest.update(b"\n");
    }
    format_sha256(&digest.finalize())
}

fn calculate_key_id(public_key: &[u8]) -> String {
    format_sha256(&Sha256::digest(public_key))
}

fn digest_file(path: &Path) -> Result<String> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("Plugin package is missing {}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(anyhow!("Plugin payload must contain only regular files"));
    }
    if metadata.len() > MAX_SIGNED_FILE_BYTES {
        return Err(anyhow!("Signed plugin file exceeds 20 MiB"));
    }
    let mut file = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let copied = std::io::copy(
        &mut (&mut file).take(MAX_SIGNED_FILE_BYTES + 1),
        &mut DigestWriter(&mut digest),
    )?;
    if copied != metadata.len() {
        return Err(anyhow!("Plugin file changed during integrity verification"));
    }
    Ok(format_sha256(&digest.finalize()))
}

fn collect_payload_files(root: &Path) -> Result<BTreeSet<String>> {
    let canonical_root = fs::canonicalize(root)?;
    let mut files = BTreeSet::new();
    collect_payload_files_inner(&canonical_root, &canonical_root, &mut files)?;
    if files.len() > MAX_SIGNED_FILES {
        return Err(anyhow!("Signed plugin contains too many files"));
    }
    Ok(files)
}

fn collect_payload_files_inner(
    root: &Path,
    current: &Path,
    files: &mut BTreeSet<String>,
) -> Result<()> {
    for entry in fs::read_dir(current)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let path = entry.path();
        if file_type.is_symlink() || (!file_type.is_file() && !file_type.is_dir()) {
            return Err(anyhow!("Plugin package contains an unsupported file"));
        }
        if file_type.is_dir() {
            collect_payload_files_inner(root, &path, files)?;
            continue;
        }
        let relative = package_relative_path(root, &path)?;
        if relative != INTEGRITY_FILE && relative != SIGNATURE_FILE {
            files.insert(relative);
        }
    }
    Ok(())
}

fn package_relative_path(root: &Path, path: &Path) -> Result<String> {
    let relative = path
        .strip_prefix(root)?
        .to_str()
        .ok_or_else(|| anyhow!("Plugin package path is not valid UTF-8"))?
        .replace('\\', "/");
    validate_relative_path(&relative)?;
    Ok(relative)
}

fn validate_relative_path(path: &str) -> Result<()> {
    if path.is_empty() || path.starts_with('/') || path.contains('\\') || path.len() > 512 {
        return Err(anyhow!("Invalid integrity path: {path}"));
    }
    if path.split('/').any(|part| {
        part.is_empty()
            || part == "."
            || part == ".."
            || part.contains(':')
            || part.chars().any(char::is_control)
    }) {
        return Err(anyhow!("Invalid integrity path: {path}"));
    }
    Ok(())
}

fn validate_sha256(value: &str, label: &str) -> Result<()> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(anyhow!("Plugin {label} must use sha256"));
    };
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(anyhow!("Plugin {label} is invalid"));
    }
    Ok(())
}

fn read_bounded_json<T: for<'de> Deserialize<'de>>(path: &Path, label: &str) -> Result<T> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(anyhow!("Plugin {label} must be a regular file"));
    }
    if metadata.len() > MAX_METADATA_BYTES {
        return Err(anyhow!("Plugin {label} exceeds 512 KiB"));
    }
    serde_json::from_slice(&fs::read(path)?).with_context(|| format!("Plugin {label} is invalid"))
}

fn format_sha256(bytes: &[u8]) -> String {
    let encoded = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("sha256:{encoded}")
}

struct DigestWriter<'a>(&'a mut Sha256);

impl std::io::Write for DigestWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests;
