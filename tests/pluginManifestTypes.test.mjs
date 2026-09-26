import assert from 'node:assert/strict';
import {
  PLUGIN_PERMISSION_CATALOG,
  getDeclaredPluginPermissions,
  getPluginPermissionDefinition,
  isLegacyPluginManifest,
} from '../.tmp-agent-tests/src/features/plugins/types.js';

const ids = PLUGIN_PERMISSION_CATALOG.map(permission => permission.id);
assert.equal(new Set(ids).size, ids.length, 'permission catalog ids must be unique');
assert.ok(ids.includes('ui.dialog.confirm'));
assert.equal(ids.includes('window.create'), false, 'removed plugin windows must not remain reviewable');

for (const permission of PLUGIN_PERMISSION_CATALOG) {
  assert.match(permission.id, /^[a-z][a-zA-Z0-9]*(?:[._-][a-zA-Z0-9]+)+$/);
  assert.ok(permission.title.trim());
  assert.ok(permission.description.trim());
  assert.equal(getPluginPermissionDefinition(permission.id), permission);
}

assert.equal(isLegacyPluginManifest({ id: 'legacy', name: 'Legacy', version: '1.0.0' }), true);
assert.equal(isLegacyPluginManifest({ manifestVersion: 2, id: 'v2', name: 'V2', version: '2.0.0' }), false);

const declarations = getDeclaredPluginPermissions({
  manifestVersion: 2,
  id: 'dev.example.test',
  name: 'Test',
  version: '2.0.0',
  permissions: {
    required: [{ id: 'ui.pane.register', reason: 'Show a pane.' }],
    optional: [{ id: 'network.fetch', reason: 'Load status.', hosts: ['api.example.dev'] }],
  },
});

assert.deepEqual(declarations, [
  { id: 'ui.pane.register', reason: 'Show a pane.', required: true },
  {
    id: 'network.fetch',
    reason: 'Load status.',
    hosts: ['api.example.dev'],
    required: false,
  },
]);

console.log('plugin manifest type tests passed');
