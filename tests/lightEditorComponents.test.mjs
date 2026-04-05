import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { LightCompletionPanel } from '../.tmp-agent-tests/src/components/light-editor/LightCompletionPanel.js';
import { LightFindReplaceBar } from '../.tmp-agent-tests/src/components/light-editor/LightFindReplaceBar.js';
import { LightGoToLineBar } from '../.tmp-agent-tests/src/components/light-editor/LightGoToLineBar.js';
import { LightShortcutsList } from '../.tmp-agent-tests/src/components/light-editor/LightShortcutsList.js';
import { EditorPanelHost } from '../.tmp-agent-tests/src/components/light-editor/panels/EditorPanelHost.js';
import { LIGHT_EDITOR_COMMANDS } from '../.tmp-agent-tests/src/components/light-editor/commands.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

const noop = () => {};
const inputRef = { current: null };

runTest('find/replace widget renders a second row when replace is enabled', () => {
  const html = renderToStaticMarkup(React.createElement(LightFindReplaceBar, {
    findText: 'hello',
    replaceText: 'world',
    showReplace: true,
    matchLabel: '1/2',
    caseSensitive: true,
    wholeWord: false,
    useRegex: true,
    onFindTextChange: noop,
    onReplaceTextChange: noop,
    onToggleCaseSensitive: noop,
    onToggleWholeWord: noop,
    onToggleRegex: noop,
    onPrevious: noop,
    onNext: noop,
    onToggleReplace: noop,
    onReplaceOne: noop,
    onReplaceAll: noop,
    onClose: noop,
    onFindKeyDown: noop,
    onReplaceKeyDown: noop,
    findInputRef: inputRef,
    replaceInputRef: inputRef,
  }));

  assert.match(html, /placeholder="Find"/);
  assert.match(html, /placeholder="Replace"/);
  assert.match(html, /Replace<\/button>/);
  assert.match(html, /All<\/button>/);
  assert.match(html, /Match case/);
  assert.match(html, /Use regular expression/);
});

runTest('go-to-line widget renders the expected inline controls', () => {
  const html = renderToStaticMarkup(React.createElement(LightGoToLineBar, {
    targetLine: '10',
    lineCount: 120,
    onTargetLineChange: noop,
    onGo: noop,
    onClose: noop,
    onKeyDown: noop,
    inputRef,
  }));

  assert.match(html, /Go to line/);
  assert.match(html, /placeholder="1-120"/);
  assert.match(html, />Go<\/button>/);
});

runTest('completion panel offsets below active utility UI and renders selected item styling', () => {
  const html = renderToStaticMarkup(React.createElement(LightCompletionPanel, {
    currentWord: 'imp',
    completionItems: [
      { label: 'import', detail: 'keyword' },
      { label: 'implements', detail: 'keyword' },
    ],
    selectedCompletionIndex: 0,
    hoverInfo: null,
    definitionInfo: null,
    utilityMode: 'find',
    showReplace: true,
    onSelectIndex: noop,
    onApplyCompletion: noop,
  }));

  assert.match(html, /top:\d+px/);
  assert.match(html, /Context Engine/);
  assert.match(html, /Suggestions/);
  assert.match(html, /import/);
  assert.match(html, /border-app-accent\/40 bg-app-surface\/80/);
});

runTest('panel host composes utility and completion panels together', () => {
  const html = renderToStaticMarkup(React.createElement(EditorPanelHost, {
    utilityMode: 'find',
    showReplace: true,
    targetLine: '10',
    lineCount: 120,
    findText: 'hello',
    replaceText: 'world',
    matchLabel: '1/2',
    findCaseSensitive: false,
    findWholeWord: false,
    findUseRegex: false,
    currentWord: 'imp',
    completionItems: [{ label: 'import', detail: 'keyword' }],
    selectedCompletionIndex: 0,
    hoverInfo: null,
    definitionInfo: null,
    diagnostics: [],
    contextMenuPosition: null,
    contextMenuItems: [],
    findInputRef: inputRef,
    replaceInputRef: inputRef,
    goToLineInputRef: inputRef,
    onFindTextChange: noop,
    onReplaceTextChange: noop,
    onToggleFindCaseSensitive: noop,
    onToggleFindWholeWord: noop,
    onToggleFindRegex: noop,
    onTargetLineChange: noop,
    onPreviousFind: noop,
    onNextFind: noop,
    onToggleReplace: noop,
    onReplaceOne: noop,
    onReplaceAll: noop,
    onCloseFind: noop,
    onCloseGoto: noop,
    onCloseContextMenu: noop,
    onFindKeyDown: noop,
    onReplaceKeyDown: noop,
    onGoToLine: noop,
    onGotoKeyDown: noop,
    onCompletionSelectIndex: noop,
    onApplyCompletion: noop,
    onJumpToDiagnostic: noop,
  }));

  assert.match(html, /placeholder="Find"/);
  assert.match(html, /placeholder="Replace"/);
  assert.match(html, /Context Engine/);
  assert.match(html, /import/);
});

runTest('shortcuts list renders grouped editor commands and keycaps', () => {
  const html = renderToStaticMarkup(React.createElement(LightShortcutsList, {
    commands: LIGHT_EDITOR_COMMANDS,
  }));

  assert.match(html, /File/);
  assert.match(html, /Search/);
  assert.match(html, /Save/);
  assert.match(html, /Find/);
  assert.match(html, /Ctrl/);
  assert.match(html, /Cmd/);
});

console.log('Light editor component tests passed.');
