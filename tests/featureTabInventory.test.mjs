import assert from 'node:assert/strict';
import { singleFeaturePane, singlePane, splitPane } from '../.tmp-agent-tests/src/lib/paneLayout/index.js';
import {
  featureTabsFromPaneGroups,
  initialFeatureTabsForView,
  mergeFeatureTabs,
} from '../.tmp-agent-tests/src/components/layout/featureTabInventory.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  fail ${name}`);
    throw error;
  }
}

function createTab(featureId) {
  return { id: `fresh-${featureId}`, featureId, instanceId: `fresh-${featureId}` };
}

runTest('returning to a host reuses the saved Files pane', () => {
  const groups = {
    'files-a': singleFeaturePane('files', 'pane-files', 'files-a'),
  };
  const first = initialFeatureTabsForView('files', groups, 'files-a', createTab);
  const second = initialFeatureTabsForView('files', groups, 'files-a', createTab);
  assert.deepEqual(first.tabs.map(tab => tab.id), ['files-a']);
  assert.equal(first.activeId, 'files-a');
  assert.deepEqual(second.tabs.map(tab => tab.id), ['files-a']);
  assert.equal(second.activeId, 'files-a');
});

runTest('a host with no Files pane still gets one tab', () => {
  const seeded = initialFeatureTabsForView('files', {}, null, createTab);
  assert.deepEqual(seeded.tabs.map(tab => tab.id), ['fresh-files']);
  assert.equal(seeded.activeId, 'fresh-files');
});

runTest('several saved Files panes come back without an extra tab', () => {
  const groups = {
    'files-a': singleFeaturePane('files', 'pane-a', 'files-a'),
    'files-b': singleFeaturePane('files', 'pane-b', 'files-b'),
  };
  const seeded = initialFeatureTabsForView('files', groups, 'files-a', createTab);
  assert.deepEqual(seeded.tabs.map(tab => tab.id), ['files-a', 'files-b']);
  assert.equal(seeded.activeId, 'files-a');
});

runTest('the active Files group restores its matching tab', () => {
  const groups = {
    'files-a': singleFeaturePane('files', 'pane-a', 'files-a'),
    'files-b': singleFeaturePane('files', 'pane-b', 'files-b'),
  };
  const seeded = initialFeatureTabsForView('files', groups, 'files-b', createTab);
  assert.equal(seeded.activeId, 'files-b');
});

runTest('a terminal view keeps saved Files panes and does not open a new one', () => {
  const groups = {
    'files-a': singleFeaturePane('files', 'pane-files', 'files-a'),
  };
  const seeded = initialFeatureTabsForView('terminal', groups, null, createTab);
  assert.deepEqual(seeded.tabs.map(tab => tab.id), ['files-a']);
  assert.equal(seeded.activeId, null);
});

runTest('merging pane tabs does not duplicate an id already on the bar', () => {
  const groups = {
    'files-a': singleFeaturePane('files', 'pane-files', 'files-a'),
  };
  const fromPanes = featureTabsFromPaneGroups(groups);
  const merged = mergeFeatureTabs(
    [{ id: 'files-a', featureId: 'files', instanceId: 'files-a' }],
    fromPanes,
  );
  assert.equal(merged.length, 1);
  assert.equal(mergeFeatureTabs(merged, fromPanes), merged);
});

runTest('a terminal-owned split keeps its Files tab over a later Files pane', () => {
  const split = splitPane(
    singlePane('term-1', 'pane-term'),
    'pane-term',
    'horizontal',
    { kind: 'feature', featureId: 'files', instanceId: 'files-a' },
  );
  assert.equal(split.ok, true);
  if (!split.ok) return;
  const groups = {
    'term-1': split.layout,
    'files-b': singleFeaturePane('files', 'pane-b', 'files-b'),
  };
  const seeded = initialFeatureTabsForView('files', groups, 'term-1', createTab);
  assert.deepEqual(seeded.tabs.map(tab => tab.id), ['files-a', 'files-b']);
  assert.equal(seeded.activeId, 'files-a');
});

runTest('the last Files tab is used when the active group has no Files pane', () => {
  const groups = {
    'term-1': singlePane('term-1', 'pane-term'),
    'files-a': singleFeaturePane('files', 'pane-a', 'files-a'),
    'files-b': singleFeaturePane('files', 'pane-b', 'files-b'),
  };
  const seeded = initialFeatureTabsForView('files', groups, 'term-1', createTab);
  assert.equal(seeded.activeId, 'files-b');
});

runTest('a Files pane inside a split is still one tab', () => {
  const split = splitPane(
    singleFeaturePane('files', 'pane-files', 'files-a'),
    'pane-files',
    'horizontal',
    { kind: 'term', termId: 'term-1' },
  );
  assert.equal(split.ok, true);
  if (!split.ok) return;
  const tabs = featureTabsFromPaneGroups({ 'files-a': split.layout });
  assert.deepEqual(tabs.map(tab => tab.id), ['files-a']);
});
