import assert from 'node:assert/strict';

import {
  getCodeMirrorLanguageId,
  getLanguageLabel,
  getLineCommentToken,
} from '../.tmp-agent-tests/src/components/editor/codemirror/fileTypes.js';
import { CODEMIRROR_SHORTCUT_HINTS, isCommentShortcut } from '../.tmp-agent-tests/src/components/editor/codemirror/keymap.js';
import { buildLineCommentChanges } from '../.tmp-agent-tests/src/components/editor/codemirror/comments.js';
import {
  BUILTIN_PLAIN_EDITOR_ID,
  CODEMIRROR_EDITOR_ID,
  formatEditorCapabilities,
  isBuiltinProvider,
  sortEditorProviders,
} from '../.tmp-agent-tests/src/components/editor/providers.js';
import { formatCodeMirrorStatus } from '../.tmp-agent-tests/src/components/editor/codemirror/status.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('maps common filenames to codemirror language ids', () => {
  assert.equal(getCodeMirrorLanguageId('a.tsx'), 'typescript-jsx');
  assert.equal(getCodeMirrorLanguageId('a.rs'), 'rust');
  assert.equal(getCodeMirrorLanguageId('a.yaml'), 'yaml');
  assert.equal(getCodeMirrorLanguageId('a.unknown'), 'plaintext');
});

runTest('computes language labels from file extensions', () => {
  assert.equal(getLanguageLabel('next.config.js'), 'JS');
  assert.equal(getLanguageLabel('README'), 'README');
});

runTest('returns line comment tokens by file type', () => {
  assert.equal(getLineCommentToken('main.rs'), '//');
  assert.equal(getLineCommentToken('script.py'), '#');
  assert.equal(getLineCommentToken('docker-compose.yaml'), '#');
});

runTest('builds insert changes to line-comment a selection', () => {
  const text = 'alpha\n  beta\n';
  const changes = buildLineCommentChanges(text, [{ from: 0, to: 8 }], '//');
  assert.deepEqual(changes, [
    { from: 0, to: 0, insert: '// ' },
    { from: 8, to: 8, insert: '// ' },
  ]);
});

runTest('builds delete changes to uncomment already commented lines', () => {
  const text = '// alpha\n  // beta\n';
  const changes = buildLineCommentChanges(text, [{ from: 0, to: text.length }], '//');
  assert.deepEqual(changes, [
    { from: 0, to: 3, insert: '' },
    { from: 11, to: 14, insert: '' },
  ]);
});

runTest('formats status bar text for the global editor slot', () => {
  assert.equal(
    formatCodeMirrorStatus('main.rs', 12, 4, 'RS', true),
    'main.rs  Ln 12, Col 4  UTF-8  RS  • Modified',
  );
});

runTest('exposes stable editor provider ids', () => {
  assert.equal(BUILTIN_PLAIN_EDITOR_ID, 'builtin-plain');
  assert.equal(CODEMIRROR_EDITOR_ID, 'com.zync.editor.codemirror');
});

runTest('formats editor capabilities into concise labels', () => {
  assert.equal(
    formatEditorCapabilities(['search', 'replace', 'goto-line', 'folding'], 3),
    'Search, Replace, Go to Line +1',
  );
  assert.equal(formatEditorCapabilities([], 3), 'Plugin editor');
});

runTest('identifies built-in providers by plugin path', () => {
  assert.equal(isBuiltinProvider({ path: 'builtin://codemirror-editor-provider' }), true);
  assert.equal(isBuiltinProvider({ path: '/tmp/plugins/com.zync.editor.foo' }), false);
});

runTest('sorts editor providers by priority then built-in then name', () => {
  const sorted = sortEditorProviders([
    {
      path: '/tmp/plugins/z-provider',
      manifest: { name: 'Zed', editor: { priority: 10 } },
    },
    {
      path: 'builtin://a-provider',
      manifest: { name: 'Alpha Built-in', editor: { priority: 10 } },
    },
    {
      path: '/tmp/plugins/a-provider',
      manifest: { name: 'Aardvark', editor: { priority: 100 } },
    },
  ]);

  assert.deepEqual(
    sorted.map((provider) => provider.manifest.name),
    ['Aardvark', 'Alpha Built-in', 'Zed'],
  );
});

runTest('recognizes slash comment shortcuts across common key variants', () => {
  assert.equal(isCommentShortcut({ ctrlKey: true, metaKey: false, key: '/', code: 'Slash' }), true);
  assert.equal(isCommentShortcut({ ctrlKey: false, metaKey: true, key: '?', code: 'Slash' }), true);
  assert.equal(isCommentShortcut({ ctrlKey: false, metaKey: false, key: '/', code: 'Slash' }), false);
});

runTest('keeps shortcut hint metadata stable', () => {
  assert.deepEqual([...CODEMIRROR_SHORTCUT_HINTS], ['Ctrl/Cmd+S', 'Ctrl/Cmd+W', 'Ctrl/Cmd+G', 'Ctrl/Cmd+/']);
});

console.log('CodeMirror helper tests passed.');
