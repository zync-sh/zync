import assert from 'node:assert/strict';
import {
  clearIdleHostSuspendNotice,
  IDLE_HOST_SUSPEND_MESSAGE,
  writeIdleHostSuspendNotice,
} from '../.tmp-agent-tests/src/lib/terminal/terminalIdleSuspendNotice.js';
import { terminalCache } from '../.tmp-agent-tests/src/lib/terminal/terminalCache.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  fail ${name}`);
    throw error;
  }
}

runTest('writeIdleHostSuspendNotice writes once per suspend cycle', () => {
  terminalCache.clear();
  const writes = [];
  terminalCache.set('shell-1', {
    term: { write: (data) => writes.push(data) },
    ligaturesEnabled: false,
  });

  writeIdleHostSuspendNotice('shell-1');
  writeIdleHostSuspendNotice('shell-1');

  assert.equal(writes.length, 1);
  assert.equal(writes[0], IDLE_HOST_SUSPEND_MESSAGE);
});

runTest('clearIdleHostSuspendNotice allows a fresh banner', () => {
  terminalCache.clear();
  const writes = [];
  terminalCache.set('shell-2', {
    term: { write: (data) => writes.push(data) },
    idleSuspendNoticeShown: true,
    ligaturesEnabled: false,
  });

  clearIdleHostSuspendNotice('shell-2');
  writeIdleHostSuspendNotice('shell-2');

  assert.equal(writes.length, 1);
});

console.log('Terminal idle suspend notice tests passed.');