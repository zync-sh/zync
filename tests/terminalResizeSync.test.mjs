import assert from 'node:assert/strict';
import { syncTerminalResize } from '../.tmp-agent-tests/src/lib/terminal/terminalResizeSync.js';
import { terminalCache } from '../.tmp-agent-tests/src/lib/terminal/terminalCache.js';

const SESSION = 'resize-sync-test';
const ipcResizes = [];

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  fail ${name}`);
    throw error;
  }
}

const term = { rows: 24, cols: 80 };

globalThis.window = {
  ipcRenderer: {
    send: (_channel, payload) => {
      ipcResizes.push(payload);
    },
  },
};

runTest('syncTerminalResize skips IPC when cache entry is missing', () => {
  terminalCache.clear();
  ipcResizes.length = 0;
  syncTerminalResize(SESSION, term);
  assert.equal(ipcResizes.length, 0);
});

runTest('syncTerminalResize skips IPC while PTY is not spawned', () => {
  terminalCache.clear();
  ipcResizes.length = 0;
  terminalCache.set(SESSION, {
    term,
    fitAddon: {},
    searchAddon: {},
    generation: 1,
    spawned: false,
    starting: false,
    listenerAttached: false,
    pendingInput: '',
    inputFlushTimer: null,
    lastResize: null,
    ligaturesEnabled: false,
  });
  syncTerminalResize(SESSION, term);
  assert.equal(ipcResizes.length, 0);
});

runTest('syncTerminalResize skips IPC while PTY is starting', () => {
  terminalCache.clear();
  ipcResizes.length = 0;
  terminalCache.set(SESSION, {
    term,
    fitAddon: {},
    searchAddon: {},
    generation: 1,
    spawned: true,
    starting: true,
    listenerAttached: false,
    pendingInput: '',
    inputFlushTimer: null,
    lastResize: null,
    ligaturesEnabled: false,
  });
  syncTerminalResize(SESSION, term);
  assert.equal(ipcResizes.length, 0);
});

runTest('syncTerminalResize sends IPC when PTY is live', () => {
  terminalCache.clear();
  ipcResizes.length = 0;
  terminalCache.set(SESSION, {
    term,
    fitAddon: {},
    searchAddon: {},
    generation: 1,
    spawned: true,
    starting: false,
    listenerAttached: false,
    pendingInput: '',
    inputFlushTimer: null,
    lastResize: null,
    ligaturesEnabled: false,
  });
  syncTerminalResize(SESSION, term);
  assert.equal(ipcResizes.length, 1);
  assert.deepEqual(ipcResizes[0], { termId: SESSION, rows: 24, cols: 80 });
});

console.log('Terminal resize sync tests passed.');