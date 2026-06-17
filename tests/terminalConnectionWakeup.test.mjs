import assert from 'node:assert/strict';
import {
  TERMINAL_CONNECTION_WAKEUP_EVENT,
  dispatchTerminalConnectionWakeup,
  tryWakeTerminalOnReconnect,
} from '../.tmp-agent-tests/src/lib/terminal/terminalConnectionWakeup.js';
import { markConnectionBackendLive } from '../.tmp-agent-tests/src/lib/terminal/connectionBackend.js';
import { terminalCache } from '../.tmp-agent-tests/src/lib/terminal/terminalCache.js';

const SESSION = 'wakeup-test';
const ipcCreates = [];

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  fail ${name}`);
    throw error;
  }
}

function seedCache(overrides = {}) {
  terminalCache.set(SESSION, {
    term: {
      rows: 24,
      cols: 80,
      clear: () => {},
      reset: () => {},
      write: () => {},
    },
    fitAddon: {},
    searchAddon: {},
    generation: 1,
    spawned: false,
    starting: false,
    listenerAttached: false,
    pendingInput: '',
    inputFlushTimer: null,
    lastResize: { rows: 24, cols: 80 },
    ligaturesEnabled: false,
    ...overrides,
  });
}

const dispatched = [];
globalThis.window = {
  ipcRenderer: {
    invoke: (_channel, payload) => {
      ipcCreates.push(payload);
      return Promise.resolve();
    },
    send: () => {},
  },
  dispatchEvent: (event) => {
    dispatched.push(event);
  },
  CustomEvent: class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  },
};

runTest('dispatchTerminalConnectionWakeup emits one event per tab id', () => {
  dispatched.length = 0;
  dispatchTerminalConnectionWakeup(['term-a', 'term-b']);
  assert.equal(dispatched.length, 2);
  assert.equal(dispatched[0].type, TERMINAL_CONNECTION_WAKEUP_EVENT);
  assert.equal(dispatched[0].detail, 'term-a');
  assert.equal(dispatched[1].detail, 'term-b');
});

runTest('tryWakeTerminalOnReconnect spawns visible unspawned tab with clearBuffer', () => {
  terminalCache.clear();
  ipcCreates.length = 0;
  seedCache();
  markConnectionBackendLive('host-1');

  const term = terminalCache.get(SESSION).term;
  const spawned = tryWakeTerminalOnReconnect({
    sessionId: SESSION,
    connectionId: 'host-1',
    terminalKey: 'host-1',
    term,
    isVisible: true,
    terminals: {
      'host-1': [{ id: SESSION, initialPath: '/home/user' }],
    },
  });

  assert.equal(spawned, true);
  assert.equal(terminalCache.get(SESSION).starting, true);
  assert.equal(ipcCreates.length, 1);
  assert.equal(ipcCreates[0].connectionId, 'host-1');
  assert.equal(ipcCreates[0].cwd, '/home/user');
});

runTest('tryWakeTerminalOnReconnect is a no-op when tab is hidden', () => {
  terminalCache.clear();
  ipcCreates.length = 0;
  seedCache();

  const spawned = tryWakeTerminalOnReconnect({
    sessionId: SESSION,
    connectionId: 'host-1',
    terminalKey: 'host-1',
    term: terminalCache.get(SESSION).term,
    isVisible: false,
    terminals: {},
  });

  assert.equal(spawned, false);
  assert.equal(ipcCreates.length, 0);
});

runTest('tryWakeTerminalOnReconnect is a no-op when PTY is already live', () => {
  terminalCache.clear();
  ipcCreates.length = 0;
  seedCache({ spawned: true });

  const spawned = tryWakeTerminalOnReconnect({
    sessionId: SESSION,
    connectionId: 'host-1',
    terminalKey: 'host-1',
    term: terminalCache.get(SESSION).term,
    isVisible: true,
    terminals: {},
  });

  assert.equal(spawned, false);
  assert.equal(ipcCreates.length, 0);
});

console.log('Terminal connection wakeup tests passed.');