mod keyring;
mod lifecycle;
mod manifest;
mod wrap;

pub use keyring::{
    clear_collection_key_cache, collection_key_cache_metadata_fresh,
    enforce_collection_key_cache_ttl, load_collection_key, SYNC_COLLECTION_KEY_CACHE_TTL_SECS,
};
pub use lifecycle::{
    regenerate_recovery_key, set_collection_key_cache_ttl, setup_manifest,
    unlock_collection_key_with_passphrase, unlock_collection_key_with_recovery_key,
};
pub use manifest::{load_manifest, save_manifest};
pub use wrap::{
    collection_key_wrap_object_name, has_recovery_key_slot, remote_key_wrap_from_manifest,
    RemoteCollectionKeyWrapV1,
};

#[cfg(test)]
mod tests;
