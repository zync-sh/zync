import assert from 'node:assert/strict';
import {
  IDLE_HOST_SUSPEND_MESSAGE,
  terminalExitGenerationMatches,
} from '../.tmp-agent-tests/src/lib/terminal/terminalLifecycleListeners.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  fail ${name}`);
    throw error;
  }
}

runTest('IDLE_HOST_SUSPEND_MESSAGE includes resume hint', () => {
  assert.match(IDLE_HOST_SUSPEND_MESSAGE, /Press Enter to resume/);
});

runTest('terminalExitGenerationMatches accepts idle suspend exit generation', () => {
  assert.equal(
    terminalExitGenerationMatches({ generation: 6, suspendedByIdle: true }, 5),
    true,
  );
});

runTest('terminalExitGenerationMatches rejects unrelated generation', () => {
  assert.equal(
    terminalExitGenerationMatches({ generation: 6, suspendedByIdle: true }, 4),
    false,
  );
});

console.log('Terminal lifecycle listener tests passed.');