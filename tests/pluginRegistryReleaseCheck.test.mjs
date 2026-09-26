import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildSignedRegistryFromFile,
  generateRegistryRootKey,
  verifySignedRegistryBytes,
} from '../scripts/plugin-signing/registry-signing.mjs';
import { checkPublishedRegistry } from '../scripts/plugin-signing/registry-release-check.mjs';

const now = 1_800_000_000_000;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zync-registry-release-check-'));

function json(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function fetchSequence(responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    const response = responses.shift();
    if (!response) throw new Error('Unexpected fetch');
    return response;
  };
  return { calls, fetchImpl };
}

try {
  const keyPath = path.join(root, 'root-key.json');
  const oldKeyPath = path.join(root, 'old-root-key.json');
  const descriptorPath = path.join(root, 'releases.json');
  const registryPath = path.join(root, 'registry.json');
  const currentRoot = generateRegistryRootKey(keyPath);
  const oldRoot = generateRegistryRootKey(oldKeyPath);
  json(descriptorPath, { releases: [], revocations: [] });
  buildSignedRegistryFromFile({
    descriptorPath,
    keyPath,
    outputPath: registryPath,
    version: 12,
    issuedAtMs: now - 1_000,
    expiresAtMs: now + 48 * 60 * 60 * 1_000,
  });
  const bytes = fs.readFileSync(registryPath);
  const rotatingRoots = `${oldRoot.publicKey}, ${currentRoot.publicKey}`;

  const verified = verifySignedRegistryBytes(bytes, rotatingRoots, now);
  assert.equal(verified.version, 12);
  assert.equal(verified.keyId, currentRoot.keyId);

  const direct = fetchSequence([
    new Response(bytes, {
      status: 200,
      headers: { 'content-length': String(bytes.length), 'content-type': 'application/json' },
    }),
  ]);
  const checked = await checkPublishedRegistry({
    registryUrl: 'https://staging.plugins.example.test/registry.json',
    trustedRootPublicKeys: rotatingRoots,
    minimumVersion: 12,
    minimumValidityMs: 24 * 60 * 60 * 1_000,
    currentTimeMs: now,
    fetchImpl: direct.fetchImpl,
  });
  assert.equal(checked.version, 12);
  assert.equal(checked.redirects, 0);
  assert.equal(checked.bytes, bytes.length);
  assert.equal(direct.calls[0].options.redirect, 'manual');

  const redirected = fetchSequence([
    new Response(null, { status: 302, headers: { location: '/v12/registry.json' } }),
    new Response(bytes, { status: 200 }),
  ]);
  const redirectedResult = await checkPublishedRegistry({
    registryUrl: 'https://staging.plugins.example.test/registry.json',
    trustedRootPublicKeys: currentRoot.publicKey,
    minimumVersion: 12,
    currentTimeMs: now,
    fetchImpl: redirected.fetchImpl,
  });
  assert.equal(redirectedResult.redirects, 1);
  assert.equal(redirectedResult.finalUrl, 'https://staging.plugins.example.test/v12/registry.json');

  await assert.rejects(
    checkPublishedRegistry({
      registryUrl: 'http://staging.plugins.example.test/registry.json',
      trustedRootPublicKeys: currentRoot.publicKey,
      currentTimeMs: now,
      fetchImpl: direct.fetchImpl,
    }),
    /must use HTTPS/,
  );

  const insecureRedirect = fetchSequence([
    new Response(null, { status: 302, headers: { location: 'http://plugins.example.test/registry.json' } }),
  ]);
  await assert.rejects(
    checkPublishedRegistry({
      registryUrl: 'https://staging.plugins.example.test/registry.json',
      trustedRootPublicKeys: currentRoot.publicKey,
      currentTimeMs: now,
      fetchImpl: insecureRedirect.fetchImpl,
    }),
    /must use HTTPS/,
  );

  const oversized = fetchSequence([
    new Response(null, { status: 200, headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }),
  ]);
  await assert.rejects(
    checkPublishedRegistry({
      registryUrl: 'https://staging.plugins.example.test/registry.json',
      trustedRootPublicKeys: currentRoot.publicKey,
      currentTimeMs: now,
      fetchImpl: oversized.fetchImpl,
    }),
    /exceeds 2 MiB/,
  );

  const oversizedBody = fetchSequence([
    new Response(Buffer.alloc(2 * 1024 * 1024 + 1), { status: 200 }),
  ]);
  await assert.rejects(
    checkPublishedRegistry({
      registryUrl: 'https://staging.plugins.example.test/registry.json',
      trustedRootPublicKeys: currentRoot.publicKey,
      currentTimeMs: now,
      fetchImpl: oversizedBody.fetchImpl,
    }),
    /exceeds 2 MiB/,
  );

  const staleVersion = fetchSequence([new Response(bytes, { status: 200 })]);
  await assert.rejects(
    checkPublishedRegistry({
      registryUrl: 'https://staging.plugins.example.test/registry.json',
      trustedRootPublicKeys: currentRoot.publicKey,
      minimumVersion: 13,
      currentTimeMs: now,
      fetchImpl: staleVersion.fetchImpl,
    }),
    /below required version/,
  );

  const shortValidity = fetchSequence([new Response(bytes, { status: 200 })]);
  await assert.rejects(
    checkPublishedRegistry({
      registryUrl: 'https://staging.plugins.example.test/registry.json',
      trustedRootPublicKeys: currentRoot.publicKey,
      minimumValidityMs: 72 * 60 * 60 * 1_000,
      currentTimeMs: now,
      fetchImpl: shortValidity.fetchImpl,
    }),
    /validation window/,
  );

  assert.throws(
    () => verifySignedRegistryBytes(bytes, Buffer.alloc(32, 99).toString('base64'), now),
    /root key is not trusted/,
  );

  const releaseWorkflow = fs.readFileSync(
    path.join(process.cwd(), '.github', 'workflows', 'release.yml'),
    'utf8',
  );
  const stagingWorkflow = fs.readFileSync(
    path.join(process.cwd(), '.github', 'workflows', 'plugin-registry-staging.yml'),
    'utf8',
  );
  assert.match(releaseWorkflow, /needs: plugin-registry-preflight/);
  assert.match(releaseWorkflow, /ZYNC_PLUGIN_REGISTRY_REQUIRED/);
  assert.match(releaseWorkflow, /npm run plugin:registry-check/);
  assert.match(stagingWorkflow, /environment: plugin-staging/);
  assert.match(stagingWorkflow, /cargo test --no-default-features plugins::registry::/);
  console.log('Plugin registry release preflight tests passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
