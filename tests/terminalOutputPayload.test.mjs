import assert from 'node:assert/strict';
import { decodeTerminalOutputData } from '../.tmp-agent-tests/src/lib/terminal/terminalOutputPayload.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  fail ${name}`);
    throw error;
  }
}

runTest('decodeTerminalOutputData decodes base64 PTY bytes', () => {
  const encoded = Buffer.from('hello\r\n\x1b[31mred\x1b[0m', 'utf8').toString('base64');
  const decoded = decodeTerminalOutputData(encoded);
  assert.equal(Buffer.from(decoded).toString('utf8'), 'hello\r\n\x1b[31mred\x1b[0m');
});

runTest('decodeTerminalOutputData accepts legacy number[] payloads', () => {
  const legacy = Array.from(Buffer.from('ls\r\n', 'utf8'));
  const decoded = decodeTerminalOutputData(legacy);
  assert.equal(Buffer.from(decoded).toString('utf8'), 'ls\r\n');
});

runTest('decodeTerminalOutputData handles empty output', () => {
  assert.equal(decodeTerminalOutputData('').length, 0);
  assert.equal(decodeTerminalOutputData([]).length, 0);
});

console.log('Terminal output payload tests passed.');