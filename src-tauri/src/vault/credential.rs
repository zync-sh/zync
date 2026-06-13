//! Typed credential model + compatibility helpers for vault record storage.
//!
//! Vault records store named secret values beside a typed credential envelope.
//! The legacy single `secret` field is accepted only as a migration/input
//! compatibility shape and is cleared whenever a record is normalized.

#![allow(dead_code)]

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

use super::types::PlaintextRecord;

pub const CURRENT_CREDENTIAL_SCHEMA_VERSION: u32 = 2;
pub const PRIVATE_KEY_FIELD: &str = "privateKey";
pub const PASSPHRASE_FIELD: &str = "passphrase";
pub const PASSWORD_FIELD: &str = "password";
pub const TOKEN_FIELD: &str = "token";
pub const SECRET_FIELD: &str = "secret";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CredentialKind {
    SshPrivateKey,
    SshPassword,
    SshKeyWithPassphrase,
    SshCertificate,
    UsernamePassword,
    ApiToken,
    SecretText,
    Certificate,
    CertificateKeyPair,
    CertificateChain,
    GitCredential,
    JenkinsCredential,
    ContainerRegistryCredential,
    CloudProviderCredential,
    ExternalKeychainReference,
    PluginDefined,
    GenericSecret,
}

impl CredentialKind {
    pub fn from_legacy_kind(kind: &str) -> Self {
        match kind {
            "ssh-private-key" | "ssh-key-with-passphrase" => Self::SshPrivateKey,
            "ssh-password" => Self::SshPassword,
            "ssh-agent-key" => Self::ExternalKeychainReference,
            "ssh-certificate" => Self::SshCertificate,
            "api-token" | "api-key" => Self::ApiToken,
            "secret-text" | "secure-note" => Self::SecretText,
            "username-password" => Self::UsernamePassword,
            "certificate" => Self::Certificate,
            "certificate-key-pair" => Self::CertificateKeyPair,
            "certificate-chain" => Self::CertificateChain,
            "jenkins-credential" => Self::JenkinsCredential,
            "git-credential" => Self::GitCredential,
            "container-registry-credential" => Self::ContainerRegistryCredential,
            "cloud-provider-credential" => Self::CloudProviderCredential,
            "external-keychain-reference" => Self::ExternalKeychainReference,
            "plugin-defined" => Self::PluginDefined,
            _ => Self::GenericSecret,
        }
    }
}

impl CredentialKind {
    pub fn canonical_storage_kind(&self) -> &'static str {
        match self {
            Self::SshPrivateKey | Self::SshKeyWithPassphrase => "ssh-private-key",
            Self::SshPassword => "ssh-password",
            Self::SshCertificate => "ssh-certificate",
            Self::UsernamePassword => "username-password",
            Self::ApiToken => "api-token",
            Self::SecretText => "secret-text",
            Self::Certificate => "certificate",
            Self::CertificateKeyPair => "certificate-key-pair",
            Self::CertificateChain => "certificate-chain",
            Self::GitCredential => "git-credential",
            Self::JenkinsCredential => "jenkins-credential",
            Self::ContainerRegistryCredential => "container-registry-credential",
            Self::CloudProviderCredential => "cloud-provider-credential",
            Self::ExternalKeychainReference => "external-keychain-reference",
            Self::PluginDefined => "plugin-defined",
            Self::GenericSecret => "generic-secret",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CredentialFieldFormat {
    Text,
    Username,
    Password,
    PrivateKey,
    Certificate,
    Token,
    Url,
    Json,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CredentialFieldEncoding {
    Plain,
    Pem,
    Base64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialField {
    pub name: String,
    pub label: String,
    pub secret: bool,
    #[serde(default)]
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<CredentialFieldFormat>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoding: Option<CredentialFieldEncoding>,
}

impl Zeroize for CredentialField {
    fn zeroize(&mut self) {
        self.name.zeroize();
        self.label.zeroize();
        self.format = None;
        self.value.zeroize();
        self.value_ref.zeroize();
        self.encoding = None;
        self.required = false;
        self.secret = false;
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_ref_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

impl Zeroize for CredentialMetadata {
    fn zeroize(&mut self) {
        self.service.zeroize();
        self.url.zeroize();
        self.username.zeroize();
        self.plugin_id.zeroize();
        self.external_ref_kind.zeroize();
        self.external_ref.zeroize();
        self.schema_name.zeroize();
        self.schema_version.zeroize();
        self.legacy_kind.zeroize();
        self.notes.zeroize();
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialEnvelope {
    pub credential_id: String,
    pub kind: CredentialKind,
    pub label: String,
    pub fields: Vec<CredentialField>,
    pub metadata: CredentialMetadata,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub revision: u64,
    pub schema_version: u32,
}

impl Zeroize for CredentialEnvelope {
    fn zeroize(&mut self) {
        self.credential_id.zeroize();
        self.label.zeroize();
        for field in &mut self.fields {
            field.zeroize();
        }
        self.fields.clear();
        self.metadata.zeroize();
        for tag in &mut self.tags {
            tag.zeroize();
        }
        self.tags.clear();
        self.created_at.zeroize();
        self.updated_at.zeroize();
        self.revision.zeroize();
        self.schema_version.zeroize();
    }
}

impl ZeroizeOnDrop for CredentialEnvelope {}

pub fn secret_values_from_legacy(kind: &str, secret: &str) -> BTreeMap<String, String> {
    let mut values = BTreeMap::new();
    if secret.is_empty() {
        return values;
    }

    let normalized_kind = CredentialKind::from_legacy_kind(kind);
    if normalized_kind == CredentialKind::SshPrivateKey {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(secret) {
            if let Some(key) = value.get("key").and_then(serde_json::Value::as_str) {
                values.insert(PRIVATE_KEY_FIELD.to_string(), key.to_string());
                if let Some(passphrase) = value
                    .get(PASSPHRASE_FIELD)
                    .and_then(serde_json::Value::as_str)
                    .filter(|value| !value.is_empty())
                {
                    values.insert(PASSPHRASE_FIELD.to_string(), passphrase.to_string());
                }
                return values;
            }
        }
    }

    values.insert(primary_secret_field_name(&normalized_kind).to_string(), secret.to_string());
    values
}

pub fn primary_secret_field_name(kind: &CredentialKind) -> &'static str {
    match kind {
        CredentialKind::SshPrivateKey | CredentialKind::SshKeyWithPassphrase => PRIVATE_KEY_FIELD,
        CredentialKind::SshPassword | CredentialKind::UsernamePassword => PASSWORD_FIELD,
        CredentialKind::ApiToken => TOKEN_FIELD,
        _ => SECRET_FIELD,
    }
}

pub fn validate_secret_values_for_kind(
    kind: &str,
    secret_values: &BTreeMap<String, String>,
) -> Result<(), String> {
    let normalized_kind = CredentialKind::from_legacy_kind(kind);
    let required_field = primary_secret_field_name(&normalized_kind);
    let required_present = secret_values
        .get(required_field)
        .is_some_and(|value| !value.trim().is_empty());
    if required_present {
        return Ok(());
    }

    Err(format!(
        "credential kind '{kind}' requires a non-empty '{required_field}' value"
    ))
}

pub fn primary_secret_value(record: &PlaintextRecord) -> Option<&str> {
    let kind = CredentialKind::from_legacy_kind(&record.kind);
    record
        .secret_values
        .get(primary_secret_field_name(&kind))
        .or_else(|| record.secret_values.values().next())
        .map(String::as_str)
        .or_else(|| (!record.secret.is_empty()).then_some(record.secret.as_str()))
}

pub fn private_key_auth_values(record: &PlaintextRecord) -> Option<(&str, Option<&str>)> {
    let key = record
        .secret_values
        .get(PRIVATE_KEY_FIELD)
        .map(String::as_str)
        .filter(|value| !value.is_empty())
        .or_else(|| (!record.secret.is_empty()).then_some(record.secret.as_str()))?;
    let passphrase = record
        .secret_values
        .get(PASSPHRASE_FIELD)
        .map(String::as_str)
        .filter(|value| !value.is_empty());
    Some((key, passphrase))
}

pub fn normalize_record_credential(record: &mut PlaintextRecord) {
    let original_kind = record.kind.clone();
    let normalized_kind = CredentialKind::from_legacy_kind(&original_kind);
    let had_typed_credential = record.credential.is_some();
    let mut credential = record
        .credential
        .take()
        .unwrap_or_else(|| legacy_record_to_credential(record));

    credential.credential_id = record
        .logical_id
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| record.id.clone());
    if !had_typed_credential {
        credential.kind = normalized_kind.clone();
    }
    let effective_kind = credential.kind.clone();
    record.kind = effective_kind.canonical_storage_kind().to_string();
    if record.secret_values.is_empty() {
        record.secret_values = secret_values_from_legacy(&record.kind, &record.secret);
    }
    remap_single_legacy_secret_to_typed_field(&mut record.secret_values, &credential.fields);
    extract_inline_secret_values(&mut record.secret_values, &credential.fields);
    record.secret.clear();

    credential.label = record.label.clone();
    credential.created_at = record.created_at;
    credential.updated_at = record.updated_at;
    credential.revision = record.revision;
    credential.schema_version = CURRENT_CREDENTIAL_SCHEMA_VERSION;
    if credential.metadata.legacy_kind.is_none() {
        credential.metadata.legacy_kind = Some(original_kind);
    }

    if credential.metadata.notes.is_none() {
        credential.metadata.notes = record.notes.clone();
    }

    credential.fields = normalized_fields(
        &effective_kind,
        std::mem::take(&mut credential.fields),
        &record.secret_values,
    );

    record.credential = Some(credential);
}

pub fn legacy_record_to_credential(record: &PlaintextRecord) -> CredentialEnvelope {
    let kind = CredentialKind::from_legacy_kind(&record.kind);
    let credential_id = record
        .logical_id
        .clone()
        .unwrap_or_else(|| record.id.clone());

    CredentialEnvelope {
        credential_id,
        kind: kind.clone(),
        label: record.label.clone(),
        fields: canonical_fields(&kind, &record.secret_values),
        metadata: CredentialMetadata {
            legacy_kind: Some(record.kind.clone()),
            notes: record.notes.clone(),
            ..CredentialMetadata::default()
        },
        tags: Vec::new(),
        created_at: record.created_at,
        updated_at: record.updated_at,
        revision: record.revision,
        schema_version: CURRENT_CREDENTIAL_SCHEMA_VERSION,
    }
}

fn secret_field(
    name: &str,
    label: &str,
    required: bool,
    format: CredentialFieldFormat,
    encoding: Option<CredentialFieldEncoding>,
) -> CredentialField {
    CredentialField {
        name: name.to_string(),
        label: label.to_string(),
        secret: true,
        required,
        format: Some(format),
        value: None,
        value_ref: Some(format!("secret:{name}")),
        encoding,
    }
}

fn canonical_fields(
    kind: &CredentialKind,
    secret_values: &BTreeMap<String, String>,
) -> Vec<CredentialField> {
    match kind {
        CredentialKind::SshPrivateKey | CredentialKind::SshKeyWithPassphrase => {
            let mut fields = vec![secret_field(
                PRIVATE_KEY_FIELD,
                "Private Key",
                true,
                CredentialFieldFormat::PrivateKey,
                Some(CredentialFieldEncoding::Pem),
            )];
            if secret_values.contains_key(PASSPHRASE_FIELD) {
                fields.push(secret_field(
                    PASSPHRASE_FIELD,
                    "Passphrase",
                    false,
                    CredentialFieldFormat::Password,
                    None,
                ));
            }
            fields
        }
        CredentialKind::SshPassword | CredentialKind::UsernamePassword => vec![secret_field(
            PASSWORD_FIELD,
            "Password",
            true,
            CredentialFieldFormat::Password,
            None,
        )],
        CredentialKind::ApiToken => vec![secret_field(
            TOKEN_FIELD,
            "Token",
            true,
            CredentialFieldFormat::Token,
            None,
        )],
        _ => vec![secret_field(
            SECRET_FIELD,
            "Secret",
            true,
            CredentialFieldFormat::Text,
            None,
        )],
    }
}

fn normalized_fields(
    kind: &CredentialKind,
    mut existing_fields: Vec<CredentialField>,
    secret_values: &BTreeMap<String, String>,
) -> Vec<CredentialField> {
    if matches!(
        kind,
        CredentialKind::SshPrivateKey
            | CredentialKind::SshKeyWithPassphrase
            | CredentialKind::SshPassword
            | CredentialKind::UsernamePassword
            | CredentialKind::ApiToken
    ) {
        return canonical_fields(kind, secret_values);
    }

    if existing_fields.is_empty() {
        return canonical_fields(kind, secret_values);
    }

    for field in &mut existing_fields {
        if field.secret {
            field.value = None;
            field.value_ref = Some(format!("secret:{}", field.name));
        }
    }
    existing_fields
}

fn extract_inline_secret_values(
    secret_values: &mut BTreeMap<String, String>,
    fields: &[CredentialField],
) {
    for field in fields.iter().filter(|field| field.secret) {
        let Some(value) = field.value.as_ref() else {
            continue;
        };
        if value.is_empty() {
            continue;
        }
        secret_values
            .entry(field.name.clone())
            .or_insert_with(|| value.clone());
    }
}

fn remap_single_legacy_secret_to_typed_field(
    secret_values: &mut BTreeMap<String, String>,
    fields: &[CredentialField],
) {
    let secret_field_names: Vec<&str> = fields
        .iter()
        .filter(|field| field.secret)
        .map(|field| field.name.as_str())
        .collect();
    if secret_field_names.len() != 1 || secret_values.len() != 1 {
        return;
    }
    let desired_name = secret_field_names[0];
    if secret_values.contains_key(desired_name) {
        return;
    }
    if let Some(existing_name) = secret_values.keys().next().cloned() {
        if let Some(value) = secret_values.remove(&existing_name) {
            secret_values.insert(desired_name.to_string(), value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn legacy_record(kind: &str) -> PlaintextRecord {
        PlaintextRecord {
            id: "item-1".to_string(),
            logical_id: Some("cred-1".to_string()),
            kind: kind.to_string(),
            label: "Prod credential".to_string(),
            secret: "not-copied-to-envelope".to_string(),
            secret_values: BTreeMap::new(),
            notes: Some("owned by ops".to_string()),
            credential: None,
            revision: 7,
            created_at: 10,
            updated_at: 20,
        }
    }

    #[test]
    fn legacy_private_key_maps_to_typed_secret_ref_without_plaintext() {
        let record = legacy_record("ssh-private-key");

        let credential = legacy_record_to_credential(&record);

        assert_eq!(credential.credential_id, "cred-1");
        assert_eq!(credential.kind, CredentialKind::SshPrivateKey);
        assert_eq!(credential.fields.len(), 1);
        assert_eq!(credential.fields[0].name, "privateKey");
        assert_eq!(credential.fields[0].format, Some(CredentialFieldFormat::PrivateKey));
        assert_eq!(credential.fields[0].encoding, Some(CredentialFieldEncoding::Pem));
        assert_eq!(
            credential.fields[0].value_ref.as_deref(),
            Some("secret:privateKey")
        );
        assert_eq!(credential.fields[0].value, None);
        assert_eq!(credential.metadata.notes.as_deref(), Some("owned by ops"));
    }

    #[test]
    fn legacy_record_without_logical_id_uses_physical_id_for_compatibility() {
        let mut record = legacy_record("ssh-password");
        record.logical_id = None;

        let credential = legacy_record_to_credential(&record);

        assert_eq!(credential.credential_id, "item-1");
        assert_eq!(credential.kind, CredentialKind::SshPassword);
        assert_eq!(credential.fields[0].name, "password");
    }

    #[test]
    fn unknown_legacy_kind_preserves_kind_in_metadata() {
        let record = legacy_record("legacy-custom-secret");

        let credential = legacy_record_to_credential(&record);

        assert_eq!(credential.kind, CredentialKind::GenericSecret);
        assert_eq!(
            credential.metadata.legacy_kind.as_deref(),
            Some("legacy-custom-secret")
        );
    }

    #[test]
    fn normalize_record_credential_builds_and_stabilizes_envelope() {
        let mut record = legacy_record("ssh-password");
        normalize_record_credential(&mut record);

        let credential = record
            .credential
            .as_ref()
            .expect("credential envelope");
        assert_eq!(credential.credential_id, "cred-1");
        assert_eq!(credential.kind, CredentialKind::SshPassword);
        assert_eq!(credential.label, "Prod credential");
        assert_eq!(credential.revision, 7);
        assert_eq!(
            credential.fields[0].value_ref.as_deref(),
            Some("secret:password")
        );
        assert_eq!(credential.fields[0].value, None);
    }

    #[test]
    fn normalize_record_credential_preserves_existing_typed_kind() {
        let mut record = legacy_record("ssh-password");
        let mut typed = legacy_record_to_credential(&record);
        typed.kind = CredentialKind::UsernamePassword;
        record.credential = Some(typed);

        normalize_record_credential(&mut record);

        assert_eq!(
            record.credential.as_ref().map(|credential| &credential.kind),
            Some(&CredentialKind::UsernamePassword)
        );
        assert_eq!(record.kind, "username-password");
    }

    #[test]
    fn normalize_record_credential_preserves_original_legacy_kind_metadata() {
        let mut record = legacy_record("ssh-password");
        let mut typed = legacy_record_to_credential(&record);
        typed.metadata.legacy_kind = Some("original-custom-kind".into());
        record.credential = Some(typed);

        normalize_record_credential(&mut record);

        assert_eq!(
            record
                .credential
                .as_ref()
                .and_then(|credential| credential.metadata.legacy_kind.as_deref()),
            Some("original-custom-kind")
        );
    }

    #[test]
    fn normalize_preserves_plugin_defined_field_schema_and_remaps_single_secret() {
        let mut record = legacy_record("legacy-custom-secret");
        let mut typed = legacy_record_to_credential(&record);
        typed.kind = CredentialKind::PluginDefined;
        typed.fields = vec![CredentialField {
            name: "clientSecret".to_string(),
            label: "Client Secret".to_string(),
            secret: true,
            required: true,
            format: Some(CredentialFieldFormat::Password),
            value: Some("must-not-survive".to_string()),
            value_ref: Some("legacy:item-1:secret".to_string()),
            encoding: None,
        }];
        record.credential = Some(typed);

        normalize_record_credential(&mut record);

        assert_eq!(record.kind, "plugin-defined");
        assert_eq!(
            record.secret_values.get("clientSecret").map(String::as_str),
            Some("not-copied-to-envelope")
        );
        let field = &record.credential.as_ref().expect("credential").fields[0];
        assert_eq!(field.name, "clientSecret");
        assert_eq!(field.value, None);
        assert_eq!(field.value_ref.as_deref(), Some("secret:clientSecret"));
    }

    #[test]
    fn normalize_extracts_inline_typed_secrets_before_clearing_fields() {
        let mut record = legacy_record("plugin-defined");
        record.secret.clear();
        record.credential = Some(CredentialEnvelope {
            credential_id: "cred-1".into(),
            kind: CredentialKind::PluginDefined,
            label: "Plugin credential".into(),
            fields: vec![CredentialField {
                name: "clientSecret".into(),
                label: "Client Secret".into(),
                secret: true,
                required: true,
                format: Some(CredentialFieldFormat::Password),
                value: Some("inline-secret".into()),
                value_ref: None,
                encoding: None,
            }],
            metadata: CredentialMetadata::default(),
            tags: Vec::new(),
            revision: 1,
            created_at: 1,
            updated_at: 1,
            schema_version: CURRENT_CREDENTIAL_SCHEMA_VERSION,
        });

        normalize_record_credential(&mut record);

        assert_eq!(
            record.secret_values.get("clientSecret").map(String::as_str),
            Some("inline-secret")
        );
        let field = &record.credential.as_ref().expect("credential").fields[0];
        assert_eq!(field.value, None);
        assert_eq!(field.value_ref.as_deref(), Some("secret:clientSecret"));
    }

    #[test]
    fn normalize_keeps_named_secret_over_duplicate_inline_value() {
        let mut record = legacy_record("plugin-defined");
        record.secret.clear();
        record
            .secret_values
            .insert("clientSecret".into(), "named-secret".into());
        record.credential = Some(CredentialEnvelope {
            credential_id: "cred-1".into(),
            kind: CredentialKind::PluginDefined,
            label: "Plugin credential".into(),
            fields: vec![CredentialField {
                name: "clientSecret".into(),
                label: "Client Secret".into(),
                secret: true,
                required: true,
                format: Some(CredentialFieldFormat::Password),
                value: Some("stale-inline-secret".into()),
                value_ref: None,
                encoding: None,
            }],
            metadata: CredentialMetadata::default(),
            tags: Vec::new(),
            revision: 1,
            created_at: 1,
            updated_at: 1,
            schema_version: CURRENT_CREDENTIAL_SCHEMA_VERSION,
        });

        normalize_record_credential(&mut record);

        assert_eq!(
            record.secret_values.get("clientSecret").map(String::as_str),
            Some("named-secret")
        );
    }

    #[test]
    fn normalize_private_key_json_migrates_named_secret_values_and_canonical_kind() {
        let mut record = legacy_record("ssh-key-with-passphrase");
        record.secret = serde_json::json!({
            "key": "private-key-data",
            "passphrase": "key-passphrase"
        })
        .to_string();

        normalize_record_credential(&mut record);

        assert_eq!(record.kind, "ssh-private-key");
        assert!(record.secret.is_empty());
        assert_eq!(
            record.secret_values.get(PRIVATE_KEY_FIELD).map(String::as_str),
            Some("private-key-data")
        );
        assert_eq!(
            record.secret_values.get(PASSPHRASE_FIELD).map(String::as_str),
            Some("key-passphrase")
        );
        let fields = &record.credential.as_ref().expect("credential").fields;
        assert_eq!(fields.len(), 2);
        assert_eq!(fields[1].value_ref.as_deref(), Some("secret:passphrase"));
    }

    #[test]
    fn private_key_auth_values_resolves_named_key_and_optional_passphrase() {
        let mut record = legacy_record("ssh-private-key");
        record.secret.clear();
        record.secret_values = BTreeMap::from([
            (PRIVATE_KEY_FIELD.to_string(), "private-key-data".to_string()),
            (PASSPHRASE_FIELD.to_string(), "key-passphrase".to_string()),
        ]);
        normalize_record_credential(&mut record);

        assert_eq!(
            private_key_auth_values(&record),
            Some(("private-key-data", Some("key-passphrase")))
        );
    }
}
