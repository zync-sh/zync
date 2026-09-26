import assert from 'node:assert/strict';
import { parsePluginWorkerMessage } from '../.tmp-agent-tests/src/features/plugins/runtime/pluginMessageEnvelope.js';

const valid = parsePluginWorkerMessage({
  type: 'api:storage:set',
  payload: { requestId: 'request-1', key: 'count', value: '1' },
});
assert.deepEqual(valid, {
  type: 'api:storage:set',
  payload: { requestId: 'request-1', key: 'count', value: '1' },
});
assert.deepEqual(parsePluginWorkerMessage({ type: 'api:log', payload: 'hello' }), {
  type: 'api:log',
  payload: 'hello',
});

for (const malformed of [
  null,
  [],
  {},
  { type: 42, payload: {} },
  { type: 'API:storage:get', payload: {} },
  { type: `api:${'x'.repeat(130)}`, payload: {} },
  { type: 'api:storage:set', payload: { value: Number.POSITIVE_INFINITY } },
  { type: 'api:storage:set', payload: new Date() },
]) {
  assert.equal(parsePluginWorkerMessage(malformed), null);
}

const cyclic = {};
cyclic.self = cyclic;
assert.equal(parsePluginWorkerMessage({ type: 'api:log', payload: cyclic }), null);

assert.equal(parsePluginWorkerMessage({
  type: 'api:log',
  payload: { message: 'x'.repeat(140_000) },
}), null, 'oversized messages must fail before routing');

let deeplyNested = {};
for (let index = 0; index < 40; index += 1) deeplyNested = { child: deeplyNested };
assert.equal(parsePluginWorkerMessage({ type: 'api:log', payload: deeplyNested }), null);

assert.equal(parsePluginWorkerMessage({
  type: 'api:log',
  payload: Array.from({ length: 10_001 }, () => null),
}), null, 'messages must have a bounded node count');

console.log('Plugin Worker message envelope adversarial tests passed.');
