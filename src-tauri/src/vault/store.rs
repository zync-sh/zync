use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine};
use rand_core::{OsRng, RngCore};
use redb::{Database, ReadTransaction, ReadableTable};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

use crate::vault::crypto::{
    decrypt_record, derive_kek, derive_record_key, derive_secret_fingerprint, encrypt_record,
    generate_salt, generate_vek, EncryptedEnvelope, KdfParams, SecretKey,
};
use crate::vault::error::VaultError;
use crate::vault::schema::{
    KEY_SLOTS, LOGICAL_IDS, RECORDS, SLOT_PASSPHRASE, SLOT_RECOVERY, VAULT_META,
};
use crate::vault::types::{PlaintextRecord, StoredEnvelope, VaultItemMeta, VaultMeta, VaultStatus};

const CRYPTO_SUITE: &str = "xchacha20poly1305-argon2id-v1";
const AAD_VERSION: u32 = 1;
const SCHEMA_VERSION: u32 = 1;

// ── Service ───────────────────────────────────────────────────────────────────

pub struct VaultService {
    db: Option<Database>,
    vek: Option<SecretKey>,
    /// Cached after initialize/unlock; cleared on lock.
    meta: Option<VaultMeta>,
    data_dir: PathBuf,
}

impl VaultService {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            db: None,
            vek: None,
            meta: None,
            data_dir,
        }
    }

    fn vault_path(&self) -> PathBuf {
        self.data_dir.join("vault.redb")
    }

    /// Opens an existing vault.redb without unlocking. No-op if already open.
    fn try_open(&mut self) -> Result<(), VaultError> {
        if self.db.is_some() {
            return Ok(());
        }
        let path = self.vault_path();
        if path.exists() {
            self.db = Some(Database::open(&path)?);
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

        if self.vek.is_none() {
            return Ok(VaultStatus::Locked { vault_id });
        }

        let item_count = live_record_count(&read_txn)?;

        Ok(VaultStatus::Unlocked {
            vault_id,
            item_count,
        })
    }

    // ── Initialize ────────────────────────────────────────────────────────────

    pub fn initialize(&mut self, passphrase: &str) -> Result<VaultStatus, VaultError> {
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
        }
        write_txn.commit()?;

        self.db = Some(db);
        self.vek = Some(vek);
        self.meta = Some(meta);

        Ok(VaultStatus::Unlocked {
            vault_id,
            item_count: 0,
        })
    }

    // ── Unlock ────────────────────────────────────────────────────────────────

    pub fn unlock(&mut self, passphrase: &str) -> Result<VaultStatus, VaultError> {
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

        let vault_id = meta.vault_id.clone();
        self.vek = Some(SecretKey::from_bytes(vek_arr));
        vek_arr.zeroize();
        self.meta = Some(meta);

        // Count existing records for the returned status
        let item_count = live_record_count(&read_txn)?;

        Ok(VaultStatus::Unlocked {
            vault_id,
            item_count,
        })
    }

    // ── Lock ──────────────────────────────────────────────────────────────────

    pub fn lock(&mut self) {
        // SecretKey implements ZeroizeOnDrop — drops immediately here.
        self.vek = None;
        self.meta = None;
    }

    /// Returns the vault ID if the vault is unlocked (meta is cached).
    pub fn vault_id(&self) -> Option<String> {
        self.meta.as_ref().map(|m| m.vault_id.clone())
    }

    pub fn secret_fingerprint(&self, secret: &str) -> Result<String, VaultError> {
        let vek = self.vek.as_ref().ok_or(VaultError::Locked)?;
        derive_secret_fingerprint(vek, secret).map_err(VaultError::from)
    }

    pub fn item_meta(&self, record: &PlaintextRecord) -> Result<VaultItemMeta, VaultError> {
        Ok(VaultItemMeta {
            id: record.id.clone(),
            logical_id: Self::record_logical_id(record),
            kind: record.kind.clone(),
            label: record.label.clone(),
            secret_fingerprint: self.secret_fingerprint(&record.secret)?,
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
        let vek = self.vek.as_ref().ok_or(VaultError::Locked)?;
        let db = self.db.as_ref().ok_or(VaultError::NotInitialized)?;
        let meta = self.meta.as_ref().ok_or(VaultError::Locked)?;

        let id = Uuid::new_v4().to_string();
        let logical_id = logical_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let now = Self::now_secs();
        let revision = 1u64;

        let record = PlaintextRecord {
            id: id.clone(),
            logical_id: Some(logical_id),
            kind: kind.to_string(),
            label: label.to_string(),
            secret: secret.to_string(),
            notes: notes.map(str::to_string),
            revision,
            created_at: now,
            updated_at: now,
        };

        let plaintext = serde_json::to_vec(&record)?;
        let record_key = derive_record_key(vek, record_info_bytes(&id, revision).as_bytes())?;
        let aad = record_aad_string(&meta.vault_id, &id, revision);
        let envelope = encrypt_record(&record_key, &plaintext, aad.as_bytes())?;

        let stored = StoredEnvelope {
            id: id.clone(),
            kind: kind.to_string(),
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
        let existing = self.item_get(item_id)?;
        let vek = self.vek.as_ref().ok_or(VaultError::Locked)?;
        let db = self.db.as_ref().ok_or(VaultError::NotInitialized)?;
        let meta = self.meta.as_ref().ok_or(VaultError::Locked)?;

        let revision = existing.revision.saturating_add(1);
        let now = Self::now_secs();
        let record = PlaintextRecord {
            id: existing.id.clone(),
            logical_id: Some(Self::record_logical_id(&existing)),
            kind: kind.to_string(),
            label: label.to_string(),
            secret: secret.to_string(),
            notes: notes.map(str::to_string),
            revision,
            created_at: existing.created_at,
            updated_at: now,
        };

        let plaintext = serde_json::to_vec(&record)?;
        let record_key = derive_record_key(vek, record_info_bytes(item_id, revision).as_bytes())?;
        let aad = record_aad_string(&meta.vault_id, item_id, revision);
        let envelope = encrypt_record(&record_key, &plaintext, aad.as_bytes())?;
        let stored = StoredEnvelope {
            id: item_id.to_string(),
            kind: kind.to_string(),
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
            let _ = logical_ids.remove(logical_id.as_str());

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

    pub fn has_recovery_key(&self) -> Result<bool, VaultError> {
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
    pub fn unlock_with_recovery_key(&mut self, key: &str) -> Result<VaultStatus, VaultError> {
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

        let vault_id = meta.vault_id.clone();
        self.vek = Some(SecretKey::from_bytes(vek_arr));
        vek_arr.zeroize();
        self.meta = Some(meta);

        let item_count = live_record_count(&read_txn)?;

        Ok(VaultStatus::Unlocked {
            vault_id,
            item_count,
        })
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

fn live_record_count(read_txn: &ReadTransaction) -> Result<u64, VaultError> {
    if let Ok(meta_table) = read_txn.open_table(VAULT_META) {
        if let Some(meta_bytes) = meta_table.get("meta")? {
            let meta: VaultMeta = serde_json::from_slice(meta_bytes.value())?;
            if let Some(count) = meta.live_records {
                return Ok(count);
            }
        }
    }

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
    Ok(serde_json::from_slice(&plaintext)?)
}

fn validate_vault_database(path: &Path) -> Result<(), VaultError> {
    let db = Database::open(path)
        .map_err(|_| VaultError::InvalidData("Import file is not a valid vault.".into()))?;
    let read_txn = db
        .begin_read()
        .map_err(|e| VaultError::InvalidData(format!("Import file cannot be read: {e}")))?;
    read_txn
        .open_table(VAULT_META)
        .map_err(|_| VaultError::InvalidData("Import file is missing vault metadata.".into()))?;
    read_txn
        .open_table(KEY_SLOTS)
        .map_err(|_| VaultError::InvalidData("Import file is missing key slots.".into()))?;
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
    std::fs::OpenOptions::new()
        .read(true)
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
