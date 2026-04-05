import assert from 'node:assert/strict';

// Stub out modules that use browser globals before importing the store.
// Zustand and nanoid are pure ESM — only the localStorage call is deferred,
// so the import itself is safe as long as we don't trigger persistence.
const store = await import('../.tmp-agent-tests/src/ai/store/agentRunStore.js');
const { partializeConversations } = store;

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function makeToolCall(overrides = {}) {
  return {
    type: 'tool-call',
    id: 'msg-1',
    toolCallId: 'tc-1',
    toolName: 'run_command',
    input: { command: 'ls -la', reason: 'list files' },
    output: 'total 16\ndrwxr-xr-x  ...',
    status: 'done',
    ...overrides,
  };
}

function makeThinking(overrides = {}) {
  return {
    type: 'thinking',
    id: 'think-1',
    text: 'I should check the nginx config first.',
    ...overrides,
  };
}

function makeDone(overrides = {}) {
  return {
    type: 'done',
    id: 'done-1',
    success: true,
    summary: 'Deployed nginx successfully.',
    actions: ['✔ Checked config', '✔ Restarted nginx'],
    ...overrides,
  };
}

runTest('clears output and strips diff from tool-call messages', () => {
  const conversations = {
    'ssh:prod': [
      makeToolCall({
        output: 'secret_token=abc123 found in config',
        diff: { before: 'old', after: 'new', path: '/etc/nginx.conf' },
      }),
    ],
  };
  const result = partializeConversations(conversations);
  const msg = result['ssh:prod'][0];

  assert.equal(msg.type, 'tool-call');
  // Raw output is cleared (not stored) to prevent secrets leaking into localStorage.
  assert.equal(msg.output, '', 'original output leaked into persistence');
  assert.ok(!('diff' in msg), 'diff field leaked into persistence');
  assert.equal(msg.toolName, 'run_command');
  assert.deepEqual(msg.input, { command: 'ls -la', reason: 'list files' });
});

runTest('resets running tool-call status to done on persist', () => {
  const conversations = {
    'ssh:prod': [makeToolCall({ status: 'running' })],
  };
  const result = partializeConversations(conversations);
  assert.equal(result['ssh:prod'][0].status, 'done');
});

runTest('preserves error status on tool-call messages', () => {
  const conversations = {
    'ssh:prod': [makeToolCall({ status: 'error' })],
  };
  const result = partializeConversations(conversations);
  assert.equal(result['ssh:prod'][0].status, 'error');
});

runTest('filters out thinking messages', () => {
  const conversations = {
    'ssh:prod': [
      { type: 'user', id: 'u1', text: 'deploy nginx' },
      makeThinking(),
      makeToolCall(),
      makeDone(),
    ],
  };
  const result = partializeConversations(conversations);
  const types = result['ssh:prod'].map((m) => m.type);

  assert.ok(!types.includes('thinking'), 'thinking message leaked into persistence');
  assert.ok(types.includes('user'));
  assert.ok(types.includes('tool-call'));
  assert.ok(types.includes('done'));
});

runTest('caps messages at MAX_PERSISTED_MESSAGES (60)', () => {
  const msgs = Array.from({ length: 80 }, (_, i) => ({
    type: 'user',
    id: `u${i}`,
    text: `goal ${i}`,
  }));
  const result = partializeConversations({ scope: msgs });
  assert.equal(result['scope'].length, 60);
  // Should keep the last 60
  assert.equal(result['scope'][0].id, 'u20');
  assert.equal(result['scope'][59].id, 'u79');
});

runTest('backfills actions field for legacy done messages without it', () => {
  // Simulate a done message persisted before the `actions` field was added
  const legacyDone = { type: 'done', id: 'done-old', success: true, summary: 'Done.' };
  const conversations = { scope: [legacyDone] };
  const result = partializeConversations(conversations);
  const msg = result['scope'][0];

  assert.equal(msg.type, 'done');
  assert.deepEqual(msg.actions, []);
  assert.equal(msg.summary, 'Done.');
});

runTest('preserves done messages that already have actions', () => {
  const conversations = { scope: [makeDone()] };
  const result = partializeConversations(conversations);
  const msg = result['scope'][0];

  assert.deepEqual(msg.actions, ['✔ Checked config', '✔ Restarted nginx']);
});

runTest('handles multiple scopes independently', () => {
  const conversations = {
    'ssh:prod': [makeToolCall({ output: 'prod secret' })],
    'local': [makeToolCall({ output: 'local secret' })],
  };
  const result = partializeConversations(conversations);

  assert.equal(Object.keys(result).length, 2);
  assert.equal(result['ssh:prod'][0].output, '', 'prod secret leaked');
  assert.equal(result['local'][0].output, '', 'local secret leaked');
});

console.log('AgentRunStore partialize tests passed.');
