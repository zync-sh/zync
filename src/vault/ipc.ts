import { invoke } from '@tauri-apps/api/core';

export type VaultStatus =
  | { status: 'uninitialized' }
  | { status: 'locked'; vaultId: string }
  | { status: 'unlocked'; vaultId: string; itemCount: number };

export interface VaultItem {
  id: string;
  kind: string;
  label: string;
  secretFingerprint: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface VaultItemSecret {
  id: string;
  kind: string;
  label: string;
  secret: string;
  notes?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface MigrationCandidate {
  connectionId: string;
  connectionName: string;
  host: string;
  migrationKind: string;
}

export interface MigrationPreview {
  candidates: MigrationCandidate[];
  alreadyMigrated: number;
  skippedNoFile: number;
}

export interface MigrationResult {
  migrated: number;
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

  itemCreate: (label: string, kind: string, secret: string, notes?: string): Promise<VaultItem> => {
    const args: { label: string; kind: string; secret: string; notes?: string } = { label, kind, secret };
    if (notes !== undefined) args.notes = notes;
    return invoke('vault_item_create', { args });
  },

  itemDelete: (itemId: string): Promise<void> =>
    invoke('vault_item_delete', { args: { item_id: itemId } }),

  migrationPreview: (): Promise<MigrationPreview> =>
    invoke('vault_migration_preview'),

  migrateExistingSecrets: (): Promise<MigrationResult> =>
    invoke('vault_migrate_existing_secrets'),

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
};
