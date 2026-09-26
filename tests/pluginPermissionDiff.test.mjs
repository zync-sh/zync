import assert from 'node:assert/strict';
import { diffPluginPermissions } from '../src/features/plugins/permissionDiff.ts';

const previous = {
  required: [
    { id: 'ui.commands.register', reason: 'Commands.' },
    { id: 'network.fetch', reason: 'Old host.', hosts: ['api.example.dev'] },
  ],
  optional: [
    { id: 'ui.notifications.emit', reason: 'Notify.' },
    { id: 'filesystem.external.read', reason: 'Removed.' },
  ],
};
const next = {
  required: [
    { id: 'ui.commands.register', reason: 'A clearer explanation.' },
    { id: 'network.fetch', reason: 'New host.', hosts: ['api.example.dev', 'status.example.dev'] },
    { id: 'ssh.filesystem.read', reason: 'New required access.' },
  ],
  optional: [
    { id: 'ui.notifications.emit', reason: 'Notify.' },
    { id: 'filesystem.external.write', reason: 'New optional access.' },
  ],
};

const diff = diffPluginPermissions(previous, next, ['ui.notifications.emit']);
assert.deepEqual(diff.added.map(entry => entry.id), [
  'filesystem.external.write',
  'ssh.filesystem.read',
]);
assert.deepEqual(diff.changed.map(entry => entry.id), ['network.fetch']);
assert.deepEqual(diff.removed.map(entry => entry.id), ['filesystem.external.read']);
assert.deepEqual(diff.unchanged.map(entry => entry.id), [
  'ui.commands.register',
  'ui.notifications.emit',
]);
assert.deepEqual(diff.optionalSelectedByDefault, ['ui.notifications.emit']);

const safer = diffPluginPermissions(
  { optional: [{ id: 'network.fetch', reason: 'Broad.', hosts: ['a.test', 'b.test'] }] },
  { optional: [{ id: 'network.fetch', reason: 'Narrow.', hosts: ['a.test'] }] },
  ['network.fetch'],
);
assert.equal(safer.changed.length, 1, 'scope changes must remain visible even when narrower');
assert.deepEqual(safer.optionalSelectedByDefault, [], 'changed optional access must require a new choice');

console.log('Plugin permission diff tests passed.');
