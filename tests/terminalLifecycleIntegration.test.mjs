import assert from 'node:assert/strict';
import {
  spawnTerminalSession,
  suspendTerminalPty,
} from '../.tmp-agent-tests/src/lib/terminal/ptyLifecycle.js';
import {
  handleTerminalReady,
  queueTerminalInput,
} from '../.tmp-agent-tests/src/lib/terminal/inputPipeline.js';
import { syncTerminalResize } from '../.tmp-agent-tests/src/lib/terminal/terminalResizeSync.js';
import { terminalCache } from '../.tmp-agent-tests/src/lib/terminal/terminalCache.js';

const SESSION = 'lifecycle-integration';
const ipcCreates = [];
const ipcKills = [];
const ipcResizes = [];
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
    lastResize: null,
    ligaturesEnabled: false,
    ...overrides,
  });
}

globalThis.window = {
  ipcRenderer: {
    invoke: (_channel, payload) => {
      ipcCreates.push(payload);
      return Promise.resolve();
    },
    send: (channel, payload) => {
      if (channel === 'terminal:kill') ipcKills.push(payload);
      if (channel === 'terminal:resize') ipcResizes.push(payload);
      if (channel === 'terminal:write') ipcWrites.push(payload);
    },
  },
  setTimeout: (fn) => {
    fn();
    return 1;
  },
  clearTimeout: () => {},
};

runTest('spawn → ready → resize → suspend → respawn generation chain', () => {
  terminalCache.clear();
  ipcCreates.length = 0;
  ipcKills.length = 0;
  ipcResizes.length = 0;
  ipcWrites.length = 0;
  seedCache();

  const term = terminalCache.get(SESSION).term;

  assert.equal(
    spawnTerminalSession({ termId: SESSION, connectionId: 'local', term }),
    true,
  );
  assert.equal(terminalCache.get(SESSION).generation, 2);
  assert.equal(terminalCache.get(SESSION).starting, true);

  queueTerminalInput(SESSION, 'ls\r');
  assert.equal(ipcWrites.length, 0);

  assert.equal(handleTerminalReady(SESSION, 2), true);
  assert.equal(terminalCache.get(SESSION).starting, false);
  assert.equal(ipcWrites.length, 1);
  assert.equal(ipcWrites[0].data, 'ls\r');

  syncTerminalResize(SESSION, term);
  assert.equal(ipcResizes.length, 1);
  assert.deepEqual(ipcResizes[0], { termId: SESSION, rows: 24, cols: 80 });

  syncTerminalResize(SESSION, term);
  assert.equal(ipcResizes.length, 1, 'duplicate resize is deduped');

  suspendTerminalPty(SESSION, { panelHide: true });
  assert.equal(terminalCache.get(SESSION).generation, 3);
  assert.equal(terminalCache.get(SESSION).spawned, false);
  assert.equal(ipcKills.length, 1);

  assert.equal(handleTerminalReady(SESSION, 2), false, 'stale ready after suspend');

  assert.equal(
    spawnTerminalSession({ termId: SESSION, connectionId: 'local', term }),
    true,
  );
  assert.equal(terminalCache.get(SESSION).generation, 4);
  assert.equal(ipcCreates[1].generation, 4);
});

console.log('Terminal lifecycle integration tests passed.');