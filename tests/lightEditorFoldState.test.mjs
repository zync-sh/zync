import assert from 'node:assert/strict';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function getFoldStartLinesForLine(foldRanges, collapsedLines, line) {
  return foldRanges
    .filter((range) => collapsedLines.has(range.startLine) && line >= range.startLine && line <= range.endLine)
    .map((range) => range.startLine);
}

runTest('finds collapsed folds that contain a target line', () => {
  const foldRanges = [
    { id: 'imports', startLine: 1, endLine: 3, kind: 'imports' },
    { id: 'fn', startLine: 10, endLine: 20, kind: 'function' },
    { id: 'inner', startLine: 12, endLine: 15, kind: 'region' },
  ];
  const collapsedLines = new Set([1, 10, 12]);

  assert.deepEqual(getFoldStartLinesForLine(foldRanges, collapsedLines, 2), [1]);
  assert.deepEqual(getFoldStartLinesForLine(foldRanges, collapsedLines, 13), [10, 12]);
  assert.deepEqual(getFoldStartLinesForLine(foldRanges, collapsedLines, 30), []);
});

runTest('ignores matching fold ranges that are not collapsed', () => {
  const foldRanges = [
    { id: 'fn', startLine: 10, endLine: 20, kind: 'function' },
    { id: 'inner', startLine: 12, endLine: 15, kind: 'region' },
  ];
  const collapsedLines = new Set([12]);

  assert.deepEqual(getFoldStartLinesForLine(foldRanges, collapsedLines, 13), [12]);
});

console.log('Light editor fold state tests passed.');
