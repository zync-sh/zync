import assert from 'node:assert/strict';
import { isTerminalDomMeasurable } from '../.tmp-agent-tests/src/lib/terminal/terminalFit.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  fail ${name}`);
    throw error;
  }
}

runTest('isTerminalDomMeasurable rejects disconnected elements', () => {
  assert.equal(isTerminalDomMeasurable({ element: null }), false);
});

runTest('isTerminalDomMeasurable rejects zero-size hosts', () => {
  assert.equal(
    isTerminalDomMeasurable({
      element: { isConnected: true, clientWidth: 0, clientHeight: 400 },
    }),
    false,
  );
});

runTest('isTerminalDomMeasurable accepts measurable hosts', () => {
  assert.equal(
    isTerminalDomMeasurable({
      element: { isConnected: true, clientWidth: 800, clientHeight: 400 },
    }),
    true,
  );
});

console.log('Terminal panel restore tests passed.');