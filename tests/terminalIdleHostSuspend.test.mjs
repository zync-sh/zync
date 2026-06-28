import assert from 'node:assert/strict';
import { suspendAllTerminalsForConnection } from '../.tmp-agent-tests/src/lib/terminal/suspendAllTerminals.js';
import { isTerminalIdleSuspended } from '../.tmp-agent-tests/src/lib/terminal/ptyLifecycle.js';
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

const ipcKills = [];

globalThis.window = {
  ipcRenderer: {
    invoke: () => Promise.resolve(),
    send: (_channel, payload) => {
      ipcKills.push(payload);
    },
  },
};

function seedTab(id) {
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
  });
}

runTest('suspendAllTerminalsForConnection idleHost marks tabs idle-suspended', () => {
  terminalCache.clear();
  ipcKills.length = 0;
  seedTab('shell-a');
  seedTab('shell-b');

  suspendAllTerminalsForConnection([{ id: 'shell-a' }, { id: 'shell-b' }], { idleHost: true });

  assert.equal(isTerminalIdleSuspended('shell-a'), true);
  assert.equal(isTerminalIdleSuspended('shell-b'), true);
  assert.equal(ipcKills.length, 2);
});

console.log('Terminal idle host suspend tests passed.');