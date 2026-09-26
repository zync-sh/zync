import assert from 'node:assert/strict';
import vm from 'node:vm';
import { isPluginShortcutCommandAllowed, pluginShortcutBindings, matchPluginShortcut, pluginShortcutBridgeScript } from '../.tmp-agent-tests/src/features/shortcuts/pluginShortcuts.js';

const key = (key, extra = {}) => ({ key, code: '', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, inField: false, ...extra });
const bindings = pluginShortcutBindings({}, false);
for (const id of ['toggleSidebar', 'openNewConnection', 'closeTab', 'zoomIn', 'zoomOut', 'filesFeature', 'tunnelsFeature', 'snippetsFeature', 'dashboardFeature', 'termPaste', 'newHostTerminal', 'unknown']) {
  assert.equal(isPluginShortcutCommandAllowed(id), false, `${id} must not be authorized by a plugin message`);
  assert.ok(!bindings.some(binding => binding.id === id));
  // Even a perfectly matching forged binding is not command authorization.
  const matched = matchPluginShortcut(key('p'), [{ ...bindings.find(binding => binding.id === 'commandPalette'), id }]);
  assert.equal(matched, id);
  assert.equal(isPluginShortcutCommandAllowed(matched), false);
}
assert.ok(bindings.every(binding => isPluginShortcutCommandAllowed(binding.id)));
assert.equal(isPluginShortcutCommandAllowed('commandPalette'), true);
assert.equal(matchPluginShortcut(key('w'), bindings), null);
assert.deepEqual(pluginShortcutBindings(undefined, false), bindings, 'Missing settings must use default shortcuts');
assert.deepEqual(pluginShortcutBindings(null, false), bindings, 'Null settings must use default shortcuts');
assert.deepEqual(pluginShortcutBindings(undefined, true), pluginShortcutBindings({}, true));
assert.equal(matchPluginShortcut(key('p'), bindings), 'commandPalette');
assert.equal(matchPluginShortcut(key('p', { shiftKey: true, inField: true }), bindings), 'commandPaletteMode');
assert.equal(matchPluginShortcut(key('w', { inField: true }), bindings), null);
assert.equal(matchPluginShortcut(key('v'), bindings), null);
assert.equal(matchPluginShortcut(key('v', { shiftKey: true }), bindings), null);
assert.equal(matchPluginShortcut(key('t', { shiftKey: true }), bindings), null);
assert.equal(matchPluginShortcut(key('p', { repeat: true }), bindings), null);
assert.equal(matchPluginShortcut(key('p', { isComposing: true }), bindings), null);
assert.equal(matchPluginShortcut({ key: 'p', ctrlKey: true }, bindings), null);
assert.equal(matchPluginShortcut(key('p'), pluginShortcutBindings({ commandPalette: 'Mod+K' }, false)), null);
assert.equal(matchPluginShortcut(key('k'), pluginShortcutBindings({ commandPalette: 'Mod+K' }, false)), 'commandPalette');
assert.equal(matchPluginShortcut(key('p', { ctrlKey: false, metaKey: true }), pluginShortcutBindings({}, true)), 'commandPalette');

// Exercise the exact code injected into the sandbox, not a separate listener mock.
const listeners = new Map();
const messages = [];
const parent = { postMessage: message => messages.push(message) };
vm.runInNewContext(pluginShortcutBridgeScript().replace(/^<script>|<\/script>$/g, ''), {
  window: { parent, addEventListener: (type, listener) => listeners.set(type, listener) },
});
listeners.get('message')({ source: {}, data: { type: 'zync:shortcuts:update', payload: bindings } });
let prevented = 0;
const event = { ...key('p'), isTrusted: true, preventDefault: () => prevented++, stopImmediatePropagation() {} };
listeners.get('keydown')(event);
assert.equal(messages.length, 0);
listeners.get('message')({ source: parent, data: { type: 'zync:shortcuts:update', payload: bindings } });
listeners.get('keydown')({ ...event, isTrusted: false });
assert.equal(messages.length, 0);
listeners.get('keydown')(event);
assert.equal(messages.length, 1);
assert.equal(prevented, 1);
assert.equal(messages[0].type, 'zync:shortcut');
listeners.get('keydown')({ ...event, key: 'c' });
assert.equal(messages.length, 1);
console.log('Plugin shortcut bridge tests passed.');
