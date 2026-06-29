import assert from 'node:assert/strict';
import { decodeTerminalOutputChannelFrame } from '../.tmp-agent-tests/src/lib/terminal/terminalOutputStream.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  fail ${name}`);
    throw error;
  }
}

runTest('decodeTerminalOutputChannelFrame parses generation and PTY bytes', () => {
  const payload = new Uint8Array([0x03, 0x00, 0x00, 0x00, 0x24, 0x50, 0x53]);
  const buffer = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
  const decoded = decodeTerminalOutputChannelFrame(buffer);
  assert.equal(decoded.generation, 3);
  assert.deepEqual(decoded.data, new Uint8Array([0x24, 0x50, 0x53]));
});

runTest('decodeTerminalOutputChannelFrame rejects truncated header', () => {
  const payload = new Uint8Array([0x01, 0x00, 0x00]);
  const buffer = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
  assert.throws(
    () => decodeTerminalOutputChannelFrame(buffer),
    RangeError,
  );
});

runTest('decodeTerminalOutputChannelFrame handles empty PTY payload', () => {
  const payload = new Uint8Array([0x01, 0x00, 0x00, 0x00]);
  const buffer = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
  const decoded = decodeTerminalOutputChannelFrame(buffer);
  assert.equal(decoded.generation, 1);
  assert.equal(decoded.data.length, 0);
});

console.log('Terminal output stream tests passed.');