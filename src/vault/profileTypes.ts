export const VAULT_PROFILE_IDS = ['local', 'google'] as const;

export type VaultProfileId = typeof VAULT_PROFILE_IDS[number];

export const DEFAULT_VAULT_PROFILE_ID: VaultProfileId = 'local';

export function isVaultProfileId(value: unknown): value is VaultProfileId {
  return typeof value === 'string' && VAULT_PROFILE_IDS.includes(value as VaultProfileId);
}
