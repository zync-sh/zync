import assert from 'node:assert/strict';

import { getLightEditorKeyAction } from '../.tmp-agent-tests/src/components/light-editor/interactions.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('prioritizes save over other editor actions when ctrl/cmd+s is pressed', () => {
  assert.equal(getLightEditorKeyAction({ key: 's', ctrlOrMeta: true, hasSuggestions: true }), 'save');
});

runTest('routes suggestion navigation keys only when suggestions are visible', () => {
  assert.equal(getLightEditorKeyAction({ key: 'ArrowDown', ctrlOrMeta: false, hasSuggestions: true }), 'completion-next');
  assert.equal(getLightEditorKeyAction({ key: 'ArrowUp', ctrlOrMeta: false, hasSuggestions: true }), 'completion-prev');
  assert.equal(getLightEditorKeyAction({ key: 'ArrowDown', ctrlOrMeta: false, hasSuggestions: false }), 'noop');
});

runTest('prefers completion acceptance over indent when suggestions are visible', () => {
  assert.equal(getLightEditorKeyAction({ key: 'Tab', ctrlOrMeta: false, hasSuggestions: true }), 'completion-accept');
  assert.equal(getLightEditorKeyAction({ key: 'Enter', ctrlOrMeta: false, hasSuggestions: true }), 'completion-accept');
  assert.equal(getLightEditorKeyAction({ key: 'Tab', ctrlOrMeta: false, hasSuggestions: false }), 'indent');
});

runTest('routes escape to completion clear only when suggestions are visible', () => {
  assert.equal(getLightEditorKeyAction({ key: 'Escape', ctrlOrMeta: false, hasSuggestions: true }), 'completion-clear');
  assert.equal(getLightEditorKeyAction({ key: 'Escape', ctrlOrMeta: false, hasSuggestions: false }), 'noop');
});

console.log('Light editor interaction tests passed.');
