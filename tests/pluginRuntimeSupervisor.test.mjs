import assert from 'node:assert/strict';
import { PluginRuntimeSupervisor } from '../.tmp-agent-tests/src/features/plugins/runtime/pluginRuntimeSupervisor.js';

let now = 1_000;
const supervisor = new PluginRuntimeSupervisor(() => now, 3, 60_000);
const updates = [];
const unsubscribe = supervisor.subscribe(health => updates.push(health));

supervisor.syncKnownPlugins([
  { pluginId: 'active-plugin', enabled: true, runnable: true },
  { pluginId: 'disabled-plugin', enabled: false, runnable: true },
  { pluginId: 'pane-only-plugin', enabled: true, runnable: false },
]);
assert.equal(supervisor.snapshot().find(item => item.pluginId === 'disabled-plugin')?.status, 'disabled');
assert.equal(supervisor.snapshot().find(item => item.pluginId === 'pane-only-plugin')?.status, 'inactive');

assert.equal(supervisor.beginStart('active-plugin'), true);
const firstWorker = { terminated: false, terminate() { this.terminated = true; } };
supervisor.attach('active-plugin', firstWorker, 'runtime-1');
assert.equal(supervisor.getWorker('active-plugin'), firstWorker);
assert.equal(supervisor.getRuntimeInstanceId('active-plugin'), 'runtime-1');
assert.equal(supervisor.snapshot().find(item => item.pluginId === 'active-plugin')?.status, 'active');

assert.equal(supervisor.markCrash('active-plugin', { terminate() {} }, new Error('stale')), null);
assert.equal(supervisor.markCrash('active-plugin', firstWorker, new Error('boom 1')), 'runtime-1');
assert.equal(firstWorker.terminated, true);
assert.equal(supervisor.snapshot().find(item => item.pluginId === 'active-plugin')?.status, 'crashed');

supervisor.beginStart('active-plugin');
supervisor.markStartFailure('active-plugin', new Error('boom 2'));
supervisor.beginStart('active-plugin');
supervisor.markStartFailure('active-plugin', new Error('boom 3'));
assert.equal(supervisor.snapshot().find(item => item.pluginId === 'active-plugin')?.status, 'quarantined');
assert.equal(supervisor.beginStart('active-plugin'), false);

supervisor.clearQuarantine('active-plugin');
assert.equal(supervisor.beginStart('active-plugin'), true);
const recoveredWorker = { terminated: false, terminate() { this.terminated = true; } };
supervisor.attach('active-plugin', recoveredWorker, 'runtime-2');
supervisor.stopAll(() => {});
assert.equal(recoveredWorker.terminated, true);
assert.equal(supervisor.snapshot().find(item => item.pluginId === 'active-plugin')?.status, 'inactive');

now += 61_000;
supervisor.markStartFailure('active-plugin', new Error('later'));
assert.equal(supervisor.snapshot().find(item => item.pluginId === 'active-plugin')?.crashCount, 1);
assert.ok(updates.length > 5);
unsubscribe();

let heartbeatNow = 5_000;
const heartbeatSupervisor = new PluginRuntimeSupervisor(() => heartbeatNow, 3, 60_000);
heartbeatSupervisor.syncKnownPlugins([{ pluginId: 'heartbeat-plugin', enabled: true, runnable: true }]);
heartbeatSupervisor.beginStart('heartbeat-plugin');
const heartbeatWorker = { terminated: false, messages: [], terminate() { this.terminated = true; } };
heartbeatSupervisor.attach('heartbeat-plugin', heartbeatWorker, 'heartbeat-runtime');

const firstPoll = heartbeatSupervisor.pollHeartbeats(15_000);
assert.equal(firstPoll.probes.length, 1);
assert.equal(firstPoll.unresponsive.length, 0);
assert.equal(heartbeatSupervisor.acknowledgeHeartbeat('heartbeat-plugin', heartbeatWorker, -1), false);
assert.equal(
  heartbeatSupervisor.acknowledgeHeartbeat('heartbeat-plugin', heartbeatWorker, firstPoll.probes[0].nonce),
  true,
);

const beforeSuspend = heartbeatSupervisor.pollHeartbeats(15_000);
heartbeatNow += 31_000;
const afterSuspend = heartbeatSupervisor.pollHeartbeats(15_000);
assert.equal(afterSuspend.unresponsive.length, 0, 'a suspended host must not quarantine responsive plugins');
assert.equal(afterSuspend.probes.length, 1, 'a suspended host starts a fresh heartbeat cycle');
assert.equal(
  heartbeatSupervisor.acknowledgeHeartbeat('heartbeat-plugin', heartbeatWorker, beforeSuspend.probes[0].nonce),
  false,
  'a reply from the abandoned pre-suspend cycle must be rejected',
);
assert.equal(
  heartbeatSupervisor.acknowledgeHeartbeat('heartbeat-plugin', heartbeatWorker, afterSuspend.probes[0].nonce),
  true,
);

heartbeatSupervisor.pollHeartbeats(15_000);
heartbeatNow += 15_000;
const timedOut = heartbeatSupervisor.pollHeartbeats(15_000);
assert.deepEqual(timedOut.unresponsive, [{
  pluginId: 'heartbeat-plugin',
  runtimeInstanceId: 'heartbeat-runtime',
}]);
assert.equal(heartbeatWorker.terminated, true);
assert.equal(heartbeatSupervisor.snapshot()[0].status, 'crashed');

const restoredSupervisor = new PluginRuntimeSupervisor(() => 100_000, 3, 60_000);
restoredSupervisor.restoreFailures('restored-plugin', [70_000, 80_000, 90_000], 'worker-error');
restoredSupervisor.syncKnownPlugins([{
  pluginId: 'restored-plugin',
  enabled: true,
  runnable: true,
}]);
assert.equal(restoredSupervisor.snapshot()[0].status, 'quarantined');
assert.equal(restoredSupervisor.beginStart('restored-plugin'), false);

const safeModeSupervisor = new PluginRuntimeSupervisor(() => 100_000);
safeModeSupervisor.syncKnownPlugins([{
  pluginId: 'third-party',
  enabled: true,
  runnable: true,
  safeModeBlocked: true,
}]);
assert.equal(safeModeSupervisor.snapshot()[0].status, 'safe-mode');
assert.equal(safeModeSupervisor.beginStart('third-party'), false);
safeModeSupervisor.syncKnownPlugins([{
  pluginId: 'third-party',
  enabled: true,
  runnable: true,
  safeModeBlocked: false,
}]);
assert.equal(safeModeSupervisor.beginStart('third-party'), true);

console.log('Plugin runtime supervisor tests passed.');
