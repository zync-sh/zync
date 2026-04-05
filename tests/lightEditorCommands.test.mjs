import assert from 'node:assert/strict';

import {
  groupLightEditorCommands,
  LIGHT_EDITOR_COMMANDS,
  resolveLightEditorCommand,
  splitCommandShortcut,
} from '../.tmp-agent-tests/src/components/light-editor/commands.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('exports the expected core commands for the editor surface', () => {
  const ids = LIGHT_EDITOR_COMMANDS.map((command) => command.id);
  assert.deepEqual(ids, [
    'save',
    'find',
    'replace',
    'goto',
    'close-utility',
    'cut',
    'copy',
    'paste',
    'select-all',
    'fold-all',
    'unfold-all',
    'fold-imports',
    'fold-current',
    'completion-next',
    'completion-prev',
    'completion-accept',
    'completion-clear',
    'indent',
  ]);
});

runTest('includes shortcut metadata for search commands', () => {
  const find = LIGHT_EDITOR_COMMANDS.find((command) => command.id === 'find');
  const replace = LIGHT_EDITOR_COMMANDS.find((command) => command.id === 'replace');
  const goto = LIGHT_EDITOR_COMMANDS.find((command) => command.id === 'goto');

  assert.equal(find?.shortcut, 'Ctrl/Cmd+F');
  assert.equal(replace?.shortcut, 'Ctrl/Cmd+H');
  assert.equal(goto?.shortcut, 'Ctrl/Cmd+G');
});

runTest('resolves keyboard input to command ids', () => {
  assert.equal(resolveLightEditorCommand({ key: 's', ctrlOrMeta: true, hasSuggestions: false }), 'save');
  assert.equal(resolveLightEditorCommand({ key: 'ArrowDown', ctrlOrMeta: false, hasSuggestions: true }), 'completion-next');
  assert.equal(resolveLightEditorCommand({ key: 'Tab', ctrlOrMeta: false, hasSuggestions: true }), 'completion-accept');
  assert.equal(resolveLightEditorCommand({ key: 'Tab', ctrlOrMeta: false, hasSuggestions: false }), 'indent');
  assert.equal(resolveLightEditorCommand({ key: 'Escape', ctrlOrMeta: false, hasSuggestions: false }), null);
});

runTest('splits shortcut strings into keyboard key parts', () => {
  assert.deepEqual(splitCommandShortcut('Ctrl/Cmd+F'), ['Ctrl', 'Cmd', 'F']);
  assert.deepEqual(splitCommandShortcut('Enter / Tab'), ['Enter', 'Tab']);
});

runTest('groups commands by their declared command family', () => {
  const groups = groupLightEditorCommands(LIGHT_EDITOR_COMMANDS);
  assert.ok(groups.file.some((command) => command.id === 'save'));
  assert.ok(groups.search.some((command) => command.id === 'find'));
  assert.ok(groups.editing.some((command) => command.id === 'copy'));
  assert.ok(groups.completion.some((command) => command.id === 'completion-accept'));
});

console.log('Light editor command tests passed.');
