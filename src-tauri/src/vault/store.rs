use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine};
use rand_core::{OsRng, RngCore};
use redb::{Database, DatabaseError, ReadTransaction, ReadableTable};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

use crate::vault::credential::{
    normalize_record_credential, primary_secret_value, secret_values_from_legacy,
    validate_secret_values_for_kind, CredentialEnvelope, CURRENT_CREDENTIAL_SCHEMA_VERSION,
};
use crate::vault::crypto::{
    decrypt_record, derive_kek, derive_record_key, derive_secret_fingerprint, encrypt_record,
    generate_salt, generate_vek, EncryptedEnvelope, KdfParams, SecretKey,
};
use crate::vault::error::VaultError;
use crate::vault::schema::{
    KEY_SLOTS, LOGICAL_IDS, RECORDS, REVISION_HISTORY, SLOT_PASSPHRASE, SLOT_RECOVERY, VAULT_META,
};
use crate::vault::types::{
    PlaintextRecord, RevisionMeta, StoredEnvelope, VaultItemMeta, VaultMeta, VaultStatus,
};

const CRYPTO_SUITE: &str = "xchacha20poly1305-argon2id-v1";
const AAD_VERSION: u32 = 1;
const SCHEMA_VERSION: u32 = 1;
pub const PASSPHRASE_MIN_LENGTH: usize = 12;
const SESSION_CACHE_VERIFIER_META_KEY: &str = "session_cache_verifier";
const SESSION_CACHE_VERIFIER_RECORD_ID: &str = "__session_cache_verifier__";
const SESSION_CACHE_VERIFIER_REVISION: u64 = 1;
const SESSION_CACHE_VERIFIER_PLAINTEXT: &[u8] = b"zync-vault-session-verify-v1";

fn validate_secret_values(
    kind: &str,
    secret_values: &BTreeMap<String, String>,
) -> Result<(), VaultError> {
    validate_secret_values_for_kind(kind, secret_values).map_err(VaultError::InvalidData)
}

// ── Service ───────────────────────────────────────────────────────────────────

pub struct VaultService {
    db: Option<Database>,
    vek: Option<SecretKey>,
    /// Cached after initialize/unlock; cleared on lock.
    meta: Option<VaultMeta>,
    data_dir: PathBuf,
    /// When true, `status()` must not auto-restore unlock from the OS session cache.
    /// Set by explicit `lock()`; cleared by initialize/unlock/recovery unlock.
    suppress_session_cache_unlock: bool,
}

impl VaultService {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            db: None,
            vek: None,
            meta: None,
            data_dir,
            suppress_session_cache_unlock: false,
        }
    }

    fn vault_path(&self) -> PathBuf {
        self.data_dir.join("vault.redb")
    }

    fn map_database_open_error(err: DatabaseError) -> VaultError {
        match err {
            DatabaseError::DatabaseAlreadyOpen => VaultError::InUseByAnotherInstance,
            other => VaultError::from(other),
        }
    }

    /// Opens an existing vault.redb without unlocking. No-op if already open.
    /// Also ensures that tables added in later schema versions exist in
    /// already-deployed databases (forward-compatible migration).
    fn try_open(&mut self) -> Result<(), VaultError> {
        if self.db.is_some() {
            return Ok(());
        }
        let path = self.vault_path();
        if path.exists() {
            let db = Database::open(&path).map_err(Self::map_database_open_error)?;
            // Ensure tables introduced after the initial schema exist.
            // This is a no-op for new databases (initialize() already creates them)
            // and a safe migration for existing databases that predate these tables.
            let write_txn = db.begin_write()?;
            {
                // open_table / open_multimap_table creates the table if absent.
                write_txn.open_table(LOGICAL_IDS)?;
                write_txn.open_multimap_table(REVISION_HISTORY)?;
            }
            write_txn.commit()?;
            self.db = Some(db);
        }
        Ok(())
    }

    fn now_secs() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }

    // ── Status ────────────────────────────────────────────────────────────────

    pub fn status(&mut self) -> Result<VaultStatus, VaultError> {
        let _ = self.try_unlock_from_session_cache();
        self.status_after_session_attempt()
    }

    fn status_after_session_attempt(&mut self) -> Result<VaultStatus, VaultError> {
        self.try_open()?;

        let Some(db) = &self.db else {
            return Ok(VaultStatus::Uninitialized);
        };

        let read_txn = db.begin_read()?;
        let meta_table = match read_txn.open_table(VAULT_META) {
            Ok(t) => t,
            Err(redb::TableError::TableDoesNotExist(_)) => return Ok(VaultStatus::Uninitialized),
            Err(e) => return Err(VaultError::from(e)),
        };

        let vault_id = meta_table
            .get("vault_id")?
            .map(|v| String::from_utf8_lossy(v.value()).into_owned())
            .unwrap_or_default();

        if vault_id.is_empty() {
            return Ok(VaultStatus::Uninitialized);
        }

        let item_count = live_record_count(&read_txn)?;

        if self.vek.is_none() {
            return Ok(self.locked_status(vault_id, item_count));
        }

        Ok(VaultStatus::Unlocked {
            vault_id,
            item_count,
        })
    }

    fn locked_status(&self, vault_id: String, item_count: u64) -> VaultStatus {
        let remembered_on_device =
            super::session_cache::has_session_cache(&vault_id).unwrap_or(false);
        VaultStatus::Locked {
            vault_id,
            item_count,
            remembered_on_device,
        }
    }

    /// Restores an in-memory unlock from the OS keychain session cache when available.
    pub fn try_unlock_from_session_cache(&mut self) -> Result<bool, VaultError> {
        if self.suppress_session_cache_unlock {
            return Ok(false);
        }

        if self.vek.is_some() {
            return Ok(true);
        }

        self.try_open()?;
        let db = match self.db.as_ref() {
            Some(db) => db,
            None => return Ok(false),
        };

        let read_txn = db.begin_read()?;
        let vm = match read_txn.open_table(VAULT_META) {
            Ok(table) => table,
            Err(redb::TableError::TableDoesNotExist(_)) => return Ok(false),
            Err(error) => return Err(VaultError::from(error)),
        };

        let vault_id = vm
            .get("vault_id")?
            .map(|value| String::from_utf8_lossy(value.value()).into_owned())
            .unwrap_or_default();
        if vault_id.is_empty() {
            return Ok(false);
        }

        let meta_bytes = match vm.get("meta")? {
            Some(value) => value,
            None => return Ok(false),
        };
        let meta: VaultMeta = serde_json::from_slice(meta_bytes.value())?;

        let Some(cached) = super::session_cache::load_session_cache(&vault_id)? else {
            return Ok(false);
        };

        if verify_cached_vek(&cached.vek, &meta, &read_txn, cached.proof_verified).is_err() {
            let _ = super::session_cache::clear_session_cache(&vault_id);
            return Ok(false);
        }

        self.vek = Some(cached.vek);
        self.meta = Some(meta);

        if self.migrate_live_records_to_current_schema().is_err() {
            self.vek = None;
            self.meta = None;
            let _ = super::session_cache::clear_session_cache(&vault_id);
            return Ok(false);
        }

        Ok(true)
    }

    pub fn forget_device_session(&mut self) -> Result<(), VaultError> {
        self.try_open()?;
        let Some(db) = &self.db else {
            return Ok(());
        };

        let read_txn = db.begin_read()?;
        let meta_table = match read_txn.open_table(VAULT_META) {
            Ok(table) => table,
            Err(redb::TableError::TableDoesNotExist(_)) => return Ok(()),
            Err(error) => return Err(VaultError::from(error)),
        };

        let vault_id = meta_table
            .get("vault_id")?
            .map(|value| String::from_utf8_lossy(value.value()).into_owned())
            .unwrap_or_default();
        if vault_id.is_empty() {
            return Ok(());
        }

        super::session_cache::clear_session_cache(&vault_id)?;
        self.clear_session_cache_verifier()
    }

    fn persist_session_cache_preference(&self, remember_on_device: bool) -> Result<(), VaultError> {
        let meta = self.meta.as_ref().ok_or(VaultError::Locked)?;
        let vek = self.vek.as_ref().ok_or(VaultError::Locked)?;
        if remember_on_device {
            super::session_cache::save_session_cache(&meta.vault_id, vek)?;
            self.write_session_cache_verifier()
        } else {
            super::session_cache::clear_session_cache(&meta.vault_id)?;
            self.clear_session_cache_verifier()
        }
    }

    fn persist_session_cache_best_effort(&self, remember_on_device: bool) {
        if let Err(error) = self.persist_session_cache_preference(remember_on_device) {
            log::warn!("vault session cache persistence failed: {error}");
        }
    }

    fn write_session_cache_verifier(&self) -> Result<(), VaultError> {
        let vek = self.vek.as_ref().ok_or(VaultError::Locked)?;
        let meta = self.meta.as_ref().ok_or(VaultError::Locked)?;
        let db = self.db.as_ref().ok_or(VaultError::NotInitialized)?;
        let stored = encrypt_session_cache_verifier(vek, &meta.vault_id)?;
        let write_txn = db.begin_write()?;
        {
            let mut meta_table = write_txn.open_table(VAULT_META)?;
            meta_table.insert(
                SESSION_CACHE_VERIFIER_META_KEY,
                serde_json::to_vec(&stored)?.as_slice(),
            )?;
        }
        write_txn.commit()?;
        Ok(())
    }

    fn clear_session_cache_verifier(&self) -> Result<(), VaultError> {
        let db = self.db.as_ref().ok_or(VaultError::NotInitialized)?;
        let write_txn = db.begin_write()?;
        {
            let mut meta_table = write_txn.open_table(VAULT_META)?;
            if meta_table.get(SESSION_CACHE_VERIFIER_META_KEY)?.is_some() {
                meta_table.remove(SESSION_CACHE_VERIFIER_META_KEY)?;
            }
        }
        write_txn.commit()?;
        Ok(())
    }

    fn build_unlocked_status(&self) -> Result<VaultStatus, VaultError> {
        let meta = self.meta.as_ref().ok_or(VaultError::Locked)?;
        let db = self.db.as_ref().ok_or(VaultError::NotInitialized)?;
        let read_txn = db.begin_read()?;
        let item_count = live_record_count(&read_txn)?;
        Ok(VaultStatus::Unlocked {
            vault_id: meta.vault_id.clone(),
            item_count,
        })
    }

    // ── Initialize ────────────────────────────────────────────────────────────

    pub fn initialize(
        &mut self,
        passphrase: &str,
        remember_on_device: bool,
    ) -> Result<VaultStatus, VaultError> {
        if passphrase.len() < PASSPHRASE_MIN_LENGTH {
            return Err(VaultError::InvalidPassphraseLength {
                min: PASSPHRASE_MIN_LENGTH,
            });
        }
        let path = self.vault_path();
        if path.exists() {
            return Err(VaultError::AlreadyInitialized);
        }

        let kdf_params = KdfParams::default_production();
        let salt = generate_salt();
        let kek = derive_kek(passphrase.as_bytes(), &salt, &kdf_params)?;
        let vek = generate_vek();
        let vault_id = Uuid::new_v4().to_string();
        let now = Self::now_secs();

        // Wrap VEK with KEK → passphrase key slot
        let slot_aad = slot_aad_string(&vault_id, SLOT_PASSPHRASE);
        let slot_envelope = encrypt_record(&kek, vek.as_bytes(), slot_aad.as_bytes())?;
        let stored_slot = StoredEnvelope {
            id: SLOT_PASSPHRASE.into(),
            kind: "key-slot".into(),
            revision: 1,
            deleted: false,
            crypto_suite: CRYPTO_SUITE.into(),
            aad_version: AAD_VERSION,
            nonce: STANDARD.encode(slot_envelope.nonce),
            ciphertext: STANDARD.encode(&slot_envelope.ciphertext),
        };

        let meta = VaultMeta {
            vault_id: vault_id.clone(),
            schema_version: SCHEMA_VERSION,
            crypto_suite: CRYPTO_SUITE.into(),
            salt: STANDARD.encode(salt),
            kdf_m_cost: kdf_params.m_cost,
            kdf_t_cost: kdf_params.t_cost,
            kdf_p_cost: kdf_params.p_cost,
            live_records: Some(0),
            created_at: now,
            updated_at: now,
        };

        let db = Database::create(&path)?;
        let write_txn = db.begin_write()?;
        {
            let mut vm = write_txn.open_table(VAULT_META)?;
            vm.insert("vault_id", vault_id.as_bytes())?;
            vm.insert("meta", serde_json::to_vec(&meta)?.as_slice())?;

            let mut ks = write_txn.open_table(KEY_SLOTS)?;
            ks.insert(
                SLOT_PASSPHRASE,
                serde_json::to_vec(&stored_slot)?.as_slice(),
            )?;

            // Pre-create records table so reads never hit TableDoesNotExist.
            write_txn.open_table(RECORDS)?;
            write_txn.open_table(LOGICAL_IDS)?;
            write_txn.open_multimap_table(REVISION_HISTORY)?;
        }
        write_txn.commit()?;

        self.db = Some(db);
        self.vek = Some(vek);
        self.meta = Some(meta);
        self.suppress_session_cache_unlock = false;
        self.persist_session_cache_best_effort(remember_on_device);

        self.build_unlocked_status()
    }

    // ── Unlock ────────────────────────────────────────────────────────────────

    pub fn unlock(
        &mut self,
        passphrase: &str,
        remember_on_device: bool,
    ) -> Result<VaultStatus, VaultError> {
        self.try_open()?;
        let db = self.db.as_ref().ok_or(VaultError::NotInitialized)?;

        let read_txn = db.begin_read()?;
        let vm = read_txn.open_table(VAULT_META).map_err(VaultError::from)?;

        let meta_bytes = vm.get("meta")?.ok_or(VaultError::NotInitialized)?;
        let meta: VaultMeta = serde_json::from_slice(meta_bytes.value())?;

        // Derive KEK from passphrase
        let salt = STANDARD
            .decode(&meta.salt)
            .map_err(|e| VaultError::InvalidData(e.to_string()))?;
        let kdf_params = KdfParams {
            m_cost: meta.kdf_m_cost,
            t_cost: meta.kdf_t_cost,
            p_cost: meta.kdf_p_cost,
        };
        let kek = derive_kek(passphrase.as_bytes(), &salt, &kdf_params)?;

        // Read and decrypt passphrase key slot
        let ks = read_txn.open_table(KEY_SLOTS).map_err(VaultError::from)?;
        let slot_bytes = ks.get(SLOT_PASSPHRASE)?.ok_or(VaultError::NotInitialized)?;
        let stored_slot: StoredEnvelope = serde_json::from_slice(slot_bytes.value())?;

        let slot_envelope = parse_envelope(&stored_slot)?;
        let slot_aad = slot_aad_string(&meta.vault_id, SLOT_PASSPHRASE);
        let vek_bytes = Zeroizing::new(
            decrypt_record(&kek, &slot_envelope, slot_aad.as_bytes())
                .map_err(|_| VaultError::WrongPassphrase)?,
        );

        let mut vek_arr: [u8; 32] = vek_bytes
            .as_slice()
            .try_into()
            .map_err(|_| VaultError::InvalidData("VEK wrong length".into()))?;

        self.vek = Some(SecretKey::from_bytes(vek_arr));
        vek_arr.zeroize();
        self.meta = Some(meta);
        self.suppress_session_cache_unlock = false;
        drop(ks);
        drop(vm);
        drop(read_txn);

        // Idempotent compatibility migration: persist typed envelopes, named
        // secret values, canonical kinds, and the current credential schema.
        if let Err(error) = self.migrate_live_records_to_current_schema() {
            self.vek = None;
            self.meta = None;
            return Err(error);
        }

        self.persist_session_cache_best_effort(remember_on_device);
        self.build_unlocked_status()
    }

    /// Validates a passphrase without unlocking the vault or mutating session cache.
    pub fn verify_passphrase(&mut self, passphrase: &str) -> Result<(), VaultError> {
        self.try_open()?;
        let db = self.db.as_ref().ok_or(VaultError::NotInitialized)?;

        let read_txn = db.begin_read()?;
        let vm = read_txn.open_table(VAULT_META).map_err(VaultError::from)?;

        let meta_bytes = vm.get("meta")?.ok_or(VaultError::NotInitialized)?;
        let meta: VaultMeta = serde_json::from_slice(meta_bytes.value())?;

        let salt = STANDARD
            .decode(&meta.salt)
            .map_err(|e| VaultError::InvalidData(e.to_string()))?;
        let kdf_params = KdfParams {
            m_cost: meta.kdf_m_cost,
            t_cost: meta.kdf_t_cost,
            p_cost: meta.kdf_p_cost,
        };
        let kek = derive_kek(passphrase.as_bytes(), &salt, &kdf_params)?;

        let ks = read_txn.open_table(KEY_SLOTS).map_err(VaultError::from)?;
        let slot_bytes = ks.get(SLOT_PASSPHRASE)?.ok_or(VaultError::NotInitialized)?;
        let stored_slot: StoredEnvelope = serde_json::from_slice(slot_bytes.value())?;

        let slot_envelope = parse_envelope(&stored_slot)?;
        let slot_aad = slot_aad_string(&meta.vault_id, SLOT_PASSPHRASE);
        let _vek_bytes = Zeroizing::new(
            decrypt_record(&kek, &slot_envelope, slot_aad.as_bytes())
                .map_err(|_| VaultError::WrongPassphrase)?,
        );

        Ok(())
    }

    fn migrate_live_records_to_current_schema(&self) -> Result<u64, VaultError> {
        let vek = self.vek.as_ref().ok_or(VaultError::Locked)?;
        let db = self.db.as_ref().ok_or(VaultError::NotInitialized)?;
        let meta = self.meta.as_ref().ok_or(VaultError::Locked)?;

        let read_txn = db.begin_read()?;
        let records = match read_txn.open_table(RECORDS) {
            Ok(table) => table,
            Err(redb::TableError::TableDoesNotExist(_)) => return Ok(0),
            Err(error) => return Err(VaultError::from(error)),
        };
        let logical_ids = match read_txn.open_table(LOGICAL_IDS) {
            Ok(table) => Some(table),
            Err(redb::TableError::TableDoesNotExist(_)) => None,
            Err(error) => return Err(VaultError::from(error)),
        };

        let mut rewrites: Vec<(String, StoredEnvelope)> = Vec::new();
        let mut logical_id_mappings: Vec<(String, String)> = Vec::new();
        for entry in records.iter()? {
            let (key, value): (redb::AccessGuard<&str>, redb::AccessGuard<&[u8]>) = entry?;
            let item_id = key.value().to_string();
            let stored: StoredEnvelope = serde_json::from_slice(value.value())?;
            if stored.deleted {
                continue;
            }

            let record_key = derive_record_key(
                vek,
                record_info_bytes(&stored.id, stored.revision).as_bytes(),
            )?;
            let envelope = parse_envelope(&stored)?;
            let aad = record_aad_string(&meta.vault_id, &stored.id, stored.revision);
            let plaintext = decrypt_record(&record_key, &envelope, aad.as_bytes())?;
            let mut record: PlaintextRecord = serde_json::from_slice(&plaintext)?;
            let needs_rewrite = record.credential.is_none()
                || record
                    .credential
                    .as_ref()
                    .is_some_and(|credential| {
                        credential.schema_version < CURRENT_CREDENTIAL_SCHEMA_VERSION
                    })
                || record.secret_values.is_empty()
                || !record.secret.is_empty()
                || record.kind == "ssh-key-with-passphrase";
            if needs_rewrite {
                normalize_record_credential(&mut record);
                let rewritten_plaintext = serde_json::to_vec(&record)?;
                let rewritten_envelope =
                    encrypt_record(&record_key, &rewritten_plaintext, aad.as_bytes())?;
                rewrites.push((
                    item_id.clone(),
                    StoredEnvelope {
                        id: stored.id.clone(),
                        kind: record.kind.clone(),
                        revision: stored.revision,
                        deleted: stored.deleted,
                        crypto_suite: CRYPTO_SUITE.into(),
                        aad_version: AAD_VERSION,
                        nonce: STANDARD.encode(rewritten_envelope.nonce),
                        ciphertext: STANDARD.encode(&rewritten_envelope.ciphertext),
                    },
                ));
            }
            let logical_id = Self::record_logical_id(&record);
            let mapping_is_current = match &logical_ids {
                Some(table) => table
                    .get(logical_id.as_str())?
                    .is_some_and(|mapped_item_id| mapped_item_id.value() == item_id),
                None => false,
            };
            if !mapping_is_current {
                logical_id_mappings.push((logical_id, item_id));
            }
        }
        drop(logical_ids);
        drop(records);
        drop(read_txn);

        if rewrites.is_empty() && logical_id_mappings.is_empty() {
            return Ok(0);
        }

        let write_txn = db.begin_write()?;
        {
            let mut records = write_txn.open_table(RECORDS)?;
            for (item_id, stored) in &rewrites {
                records.insert(item_id.as_str(), serde_json::to_vec(stored)?.as_slice())?;
            }
            let mut logical_ids = write_txn.open_table(LOGICAL_IDS)?;
            for (logical_id, item_id) in &logical_id_mappings {
                logical_ids.insert(logical_id.as_str(), item_id.as_str())?;
            }
        }
        write_txn.commit()?;
        Ok(rewrites.len() as u64)
    }

    // ── Lock ──────────────────────────────────────────────────────────────────

    pub fn lock(&mut self) {
        // SecretKey implements ZeroizeOnDrop — drops immediately here.
        self.vek = None;
        self.meta = None;
        self.suppress_session_cache_unlock = true;
    }

    /// Returns the vault ID if the vault is unlocked (meta is cached).
    pub fn vault_id(&self) -> Option<String> {
        self.meta.as_ref().map(|m| m.vault_id.clone())
    }

    pub fn secret_fingerprint(&self, secret: &str) -> Result<String, VaultError> {
        let vek = self.vek.as_ref().ok_or(VaultError::Locked)?;
        derive_secret_fingerprint(vek, secret).map_err(VaultError::from)
    }

    pub fn record_secret_fingerprint(&self, record: &PlaintextRecord) -> Result<String, VaultError> {
        if record.secret_values.is_empty() {
            return self.secret_fingerprint(primary_secret_value(record).unwrap_or_default());
        }

        // Fingerprint the full named secret set so auxiliary secret changes
        // such as passphrase rotation are visible to dedupe/history logic.
        let serialized = serde_json::to_string(&record.secret_values)?;
        self.secret_fingerprint(&serialized)
    }

    pub fn item_meta(&self, record: &PlaintextRecord) -> Result<VaultItemMeta, VaultError> {
        let credential = record.credential.as_ref();
        let fields = credential.map(|value| value.fields.as_slice()).unwrap_or(&[]);
        Ok(VaultItemMeta {
            id: record.id.clone(),
            logical_id: Self::record_logical_id(record),
            kind: record.kind.clone(),
            label: record.label.clone(),
            secret_fingerprint: self.record_secret_fingerprint(record)?,
            schema_version: credential
                .map(|value| value.schema_version)
                .unwrap_or(CURRENT_CREDENTIAL_SCHEMA_VERSION),
            secret_field_count: fields.iter().filter(|field| field.secret).count() as u32,
            has_passphrase_field: fields.iter().any(|field| field.name == "passphrase"),
            revision: record.revision,
            created_at: record.created_at,
            updated_at: record.updated_at,
        })
    }

    pub fn record_logical_id(record: &PlaintextRecord) -> String {
        record
            .logical_id
            .as_ref()
            .filter(|value| !value.trim().is_empty())
            .cloned()
            .unwrap_or_else(|| record.id.clone())
    }

    // ── Item CRUD ─────────────────────────────────────────────────────────────

    pub fn item_create(
        &self,
        label: &str,
        kind: &str,
        secret: &str,
        notes: Option<&str>,
    ) -> Result<PlaintextRecord, VaultError> {
        self.item_create_with_logical_id(label, kind, secret, notes, None)
    }

    pub fn item_create_with_logical_id(
        &self,
        label: &str,
        kind: &str,
        secret: &str,
        notes: Option<&str>,
        logical_id: Option<&str>,
    ) -> Result<PlaintextRecord, VaultError> {
        let secret_values = secret_values_from_legacy(kind, secret);
        self.item_create_with_secret_values(label, kind, &secret_values, notes, logical_id)
    }

    pub fn item_create_with_secret_values(
        &self,
        label: &str,
        kind: &str,
        secret_values: &BTreeMap<String, String>,
        notes: Option<&str>,
        logical_id: Option<&str>,
    ) -> Result<PlaintextRecord, VaultError> {
        validate_secret_values(kind, secret_values)?;
        let vek = self.vek.as_ref().ok_or(VaultError::Locked)?;
        let db = self.db.as_ref().ok_or(VaultError::NotInitialized)?;
        let meta = self.meta.as_ref().ok_or(VaultError::Locked)?;

        let id = Uuid::new_v4().to_string();
        let caller_provided_logical_id = logical_id
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let logical_id = caller_provided_logical_id
            .map(str::to_string)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let now = Self::now_secs();
        let revision = 1u64;

        let mut record = PlaintextRecord {
            id: id.clone(),
            logical_id: Some(logical_id),
            kind: kind.to_string(),
            label: label.to_string(),
            secret: String::new(),
            secret_values: secret_values.clone(),
            notes: notes.map(str::to_string),
            credential: None,
            revision,
            created_at: now,
            updated_at: now,
        };
        normalize_record_credential(&mut record);

        let plaintext = serde_json::to_vec(&record)?;
        let record_key = derive_record_key(vek, record_info_bytes(&id, revision).as_bytes())?;
        let aad = record_aad_string(&meta.vault_id, &id, revision);
        let envelope = encrypt_record(&record_key, &plaintext, aad.as_bytes())?;

        let stored = StoredEnvelope {
            id: id.clone(),
            kind: record.kind.clone(),
            revision,
            deleted: false,
            crypto_suite: CRYPTO_SUITE.into(),
            aad_version: AAD_VERSION,
            nonce: STANDARD.encode(envelope.nonce),
            ciphertext: STANDARD.encode(&envelope.ciphertext),
        };

        let write_txn = db.begin_write()?;
        {
            let mut records = write_txn.open_table(RECORDS)?;
            records.insert(id.as_str(), serde_json::to_vec(&stored)?.as_slice())?;
            let mut logical_ids = write_txn.open_table(LOGICAL_IDS)?;

            // Reject duplicate logical IDs when the caller explicitly provided one.
            // Auto-generated UUIDs are collision-free by construction and skip this check.
            if caller_provided_logical_id.is_some() {
                if let Some(existing) = logical_ids.get(Self::record_logical_id(&record).as_str())? {
                    let existing_id = existing.value().to_string();
                    drop(existing);
                    return Err(VaultError::InvalidData(format!(
                        "logical_id '{}' is already assigned to item '{}'",
                        Self::record_logical_id(&record),
                        existing_id,
                    )));
                }
            }

            logical_ids.insert(Self::record_logical_id(&record).as_str(), id.as_str())?;

            let mut meta_table = write_txn.open_table(VAULT_META)?;
            let meta_bytes = meta_table.get("meta")?.ok_or(VaultError::NotInitialized)?;
            let mut db_meta: VaultMeta = serde_json::from_slice(meta_bytes.value())?;
            db_meta.live_records = Some(db_meta.live_records.unwrap_or(0).saturating_add(1));
            db_meta.updated_at = Self::now_secs();
            drop(meta_bytes);
            meta_table.insert("meta", serde_json::to_vec(&db_meta)?.as_slice())?;
        }
        write_txn.commit()?;

        Ok(record)
    }

    /// Creates a record from a remote sync payload while preserving the remote
    /// revision/updated_at metadata so restore reconciliation converges.
    pub fn item_create_from_sync(
        &self,
        label: &str,
        kind: &str,
        secret_values: &BTreeMap<String, String>,
        notes: Option<&str>,
        credential: Option<&CredentialEnvelope>,
        logical_id: &str,
        revision: u64,
        updated_at: u64,
    ) -> Result<PlaintextRecord, VaultError> {
        let vek = self.vek.as_ref().ok_or(VaultError::Locked)?;
        let db = self.db.as_ref().ok_or(VaultError::NotInitialized)?;
        let meta = self.meta.as_ref().ok_or(VaultError::Locked)?;
        validate_secret_values(kind, secret_values)?;

        let id = Uuid::new_v4().to_string();
        let logical_id = logical_id.trim();
        if logical_id.is_empty() {
            return Err(VaultError::InvalidData(
                "logical_id is required for sync restore create".to_string(),
            ));
        }
        let revision = revision.max(1);
        let created_at = updated_at;

        let mut record = PlaintextRecord {
            id: id.clone(),
            logical_id: Some(logical_id.to_string()),
            kind: kind.to_string(),
            label: label.to_string(),
            secret: String::new(),
            secret_values: secret_values.clone(),
            notes: notes.map(str::to_string),
            credential: credential.cloned(),
            revision,
            created_at,
            updated_at,
        };
        normalize_record_credential(&mut record);

        let plaintext = serde_json::to_vec(&record)?;
        let record_key = derive_record_key(vek, record_info_bytes(&id, revision).as_bytes())?;
        let aad = record_aad_string(&meta.vault_id, &id, revision);
        let envelope = encrypt_record(&record_key, &plaintext, aad.as_bytes())?;

        let stored = StoredEnvelope {
            id: id.clone(),
            kind: record.kind.clone(),
            revision,
            deleted: false,
            crypto_suite: CRYPTO_SUITE.into(),
            aad_version: AAD_VERSION,
            nonce: STANDARD.encode(envelope.nonce),
            ciphertext: STANDARD.encode(&envelope.ciphertext),
        };

        let write_txn = db.begin_write()?;
        {
            let mut records = write_txn.open_table(RECORDS)?;
            records.insert(id.as_str(), serde_json::to_vec(&stored)?.as_slice())?;
            let mut logical_ids = write_txn.open_table(LOGICAL_IDS)?;
            if let Some(existing) = logical_ids.get(logical_id)? {
                let existing_id = existing.value().to_string();
                drop(existing);
                return Err(VaultError::InvalidData(format!(
                    "logical_id '{}' is already assigned to item '{}'",
                    logical_id, existing_id
                )));
            }
            logical_ids.insert(logical_id, id.as_str())?;

            let mut meta_table = write_txn.open_table(VAULT_META)?;
            let meta_bytes = meta_table.get("meta")?.ok_or(VaultError::NotInitialized)?;
            let mut db_meta: VaultMeta = serde_json::from_slice(meta_bytes.value())?;
            db_meta.live_records = Some(db_meta.live_records.unwrap_or(0).saturating_add(1));
            db_meta.updated_at = Self::now_secs();
            drop(meta_bytes);
            meta_table.insert("meta", serde_json::to_vec(&db_meta)?.as_slice())?;
        }
        write_txn.commit()?;

        Ok(record)
    }

    pub fn item_get(&self, item_id: &str) -> Result<PlaintextRecord, VaultError> {
        let vek = self.vek.as_ref().ok_or(VaultError::Locked)?;
        let db = self.db.as_ref().ok_or(VaultError::NotInitialized)?;
        let meta = self.meta.as_ref().ok_or(VaultError::Locked)?;

        let read_txn = db.begin_read()?;
        let records = read_txn.open_table(RECORDS).map_err(VaultError::from)?;
        let stored_bytes = records
            .get(item_id)?
            .ok_or_else(|| VaultError::RecordNotFound(item_id.to_string()))?;
        let stored: StoredEnvelope = serde_json::from_slice(stored_bytes.value())?;

        if stored.deleted {
            return Err(VaultError::RecordNotFound(item_id.to_string()));
        }

        decrypt_stored(vek, &meta.vault_id, &stored)
    }

    pub fn item_get_by_logical_id(&self, logical_id: &str) -> Result<PlaintextRecord, VaultError> {
        let logical_id = logical_id.trim();
        if logical_id.is_empty() {
            return Err(VaultError::RecordNotFound(logical_id.to_string()));
        }

        let db = self.db.as_ref().ok_or(VaultError::NotInitialized)?;
        let read_txn = db.begin_read()?;
        let logical_ids = match read_txn.open_table(LOGICAL_IDS) {
            Ok(table) => table,
            Err(redb::TableError::TableDoesNotExist(_)) => {
                return self
                    .item_list()?
                    .into_iter()
                    .find(|record| Self::record_logical_id(record) == logical_id)
                    .ok_or_else(|| VaultError::RecordNotFound(logical_id.to_string()));
            }
            Err(error) => return Err(VaultError::from(error)),
        };

        let record_id = logical_ids
            .get(logical_id)?
            .ok_or_else(|| VaultError::RecordNotFound(logical_id.to_string()))?;
        let record_id = record_id.value().trim().to_string();
        if record_id.is_empty() {
            return Err(VaultError::RecordNotFound(logical_id.to_string()));
        }
        drop(logical_ids);
        drop(read_txn);

        self.item_get(&record_id)
    }

    pub fn item_update(
        &self,
        item_id: &str,
        label: &str,
        kind: &str,
        secret: &str,
        notes: Option<&str>,
    ) -> Result<PlaintextRecord, VaultError> {
        let secret_values = secret_values_from_legacy(kind, secret);
        self.item_update_with_secret_values(item_id, label, kind, &secret_values, notes, None)
    }

    pub fn item_update_with_secret_values(
        &self,
        item_id: &str,
        label: &str,
        kind: &str,
        secret_values: &BTreeMap<String, String>,
        notes: Option<&str>,
        credential: Option<&CredentialEnvelope>,
    ) -> Result<PlaintextRecord, VaultError> {
        validate_secret_values(kind, secret_values)?;
        let existing = self.item_get(item_id)?;
        let vek = self.vek.as_ref().ok_or(VaultError::Locked)?;
        let db = self.db.as_ref().ok_or(VaultError::NotInitialized)?;
        let meta = self.meta.as_ref().ok_or(VaultError::Locked)?;

        let revision = existing.revision.saturating_add(1);
        let now = Self::now_secs();
        let mut record = PlaintextRecord {
            id: existing.id.clone(),
            logical_id: Some(Self::record_logical_id(&existing)),
            kind: kind.to_string(),
            label: label.to_string(),
            secret: String::new(),
            secret_values: secret_values.clone(),
            notes: notes.map(str::to_string),
            credential: match credential.cloned() {
                Some(value) => Some(value),
                None => existing
                    .credential
                    .clone()
                    .filter(|existing_credential| {
                        existing_credential.kind.canonical_storage_kind() == kind
                    }),
            },
            revision,
            created_at: existing.created_at,
            updated_at: now,
        };
        normalize_record_credential(&mut record);

        let plaintext = serde_json::to_vec(&record)?;
        let record_key = derive_record_key(vek, record_info_bytes(item_id, revision).as_bytes())?;
        let aad = record_aad_string(&meta.vault_id, item_id, revision);
        let envelope = encrypt_record(&record_key, &plaintext, aad.as_bytes())?;
        let stored = StoredEnvelope {
            id: item_id.to_string(),
            kind: record.kind.clone(),
            revision,
            deleted: false,
            crypto_suite: CRYPTO_SUITE.into(),
            aad_version: AAD_VERSION,
            nonce: STANDARD.encode(envelope.nonce),
            ciphertext: STANDARD.encode(&envelope.ciphertext),
        };

        let write_txn = db.begin_write()?;
        {
            // ── Snapshot the superseded revision into history ──────────────────
            let snapshot_bytes = serde_json::to_vec(&existing)?;
            let snapshot_key = derive_record_key(
                vek,
                record_info_bytes(&existing.id, existing.revision).as_bytes(),
            )?;
            let snapshot_aad = record_aad_string(&meta.vault_id, &existing.id, existing.revision);
            let snapshot_envelope =
                encrypt_record(&snapshot_key, &snapshot_bytes, snapshot_aad.as_bytes())?;
            let snapshot_stored = StoredEnvelope {
                id: existing.id.clone(),
                kind: existing.kind.clone(),
                revision: existing.revision,
                deleted: false,
                crypto_suite: CRYPTO_SUITE.into(),
                aad_version: AAD_VERSION,
                nonce: STANDARD.encode(snapshot_envelope.nonce),
                ciphertext: STANDARD.encode(&snapshot_envelope.ciphertext),
            };
            let snapshot_json = serde_json::to_vec(&snapshot_stored)?;
            let mut history = write_txn.open_multimap_table(REVISION_HISTORY)?;
            history.insert(item_id, snapshot_json.as_slice())?;

            let mut records = write_txn.open_table(RECORDS)?;
            records.insert(item_id, serde_json::to_vec(&stored)?.as_slice())?;
            let mut logical_ids = write_txn.open_table(LOGICAL_IDS)?;
            logical_ids.insert(Self::record_logical_id(&record).as_str(), item_id)?;

            let mut meta_table = write_txn.open_table(VAULT_META)?;
            let meta_bytes = meta_table.get("meta")?.ok_or(VaultError::NotInitialized)?;
            let mut db_meta: VaultMeta = serde_json::from_slice(meta_bytes.value())?;
            db_meta.updated_at = now;
            drop(meta_bytes);
            meta_table.insert("meta", serde_json::to_vec(&db_meta)?.as_slice())?;
        }
        write_txn.commit()?;

        Ok(record)
    }

    /// Overwrites an existing record from remote sync while preserving remote
    /// revision/updated_at metadata so restore reconciliation converges.
    pub fn item_apply_sync_restore(
        &self,
        item_id: &str,
        logical_id: &str,
        label: &str,
        kind: &str,
        secret_values: &BTreeMap<String, String>,
        notes: Option<&str>,
        credential: Option<&CredentialEnvelope>,
        revision: u64,
        updated_at: u64,
    ) -> Result<PlaintextRecord, VaultError> {
        validate_secret_values(kind, secret_values)?;
        let existing = self.item_get(item_id)?;
        let vek = self.vek.as_ref().ok_or(VaultError::Locked)?;
        let db = self.db.as_ref().ok_or(VaultError::NotInitialized)?;
        let meta = self.meta.as_ref().ok_or(VaultError::Locked)?;

        let logical_id = logical_id.trim();
        if logical_id.is_empty() {
            return Err(VaultError::InvalidData(
                "logical_id is required for sync restore update".to_string(),
            ));
        }

        if revision < existing.revision {
            return Err(VaultError::InvalidData(format!(
                "sync restore revision {revision} is older than local revision {}",
                existing.revision
            )));
        }

        let revision = revision.max(1);
        let mut record = PlaintextRecord {
            id: existing.id.clone(),
            logical_id: Some(logical_id.to_string()),
            kind: kind.to_string(),
            label: label.to_string(),
            secret: String::new(),
            secret_values: secret_values.clone(),
            notes: notes.map(str::to_string),
            credential: match credential.cloned() {
                Some(value) => Some(value),
                None => existing
                    .credential
                    .clone()
                    .filter(|existing_credential| {
                        existing_credential.kind.canonical_storage_kind() == kind
                    }),
            },
            revision,
            created_at: existing.created_at,
            updated_at,
        };
        normalize_record_credential(&mut record);

        if revision == existing.revision
            && existing.kind == record.kind
            && existing.label == record.label
            && existing.secret_values == record.secret_values
            && existing.notes == record.notes
            && existing.credential == record.credential
        {
            return Ok(existing);
        }

        let plaintext = serde_json::to_vec(&record)?;
        let record_key = derive_record_key(vek, record_info_bytes(item_id, revision).as_bytes())?;
        let aad = record_aad_string(&meta.vault_id, item_id, revision);
        let envelope = encrypt_record(&record_key, &plaintext, aad.as_bytes())?;
        let stored = StoredEnvelope {
            id: item_id.to_string(),
            kind: record.kind.clone(),
            revision,
            deleted: false,
            crypto_suite: CRYPTO_SUITE.into(),
            aad_version: AAD_VERSION,
            nonce: STANDARD.encode(envelope.nonce),
            ciphertext: STANDARD.encode(&envelope.ciphertext),
        };

        let write_txn = db.begin_write()?;
        {
            let snapshot_bytes = serde_json::to_vec(&existing)?;
            let snapshot_key = derive_record_key(
                vek,
                record_info_bytes(&existing.id, existing.revision).as_bytes(),
            )?;
            let snapshot_aad = record_aad_string(&meta.vault_id, &existing.id, existing.revision);
            let snapshot_envelope =
                encrypt_record(&snapshot_key, &snapshot_bytes, snapshot_aad.as_bytes())?;
            let snapshot_stored = StoredEnvelope {
                id: existing.id.clone(),
                kind: existing.kind.clone(),
                revision: existing.revision,
                deleted: false,
                crypto_suite: CRYPTO_SUITE.into(),
                aad_version: AAD_VERSION,
                nonce: STANDARD.encode(snapshot_envelope.nonce),
                ciphertext: STANDARD.encode(snapshot_envelope.ciphertext),
            };
            let snapshot_json = serde_json::to_vec(&snapshot_stored)?;
            let mut history = write_txn.open_multimap_table(REVISION_HISTORY)?;
            history.insert(item_id, snapshot_json.as_slice())?;

            let mut records = write_txn.open_table(RECORDS)?;
            records.insert(item_id, serde_json::to_vec(&stored)?.as_slice())?;

            let mut logical_ids = write_txn.open_table(LOGICAL_IDS)?;
            let previous_logical_id = Self::record_logical_id(&existing);
            if previous_logical_id != logical_id {
                match logical_ids.remove(previous_logical_id.as_str()) {
                    Ok(_) => {}
                    Err(e) => return Err(VaultError::from(e)),
                }
            }
            if let Some(existing_mapping) = logical_ids.get(logical_id)? {
                let mapped_id = existing_mapping.value().to_string();
                drop(existing_mapping);
                if mapped_id != item_id {
                    return Err(VaultError::InvalidData(format!(
                        "logical_id '{}' is already assigned to item '{}'",
                        logical_id, mapped_id
                    )));
                }
            }
            logical_ids.insert(logical_id, item_id)?;

            let mut meta_table = write_txn.open_table(VAULT_META)?;
            let meta_bytes = meta_table.get("meta")?.ok_or(VaultError::NotInitialized)?;
            let mut db_meta: VaultMeta = serde_json::from_slice(meta_bytes.value())?;
            db_meta.updated_at = Self::now_secs();
            drop(meta_bytes);
            meta_table.insert("meta", serde_json::to_vec(&db_meta)?.as_slice())?;
        }
        write_txn.commit()?;

        Ok(record)
    }

    pub fn item_list(&self) -> Result<Vec<PlaintextRecord>, VaultError> {
        let vek = self.vek.as_ref().ok_or(VaultError::Locked)?;
        let db = self.db.as_ref().ok_or(VaultError::NotInitialized)?;
        let meta = self.meta.as_ref().ok_or(VaultError::Locked)?;

        let read_txn = db.begin_read()?;
        let records = match read_txn.open_table(RECORDS) {
            Ok(t) => t,
            Err(redb::TableError::TableDoesNotExist(_)) => return Ok(vec![]),
            Err(e) => return Err(VaultError::from(e)),
        };

        let mut results = Vec::new();
        for entry in records.iter()? {
            let (_, v): (redb::AccessGuard<&str>, redb::AccessGuard<&[u8]>) = entry?;
            let stored: StoredEnvelope = serde_json::from_slice(v.value())?;
            if stored.deleted {
                continue;
            }
            results.push(decrypt_stored(vek, &meta.vault_id, &stored)?);
        }
        Ok(results)
    }

    pub fn item_delete(&self, item_id: &str) -> Result<(), VaultError> {
        let db = self.db.as_ref().ok_or(VaultError::NotInitialized)?;
        if self.vek.is_none() {
            return Err(VaultError::Locked);
        }
        let existing = self.item_get(item_id)?;
        let logical_id = Self::record_logical_id(&existing);

        let write_txn = db.begin_write()?;
        {
            let mut records = write_txn.open_table(RECORDS)?;
            let stored_bytes = records
                .get(item_id)?
                .ok_or_else(|| VaultError::RecordNotFound(item_id.to_string()))?;
            let mut stored: StoredEnvelope = serde_json::from_slice(stored_bytes.value())?;
            drop(stored_bytes);
            if stored.deleted {
                return Err(VaultError::RecordNotFound(item_id.to_string()));
            }
            stored.deleted = true;
            stored.revision += 1;
            records.insert(item_id, serde_json::to_vec(&stored)?.as_slice())?;
            let mut logical_ids = write_txn.open_table(LOGICAL_IDS)?;
            // Propagate real DB errors; only a missing entry is safe to ignore.
            match logical_ids.remove(logical_id.as_str()) {
                Ok(_) => {}
                Err(e) => return Err(VaultError::from(e)),
            }

            let mut meta_table = write_txn.open_table(VAULT_META)?;
            let meta_bytes = meta_table.get("meta")?.ok_or(VaultError::NotInitialized)?;
            let mut db_meta: VaultMeta = serde_json::from_slice(meta_bytes.value())?;
            db_meta.live_records = Some(db_meta.live_records.unwrap_or(0).saturating_sub(1));
            db_meta.updated_at = Self::now_secs();
            drop(meta_bytes);
            meta_table.insert("meta", serde_json::to_vec(&db_meta)?.as_slice())?;
        }
        write_txn.commit()?;
        Ok(())
    }

    // ── Revision history ──────────────────────────────────────────────────────

    /// Returns all stored historical revisions for `item_id`, oldest first.
    /// The current live revision is NOT included — only superseded snapshots.
    pub fn item_revision_history(
        &self,
        item_id: &str,
    ) -> Result<Vec<RevisionMeta>, VaultError> {
        let vek = self.vek.as_ref().ok_or(VaultError::Locked)?;
        let db = self.db.as_ref().ok_or(VaultError::NotInitialized)?;
        let meta = self.meta.as_ref().ok_or(VaultError::Locked)?;

        let read_txn = db.begin_read()?;
        let history = match read_txn.open_multimap_table(REVISION_HISTORY) {
            Ok(t) => t,
            Err(redb::TableError::TableDoesNotExist(_)) => return Ok(vec![]),
            Err(e) => return Err(VaultError::from(e)),
        };

        let mut snapshots: Vec<RevisionMeta> = Vec::new();
        for entry in history.get(item_id)? {
            let value = entry?;
            let stored: StoredEnvelope = serde_json::from_slice(value.value())?;
            let record = decrypt_stored(vek, &meta.vault_id, &stored)?;
            let fingerprint = self.record_secret_fingerprint(&record)?;
            snapshots.push(RevisionMeta {
                item_id: item_id.to_string(),
                revision: record.revision,
                label: record.label.clone(),
                kind: record.kind.clone(),
                secret_fingerprint: fingerprint,
                created_at: record.created_at,
                rotated_at: record.updated_at,
            });
        }

        // Sort oldest revision first.
        snapshots.sort_by_key(|s| s.revision);
        Ok(snapshots)
    }

    /// Restores a specific historical revision as the new current value.
    /// The current live record is snapshotted into history first, then the
    /// chosen historical snapshot is re-encrypted as the new live record.
    /// The restored revision gets a new incremented revision number.
    pub fn item_restore_revision(
        &self,
        item_id: &str,
        revision: u64,
    ) -> Result<PlaintextRecord, VaultError> {
        let vek = self.vek.as_ref().ok_or(VaultError::Locked)?;
        let db = self.db.as_ref().ok_or(VaultError::NotInitialized)?;
        let meta = self.meta.as_ref().ok_or(VaultError::Locked)?;

        // Find the requested snapshot.
        let read_txn = db.begin_read()?;
        let history = match read_txn.open_multimap_table(REVISION_HISTORY) {
            Ok(t) => t,
            Err(redb::TableError::TableDoesNotExist(_)) => {
                return Err(VaultError::RecordNotFound(format!(
                    "no history for {item_id}"
                )))
            }
            Err(e) => return Err(VaultError::from(e)),
        };

        let mut target_record: Option<PlaintextRecord> = None;
        for entry in history.get(item_id)? {
            let value = entry?;
            let stored: StoredEnvelope = serde_json::from_slice(value.value())?;
            if stored.revision == revision {
                target_record = Some(decrypt_stored(vek, &meta.vault_id, &stored)?);
                break;
            }
        }
        drop(read_txn);

        let target = target_record.ok_or_else(|| {
            VaultError::RecordNotFound(format!("revision {revision} not found for {item_id}"))
        })?;

        // Use item_update to write the restored secret — this automatically
        // snapshots the current live record into history and increments revision.
        self.item_update_with_secret_values(
            item_id,
            &target.label,
            &target.kind,
            &target.secret_values,
            target.notes.as_deref(),
            target.credential.as_ref(),
        )
    }

    // ── Recovery key ─────────────────────────────────────────────────────────

    /// Generates a new 32-byte random recovery key, stores it as a second key slot,
    /// and returns it as uppercase hex groups (e.g. "AABB-CCDD-…").
    pub fn generate_recovery_key(&mut self) -> Result<String, VaultError> {
        let vek = self.vek.as_ref().ok_or(VaultError::Locked)?;
        let db = self.db.as_ref().ok_or(VaultError::NotInitialized)?;
        let meta = self.meta.as_ref().ok_or(VaultError::Locked)?;

        let mut raw = [0u8; 32];
        OsRng.fill_bytes(&mut raw);
        let recovery_key = encode_recovery_key(&raw);
        let kek = SecretKey::from_bytes(raw);
        raw.zeroize();

        let slot_aad = slot_aad_string(&meta.vault_id, SLOT_RECOVERY);
        let slot_envelope = encrypt_record(&kek, vek.as_bytes(), slot_aad.as_bytes())?;

        let stored_slot = StoredEnvelope {
            id: SLOT_RECOVERY.into(),
            kind: "key-slot".into(),
            revision: 1,
            deleted: false,
            crypto_suite: CRYPTO_SUITE.into(),
            aad_version: AAD_VERSION,
            nonce: STANDARD.encode(slot_envelope.nonce),
            ciphertext: STANDARD.encode(&slot_envelope.ciphertext),
        };

        let write_txn = db.begin_write()?;
        {
            let mut ks = write_txn.open_table(KEY_SLOTS)?;
            ks.insert(SLOT_RECOVERY, serde_json::to_vec(&stored_slot)?.as_slice())?;
        }
        write_txn.commit()?;

        Ok(recovery_key)
    }

    pub fn has_recovery_key(&mut self) -> Result<bool, VaultError> {
        self.try_open()?;
        let db = self.db.as_ref().ok_or(VaultError::NotInitialized)?;
        let read_txn = db.begin_read()?;
        let ks = match read_txn.open_table(KEY_SLOTS) {
            Ok(t) => t,
            Err(redb::TableError::TableDoesNotExist(_)) => return Ok(false),
            Err(e) => return Err(VaultError::from(e)),
        };
        Ok(ks.get(SLOT_RECOVERY)?.is_some())
    }

    /// Unlocks the vault using a recovery key string instead of a passphrase.
    pub fn unlock_with_recovery_key(
        &mut self,
        key: &str,
        remember_on_device: bool,
    ) -> Result<VaultStatus, VaultError> {
        self.try_open()?;
        let db = self.db.as_ref().ok_or(VaultError::NotInitialized)?;

        let read_txn = db.begin_read()?;
        let vm = read_txn.open_table(VAULT_META).map_err(VaultError::from)?;
        let meta_bytes = vm.get("meta")?.ok_or(VaultError::NotInitialized)?;
        let meta: VaultMeta = serde_json::from_slice(meta_bytes.value())?;

        let mut raw = parse_recovery_key(key).ok_or(VaultError::WrongPassphrase)?;
        let kek = SecretKey::from_bytes(raw);
        raw.zeroize();

        let ks = read_txn.open_table(KEY_SLOTS).map_err(VaultError::from)?;
        let slot_bytes = ks
            .get(SLOT_RECOVERY)?
            .ok_or_else(|| VaultError::InvalidData("No recovery key slot found".into()))?;
        let stored_slot: StoredEnvelope = serde_json::from_slice(slot_bytes.value())?;

        let slot_envelope = parse_envelope(&stored_slot)?;
        let slot_aad = slot_aad_string(&meta.vault_id, SLOT_RECOVERY);
        let vek_bytes = Zeroizing::new(
            decrypt_record(&kek, &slot_envelope, slot_aad.as_bytes())
                .map_err(|_| VaultError::WrongPassphrase)?,
        );

        let mut vek_arr: [u8; 32] = vek_bytes
            .as_slice()
            .try_into()
            .map_err(|_| VaultError::InvalidData("VEK wrong length".into()))?;

        self.vek = Some(SecretKey::from_bytes(vek_arr));
        vek_arr.zeroize();
        self.meta = Some(meta);
        self.suppress_session_cache_unlock = false;

        drop(slot_bytes);
        drop(ks);
        drop(meta_bytes);
        drop(vm);
        drop(read_txn);

        if let Err(error) = self.migrate_live_records_to_current_schema() {
            self.vek = None;
            self.meta = None;
            return Err(error);
        }

        self.persist_session_cache_best_effort(remember_on_device);
        self.build_unlocked_status()
    }

    // ── Export / Import ───────────────────────────────────────────────────────

    /// Copies vault.redb to `dest_path` as an encrypted backup.
    pub fn export_vault(&mut self, dest_path: &Path) -> Result<(), VaultError> {
        let src = self.vault_path();
        if !src.exists() {
            return Err(VaultError::NotInitialized);
        }
        // Temporarily drop the DB handle to release the redb exclusive file lock.
        let had_db = self.db.take().is_some();
        let result = std::fs::copy(&src, dest_path)
            .map_err(|e| VaultError::InvalidData(format!("export failed: {e}")));
        if had_db {
            let reopen_result = self.try_open();
            result?;
            reopen_result?;
            return Ok(());
        }
        result?;
        Ok(())
    }

    /// Replaces the current vault.redb with the file at `src_path`.
    /// Validates the file is a valid redb database before overwriting.
    /// Backs up the existing vault first.
    pub fn import_vault(&mut self, src_path: &Path) -> Result<VaultStatus, VaultError> {
        // Validate before touching the current vault.
        validate_vault_database(src_path)?;

        // Close and clear current state.
        self.db = None;
        self.vek = None;
        self.meta = None;

        let dest = self.vault_path();
        let tmp = dest.with_extension("redb.tmp-pre-import");
        let backup = dest.with_extension("redb.pre-import");
        let _ = std::fs::remove_file(&tmp);

        if dest.exists() {
            std::fs::copy(&dest, &backup)
                .map_err(|e| VaultError::InvalidData(format!("pre-import backup failed: {e}")))?;
            sync_file(&backup)?;
        }

        if let Err(e) = copy_file_synced(src_path, &tmp)
            .and_then(|_| {
                if dest.exists() {
                    std::fs::remove_file(&dest).map_err(|e| {
                        VaultError::InvalidData(format!("import remove old vault failed: {e}"))
                    })?;
                }
                std::fs::rename(&tmp, &dest).map_err(|e| {
                    VaultError::InvalidData(format!("import replace failed: {e}"))
                })?;
                sync_parent_dir(&dest)
            })
        {
            let _ = std::fs::remove_file(&tmp);
            if backup.exists() {
                let _ = std::fs::copy(&backup, &dest);
                let _ = sync_file(&dest);
            }
            return Err(e);
        }

        if let Err(e) = self.try_open().and_then(|_| self.status()) {
            if backup.exists() {
                self.db = None;
                let _ = std::fs::copy(&backup, &dest);
                let _ = sync_file(&dest);
                self.try_open()?;
            }
            return Err(VaultError::InvalidData(format!("imported vault failed to open: {e}")));
        }

        self.status()
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn record_info_bytes(record_id: &str, revision: u64) -> String {
    format!("zync:vault:record:v1:{record_id}:{revision}")
}

fn record_aad_string(vault_id: &str, record_id: &str, revision: u64) -> String {
    format!("vault:{vault_id}|record:{record_id}|revision:{revision}|v:{AAD_VERSION}")
}

fn slot_aad_string(vault_id: &str, slot_id: &str) -> String {
    format!("vault:{vault_id}|slot:{slot_id}|v:{AAD_VERSION}")
}

fn parse_envelope(stored: &StoredEnvelope) -> Result<EncryptedEnvelope, VaultError> {
    let nonce_bytes = STANDARD
        .decode(&stored.nonce)
        .map_err(|e| VaultError::InvalidData(e.to_string()))?;
    let nonce: [u8; 24] = nonce_bytes
        .try_into()
        .map_err(|_| VaultError::InvalidData("nonce wrong length".into()))?;
    let ciphertext = STANDARD
        .decode(&stored.ciphertext)
        .map_err(|e| VaultError::InvalidData(e.to_string()))?;
    Ok(EncryptedEnvelope { nonce, ciphertext })
}

fn verify_cached_vek(
    vek: &SecretKey,
    meta: &VaultMeta,
    read_txn: &ReadTransaction,
    _proof_verified: bool,
) -> Result<(), VaultError> {
    let item_count = live_record_count(read_txn)?;
    if item_count > 0 {
        decrypt_first_live_record(vek, &meta.vault_id, read_txn)
    } else {
        verify_session_cache_verifier(vek, &meta.vault_id, read_txn)
    }
}

fn encrypt_session_cache_verifier(
    vek: &SecretKey,
    vault_id: &str,
) -> Result<StoredEnvelope, VaultError> {
    let record_key = derive_record_key(
        vek,
        record_info_bytes(SESSION_CACHE_VERIFIER_RECORD_ID, SESSION_CACHE_VERIFIER_REVISION)
            .as_bytes(),
    )?;
    let aad = record_aad_string(
        vault_id,
        SESSION_CACHE_VERIFIER_RECORD_ID,
        SESSION_CACHE_VERIFIER_REVISION,
    );
    let envelope = encrypt_record(
        &record_key,
        SESSION_CACHE_VERIFIER_PLAINTEXT,
        aad.as_bytes(),
    )?;
    Ok(StoredEnvelope {
        id: SESSION_CACHE_VERIFIER_RECORD_ID.into(),
        kind: "session-cache-verifier".into(),
        revision: SESSION_CACHE_VERIFIER_REVISION,
        deleted: false,
        crypto_suite: CRYPTO_SUITE.into(),
        aad_version: AAD_VERSION,
        nonce: STANDARD.encode(envelope.nonce),
        ciphertext: STANDARD.encode(&envelope.ciphertext),
    })
}

fn verify_session_cache_verifier(
    vek: &SecretKey,
    vault_id: &str,
    read_txn: &ReadTransaction,
) -> Result<(), VaultError> {
    let meta_table = read_txn.open_table(VAULT_META).map_err(VaultError::from)?;
    let Some(verifier_bytes) = meta_table.get(SESSION_CACHE_VERIFIER_META_KEY)? else {
        return Err(VaultError::InvalidData(
            "session cache verifier missing for empty vault".into(),
        ));
    };
    let stored: StoredEnvelope = serde_json::from_slice(verifier_bytes.value())?;
    let record_key = derive_record_key(
        vek,
        record_info_bytes(SESSION_CACHE_VERIFIER_RECORD_ID, SESSION_CACHE_VERIFIER_REVISION)
            .as_bytes(),
    )?;
    let envelope = parse_envelope(&stored)?;
    let aad = record_aad_string(
        vault_id,
        SESSION_CACHE_VERIFIER_RECORD_ID,
        SESSION_CACHE_VERIFIER_REVISION,
    );
    let plaintext = decrypt_record(&record_key, &envelope, aad.as_bytes())?;
    if plaintext.as_slice() != SESSION_CACHE_VERIFIER_PLAINTEXT {
        return Err(VaultError::InvalidData(
            "session cache verifier plaintext mismatch".into(),
        ));
    }
    Ok(())
}

fn decrypt_first_live_record(
    vek: &SecretKey,
    vault_id: &str,
    read_txn: &ReadTransaction,
) -> Result<(), VaultError> {
    let records = match read_txn.open_table(RECORDS) {
        Ok(table) => table,
        Err(redb::TableError::TableDoesNotExist(_)) => {
            return Err(VaultError::InvalidData("no records table".into()));
        }
        Err(error) => return Err(VaultError::from(error)),
    };

    for entry in records.iter()? {
        let (_, value): (redb::AccessGuard<&str>, redb::AccessGuard<&[u8]>) = entry?;
        let stored: StoredEnvelope = serde_json::from_slice(value.value())?;
        if stored.deleted {
            continue;
        }
        decrypt_stored(vek, vault_id, &stored)?;
        return Ok(());
    }

    Err(VaultError::InvalidData("no live records to verify VEK".into()))
}

fn live_record_count(read_txn: &ReadTransaction) -> Result<u64, VaultError> {
    let records = match read_txn.open_table(RECORDS) {
        Ok(t) => t,
        Err(redb::TableError::TableDoesNotExist(_)) => return Ok(0),
        Err(e) => return Err(VaultError::from(e)),
    };

    let mut count = 0u64;
    for entry in records.iter()? {
        let (_, value): (redb::AccessGuard<&str>, redb::AccessGuard<&[u8]>) = entry?;
        let stored: StoredEnvelope = serde_json::from_slice(value.value())?;
        if !stored.deleted {
            count += 1;
        }
    }
    Ok(count)
}

fn encode_recovery_key(bytes: &[u8; 32]) -> String {
    let hex: Vec<char> = bytes
        .iter()
        .flat_map(|b| {
            let hi = char::from_digit((b >> 4) as u32, 16)
                .unwrap()
                .to_ascii_uppercase();
            let lo = char::from_digit((b & 0xf) as u32, 16)
                .unwrap()
                .to_ascii_uppercase();
            [hi, lo]
        })
        .collect();
    hex.chunks(4)
        .map(|c| c.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join("-")
}

fn parse_recovery_key(s: &str) -> Option<[u8; 32]> {
    let clean: String = s
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if clean.len() != 64 {
        return None;
    }
    let b = clean.as_bytes();
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        let hi = hex_nibble(b[i * 2])?;
        let lo = hex_nibble(b[i * 2 + 1])?;
        *byte = (hi << 4) | lo;
    }
    Some(out)
}

fn hex_nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

fn decrypt_stored(
    vek: &SecretKey,
    vault_id: &str,
    stored: &StoredEnvelope,
) -> Result<PlaintextRecord, VaultError> {
    let record_key = derive_record_key(
        vek,
        record_info_bytes(&stored.id, stored.revision).as_bytes(),
    )?;
    let envelope = parse_envelope(stored)?;
    let aad = record_aad_string(vault_id, &stored.id, stored.revision);
    let plaintext = decrypt_record(&record_key, &envelope, aad.as_bytes())?;
    let mut record: PlaintextRecord = serde_json::from_slice(&plaintext)?;
    normalize_record_credential(&mut record);
    Ok(record)
}

fn validate_vault_database(path: &Path) -> Result<(), VaultError> {
    let db = Database::open(path)
        .map_err(|_| VaultError::InvalidData("Import file is not a valid vault.".into()))?;
    let read_txn = db
        .begin_read()
        .map_err(|e| VaultError::InvalidData(format!("Import file cannot be read: {e}")))?;

    // Verify vault_meta table exists and contains a non-empty vault_id and parseable meta row.
    let vm = read_txn
        .open_table(VAULT_META)
        .map_err(|_| VaultError::InvalidData("Import file is missing vault metadata.".into()))?;
    let vault_id_bytes = vm
        .get("vault_id")
        .map_err(|e| VaultError::InvalidData(format!("Import file vault_id unreadable: {e}")))?
        .ok_or_else(|| VaultError::InvalidData("Import file has no vault_id.".into()))?;
    if vault_id_bytes.value().is_empty() {
        return Err(VaultError::InvalidData("Import file vault_id is empty.".into()));
    }
    let meta_bytes = vm
        .get("meta")
        .map_err(|e| VaultError::InvalidData(format!("Import file meta row unreadable: {e}")))?
        .ok_or_else(|| VaultError::InvalidData("Import file has no meta row.".into()))?;
    serde_json::from_slice::<VaultMeta>(meta_bytes.value())
        .map_err(|e| VaultError::InvalidData(format!("Import file meta row is malformed: {e}")))?;

    // Verify key_slots table exists and contains the passphrase slot.
    let ks = read_txn
        .open_table(KEY_SLOTS)
        .map_err(|_| VaultError::InvalidData("Import file is missing key slots.".into()))?;
    let slot = ks
        .get(SLOT_PASSPHRASE)
        .map_err(|e| VaultError::InvalidData(format!("Import file passphrase slot unreadable: {e}")))?
        .ok_or_else(|| VaultError::InvalidData("Import file has no passphrase key slot.".into()))?;
    if slot.value().is_empty() {
        return Err(VaultError::InvalidData("Import file passphrase slot is empty.".into()));
    }

    read_txn
        .open_table(RECORDS)
        .map_err(|_| VaultError::InvalidData("Import file is missing records table.".into()))?;
    Ok(())
}

fn copy_file_synced(src: &Path, dest: &Path) -> Result<(), VaultError> {
    std::fs::copy(src, dest)
        .map_err(|e| VaultError::InvalidData(format!("import copy failed: {e}")))?;
    sync_file(dest)
}

fn sync_file(path: &Path) -> Result<(), VaultError> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "windows")]
    {
        // Windows may return "Access is denied" for sync_all on a read-only handle.
        // Requesting write access avoids false failures during import/export backup sync.
        options.write(true);
    }

    options
        .open(path)
        .and_then(|file| file.sync_all())
        .map_err(|e| VaultError::InvalidData(format!("sync failed for {path:?}: {e}")))
}

#[cfg(not(target_os = "windows"))]
fn sync_parent_dir(path: &Path) -> Result<(), VaultError> {
    if let Some(parent) = path.parent() {
        std::fs::File::open(parent)
            .and_then(|file| file.sync_all())
            .map_err(|e| VaultError::InvalidData(format!("parent directory sync failed: {e}")))?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn sync_parent_dir(_path: &Path) -> Result<(), VaultError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::session_cache;

    struct TestVault {
        service: VaultService,
        dir: PathBuf,
    }

    impl TestVault {
        fn new() -> Self {
            let dir = std::env::temp_dir()
                .join(format!("zync-vault-store-test-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&dir).expect("create temp vault dir");
            let service = VaultService::new(dir.clone());
            Self { service, dir }
        }
    }

    impl Drop for TestVault {
        fn drop(&mut self) {
            let replacement = VaultService::new(PathBuf::new());
            let old_service = std::mem::replace(&mut self.service, replacement);
            drop(old_service);
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn initialized_test_vault() -> TestVault {
        let mut vault = TestVault::new();
        vault
            .service
            .initialize("correct horse battery staple", false)
            .expect("initialize vault");
        vault
    }

    #[test]
    fn initialize_rejects_short_passphrase() {
        let mut vault = TestVault::new();
        let err = vault.service.initialize("short", false).unwrap_err();
        assert!(matches!(
            err,
            VaultError::InvalidPassphraseLength { min }
            if min == PASSPHRASE_MIN_LENGTH
        ));
    }

    #[test]
    fn item_create_rejects_blank_secret_values() {
        let vault = initialized_test_vault();
        let secret_values = BTreeMap::from([("password".into(), "   ".into())]);

        let result = vault
            .service
            .item_create_with_secret_values(
                "blank password",
                "ssh-password",
                &secret_values,
                None,
                None,
            );

        assert!(matches!(result, Err(VaultError::InvalidData(_))));
    }

    #[test]
    fn item_update_rejects_blank_secret_values() {
        let vault = initialized_test_vault();
        let item = vault
            .service
            .item_create("password", "ssh-password", "secret", None)
            .expect("create item");
        let secret_values = BTreeMap::from([("password".into(), "\t".into())]);

        let result = vault
            .service
            .item_update_with_secret_values(
                &item.id,
                "blank password",
                "ssh-password",
                &secret_values,
                None,
                None,
            );

        assert!(matches!(result, Err(VaultError::InvalidData(_))));
    }

    #[test]
    fn sync_create_rejects_blank_secret_values() {
        let vault = initialized_test_vault();
        let secret_values = BTreeMap::from([("password".into(), " ".into())]);

        let result = vault.service.item_create_from_sync(
            "blank synced password",
            "ssh-password",
            &secret_values,
            None,
            None,
            "credential-sync-blank",
            1,
            1,
        );

        assert!(matches!(result, Err(VaultError::InvalidData(_))));
    }

    #[test]
    fn sync_update_rejects_blank_secret_values() {
        let vault = initialized_test_vault();
        let item = vault
            .service
            .item_create("password", "ssh-password", "secret", None)
            .expect("create item");
        let secret_values = BTreeMap::from([("password".into(), "\n".into())]);

        let result = vault.service.item_apply_sync_restore(
            &item.id,
            item.logical_id.as_deref().expect("logical id"),
            "blank synced password",
            "ssh-password",
            &secret_values,
            None,
            None,
            2,
            item.updated_at.saturating_add(1),
        );

        assert!(matches!(result, Err(VaultError::InvalidData(_))));
    }

    #[test]
    fn item_update_records_revision_history_without_current_revision() {
        let vault = initialized_test_vault();
        let item = vault
            .service
            .item_create_with_logical_id(
                "prod key",
                "ssh-private-key",
                "secret-v1",
                Some("initial note"),
                Some("credential-prod"),
            )
            .expect("create item");

        vault
            .service
            .item_update(
                &item.id,
                "prod key rotated",
                "ssh-private-key",
                "secret-v2",
                Some("rotated note"),
            )
            .expect("rotate item");
        let live = vault.service.item_get(&item.id).expect("get live item");
        let history = vault
            .service
            .item_revision_history(&item.id)
            .expect("load revision history");

        assert_eq!(live.revision, 2);
        assert_eq!(primary_secret_value(&live), Some("secret-v2"));
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].revision, 1);
        assert_eq!(history[0].label, "prod key");
        assert_eq!(history[0].kind, "ssh-private-key");
        assert_ne!(
            history[0].secret_fingerprint,
            vault.service.record_secret_fingerprint(&live).unwrap()
        );
    }

    #[test]
    fn named_private_key_secrets_persist_and_restore_without_legacy_secret_blob() {
        use crate::vault::credential::{PASSPHRASE_FIELD, PRIVATE_KEY_FIELD};

        let vault = initialized_test_vault();
        let secret_values = BTreeMap::from([
            (PRIVATE_KEY_FIELD.to_string(), "private-key-data".to_string()),
            (PASSPHRASE_FIELD.to_string(), "key-passphrase".to_string()),
        ]);
        let item = vault
            .service
            .item_create_with_secret_values(
                "prod key",
                "ssh-private-key",
                &secret_values,
                None,
                Some("credential-prod-key"),
            )
            .expect("create named-secret credential");
        let loaded = vault.service.item_get(&item.id).expect("load credential");

        assert!(loaded.secret.is_empty());
        assert_eq!(loaded.secret_values, secret_values);
        assert_eq!(
            loaded
                .credential
                .as_ref()
                .expect("typed credential")
                .fields
                .iter()
                .map(|field| field.value_ref.as_deref())
                .collect::<Vec<_>>(),
            vec![Some("secret:privateKey"), Some("secret:passphrase")]
        );
    }

    #[test]
    fn record_secret_fingerprint_changes_when_secondary_secret_changes() {
        use crate::vault::credential::{PASSPHRASE_FIELD, PRIVATE_KEY_FIELD};

        let vault = initialized_test_vault();
        let first = PlaintextRecord {
            id: "item-1".to_string(),
            logical_id: Some("cred-1".to_string()),
            kind: "ssh-private-key".to_string(),
            label: "prod key".to_string(),
            secret: String::new(),
            secret_values: BTreeMap::from([
                (PRIVATE_KEY_FIELD.to_string(), "private-key-data".to_string()),
                (PASSPHRASE_FIELD.to_string(), "passphrase-a".to_string()),
            ]),
            notes: None,
            credential: None,
            revision: 1,
            created_at: 1,
            updated_at: 1,
        };
        let second = PlaintextRecord {
            id: "item-1".to_string(),
            logical_id: Some("cred-1".to_string()),
            kind: "ssh-private-key".to_string(),
            label: "prod key".to_string(),
            secret: String::new(),
            secret_values: BTreeMap::from([
                (PRIVATE_KEY_FIELD.to_string(), "private-key-data".to_string()),
                (PASSPHRASE_FIELD.to_string(), "passphrase-b".to_string()),
            ]),
            notes: None,
            credential: None,
            revision: 1,
            created_at: 1,
            updated_at: 1,
        };

        let first_fp = vault
            .service
            .record_secret_fingerprint(&first)
            .expect("fingerprint first secret set");
        let second_fp = vault
            .service
            .record_secret_fingerprint(&second)
            .expect("fingerprint second secret set");

        assert_ne!(first_fp, second_fp);
    }

    #[test]
    fn item_restore_revision_preserves_logical_id_and_snapshots_current_value() {
        let vault = initialized_test_vault();
        let item = vault
            .service
            .item_create_with_logical_id(
                "prod password",
                "ssh-password",
                "secret-v1",
                Some("first"),
                Some("credential-prod-password"),
            )
            .expect("create item");

        vault
            .service
            .item_update(
                &item.id,
                "prod password v2",
                "ssh-password",
                "secret-v2",
                Some("second"),
            )
            .expect("rotate to v2");
        vault
            .service
            .item_update(
                &item.id,
                "prod password v3",
                "ssh-password",
                "secret-v3",
                Some("third"),
            )
            .expect("rotate to v3");

        let restored = vault
            .service
            .item_restore_revision(&item.id, 1)
            .expect("restore v1");
        let live = vault.service.item_get(&item.id).expect("get restored live item");
        let relinked = vault
            .service
            .item_get_by_logical_id("credential-prod-password")
            .expect("logical id still resolves");
        let history = vault
            .service
            .item_revision_history(&item.id)
            .expect("load revision history after restore");

        assert_eq!(restored.id, item.id);
        assert_eq!(restored.revision, 4);
        assert_eq!(restored.logical_id.as_deref(), Some("credential-prod-password"));
        assert_eq!(primary_secret_value(&live), Some("secret-v1"));
        assert_eq!(live.label, "prod password");
        assert_eq!(live.notes.as_deref(), Some("first"));
        assert_eq!(relinked.id, item.id);

        let revisions: Vec<u64> = history.iter().map(|revision| revision.revision).collect();
        assert_eq!(revisions, vec![1, 2, 3]);
    }

    #[test]
    fn unlock_backfills_missing_logical_id_mapping_for_current_record() {
        let mut vault = initialized_test_vault();
        let item = vault
            .service
            .item_create_with_logical_id(
                "prod password",
                "ssh-password",
                "secret-v1",
                None,
                Some("credential-prod-password"),
            )
            .expect("create item");
        let db = vault.service.db.as_ref().expect("opened database");
        let write_txn = db.begin_write().expect("begin write");
        {
            let mut logical_ids = write_txn.open_table(LOGICAL_IDS).expect("open logical ids");
            logical_ids
                .remove("credential-prod-password")
                .expect("remove logical id");
        }
        write_txn.commit().expect("commit missing logical id");
        assert!(matches!(
            vault
                .service
                .item_get_by_logical_id("credential-prod-password"),
            Err(VaultError::RecordNotFound(_))
        ));

        vault.service.lock();
        vault
            .service
            .unlock("correct horse battery staple", false)
            .expect("unlock and backfill");
        let restored = vault
            .service
            .item_get_by_logical_id("credential-prod-password")
            .expect("logical id resolves after migration");
        assert_eq!(restored.id, item.id);
    }

    #[test]
    fn item_restore_revision_restores_historical_typed_credential() {
        use crate::vault::credential::{CredentialKind, CredentialMetadata};

        let vault = initialized_test_vault();
        let item = vault
            .service
            .item_create_with_logical_id(
                "prod key",
                "ssh-private-key",
                "secret-v1",
                None,
                Some("credential-prod-key"),
            )
            .expect("create item");
        let mut replacement = item.credential.clone().expect("typed credential");
        replacement.kind = CredentialKind::PluginDefined;
        replacement.metadata = CredentialMetadata {
            plugin_id: Some("com.example.current".into()),
            ..CredentialMetadata::default()
        };

        vault
            .service
            .item_apply_sync_restore(
                &item.id,
                "credential-prod-key",
                "prod key current",
                "plugin-defined",
                &secret_values_from_legacy("plugin-defined", "secret-v2"),
                None,
                Some(&replacement),
                2,
                item.updated_at.saturating_add(1),
            )
            .expect("apply current typed credential");

        let restored = vault
            .service
            .item_restore_revision(&item.id, 1)
            .expect("restore historical revision");
        let restored_credential = restored.credential.as_ref().expect("restored credential");

        assert_eq!(restored_credential.kind, CredentialKind::SshPrivateKey);
        assert_eq!(restored_credential.metadata.plugin_id, None);
    }

    #[test]
    fn explicit_lock_stays_locked_when_session_cache_remembers_device() {
        let mut vault = initialized_test_vault();
        vault
            .service
            .unlock("correct horse battery staple", true)
            .expect("unlock with remember on device");
        let vault_id = vault.service.meta.as_ref().expect("meta").vault_id.clone();

        vault.service.lock();
        let status = vault.service.status().expect("status after lock");
        assert!(
            matches!(status, VaultStatus::Locked { .. }),
            "explicit lock must not be undone by session cache restore"
        );
        session_cache::clear_session_cache(&vault_id).expect("cleanup");
    }

    #[test]
    fn verify_passphrase_does_not_clear_remembered_session_cache() {
        let mut vault = initialized_test_vault();
        vault
            .service
            .unlock("correct horse battery staple", true)
            .expect("unlock with remember on device");
        let vault_id = vault.service.meta.as_ref().expect("meta").vault_id.clone();
        assert!(
            session_cache::has_session_cache(&vault_id).expect("has cache check")
        );

        vault.service.lock();
        vault
            .service
            .verify_passphrase("correct horse battery staple")
            .expect("verify passphrase");
        assert!(
            session_cache::has_session_cache(&vault_id).expect("has cache check"),
            "verify_passphrase must not clear remembered session cache"
        );
        session_cache::clear_session_cache(&vault_id).expect("cleanup");
    }

    #[test]
    fn session_cache_restore_empty_vault_with_verifier_record() {
        let mut vault = initialized_test_vault();
        vault
            .service
            .unlock("correct horse battery staple", true)
            .expect("unlock with remember on device");

        vault.service.vek = None;
        vault.service.meta = None;
        assert!(
            vault
                .service
                .try_unlock_from_session_cache()
                .expect("try cache unlock"),
            "empty vault should restore from cache when verifier record exists"
        );

        let vault_id = vault.service.meta.as_ref().expect("meta").vault_id.clone();
        session_cache::clear_session_cache(&vault_id).expect("cleanup");
    }

    #[test]
    fn session_cache_restore_rejects_wrong_vek_for_empty_vault() {
        let mut vault = initialized_test_vault();
        vault
            .service
            .unlock("correct horse battery staple", true)
            .expect("unlock with remember on device");
        let vault_id = vault.service.meta.as_ref().expect("meta").vault_id.clone();
        let wrong_vek = SecretKey::from_bytes([2u8; 32]);
        session_cache::save_session_cache(&vault_id, &wrong_vek).expect("save wrong vek");

        vault.service.vek = None;
        vault.service.meta = None;
        assert!(
            !vault
                .service
                .try_unlock_from_session_cache()
                .expect("try cache unlock"),
            "wrong cached VEK must not unlock empty vault"
        );
        assert!(
            !session_cache::has_session_cache(&vault_id).expect("cache cleared"),
            "invalid cache entry should be cleared"
        );
    }

    #[test]
    fn session_cache_restore_rejects_wrong_vek_for_nonempty_vault() {
        let mut vault = initialized_test_vault();
        vault
            .service
            .item_create("prod password", "ssh-password", "secret", None)
            .expect("create item");
        let vault_id = vault.service.meta.as_ref().expect("meta").vault_id.clone();
        let wrong_vek = SecretKey::from_bytes([1u8; 32]);
        session_cache::save_session_cache(&vault_id, &wrong_vek).expect("save wrong vek");

        // Clear in-memory unlock without suppressing session-cache verification.
        vault.service.vek = None;
        vault.service.meta = None;
        assert!(
            !vault
                .service
                .try_unlock_from_session_cache()
                .expect("try cache unlock"),
            "wrong cached VEK must not unlock vault"
        );
        assert!(
            !session_cache::has_session_cache(&vault_id).expect("cache cleared"),
            "invalid cache entry should be cleared"
        );
    }

    #[test]
    fn recovery_key_unlock_runs_compatibility_migration_without_transaction_conflict() {
        let mut vault = initialized_test_vault();
        vault
            .service
            .item_create("prod password", "ssh-password", "secret", None)
            .expect("create item");
        let recovery_key = vault
            .service
            .generate_recovery_key()
            .expect("generate recovery key");

        vault.service.lock();
        let status = vault
            .service
            .unlock_with_recovery_key(&recovery_key, false)
            .expect("unlock with recovery key");

        assert!(matches!(
            status,
            VaultStatus::Unlocked { item_count: 1, .. }
        ));
    }
}
