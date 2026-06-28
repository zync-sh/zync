import assert from 'node:assert/strict';
import {
  getLatestTerminalActivityAt,
  isTerminalBusyForIdleSuspend,
  touchTerminalActivity,
} from '../.tmp-agent-tests/src/lib/terminal/terminalActivity.js';
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

function seedTab(id, overrides = {}) {
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
    ...overrides,
  });
}

runTest('isTerminalBusyForIdleSuspend is false for quiet spawned shell', () => {
  terminalCache.clear();
  seedTab('shell-quiet');
  assert.equal(isTerminalBusyForIdleSuspend('shell-quiet', Date.now() - 60_000), false);
});

runTest('isTerminalBusyForIdleSuspend is true after recent output', () => {
  terminalCache.clear();
  const backgroundedAt = 1_000;
  seedTab('shell-busy');
  touchTerminalActivity('shell-busy', 2_000);
  assert.equal(isTerminalBusyForIdleSuspend('shell-busy', backgroundedAt), true);
});

runTest('isTerminalBusyForIdleSuspend is true with buffered input', () => {
  terminalCache.clear();
  seedTab('shell-input', { pendingInput: 'npm test', pendingInputBytes: 8 });
  assert.equal(isTerminalBusyForIdleSuspend('shell-input', Date.now() - 60_000), true);
});

runTest('getLatestTerminalActivityAt tracks the newest tab activity', () => {
  terminalCache.clear();
  seedTab('shell-a');
  seedTab('shell-b');
  touchTerminalActivity('shell-a', 1_500);
  touchTerminalActivity('shell-b', 2_500);
  assert.equal(
    getLatestTerminalActivityAt([{ id: 'shell-a' }, { id: 'shell-b' }], 1_000),
    2_500,
  );
});

console.log('Terminal activity tests passed.');