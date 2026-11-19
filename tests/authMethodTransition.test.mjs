import assert from 'node:assert/strict';
import { applyAuthMethodTransition } from '../.tmp-agent-tests/src/features/connections/domain/authMethodTransition.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('password → key clears login password', () => {
  const next = applyAuthMethodTransition(
    { password: 'login-secret', host: 'h', privateKeyPath: '/k' },
    'password',
    'key',
  );
  assert.equal(next.password, '');
  assert.equal(next.privateKeyPath, '/k');
});

runTest('key → password clears key passphrase and path', () => {
  const next = applyAuthMethodTransition(
    { password: 'key-pass', privateKeyPath: '/k' },
    'key',
    'password',
  );
  assert.equal(next.password, '');
  assert.equal(next.privateKeyPath, undefined);
});

runTest('same method is a no-op', () => {
  const form = { password: 'keep-me' };
  const next = applyAuthMethodTransition(form, 'key', 'key');
  assert.equal(next.password, 'keep-me');
  assert.equal(next, form);
});

runTest('any mode → agent clears passwords, key paths and vault refs', () => {
  const next = applyAuthMethodTransition(
    { password: 'secret', privateKeyPath: '/k', authRef: { itemId: 'item-1' }, certificatePath: '/cert' },
    'vault',
    'agent',
  );
  assert.equal(next.password, '');
  assert.equal(next.privateKeyPath, undefined);
  assert.equal(next.authRef, undefined);
  assert.equal(next.certificatePath, undefined);
});

runTest('agent → key clears agent selection and vault refs', () => {
  const next = applyAuthMethodTransition(
    { useSshAgent: true, agentKey: 'ssh-ed25519 AAAA', password: 'pass' },
    'agent',
    'key',
  );
  assert.equal(next.useSshAgent, undefined);
  assert.equal(next.agentKey, undefined);
  assert.equal(next.authRef, undefined);
});

runTest('agent → password clears agent selection', () => {
  const next = applyAuthMethodTransition(
    { useSshAgent: true, agentKey: 'ssh-ed25519 AAAA', password: '' },
    'agent',
    'password',
  );
  assert.equal(next.useSshAgent, undefined);
  assert.equal(next.agentKey, undefined);
  assert.equal(next.privateKeyPath, undefined);
  assert.equal(next.authRef, undefined);
});

console.log('Auth method transition tests passed.');
