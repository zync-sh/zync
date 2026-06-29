import assert from 'node:assert/strict';
import {
  cancelAllIdlePtySuspends,
  cancelIdlePtySuspend,
  flushIdlePtySuspend,
  partitionBackgroundHostTabs,
  resolveIdleHostPtySuspendDelayMs,
  scheduleIdlePtySuspend,
} from '../.tmp-agent-tests/src/lib/terminal/terminalIdlePty.js';
import { touchTerminalActivity } from '../.tmp-agent-tests/src/lib/terminal/terminalActivity.js';
import { terminalCache } from '../.tmp-agent-tests/src/lib/terminal/terminalCache.js';

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  fail ${name}`);
    throw error;
  }
}

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

await runTest('partitionBackgroundHostTabs can split inactive vs last-active shell tabs', () => {
  const { immediateTabs, delayedTabs } = partitionBackgroundHostTabs(
    [{ id: 'shell-a' }, { id: 'shell-b' }, { id: 'shell-c' }],
    'shell-b',
  );
  assert.deepEqual(immediateTabs.map((tab) => tab.id), ['shell-a', 'shell-c']);
  assert.deepEqual(delayedTabs.map((tab) => tab.id), ['shell-b']);
});

await runTest('scheduleIdlePtySuspend invokes onSuspend after flush', async () => {
  const suspended = [];
  scheduleIdlePtySuspend('conn-a', [{ id: 'shell-1' }, { id: 'shell-2' }], {
    delayMs: 60_000,
    isProcessBusy: async () => false,
    onSuspend: (tabs) => {
      suspended.push(...tabs.map((tab) => tab.id));
    },
  });

  assert.deepEqual(suspended, []);
  await flushIdlePtySuspend('conn-a');
  assert.deepEqual(suspended, ['shell-1', 'shell-2']);
});

await runTest('cancelIdlePtySuspend prevents suspend', async () => {
  const suspended = [];
  scheduleIdlePtySuspend('conn-b', [{ id: 'shell-3' }], {
    delayMs: 60_000,
    isProcessBusy: async () => false,
    onSuspend: (tabs) => {
      suspended.push(tabs[0]?.id);
    },
  });

  cancelIdlePtySuspend('conn-b');
  await flushIdlePtySuspend('conn-b');
  assert.deepEqual(suspended, []);
});

await runTest('reschedule replaces prior timer for same connection', async () => {
  const suspended = [];
  scheduleIdlePtySuspend('conn-c', [{ id: 'old' }], {
    delayMs: 60_000,
    isProcessBusy: async () => false,
    onSuspend: (tabs) => {
      suspended.push(tabs[0]?.id);
    },
  });

  scheduleIdlePtySuspend('conn-c', [{ id: 'new' }], {
    delayMs: 60_000,
    isProcessBusy: async () => false,
    onSuspend: (tabs) => {
      suspended.push(tabs[0]?.id);
    },
  });

  await flushIdlePtySuspend('conn-c');
  assert.deepEqual(suspended, ['new']);
});

await runTest('resolveIdleHostPtySuspendDelayMs returns null when disabled', () => {
  assert.equal(resolveIdleHostPtySuspendDelayMs(false, 2), null);
});

await runTest('resolveIdleHostPtySuspendDelayMs converts minutes to ms', () => {
  assert.equal(resolveIdleHostPtySuspendDelayMs(true, 2), 120_000);
});

await runTest('flushIdlePtySuspend skips busy tabs with recent shell activity', async () => {
  terminalCache.clear();
  const suspended = [];
  let suspendCalls = 0;
  seedBusyTab('shell-busy');

  scheduleIdlePtySuspend('conn-busy', [{ id: 'shell-busy' }], {
    delayMs: 60_000,
    backgroundedAt: 1_000,
    isProcessBusy: async () => false,
    onSuspend: (tabs) => {
      suspendCalls += 1;
      suspended.push(...tabs.map((tab) => tab.id));
    },
  });

  touchTerminalActivity('shell-busy', 2_000);
  await flushIdlePtySuspend('conn-busy');
  assert.equal(suspendCalls, 0);
  assert.deepEqual(suspended, []);
});

await runTest('flushIdlePtySuspend skips tabs with active child processes', async () => {
  terminalCache.clear();
  const suspended = [];
  let suspendCalls = 0;
  seedBusyTab('shell-proc');

  scheduleIdlePtySuspend('conn-proc', [{ id: 'shell-proc' }], {
    delayMs: 0,
    backgroundedAt: 1_000,
    isProcessBusy: async () => true,
    onSuspend: (tabs) => {
      suspendCalls += 1;
      suspended.push(...tabs.map((tab) => tab.id));
    },
  });

  await flushIdlePtySuspend('conn-proc');
  assert.equal(suspendCalls, 0);
  assert.deepEqual(suspended, []);
});

await runTest('flushIdlePtySuspend suspends after busy tab goes quiet', async () => {
  terminalCache.clear();
  const suspended = [];
  seedBusyTab('shell-quiet-later');

  scheduleIdlePtySuspend('conn-quiet', [{ id: 'shell-quiet-later' }], {
    delayMs: 0,
    backgroundedAt: 1_000,
    isProcessBusy: async () => false,
    onSuspend: (tabs) => {
      suspended.push(...tabs.map((tab) => tab.id));
    },
  });

  touchTerminalActivity('shell-quiet-later', 2_000);
  await flushIdlePtySuspend('conn-quiet');
  assert.deepEqual(suspended, []);

  await flushIdlePtySuspend('conn-quiet');
  assert.deepEqual(suspended, ['shell-quiet-later']);
});

cancelAllIdlePtySuspends();

console.log('Terminal idle PTY suspend tests passed.');