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
} from '../.tmp-agent-tests/src/features/connections/domain/merge.js';
import {
  applyImportPlan,
  buildImportPlanRows,
} from '../.tmp-agent-tests/src/features/connections/domain/importPlan.js';
import {
  buildConnectConfig,
} from '../.tmp-agent-tests/src/features/connections/domain/connectionConfig.js';
import {
  hasRequiredHostAndUsername,
  getCredentialHealthChecks,
} from '../.tmp-agent-tests/src/features/connections/domain/validation.js';
import {
  normalizeFolderPath,
  normalizePort,
  normalizeTags,
} from '../.tmp-agent-tests/src/features/connections/domain/normalization.js';

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

console.log('Connection domain tests passed.');
