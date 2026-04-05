import assert from 'node:assert/strict';

import { getBracketHighlights } from '../.tmp-agent-tests/src/components/light-editor/core/brackets.js';
import { createLineModel } from '../.tmp-agent-tests/src/components/light-editor/core/lineModel.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('finds matching curly brackets near the cursor', () => {
  const content = 'fn main() {\n  let x = 1;\n}\n';
  const model = createLineModel(content);
  const cursorOffset = content.indexOf('{');
  const highlights = getBracketHighlights(model, cursorOffset);

  assert.equal(highlights.length, 2);
  assert.deepEqual(highlights[0], { key: `bracket-${cursorOffset}`, line: 1, column: 11 });
  assert.deepEqual(highlights[1], { key: `bracket-${content.indexOf('}')}`, line: 3, column: 1 });
});

runTest('returns no highlights when the cursor is not near a bracket', () => {
  const content = 'fn main() {\n  let x = 1;\n}\n';
  const model = createLineModel(content);
  const highlights = getBracketHighlights(model, content.indexOf('x'));
  assert.equal(highlights.length, 0);
});

console.log('Light editor bracket tests passed.');
