import assert from 'node:assert/strict';
import { buildSessionData, MAX_TABS_PER_SCOPE } from '../.tmp-agent-tests/src/store/sessionPersistence.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function makeConnectionTab(id = 'tab-1') {
  return { id, type: 'connection', title: 'Prod', connectionId: 'conn-1', view: 'terminal' };
}

function makeSettingsTab(id = 'settings-tab') {
  return { id, type: 'settings', title: 'Settings', view: 'terminal' };
}

function makeTerminal(index) {
  return {
    id: `term-${index}`,
    title: `Terminal ${index}`,
    lastKnownCwd: `/workspace/${index}`,
    initialPath: `/start/${index}`,
    isSynced: index % 2 === 0,
  };
}

runTest('buildSessionData preserves active tab and connection IDs', () => {
  const data = buildSessionData({
    activeTabId: 'tab-1',
    activeConnectionId: 'conn-1',
    tabs: [makeConnectionTab()],
    terminals: {},
    activeTerminalIds: {},
  });

  assert.equal(data.activeTabId, 'tab-1');
  assert.equal(data.activeConnectionId, 'conn-1');
});

runTest('buildSessionData excludes settings tabs and clears invalid activeTabId', () => {
  const data = buildSessionData({
    activeTabId: 'settings-tab',
    activeConnectionId: 'conn-1',
    tabs: [makeConnectionTab(), makeSettingsTab()],
    terminals: {},
    activeTerminalIds: {},
  });

  assert.deepEqual(
    data.tabs.map((tab) => tab.tabType),
    ['connection'],
  );
  assert.equal(data.activeTabId, undefined);
});

runTest('buildSessionData truncates terminals and maps snapshot fields', () => {
  const data = buildSessionData({
    activeTabId: 'tab-1',
    activeConnectionId: 'conn-1',
    tabs: [makeConnectionTab()],
    terminals: {
      conn1: Array.from({ length: MAX_TABS_PER_SCOPE + 4 }, (_, index) => makeTerminal(index)),
    },
    activeTerminalIds: {},
  });

  assert.equal(data.terminals.conn1.length, MAX_TABS_PER_SCOPE);
  assert.deepEqual(data.terminals.conn1[0], {
    id: 'term-0',
    title: 'Terminal 0',
    cwd: '/workspace/0',
    initialPath: '/start/0',
    isSynced: true,
  });
  assert.equal(data.terminals.conn1[MAX_TABS_PER_SCOPE - 1].id, `term-${MAX_TABS_PER_SCOPE - 1}`);
});

runTest('buildSessionData filters active terminal IDs to kept terminals only', () => {
  const data = buildSessionData({
    activeTabId: 'tab-1',
    activeConnectionId: 'conn-1',
    tabs: [makeConnectionTab()],
    terminals: {
      conn1: Array.from({ length: MAX_TABS_PER_SCOPE + 4 }, (_, index) => makeTerminal(index)),
      local: [makeTerminal(0)],
    },
    activeTerminalIds: {
      conn1: `term-${MAX_TABS_PER_SCOPE + 1}`,
      local: 'term-0',
      orphan: 'term-x',
      empty: null,
    },
  });

  assert.deepEqual(data.activeTerminalIds, {
    local: 'term-0',
  });
});

console.log('Session persistence tests passed.');
