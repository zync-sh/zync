import type { VaultStatus } from './ipc';

/** True while vault status is unknown — show placeholders, not empty/locked UI. */
export function isVaultStatusPending(
  status: VaultStatus | null,
  isLoading: boolean,
): boolean {
  return isLoading && (status === null || status.status === 'uninitialized');
}