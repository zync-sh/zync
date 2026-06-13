use crate::vault::crypto::VaultCryptoError;

#[derive(Debug)]
pub enum VaultError {
    NotInitialized,
    AlreadyInitialized,
    Locked,
    WrongPassphrase,
    InvalidPassphraseLength { min: usize },
    RecordNotFound(String),
    InvalidData(String),
    Crypto(VaultCryptoError),
    Storage(anyhow::Error),
    Serde(serde_json::Error),
}

impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotInitialized => write!(f, "Vault is not initialized"),
            Self::AlreadyInitialized => write!(f, "Vault is already initialized"),
            Self::Locked => write!(f, "Vault is locked"),
            Self::WrongPassphrase => write!(f, "Incorrect passphrase"),
            Self::InvalidPassphraseLength { min } => {
                write!(f, "Passphrase must be at least {min} characters")
            }
            Self::RecordNotFound(id) => write!(f, "Record not found: {id}"),
            Self::InvalidData(msg) => write!(f, "Invalid vault data: {msg}"),
            Self::Crypto(e) => write!(f, "Crypto error: {e}"),
            Self::Storage(e) => write!(f, "Storage error: {e}"),
            Self::Serde(e) => write!(f, "Serialization error: {e}"),
        }
    }
}

impl std::error::Error for VaultError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Crypto(e) => Some(e),
            Self::Storage(e) => Some(e.as_ref()),
            Self::Serde(e) => Some(e),
            _ => None,
        }
    }
}

impl From<VaultCryptoError> for VaultError {
    fn from(e: VaultCryptoError) -> Self {
        Self::Crypto(e)
    }
}

impl From<serde_json::Error> for VaultError {
    fn from(e: serde_json::Error) -> Self {
        Self::Serde(e)
    }
}

macro_rules! impl_from_storage {
    ($t:ty) => {
        impl From<$t> for VaultError {
            fn from(e: $t) -> Self {
                Self::Storage(anyhow::Error::new(e))
            }
        }
    };
}

impl_from_storage!(redb::DatabaseError);
impl_from_storage!(redb::TransactionError);
impl_from_storage!(redb::TableError);
impl_from_storage!(redb::CommitError);
impl_from_storage!(redb::StorageError);
