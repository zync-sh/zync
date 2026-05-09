import assert from 'node:assert/strict';
import { resolveVaultFocusProfile } from '../.tmp-agent-tests/src/components/settings/tabs/vaultFocus.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('resolveVaultFocusProfile keeps google profile', () => {
  assert.equal(resolveVaultFocusProfile('google'), 'google');
});

runTest('resolveVaultFocusProfile defaults undefined to local', () => {
  assert.equal(resolveVaultFocusProfile(undefined), 'local');
});

runTest('resolveVaultFocusProfile keeps local profile', () => {
  assert.equal(resolveVaultFocusProfile('local'), 'local');
});

console.log('Vault focus tests passed.');
