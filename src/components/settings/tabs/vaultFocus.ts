import type { VaultProfileId } from '../../../vault/profileTypes';

export function resolveVaultFocusProfile(profileId: VaultProfileId | undefined): VaultProfileId {
  return profileId === 'google' ? 'google' : 'local';
}
