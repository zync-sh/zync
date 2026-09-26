import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generatePublisherKey,
  signPluginDirectory,
  verifySignedPlugin,
} from '../scripts/plugin-signing/package-signing.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zync-plugin-signing-test-'));
try {
  const source = path.join(root, 'source');
  const signed = path.join(root, 'signed');
  const keyPath = path.join(root, 'publisher-key.json');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({
    manifestVersion: 2,
    id: 'dev.example.manual-test',
    name: 'Manual test',
    version: '1.0.0',
    publisher: 'dev.example',
  }));
  fs.writeFileSync(path.join(source, 'worker.js'), 'self.onmessage = () => {};');

  const generated = generatePublisherKey('dev.example', keyPath);
  assert.match(generated.keyId, /^sha256:[a-f0-9]{64}$/);
  signPluginDirectory(source, keyPath, signed, 1_800_000_000_000);
  const verified = verifySignedPlugin(signed);
  assert.equal(verified.pluginId, 'dev.example.manual-test');
  assert.equal(verified.publisher, 'dev.example');
  assert.equal(verified.keyId, generated.keyId);
  assert.equal(fs.existsSync(path.join(signed, 'publisher-key.json')), false);
  assert.throws(
    () => signPluginDirectory(source, keyPath, signed),
    /Signed output already exists/,
  );

  fs.writeFileSync(path.join(signed, 'worker.js'), 'tampered');
  assert.throws(() => verifySignedPlugin(signed), /integrity verification failed/);

  const unsafeKeyPath = path.join(source, 'publisher-key.json');
  generatePublisherKey('dev.example', unsafeKeyPath);
  assert.throws(
    () => signPluginDirectory(source, unsafeKeyPath, path.join(root, 'bad')),
    /Publisher key must be outside/,
  );
  console.log('Plugin signing tool tests passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
