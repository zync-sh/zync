import assert from 'node:assert/strict';
import { buildAppAddItems } from '../.tmp-agent-tests/src/components/layout/appAddMenu/buildAppAddItems.js';
import { visibleAppAddItems } from '../.tmp-agent-tests/src/components/layout/appAddMenu/filterAppAddItems.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  fail ${name}`);
    throw error;
  }
}

const hosts = [
  { id: 'h-b', name: 'beta', host: '10.0.0.2' },
  { id: 'h-a', name: 'alpha', host: '10.0.0.1', isFavorite: true, username: 'ubuntu' },
];

runTest('create rows stay pinned and go includes pf pu local hosts', () => {
  const items = buildAppAddItems({ hosts });
  const kinds = items.map((item) => item.kind);
  assert.deepEqual(kinds.slice(0, 3), ['new-host', 'new-folder', 'new-tunnel']);
  assert.equal(kinds.includes('port-forwarding'), true);
  assert.equal(kinds.includes('public-urls'), true);
  assert.equal(kinds.includes('security-audits'), true);
  assert.equal(kinds.includes('local'), true);
  assert.equal(items.some((item) => item.kind === 'host' && item.hostId === 'h-a'), true);
  assert.equal(items.some((item) => item.label === 'Files'), false);
  assert.equal(items.some((item) => item.label === 'Snippets'), false);
});

runTest('global audit navigation is discoverable and reflects its open state without selecting a host', () => {
  const items = buildAppAddItems({ hosts, open: { securityAuditsOpen: true } });
  const audit = items.find(item => item.kind === 'security-audits');
  assert.equal(audit.label, 'Security hardening audit');
  assert.equal(audit.hint, 'Open');
  assert.equal(audit.hostId, undefined);
  assert.equal(visibleAppAddItems(items, 'audit').includes(audit), true);
});

runTest('favorites sort before other hosts', () => {
  const items = buildAppAddItems({ hosts });
  const hostItems = items.filter((item) => item.kind === 'host');
  assert.deepEqual(hostItems.map((item) => item.hostId), ['h-a', 'h-b']);
});

runTest('search keeps create rows and filters go', () => {
  const items = buildAppAddItems({ hosts });
  const found = visibleAppAddItems(items, 'alpha');
  assert.equal(found.filter((item) => item.group === 'create').length, 3);
  assert.equal(found.some((item) => item.hostId === 'h-a'), true);
  assert.equal(found.some((item) => item.hostId === 'h-b'), false);
  assert.equal(found.some((item) => item.kind === 'port-forwarding'), false);
});

runTest('empty query shows every row', () => {
  const items = buildAppAddItems({ hosts });
  assert.equal(visibleAppAddItems(items, '  ').length, items.length);
});

runTest('host addresses stay off the row unless the list setting is on', () => {
  const hidden = buildAppAddItems({ hosts, showHostAddressesInLists: false });
  const shown = buildAppAddItems({ hosts, showHostAddressesInLists: true });
  const hiddenHost = hidden.find((item) => item.hostId === 'h-a');
  const shownHost = shown.find((item) => item.hostId === 'h-a');
  assert.equal(hiddenHost?.label, 'alpha');
  assert.equal(hiddenHost?.detail, undefined);
  assert.equal(shownHost?.detail?.includes('10.0.0.1'), true);
});

runTest('open hints mark existing tabs', () => {
  const items = buildAppAddItems({
    hosts,
    open: {
      portForwardingOpen: true,
      openHostIds: new Set(['h-a']),
    },
  });
  assert.equal(items.find((item) => item.kind === 'port-forwarding')?.hint, 'Open');
  assert.equal(items.find((item) => item.hostId === 'h-a')?.hint, 'Open');
  assert.equal(items.find((item) => item.hostId === 'h-b')?.hint, undefined);
});

console.log('App add item tests passed.');
