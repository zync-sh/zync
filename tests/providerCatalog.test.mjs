import assert from 'node:assert/strict';
import {
  getActiveModel,
  getModelShort,
  requiresProviderSetup,
} from '../.tmp-agent-tests/src/components/ai/providerCatalog.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('uses default model when provider has no configured model', () => {
  assert.equal(getActiveModel('openai', undefined), 'gpt-4o');
});

runTest('uses configured model when provided', () => {
  assert.equal(getActiveModel('claude', 'claude-custom'), 'claude-custom');
});

runTest('computes model short label from current models', () => {
  assert.equal(
    getModelShort([{ value: 'gpt-4o', label: 'GPT-4o', short: 'GPT-4o' }], 'gpt-4o'),
    'GPT-4o',
  );
});

runTest('requires setup for ollama when unavailable or model missing', () => {
  assert.equal(requiresProviderSetup('ollama', '', true), true);
  assert.equal(requiresProviderSetup('ollama', 'llama3.2', false), true);
  assert.equal(requiresProviderSetup('ollama', 'llama3.2', true), false);
});

runTest('requires setup for hosted providers only when model missing', () => {
  assert.equal(requiresProviderSetup('openai', '', true), true);
  assert.equal(requiresProviderSetup('openai', 'gpt-4o', false), false);
});

console.log('Provider catalog tests passed.');
