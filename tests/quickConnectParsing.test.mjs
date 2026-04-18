import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

const compiledParsingPath = path.resolve('.tmp-agent-tests/src/components/dashboard/welcome/quick-connect/parsing.js');
if (!fs.existsSync(compiledParsingPath)) {
  throw new Error(
    'Missing compiled parser module. Run "npm run compile:agent-tests" (or "npm run test:all-agent") first.',
  );
}

let parseSSHCommand;
try {
  ({ parseSSHCommand } = await import('../.tmp-agent-tests/src/components/dashboard/welcome/quick-connect/parsing.js'));
} catch (error) {
  console.error('Failed to import compiled parser module. Run "npm run compile:agent-tests" first.');
  throw error;
}

runTest('parseSSHCommand handles verbose flag without swallowing host token', () => {
  const parsed = parseSSHCommand('ssh -v user@host');
  assert.deepEqual(parsed, { username: 'user', host: 'host', port: 22, privateKeyPath: undefined });
});

runTest('parseSSHCommand handles boolean flag + key flag sequence', () => {
  const parsed = parseSSHCommand('ssh -v -i ~/.ssh/id_ed25519 user@host');
  assert.deepEqual(parsed, {
    username: 'user',
    host: 'host',
    port: 22,
    privateKeyPath: '~/.ssh/id_ed25519',
  });
});

runTest('parseSSHCommand keeps port parsing correct with auth forwarding flag', () => {
  const parsed = parseSSHCommand('ssh -A -p 2222 user@host');
  assert.deepEqual(parsed, { username: 'user', host: 'host', port: 2222, privateKeyPath: undefined });
});

runTest('parseSSHCommand derives username from -l flag', () => {
  const parsed = parseSSHCommand('ssh -l admin example.com');
  assert.deepEqual(parsed, { username: 'admin', host: 'example.com', port: 22, privateKeyPath: undefined });
});

runTest('parseSSHCommand ignores -o argument as host candidate', () => {
  const parsed = parseSSHCommand('ssh -o Port=2222 user@host');
  assert.deepEqual(parsed, { username: 'user', host: 'host', port: 22, privateKeyPath: undefined });
});

runTest('parseSSHCommand returns null for invalid -p port value', () => {
  const parsed = parseSSHCommand('ssh -p abc user@host');
  assert.equal(parsed, null);
});

runTest('parseSSHCommand preserves spaces in quoted key paths', () => {
  const parsed = parseSSHCommand('ssh -i "~/my keys/id_ed25519" user@host');
  assert.deepEqual(parsed, {
    username: 'user',
    host: 'host',
    port: 22,
    privateKeyPath: '~/my keys/id_ed25519',
  });
});

console.log('Quick connect parsing tests passed.');
