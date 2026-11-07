import type { Connection } from '../features/connections/domain/types.js';
import type { VncProfile } from '../features/vnc/domain/profile.js';
import { isPasswordCredentialKind, PASSWORD_CREDENTIAL_KIND } from './credentialTypes.js';
import type { VaultItem } from './ipc.js';

type CredentialIdentity = Pick<VaultItem, 'id' | 'logicalId'>;
type VaultConnection = Pick<Connection, 'authRef'>;
type VaultProfile = Pick<VncProfile, 'credentialId'>;

/** Index saved links by both current logical identity and legacy physical item ID. */
function vaultReferenceChecker(
    connections: readonly VaultConnection[],
    vncProfiles: readonly VaultProfile[],
): (item: CredentialIdentity) => boolean {
    const itemIds = new Set(connections.map(({ authRef }) => authRef?.itemId));
    const credentialIds = new Set([
        ...connections.map(({ authRef }) => authRef?.credentialId),
        ...vncProfiles.map(({ credentialId }) => credentialId),
    ]);
    return ({ id, logicalId }) => itemIds.has(id) || credentialIds.has(logicalId);
}

/** Keep every linked record and keep the newest copy when a group has no links. */
export function unreferencedVaultDuplicates(
    items: readonly VaultItem[],
    connections: readonly VaultConnection[],
    vncProfiles: readonly VaultProfile[],
): VaultItem[] {
    const isReferenced = vaultReferenceChecker(connections, vncProfiles);
    const groups = new Map<string, VaultItem[]>();
    for (const item of items) {
        const kind = isPasswordCredentialKind(item.kind) ? PASSWORD_CREDENTIAL_KIND : item.kind;
        const fingerprint = `${kind}:${item.secretFingerprint}`;
        const group = groups.get(fingerprint);
        if (group) {
            group.push(item);
        } else {
            groups.set(fingerprint, [item]);
        }
    }

    const duplicates: VaultItem[] = [];
    for (const group of groups.values()) {
        if (group.length <= 1) {
            continue;
        }
        const unreferenced = group.filter((item) => !isReferenced(item));
        if (unreferenced.length === group.length) {
            unreferenced.sort((a, b) => b.createdAt - a.createdAt);
            unreferenced.shift();
        }
        duplicates.push(...unreferenced);
    }
    return duplicates;
}
