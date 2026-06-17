import assert from 'node:assert/strict';
import {
  spawnTerminalSession,
  suspendTerminalPty,
} from '../.tmp-agent-tests/src/lib/terminal/ptyLifecycle.js';
import {
  markConnectionBackendLive,
  markConnectionBackendOffline,
} from '../.tmp-agent-tests/src/lib/terminal/connectionBackend.js';
import { terminalCache } from '../.tmp-agent-tests/src/lib/terminal/terminalCache.js';

const SESSION = 'pty-lifecycle-test';
const ipcCreates = [];
const ipcKills = [];

async function runTest(name, fn) {
  try {
    await fn();
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
    pendingInputBytes: 0,
    inputFlushTimer: null,
    lastResize: { rows: 24, cols: 80 },
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
    send: (_channel, payload) => {
      ipcKills.push(payload);
    },
  },
};

(async () => {
await runTest('spawnTerminalSession marks cache as starting and sends terminal:create', () => {
  terminalCache.clear();
  ipcCreates.length = 0;
  seedCache();

  const spawned = spawnTerminalSession({
    termId: SESSION,
    connectionId: 'local',
    term: terminalCache.get(SESSION).term,
    clearBuffer: true,
    cwd: '/tmp',
    shell: 'pwsh.exe',
  });

  assert.equal(spawned, true);
  const cached = terminalCache.get(SESSION);
  assert.equal(cached.spawned, true);
  assert.equal(cached.starting, true);
  assert.equal(cached.generation, 2);
  assert.equal(ipcCreates.length, 1);
  assert.equal(ipcCreates[0].termId, SESSION);
  assert.equal(ipcCreates[0].cwd, '/tmp');
});

await runTest('spawnTerminalSession skips remote spawn until connection is ready', () => {
  terminalCache.clear();
  ipcCreates.length = 0;
  seedCache();
  markConnectionBackendOffline('ssh_test-host');

  const spawned = spawnTerminalSession({
    termId: SESSION,
    connectionId: 'ssh_test-host',
    term: terminalCache.get(SESSION).term,
    remoteReady: false,
  });

  assert.equal(spawned, false);
  assert.equal(ipcCreates.length, 0);
});

await runTest('spawnTerminalSession blocks respawn after missing connection config', async () => {
  terminalCache.clear();
  ipcCreates.length = 0;
  seedCache();
  markConnectionBackendLive('ssh_test-host');

  const originalInvoke = globalThis.window.ipcRenderer.invoke;
  globalThis.window.ipcRenderer.invoke = () =>
    Promise.reject('CONNECTION_NOT_READY:ssh_test-host');

  try {
    const term = terminalCache.get(SESSION).term;
    assert.equal(
      spawnTerminalSession({
        termId: SESSION,
        connectionId: 'ssh_test-host',
        term,
        remoteReady: true,
      }),
      true,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const cached = terminalCache.get(SESSION);
    assert.equal(cached.spawned, false);
    assert.equal(cached.starting, false);
    assert.equal(cached.spawnBlocked, true);
    assert.equal(
      spawnTerminalSession({
        termId: SESSION,
        connectionId: 'ssh_test-host',
        term,
        remoteReady: true,
      }),
      false,
    );
  } finally {
    globalThis.window.ipcRenderer.invoke = originalInvoke;
  }
});

await runTest('spawnTerminalSession is a no-op when already live', () => {
  terminalCache.clear();
  ipcCreates.length = 0;
  seedCache({ spawned: true, starting: false });

  const spawned = spawnTerminalSession({
    termId: SESSION,
    connectionId: 'local',
    term: terminalCache.get(SESSION).term,
  });

  assert.equal(spawned, false);
  assert.equal(ipcCreates.length, 0);
});

await runTest('suspendTerminalPty kills backend and resets spawn flags', () => {
  terminalCache.clear();
  ipcKills.length = 0;
  seedCache({ spawned: true, starting: false, pendingInput: 'ls' });

  suspendTerminalPty(SESSION, { panelHide: true });

  const cached = terminalCache.get(SESSION);
  assert.equal(cached.spawned, false);
  assert.equal(cached.starting, false);
  assert.equal(cached.generation, 2);
  assert.equal(cached.pendingInput, '');
  assert.equal(cached.lastResize, null);
  assert.equal(cached.suspendedByPanel, true);
  assert.equal(ipcKills.length, 1);
  assert.equal(ipcKills[0].termId, SESSION);
});

await runTest('suspendTerminalPty without panelHide does not set suspendedByPanel', () => {
  terminalCache.clear();
  seedCache({ spawned: true, starting: false, generation: 5 });

  suspendTerminalPty(SESSION);

  const cached = terminalCache.get(SESSION);
  assert.equal(cached.generation, 6);
  assert.equal(cached.suspendedByPanel, false);
});

console.log('Terminal PTY lifecycle tests passed.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});