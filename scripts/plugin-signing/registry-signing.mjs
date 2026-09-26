import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { verifySignedPlugin } from './package-signing.mjs';

const REGISTRY_TYPE = 'zync.plugin-registry';
const REGISTRY_DOMAIN = 'zync-plugin-registry-v1\n';
const ROOT_KEY_PURPOSE = 'zync-plugin-registry-root';
export const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 2_048;
const MAX_TRUSTED_ROOT_KEYS = 4;

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function toStandardBase64(base64Url) {
  return Buffer.from(base64Url, 'base64url').toString('base64');
}

function toBase64Url(base64) {
  return Buffer.from(base64, 'base64').toString('base64url');
}

function readJson(filePath, label, maximumBytes = 512 * 1024) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  if (stat.size > maximumBytes) throw new Error(`${label} is too large`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function assertSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function validateSha256(value, label) {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

function validateHttpsUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) {
    throw new Error(`${label} must use HTTPS without credentials or fragments`);
  }
  return url;
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Registry numbers must be safe integers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  throw new Error('Registry metadata contains an unsupported value');
}

function loadRootKey(keyPath, requirePrivate) {
  const key = readJson(path.resolve(keyPath), 'Registry root key');
  if (key.version !== 1 || key.algorithm !== 'ed25519' || key.purpose !== ROOT_KEY_PURPOSE) {
    throw new Error('Unsupported registry root key format');
  }
  const publicBytes = Buffer.from(key.publicKey ?? '', 'base64');
  if (publicBytes.length !== 32 || key.keyId !== sha256(publicBytes)) {
    throw new Error('Registry root key fingerprint is invalid');
  }
  if (requirePrivate && Buffer.from(key.privateKey ?? '', 'base64').length !== 32) {
    throw new Error('Registry root key does not contain a valid private key');
  }
  return key;
}

function privateKeyFromRecord(key) {
  return createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: toBase64Url(key.publicKey),
      d: toBase64Url(key.privateKey),
    },
    format: 'jwk',
  });
}

function publicKeyFromRecord(key) {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: toBase64Url(key.publicKey) },
    format: 'jwk',
  });
}

function trustedRootRecords(value) {
  const encoded = String(value ?? '')
    .split(',')
    .map(candidate => candidate.trim())
    .filter(Boolean);
  if (encoded.length === 0 || encoded.length > MAX_TRUSTED_ROOT_KEYS) {
    throw new Error(`Trusted registry must configure between 1 and ${MAX_TRUSTED_ROOT_KEYS} root keys`);
  }
  return encoded.map(publicKey => {
    const bytes = Buffer.from(publicKey, 'base64');
    if (bytes.length !== 32 || bytes.toString('base64') !== publicKey) {
      throw new Error('Trusted registry root key must be 32 bytes of canonical base64');
    }
    return {
      publicKey,
      keyId: sha256(bytes),
    };
  });
}

export function validateTrustedRootPublicKeys(value) {
  return trustedRootRecords(value).map(key => key.keyId);
}

function packageFiles(root) {
  const files = [];
  let totalBytes = 0;

  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Plugin packages may not contain links: ${absolute}`);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Unsupported plugin package entry: ${absolute}`);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const relativeBytes = Buffer.from(relative);
      if (!relative || relative.includes('\\') || relative.startsWith('/') || relativeBytes.length > 512) {
        throw new Error(`Invalid plugin package path: ${relative}`);
      }
      if (relative.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) {
        throw new Error(`Invalid plugin package path: ${relative}`);
      }
      if (stat.size > MAX_FILE_BYTES) throw new Error(`Plugin file exceeds 20 MiB: ${relative}`);
      totalBytes += stat.size;
      if (totalBytes > MAX_PACKAGE_BYTES) throw new Error('Plugin package exceeds 100 MiB');
      files.push({ absolute, relative, relativeBytes, size: stat.size });
      if (files.length > MAX_FILES) throw new Error('Plugin package contains too many files');
    }
  }

  visit(root);
  return files.sort((left, right) => Buffer.compare(left.relativeBytes, right.relativeBytes));
}

export function digestPluginDirectory(sourcePath) {
  const root = fs.realpathSync(sourcePath);
  if (!fs.statSync(root).isDirectory()) throw new Error('Plugin package must be a directory');
  const digest = createHash('sha256');
  for (const file of packageFiles(root)) {
    const pathLength = Buffer.alloc(8);
    pathLength.writeBigUInt64LE(BigInt(file.relativeBytes.length));
    const fileLength = Buffer.alloc(8);
    fileLength.writeBigUInt64LE(BigInt(file.size));
    digest.update(pathLength);
    digest.update(file.relativeBytes);
    digest.update(fileLength);
    digest.update(fs.readFileSync(file.absolute));
  }
  return `sha256:${digest.digest('hex')}`;
}

export function generateRegistryRootKey(outputPath) {
  const output = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  if (!jwk.d || !jwk.x) throw new Error('Failed to export the generated registry key');
  const publicKey = toStandardBase64(jwk.x);
  const key = {
    version: 1,
    algorithm: 'ed25519',
    purpose: ROOT_KEY_PURPOSE,
    privateKey: toStandardBase64(jwk.d),
    publicKey,
    keyId: sha256(Buffer.from(publicKey, 'base64')),
  };
  fs.writeFileSync(output, `${JSON.stringify(key, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { outputPath: output, publicKey: key.publicKey, keyId: key.keyId };
}

function releaseFromDescriptor(descriptor, baseDirectory) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new Error('Every registry release must be an object');
  }
  const packagePath = path.resolve(baseDirectory, descriptor.packagePath ?? '');
  const verified = verifySignedPlugin(packagePath);
  const manifest = readJson(path.join(packagePath, 'manifest.json'), 'Plugin manifest');
  const signature = readJson(path.join(packagePath, 'signature.json'), 'Plugin signature');
  validateHttpsUrl(descriptor.downloadUrl, 'Plugin download URL');
  if (typeof descriptor.publisherVerified !== 'boolean') {
    throw new Error(`publisherVerified must be true or false for ${manifest.id}`);
  }
  if (verified.pluginId !== manifest.id || verified.publisher !== manifest.publisher) {
    throw new Error('Verified plugin identity does not match its manifest');
  }
  const release = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    channel: descriptor.channel ?? 'stable',
    description: descriptor.description ?? manifest.description ?? '',
    publisher: manifest.publisher,
    downloadUrl: descriptor.downloadUrl,
    packageDigest: digestPluginDirectory(packagePath),
    publisherKeyId: verified.keyId,
    publisherPublicKey: signature.publicKey,
    publisherVerified: descriptor.publisherVerified,
  };
  for (const field of ['icon', 'thumbnailUrl', 'pluginType']) {
    const value = descriptor[field] ?? (field === 'pluginType' ? manifest.type : manifest[field]);
    if (value !== undefined && value !== null) release[field] = value;
  }
  validateRegistryRelease(release);
  return release;
}

function validateRegistryRelease(release) {
  for (const field of ['id', 'name', 'version', 'publisher', 'downloadUrl', 'packageDigest', 'publisherKeyId', 'publisherPublicKey']) {
    if (typeof release[field] !== 'string' || !release[field].trim()) {
      throw new Error(`Registry release is missing ${field}`);
    }
  }
  if (!release.id.startsWith(`${release.publisher}.`)) {
    throw new Error(`Plugin id is not namespaced to its publisher: ${release.id}`);
  }
  if (typeof release.description !== 'string' || typeof release.publisherVerified !== 'boolean') {
    throw new Error(`Registry release metadata is invalid for ${release.id}`);
  }
  const channel = release.channel ?? 'stable';
  if (channel !== 'stable' && channel !== 'beta') throw new Error(`Invalid plugin release channel for ${release.id}`);
  const parsedVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(release.version);
  if (!parsedVersion || Boolean(parsedVersion[1]) !== (channel === 'beta')) {
    throw new Error(`Plugin release channel does not match version for ${release.id}`);
  }
  if (parsedVersion[1]?.split('.').some(identifier => /^0\d+$/.test(identifier))) {
    throw new Error(`Plugin release version is not valid semantic versioning for ${release.id}`);
  }
  if (channel === 'beta' && parsedVersion[1] !== 'beta' && !parsedVersion[1].startsWith('beta.')) {
    throw new Error(`Beta plugin version must use a beta prerelease suffix for ${release.id}`);
  }
  for (const field of ['icon', 'thumbnailUrl', 'pluginType']) {
    if (release[field] !== undefined && (typeof release[field] !== 'string' || !release[field].trim())) {
      throw new Error(`Registry release ${field} is invalid for ${release.id}`);
    }
  }
  validateHttpsUrl(release.downloadUrl, 'Plugin download URL');
  validateSha256(release.packageDigest, 'Package digest');
  validateSha256(release.publisherKeyId, 'Publisher key id');
  const publicBytes = Buffer.from(release.publisherPublicKey, 'base64');
  if (publicBytes.length !== 32 || sha256(publicBytes) !== release.publisherKeyId) {
    throw new Error(`Publisher key does not match its fingerprint for ${release.id}`);
  }
}

function validatePublisher(value, label = 'Publisher') {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(value)) {
    throw new Error(`${label} must be a lowercase namespaced identifier`);
  }
}

function revocationFromDescriptor(descriptor, baseDirectory, issuedAtMs) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new Error('Every registry revocation must be an object');
  }
  const revokedAtMs = descriptor.revokedAtMs;
  assertSafeInteger(revokedAtMs, 'Revocation time');
  if (revokedAtMs > issuedAtMs) throw new Error('Revocation time cannot be after the registry issue time');
  if (typeof descriptor.reason !== 'string' || !descriptor.reason.trim() || descriptor.reason.length > 500) {
    throw new Error('Revocation reason must contain between 1 and 500 characters');
  }
  if (descriptor.kind === 'publisherKey') {
    validatePublisher(descriptor.publisher, 'Revoked publisher');
    validateSha256(descriptor.keyId, 'Revoked publisher key id');
    return {
      kind: 'publisherKey',
      publisher: descriptor.publisher,
      keyId: descriptor.keyId,
      revokedAtMs,
      reason: descriptor.reason.trim(),
    };
  }
  if (descriptor.kind === 'pluginRelease') {
    const packagePath = path.resolve(baseDirectory, descriptor.packagePath ?? '');
    const verified = verifySignedPlugin(packagePath);
    const manifest = readJson(path.join(packagePath, 'manifest.json'), 'Revoked plugin manifest');
    return {
      kind: 'pluginRelease',
      publisher: verified.publisher,
      pluginId: verified.pluginId,
      version: manifest.version,
      packageDigest: digestPluginDirectory(packagePath),
      revokedAtMs,
      reason: descriptor.reason.trim(),
    };
  }
  throw new Error('Revocation kind must be publisherKey or pluginRelease');
}

function validateRegistryRevocation(revocation) {
  validatePublisher(revocation.publisher, 'Revoked publisher');
  assertSafeInteger(revocation.revokedAtMs, 'Revocation time');
  if (typeof revocation.reason !== 'string' || !revocation.reason.trim()) {
    throw new Error('Revocation reason is missing');
  }
  if (revocation.kind === 'publisherKey') {
    validateSha256(revocation.keyId, 'Revoked publisher key id');
    if (revocation.pluginId !== undefined || revocation.version !== undefined || revocation.packageDigest !== undefined) {
      throw new Error('Publisher-key revocation contains plugin release fields');
    }
    return;
  }
  if (revocation.kind === 'pluginRelease') {
    if (typeof revocation.pluginId !== 'string'
      || !revocation.pluginId.startsWith(`${revocation.publisher}.`)
      || typeof revocation.version !== 'string'
      || !revocation.version.trim()) {
      throw new Error('Plugin-release revocation identity is invalid');
    }
    validateSha256(revocation.packageDigest, 'Revoked package digest');
    if (revocation.keyId !== undefined) throw new Error('Plugin-release revocation contains a key id');
    return;
  }
  throw new Error('Registry revocation kind is invalid');
}

export function buildSignedRegistry({
  releases,
  revocations = [],
  baseDirectory = process.cwd(),
  keyPath,
  outputPath,
  version,
  issuedAtMs = Date.now(),
  expiresAtMs,
}) {
  assertSafeInteger(version, 'Registry version');
  assertSafeInteger(issuedAtMs, 'Registry issue time');
  assertSafeInteger(expiresAtMs, 'Registry expiry time');
  if (expiresAtMs <= issuedAtMs) throw new Error('Registry expiry must be after its issue time');
  if (!Array.isArray(releases) || releases.length > 10_000) {
    throw new Error('Registry releases must contain no more than 10,000 entries');
  }
  if (!Array.isArray(revocations) || revocations.length > 10_000) {
    throw new Error('Registry revocations must contain no more than 10,000 entries');
  }
  const plugins = releases.map(release => releaseFromDescriptor(release, baseDirectory));
  const seen = new Set();
  for (const plugin of plugins) {
    const identity = `${plugin.id}\0${plugin.version}`;
    if (seen.has(identity)) throw new Error(`Duplicate registry release: ${plugin.id} ${plugin.version}`);
    seen.add(identity);
  }
  plugins.sort((left, right) => (
    Buffer.compare(Buffer.from(left.id), Buffer.from(right.id))
    || Buffer.compare(Buffer.from(left.version), Buffer.from(right.version))
  ));
  const signedRevocations = revocations.map(revocation => (
    revocationFromDescriptor(revocation, baseDirectory, issuedAtMs)
  ));
  const seenRevocations = new Set();
  for (const revocation of signedRevocations) {
    validateRegistryRevocation(revocation);
    const identity = revocation.kind === 'publisherKey'
      ? `publisher-key\0${revocation.publisher}\0${revocation.keyId}`
      : `plugin-release\0${revocation.pluginId}\0${revocation.version}\0${revocation.packageDigest}`;
    if (seenRevocations.has(identity)) throw new Error('Duplicate registry revocation');
    seenRevocations.add(identity);
  }
  signedRevocations.sort((left, right) => Buffer.compare(
    Buffer.from(canonicalJson(left)),
    Buffer.from(canonicalJson(right)),
  ));

  const key = loadRootKey(keyPath, true);
  const signed = {
    _type: REGISTRY_TYPE,
    version,
    issuedAtMs,
    expiresAtMs,
    plugins,
    revocations: signedRevocations,
  };
  const signature = sign(
    null,
    Buffer.from(`${REGISTRY_DOMAIN}${canonicalJson(signed)}`),
    privateKeyFromRecord(key),
  ).toString('base64');
  const envelope = { signed, signatures: [{ keyId: key.keyId, signature }] };
  const encoded = `${JSON.stringify(envelope, null, 2)}\n`;
  if (Buffer.byteLength(encoded) > MAX_REGISTRY_BYTES) throw new Error('Signed registry exceeds 2 MiB');
  const output = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, encoded, { flag: 'wx' });
  return {
    outputPath: output,
    version,
    keyId: key.keyId,
    pluginCount: plugins.length,
    revocationCount: signedRevocations.length,
  };
}

export function buildSignedRegistryFromFile({ descriptorPath, ...options }) {
  const resolvedDescriptor = fs.realpathSync(descriptorPath);
  const descriptor = readJson(resolvedDescriptor, 'Registry release descriptor', MAX_REGISTRY_BYTES);
  if (!descriptor || typeof descriptor !== 'object' || !Array.isArray(descriptor.releases)) {
    throw new Error('Registry release descriptor must contain a releases array');
  }
  return buildSignedRegistry({
    ...options,
    releases: descriptor.releases,
    revocations: descriptor.revocations ?? [],
    baseDirectory: path.dirname(resolvedDescriptor),
  });
}

export function verifySignedRegistry(
  registryPath,
  rootKeyPath,
  currentTimeMs = Date.now(),
) {
  const key = loadRootKey(rootKeyPath, false);
  const resolved = path.resolve(registryPath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Signed registry must be a regular file');
  if (stat.size > MAX_REGISTRY_BYTES) throw new Error('Signed registry is too large');
  const bytes = fs.readFileSync(resolved);
  return verifySignedRegistryBytes(bytes, key.publicKey, currentTimeMs);
}

export function verifySignedRegistryBytes(
  bytes,
  trustedRootPublicKeys,
  currentTimeMs = Date.now(),
) {
  const encoded = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (encoded.length > MAX_REGISTRY_BYTES) throw new Error('Signed registry is too large');
  let envelope;
  try {
    envelope = JSON.parse(encoded.toString('utf8'));
  } catch (error) {
    throw new Error(`Signed registry is invalid JSON: ${error.message}`);
  }
  if (!envelope || typeof envelope !== 'object' || !Array.isArray(envelope.signatures) || envelope.signatures.length !== 1) {
    throw new Error('Signed registry must contain exactly one root signature');
  }
  const registrySignature = envelope.signatures[0];
  const key = trustedRootRecords(trustedRootPublicKeys)
    .find(candidate => candidate.keyId === registrySignature.keyId);
  if (!key) throw new Error('Registry root key is not trusted');
  const signatureBytes = Buffer.from(registrySignature.signature ?? '', 'base64');
  if (signatureBytes.length !== 64) throw new Error('Registry signature must be 64 bytes');
  const valid = verify(
    null,
    Buffer.from(`${REGISTRY_DOMAIN}${canonicalJson(envelope.signed)}`),
    publicKeyFromRecord(key),
    signatureBytes,
  );
  if (!valid) throw new Error('Registry signature is invalid');

  const payload = envelope.signed;
  if (!payload || payload._type !== REGISTRY_TYPE) throw new Error('Unsupported registry metadata');
  assertSafeInteger(payload.version, 'Registry version');
  assertSafeInteger(payload.issuedAtMs, 'Registry issue time');
  assertSafeInteger(payload.expiresAtMs, 'Registry expiry time');
  if (payload.issuedAtMs > currentTimeMs + 5 * 60 * 1_000) throw new Error('Registry is dated in the future');
  if (payload.expiresAtMs <= currentTimeMs || payload.expiresAtMs <= payload.issuedAtMs) {
    throw new Error('Registry has expired');
  }
  if (!Array.isArray(payload.plugins) || payload.plugins.length > 10_000) {
    throw new Error('Registry plugin list is invalid');
  }
  const revocations = payload.revocations ?? [];
  if (!Array.isArray(revocations) || revocations.length > 10_000) {
    throw new Error('Registry revocation list is invalid');
  }
  const seen = new Set();
  for (const plugin of payload.plugins) {
    validateRegistryRelease(plugin);
    const identity = `${plugin.id}\0${plugin.version}`;
    if (seen.has(identity)) throw new Error(`Duplicate registry release: ${plugin.id} ${plugin.version}`);
    seen.add(identity);
  }
  const seenRevocations = new Set();
  for (const revocation of revocations) {
    validateRegistryRevocation(revocation);
    if (revocation.revokedAtMs > currentTimeMs + 5 * 60 * 1_000) {
      throw new Error('Registry revocation is dated in the future');
    }
    const identity = revocation.kind === 'publisherKey'
      ? `publisher-key\0${revocation.publisher}\0${revocation.keyId}`
      : `plugin-release\0${revocation.pluginId}\0${revocation.version}\0${revocation.packageDigest}`;
    if (seenRevocations.has(identity)) throw new Error('Duplicate registry revocation');
    seenRevocations.add(identity);
  }
  return {
    version: payload.version,
    expiresAtMs: payload.expiresAtMs,
    pluginCount: payload.plugins.length,
    revocationCount: revocations.length,
    keyId: key.keyId,
  };
}
