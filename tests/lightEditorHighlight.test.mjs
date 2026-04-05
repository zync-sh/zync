import assert from 'node:assert/strict';
import {
  createHighlightCacheKey,
  getHighlightViewport,
  getLineSlice,
  renderHighlightedHtml,
} from '../.tmp-agent-tests/src/components/light-editor/highlight.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('highlights keywords and numbers', () => {
  const html = renderHighlightedHtml('const count = 42;', 'javascript');

  assert.ok(html.includes('token keyword'));
  assert.ok(html.includes('token number'));
});

runTest('highlights comments and strings', () => {
  const html = renderHighlightedHtml('const a = \"hi\"; // note', 'javascript');

  assert.ok(html.includes('token string'));
  assert.ok(html.includes('token comment'));
});

runTest('computes a buffered highlight viewport', () => {
  const viewport = getHighlightViewport(240, 240, 200);

  assert.equal(viewport.startLine, 0);
  assert.equal(viewport.endLine, 50);
});

runTest('extracts the visible line slice for virtualization', () => {
  const slice = getLineSlice('a\nb\nc\nd', 1, 3);

  assert.equal(slice.totalLines, 4);
  assert.equal(slice.visibleContent, 'b\nc');
});

runTest('creates distinct cache keys for different same-length visible slices', () => {
  const a = createHighlightCacheKey('rust', 0, 2, 'ab');
  const b = createHighlightCacheKey('rust', 0, 2, 'cd');
  assert.notEqual(a, b);
});

console.log('Light editor highlight tests passed.');
