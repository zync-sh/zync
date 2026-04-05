import assert from 'node:assert/strict';

import { formatGlobalEditorStatus } from '../.tmp-agent-tests/src/components/light-editor/status.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('formats the shared global editor status line', () => {
  const text = formatGlobalEditorStatus('app.js', 11, 3, 'javascript');
  assert.equal(text, 'app.js Ln 11, Col 3 UTF-8 Tab: 2 {} JAVASCRIPT');
});

runTest('uppercases the language id in the shared status line', () => {
  const text = formatGlobalEditorStatus('script.ps1', 1, 1, 'powershell');
  assert.ok(text.endsWith('POWERSHELL'));
});

console.log('Light editor status tests passed.');
