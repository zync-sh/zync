import type { SyncKeyPolicyMode } from './syncIpc';
import { parseSyncInvokeError } from './syncError.js';

/** Matches backend `SYNC_COLLECTION_PASSPHRASE_MIN_LENGTH`. */
export const SYNC_PASSPHRASE_MIN_LENGTH = 12;

export function isLocalPassphrasePolicy(mode: SyncKeyPolicyMode): boolean {
  return mode === 'local-passphrase';
}

export function getSyncPassphraseLabel(mode: SyncKeyPolicyMode): string {
  return isLocalPassphrasePolicy(mode) ? 'Local Vault passphrase' : 'Google encryption passphrase';
}

export function validateSyncSetupPassphrase(args: {
  mode: SyncKeyPolicyMode;
  passphrase: string;
  confirmPassphrase: string;
  hasLocalVaultConfigured: boolean;
}): string | null {
  const trimmed = args.passphrase.trim();
  const trimmedConfirm = args.confirmPassphrase.trim();
  const label = getSyncPassphraseLabel(args.mode);

  if (trimmed.length < SYNC_PASSPHRASE_MIN_LENGTH) {
    return `${label} must be at least ${SYNC_PASSPHRASE_MIN_LENGTH} characters.`;
  }

  if (!isLocalPassphrasePolicy(args.mode) && trimmed !== trimmedConfirm) {
    return 'Passphrases do not match.';
  }

  if (isLocalPassphrasePolicy(args.mode) && !args.hasLocalVaultConfigured) {
    return 'Set up the local vault first, or use a custom sync passphrase for app-data sync.';
  }

  return null;
}

export function canSubmitSyncSetup(args: {
  mode: SyncKeyPolicyMode;
  passphrase: string;
  confirmPassphrase: string;
  hasLocalVaultConfigured: boolean;
  isSubmitting: boolean;
}): boolean {
  if (args.isSubmitting) return false;
  return validateSyncSetupPassphrase(args) === null;
}

export function formatSyncCollectionSetupError(error: unknown): string {
  const { code, message } = parseSyncInvokeError(error);

  if (code === 'sync_collection_passphrase_mismatch') {
    return message || 'Local Vault passphrase did not unlock this vault.';
  }
  if (code === 'vault_uninitialized') {
    return message || 'Initialize the local vault before setting up Google encryption.';
  }
  if (code === 'sync_collection_ambiguous_remote') {
    return message || 'Multiple encrypted backups were found on Google Drive. Choose which backup to link.';
  }
  if (code === 'sync_collection_id_not_found') {
    return message || 'The selected Google Drive backup could not be found. Refresh and try again.';
  }
  if (code === 'sync_collection_key_unrecoverable') {
    return (
      message ||
      'This Drive backup cannot be unlocked after a local reset — the collection key is missing from this device. Create a new empty collection and re-upload, or recover from a PC that still has the key.'
    );
  }

  return message || 'Failed to set up Google encryption.';
}

export function formatSyncCollectionIdLabel(syncCollectionId: string): string {
  const trimmed = syncCollectionId.trim();
  if (trimmed.length <= 16) return trimmed;
  return `${trimmed.slice(0, 8)}…${trimmed.slice(-4)}`;
}