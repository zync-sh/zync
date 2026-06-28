import assert from 'node:assert/strict';
import {
  cancelAllIdlePtySuspends,
  cancelIdlePtySuspend,
  flushIdlePtySuspend,
  scheduleIdlePtySuspend,
} from '../.tmp-agent-tests/src/lib/terminal/terminalIdlePty.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  fail ${name}`);
    throw error;
  }
}

cancelAllIdlePtySuspends();

runTest('scheduleIdlePtySuspend invokes onSuspend after flush', () => {
  const suspended = [];
  scheduleIdlePtySuspend('conn-a', [{ id: 'shell-1' }, { id: 'shell-2' }], {
    delayMs: 60_000,
    onSuspend: (tabs) => {
      suspended.push(...tabs.map((tab) => tab.id));
    },
  });

  assert.deepEqual(suspended, []);
  flushIdlePtySuspend('conn-a');
  assert.deepEqual(suspended, ['shell-1', 'shell-2']);
});

runTest('cancelIdlePtySuspend prevents suspend', () => {
  const suspended = [];
  scheduleIdlePtySuspend('conn-b', [{ id: 'shell-3' }], {
    delayMs: 60_000,
    onSuspend: (tabs) => {
      suspended.push(tabs[0]?.id);
    },
  });

  cancelIdlePtySuspend('conn-b');
  flushIdlePtySuspend('conn-b');
  assert.deepEqual(suspended, []);
});

runTest('reschedule replaces prior timer for same connection', () => {
  const suspended = [];
  scheduleIdlePtySuspend('conn-c', [{ id: 'old' }], {
    delayMs: 60_000,
    onSuspend: (tabs) => {
      suspended.push(tabs[0]?.id);
    },
  });

  scheduleIdlePtySuspend('conn-c', [{ id: 'new' }], {
    delayMs: 60_000,
    onSuspend: (tabs) => {
      suspended.push(tabs[0]?.id);
    },
  });

  flushIdlePtySuspend('conn-c');
  assert.deepEqual(suspended, ['new']);
});

cancelAllIdlePtySuspends();

console.log('Terminal idle PTY suspend tests passed.');