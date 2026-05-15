# Vault Sync Phase 2 Smoke Test

## Scope
Validate provider abstraction + Google adapter + SyncProfile persistence + normalized status/error path.

> Important: cloud backup stores encrypted vault data only. It does **not** store vault passphrase or recovery key material.

## Preconditions
- Build includes latest Phase 2 changes.
- Google OAuth app is configured in `src-tauri/.env` (`GOOGLE_CLIENT_ID`, optional `GOOGLE_CLIENT_SECRET`).
- App closed before reset.

## 0) Clean test state

### Windows
```powershell
./scripts/reset-vault-test-data.ps1
```

### macOS/Linux
```bash
./scripts/reset-vault-test-data.sh
```

Then also disconnect Google from app (if still connected) and restart app.

## 1) Baseline boot
1. Start app.
2. Open **Vault** tab.
3. Expected:
   - Vault can be initialized/unlocked.
   - Google row shows **Not connected**.
   - No crash in console.

## 2) Connect flow
1. Click **Connect** under Google Drive.
2. Complete OAuth.
3. Expected:
   - Status becomes **Connected**.
   - Optional email appears.
   - Backend writes `sync-profiles.json` in app data dir with provider `google` and `connected=true`.

## 2.1) Set up provider sync key
1. Click **Set up Sync Key**.
2. Choose **Use Local Vault passphrase**.
3. Enter and confirm the current Local Vault passphrase.
4. Expected:
   - Wrong passphrase is rejected with `sync_collection_passphrase_mismatch`.
   - Correct passphrase configures the provider collection.
   - `sync-collection-google.json` contains wrapped-key metadata (`keyWrapSalt`, `keyWrapNonce`,
     `keyWrapCiphertext`) but no plaintext passphrase or provider collection key.
   - If **Generate provider sync recovery key** is enabled, a Google Sync Recovery Key modal appears once.
   - The manifest contains recovery wrap metadata (`recoveryKeyWrapSalt`, `recoveryKeyWrapNonce`,
     `recoveryKeyWrapCiphertext`) but not the recovery key itself.
   - If an older local manifest has neither keychain cache nor wrapped-key metadata, setup fails
     with `sync_collection_key_missing` instead of silently creating an incompatible key.

## 2.2) Provider sync key recovery
1. Close the app.
2. Remove only the OS keychain entry for `Zync Sync Collection Keys` for this provider collection
   (or use a test environment where the keychain cache is absent).
3. Reopen Vault.
4. Expected:
   - Google collection remains configured but shows the sync key cache as locked.
   - Backup/Restore/Sync item actions are disabled until the sync key is unlocked.
5. Click **Unlock Sync Key** and enter either:
   - the sync/local vault passphrase, or
   - the saved Google Sync Recovery Key.
6. Expected:
   - Correct secret restores the device key cache.
   - Wrong recovery key fails with `sync_collection_recovery_key_unwrap_failed`.
   - No passphrase or recovery key is persisted in provider storage.

## 3) Upload backup
1. With unlocked vault, click **Backup to Drive**.
2. Expected:
   - Success toast.
   - `lastSync` updates in UI.
   - `sync-profiles.json` has updated `lastSync` and cleared `lastError*`.

## 4) Restore credentials (non-destructive)
1. Click **Restore Credentials** and confirm.
2. Expected:
   - Confirm modal shows preview counts (new/update/delete/stale/conflict/failed) before restore.
   - If conflicts exist, a conflict modal opens with per-credential checkboxes.
     - unchecked = keep local
     - checked = apply remote for those conflict logical IDs
   - Success/info toast with counts (`new`, `updated`, `skipped`, `failed`).
   - Conflict count is surfaced separately; conflicting records are skipped, not silently overwritten.
   - Tombstone records (when present) delete matching local credentials only when tombstone revision/timestamp is newer.
   - Credentials are merged into the current unlocked local vault by `logicalId`.
   - Local vault file is **not replaced** and vault does not auto-lock.
   - `lastSync` updates.

## 4.1) Legacy full-file restore (compatibility path)
`sync_download` still exists as a backend compatibility path for full `vault.redb`
replace-restore disaster recovery, but it is not the primary UI flow for provider
sync collection restore.

## 5) Disconnect flow
1. Click **Disconnect** and confirm.
2. Expected:
   - UI returns to **Not connected**.
   - Profile persists with `connected=false`.
   - If remote revoke fails, message should carry normalized code/message and local disconnect still completes.

## 6) Compatibility fallback check
1. Remove/rename `sync-profiles.json` only (keep old `sync-google.json` token file if present).
2. Relaunch app and open Vault tab.
3. Expected:
   - Status still resolves (legacy snapshot fallback).
   - New `sync-profiles.json` is recreated.

## 7) Error normalization check
Trigger any sync failure (network off / invalid token / revoked grant) and verify:
- Backend response shape is normalized (`[error_code] message` for thrown errors).
- Local vault/fs failures are also normalized (e.g. `vault_import_failed`, `sync_temp_write_failed`, `vault_status_failed`) instead of raw uncoded strings.
- Frontend extracts and keeps `errorCode` + readable message.
- Vault sync card can show warning text without breaking actions.

## 8) Restore convergence check (critical)
1. Ensure at least one remote credential record exists for Google sync.
2. Run **Restore Credentials** once and note result counts.
3. Run **Restore Credentials** immediately again with no local edits.
4. Expected:
   - Second run should not keep re-applying the same record as updated/new.
   - Most records should move to skipped/stale unless remote changed.
   - This confirms local records preserved remote `revision`/`updated_at` metadata.

## 9) Cross-platform finalize check
On Windows, macOS, and Linux:
1. Connect provider and perform setup/unlock/backup/restore flows.
2. Restart app and repeat.
3. Expected:
   - No sync profile/manifest corruption.
   - No destructive replace of valid files on non-conflict rename errors.
   - No leftover temp artifacts (`*.tmp`) after successful operations.

## Pass criteria
- Connect/disconnect/upload/restore all function through provider interface.
- SyncProfile file is canonical source of provider status metadata.
- Legacy fallback path does not break existing users.
- Error/state handling remains stable across refresh/restart.
- Restore converges (same remote payload is not repeatedly re-applied).
