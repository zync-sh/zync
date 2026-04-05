import assert from 'node:assert/strict';
import { shouldTreatAgentInputAsAsk } from '../.tmp-agent-tests/src/components/ai/sidebarSubmit.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('routes short greetings to ask mode', () => {
  assert.equal(shouldTreatAgentInputAsAsk('hello'), true);
  assert.equal(shouldTreatAgentInputAsAsk('thank you'), true);
});

runTest('keeps non-greeting work requests in agent mode', () => {
  assert.equal(shouldTreatAgentInputAsAsk('restart nginx and inspect the logs'), false);
  assert.equal(shouldTreatAgentInputAsAsk('hello there can you inspect the production redis issue now'), false);
});

console.log('Sidebar submit tests passed.');
