import assert from 'node:assert/strict';
import {
  cancelAllIdlePtySuspends,
  cancelIdlePtySuspend,
  flushIdlePtySuspend,
  resolveIdleHostPtySuspendDelayMs,
  scheduleIdlePtySuspend,
} from '../.tmp-agent-tests/src/lib/terminal/terminalIdlePty.js';
import { touchTerminalActivity } from '../.tmp-agent-tests/src/lib/terminal/terminalActivity.js';
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

runTest('resolveIdleHostPtySuspendDelayMs returns null when disabled', () => {
  assert.equal(resolveIdleHostPtySuspendDelayMs(false, 2), null);
});

runTest('resolveIdleHostPtySuspendDelayMs converts minutes to ms', () => {
  assert.equal(resolveIdleHostPtySuspendDelayMs(true, 2), 120_000);
});

runTest('flushIdlePtySuspend skips busy tabs with recent shell activity', () => {
  terminalCache.clear();
  const suspended = [];
  seedBusyTab('shell-busy');

  scheduleIdlePtySuspend('conn-busy', [{ id: 'shell-busy' }], {
    delayMs: 60_000,
    backgroundedAt: 1_000,
    onSuspend: (tabs) => {
      suspended.push(...tabs.map((tab) => tab.id));
    },
  });

  touchTerminalActivity('shell-busy', 2_000);
  flushIdlePtySuspend('conn-busy');
  assert.deepEqual(suspended, []);
});

function seedBusyTab(id) {
  terminalCache.set(id, {
    term: { rows: 24, cols: 80, clear() {}, reset() {}, write() {} },
    fitAddon: {},
    searchAddon: {},
    generation: 1,
    spawned: true,
    starting: false,
    listenerAttached: false,
    pendingInput: '',
    pendingInputBytes: 0,
    inputFlushTimer: null,
    lastResize: null,
    ligaturesEnabled: false,
  });
}

cancelAllIdlePtySuspends();

console.log('Terminal idle PTY suspend tests passed.');