import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generatePublisherKey,
  signPluginDirectory,
} from '../scripts/plugin-signing/package-signing.mjs';
import {
  buildSignedRegistryFromFile,
  digestPluginDirectory,
  generateRegistryRootKey,
  verifySignedRegistry,
} from '../scripts/plugin-signing/registry-signing.mjs';

const issuedAtMs = 1_800_000_000_000;
const expiresAtMs = issuedAtMs + 60_000;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zync-plugin-registry-signing-test-'));

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

try {
  const source = path.join(root, 'source');
  const signed = path.join(root, 'signed');
  const publisherKeyPath = path.join(root, 'publisher-key.json');
  const rootKeyPath = path.join(root, 'registry-root-key.json');
  const descriptorPath = path.join(root, 'releases.json');
  const registryPath = path.join(root, 'registry.json');
  fs.mkdirSync(source);
  writeJson(path.join(source, 'manifest.json'), {
    manifestVersion: 2,
    id: 'dev.example.registry-test',
    name: 'Registry test',
    version: '1.2.3',
    description: 'Signed registry test package.',
    publisher: 'dev.example',
    type: 'workspace',
  });
  fs.writeFileSync(path.join(source, 'worker.js'), 'self.onmessage = () => {};\n');

  const publisherKey = generatePublisherKey('dev.example', publisherKeyPath);
  signPluginDirectory(source, publisherKeyPath, signed, issuedAtMs);
  const registryRoot = generateRegistryRootKey(rootKeyPath);
  writeJson(descriptorPath, {
    releases: [{
      packagePath: './signed',
      downloadUrl: 'https://plugins.example.test/dev.example.registry-test/1.2.3',
      publisherVerified: true,
      thumbnailUrl: 'https://plugins.example.test/assets/registry-test.png',
    }],
  });

  const built = buildSignedRegistryFromFile({
    descriptorPath,
    keyPath: rootKeyPath,
    outputPath: registryPath,
    version: 7,
    issuedAtMs,
    expiresAtMs,
  });
  assert.equal(built.pluginCount, 1);
  assert.equal(built.keyId, registryRoot.keyId);

  const verified = verifySignedRegistry(registryPath, rootKeyPath, issuedAtMs + 1);
  assert.deepEqual(verified, {
    version: 7,
    expiresAtMs,
    pluginCount: 1,
    revocationCount: 0,
    keyId: registryRoot.keyId,
  });

  const envelope = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const release = envelope.signed.plugins[0];
  assert.equal(release.id, 'dev.example.registry-test');
  assert.equal(release.publisherKeyId, publisherKey.keyId);
  assert.equal(release.packageDigest, digestPluginDirectory(signed));
  assert.equal(release.publisherVerified, true);

  const betaSource = path.join(root, 'beta-source');
  const betaSigned = path.join(root, 'beta-signed');
  fs.mkdirSync(betaSource);
  writeJson(path.join(betaSource, 'manifest.json'), {
    manifestVersion: 2,
    id: 'dev.example.registry-test',
    name: 'Registry test',
    version: '1.3.0-beta.1',
    publisher: 'dev.example',
    type: 'workspace',
  });
  fs.writeFileSync(path.join(betaSource, 'worker.js'), 'self.onmessage = () => {};\n');
  signPluginDirectory(betaSource, publisherKeyPath, betaSigned, issuedAtMs);
  const channelDescriptor = path.join(root, 'channel-releases.json');
  writeJson(channelDescriptor, { releases: [
    { packagePath: './signed', downloadUrl: 'https://plugins.example.test/stable.zip', publisherVerified: true },
    { packagePath: './beta-signed', downloadUrl: 'https://plugins.example.test/beta.zip', channel: 'beta', publisherVerified: true },
  ] });
  const channelRegistry = path.join(root, 'channel-registry.json');
  buildSignedRegistryFromFile({ descriptorPath: channelDescriptor, keyPath: rootKeyPath,
    outputPath: channelRegistry, version: 8, issuedAtMs, expiresAtMs });
  const channels = JSON.parse(fs.readFileSync(channelRegistry, 'utf8')).signed.plugins;
  assert.deepEqual(channels.map(item => item.channel), ['stable', 'beta']);
  assert.equal(verifySignedRegistry(channelRegistry, rootKeyPath, issuedAtMs + 1).pluginCount, 2);
  writeJson(channelDescriptor, { releases: [
    { packagePath: './beta-signed', downloadUrl: 'https://plugins.example.test/beta.zip', channel: 'stable', publisherVerified: true },
  ] });
  assert.throws(() => buildSignedRegistryFromFile({ descriptorPath: channelDescriptor, keyPath: rootKeyPath,
    outputPath: path.join(root, 'mismatched-channel.json'), version: 9, issuedAtMs, expiresAtMs }),
  /channel does not match version/);

  envelope.signed.plugins[0].name = 'Tampered';
  const tamperedPath = path.join(root, 'registry-tampered.json');
  writeJson(tamperedPath, envelope);
  assert.throws(
    () => verifySignedRegistry(tamperedPath, rootKeyPath, issuedAtMs + 1),
    /Registry signature is invalid/,
  );
  assert.throws(
    () => verifySignedRegistry(registryPath, rootKeyPath, expiresAtMs),
    /Registry has expired/,
  );

  const duplicateDescriptorPath = path.join(root, 'releases-duplicate.json');
  const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
  descriptor.releases.push({ ...descriptor.releases[0] });
  writeJson(duplicateDescriptorPath, descriptor);
  assert.throws(
    () => buildSignedRegistryFromFile({
      descriptorPath: duplicateDescriptorPath,
      keyPath: rootKeyPath,
      outputPath: path.join(root, 'registry-duplicate.json'),
      version: 8,
      issuedAtMs,
      expiresAtMs,
    }),
    /Duplicate registry release/,
  );

  const revokedRegistryPath = path.join(root, 'registry-revoked.json');
  writeJson(descriptorPath, {
    releases: [],
    revocations: [{
      kind: 'publisherKey',
      publisher: 'dev.example',
      keyId: publisherKey.keyId,
      revokedAtMs: issuedAtMs - 1,
      reason: 'Publisher rotated a compromised release key.',
    }, {
      kind: 'pluginRelease',
      packagePath: './signed',
      revokedAtMs: issuedAtMs - 1,
      reason: 'This exact release must no longer activate.',
    }],
  });
  const revoked = buildSignedRegistryFromFile({
    descriptorPath,
    keyPath: rootKeyPath,
    outputPath: revokedRegistryPath,
    version: 9,
    issuedAtMs,
    expiresAtMs,
  });
  assert.equal(revoked.pluginCount, 0);
  assert.equal(revoked.revocationCount, 2);
  const revokedEnvelope = JSON.parse(fs.readFileSync(revokedRegistryPath, 'utf8'));
  const releaseRevocation = revokedEnvelope.signed.revocations.find(item => item.kind === 'pluginRelease');
  assert.equal(releaseRevocation.pluginId, 'dev.example.registry-test');
  assert.ok(revokedEnvelope.signed.revocations.some(item => item.kind === 'publisherKey'));
  assert.equal(
    verifySignedRegistry(revokedRegistryPath, rootKeyPath, issuedAtMs + 1).revocationCount,
    2,
  );

  fs.writeFileSync(path.join(signed, 'worker.js'), 'tampered\n');
  assert.throws(
    () => buildSignedRegistryFromFile({
      descriptorPath,
      keyPath: rootKeyPath,
      outputPath: path.join(root, 'registry-package-tampered.json'),
      version: 9,
      issuedAtMs,
      expiresAtMs,
    }),
    /integrity verification failed/,
  );
  console.log('Plugin registry signing tool tests passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
