import assert from 'node:assert/strict';

import { createLineModel } from '../.tmp-agent-tests/src/components/light-editor/core/lineModel.js';
import { getFoldRanges } from '../.tmp-agent-tests/src/components/light-editor/folding/useLightEditorFolding.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('detects fold ranges from context-style brace rules', () => {
  const model = createLineModel('fn main() {\n  let x = 1;\n}\n');
  const foldingData = {
    language: 'rust',
    foldingRules: [
      {
        kind: 'region',
        startPattern: '\\bfn\\b.*\\{\\s*$',
        endPattern: '^\\s*\\}',
        description: 'Function definitions',
      },
    ],
  };

  const ranges = getFoldRanges(model, foldingData, 'rust');
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].startLine, 1);
  assert.equal(ranges[0].endLine, 3);
});

runTest('detects grouped import folds', () => {
  const model = createLineModel('use a::b;\nuse c::d;\n\nfn main() {}\n');
  const foldingData = {
    language: 'rust',
    foldingRules: [
      {
        kind: 'imports',
        startPattern: '^\\s*(import|require|use|include|from)\\b',
        groupConsecutive: true,
      },
    ],
  };

  const ranges = getFoldRanges(model, foldingData, 'rust');
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].startLine, 1);
  assert.equal(ranges[0].endLine, 2);
});

console.log('Light editor folding tests passed.');
