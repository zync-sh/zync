import assert from 'node:assert/strict';
import {
  canSendTerminalInput,
  flushPendingInput,
  handleTerminalReady,
  queueTerminalInput,
} from '../.tmp-agent-tests/src/lib/terminal/inputPipeline.js';
import { terminalCache } from '../.tmp-agent-tests/src/lib/terminal/terminalCache.js';

const SESSION = 'input-pipeline-test';
const ipcWrites = [];

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
    term: { rows: 24 },
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

globalThis.window = {
  ipcRenderer: {
    send: (_channel, payload) => {
      ipcWrites.push(payload);
    },
  },
  setTimeout: (fn) => {
    fn();
    return 1;
  },
  clearTimeout: () => {},
};

runTest('canSendTerminalInput is false while starting', () => {
  terminalCache.clear();
  ipcWrites.length = 0;
  seedCache({ starting: true });
  assert.equal(canSendTerminalInput(SESSION), false);
});

runTest('queueTerminalInput buffers without IPC while starting', () => {
  terminalCache.clear();
  ipcWrites.length = 0;
  seedCache({ starting: true });
  queueTerminalInput(SESSION, 'abc');
  assert.equal(terminalCache.get(SESSION).pendingInput, 'abc');
  assert.equal(ipcWrites.length, 0);
});

runTest('handleTerminalReady flushes buffered input', () => {
  terminalCache.clear();
  ipcWrites.length = 0;
  seedCache({ starting: true, pendingInput: 'ls\r', generation: 2 });
  assert.equal(handleTerminalReady(SESSION, 2), true);
  assert.equal(terminalCache.get(SESSION).starting, false);
  assert.equal(ipcWrites.length, 1);
  assert.equal(ipcWrites[0].data, 'ls\r');
});

runTest('handleTerminalReady clears idle-suspend guard after successful spawn', () => {
  terminalCache.clear();
  seedCache({ starting: true, generation: 2, suspendedByIdle: true, idleSuspendNoticeShown: true });
  assert.equal(handleTerminalReady(SESSION, 2), true);
  assert.equal(terminalCache.get(SESSION).suspendedByIdle, false);
  assert.equal(terminalCache.get(SESSION).idleSuspendNoticeShown, false);
});

runTest('flushPendingInput is a no-op while starting', () => {
  terminalCache.clear();
  ipcWrites.length = 0;
  seedCache({ starting: true, pendingInput: 'pwd' });
  flushPendingInput(SESSION);
  assert.equal(ipcWrites.length, 0);
  assert.equal(terminalCache.get(SESSION).pendingInput, 'pwd');
});

runTest('queueTerminalInput buffers without IPC when PTY is suspended', () => {
  terminalCache.clear();
  ipcWrites.length = 0;
  seedCache({ spawned: false, starting: false });
  queueTerminalInput(SESSION, 'echo');
  assert.equal(terminalCache.get(SESSION).pendingInput, 'echo');
  assert.equal(ipcWrites.length, 0);
});

runTest('canSendTerminalInput is false when PTY is not spawned', () => {
  terminalCache.clear();
  seedCache({ spawned: false, starting: false });
  assert.equal(canSendTerminalInput(SESSION), false);
});

runTest('handleTerminalReady rejects stale generation', () => {
  terminalCache.clear();
  ipcWrites.length = 0;
  seedCache({ starting: true, pendingInput: 'pwd', generation: 3 });
  assert.equal(handleTerminalReady(SESSION, 2), false);
  assert.equal(terminalCache.get(SESSION).starting, true);
  assert.equal(ipcWrites.length, 0);
});

runTest('queueTerminalInput no-ops when cache entry is missing', () => {
  terminalCache.clear();
  ipcWrites.length = 0;
  queueTerminalInput(SESSION, 'echo hi');
  assert.equal(ipcWrites.length, 0);
});

console.log('Terminal input pipeline tests passed.');