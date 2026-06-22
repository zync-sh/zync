import assert from 'node:assert/strict';
import { suspendTerminalPty, spawnTerminalSession, getTerminalRecentLines } from '../.tmp-agent-tests/src/lib/terminal/index.js';
import { restoreTerminalDisplay } from '../.tmp-agent-tests/src/lib/terminal/terminalPanelRestore.js';
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

function createMockTerm(lines) {
  const bufferLines = lines.map((text) => ({
    translateToString: (trim) => (trim ? text.trimEnd() : text),
  }));

  return {
    rows: 24,
    cols: 80,
    clearCalls: 0,
    resetCalls: 0,
    refreshCalls: 0,
    fitCalls: 0,
    element: { isConnected: true, clientWidth: 800, clientHeight: 400 },
    _core: { _renderService: {} },
    buffer: {
      active: {
        length: bufferLines.length,
        getLine: (index) => bufferLines[index] ?? null,
      },
    },
    clear() {
      this.clearCalls += 1;
      bufferLines.length = 0;
    },
    reset() {
      this.resetCalls += 1;
    },
    refresh() {
      this.refreshCalls += 1;
    },
  };
}

function createMockFitAddon(term) {
  return {
    fit() {
      term.fitCalls += 1;
    },
  };
}

const SESSION = 'scrollback-preserve-test';

globalThis.window = {
  ipcRenderer: {
    invoke: () => Promise.resolve(),
    send: () => {},
  },
};

runTest('suspendTerminalPty does not clear xterm scrollback', () => {
  terminalCache.clear();
  const term = createMockTerm(['echo hello\r\n', 'PS> ']);
  terminalCache.set(SESSION, {
    term,
    fitAddon: createMockFitAddon(term),
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

  suspendTerminalPty(SESSION, { panelHide: true });

  assert.equal(term.clearCalls, 0);
  assert.equal(term.resetCalls, 0);
  assert.equal(terminalCache.get(SESSION).spawned, false);
  assert.ok(getTerminalRecentLines(SESSION, 5)?.includes('echo hello'));
});

runTest('spawn after suspend uses clearBuffer=false path in lazy respawn flow', () => {
  const term = terminalCache.get(SESSION).term;
  assert.equal(
    spawnTerminalSession({ termId: SESSION, connectionId: 'local', term, clearBuffer: false }),
    true,
  );
  assert.equal(term.clearCalls, 0);
  assert.equal(term.resetCalls, 0);
});

runTest('restoreTerminalDisplay refits and refreshes measurable hosts', () => {
  const term = terminalCache.get(SESSION).term;
  const fitAddon = terminalCache.get(SESSION).fitAddon;
  const beforeFit = term.fitCalls;
  const beforeRefresh = term.refreshCalls;

  restoreTerminalDisplay(term, fitAddon);

  assert.ok(term.fitCalls > beforeFit);
  assert.ok(term.refreshCalls > beforeRefresh);
});

console.log('Terminal scrollback preserve tests passed.');