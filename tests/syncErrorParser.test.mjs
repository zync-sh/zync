import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSyncErrorString,
  parseSyncInvokeError,
} from '../.tmp-agent-tests/src/vault/syncError.js';

test('parseSyncErrorString parses bracketed code', () => {
  const parsed = parseSyncErrorString('[sync_temp_write_failed] cannot write file');
  assert.equal(parsed.code, 'sync_temp_write_failed');
  assert.equal(parsed.message, 'cannot write file');
});

test('parseSyncErrorString keeps plain message', () => {
  const parsed = parseSyncErrorString('plain failure');
  assert.equal(parsed.code, undefined);
  assert.equal(parsed.message, 'plain failure');
});

test('parseSyncErrorString handles empty/whitespace input', () => {
  assert.deepEqual(parseSyncErrorString(''), { code: undefined, message: '', raw: '' });
  assert.deepEqual(parseSyncErrorString('   '), { code: undefined, message: '', raw: '' });
});

test('parseSyncErrorString handles malformed bracket syntax', () => {
  const left = parseSyncErrorString('[code');
  assert.equal(left.code, undefined);
  assert.equal(left.message, '[code');

  const right = parseSyncErrorString('code]');
  assert.equal(right.code, undefined);
  assert.equal(right.message, 'code]');
});

test('parseSyncErrorString handles code-only and multiline payloads', () => {
  const codeOnly = parseSyncErrorString('[ERROR]');
  assert.equal(codeOnly.code, 'ERROR');
  assert.equal(codeOnly.message, '');

  const multiline = parseSyncErrorString('[sync_failed] line1\nline2');
  assert.equal(multiline.code, 'sync_failed');
  assert.equal(multiline.message, 'line1\nline2');
});

test('parseSyncInvokeError reads error.message objects', () => {
  const parsed = parseSyncInvokeError({ message: '[vault_import_failed] import failed' });
  assert.equal(parsed.code, 'vault_import_failed');
  assert.equal(parsed.message, 'import failed');
});

test('parseSyncInvokeError handles plain string and nullish', () => {
  const plain = parseSyncInvokeError('plain failure');
  assert.equal(plain.code, undefined);
  assert.equal(plain.message, 'plain failure');

  const nil = parseSyncInvokeError(null);
  assert.equal(nil.code, undefined);
  assert.equal(nil.message, '');

  const undef = parseSyncInvokeError(undefined);
  assert.equal(undef.code, undefined);
  assert.equal(undef.message, '');
});

test('parseSyncInvokeError handles object without message', () => {
  const parsed = parseSyncInvokeError({});
  assert.equal(parsed.code, undefined);
  assert.equal(parsed.message, '[object Object]');
});
