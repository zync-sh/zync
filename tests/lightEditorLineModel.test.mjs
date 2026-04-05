import assert from 'node:assert/strict';

import {
  createLineModel,
  getLineSlice,
  getOffsetPosition,
  getLineStartOffset,
  getLineText,
} from '../.tmp-agent-tests/src/components/light-editor/core/lineModel.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('builds line starts and line count from content once', () => {
  const model = createLineModel('a\nbb\nccc');
  assert.equal(model.lineCount, 3);
  assert.deepEqual(model.lineStarts, [0, 2, 5]);
});

runTest('maps offsets to line and column efficiently', () => {
  const model = createLineModel('a\nbb\nccc');
  assert.deepEqual(getOffsetPosition(model, 0), { line: 1, column: 1 });
  assert.deepEqual(getOffsetPosition(model, 3), { line: 2, column: 2 });
  assert.deepEqual(getOffsetPosition(model, 6), { line: 3, column: 2 });
});

runTest('extracts line slices and line text without full split consumers', () => {
  const model = createLineModel('a\nbb\nccc');
  const slice = getLineSlice(model, 1, 3);
  assert.equal(slice.totalLines, 3);
  assert.equal(slice.visibleContent, 'bb\nccc');
  assert.equal(getLineStartOffset(model, 3), 5);
  assert.equal(getLineText(model, 2), 'bb');
});

console.log('Light editor line model tests passed.');
