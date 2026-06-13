import assert from 'node:assert/strict';
import {
  didVaultTransitionToLocked,
  resolveVaultFocusProfile,
} from '../.tmp-agent-tests/src/components/settings/tabs/vaultFocus.js';

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

runTest('locked vault rerenders do not close the unlock modal', () => {
  assert.equal(didVaultTransitionToLocked(false, false), false);
});

runTest('actual vault lock transition closes vault-dependent overlays', () => {
  assert.equal(didVaultTransitionToLocked(true, false), true);
});

runTest('unlock transition does not close vault-dependent overlays', () => {
  assert.equal(didVaultTransitionToLocked(false, true), false);
});

console.log('Vault focus tests passed.');
