import assert from 'node:assert/strict';
import { clampAiSidebarWidth } from '../.tmp-agent-tests/src/components/ai/useAiSidebarResize.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('clamps sidebar width to minimum', () => {
  assert.equal(clampAiSidebarWidth(100), 250);
});

runTest('clamps sidebar width to maximum', () => {
  assert.equal(clampAiSidebarWidth(1200), 800);
});

runTest('preserves widths inside allowed range', () => {
  assert.equal(clampAiSidebarWidth(420), 420);
});

console.log('AI sidebar resize tests passed.');
