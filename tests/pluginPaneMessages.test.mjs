import assert from 'node:assert/strict';
import { parsePluginPaneMessage } from '../.tmp-agent-tests/src/features/plugins/runtime/paneMessages.js';

assert.deepEqual(
  parsePluginPaneMessage({ type: 'zync:pane:message', payload: { action: 'increment', amount: 1 } }),
  { ok: true, message: { action: 'increment', amount: 1 } },
);
assert.deepEqual(parsePluginPaneMessage({ type: 'zync:pane:message', payload: null }), { ok: true, message: null });
assert.deepEqual(parsePluginPaneMessage({ type: 'other', payload: {} }), { ok: false });
assert.deepEqual(parsePluginPaneMessage({ type: 'zync:pane:message', payload: { invalid: undefined } }), { ok: false });
assert.deepEqual(parsePluginPaneMessage({ type: 'zync:pane:message', payload: 'x'.repeat(70 * 1024) }), { ok: false });

let deep = 'end';
for (let index = 0; index < 18; index += 1) deep = { next: deep };
assert.deepEqual(parsePluginPaneMessage({ type: 'zync:pane:message', payload: deep }), { ok: false });

const tooManyKeys = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`key-${index}`, index]));
assert.deepEqual(parsePluginPaneMessage({ type: 'zync:pane:message', payload: tooManyKeys }), { ok: false });
assert.deepEqual(
  parsePluginPaneMessage({ type: 'zync:pane:message', payload: Array.from({ length: 4097 }, () => 0) }),
  { ok: false },
);

console.log('Plugin pane message tests passed.');
