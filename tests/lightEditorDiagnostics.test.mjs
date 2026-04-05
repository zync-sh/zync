import assert from 'node:assert/strict';

import { createLineModel } from '../.tmp-agent-tests/src/components/light-editor/core/lineModel.js';
import { getLightEditorDiagnostics } from '../.tmp-agent-tests/src/components/light-editor/diagnostics/useLightEditorDiagnostics.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('detects console.log and TODO warnings', () => {
  const diagnostics = getLightEditorDiagnostics(createLineModel('console.log("x");\n// TODO: cleanup'), 'javascript');
  assert.ok(diagnostics.some((diagnostic) => diagnostic.id === 'console-log-1'));
  assert.ok(diagnostics.some((diagnostic) => diagnostic.id === 'todo-2'));
});

runTest('detects standalone string literals for javascript-like files only', () => {
  const diagnostics = getLightEditorDiagnostics(createLineModel('"hello";\nconst a = 1'), 'javascript');
  assert.ok(diagnostics.some((diagnostic) => diagnostic.id === 'stray-string-1'));
  assert.equal(diagnostics.some((diagnostic) => diagnostic.id === 'statement-2'), false);
});

runTest('does not apply javascript-only diagnostics to rust files', () => {
  const diagnostics = getLightEditorDiagnostics(createLineModel('println!("x");\nlet x = 1\n'), 'rust');
  assert.equal(diagnostics.some((diagnostic) => diagnostic.id.startsWith('console-log')), false);
  assert.equal(diagnostics.some((diagnostic) => diagnostic.id.startsWith('stray-string')), false);
});

console.log('Light editor diagnostics tests passed.');
