import assert from 'node:assert/strict';

import { getActiveLineOverlay, getCompletionPanelTopOffset } from '../.tmp-agent-tests/src/components/light-editor/layout.js';
import { getUtilityStateForAction, resolveUtilityShortcut } from '../.tmp-agent-tests/src/components/light-editor/useLightEditorUtilities.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('routes ctrl/cmd shortcuts to the expected utility action', () => {
  assert.equal(resolveUtilityShortcut('f', true), 'find');
  assert.equal(resolveUtilityShortcut('H', true), 'replace');
  assert.equal(resolveUtilityShortcut('g', true), 'goto');
  assert.equal(resolveUtilityShortcut('g', false), null);
  assert.equal(resolveUtilityShortcut('x', true), null);
});

runTest('moves completion panel below the utility widget when needed', () => {
  assert.equal(getCompletionPanelTopOffset(null, false), 16);
  assert.equal(getCompletionPanelTopOffset('goto', false), 68);
  assert.equal(getCompletionPanelTopOffset('find', false), 68);
  assert.equal(getCompletionPanelTopOffset('find', true), 116);
});

runTest('computes active-line overlay only when the cursor is inside the viewport', () => {
  const active = getActiveLineOverlay(12, 5, 20, 48);
  assert.equal(active.visible, true);
  assert.equal(active.top, 228);
  assert.equal(active.height, 24);

  const hidden = getActiveLineOverlay(3, 5, 20, 48);
  assert.equal(hidden.visible, false);
});

runTest('utility state transitions reset conflicting UI state on open and close', () => {
  const initial = { utilityMode: 'goto', targetLine: '24', showReplace: true };
  assert.deepEqual(getUtilityStateForAction('find', initial), {
    utilityMode: 'find',
    targetLine: '24',
    showReplace: false,
  });
  assert.deepEqual(getUtilityStateForAction('replace', initial), {
    utilityMode: 'find',
    targetLine: '24',
    showReplace: true,
  });
  assert.deepEqual(getUtilityStateForAction('goto', initial), {
    utilityMode: 'goto',
    targetLine: '24',
    showReplace: false,
  });
  assert.deepEqual(getUtilityStateForAction('close', initial), {
    utilityMode: null,
    targetLine: '',
    showReplace: false,
  });
});

console.log('Light editor utility tests passed.');
