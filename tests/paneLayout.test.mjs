import assert from 'node:assert/strict';
import {
  activeTermId,
  canSplit,
  dockEdgeFromPoint,
  dockIntoLayout,
  dockPreviewRect,
  dropFeature,
  dropSplitIntro,
  dropTerm,
  featureToPromoteOnLastShellExit,
  findLayoutOwner,
  focusPane,
  neighborPaneId,
  oppositeDockEdge,
  paneBoxAtPoint,
  paneNavDirectionFromKey,
  isFeaturePaneFocused,
  layoutFeatureIds,
  isSplitFeatureId,
  isSplitLayout,
  layoutHasFeature,
  layoutHasPlugin,
  leafCount,
  openFeatureInLayout,
  singleFeaturePane,
  singlePluginPane,
  parsePaneLayout,
  parsePaneLayoutGroups,
  focusedTermIdForRestore,
  detachTermFromGroups,
  sameGroupTermDock,
  sameSplitGroup,
  sanitizePaneLayout,
  selectTerm,
  setSplitSizes,
  singlePane,
  snapshotPaneLayouts,
  snapshotPaneLayoutGroups,
  splitFromDockEdge,
  splitPane,
  incomingIndexForInsert,
  introStartSizes,
  markSplitIntro,
  takeSplitIntro,
  splitSashStyle,
  SPLIT_SASH_HIT_PX,
  wheelAxisDelta,
  wheelDeltaToRatio,
  unsplitPane,
  visibleTermIds,
  MAX_PANE_NESTING,
  MAX_VISIBLE_PANES,
  WORKSPACE_PANE_OWNER,
} from '../.tmp-agent-tests/src/lib/paneLayout/index.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  fail ${name}`);
    throw error;
  }
}

runTest('single pane is not a split', () => {
  const layout = singlePane('term-a', 'pane-a');
  assert.equal(leafCount(layout.root), 1);
  assert.equal(isSplitLayout(layout), false);
  assert.deepEqual(visibleTermIds(layout), ['term-a']);
  assert.equal(canSplit(layout), true);
});

runTest('split nests until the visible-pane cap', () => {
  let layout = singlePane('term-a', 'pane-a');
  for (let i = 1; i < MAX_VISIBLE_PANES; i += 1) {
    const target = layout.activePaneId;
    const result = splitPane(layout, target, i % 2 === 0 ? 'horizontal' : 'vertical', {
      kind: 'term',
      termId: `term-${String.fromCharCode(97 + i)}`,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    layout = result.layout;
  }
  assert.equal(leafCount(layout.root), MAX_VISIBLE_PANES);
  assert.equal(canSplit(layout), false);
  const again = splitPane(layout, layout.activePaneId, 'horizontal', { kind: 'term', termId: 'term-z' });
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.reason, 'cap');
});

runTest('unsplit of a nested pane keeps the rest of the tree and focuses the sibling', () => {
  const first = splitPane(singlePane('term-a', 'pane-a'), 'pane-a', 'vertical', { kind: 'term', termId: 'term-b' });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const bLeaf = first.layout.root.type === 'split' ? first.layout.root.children[1] : null;
  assert.ok(bLeaf && bLeaf.type === 'pane');
  const nested = splitPane(first.layout, bLeaf.id, 'horizontal', { kind: 'term', termId: 'term-c' });
  assert.equal(nested.ok, true);
  if (!nested.ok) return;
  assert.equal(leafCount(nested.layout.root), 3);
  const cLeaf = nested.layout.root.type === 'split' ? nested.layout.root.children[1] : null;
  const cPane = cLeaf && cLeaf.type === 'split' ? cLeaf.children[1] : null;
  assert.ok(cPane && cPane.type === 'pane');
  const focused = focusPane(nested.layout, cPane.id);
  const next = unsplitPane(focused, cPane.id);
  assert.equal(leafCount(next.root), 2);
  assert.equal(isSplitLayout(next), true);
  assert.deepEqual(visibleTermIds(next).sort(), ['term-a', 'term-b']);
  assert.equal(next.activePaneId, bLeaf.id);
});

runTest('unsplit keeps the other shell as a tab-ready leaf', () => {
  const base = singlePane('term-a', 'pane-a');
  const split = splitPane(base, 'pane-a', 'vertical', { kind: 'term', termId: 'term-b' });
  assert.equal(split.ok, true);
  if (!split.ok) return;
  const otherId = visibleTermIds(split.layout).find((id) => id === 'term-b');
  const bLeaf = split.layout.root.type === 'split' ? split.layout.root.children[1] : null;
  assert.ok(bLeaf && bLeaf.type === 'pane');
  const next = unsplitPane(split.layout, bLeaf.id);
  assert.equal(isSplitLayout(next), false);
  assert.deepEqual(visibleTermIds(next), ['term-a']);
  assert.equal(otherId, 'term-b');
});

runTest('selectTerm focuses an on-screen shell or replaces the active pane', () => {
  const base = singlePane('term-a', 'pane-a');
  const split = splitPane(base, 'pane-a', 'horizontal', { kind: 'term', termId: 'term-b' });
  assert.equal(split.ok, true);
  if (!split.ok) return;
  const focusedB = selectTerm(split.layout, 'term-b');
  const focusedLeaf = focusedB.root.type === 'split'
    ? focusedB.root.children.find((child) => child.type === 'pane' && child.content.termId === 'term-b')
    : null;
  assert.equal(focusedB.activePaneId, focusedLeaf?.id);
  const replaced = selectTerm(split.layout, 'term-c');
  assert.ok(visibleTermIds(replaced).includes('term-c'));
  assert.equal(visibleTermIds(replaced).includes('term-a') || visibleTermIds(replaced).includes('term-b'), true);
  assert.equal(leafCount(replaced.root), 2);
});

runTest('detachTermFromGroups rekeys when the owner term leaves a nested split', () => {
  const first = splitPane(singlePane('term-a', 'pane-a'), 'pane-a', 'horizontal', { kind: 'term', termId: 'term-b' });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const right = first.layout.root.type === 'split' ? first.layout.root.children[1] : null;
  assert.ok(right);
  const nested = splitPane(first.layout, right.id, 'vertical', { kind: 'term', termId: 'term-c' });
  assert.equal(nested.ok, true);
  if (!nested.ok) return;
  const { next, nextOwner, remainingIds } = detachTermFromGroups({ 'term-a': nested.layout }, 'term-a');
  assert.ok(nextOwner);
  assert.notEqual(nextOwner, 'term-a');
  assert.equal(remainingIds.includes('term-a'), false);
  assert.ok(next?.[nextOwner]);
  assert.equal(isSplitLayout(next[nextOwner]), true);
  assert.deepEqual(visibleTermIds(next[nextOwner]).sort(), ['term-b', 'term-c']);
});

runTest('detachTermFromGroups drops an extra pane and keeps the owner tab', () => {
  const first = splitPane(singlePane('term-a', 'pane-a'), 'pane-a', 'horizontal', { kind: 'term', termId: 'term-b' });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const left = first.layout.root.type === 'split' ? first.layout.root.children[0] : null;
  assert.ok(left);
  const nested = splitPane(first.layout, left.id, 'vertical', { kind: 'term', termId: 'term-c' });
  assert.equal(nested.ok, true);
  if (!nested.ok) return;
  const { next, nextOwner, remainingIds } = detachTermFromGroups({ 'term-a': nested.layout }, 'term-c');
  assert.equal(nextOwner, 'term-a');
  assert.ok(remainingIds.includes('term-a'));
  assert.equal(remainingIds.includes('term-c'), false);
  assert.equal(isSplitLayout(next?.['term-a']), true);
  assert.deepEqual(visibleTermIds(next['term-a']).sort(), ['term-a', 'term-b']);
});

runTest('dropTerm unsplits when a visible shell is closed', () => {
  const base = singlePane('term-a', 'pane-a');
  const split = splitPane(base, 'pane-a', 'vertical', { kind: 'term', termId: 'term-b' });
  assert.equal(split.ok, true);
  if (!split.ok) return;
  const afterB = dropTerm(split.layout, 'term-b');
  assert.ok(afterB);
  assert.equal(isSplitLayout(afterB), false);
  assert.deepEqual(visibleTermIds(afterB), ['term-a']);
  assert.equal(dropTerm(afterB, 'term-a'), null);
});

runTest('sanitize drops missing term ids', () => {
  const base = singlePane('term-a', 'pane-a');
  const split = splitPane(base, 'pane-a', 'vertical', { kind: 'term', termId: 'gone' });
  assert.equal(split.ok, true);
  if (!split.ok) return;
  const clean = sanitizePaneLayout(split.layout, new Set(['term-a']));
  assert.ok(clean);
  assert.deepEqual(visibleTermIds(clean), ['term-a']);
  assert.equal(parsePaneLayout({ nope: true }, new Set(['term-a'])), null);
});

runTest('sanitize falls back when activePaneId is a split node', () => {
  const base = singlePane('term-a', 'pane-a');
  const split = splitPane(base, 'pane-a', 'horizontal', { kind: 'term', termId: 'term-b' });
  assert.equal(split.ok, true);
  if (!split.ok) return;
  const dirty = { ...split.layout, activePaneId: split.layout.root.id };
  const clean = sanitizePaneLayout(dirty, new Set(['term-a', 'term-b']));
  assert.ok(clean);
  assert.equal(clean.root.type, 'split');
  assert.notEqual(clean.activePaneId, clean.root.id);
  assert.equal(clean.activePaneId, 'pane-a');
});

runTest('setSplitSizes clamps so neither pane collapses', () => {
  const base = singlePane('term-a', 'pane-a');
  const split = splitPane(base, 'pane-a', 'vertical', { kind: 'term', termId: 'term-b' });
  assert.equal(split.ok, true);
  if (!split.ok) return;
  const resized = setSplitSizes(split.layout, split.layout.root.id, [0.01, 0.99]);
  assert.equal(resized.root.type, 'split');
  if (resized.root.type !== 'split') return;
  assert.ok(resized.root.sizes[0] >= 0.2);
  assert.ok(resized.root.sizes[1] >= 0.2);
});

runTest('focusPane ignores unknown ids', () => {
  const layout = singlePane('term-a', 'pane-a');
  assert.equal(focusPane(layout, 'missing').activePaneId, 'pane-a');
});

runTest('neighborPaneId follows side-by-side and stacked splits', () => {
  assert.equal(paneNavDirectionFromKey('ArrowRight'), 'right');
  assert.equal(paneNavDirectionFromKey('a'), null);

  const side = splitPane(singlePane('term-a', 'pane-a'), 'pane-a', 'horizontal', { kind: 'term', termId: 'term-b' });
  assert.equal(side.ok, true);
  if (!side.ok) return;
  const left = side.layout.root.type === 'split' ? side.layout.root.children[0] : null;
  const right = side.layout.root.type === 'split' ? side.layout.root.children[1] : null;
  assert.ok(left && right && left.type === 'pane' && right.type === 'pane');
  const focusedRight = focusPane(side.layout, left.id);
  assert.equal(neighborPaneId(focusedRight, 'right'), right.id);
  assert.equal(neighborPaneId(focusedRight, 'left'), null);
  assert.equal(neighborPaneId(singlePane('term-a', 'pane-a'), 'right'), null);

  const stacked = splitPane(singlePane('term-a', 'pane-a'), 'pane-a', 'vertical', { kind: 'term', termId: 'term-b' });
  assert.equal(stacked.ok, true);
  if (!stacked.ok) return;
  const top = stacked.layout.root.type === 'split' ? stacked.layout.root.children[0] : null;
  const bottom = stacked.layout.root.type === 'split' ? stacked.layout.root.children[1] : null;
  assert.ok(top && bottom && top.type === 'pane' && bottom.type === 'pane');
  assert.equal(neighborPaneId(focusPane(stacked.layout, top.id), 'down'), bottom.id);
  assert.equal(neighborPaneId(focusPane(stacked.layout, bottom.id), 'up'), top.id);
});

runTest('neighborPaneId prefers the overlapping pane in a 2x2', () => {
  const first = splitPane(singlePane('term-a', 'pane-a'), 'pane-a', 'horizontal', { kind: 'term', termId: 'term-b' });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const left = first.layout.root.type === 'split' ? first.layout.root.children[0] : null;
  const right = first.layout.root.type === 'split' ? first.layout.root.children[1] : null;
  assert.ok(left && right);
  const downLeft = splitPane(first.layout, left.id, 'vertical', { kind: 'term', termId: 'term-c' });
  assert.equal(downLeft.ok, true);
  if (!downLeft.ok) return;
  const downBoth = splitPane(downLeft.layout, right.id, 'vertical', { kind: 'term', termId: 'term-d' });
  assert.equal(downBoth.ok, true);
  if (!downBoth.ok) return;
  const root = downBoth.layout.root;
  assert.equal(root.type, 'split');
  if (root.type !== 'split') return;
  const leftSplit = root.children[0];
  const rightSplit = root.children[1];
  assert.equal(leftSplit.type, 'split');
  assert.equal(rightSplit.type, 'split');
  if (leftSplit.type !== 'split' || rightSplit.type !== 'split') return;
  const a = leftSplit.children[0];
  const c = leftSplit.children[1];
  const b = rightSplit.children[0];
  const d = rightSplit.children[1];
  assert.equal(neighborPaneId(focusPane(downBoth.layout, a.id), 'right'), b.id);
  assert.equal(neighborPaneId(focusPane(downBoth.layout, a.id), 'down'), c.id);
  assert.equal(neighborPaneId(focusPane(downBoth.layout, b.id), 'left'), a.id);
  assert.equal(neighborPaneId(focusPane(downBoth.layout, d.id), 'up'), b.id);
});

runTest('parsePaneLayout rejects more leaves than MAX_VISIBLE_PANES', () => {
  const leaf = (id) => ({ type: 'pane', id: `p-${id}`, content: { kind: 'term', termId: id } });
  const split = (id, left, right) => ({
    type: 'split',
    id: `s-${id}`,
    direction: 'vertical',
    sizes: [0.5, 0.5],
    children: [left, right],
  });
  const raw = {
    version: 1,
    activePaneId: 'p-a',
    root: split('1', leaf('a'), split('2', leaf('b'), split('3', leaf('c'), split('4', leaf('d'), leaf('e'))))),
  };
  assert.equal(parsePaneLayout(raw, new Set(['a', 'b', 'c', 'd', 'e'])), null);
  const three = {
    version: 1,
    activePaneId: 'p-a',
    root: split('1', leaf('a'), split('2', leaf('b'), leaf('c'))),
  };
  assert.ok(parsePaneLayout(three, new Set(['a', 'b', 'c'])));
});

runTest('parsePaneLayout normalizes valid sizes and falls back when persisted sizes are invalid', () => {
  const leaf = (id) => ({ type: 'pane', id: `p-${id}`, content: { kind: 'term', termId: id } });
  const raw = (sizes) => ({
    version: 1,
    activePaneId: 'p-a',
    root: {
      type: 'split',
      id: 's-1',
      direction: 'vertical',
      sizes,
      children: [leaf('a'), leaf('b')],
    },
  });
  const known = new Set(['a', 'b']);

  const ok = parsePaneLayout(raw([0.6, 0.4]), known);
  assert.ok(ok);
  assert.equal(ok.root.type, 'split');
  if (ok.root.type !== 'split') return;
  assert.equal(ok.root.sizes[0], 0.6);
  assert.equal(ok.root.sizes[1], 0.4);

  for (const sizes of [undefined, [0, 1], [NaN, 0.5], [-1, 2], [1], 'nope']) {
    const parsed = parsePaneLayout(raw(sizes), known);
    assert.ok(parsed);
    assert.equal(parsed.root.type, 'split');
    if (parsed.root.type !== 'split') return;
    assert.deepEqual(parsed.root.sizes, [0.5, 0.5]);
  }

  const clamped = parsePaneLayout(raw([0.01, 0.99]), known);
  assert.ok(clamped);
  assert.equal(clamped.root.type, 'split');
  if (clamped.root.type !== 'split') return;
  assert.ok(clamped.root.sizes[0] >= 0.2);
  assert.ok(clamped.root.sizes[1] >= 0.2);
});

runTest('parsePaneLayout rejects trees deeper than MAX_PANE_NESTING', () => {
  const leaf = (id) => ({ type: 'pane', id: `p-${id}`, content: { kind: 'term', termId: `t-${id}` } });
  let node = leaf(0);
  for (let i = 1; i <= MAX_PANE_NESTING + 2; i += 1) {
    node = {
      type: 'split',
      id: `s-${i}`,
      direction: 'vertical',
      sizes: [0.5, 0.5],
      children: [node, leaf(i)],
    };
  }
  assert.equal(parsePaneLayout({ version: 1, activePaneId: 'p-0', root: node }, new Set(['t-0'])), null);
});

runTest('snapshot keeps only real splits', () => {
  const split = splitPane(singlePane('term-a', 'pane-a'), 'pane-a', 'vertical', { kind: 'term', termId: 'term-b' });
  assert.equal(split.ok, true);
  if (!split.ok) return;
  const snapped = snapshotPaneLayouts(
    { host: split.layout, local: singlePane('term-z', 'pane-z') },
    { host: [{ id: 'term-a' }, { id: 'term-b' }], local: [{ id: 'term-z' }] },
  );
  assert.ok(snapped.host);
  assert.equal(snapped.local, undefined);
});

runTest('focusedTermIdForRestore uses the layout focused leaf, not the owner tab id', () => {
  const first = splitPane(singlePane('term-a', 'pane-a'), 'pane-a', 'horizontal', { kind: 'term', termId: 'term-b' });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const right = first.layout.root.type === 'split' ? first.layout.root.children[1] : null;
  assert.ok(right && right.type === 'pane');
  const focused = focusPane(first.layout, right.id);
  const groups = { 'term-a': focused };
  assert.equal(focusedTermIdForRestore(groups, 'term-a', 'term-a'), 'term-b');
  assert.equal(focusedTermIdForRestore(groups, 'term-b', 'term-a'), 'term-b');
  assert.equal(focusedTermIdForRestore({}, 'term-a', 'term-z'), 'term-a');
  assert.equal(focusedTermIdForRestore(groups, null, 'term-a'), 'term-b');
  assert.equal(focusedTermIdForRestore(groups, 'stale', 'term-a'), 'term-b');
});

runTest('parsePaneLayoutGroups keeps disjoint owners and drops overlapping or ownerless trees', () => {
  const ab = splitPane(singlePane('term-a', 'pane-a'), 'pane-a', 'vertical', { kind: 'term', termId: 'term-b' });
  const cd = splitPane(singlePane('term-c', 'pane-c'), 'pane-c', 'horizontal', { kind: 'term', termId: 'term-d' });
  const cb = splitPane(singlePane('term-c', 'pane-c'), 'pane-c', 'horizontal', { kind: 'term', termId: 'term-b' });
  assert.equal(ab.ok && cd.ok && cb.ok, true);
  if (!ab.ok || !cd.ok || !cb.ok) return;

  const known = new Set(['term-a', 'term-b', 'term-c', 'term-d', 'term-z']);
  const ok = parsePaneLayoutGroups(
    { 'term-a': ab.layout, 'term-c': cd.layout },
    known,
  );
  assert.ok(ok['term-a']);
  assert.ok(ok['term-c']);

  const overlap = parsePaneLayoutGroups(
    { 'term-a': ab.layout, 'term-c': cb.layout },
    known,
  );
  assert.ok(overlap['term-a']);
  assert.equal(overlap['term-c'], undefined);

  const ownerless = parsePaneLayoutGroups(
    { 'term-z': ab.layout },
    known,
  );
  assert.equal(ownerless['term-z'], undefined);
});

runTest('feature-owned mixed groups survive snapshot and restore', () => {
  const mixed = splitPane(
    singleFeaturePane('files', 'pane-files', 'files-a'),
    'pane-files',
    'horizontal',
    { kind: 'term', termId: 'term-a' },
  );
  assert.equal(mixed.ok, true);
  if (!mixed.ok) return;

  const parsed = parsePaneLayoutGroups(
    { 'files-a': mixed.layout },
    new Set(['term-a']),
  );
  assert.ok(parsed['files-a']);

  const snapped = snapshotPaneLayoutGroups(
    { host: { 'files-a': mixed.layout } },
    { host: [{ id: 'term-a' }] },
  );
  assert.ok(snapped.host?.['files-a']);

  const invalidOwner = parsePaneLayoutGroups(
    { 'files-other': mixed.layout },
    new Set(['term-a']),
  );
  assert.equal(invalidOwner['files-other'], undefined);
});

runTest('detachTermFromGroups drops one pane and keeps the rest of the tab', () => {
  const first = splitPane(singlePane('term-a', 'pane-a'), 'pane-a', 'vertical', { kind: 'term', termId: 'term-b' });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const bLeaf = first.layout.root.type === 'split' ? first.layout.root.children[1] : null;
  assert.ok(bLeaf && bLeaf.type === 'pane');
  const nested = splitPane(first.layout, bLeaf.id, 'horizontal', { kind: 'term', termId: 'term-c' });
  assert.equal(nested.ok, true);
  if (!nested.ok) return;

  const extraGone = detachTermFromGroups({ 'term-a': nested.layout }, 'term-c');
  assert.ok(extraGone.next?.['term-a']);
  assert.deepEqual(extraGone.remainingIds.sort(), ['term-a', 'term-b']);
  assert.equal(extraGone.nextOwner, 'term-a');

  const ownerGone = detachTermFromGroups({ 'term-a': nested.layout }, 'term-a');
  assert.equal(ownerGone.next?.['term-a'], undefined);
  assert.ok(ownerGone.next?.[ownerGone.nextOwner ?? '']);
  assert.equal(ownerGone.remainingIds.includes('term-a'), false);
  assert.equal(ownerGone.remainingIds.length, 2);

  const lastExtra = detachTermFromGroups({ 'term-a': first.layout }, 'term-b');
  assert.equal(lastExtra.next, undefined);
  assert.deepEqual(lastExtra.remainingIds, ['term-a']);
  assert.equal(lastExtra.nextOwner, 'term-a');
});

runTest('detachTermFromGroups keeps Files panes when the last shell exits', () => {
  const withFiles = dockIntoLayout(
    singlePane('term-a', 'pane-a'),
    { kind: 'feature', featureId: 'files', instanceId: 'files-a' },
    'right',
  );
  assert.equal(withFiles.ok, true);
  if (!withFiles.ok) return;
  const twoFiles = dockIntoLayout(
    withFiles.layout,
    { kind: 'feature', featureId: 'files', instanceId: 'files-b' },
    'bottom',
  );
  assert.equal(twoFiles.ok, true);
  if (!twoFiles.ok) return;
  const gone = detachTermFromGroups({ 'term-a': twoFiles.layout }, 'term-a');
  const remaining = gone.next ? Object.values(gone.next)[0] : undefined;
  assert.ok(remaining);
  assert.equal(isSplitLayout(remaining), true);
  assert.equal(layoutHasFeature(remaining, 'files'), true);
  assert.deepEqual(visibleTermIds(remaining), []);
});

runTest('detachTermFromGroups rekeys a plugin-only remainder to workspace', () => {
  const mixed = dockIntoLayout(
    singlePane('term-a', 'pane-a'),
    { kind: 'plugin', pluginId: 'plug-1' },
    'right',
  );
  assert.equal(mixed.ok, true);
  if (!mixed.ok) return;
  const gone = detachTermFromGroups({ 'term-a': mixed.layout }, 'term-a');
  assert.equal(gone.nextOwner, WORKSPACE_PANE_OWNER);
  const remaining = gone.next?.[WORKSPACE_PANE_OWNER];
  assert.ok(remaining);
  assert.equal(layoutHasPlugin(remaining, 'plug-1'), true);
  assert.deepEqual(visibleTermIds(remaining), []);
});

runTest('snapshot and parse keep a single Files pane', () => {
  const solo = singleFeaturePane('files', 'pane-files', 'files-a');
  const snapped = snapshotPaneLayoutGroups(
    { host: { 'files-a': solo } },
    { host: [] },
  );
  assert.ok(snapped.host?.['files-a']);
  const parsed = parsePaneLayoutGroups(snapped.host, new Set());
  assert.ok(parsed['files-a']);
  assert.equal(isSplitLayout(parsed['files-a']), false);
  assert.equal(layoutHasFeature(parsed['files-a'], 'files'), true);
});

runTest('openFeatureInLayout splits Files beside a shell and focuses the new leaf', () => {
  const opened = openFeatureInLayout(singlePane('term-a', 'pane-a'), 'files');
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.equal(opened.created, true);
  assert.equal(leafCount(opened.layout.root), 2);
  assert.deepEqual(visibleTermIds(opened.layout), ['term-a']);
  assert.equal(layoutHasFeature(opened.layout, 'files'), true);
  assert.equal(isFeaturePaneFocused(opened.layout, 'files'), true);
  assert.equal(activeTermId(opened.layout), 'term-a');
});

runTest('openFeatureInLayout can add a second Files pane beside the first', () => {
  const first = openFeatureInLayout(singlePane('term-a', 'pane-a'), 'files');
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const termLeaf = first.layout.root.type === 'split' ? first.layout.root.children[0] : null;
  assert.ok(termLeaf);
  const focusedShell = focusPane(first.layout, termLeaf.id);
  const again = openFeatureInLayout(focusedShell, 'files');
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.created, true);
  assert.equal(leafCount(again.layout.root), 3);
});

runTest('openFeatureInLayout refuses to replace a shell when the pane cap is full', () => {
  let layout = singlePane('term-a', 'pane-a');
  for (let i = 1; i < MAX_VISIBLE_PANES; i += 1) {
    const result = splitPane(layout, layout.activePaneId, 'horizontal', {
      kind: 'term',
      termId: `term-${String.fromCharCode(97 + i)}`,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    layout = result.layout;
  }
  const refused = openFeatureInLayout(layout, 'files');
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.reason, 'cap');
  assert.equal(layoutHasFeature(layout, 'files'), false);
});

runTest('featureToPromoteOnLastShellExit keeps Files when the last shell exits', () => {
  const opened = openFeatureInLayout(singlePane('term-a', 'pane-a'), 'files');
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.deepEqual(layoutFeatureIds(opened.layout), ['files']);
  assert.equal(featureToPromoteOnLastShellExit(opened.layout, 'term-a'), 'files');
  const twoShells = splitPane(opened.layout, opened.layout.activePaneId, 'vertical', {
    kind: 'term',
    termId: 'term-b',
  });
  assert.equal(twoShells.ok, true);
  if (!twoShells.ok) return;
  assert.equal(featureToPromoteOnLastShellExit(twoShells.layout, 'term-b'), null);
});

runTest('dropFeature unsplits Files and keeps the shell; last-term drop keeps a Files-only layout', () => {
  const opened = openFeatureInLayout(singlePane('term-a', 'pane-a'), 'files');
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const withoutFiles = dropFeature(opened.layout, 'files');
  assert.ok(withoutFiles);
  assert.equal(isSplitLayout(withoutFiles), false);
  assert.deepEqual(visibleTermIds(withoutFiles), ['term-a']);
  assert.equal(layoutHasFeature(withoutFiles, 'files'), false);

  const lastShellGone = dropTerm(opened.layout, 'term-a');
  assert.ok(lastShellGone);
  assert.equal(layoutHasFeature(lastShellGone, 'files'), true);
  assert.deepEqual(visibleTermIds(lastShellGone), []);
});

runTest('selectTerm never replaces a Files leaf', () => {
  const opened = openFeatureInLayout(singlePane('term-a', 'pane-a'), 'files');
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const replaced = selectTerm(opened.layout, 'term-z');
  assert.equal(layoutHasFeature(replaced, 'files'), true);
  assert.deepEqual(visibleTermIds(replaced).sort(), ['term-z']);
  assert.equal(leafCount(replaced.root), 2);
});

runTest('sanitize and parse keep Files beside known shells and keep Files-only trees', () => {
  const opened = openFeatureInLayout(singlePane('term-a', 'pane-a'), 'files');
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const kept = sanitizePaneLayout(opened.layout, new Set(['term-a']));
  assert.ok(kept);
  assert.equal(layoutHasFeature(kept, 'files'), true);

  const featureOnly = dropTerm(opened.layout, 'term-a');
  assert.ok(featureOnly);
  assert.equal(layoutHasFeature(featureOnly, 'files'), true);
  const pruned = sanitizePaneLayout(opened.layout, new Set());
  assert.ok(pruned);
  assert.equal(layoutHasFeature(pruned, 'files'), true);

  const parsed = parsePaneLayout(opened.layout, new Set(['term-a']));
  assert.ok(parsed);
  assert.equal(layoutHasFeature(parsed, 'files'), true);
  assert.deepEqual(visibleTermIds(parsed), ['term-a']);
});

runTest('parse collapses an unknown feature leaf instead of dropping the whole split', () => {
  const raw = {
    version: 1,
    activePaneId: 'pane-a',
    root: {
      type: 'split',
      id: 's-1',
      direction: 'horizontal',
      sizes: [0.5, 0.5],
      children: [
        { type: 'pane', id: 'pane-a', content: { kind: 'term', termId: 'term-a' } },
        { type: 'pane', id: 'pane-files', content: { kind: 'feature', featureId: 'not-a-feature' } },
      ],
    },
  };
  const parsed = parsePaneLayout(raw, new Set(['term-a']));
  assert.ok(parsed);
  assert.equal(isSplitLayout(parsed), false);
  assert.deepEqual(visibleTermIds(parsed), ['term-a']);
});

runTest('isSplitFeatureId accepts all four host features', () => {
  assert.equal(isSplitFeatureId('files'), true);
  assert.equal(isSplitFeatureId('port-forwarding'), true);
  assert.equal(isSplitFeatureId('dashboard'), true);
  assert.equal(isSplitFeatureId('snippets'), true);
  assert.equal(isSplitFeatureId('plugin:x'), false);
});

runTest('dockEdgeFromPoint picks the nearest edge inside the surface and ignores outside', () => {
  assert.equal(dockEdgeFromPoint(10, 50, 100, 100), 'left');
  assert.equal(dockEdgeFromPoint(90, 50, 100, 100), 'right');
  assert.equal(dockEdgeFromPoint(50, 10, 100, 100), 'top');
  assert.equal(dockEdgeFromPoint(50, 90, 100, 100), 'bottom');
  assert.equal(dockEdgeFromPoint(20, 50, 100, 100), 'left');
  assert.equal(dockEdgeFromPoint(-1, 50, 100, 100), null);
  assert.equal(dockEdgeFromPoint(50, 150, 100, 100), null);
  assert.equal(dockEdgeFromPoint(50, 50, 100, 100), null);
  assert.equal(dockEdgeFromPoint(40, 50, 100, 100), null);
});

runTest('oppositeDockEdge flips left/right and top/bottom', () => {
  assert.equal(oppositeDockEdge('right'), 'left');
  assert.equal(oppositeDockEdge('left'), 'right');
  assert.equal(oppositeDockEdge('bottom'), 'top');
  assert.equal(oppositeDockEdge('top'), 'bottom');
});

runTest('files overlay split places Files beside a new shell without using another group', () => {
  const term = singlePane('term-new', 'pane-new');
  const placed = dockIntoLayout(term, { kind: 'feature', featureId: 'files' }, oppositeDockEdge('right'));
  assert.equal(placed.ok, true);
  if (!placed.ok) return;
  assert.equal(placed.layout.root.type, 'split');
  if (placed.layout.root.type !== 'split') return;
  const left = placed.layout.root.children[0];
  const right = placed.layout.root.children[1];
  assert.equal(left.type, 'pane');
  assert.equal(right.type, 'pane');
  if (left.type !== 'pane' || right.type !== 'pane') return;
  assert.equal(left.content.kind, 'feature');
  assert.equal(right.content.kind, 'term');
  assert.equal(right.content.kind === 'term' && right.content.termId, 'term-new');
});

runTest('splitFromDockEdge maps left/top to insert-before', () => {
  assert.deepEqual(splitFromDockEdge('left'), { direction: 'horizontal', insert: 'before' });
  assert.deepEqual(splitFromDockEdge('right'), { direction: 'horizontal', insert: 'after' });
  assert.deepEqual(splitFromDockEdge('top'), { direction: 'vertical', insert: 'before' });
  assert.deepEqual(splitFromDockEdge('bottom'), { direction: 'vertical', insert: 'after' });
});

runTest('dockIntoLayout on the left puts the new leaf first', () => {
  const docked = dockIntoLayout(singlePane('term-a', 'pane-a'), { kind: 'feature', featureId: 'dashboard' }, 'left');
  assert.equal(docked.ok, true);
  if (!docked.ok) return;
  assert.equal(docked.layout.root.type, 'split');
  if (docked.layout.root.type !== 'split') return;
  assert.equal(docked.layout.root.direction, 'horizontal');
  const first = docked.layout.root.children[0];
  assert.equal(first.type, 'pane');
  if (first.type !== 'pane' || first.content.kind !== 'feature') return;
  assert.equal(first.content.featureId, 'dashboard');
  assert.equal(layoutHasFeature(docked.layout, 'dashboard'), true);
});

runTest('dockIntoLayout of an already-mounted Files instance focuses instead of splitting', () => {
  const solo = singleFeaturePane('files', 'pane-files-a', 'files-a');
  const again = dockIntoLayout(
    solo,
    { kind: 'feature', featureId: 'files', instanceId: 'files-a' },
    'right',
    undefined,
    'pane-files-a',
  );
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.created, false);
  assert.equal(again.paneId, 'pane-files-a');
  assert.equal(isSplitLayout(again.layout), false);
});

runTest('dockIntoLayout can duplicate a feature pane like a second shell', () => {
  const first = dockIntoLayout(singlePane('term-a', 'pane-a'), { kind: 'feature', featureId: 'files' }, 'right');
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const again = dockIntoLayout(first.layout, { kind: 'feature', featureId: 'files' }, 'left');
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.created, true);
  assert.equal(leafCount(again.layout.root), 3);
});

runTest('pane content can be repeatedly docked at the hovered pane up to the shared cap', () => {
  const solo = singleFeaturePane('files', 'pane-files-a', 'files-a');
  const second = dockIntoLayout(
    solo,
    { kind: 'feature', featureId: 'files', instanceId: 'files-b' },
    'right',
    undefined,
    'pane-files-a',
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;

  const third = dockIntoLayout(
    second.layout,
    { kind: 'feature', featureId: 'dashboard' },
    'bottom',
    undefined,
    second.paneId,
  );
  assert.equal(third.ok, true);
  if (!third.ok) return;

  const fourth = dockIntoLayout(
    third.layout,
    { kind: 'plugin', pluginId: 'clock' },
    'left',
    undefined,
    third.paneId,
  );
  assert.equal(fourth.ok, true);
  if (!fourth.ok) return;
  assert.equal(leafCount(fourth.layout.root), MAX_VISIBLE_PANES);

  const refused = dockIntoLayout(
    fourth.layout,
    { kind: 'feature', featureId: 'snippets' },
    'top',
    undefined,
    fourth.paneId,
  );
  assert.deepEqual(refused, { ok: false, reason: 'cap' });
});

runTest('dockIntoLayout can place a plugin pane beside a shell', () => {
  const docked = dockIntoLayout(singlePane('term-a', 'pane-a'), { kind: 'plugin', pluginId: 'clock' }, 'right');
  assert.equal(docked.ok, true);
  if (!docked.ok) return;
  assert.equal(layoutHasPlugin(docked.layout, 'clock'), true);
  const again = dockIntoLayout(docked.layout, { kind: 'plugin', pluginId: 'clock' }, 'left');
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.created, true);
  assert.equal(leafCount(again.layout.root), 3);
});

runTest('plugin self-split creates independent instance identities and restores them', () => {
  const solo = singlePluginPane('clock', 'pane-clock', 'clock-instance-a');
  const split = dockIntoLayout(
    solo,
    { kind: 'plugin', pluginId: 'clock', instanceId: 'clock-instance-b' },
    'right',
    undefined,
    'pane-clock',
  );
  assert.equal(split.ok, true);
  if (!split.ok) return;

  const contents = split.layout.root.children.map(child => child.content);
  assert.deepEqual(contents.map(content => content.pluginId), ['clock', 'clock']);
  assert.deepEqual(contents.map(content => content.instanceId), ['clock-instance-a', 'clock-instance-b']);

  const restored = parsePaneLayout(JSON.parse(JSON.stringify(split.layout)), new Set());
  assert.ok(restored);
  assert.deepEqual(
    restored.root.children.map(child => child.content.instanceId),
    ['clock-instance-a', 'clock-instance-b'],
  );
});

runTest('singleFeaturePane can split into two Files panes without a shell', () => {
  const solo = singleFeaturePane('files', 'pane-files', 'files-a');
  const split = dockIntoLayout(solo, { kind: 'feature', featureId: 'files', instanceId: 'files-b' }, 'right');
  assert.equal(split.ok, true);
  if (!split.ok) return;
  assert.equal(isSplitLayout(split.layout), true);
  assert.equal(leafCount(split.layout.root), 2);
  assert.deepEqual(visibleTermIds(split.layout), []);
});

runTest('workspace feature layouts do not claim shells they do not contain', () => {
  const solo = singleFeaturePane('files', 'pane-files-a', 'files-a');
  const split = dockIntoLayout(solo, { kind: 'feature', featureId: 'files', instanceId: 'files-b' }, 'right');
  assert.equal(split.ok, true);
  if (!split.ok) return;
  const groups = { [WORKSPACE_PANE_OWNER]: split.layout };
  assert.equal(findLayoutOwner(groups, 'term-a'), null);
  const detached = detachTermFromGroups(groups, 'term-a');
  assert.equal(detached.next, groups);
  assert.equal(detached.next?.[WORKSPACE_PANE_OWNER], split.layout);
});

runTest('sameSplitGroup treats a single tab as its own group', () => {
  assert.equal(sameSplitGroup({}, 'term-a', 'term-a'), true);
  assert.equal(sameSplitGroup({}, 'term-a', 'term-b'), false);
  const split = splitPane(singlePane('term-a', 'pane-a'), 'pane-a', 'horizontal', { kind: 'term', termId: 'term-b' });
  assert.equal(split.ok, true);
  if (!split.ok) return;
  const groups = { 'term-a': split.layout };
  assert.equal(sameSplitGroup(groups, 'term-a', 'term-b'), true);
  assert.equal(sameSplitGroup(groups, 'term-a', 'term-z'), false);
});

runTest('same-group term dock only matches shells already visible in that layout', () => {
  assert.equal(sameGroupTermDock(undefined, 'term-a', 'term-a'), null);
  assert.equal(sameGroupTermDock({}, 'term-a', 'term-a'), null);
  assert.equal(sameGroupTermDock({}, 'term-a', 'term-b'), null);
  const split = splitPane(singlePane('term-a', 'pane-a'), 'pane-a', 'horizontal', { kind: 'term', termId: 'term-b' });
  assert.equal(split.ok, true);
  if (!split.ok) return;
  takeSplitIntro(split.layout.root.type === 'split' ? split.layout.root.id : '');
  const groups = { 'term-a': split.layout };
  const snapshot = JSON.stringify(groups);
  assert.equal(sameGroupTermDock(groups, 'term-a', 'term-a'), 'self');
  assert.equal(sameGroupTermDock(groups, 'term-a', 'term-b'), 'self');
  assert.equal(sameGroupTermDock(groups, 'term-a', 'term-z'), null);
  assert.equal(JSON.stringify(groups), snapshot);
});

runTest('paneBoxAtPoint hits the smallest pane containing the point', () => {
  const left = { id: 'a', x: 0, y: 0, w: 50, h: 100 };
  const right = { id: 'b', x: 50, y: 0, w: 50, h: 100 };
  assert.equal(paneBoxAtPoint(10, 50, [left, right])?.id, 'a');
  assert.equal(paneBoxAtPoint(70, 20, [left, right])?.id, 'b');
  assert.equal(paneBoxAtPoint(-1, 50, [left, right]), null);
});

runTest('dockPreviewRect stays inside the hovered pane, not the full surface', () => {
  const right = { id: 'b', x: 50, y: 0, w: 50, h: 100 };
  const preview = dockPreviewRect(right, 'bottom', 0);
  assert.equal(preview.x, 50);
  assert.equal(preview.w, 50);
  assert.ok(preview.y >= 50);
  assert.ok(preview.y + preview.h <= 100);
});

runTest('dockIntoLayout splits the hovered pane, not the whole workspace', () => {
  const first = splitPane(singlePane('term-a', 'pane-a'), 'pane-a', 'horizontal', { kind: 'term', termId: 'term-b' });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.layout.root.type, 'split');
  if (first.layout.root.type !== 'split') return;
  const right = first.layout.root.children[1];
  const docked = dockIntoLayout(
    first.layout,
    { kind: 'feature', featureId: 'files' },
    'bottom',
    undefined,
    right.id,
  );
  assert.equal(docked.ok, true);
  if (!docked.ok) return;
  assert.equal(docked.layout.root.type, 'split');
  if (docked.layout.root.type !== 'split') return;
  assert.equal(docked.layout.root.direction, 'horizontal');
  const nextRight = docked.layout.root.children[1];
  assert.equal(nextRight.type, 'split');
  if (nextRight.type !== 'split') return;
  assert.equal(nextRight.direction, 'vertical');
  const filesLeaf = nextRight.children[1];
  assert.equal(filesLeaf.type, 'pane');
  if (filesLeaf.type !== 'pane') return;
  assert.equal(filesLeaf.content.kind, 'feature');
});

runTest('parse keeps Dashboard beside a known shell', () => {
  const docked = dockIntoLayout(singlePane('term-a', 'pane-a'), { kind: 'feature', featureId: 'dashboard' }, 'right');
  assert.equal(docked.ok, true);
  if (!docked.ok) return;
  const parsed = parsePaneLayout(docked.layout, new Set(['term-a']));
  assert.ok(parsed);
  assert.equal(layoutHasFeature(parsed, 'dashboard'), true);
});

runTest('wheelDeltaToRatio maps notches and caps a single flick', () => {
  assert.equal(wheelDeltaToRatio(0), 0);
  assert.equal(wheelDeltaToRatio(Number.NaN), 0);
  assert.ok(wheelDeltaToRatio(120) > 0);
  assert.ok(wheelDeltaToRatio(120) <= 0.08);
  assert.equal(wheelDeltaToRatio(-120), -wheelDeltaToRatio(120));
  assert.ok(Math.abs(wheelDeltaToRatio(1, 1)) > Math.abs(wheelDeltaToRatio(1, 0)));
  assert.equal(wheelDeltaToRatio(10_000), 0.08);
});

runTest('wheelAxisDelta uses Y when stacked and the dominant axis side by side', () => {
  assert.equal(wheelAxisDelta(40, 10, false), 40);
  assert.equal(wheelAxisDelta(10, 40, false), 40);
  assert.equal(wheelAxisDelta(40, 10, true), 10);
});

runTest('introStartSizes parks the incoming leaf at zero', () => {
  assert.deepEqual(introStartSizes(0), [0, 1]);
  assert.deepEqual(introStartSizes(1), [1, 0]);
  assert.equal(incomingIndexForInsert('before'), 0);
  assert.equal(incomingIndexForInsert('after'), 1);
});

runTest('splitSashStyle overlays a hit target on the seam', () => {
  const side = splitSashStyle(false, 0.5);
  assert.equal(side.left, '50%');
  assert.equal(side.width, SPLIT_SASH_HIT_PX);
  assert.equal(side.marginLeft, -(SPLIT_SASH_HIT_PX / 2));
  const stacked = splitSashStyle(true, 0);
  assert.equal(stacked.top, '0%');
  assert.equal(stacked.height, SPLIT_SASH_HIT_PX);
});

runTest('splitPane marks a one-shot intro on the new split', () => {
  const result = splitPane(singlePane('term-a', 'pane-a'), 'pane-a', 'horizontal', { kind: 'term', termId: 'term-b' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.layout.root.type, 'split');
  if (result.layout.root.type !== 'split') return;
  assert.deepEqual(takeSplitIntro(result.layout.root.id), { incomingIndex: 1 });
  assert.equal(takeSplitIntro(result.layout.root.id), null);
});

runTest('splitPane insert-before marks incoming index 0', () => {
  const result = splitPane(
    singlePane('term-a', 'pane-a'),
    'pane-a',
    'vertical',
    { kind: 'term', termId: 'term-b' },
    undefined,
    'before',
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.layout.root.type, 'split');
  if (result.layout.root.type !== 'split') return;
  assert.deepEqual(takeSplitIntro(result.layout.root.id), { incomingIndex: 0 });
});

runTest('markSplitIntro overwrites the incoming side for overlay continuity', () => {
  markSplitIntro('split-overlay', 0);
  markSplitIntro('split-overlay', 1);
  assert.deepEqual(takeSplitIntro('split-overlay'), { incomingIndex: 1 });
  assert.equal(takeSplitIntro('split-overlay'), null);
});

runTest('dropSplitIntro discards a pending intro so it cannot replay', () => {
  markSplitIntro('split-gone', 1);
  dropSplitIntro('split-gone');
  assert.equal(takeSplitIntro('split-gone'), null);
});

runTest('dockIntoLayout of a term already in the group only focuses', () => {
  const first = splitPane(singlePane('term-a', 'pane-a'), 'pane-a', 'horizontal', { kind: 'term', termId: 'term-b' });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  takeSplitIntro(first.layout.root.type === 'split' ? first.layout.root.id : '');
  const again = dockIntoLayout(first.layout, { kind: 'term', termId: 'term-a' }, 'left');
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.created, false);
  assert.equal(leafCount(again.layout.root), 2);
});

runTest('dockIntoLayout that only focuses does not mark a second intro', () => {
  const first = splitPane(singlePane('term-a', 'pane-a'), 'pane-a', 'horizontal', { kind: 'term', termId: 'term-b' });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.layout.root.type, 'split');
  if (first.layout.root.type !== 'split') return;
  const splitId = first.layout.root.id;
  takeSplitIntro(splitId);
  const again = dockIntoLayout(first.layout, { kind: 'term', termId: 'term-b' }, 'left');
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.created, false);
  assert.equal(takeSplitIntro(splitId), null);
});
