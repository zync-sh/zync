import assert from 'node:assert/strict';

import { buildProjection, projectionToText } from '../.tmp-agent-tests/src/components/light-editor/core/projection.js';
import { createLineModel } from '../.tmp-agent-tests/src/components/light-editor/core/lineModel.js';
import { getLightEditorMinimapState } from '../.tmp-agent-tests/src/components/light-editor/minimap/useLightEditorMinimap.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('computes viewport box and marker positions for the minimap', () => {
  const state = getLightEditorMinimapState({
    lineModel: createLineModel('import x\nconsole.log(x)\n\nconst a = 1;'),
    lineCount: 100,
    viewportHeight: 240,
    scrollTop: 120,
    diagnostics: [
      { id: 'd1', severity: 'warning', line: 10, column: 1, message: 'todo' },
      { id: 'd2', severity: 'error', line: 40, column: 1, message: 'error' },
    ],
    searchHighlights: [
      { key: 's1', top: 48, active: false },
      { key: 's2', top: 240, active: true },
    ],
    minimapHeight: 280,
  });

  assert.equal(state.contentHeight, 280);
  assert.ok(state.viewportTop > 0);
  assert.ok(state.viewportHeight >= 12);
  assert.ok(state.linePreviews.length > 0);
  assert.equal(state.diagnosticMarkers.length, 2);
  assert.equal(state.searchMarkers.length, 2);
  assert.equal(state.diagnosticMarkers[1].severity, 'error');
  assert.equal(state.searchMarkers[1].active, true);
});

runTest('supports folded projection content in the minimap model', () => {
  const realModel = createLineModel('use a::b;\nuse c::d;\n\nimpl AppState {\n  fn new() {}\n}\n');
  const projection = buildProjection(realModel, [
    { id: 'imports', startLine: 1, endLine: 2, kind: 'imports' },
    { id: 'impl', startLine: 4, endLine: 6, kind: 'region' },
  ], new Set([1, 4]));
  const displayModel = createLineModel(projectionToText(projection, realModel));

  const state = getLightEditorMinimapState({
    lineModel: displayModel,
    lineCount: displayModel.lineCount,
    viewportHeight: 96,
    scrollTop: 24,
    diagnostics: [],
    searchHighlights: [],
    minimapHeight: 280,
  });

  assert.equal(displayModel.lineCount, 4);
  assert.equal(state.linePreviews[0].text, 'import ...');
  assert.equal(state.linePreviews[2].text, 'impl AppState { ... }');
});

console.log('Light editor minimap tests passed.');
