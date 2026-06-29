import assert from 'node:assert/strict';
import { LOCAL_TERMINAL_CONNECTION_ID } from '../.tmp-agent-tests/src/lib/terminal/connectionIds.js';
import { shouldIdleSuspendConnection } from '../.tmp-agent-tests/src/lib/terminal/terminalIdlePty.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  fail ${name}`);
    throw error;
  }
}

runTest('shouldIdleSuspendConnection skips local workspace host', () => {
  assert.equal(shouldIdleSuspendConnection(LOCAL_TERMINAL_CONNECTION_ID), false);
  assert.equal(shouldIdleSuspendConnection('ssh_prod'), true);
});

console.log('Terminal tab close policy tests passed.');