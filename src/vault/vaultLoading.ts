import type { VaultStatus } from './ipc';

/** True while vault status is unknown — show placeholders, not empty/locked UI. */
export function isVaultStatusPending(
  status: VaultStatus | null,
  isLoading: boolean,
): boolean {
  return isLoading && (status === null || status.status === 'uninitialized');
}

export const VAULT_IN_USE_USER_MESSAGE =
  'Vault is open in another Zync window. Close the other instance, then try again.';

export function isVaultInUseError(error: string | null | undefined): boolean {
  if (!error) return false;
  const normalized = error.toLowerCase();
  return normalized.includes('vault_in_use')
    || normalized.includes('another zync window')
    || normalized.includes('another zync instance');
}