import assert from 'node:assert/strict';
import {
  addFolderExact,
  deleteFolderExact,
  renameConnectionFolderExact,
  renameFolderExact,
  updateConnectionFolderExact,
  remapFolderPath,
  isFolderOrDescendant,
} from '../.tmp-agent-tests/src/features/connections/domain/folderTreeOps.js';
import {
  mergeImportedConnectionsByName,
  preserveVaultCredentialOnUpdate,
} from '../.tmp-agent-tests/src/features/connections/domain/merge.js';
import {
  applyImportPlan,
  buildImportPlanRows,
} from '../.tmp-agent-tests/src/features/connections/domain/importPlan.js';
import {
  buildConnectConfig,
  shouldAutoConnectOnOpenTab,
} from '../.tmp-agent-tests/src/features/connections/domain/connectionConfig.js';
import {
  assignCredentialToConnections,
  syncCredentialAssignments,
} from '../.tmp-agent-tests/src/features/connections/domain/credentialAssignments.js';
import {
  hasRequiredHostAndUsername,
  getCredentialHealthChecks,
} from '../.tmp-agent-tests/src/features/connections/domain/validation.js';
import {
  normalizeFolderPath,
  normalizePort,
  normalizeTags,
} from '../.tmp-agent-tests/src/features/connections/domain/normalization.js';
import {
  connectionErrorMessage,
} from '../.tmp-agent-tests/src/features/connections/domain/errorSanitization.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`FAIL ${name}: ${message}`);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    } else {
      console.error(error);
    }
    throw error;
  }
}

runTest('connection error sanitization redacts JSON and quoted secret values', () => {
  const message = connectionErrorMessage(
    'failed {"password":"json secret"} token="quoted token" passphrase=\'single quoted secret\'',
  );

  assert.equal(message.includes('json secret'), false);
  assert.equal(message.includes('quoted token'), false);
  assert.equal(message.includes('single quoted secret'), false);
  assert.match(message, /"password":"\[redacted\]"/);
});

runTest('normalize helpers keep expected defaults', () => {
  assert.equal(normalizePort('abc'), 22);
  assert.equal(normalizePort(2222), 2222);
  assert.equal(normalizeFolderPath(' prod / web // '), 'prod/web');
  assert.deepEqual(normalizeTags(['a', ' a ', '', 'b']), ['a', 'b']);
});

runTest('required-field helper checks trimmed host and username', () => {
  assert.equal(hasRequiredHostAndUsername({ host: ' 1.1.1.1 ', username: ' root ' }), true);
  assert.equal(hasRequiredHostAndUsername({ host: '  ', username: 'root' }), false);
  assert.equal(hasRequiredHostAndUsername({ host: '1.1.1.1', username: '' }), false);
});

runTest('credential health checks surface actionable hints', () => {
  const passwordChecks = getCredentialHealthChecks(
    { host: 'localhost', username: 'root', password: '123' },
    'password',
  );
  assert.equal(passwordChecks.some((check) => check.message.includes('very short')), true);
  assert.equal(passwordChecks.some((check) => check.message.includes('root@localhost')), true);

  const keyChecks = getCredentialHealthChecks(
    { host: 'edge-alias', username: 'ubuntu', privateKeyPath: 'id_custom' },
    'key',
  );
  assert.equal(keyChecks.some((check) => check.message.includes('uncommon')), true);
  assert.equal(keyChecks.some((check) => check.message.includes('domain/IP pattern')), true);

  const missingKeyChecks = getCredentialHealthChecks(
    { host: '10.0.0.5', username: 'ubuntu', privateKeyPath: '' },
    'key',
  );
  assert.equal(missingKeyChecks.some((check) => check.message.includes('uncommon')), false);

  const ipv6Checks = getCredentialHealthChecks(
    { host: '[2001:db8::1]', username: 'ubuntu' },
    'password',
  );
  assert.equal(ipv6Checks.some((check) => check.message.includes('domain/IP pattern')), false);
});

runTest('folder exact helpers preserve current exact-match semantics', () => {
  const folders = [{ name: 'prod' }, { name: 'staging', tags: ['blue'] }];
  assert.equal(addFolderExact(folders, 'prod'), folders);
  assert.deepEqual(deleteFolderExact(folders, 'prod'), [{ name: 'staging', tags: ['blue'] }]);
  assert.deepEqual(renameFolderExact(folders, 'staging', 'qa'), [{ name: 'prod' }, { name: 'qa', tags: ['blue'] }]);
});

runTest('connection folder exact helpers update only targeted rows', () => {
  const connections = [
    { id: '1', folder: 'prod' },
    { id: '2', folder: 'staging' },
  ];
  assert.deepEqual(updateConnectionFolderExact(connections, '2', 'prod'), [
    { id: '1', folder: 'prod' },
    { id: '2', folder: 'prod' },
  ]);
  assert.deepEqual(renameConnectionFolderExact(connections, 'prod', 'qa'), [
    { id: '1', folder: 'qa' },
    { id: '2', folder: 'staging' },
  ]);
});

runTest('tree helpers support subtree checks and remap', () => {
  assert.equal(isFolderOrDescendant('prod', 'prod/web'), true);
  assert.equal(isFolderOrDescendant('prod', 'stage/web'), false);
  assert.equal(isFolderOrDescendant('/', '/prod/web'), true);
  assert.equal(remapFolderPath('prod/web/api', 'prod', 'production'), 'production/web/api');
});

runTest('import merge keeps existing ids for same names and dedups by id', () => {
  const existing = [
    { id: 'a', name: 'web', status: 'connected' },
    { id: 'b', name: 'db', status: 'disconnected' },
  ];
  const incoming = [
    { id: 'x', name: 'web', status: 'disconnected' },
    { id: 'y', name: 'cache', status: 'disconnected' },
    { id: '   ', name: 'queue', status: 'disconnected' },
  ];

  const result = mergeImportedConnectionsByName(existing, incoming);
  assert.equal(result.updated, 1);
  assert.equal(result.created, 2);

  const web = result.merged.find((c) => c.name === 'web');
  const cache = result.merged.find((c) => c.name === 'cache');
  const queue = result.merged.find((c) => c.name === 'queue');
  assert.equal(web?.id, 'a');
  assert.equal(web?.status, 'connected');
  assert.equal(cache?.id, 'y');
  assert.equal((queue?.id || '').trim().length > 0, true);
});

runTest('import merge keeps incoming metadata when match metadata is undefined', () => {
  const existing = [{ id: 'a', name: 'web', status: 'connected' }];
  const incoming = [{ id: 'x', name: 'web', status: 'disconnected', icon: 'Ubuntu' }];

  const result = mergeImportedConnectionsByName(existing, incoming);
  const web = result.merged.find((c) => c.id === 'a');
  assert.equal(web?.icon, 'Ubuntu');
});

runTest('import merge preserves existing folder/theme/tags metadata on matched updates', () => {
  const existing = [{ id: 'a', name: 'web', status: 'connected', folder: 'prod', theme: 'blue', tags: ['core'] }];
  const incoming = [{ id: 'x', name: 'web', status: 'disconnected' }];

  const result = mergeImportedConnectionsByName(existing, incoming);
  const web = result.merged.find((c) => c.id === 'a');
  assert.equal(web?.folder, 'prod');
  assert.equal(web?.theme, 'blue');
  assert.deepEqual(web?.tags, ['core']);
});

runTest('import merge preserves existing vault auth when overriding with plaintext import', () => {
  const authRef = {
    vaultId: 'vault-1',
    itemId: 'item-1',
    itemKind: 'ssh-private-key',
    purpose: 'ssh-auth',
  };
  const existing = [{
    id: 'a',
    name: 'web',
    host: 'prod',
    username: 'root',
    port: 22,
    status: 'connected',
    authRef,
  }];
  const incoming = [{
    id: 'x',
    name: 'web',
    host: 'prod',
    username: 'root',
    port: 22,
    status: 'disconnected',
    privateKeyPath: 'C:/Users/me/.ssh/id_rsa',
    password: 'key-passphrase',
  }];

  const result = mergeImportedConnectionsByName(existing, incoming);
  const web = result.merged.find((c) => c.id === 'a');
  assert.deepEqual(web?.authRef, authRef);
  assert.equal(web?.privateKeyPath, undefined);
  assert.equal(web?.password, undefined);

  const preserved = preserveVaultCredentialOnUpdate(existing[0], incoming[0]);
  assert.deepEqual(preserved.authRef, authRef);
  assert.equal(preserved.privateKeyPath, undefined);
  assert.equal(preserved.password, undefined);
});

runTest('import merge allows incoming metadata to override or clear matched metadata', () => {
  const existing = [{
    id: 'a',
    name: 'web',
    host: 'prod',
    username: 'root',
    port: 22,
    status: 'connected',
    folder: 'prod',
    theme: 'blue',
    tags: ['core'],
    icon: 'Server',
  }];
  const incoming = [{
    id: 'x',
    name: 'web',
    host: 'prod',
    username: 'root',
    port: 22,
    status: 'disconnected',
    folder: '',
    theme: null,
    tags: [],
    icon: 'Ubuntu',
  }];

  const result = mergeImportedConnectionsByName(existing, incoming);
  const web = result.merged.find((c) => c.id === 'a');
  assert.equal(web?.folder, '');
  assert.equal(web?.theme, null);
  assert.deepEqual(web?.tags, []);
  assert.equal(web?.icon, 'Ubuntu');
});

runTest('preserveVaultCredentialOnUpdate lets incoming vault auth replace plaintext credentials', () => {
  const authRef = {
    vaultId: 'vault-2',
    itemId: 'item-2',
    itemKind: 'ssh-password',
    purpose: 'ssh-auth',
  };
  const existing = {
    id: 'a',
    name: 'web',
    host: 'prod',
    username: 'root',
    port: 22,
    status: 'connected',
    password: 'old-plaintext',
  };
  const incoming = {
    ...existing,
    id: 'x',
    status: 'disconnected',
    password: undefined,
    privateKeyPath: 'incoming-key-path',
    authRef,
  };

  const preserved = preserveVaultCredentialOnUpdate(existing, incoming);
  assert.deepEqual(preserved.authRef, authRef);
  assert.equal(preserved.password, undefined);
  assert.equal(preserved.privateKeyPath, undefined);
});

runTest('preserveVaultCredentialOnUpdate lets incoming vault auth win when both sides are vaulted', () => {
  const existingAuthRef = {
    vaultId: 'vault-1',
    itemId: 'item-1',
    itemKind: 'ssh-private-key',
    purpose: 'ssh-auth',
  };
  const incomingAuthRef = {
    vaultId: 'vault-2',
    itemId: 'item-2',
    itemKind: 'ssh-password',
    purpose: 'ssh-auth',
  };
  const existing = {
    id: 'a',
    name: 'web',
    host: 'prod',
    username: 'root',
    port: 22,
    status: 'connected',
    authRef: existingAuthRef,
  };
  const incoming = {
    ...existing,
    id: 'x',
    status: 'disconnected',
    password: 'stale-password',
    privateKeyPath: 'stale-key',
    authRef: incomingAuthRef,
  };

  const preserved = preserveVaultCredentialOnUpdate(existing, incoming);
  assert.deepEqual(preserved.authRef, incomingAuthRef);
  assert.equal(preserved.password, undefined);
  assert.equal(preserved.privateKeyPath, undefined);
});

runTest('preserveVaultCredentialOnUpdate strips plaintext when existing vault auth is retained', () => {
  const authRef = {
    vaultId: 'vault-1',
    itemId: 'item-1',
    itemKind: 'ssh-private-key',
    purpose: 'ssh-auth',
  };
  const existing = {
    id: 'a',
    name: 'web',
    host: 'prod',
    username: 'root',
    port: 22,
    status: 'connected',
    authRef,
    password: 'stale-password',
    privateKeyPath: 'stale-key',
  };
  const incoming = {
    id: 'x',
    name: 'web',
    host: 'prod',
    username: 'root',
    port: 22,
    status: 'disconnected',
    password: 'imported-password',
    privateKeyPath: 'imported-key',
  };

  const preserved = preserveVaultCredentialOnUpdate(existing, incoming);
  assert.deepEqual(preserved.authRef, authRef);
  assert.equal(preserved.password, undefined);
  assert.equal(preserved.privateKeyPath, undefined);
});

runTest('import plan builds recommendations and applies new/update/skip decisions', () => {
  const existing = [
    { id: 'a', name: 'web', host: 'prod', username: 'root', port: 22, status: 'connected' },
  ];
  const incoming = [
    { id: 'x', name: 'web', host: 'prod', username: 'root', port: 22, status: 'disconnected' },
    { id: 'y', name: 'worker', host: 'worker', username: 'ubuntu', port: 22, status: 'disconnected' },
    { id: 'z', name: 'api-import', host: 'prod', username: 'root', port: 22, status: 'disconnected' },
  ];

  const rows = buildImportPlanRows(existing, incoming);
  const webRow = rows.find((row) => row.imported.id === 'x');
  const workerRow = rows.find((row) => row.imported.id === 'y');
  const endpointRow = rows.find((row) => row.imported.id === 'z');
  assert.equal(webRow?.recommended, 'update');
  assert.equal(workerRow?.recommended, 'new');
  assert.equal(endpointRow?.recommended, 'update');

  const updateApplied = applyImportPlan(existing, rows, {
    x: 'update',
    y: 'skip',
    z: 'skip',
  });
  assert.equal(updateApplied.updated, 1);
  assert.equal(updateApplied.created, 0);
  assert.equal(updateApplied.skipped, 2);
  assert.equal(updateApplied.toImport.length, 1);
  assert.equal(updateApplied.toImport[0].targetId, 'a');
  assert.equal(updateApplied.toImport[0].matchType, 'name');
  assert.equal(updateApplied.renamed.length, 0);

  const applied = applyImportPlan(existing, rows, {
    x: 'new',
    y: 'skip',
    z: 'skip',
  });

  assert.equal(applied.created, 1);
  assert.equal(applied.updated, 0);
  assert.equal(applied.skipped, 2);
  assert.equal(applied.toImport.length, 1);
  assert.equal(applied.toImport[0].connection.name.startsWith('web (imported'), true);
  assert.equal(applied.renamed.length, 1);

  const updateWithoutTarget = applyImportPlan(existing, rows, {
    x: 'skip',
    y: 'update',
    z: 'skip',
  });
  assert.equal(updateWithoutTarget.updated, 0);
  assert.equal(updateWithoutTarget.created, 1);
  assert.equal(updateWithoutTarget.toImport[0].targetId, null);
  assert.equal(updateWithoutTarget.toImport[0].matchType, null);
});

runTest('buildConnectConfig builds jump-host chain and rejects simple cycle', () => {
  const connections = [
    { id: 'a', name: 'A', host: 'a', port: 22, username: 'u', password: 'p', status: 'disconnected', jumpServerId: 'b' },
    { id: 'b', name: 'B', host: 'b', port: 22, username: 'u', password: 'p', status: 'disconnected' },
  ];

  const config = buildConnectConfig(connections, 'a');
  assert.equal(config?.id, 'a');
  assert.equal(config?.jump_host?.id, 'b');

  const cyclic = [
    { ...connections[0], jumpServerId: 'b' },
    { ...connections[1], jumpServerId: 'a' },
  ];
  const cyclicConfig = buildConnectConfig(cyclic, 'a');
  assert.equal(cyclicConfig, null);
});

runTest('buildConnectConfig includes stable credential id for vault auth', () => {
  const connections = [{
    id: 'vaulted',
    name: 'Vaulted',
    host: 'prod',
    port: 22,
    username: 'root',
    status: 'disconnected',
    authRef: {
      vaultId: 'vault-1',
      credentialId: 'cred-1',
      itemId: 'item-1',
      itemKind: 'ssh-private-key',
      purpose: 'ssh-auth',
    },
  }];

  const config = buildConnectConfig(connections, 'vaulted');

  assert.equal(config?.auth_method.type, 'VaultRef');
  assert.equal(config?.auth_method.item_id, 'item-1');
  assert.equal(config?.auth_method.credential_id, 'cred-1');
});

runTest('buildConnectConfig rejects missing auth instead of sending empty password', () => {
  const connections = [{
    id: 'empty-auth',
    name: 'Empty Auth',
    host: 'prod',
    port: 22,
    username: 'root',
    status: 'disconnected',
    password: '',
  }];

  assert.equal(buildConnectConfig(connections, 'empty-auth'), null);
});

runTest('buildConnectConfig preserves password and key passphrase whitespace', () => {
  const passwordConfig = buildConnectConfig([{
    id: 'password-whitespace',
    name: 'Password whitespace',
    host: 'prod',
    port: 22,
    username: 'root',
    status: 'disconnected',
    password: '  valid password  ',
  }], 'password-whitespace');
  assert.equal(passwordConfig?.auth_method.type, 'Password');
  assert.equal(passwordConfig?.auth_method.password, '  valid password  ');

  const keyConfig = buildConnectConfig([{
    id: 'passphrase-whitespace',
    name: 'Passphrase whitespace',
    host: 'prod',
    port: 22,
    username: 'root',
    status: 'disconnected',
    privateKeyPath: '/tmp/id_rsa',
    password: '  valid passphrase  ',
  }], 'passphrase-whitespace');
  assert.equal(keyConfig?.auth_method.type, 'PrivateKey');
  assert.equal(keyConfig?.auth_method.passphrase, '  valid passphrase  ');
});

runTest('buildConnectConfig accepts legacy snake_case private key records', () => {
  const connections = [{
    id: 'legacy-key',
    name: 'Legacy Key',
    host: 'prod',
    port: 22,
    username: 'root',
    status: 'disconnected',
    private_key_path: '/tmp/id_rsa',
  }];

  const config = buildConnectConfig(connections, 'legacy-key');

  assert.equal(config?.auth_method.type, 'PrivateKey');
  assert.equal(config?.auth_method.key_path, '/tmp/id_rsa');
});

runTest('shouldAutoConnectOnOpenTab connects disconnected hosts including vault-backed', () => {
  const vaultHost = {
    id: 'vaulted',
    name: 'Vault Host',
    host: '10.0.0.1',
    username: 'root',
    port: 22,
    status: 'disconnected',
    authRef: {
      vaultId: 'vault-1',
      credentialId: 'cred-1',
      itemId: 'item-1',
      itemKind: 'ssh-password',
      purpose: 'ssh-auth',
    },
  };

  assert.equal(shouldAutoConnectOnOpenTab([vaultHost], vaultHost), true);
  assert.equal(
    shouldAutoConnectOnOpenTab([vaultHost], { ...vaultHost, status: 'connected' }),
    false,
  );
});

runTest('assignCredentialToConnections clears plaintext fields and preserves untouched hosts', () => {
  const authRef = {
    vaultId: 'vault-1',
    credentialId: 'cred-1',
    itemId: 'item-1',
    itemKind: 'ssh-private-key',
    purpose: 'ssh-auth',
  };
  const connections = [
    {
      id: 'a',
      name: 'web',
      host: 'prod',
      username: 'root',
      port: 22,
      status: 'disconnected',
      password: 'plaintext',
      privateKeyPath: '/tmp/key.pem',
    },
    {
      id: 'b',
      name: 'db',
      host: 'db',
      username: 'postgres',
      port: 22,
      status: 'disconnected',
      password: 'keep-me',
    },
  ];

  const assigned = assignCredentialToConnections(connections, ['a'], authRef);

  assert.deepEqual(assigned[0].authRef, authRef);
  assert.equal(assigned[0].password, undefined);
  assert.equal(assigned[0].privateKeyPath, undefined);
  assert.equal(assigned[1].authRef, undefined);
  assert.equal(assigned[1].password, 'keep-me');
});

runTest('syncCredentialAssignments assigns selected hosts and unassigns deselected hosts using same credential', () => {
  const authRef = {
    vaultId: 'vault-1',
    credentialId: 'cred-1',
    itemId: 'item-1',
    itemKind: 'ssh-private-key',
    purpose: 'ssh-auth',
  };
  const otherAuthRef = {
    vaultId: 'vault-1',
    credentialId: 'cred-2',
    itemId: 'item-2',
    itemKind: 'ssh-password',
    purpose: 'ssh-auth',
  };
  const connections = [
    {
      id: 'a',
      name: 'web',
      host: 'prod',
      username: 'root',
      port: 22,
      status: 'disconnected',
      authRef,
    },
    {
      id: 'b',
      name: 'api',
      host: 'prod-api',
      username: 'root',
      port: 22,
      status: 'disconnected',
      password: 'plaintext',
    },
    {
      id: 'c',
      name: 'db',
      host: 'db',
      username: 'postgres',
      port: 22,
      status: 'disconnected',
      authRef: otherAuthRef,
    },
  ];

  const synced = syncCredentialAssignments(connections, ['b'], authRef);

  assert.equal(synced[0].authRef, undefined);
  assert.deepEqual(synced[1].authRef, authRef);
  assert.equal(synced[1].password, undefined);
  assert.deepEqual(synced[2].authRef, otherAuthRef);
});

runTest('syncCredentialAssignments matches legacy item-id refs safely without clearing unrelated undefined refs', () => {
  const legacyAuthRef = {
    vaultId: 'vault-1',
    itemId: 'item-legacy',
    itemKind: 'ssh-private-key',
    purpose: 'ssh-auth',
  };
  const incomingLegacyRef = {
    vaultId: 'vault-1',
    itemId: 'item-legacy',
    itemKind: 'ssh-private-key',
    purpose: 'ssh-auth',
  };
  const unrelatedUndefinedRef = {
    vaultId: 'vault-1',
    itemId: 'item-other',
    itemKind: 'ssh-private-key',
    purpose: 'ssh-auth',
  };
  const connections = [
    {
      id: 'a',
      name: 'legacy-match',
      host: 'prod',
      username: 'root',
      port: 22,
      status: 'disconnected',
      authRef: legacyAuthRef,
    },
    {
      id: 'b',
      name: 'unrelated-legacy',
      host: 'api',
      username: 'root',
      port: 22,
      status: 'disconnected',
      authRef: unrelatedUndefinedRef,
    },
    {
      id: 'c',
      name: 'credential-match',
      host: 'db',
      username: 'postgres',
      port: 22,
      status: 'disconnected',
      authRef: {
        vaultId: 'vault-1',
        credentialId: 'cred-2',
        itemId: 'item-stale',
        itemKind: 'ssh-password',
        purpose: 'ssh-auth',
      },
    },
  ];

  const synced = syncCredentialAssignments(connections, ['a'], {
    vaultId: 'vault-1',
    itemId: 'item-legacy',
    itemKind: 'ssh-private-key',
    purpose: 'ssh-auth',
  });

  assert.equal(synced[0].authRef?.vaultId, incomingLegacyRef.vaultId);
  assert.equal(synced[0].authRef?.itemId, incomingLegacyRef.itemId);
  assert.equal(synced[0].authRef?.itemKind, incomingLegacyRef.itemKind);
  assert.equal(synced[0].authRef?.purpose, incomingLegacyRef.purpose);
  assert.equal(synced[0].authRef?.credentialId, undefined);
  assert.deepEqual(synced[1].authRef, unrelatedUndefinedRef);

  const credentialSynced = syncCredentialAssignments(connections, ['c'], {
    vaultId: 'vault-1',
    credentialId: 'cred-2',
    itemId: 'item-fresh',
    itemKind: 'ssh-password',
    purpose: 'ssh-auth',
  });
  assert.deepEqual(credentialSynced[0].authRef, legacyAuthRef);
  assert.deepEqual(credentialSynced[1].authRef, unrelatedUndefinedRef);
  assert.equal(credentialSynced[2].authRef?.credentialId, 'cred-2');
  assert.equal(credentialSynced[2].authRef?.itemId, 'item-fresh');
});

console.log('Connection domain tests passed.');
