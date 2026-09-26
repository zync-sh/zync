import assert from 'node:assert/strict';
import { autoRollbackPlugin } from '../.tmp-agent-tests/src/features/plugins/runtime/pluginAutoRollback.js';

function harness(healthChecks) {
  const calls = [];
  let swap = 0;
  return {
    calls,
    dependencies: {
      rollback: async pluginId => {
        calls.push(`rollback:${pluginId}`);
        swap += 1;
        return swap === 1
          ? { pluginId, restoredVersion: '1.0.0', replacedVersion: '2.0.0' }
          : { pluginId, restoredVersion: '2.0.0', replacedVersion: '1.0.0' };
      },
      clearFailures: async pluginId => calls.push(`clear:${pluginId}`),
      clearQuarantine: pluginId => calls.push(`unquarantine:${pluginId}`),
      reloadAndCheck: async pluginId => {
        calls.push(`check:${pluginId}`);
        return healthChecks.shift() ?? false;
      },
    },
  };
}

{
  const { calls, dependencies } = harness([true]);
  const result = await autoRollbackPlugin('dev.example.tool', dependencies);
  assert.deepEqual(result, {
    status: 'restored',
    restoredVersion: '1.0.0',
    replacedVersion: '2.0.0',
  });
  assert.deepEqual(calls, [
    'rollback:dev.example.tool',
    'clear:dev.example.tool',
    'unquarantine:dev.example.tool',
    'check:dev.example.tool',
  ]);
}

{
  const { calls, dependencies } = harness([false, true]);
  const result = await autoRollbackPlugin('dev.example.tool', dependencies);
  assert.deepEqual(result, {
    status: 'reverted',
    failedVersion: '1.0.0',
    restoredVersion: '2.0.0',
    runtimeHealthy: true,
  });
  assert.equal(calls.filter(call => call.startsWith('rollback:')).length, 2);
  assert.equal(calls.filter(call => call.startsWith('check:')).length, 2);
}

console.log('Plugin automatic rollback tests passed.');
