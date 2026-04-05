import assert from 'node:assert/strict';
import { attachAiContext } from '../.tmp-agent-tests/src/ai/lib/requestContext.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('returns original context when no attachment exists', () => {
  const base = { cwd: '/tmp', connectionType: 'local' };
  assert.deepEqual(attachAiContext(base, null), base);
});

runTest('attaches label and redacts sensitive content', () => {
  const result = attachAiContext(
    { cwd: '/srv/app' },
    { type: 'file', label: 'env', content: 'token=supersecret' },
  );

  assert.equal(result.attachedLabel, 'env');
  assert.equal(result.cwd, '/srv/app');
  assert.ok(typeof result.attachedContent === 'string');
  assert.ok(!String(result.attachedContent).includes('supersecret'));
  assert.ok(String(result.attachedContent).includes('[REDACTED]'));
});

console.log('Request context tests passed.');
