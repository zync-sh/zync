import assert from 'node:assert/strict';
import { redactSensitiveOutput } from '../.tmp-agent-tests/src/ai/lib/redactContext.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('returns null for null input', () => {
  assert.equal(redactSensitiveOutput(null), null);
});

runTest('redacts key=value style secrets', () => {
  const result = redactSensitiveOutput('password=supersecret and token=abc123');
  assert.ok(!result.includes('supersecret'), 'password value leaked');
  assert.ok(!result.includes('abc123'), 'token value leaked');
  assert.ok(result.includes('[REDACTED]'), 'missing redaction marker');
});

runTest('redacts Authorization: Bearer headers', () => {
  const result = redactSensitiveOutput('Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig');
  assert.ok(!result.includes('eyJhbGciOiJSUzI1NiJ9'), 'bearer token leaked');
  assert.ok(result.includes('[REDACTED]'));
});

runTest('redacts GitHub personal access tokens', () => {
  // Use a prefix that doesn't trigger the key=value rule (no "token:")
  const result = redactSensitiveOutput('Cloning with ghp_ABCDEFGHIJKLMNOPQRSTUVwxyz0123 as credential');
  assert.ok(!result.includes('ghp_'), 'GitHub token leaked');
  assert.ok(result.includes('[REDACTED_KEY]'));
});

runTest('redacts AWS access key IDs', () => {
  const result = redactSensitiveOutput('AKIAIOSFODNN7EXAMPLE is the key');
  assert.ok(!result.includes('AKIAIOSFODNN7EXAMPLE'), 'AWS key leaked');
  assert.ok(result.includes('[REDACTED_KEY]'));
});

runTest('redacts OpenAI-style sk- keys', () => {
  const result = redactSensitiveOutput('sk-proj-abcdefghijklmnopqrstuvwxyz1234567890ABC');
  assert.ok(!result.includes('sk-proj-'), 'OpenAI key leaked');
  assert.ok(result.includes('[REDACTED_KEY]'));
});

runTest('redacts PEM private keys', () => {
  const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA2a2rwplBQLF29amygykEMmYz0+Kcj3bKBp29bNM
-----END RSA PRIVATE KEY-----`;
  const result = redactSensitiveOutput(pem);
  assert.ok(!result.includes('MIIEowIBAAKCAQEA'), 'PEM key content leaked');
  assert.ok(result.includes('[REDACTED_PRIVATE_KEY]'));
});

runTest('redacts internal IPv4 addresses', () => {
  const result = redactSensitiveOutput('Connect to 192.168.1.100 on port 22');
  assert.ok(!result.includes('192.168.1.100'), 'internal IP leaked');
  assert.ok(result.includes('[REDACTED_IP]'));
});

runTest('redacts internal hostnames', () => {
  const result = redactSensitiveOutput('Connect to db-primary.internal and cache.corp');
  assert.ok(!result.includes('db-primary.internal'), 'internal hostname leaked');
  assert.ok(!result.includes('cache.corp'), 'corp hostname leaked');
  assert.ok(result.includes('[REDACTED_HOST]'));
});

runTest('does not redact public IP addresses', () => {
  const result = redactSensitiveOutput('Server at 8.8.8.8 is reachable');
  assert.ok(result.includes('8.8.8.8'), 'public IP incorrectly redacted');
});

runTest('preserves non-sensitive content', () => {
  const safe = 'nginx is running on port 80, status: active';
  const result = redactSensitiveOutput(safe);
  assert.equal(result, safe);
});

console.log('Redaction tests passed.');
