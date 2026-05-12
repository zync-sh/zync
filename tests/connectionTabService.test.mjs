import assert from 'node:assert/strict';
import {
  activateExistingConnectionTab,
  createConnectionTabState,
  createLocalTerminalTabState,
  ensureGlobalSnippetsTab,
  ensureSingleTabByType,
  ensureVaultTabState,
  findConnectionTab,
} from '../.tmp-agent-tests/src/features/connections/application/tabService.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('createLocalTerminalTabState appends local tab and activates it', () => {
  const state = createLocalTerminalTabState([]);
  assert.equal(state.tabs.length, 1);
  assert.equal(state.tabs[0].connectionId, 'local');
  assert.equal(state.activeConnectionId, 'local');
  assert.equal(state.activeTabId, state.tabs[0].id);
});

runTest('createLocalTerminalTabState reuses existing local terminal tab', () => {
  const tabs = [{ id: 'lt1', type: 'connection', title: 'Local Terminal', connectionId: 'local', view: 'terminal' }];
  const state = createLocalTerminalTabState(tabs);
  assert.equal(state.tabs, tabs);
  assert.equal(state.activeTabId, 'lt1');
  assert.equal(state.activeConnectionId, 'local');
});

runTest('findConnectionTab returns connection tab only', () => {
  const tabs = [
    { id: '1', type: 'settings', title: 'Settings' },
    { id: '2', type: 'connection', title: 'Web', connectionId: 'c1', view: 'terminal' },
  ];
  const result = findConnectionTab(tabs, 'c1');
  assert.equal(result?.id, '2');
});

runTest('activateExistingConnectionTab updates view and active pointers', () => {
  const tabs = [{ id: '2', type: 'connection', title: 'Web', connectionId: 'c1', view: 'terminal' }];
  const state = activateExistingConnectionTab(tabs, tabs[0], 'files', 'c1');
  assert.equal(state.tabs[0].view, 'files');
  assert.equal(state.activeConnectionId, 'c1');
  assert.equal(state.activeTabId, '2');
});

runTest('createConnectionTabState appends and activates new connection tab', () => {
  const state = createConnectionTabState([], { id: 'c2', name: 'DB', host: '10.0.0.2' }, 'terminal');
  assert.equal(state.tabs.length, 1);
  assert.equal(state.tabs[0].connectionId, 'c2');
  assert.equal(state.tabs[0].title, 'DB');
});

runTest('ensureSingleTabByType returns existing tab activation', () => {
  const tabs = [{ id: 'pf1', type: 'port-forwarding', title: 'PF', view: 'port-forwarding' }];
  const state = ensureSingleTabByType(tabs, 'port-forwarding', () => ({
    id: 'new',
    type: 'port-forwarding',
    title: 'PF',
    view: 'port-forwarding',
  }));
  assert.equal(state.activeTabId, 'pf1');
  assert.equal(state.tabs, undefined);
  assert.equal(state.activeConnectionId, null);
});

runTest('ensureGlobalSnippetsTab creates global snippets tab if absent', () => {
  const state = ensureGlobalSnippetsTab([]);
  assert.equal(state.tabs?.length, 1);
  assert.equal(state.tabs?.[0].connectionId, 'global');
  assert.equal(state.tabs?.[0].view, 'snippets');
  assert.equal(state.activeConnectionId, 'global');
});

runTest('ensureVaultTabState creates vault tab with selected profile', () => {
  const state = ensureVaultTabState([], 'google');
  assert.equal(state.tabs.length, 1);
  assert.equal(state.tabs[0].type, 'vault');
  assert.equal(state.tabs[0].vaultProfileId, 'google');
  assert.equal(state.activeConnectionId, null);
});

runTest('ensureVaultTabState updates existing vault tab profile', () => {
  const tabs = [{ id: 'vault-1', type: 'vault', title: 'Vault', view: 'terminal', vaultProfileId: 'local' }];
  const state = ensureVaultTabState(tabs, 'google');
  assert.equal(state.tabs.length, 1);
  assert.equal(state.tabs[0].id, 'vault-1');
  assert.equal(state.tabs[0].vaultProfileId, 'google');
  assert.equal(state.activeTabId, 'vault-1');
});

runTest('ensureVaultTabState does not duplicate vault tab when other tabs exist', () => {
  const tabs = [
    { id: 'conn-1', type: 'connection', title: 'Prod', connectionId: 'c1', view: 'terminal' },
    { id: 'vault-1', type: 'vault', title: 'Vault', view: 'terminal', vaultProfileId: 'local' },
    { id: 'vault-legacy', type: 'vault', title: 'Legacy Vault', view: 'terminal', vaultProfileId: 'local' },
  ];
  const state = ensureVaultTabState(tabs, 'google');
  assert.equal(state.tabs.length, 2);
  assert.equal(state.tabs.filter((tab) => tab.type === 'vault').length, 1);
  assert.equal(state.tabs.find((tab) => tab.type === 'vault')?.vaultProfileId, 'google');
  assert.equal(state.activeTabId, 'vault-1');
});

console.log('Connection tab service tests passed.');
