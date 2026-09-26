import assert from 'node:assert/strict';
import { createPluginReloadQueue, PluginLifecycleGeneration } from '../.tmp-agent-tests/src/features/plugins/runtime/pluginReloadQueue.js';

const enqueue = createPluginReloadQueue();
const events = [];
let releaseFirst;
const first = enqueue(async () => {
  events.push('first started');
  await new Promise(resolve => { releaseFirst = resolve; });
  events.push('first failed');
  throw new Error('reload failed');
});
const second = enqueue(async () => {
  events.push('second started');
  return true;
});

await Promise.resolve();
assert.deepEqual(events, ['first started']);
releaseFirst();
await assert.rejects(first, /reload failed/);
assert.equal(await second, true);
assert.deepEqual(events, ['first started', 'first failed', 'second started']);

console.log('Plugin reload serialization tests passed.');

const lifecycle = new PluginLifecycleGeneration();
assert.equal(lifecycle.capture()(), false);
lifecycle.begin();
const oldStart = lifecycle.capture();
assert.equal(oldStart(), true);
lifecycle.invalidate();
lifecycle.begin();
assert.equal(oldStart(), false, 'effect replay must not revive an old start');
const currentStart = lifecycle.capture();
assert.equal(currentStart(), true);

const lifecycleQueue = createPluginReloadQueue();
const lifecycleEvents = [];
let releaseStart;
const starting = lifecycleQueue(async () => {
  await new Promise(resolve => { releaseStart = resolve; });
  lifecycleEvents.push(currentStart() ? 'worker attached' : 'stale lease released');
});
await Promise.resolve();
lifecycle.invalidate();
const shutdown = lifecycleQueue(async () => { lifecycleEvents.push('native reset'); });
lifecycle.begin();
const nextStart = lifecycle.capture();
const restarting = lifecycleQueue(async () => {
  if (nextStart()) lifecycleEvents.push('new worker attached');
});
releaseStart();
await Promise.all([starting, shutdown, restarting]);
assert.deepEqual(lifecycleEvents, ['stale lease released', 'native reset', 'new worker attached']);
console.log('Plugin lifecycle cancellation tests passed.');
