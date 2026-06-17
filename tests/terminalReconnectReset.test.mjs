import assert from 'node:assert/strict';
import { resetTerminalPtyForReconnect } from '../.tmp-agent-tests/src/lib/terminal/ptyLifecycle.js';
import { terminalCache } from '../.tmp-agent-tests/src/lib/terminal/terminalCache.js';

const SESSION = 'reconnect-reset-test';
const ipcKills = [];

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  fail ${name}`);
    throw error;
  }
}

globalThis.window = {
  ipcRenderer: {
    send: (_channel, payload) => {
      ipcKills.push(payload);
    },
  },
};

runTest('resetTerminalPtyForReconnect clears stale live PTY flags', () => {
  terminalCache.clear();
  ipcKills.length = 0;
  terminalCache.set(SESSION, {
    term: { rows: 24, cols: 80 },
    fitAddon: {},
    searchAddon: {},
    generation: 3,
    spawned: true,
    starting: false,
    listenerAttached: true,
    pendingInput: 'ls',
    inputFlushTimer: null,
    lastResize: { rows: 24, cols: 80 },
    ligaturesEnabled: false,
  });

  resetTerminalPtyForReconnect(SESSION);

  const cached = terminalCache.get(SESSION);
  assert.equal(cached.spawned, false);
  assert.equal(cached.starting, false);
  assert.equal(cached.generation, 4);
  assert.equal(cached.pendingInput, '');
  assert.equal(cached.lastResize, null);
  assert.equal(ipcKills.length, 1);
  assert.equal(ipcKills[0].termId, SESSION);
});

console.log('Terminal reconnect reset tests passed.');