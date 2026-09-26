import assert from 'node:assert/strict';
import { buildWorkspaceOpenItems } from '../.tmp-agent-tests/src/components/layout/workspaceOpen/buildWorkspaceOpenItems.js';
import { filterWorkspaceOpenItems, groupWorkspaceOpenItems, visibleWorkspaceOpenItems, workspaceOpenEscapeAction } from '../.tmp-agent-tests/src/components/layout/workspaceOpen/filterWorkspaceOpenItems.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  fail ${name}`);
    throw error;
  }
}

runTest('includes New Shell and registered plugin panes', () => {
  const items = buildWorkspaceOpenItems({
    shells: [{ id: 'bash', label: 'Bash' }],
    canOpenFeature: true,
    features: [{ id: 'files', isOpen: true, isActive: false }],
    plugins: [{ id: 'dev.example:monitor', title: 'Process Monitor', isOpen: false }],
  });
  assert.equal(items.some((item) => item.kind === 'new-shell'), true);
  assert.equal(items.some((item) => item.kind === 'plugin' && item.pluginId === 'dev.example:monitor'), true);
  assert.equal(items.some((item) => item.kind === 'feature' && item.featureId === 'files'), true);
});

runTest('labels an existing plugin pane as Open rather than New tab', () => {
  const items = buildWorkspaceOpenItems({
    shells: [],
    canOpenFeature: true,
    features: [],
    plugins: [{ id: 'dev.example:monitor', title: 'Process Monitor', isOpen: true }],
  });
  const plugin = items.find((item) => item.kind === 'plugin');
  assert.equal(plugin?.hint, 'Open');
});

runTest('omits feature rows when the workspace cannot open features', () => {
  const items = buildWorkspaceOpenItems({
    shells: [],
    canOpenFeature: false,
    features: [{ id: 'files', isOpen: false, isActive: false }],
  });
  assert.equal(items.every((item) => item.kind !== 'feature'), true);
});

runTest('keeps the active feature available for another tab', () => {
  const items = buildWorkspaceOpenItems({
    shells: [],
    canOpenFeature: true,
    features: [{ id: 'dashboard', isOpen: true, isActive: true }],
  });
  const dashboard = items.find((item) => item.featureId === 'dashboard');
  assert.ok(dashboard);
  assert.equal(dashboard.disabled, undefined);
  assert.equal(dashboard.hint, 'New tab');
});

runTest('root hides individual shells behind Other shells', () => {
  const items = buildWorkspaceOpenItems({
    shells: [{ id: 'pwsh', label: 'PowerShell' }, { id: 'bash', label: 'Bash' }],
    canOpenFeature: true,
    features: [],
  });
  const root = visibleWorkspaceOpenItems(items, '', 'root');
  assert.equal(root.some((item) => item.kind === 'other-shells'), true);
  assert.equal(root.some((item) => item.kind === 'shell'), false);
  assert.equal(root.some((item) => item.kind === 'feature'), true);
});

runTest('search on root still finds shells', () => {
  const items = buildWorkspaceOpenItems({
    shells: [{ id: 'pwsh', label: 'PowerShell' }],
    canOpenFeature: true,
    features: [],
  });
  const files = filterWorkspaceOpenItems(items, 'file');
  assert.equal(files.some((item) => item.id === 'feature:files'), true);
  assert.equal(files.every((item) => item.label.toLowerCase().includes('file') || item.keywords.some((k) => k.includes('file'))), true);
  const found = visibleWorkspaceOpenItems(items, 'power', 'root');
  assert.equal(found.some((item) => item.kind === 'shell'), true);
  assert.equal(found.some((item) => item.kind === 'other-shells'), false);
  assert.equal(visibleWorkspaceOpenItems(items, 'zzzz', 'root').length, 0);
});

runTest('shells view lists only shells', () => {
  const items = buildWorkspaceOpenItems({
    shells: [{ id: 'pwsh', label: 'PowerShell' }],
    canOpenFeature: true,
    features: [],
  });
  const listed = visibleWorkspaceOpenItems(items, '', 'shells');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].kind, 'shell');
});

runTest('Escape goes back from Other shells and closes on root', () => {
  assert.equal(workspaceOpenEscapeAction('shells'), 'back');
  assert.equal(workspaceOpenEscapeAction('root'), 'close');
});

runTest('groups drop empty sections', () => {
  const items = buildWorkspaceOpenItems({
    shells: [],
    canOpenFeature: false,
  });
  const groups = groupWorkspaceOpenItems(items);
  assert.deepEqual(groups.map((section) => section.group), ['create']);
});

runTest('does not add extra Files in split rows', () => {
  const items = buildWorkspaceOpenItems({
    shells: [],
    canOpenFeature: true,
    features: [{ id: 'files', isOpen: false, isActive: false }],
  });
  assert.equal(items.some((item) => item.kind === 'feature' && item.featureId === 'files'), true);
  assert.equal(items.every((item) => item.kind !== 'split-feature'), true);
  assert.equal(items.some((item) => item.label.endsWith(' in split')), false);
});

runTest('omits Files when the workspace cannot open features', () => {
  const items = buildWorkspaceOpenItems({
    shells: [],
    canOpenFeature: false,
    features: [{ id: 'files', isOpen: false, isActive: false }],
  });
  assert.equal(items.some((item) => item.featureId === 'files'), false);
  assert.equal(items.every((item) => item.kind !== 'feature' && item.kind !== 'split-feature'), true);
});

runTest('open menu stays at tab rows and never adds split-feature entries', () => {
  const items = buildWorkspaceOpenItems({
    shells: [],
    canOpenFeature: true,
    features: [
      { id: 'files', isOpen: true, isActive: false },
      { id: 'port-forwarding', isOpen: true, isActive: false },
      { id: 'dashboard', isOpen: true, isActive: false },
      { id: 'snippets', isOpen: true, isActive: false },
    ],
  });
  assert.equal(items.filter((item) => item.kind === 'feature').length, 4);
  assert.equal(items.filter((item) => item.kind === 'new-shell').length, 1);
  assert.equal(items.every((item) => item.kind !== 'split-feature'), true);
  assert.equal(items.length, 5);
});

console.log('Workspace open item tests passed.');
