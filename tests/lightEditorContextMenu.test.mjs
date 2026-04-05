import assert from 'node:assert/strict';

import { getLightEditorContextMenuActions } from '../.tmp-agent-tests/src/components/light-editor/useLightEditorContextMenu.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('exports the expected context menu actions in order', () => {
  const items = getLightEditorContextMenuActions(true);
  assert.deepEqual(items.map((item) => item.id), [
    'cut',
    'copy',
    'paste',
    'select-all',
    'find',
    'replace',
    'goto',
    'fold-current',
    'fold-imports',
    'fold-all',
    'unfold-all',
    'save',
  ]);
});

runTest('disables cut and copy when no text is selected', () => {
  const items = getLightEditorContextMenuActions(false);
  const byId = new Map(items.map((item) => [item.id, item]));
  assert.equal(byId.get('cut')?.disabled, true);
  assert.equal(byId.get('copy')?.disabled, true);
  assert.equal(byId.get('paste')?.disabled, undefined);
});

console.log('Light editor context menu tests passed.');
