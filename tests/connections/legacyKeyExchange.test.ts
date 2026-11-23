import assert from 'node:assert/strict';
import { test } from 'node:test';

import { connectWithHostKeyVerification } from '../../src/features/connections/application/hostKeyVerification.js';
import type { LegacyKex } from '../../src/features/connections/application/legacyKeyExchange.js';

interface Hop {
    id: string;
    host: string;
    port: number;
    jump_host: Hop | null;
    legacy_kex?: LegacyKex;
    host_key_approval?: { fingerprint: string; replace: boolean };
}

const algorithm = 'diffie-hellman-group-exchange-sha1';
const jump: Hop = { id: 'jump', host: 'jump.example', port: 2222, jump_host: null };
const target: Hop = { id: 'target', host: 'target.example', port: 22, jump_host: jump };
const challenge = `Connection Failed: Failed to connect to jump host: ZYNC_LEGACY_KEX:${JSON.stringify(
    {
        connectionId: jump.id,
        host: jump.host,
        port: jump.port,
        algorithm,
    },
)}`;

test('approval changes only the failing hop and still requires host key verification', async () => {
    let attempts = 0;
    const prompts: string[] = [];
    const remembered: LegacyKex[] = [];
    await connectWithHostKeyVerification(
        target,
        async (candidate) => {
            attempts += 1;
            assert.equal(candidate.legacy_kex, undefined);
            assert.equal(remembered.length, 0);
            if (attempts === 1) {
                assert.equal(candidate.jump_host?.legacy_kex, undefined);
                throw challenge;
            }
            assert.equal(candidate.jump_host?.legacy_kex, algorithm);
            if (attempts === 2) {
                throw `ZYNC_HOST_KEY:${JSON.stringify({
                    kind: 'unknown',
                    connectionId: jump.id,
                    host: jump.host,
                    port: jump.port,
                    algorithm: 'ssh-ed25519',
                    fingerprint: 'SHA256:fixture',
                })}`;
            }
            assert.equal(candidate.jump_host?.host_key_approval?.fingerprint, 'SHA256:fixture');
        },
        async (options) => {
            prompts.push(options.title);
            return true;
        },
        {
            load: () => undefined,
            onSuccess: (endpoint, accepted) => {
                assert.equal(endpoint.id, jump.id);
                remembered.push(accepted);
            },
        },
    );
    assert.equal(attempts, 3);
    assert.deepEqual(prompts, ['Allow legacy SSH key exchange?', 'Unknown SSH host']);
    assert.deepEqual(remembered, [algorithm]);
});

test('declining, repeating a challenge, or mismatching a hop never saves an exception', async () => {
    for (const scenario of ['decline', 'repeat', 'different-port'] as const) {
        let attempts = 0;
        let prompts = 0;
        await assert.rejects(
            connectWithHostKeyVerification(
                target,
                async () => {
                    attempts += 1;
                    throw scenario === 'different-port'
                        ? challenge.replace('2222', '2223')
                        : challenge;
                },
                async () => {
                    prompts += 1;
                    return scenario !== 'decline';
                },
                {
                    load: () => undefined,
                    onSuccess: () => assert.fail('unsuccessful approval was saved'),
                },
            ),
        );
        assert.equal(attempts, scenario === 'repeat' ? 2 : 1);
        assert.equal(prompts, scenario === 'different-port' ? 0 : 1);
    }
});
