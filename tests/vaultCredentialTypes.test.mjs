import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getCredentialKindLabel,
  isHostAssignableCredentialKind,
  isSupportedCreateCredentialKind,
  normalizeCredentialKind,
  vaultItemSecretReferenceField,
  vaultItemToCredentialEnvelope,
} from '../.tmp-agent-tests/src/vault/credentialTypes.js';

const vaultItem = {
  id: 'item-1',
  logicalId: 'cred-1',
  kind: 'ssh-private-key',
  label: 'Prod SSH key',
  secretFingerprint: 'fp',
  revision: 4,
  createdAt: 10,
  updatedAt: 20,
};

test('vaultItemToCredentialEnvelope maps SSH private key metadata without secret value', () => {
  const envelope = vaultItemToCredentialEnvelope(vaultItem);

  assert.equal(envelope.credentialId, 'cred-1');
  assert.equal(envelope.kind, 'ssh-private-key');
  assert.equal(envelope.label, 'Prod SSH key');
  assert.equal(envelope.revision, 4);
  assert.equal(envelope.schemaVersion, 2);
  assert.equal(envelope.metadata.legacyKind, 'ssh-private-key');
  assert.equal(envelope.fields.length, 1);
  assert.equal(envelope.fields[0].name, 'privateKey');
  assert.equal(envelope.fields[0].format, 'private-key');
  assert.equal(envelope.fields[0].encoding, 'pem');
  assert.equal(envelope.fields[0].valueRef, 'secret:privateKey');
  assert.equal(envelope.fields[0].value, undefined);
});

test('vaultItemToCredentialEnvelope falls back to item id when logical id is absent', () => {
  const envelope = vaultItemToCredentialEnvelope({
    ...vaultItem,
    logicalId: '',
  });

  assert.equal(envelope.credentialId, 'item-1');
});

test('vaultItemToCredentialEnvelope preserves a backend-provided typed envelope', () => {
  const typedEnvelope = {
    credentialId: 'cred-typed',
    kind: 'username-password',
    label: 'Typed credential',
    fields: [
      {
        name: 'username',
        label: 'Username',
        secret: false,
        required: true,
        value: 'deploy',
      },
      {
        name: 'password',
        label: 'Password',
        secret: true,
        required: true,
        valueRef: 'secret:password',
      },
    ],
    metadata: {},
    tags: ['prod'],
    revision: 2,
    createdAt: 10,
    updatedAt: 20,
    schemaVersion: 2,
  };

  const envelope = vaultItemToCredentialEnvelope({
    ...vaultItem,
    credential: typedEnvelope,
  });

  assert.deepEqual(envelope, typedEnvelope);
  assert.equal(envelope.fields.length, 2);
  assert.equal(envelope.fields[0].value, 'deploy');
});

test('vaultItemSecretReferenceField maps SSH password to password field', () => {
  const field = vaultItemSecretReferenceField({ id: 'item-2', kind: 'ssh-password' });

  assert.equal(field.name, 'password');
  assert.equal(field.label, 'Password');
  assert.equal(field.secret, true);
  assert.equal(field.format, 'password');
  assert.equal(field.valueRef, 'secret:password');
});

test('vaultItemToCredentialEnvelope accepts secret-bearing records without copying plaintext', () => {
  const envelope = vaultItemToCredentialEnvelope({
    ...vaultItem,
    secret: 'plain-secret-must-not-leak',
    notes: 'ops-only',
  });

  assert.equal(envelope.metadata.notes, 'ops-only');
  assert.equal(envelope.fields[0].value, undefined);
  assert.equal(JSON.stringify(envelope).includes('plain-secret-must-not-leak'), false);
});

test('legacy ssh agent keys map to external keychain references', () => {
  const envelope = vaultItemToCredentialEnvelope({
    ...vaultItem,
    kind: 'ssh-agent-key',
  });

  assert.equal(envelope.kind, 'external-keychain-reference');
  assert.equal(envelope.metadata.legacyKind, 'ssh-agent-key');
  assert.equal(envelope.fields[0].name, 'secret');
});

test('legacy aliases normalize to canonical credential kinds', () => {
  assert.equal(normalizeCredentialKind('api-key'), 'api-token');
  assert.equal(normalizeCredentialKind('secure-note'), 'secret-text');
});

test('unsupported legacy kinds normalize to generic secret envelope', () => {
  const envelope = vaultItemToCredentialEnvelope({
    ...vaultItem,
    kind: 'legacy-custom-secret',
  });

  assert.equal(envelope.kind, 'generic-secret');
  assert.equal(envelope.metadata.legacyKind, 'legacy-custom-secret');
  assert.equal(envelope.fields[0].name, 'secret');
});

test('supported create kind guard only enables current SSH kinds', () => {
  assert.equal(isSupportedCreateCredentialKind('ssh-private-key'), true);
  assert.equal(isSupportedCreateCredentialKind('ssh-password'), true);
  assert.equal(isSupportedCreateCredentialKind('username-password'), false);
  assert.equal(isSupportedCreateCredentialKind('jenkins-credential'), false);
});

test('host assignability follows normalized SSH credential kinds', () => {
  assert.equal(isHostAssignableCredentialKind('ssh-private-key'), true);
  assert.equal(isHostAssignableCredentialKind('ssh-password'), true);
  assert.equal(isHostAssignableCredentialKind('ssh-agent-key'), true);
  assert.equal(isHostAssignableCredentialKind('api-token'), false);
});

test('kind labels are user-readable', () => {
  assert.equal(getCredentialKindLabel('ssh-private-key'), 'SSH private key');
  assert.equal(getCredentialKindLabel('unknown-kind'), 'generic secret');
});
