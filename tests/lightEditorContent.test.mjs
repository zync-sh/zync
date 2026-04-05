import assert from 'node:assert/strict';

import { createInlineEditorContentProvider } from '../.tmp-agent-tests/src/components/light-editor/content/provider.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('returns the provided initial content snapshot', () => {
  const provider = createInlineEditorContentProvider('hello', async () => {});
  assert.equal(provider.getInitialContent(), 'hello');
});

runTest('forwards saves and normalizes the save result', async () => {
  let received = '';
  const provider = createInlineEditorContentProvider('hello', async (content) => {
    received = content;
  });

  const result = await provider.saveContent('world');

  assert.equal(received, 'world');
  assert.deepEqual(result, { content: 'world' });
});

console.log('Light editor content tests passed.');
