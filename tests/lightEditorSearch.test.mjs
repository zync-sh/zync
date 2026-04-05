import assert from 'node:assert/strict';
import { buildSearchRegex, findMatches, replaceAllMatches, replaceMatch } from '../.tmp-agent-tests/src/components/light-editor/search.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('finds case-insensitive matches', () => {
  const matches = findMatches('Hello hello', 'hello', {
    caseSensitive: false,
    wholeWord: false,
    useRegex: false,
  });
  assert.equal(matches.length, 2);
});

runTest('supports whole-word matching', () => {
  const matches = findMatches('app apple app', 'app', {
    caseSensitive: true,
    wholeWord: true,
    useRegex: false,
  });
  assert.equal(matches.length, 2);
});

runTest('replaces one and all matches', () => {
  const matches = findMatches('a b a', 'a', {
    caseSensitive: true,
    wholeWord: false,
    useRegex: false,
  });
  assert.equal(replaceMatch('a b a', matches[0], 'x'), 'x b a');
  assert.equal(replaceAllMatches('a b a', matches, 'x'), 'x b x');
});

runTest('returns null regex for invalid regex input', () => {
  const regex = buildSearchRegex('([', {
    caseSensitive: true,
    wholeWord: false,
    useRegex: true,
  });
  assert.equal(regex, null);
});

console.log('Light editor search tests passed.');
