import assert from 'node:assert/strict';

import { createLineModel } from '../.tmp-agent-tests/src/components/light-editor/core/lineModel.js';
import { findOccurrences, resolveOccurrenceTarget } from '../.tmp-agent-tests/src/components/light-editor/occurrences.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('resolves current word target when no explicit selection exists', () => {
  const target = resolveOccurrenceTarget('const app = appFactory(app)', 7, 7);
  assert.equal(target?.text, 'app');
  assert.equal(target?.isExplicitSelection, false);
});

runTest('prefers explicit non-empty single-line selection', () => {
  const target = resolveOccurrenceTarget('const app = appFactory(app)', 6, 9);
  assert.equal(target?.text, 'app');
  assert.equal(target?.isExplicitSelection, true);
});

runTest('finds whole-word occurrences and excludes the active selection', () => {
  const content = 'const app = appFactory(app)\napp.run()';
  const model = createLineModel(content);
  const occurrences = findOccurrences(model, content, 6, 9);

  assert.equal(occurrences.length, 2);
  assert.deepEqual(occurrences.map((occurrence) => occurrence.line), [1, 2]);
  assert.deepEqual(occurrences.map((occurrence) => occurrence.startColumn), [24, 1]);
});

runTest('updates target based on full explicit selection instead of stale word state', () => {
  const content = 'alpha beta alpha\nalpha';
  const model = createLineModel(content);
  const occurrences = findOccurrences(model, content, 0, 5);

  assert.equal(occurrences.length, 2);
  assert.deepEqual(occurrences.map((occurrence) => occurrence.startColumn), [12, 1]);
});

console.log('Light editor occurrence tests passed.');
