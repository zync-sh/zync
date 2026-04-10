import assert from 'node:assert/strict';
import {
  getCloseTabPreActions,
  markConnectionConnected,
  markConnectionErrorIfNeeded,
  markConnectionStatus,
  reduceTabCloseState,
} from '../.tmp-agent-tests/src/features/connections/application/connectionLifecycleService.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('markConnectionStatus updates only target id', () => {
  const connections = [
    { id: 'a', status: 'disconnected' },
    { id: 'b', status: 'connected' },
  ];
  const next = markConnectionStatus(connections, 'a', 'connecting');
  assert.equal(next[0].status, 'connecting');
  assert.equal(next[1].status, 'connected');
});

runTest('markConnectionConnected sets metadata and optional detected icon', () => {
  const connections = [{ id: 'a', status: 'connecting', icon: 'Server' }];
  const next = markConnectionConnected(connections, 'a', '/home/a', 'ubuntu');
  assert.equal(next[0].status, 'connected');
  assert.equal(next[0].homePath, '/home/a');
  assert.equal(next[0].icon, 'ubuntu');
});

runTest('markConnectionErrorIfNeeded is idempotent for existing error', () => {
  const connections = [{ id: 'a', status: 'error' }];
  const next = markConnectionErrorIfNeeded(connections, 'a');
  assert.equal(next, connections);
});

runTest('reduceTabCloseState recalculates active tab and connection', () => {
  const tabs = [
    { id: '1', connectionId: 'c1' },
    { id: '2', connectionId: 'c2' },
  ];
  const next = reduceTabCloseState(tabs, '2', '2');
  assert.equal(next.tabs.length, 1);
  assert.equal(next.activeTabId, '1');
  assert.equal(next.activeConnectionId, 'c1');
});

runTest('getCloseTabPreActions returns disconnect for connected remote tab', () => {
  const tab = { id: 't1', connectionId: 'c1' };
  const tabs = [{ id: 't1', connectionId: 'c1' }];
  const connections = [{ id: 'c1', status: 'connected' }];
  const actions = getCloseTabPreActions(tab, tabs, connections);
  assert.equal(actions.disconnectConnectionId, 'c1');
  assert.equal(actions.clearLocalTerminals, false);
});

runTest('getCloseTabPreActions does not disconnect when another tab uses same connection', () => {
  const tab = { id: 't1', connectionId: 'c1' };
  const tabs = [{ id: 't1', connectionId: 'c1' }, { id: 't2', connectionId: 'c1' }];
  const connections = [{ id: 'c1', status: 'connected' }];
  const actions = getCloseTabPreActions(tab, tabs, connections);
  assert.equal(actions.disconnectConnectionId, null);
  assert.equal(actions.clearLocalTerminals, false);
});

runTest('getCloseTabPreActions returns local terminal clear action for local tab', () => {
  const actions = getCloseTabPreActions({ id: 't1', connectionId: 'local', view: 'terminal' }, [{ id: 't1', connectionId: 'local', view: 'terminal' }], []);
  assert.equal(actions.disconnectConnectionId, null);
  assert.equal(actions.clearLocalTerminals, true);
});

runTest('getCloseTabPreActions does not clear local terminals for local snippets tab', () => {
  const actions = getCloseTabPreActions(
    { id: 't1', connectionId: 'local', view: 'snippets' },
    [{ id: 't1', connectionId: 'local', view: 'snippets' }],
    [],
  );
  assert.equal(actions.disconnectConnectionId, null);
  assert.equal(actions.clearLocalTerminals, false);
});

console.log('Connection lifecycle service tests passed.');
