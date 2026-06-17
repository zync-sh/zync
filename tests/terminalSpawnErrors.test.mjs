import assert from 'node:assert/strict';
import {
  TERMINAL_SPAWN_CONNECTION_NOT_READY,
  connectionNotReadyError,
  formatTerminalSpawnError,
  isTerminalSpawnConnectionNotReadyError,
} from '../.tmp-agent-tests/src/lib/terminal/terminalSpawnErrors.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  fail ${name}`);
    throw error;
  }
}

runTest('connectionNotReadyError uses stable machine-readable prefix', () => {
  assert.equal(
    connectionNotReadyError('ssh_abc'),
    `${TERMINAL_SPAWN_CONNECTION_NOT_READY}ssh_abc`,
  );
});

runTest('isTerminalSpawnConnectionNotReadyError matches structured backend errors', () => {
  const err = connectionNotReadyError('ssh_abc');
  assert.equal(isTerminalSpawnConnectionNotReadyError(err), true);
  assert.equal(isTerminalSpawnConnectionNotReadyError(err, 'ssh_abc'), true);
  assert.equal(isTerminalSpawnConnectionNotReadyError(err, 'ssh_other'), false);
  assert.equal(isTerminalSpawnConnectionNotReadyError('random failure'), false);
});

runTest('formatTerminalSpawnError returns reconnect guidance for not-ready errors', () => {
  const formatted = formatTerminalSpawnError(connectionNotReadyError('ssh_abc'));
  assert.match(formatted, /Reconnect/i);
  assert.doesNotMatch(formatted, /CONNECTION_NOT_READY/);
});

console.log('Terminal spawn error tests passed.');