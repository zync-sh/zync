import assert from 'node:assert/strict';
import { createOptionalPermissionRequester } from '../.tmp-agent-tests/src/features/plugins/runtime/pluginOptionalPermission.js';

const prompt = { pluginName: 'PM2 Monitor', capability: 'filesystem.external.write', reason: 'Export logs', packageDigest: 'verified-package' };
let prompts = 0;
let approvals = 0;
let granted = false;
let allow = false;
const request = createOptionalPermissionRequester({
    inspect: async (_runtime, _capability, digest) => {
        if (digest) { assert.equal(digest, prompt.packageDigest); approvals++; granted = true; return null; }
        return granted ? null : prompt;
    },
    confirm: async () => { prompts++; return allow; },
});
assert.equal(await request('runtime', prompt.capability, () => true), false);
assert.equal(await request('runtime', prompt.capability, () => true), false);
assert.equal(prompts, 2, 'Deny must not be remembered');
assert.equal(approvals, 0, 'Deny must not change grants');
allow = true;
assert.equal(await request('runtime', prompt.capability, () => true), true);
assert.equal(await request('runtime', prompt.capability, () => true), true);
assert.equal(prompts, 3, 'An existing grant must not prompt again');
assert.equal(approvals, 1);

let current = true;
let staleApprovals = 0;
const stale = createOptionalPermissionRequester({
    inspect: async (_runtime, _capability, digest) => { if (digest) staleApprovals++; return prompt; },
    confirm: async () => { current = false; return true; },
});
assert.equal(await stale('old-runtime', prompt.capability, () => current), false);
assert.equal(staleApprovals, 0, 'A stopped/replaced worker must not save approval');

let resolveDialog;
let concurrentPrompts = 0;
const concurrent = createOptionalPermissionRequester({
    inspect: async () => prompt,
    confirm: () => { concurrentPrompts++; return new Promise(resolve => { resolveDialog = resolve; }); },
});
const first = concurrent('runtime', prompt.capability, () => true);
const second = concurrent('runtime', prompt.capability, () => true);
await Promise.resolve();
assert.equal(concurrentPrompts, 1, 'Concurrent requests share one dialog');
resolveDialog(false);
assert.deepEqual(await Promise.all([first, second]), [false, false]);
const invalid = createOptionalPermissionRequester({
    inspect: async () => { throw new Error('Plugin did not declare capability'); },
    confirm: async () => { assert.fail('Invalid permissions must not prompt'); },
});
await assert.rejects(invalid('runtime', 'undeclared', () => true), /did not declare/);
console.log('Plugin optional permission tests passed');
