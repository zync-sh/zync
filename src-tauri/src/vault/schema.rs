use redb::TableDefinition;

pub const SLOT_PASSPHRASE: &str = "passphrase";
#[allow(dead_code)]
pub const SLOT_DEVICE: &str = "device";
pub const SLOT_RECOVERY: &str = "recovery";

/// vault_id, schema_version, crypto_suite, salt, kdf params, timestamps.
/// Key: string field name, Value: raw bytes (vault_id) or JSON bytes (meta).
pub const VAULT_META: TableDefinition<&str, &[u8]> = TableDefinition::new("vault_meta");

/// Per-slot wrapped VEK material.
/// Key: slot id (`SLOT_PASSPHRASE`, `SLOT_DEVICE`, `SLOT_RECOVERY`), Value: JSON StoredEnvelope bytes.
pub const KEY_SLOTS: TableDefinition<&str, &[u8]> = TableDefinition::new("key_slots");

/// Encrypted vault records.
/// Key: record UUID, Value: JSON StoredEnvelope bytes.
pub const RECORDS: TableDefinition<&str, &[u8]> = TableDefinition::new("records");

/// Logical credential id -> physical record id index.
pub const LOGICAL_IDS: TableDefinition<&str, &str> = TableDefinition::new("logical_ids");
