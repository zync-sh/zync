use super::types::{
    ProviderCapabilities, ProviderCredentialObject, ProviderIdentity, ProviderStatusSnapshot,
    SyncError, SyncProviderKind, SyncResult,
};
use async_trait::async_trait;

#[async_trait]
pub trait VaultProviderV1: Send + Sync {
    fn kind(&self) -> SyncProviderKind;
    fn capabilities(&self) -> ProviderCapabilities;

    async fn connect(&self, app: &tauri::AppHandle) -> SyncResult<ProviderIdentity>;
    async fn disconnect(&self, app: &tauri::AppHandle) -> SyncResult<()>;
    async fn status(&self, app: &tauri::AppHandle) -> SyncResult<ProviderStatusSnapshot>;

    async fn upload_vault_blob(&self, app: &tauri::AppHandle, payload: Vec<u8>) -> SyncResult<u64>;
    async fn download_vault_blob(&self, app: &tauri::AppHandle) -> SyncResult<(Vec<u8>, u64)>;
    async fn upload_credential_record(
        &self,
        app: &tauri::AppHandle,
        object_name: &str,
        payload: Vec<u8>,
    ) -> SyncResult<u64>;
    async fn list_credential_records(
        &self,
        app: &tauri::AppHandle,
        sync_collection_id: &str,
    ) -> SyncResult<Vec<ProviderCredentialObject>>;
    async fn read_credential_record(
        &self,
        app: &tauri::AppHandle,
        object: &ProviderCredentialObject,
    ) -> SyncResult<Vec<u8>>;
}

pub fn validate_provider_contract(provider: &dyn VaultProviderV1) -> SyncResult<()> {
    let kind = provider.kind();
    let parsed = SyncProviderKind::parse(kind.as_str()).ok_or_else(|| {
        SyncError::new(
            "provider_contract_invalid_kind",
            format!("Provider kind '{}' cannot be parsed", kind.as_str()),
        )
    })?;
    if parsed != kind {
        return Err(SyncError::new(
            "provider_contract_invalid_kind",
            format!(
                "Provider kind mismatch: declared '{}', parsed '{:?}'",
                kind.as_str(),
                parsed
            ),
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_test_capabilities(encryption_mode: EncryptionMode) -> ProviderCapabilities {
        ProviderCapabilities {
            supports_autosync: false,
            supports_incremental: true,
            supports_etag: false,
            supports_domains: false,
            max_object_size: None,
            encryption_mode,
        }
    }

    struct TestProvider {
        capabilities: ProviderCapabilities,
    }

    #[async_trait]
    impl VaultProviderV1 for TestProvider {
        fn kind(&self) -> SyncProviderKind {
            SyncProviderKind::Google
        }

        fn capabilities(&self) -> ProviderCapabilities {
            self.capabilities.clone()
        }

        async fn connect(&self, _app: &tauri::AppHandle) -> SyncResult<ProviderIdentity> {
            Err(SyncError::new("not_implemented", "not needed for contract test"))
        }

        async fn disconnect(&self, _app: &tauri::AppHandle) -> SyncResult<()> {
            Err(SyncError::new("not_implemented", "not needed for contract test"))
        }

        async fn status(&self, _app: &tauri::AppHandle) -> SyncResult<ProviderStatusSnapshot> {
            Err(SyncError::new("not_implemented", "not needed for contract test"))
        }

        async fn upload_vault_blob(
            &self,
            _app: &tauri::AppHandle,
            _payload: Vec<u8>,
        ) -> SyncResult<u64> {
            Err(SyncError::new("not_implemented", "not needed for contract test"))
        }

        async fn download_vault_blob(
            &self,
            _app: &tauri::AppHandle,
        ) -> SyncResult<(Vec<u8>, u64)> {
            Err(SyncError::new("not_implemented", "not needed for contract test"))
        }

        async fn upload_credential_record(
            &self,
            _app: &tauri::AppHandle,
            _object_name: &str,
            _payload: Vec<u8>,
        ) -> SyncResult<u64> {
            Err(SyncError::new("not_implemented", "not needed for contract test"))
        }

        async fn list_credential_records(
            &self,
            _app: &tauri::AppHandle,
            _sync_collection_id: &str,
        ) -> SyncResult<Vec<ProviderCredentialObject>> {
            Err(SyncError::new("not_implemented", "not needed for contract test"))
        }

        async fn read_credential_record(
            &self,
            _app: &tauri::AppHandle,
            _object: &ProviderCredentialObject,
        ) -> SyncResult<Vec<u8>> {
            Err(SyncError::new("not_implemented", "not needed for contract test"))
        }
    }

    #[test]
    fn validate_provider_contract_accepts_valid_provider() {
        let provider = TestProvider {
            capabilities: make_test_capabilities(EncryptionMode::AppEncryptedOnly),
        };
        validate_provider_contract(&provider).expect("valid provider should pass contract");
    }

    #[test]
    fn validate_provider_contract_accepts_enum_encryption_mode() {
        let provider = TestProvider {
            capabilities: make_test_capabilities(EncryptionMode::ProviderEncrypted),
        };
        validate_provider_contract(&provider).expect("enum mode should pass contract");
    }
}
