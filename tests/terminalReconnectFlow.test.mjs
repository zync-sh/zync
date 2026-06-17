import assert from 'node:assert/strict';
import {
  markConnectionBackendLive,
  markConnectionBackendOffline,
  isConnectionBackendLive,
} from '../.tmp-agent-tests/src/lib/terminal/connectionBackend.js';
import { spawnTerminalSession } from '../.tmp-agent-tests/src/lib/terminal/ptyLifecycle.js';
import { suspendAllTerminalsForConnection } from '../.tmp-agent-tests/src/lib/terminal/suspendAllTerminals.js';
import { terminalCache } from '../.tmp-agent-tests/src/lib/terminal/terminalCache.js';

const HOST = 'ssh_reconnect-flow';
const SESSION = 'term-reconnect-flow';
const ipcCreates = [];
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

function seedCache() {
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
    spawned: true,
    starting: false,
    listenerAttached: true,
    pendingInput: '',
    inputFlushTimer: null,
    lastResize: null,
    ligaturesEnabled: false,
  });
}

globalThis.window = {
  ipcRenderer: {
    invoke: (_channel, payload) => {
      ipcCreates.push(payload);
      return Promise.resolve();
    },
    send: (_channel, payload) => {
      if (_channel === 'terminal:kill') {
        ipcKills.push(payload);
      }
    },
  },
};

runTest('disconnect flow blocks remote spawn until backend is live again', () => {
  terminalCache.clear();
  ipcCreates.length = 0;
  ipcKills.length = 0;
  seedCache();
  markConnectionBackendLive(HOST);

  assert.equal(
    spawnTerminalSession({
      termId: SESSION,
      connectionId: HOST,
      term: terminalCache.get(SESSION).term,
      remoteReady: true,
    }),
    false,
    'already-spawned session should not double-spawn',
  );

  markConnectionBackendOffline(HOST);
  terminalCache.get(SESSION).spawned = false;
  terminalCache.get(SESSION).starting = false;

  assert.equal(
    spawnTerminalSession({
      termId: SESSION,
      connectionId: HOST,
      term: terminalCache.get(SESSION).term,
      remoteReady: true,
    }),
    false,
    'spawn must wait until ssh_connect completes',
  );

  markConnectionBackendLive(HOST);
  assert.equal(
    spawnTerminalSession({
      termId: SESSION,
      connectionId: HOST,
      term: terminalCache.get(SESSION).term,
      remoteReady: true,
    }),
    true,
  );
  assert.equal(ipcCreates.length, 1);
  assert.equal(ipcCreates[0].connectionId, HOST);
});

runTest('suspendAllTerminalsForConnection kills PTYs without destroying tabs', () => {
  terminalCache.clear();
  ipcKills.length = 0;
  seedCache();

  suspendAllTerminalsForConnection([{ id: SESSION }]);

  const cached = terminalCache.get(SESSION);
  assert.ok(cached, 'xterm cache survives disconnect suspend');
  assert.equal(cached.spawned, false);
  assert.equal(ipcKills.length, 1);
  assert.equal(ipcKills[0].termId, SESSION);
});

console.log('Terminal reconnect flow tests passed.');