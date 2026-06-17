import assert from 'node:assert/strict';
import { resolveTerminalSpawnParams } from '../.tmp-agent-tests/src/lib/terminal/spawnContext.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  fail ${name}`);
    throw error;
  }
}

const terminals = {
  local: [
    { id: 'term-a', lastKnownCwd: '/tmp/a', shellOverride: 'pwsh.exe' },
  ],
  'host-1': [
    { id: 'term-b', initialPath: '/home/user', shellOverride: 'bash -l' },
  ],
};

runTest('resolveTerminalSpawnParams prefers lastKnownCwd', () => {
  const result = resolveTerminalSpawnParams('local', 'term-a', terminals, 'cmd.exe');
  assert.equal(result.cwd, '/tmp/a');
  assert.equal(result.shell, 'pwsh.exe');
});

runTest('resolveTerminalSpawnParams falls back to initialPath', () => {
  const result = resolveTerminalSpawnParams('host-1', 'term-b', terminals);
  assert.equal(result.cwd, '/home/user');
  assert.equal(result.shell, 'bash -l');
});

runTest('resolveTerminalSpawnParams uses global Windows shell for local', () => {
  const result = resolveTerminalSpawnParams('local', 'missing', terminals, 'cmd.exe');
  assert.equal(result.shell, 'cmd.exe');
  assert.equal(result.cwd, undefined);
});

console.log('Terminal spawn context tests passed.');