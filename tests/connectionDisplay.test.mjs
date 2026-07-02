import assert from 'node:assert/strict';
import {
  DEFAULT_SHOW_HOST_ADDRESSES_IN_LISTS,
  formatConnectionEndpoint,
  formatConnectionListEndpoint,
  getConnectionBrowseAriaLabel,
  getConnectionDisplayLabels,
  getConnectionPrimaryLabel,
  getConnectionSecondaryLabel,
  getConnectionSearchText,
  isLikelyIpAddress,
} from '../.tmp-agent-tests/src/features/connections/domain/connectionDisplay.js';
import {
  createConnectionTabState,
  refreshConnectionTabTitles,
} from '../.tmp-agent-tests/src/features/connections/application/tabService.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`FAIL ${name}: ${message}`);
    process.exitCode = 1;
  }
}

const namedConn = {
  id: 'c1',
  name: 'Web Server US',
  host: '10.0.4.22',
  username: 'deploy',
  port: 22,
  status: 'connected',
  tags: ['production', 'web'],
  folder: 'prod/eu',
};

const unnamedIpConn = {
  id: 'c2',
  name: '',
  host: '192.168.1.10',
  username: 'admin',
  port: 2222,
  status: 'disconnected',
};

runTest('default privacy mode is label-first', () => {
  assert.equal(DEFAULT_SHOW_HOST_ADDRESSES_IN_LISTS, false);
});

runTest('named connection keeps custom title when addresses hidden', () => {
  assert.equal(getConnectionPrimaryLabel(namedConn, false), 'Web Server US');
  assert.equal(getConnectionSecondaryLabel(namedConn, false), 'SSH, deploy');
  assert.doesNotMatch(getConnectionSecondaryLabel(namedConn, false), /10\.0\.4\.22/);
  assert.doesNotMatch(getConnectionSecondaryLabel(namedConn, false), /2222|port/);
});

runTest('unnamed IP connection hides endpoint in browse labels', () => {
  assert.equal(getConnectionPrimaryLabel(unnamedIpConn, false), 'admin');
  assert.equal(getConnectionSecondaryLabel(unnamedIpConn, false), 'SSH');
});

runTest('show addresses mode exposes endpoint without port in lists', () => {
  assert.equal(getConnectionPrimaryLabel(unnamedIpConn, true), '192.168.1.10');
  assert.equal(getConnectionSecondaryLabel(unnamedIpConn, true), 'admin@192.168.1.10');
  assert.equal(formatConnectionEndpoint(unnamedIpConn), 'admin@192.168.1.10:2222');
});

runTest('endpoint formatters omit @ when username or host is missing', () => {
  assert.equal(formatConnectionListEndpoint({ username: '', host: '10.0.0.1' }), '10.0.0.1');
  assert.equal(formatConnectionListEndpoint({ username: 'admin', host: '' }), 'admin');
  assert.equal(formatConnectionListEndpoint({ username: '', host: '' }), '');
  assert.equal(formatConnectionEndpoint({ username: '', host: '10.0.0.1', port: 22 }), '10.0.0.1');
  assert.equal(formatConnectionEndpoint({ username: 'admin', host: '', port: 2222 }), 'admin:2222');
});

runTest('show addresses mode falls back to username when host is empty', () => {
  const hostless = { ...unnamedIpConn, host: '', username: 'admin' };
  assert.equal(getConnectionPrimaryLabel(hostless, true), 'admin');
  assert.equal(getConnectionSecondaryLabel(hostless, true), 'admin');
});

runTest('search text always includes host for palette matching', () => {
  const search = getConnectionSearchText(unnamedIpConn);
  assert.match(search, /192\.168\.1\.10/);
  assert.match(search, /admin/);
});

runTest('hostname without custom name can remain primary when not an IP', () => {
  const hostAlias = { ...unnamedIpConn, host: 'prod-web.internal', username: 'ops' };
  assert.equal(getConnectionPrimaryLabel(hostAlias, false), 'prod-web.internal');
});

runTest('isLikelyIpAddress detects IPv4', () => {
  assert.equal(isLikelyIpAddress('10.0.0.1'), true);
  assert.equal(isLikelyIpAddress('prod.local'), false);
});

runTest('createConnectionTabState uses privacy-aware title', () => {
  const state = createConnectionTabState([], unnamedIpConn, 'terminal', { showHostAddressesInLists: false });
  assert.equal(state.tabs[0].title, 'admin');
  const exposed = createConnectionTabState([], unnamedIpConn, 'terminal', { showHostAddressesInLists: true });
  assert.equal(exposed.tabs[0].title, '192.168.1.10');
});

runTest('refreshConnectionTabTitles updates open tab labels when addresses hidden', () => {
  const tabs = [{ id: 't1', type: 'connection', title: 'old', connectionId: 'c2', view: 'terminal' }];
  const connections = [unnamedIpConn];
  const refreshed = refreshConnectionTabTitles(tabs, connections, false);
  assert.equal(refreshed[0].title, 'admin');
});

runTest('refreshConnectionTabTitles updates open tab labels when addresses shown', () => {
  const tabs = [{ id: 't1', type: 'connection', title: 'old', connectionId: 'c2', view: 'terminal' }];
  const connections = [unnamedIpConn];
  const refreshed = refreshConnectionTabTitles(tabs, connections, true);
  assert.equal(refreshed[0].title, '192.168.1.10');
});

runTest('getConnectionDisplayLabels bundles browse fields', () => {
  const labels = getConnectionDisplayLabels(namedConn, false);
  assert.equal(labels.primary, 'Web Server US');
  assert.ok(labels.searchText.includes('10.0.4.22'));
  assert.equal(labels.endpoint, 'deploy@10.0.4.22');
});

runTest('getConnectionBrowseAriaLabel reflects privacy mode', () => {
  assert.equal(
    getConnectionBrowseAriaLabel(namedConn, false),
    'Connection Web Server US, SSH, deploy',
  );
  assert.equal(
    getConnectionBrowseAriaLabel(unnamedIpConn, true),
    'Connection 192.168.1.10, admin@192.168.1.10',
  );
});