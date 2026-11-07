import assert from 'node:assert/strict';
import test from 'node:test';

import type { CredentialRef } from '../../src/features/connections/domain/types.js';
import { unreferencedVaultDuplicates } from '../../src/vault/credentialReferences.js';
import { PASSWORD_CREDENTIAL_KIND } from '../../src/vault/credentialTypes.js';
import type { VaultItem } from '../../src/vault/ipc.js';

const legacyHostReference = {
    vaultId: 'test-vault',
    itemKind: PASSWORD_CREDENTIAL_KIND,
    purpose: 'ssh-auth',
} as const satisfies Omit<CredentialRef, 'itemId'>;

/** A Vault metadata fixture without plaintext. */
function vaultItem(id: string, kind: string, createdAt: number): VaultItem {
    return {
        id,
        logicalId: `credential-${id}`,
        kind,
        label: id,
        secretFingerprint: 'same-secret-fingerprint',
        schemaVersion: 2,
        secretFieldCount: 1,
        hasPassphraseField: false,
        revision: 1,
        createdAt,
        updatedAt: createdAt,
    };
}

test('deduplication protects every SSH and VNC link in a shared password group', () => {
    const ssh = vaultItem('ssh', PASSWORD_CREDENTIAL_KIND, 1);
    const restoredSsh = vaultItem('restored-ssh', PASSWORD_CREDENTIAL_KIND, 1);
    const vnc = vaultItem('vnc', 'vnc-password', 2);
    const unlinked = vaultItem('unlinked', 'password', 3);
    const token = vaultItem('token', 'api-token', 4);
    const items = [ssh, restoredSsh, vnc, unlinked, token];
    const connections = [
        { authRef: { ...legacyHostReference, itemId: ssh.id } },
        {
            authRef: {
                ...legacyHostReference,
                itemId: 'old-ssh-record-id',
                credentialId: restoredSsh.logicalId,
            },
        },
    ];
    const vncProfiles = [{ credentialId: vnc.logicalId }];

    assert.deepEqual(unreferencedVaultDuplicates(items, connections, vncProfiles), [unlinked]);
    assert.deepEqual(
        unreferencedVaultDuplicates(items, connections, [
            ...vncProfiles,
            { credentialId: unlinked.logicalId },
        ]),
        [],
    );
});

test('deduplication keeps the newest entry when no saved profile links to the group', () => {
    const older = vaultItem('older', PASSWORD_CREDENTIAL_KIND, 1);
    const newer = vaultItem('newer', 'vnc-password', 2);

    assert.deepEqual(unreferencedVaultDuplicates([older, newer], [], []), [older]);
});
