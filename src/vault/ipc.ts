import { invoke } from '@tauri-apps/api/core';

export type VaultStatus =
  | { status: 'uninitialized' }
  | { status: 'locked'; vaultId: string; itemCount: number }
  | { status: 'unlocked'; vaultId: string; itemCount: number };

export interface VaultItem {
  id: string;
  logicalId: string;
  kind: string;
  label: string;
  secretFingerprint: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface VaultItemSecret {
  id: string;
  logicalId?: string;
  kind: string;
  label: string;
  secret: string;
  notes?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface VaultBackfillResult {
  updated: number;
  relinkedItemIds: number;
  skippedMissingItems: number;
}

export interface RevisionMeta {
  itemId: string;
  revision: number;
  label: string;
  kind: string;
  secretFingerprint: string;
  createdAt: number;
  rotatedAt: number;
}

export interface SecureToVaultCandidate {
  connectionId: string;
  connectionName: string;
  host: string;
  secureKind: string;
}

export interface SecureToVaultPreview {
  candidates: SecureToVaultCandidate[];
  alreadySecured: number;
  skippedNoFile: number;
}

export interface SecureToVaultResult {
  secured: number;
  skipped: number;
  alreadyDone: number;
  backupPath?: string;
}

export const vaultIpc = {
  status: (): Promise<VaultStatus> =>
    invoke('vault_status'),

  initialize: (passphrase: string): Promise<VaultStatus> =>
    invoke('vault_initialize', { args: { passphrase } }),

  unlock: (passphrase: string): Promise<VaultStatus> =>
    invoke('vault_unlock', { args: { passphrase } }),

  lock: (): Promise<void> =>
    invoke('vault_lock'),

  itemList: (): Promise<VaultItem[]> =>
    invoke('vault_item_list'),

  itemGet: (itemId: string): Promise<VaultItemSecret> =>
    invoke('vault_item_get', { args: { item_id: itemId } }),

  itemUpdate: (
    itemId: string,
    label: string,
    kind: string,
    secret: string,
    notes?: string,
  ): Promise<VaultItem> => {
    const args: {
      item_id: string;
      label: string;
      kind: string;
      secret: string;
      notes?: string;
    } = { item_id: itemId, label, kind, secret };
    if (notes !== undefined) args.notes = notes;
    return invoke('vault_item_update', { args });
  },

  itemCreate: (label: string, kind: string, secret: string, notes?: string, credentialId?: string): Promise<VaultItem> => {
    const args: { label: string; kind: string; secret: string; notes?: string; credential_id?: string } = { label, kind, secret };
    if (notes !== undefined) args.notes = notes;
    if (credentialId !== undefined) args.credential_id = credentialId;
    return invoke('vault_item_create', { args });
  },

  itemDelete: (itemId: string): Promise<void> =>
    invoke('vault_item_delete', { args: { item_id: itemId } }),

  secureToVaultPreview: (): Promise<SecureToVaultPreview> =>
    invoke('vault_secure_to_vault_preview'),

  secureToVault: (): Promise<SecureToVaultResult> =>
    invoke('vault_secure_to_vault'),

  backfillConnectionRefs: (): Promise<VaultBackfillResult> =>
    invoke('vault_backfill_connection_refs'),

  generateRecoveryKey: (): Promise<string> =>
    invoke('vault_generate_recovery_key'),

  hasRecoveryKey: (): Promise<boolean> =>
    invoke('vault_has_recovery_key'),

  unlockWithRecoveryKey: (recoveryKey: string): Promise<VaultStatus> =>
    invoke('vault_unlock_with_recovery_key', { args: { recovery_key: recoveryKey } }),

  exportVault: (destPath: string): Promise<void> =>
    invoke('vault_export', { args: { dest_path: destPath } }),

  importVault: (srcPath: string): Promise<VaultStatus> =>
    invoke('vault_import', { args: { src_path: srcPath } }),

  itemRevisionHistory: (itemId: string): Promise<RevisionMeta[]> =>
    invoke('vault_item_revision_history', { args: { item_id: itemId } }),

  itemRestoreRevision: (itemId: string, revision: number): Promise<VaultItem> =>
    invoke('vault_item_restore_revision', { args: { item_id: itemId, revision } }),
};
