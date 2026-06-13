import type { VaultProfileId } from '../../../vault/profileTypes';

export function resolveVaultFocusProfile(profileId: VaultProfileId | undefined): VaultProfileId {
  return profileId === 'google' ? 'google' : 'local';
}

export function didVaultTransitionToLocked(wasUnlocked: boolean, isUnlocked: boolean): boolean {
  return wasUnlocked && !isUnlocked;
}
