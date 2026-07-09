import assert from 'node:assert/strict';
import {
  snapshotActiveTunnelsForReconnect,
  restartTunnelsAfterConnect,
} from '../.tmp-agent-tests/src/features/tunnels/application/tunnelReconnectService.js';

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

await runTest('snapshotActiveTunnelsForReconnect stores only active tunnel ids', async () => {
  snapshotActiveTunnelsForReconnect('conn-1', [
    { id: 't1', status: 'active' },
    { id: 't2', status: 'stopped' },
    { id: 't3', status: 'active' },
    { id: 't4' },
  ]);

  const started = [];
  await restartTunnelsAfterConnect({
    connectionId: 'conn-1',
    tunnels: [
      { id: 't1', name: 'one' },
      { id: 't3', name: 'three' },
    ],
    startTunnel: async (id) => { started.push(id); },
    onTunnelError: () => {},
  });

  assert.deepEqual(started.sort(), ['t1', 't3']);
});

await runTest('restartTunnelsAfterConnect merges remembered active and auto-start tunnels', async () => {
  snapshotActiveTunnelsForReconnect('conn-2', [
    { id: 'active-a', status: 'active' },
    { id: 'active-b', status: 'active' },
  ]);

  const started = [];
  const count = await restartTunnelsAfterConnect({
    connectionId: 'conn-2',
    tunnels: [
      { id: 'active-a', name: 'A', autoStart: true },
      { id: 'active-b', name: 'B' },
      { id: 'auto-only', name: 'Auto', autoStart: true },
      { id: 'manual', name: 'Manual', autoStart: false },
    ],
    startTunnel: async (id) => { started.push(id); },
    onTunnelError: () => {},
  });

  assert.equal(count, 3);
  assert.deepEqual(started.sort(), ['active-a', 'active-b', 'auto-only']);
});

await runTest('restartTunnelsAfterConnect clears remembered snapshot after use', async () => {
  snapshotActiveTunnelsForReconnect('conn-3', [
    { id: 'was-active', status: 'active' },
  ]);

  await restartTunnelsAfterConnect({
    connectionId: 'conn-3',
    tunnels: [{ id: 'was-active', name: 'Was active' }],
    startTunnel: async () => {},
    onTunnelError: () => {},
  });

  const started = [];
  await restartTunnelsAfterConnect({
    connectionId: 'conn-3',
    tunnels: [{ id: 'was-active', name: 'Was active' }],
    startTunnel: async (id) => { started.push(id); },
    onTunnelError: () => {},
  });

  assert.deepEqual(started, []);
});

await runTest('restartTunnelsAfterConnect reports per-tunnel failures via onTunnelError', async () => {
  const errors = [];
  const count = await restartTunnelsAfterConnect({
    connectionId: 'conn-4',
    tunnels: [
      { id: 'ok', name: 'OK', autoStart: true },
      { id: 'fail', name: 'Fail', autoStart: true },
    ],
    startTunnel: async (id) => {
      if (id === 'fail') throw new Error('bind failed');
    },
    onTunnelError: (tunnel, error) => {
      errors.push(`${tunnel.id}:${error.message}`);
    },
  });

  assert.equal(count, 1);
  assert.deepEqual(errors, ['fail:bind failed']);
});

await runTest('restartTunnelsAfterConnect returns zero when nothing to restart', async () => {
  const started = [];
  const count = await restartTunnelsAfterConnect({
    connectionId: 'conn-empty',
    tunnels: [{ id: 'manual', name: 'Manual', autoStart: false }],
    startTunnel: async (id) => { started.push(id); },
    onTunnelError: () => {},
  });

  assert.equal(count, 0);
  assert.deepEqual(started, []);
});

console.log('Tunnel reconnect service tests passed.');