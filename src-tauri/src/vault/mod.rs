//! Vault subsystem for encrypted local credential storage.
//!
//! `commands` exposes Tauri IPC, `crypto` owns KDF/AEAD helpers, `schema`
//! defines redb tables and key-slot identifiers, `store` coordinates encrypted
//! redb persistence, `secure_to_vault` moves unsecured credentials into vault records,
//! while `types` and `error` define the public data/error contracts. Secrets
//! should stay in backend memory only and be zeroized where practical.

pub mod commands;
pub mod credential;
pub(crate) mod crypto;
pub mod error;
pub(crate) mod secure_to_vault;
pub(crate) mod schema;
pub(crate) mod store;
pub mod types;
