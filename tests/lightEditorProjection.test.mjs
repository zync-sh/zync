import assert from 'node:assert/strict';

import { buildProjection, projectionToText, realLineToVisibleRow, visibleRowToRealLine } from '../.tmp-agent-tests/src/components/light-editor/core/projection.js';
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

runTest('keeps all rows visible when no folds are collapsed', () => {
  const model = createLineModel('a\nb\nc\n');
  const projection = buildProjection(model, [], new Set());
  assert.equal(projection.visibleLineCount, 4);
  assert.equal(realLineToVisibleRow(projection, 2), 1);
  assert.equal(visibleRowToRealLine(projection, 2), 3);
  assert.equal(visibleRowToRealLine(projection, 3), 4);
});

runTest('replaces collapsed ranges with a single fold row and preserves mapping', () => {
  const model = createLineModel('fn main() {\n  a\n  b\n}\nnext\n');
  const folds = [{ id: 'fold-1', startLine: 1, endLine: 4, kind: 'function', description: 'fn' }];
  const projection = buildProjection(model, folds, new Set([1]));

  assert.equal(projection.visibleLineCount, 3);
  assert.equal(projection.rows[0].kind, 'fold');
  assert.equal(projection.rows[0].realLine, 1);
  assert.match(projection.rows[0].label, /fn main\(\).*{ \.\.\. }/);
  assert.equal(realLineToVisibleRow(projection, 3), 0);
  assert.equal(realLineToVisibleRow(projection, 5), 1);
  assert.equal(realLineToVisibleRow(projection, 6), 2);
});

runTest('builds readable labels for imports and impl blocks', () => {
  const model = createLineModel('use a::b;\nuse c::d;\n\nimpl AppState {\n  fn new() {}\n}\n');
  const projection = buildProjection(model, [
    { id: 'imports', startLine: 1, endLine: 2, kind: 'imports' },
    { id: 'impl', startLine: 4, endLine: 6, kind: 'region' },
  ], new Set([1, 4]));

  assert.equal(projection.rows[0].label, 'import ...');
  assert.equal(projection.rows[2].label, 'impl AppState { ... }');
  assert.match(projectionToText(projection, model), /import \.\.\./);
  assert.match(projectionToText(projection, model), /impl AppState { \.\.\. }/);
});

console.log('Light editor projection tests passed.');
