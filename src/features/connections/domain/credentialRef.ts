import type { CredentialRef } from './types.js';

export const withVaultId = (authRef: CredentialRef, vaultId: string): CredentialRef => ({
    ...authRef,
    vaultId,
});

export const ensureAuthRefVaultId = (
    authRef: CredentialRef | undefined,
    vaultId: string | undefined,
): CredentialRef | undefined => {
    if (!authRef) return undefined;
    if (authRef.vaultId) return authRef;
    if (!vaultId) return authRef;
    return withVaultId(authRef, vaultId);
};