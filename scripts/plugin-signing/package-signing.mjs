import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const INTEGRITY_FILE = 'integrity.json';
const SIGNATURE_FILE = 'signature.json';
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 2_048;

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function toStandardBase64(base64Url) {
  return Buffer.from(base64Url, 'base64url').toString('base64');
}

function toBase64Url(base64) {
  return Buffer.from(base64, 'base64').toString('base64url');
}

function readJson(filePath, label) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  if (stat.size > 512 * 1024) throw new Error(`${label} is too large`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function validatePublisher(publisher) {
  if (typeof publisher !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(publisher)) {
    throw new Error('Publisher must be a lowercase namespaced identifier such as dev.example');
  }
}

function validateRelativePath(relativePath) {
  if (!relativePath || relativePath.length > 512 || relativePath.includes('\\') || relativePath.startsWith('/')) {
    throw new Error(`Invalid plugin package path: ${relativePath}`);
  }
  for (const part of relativePath.split('/')) {
    if (!part || part === '.' || part === '..' || part.includes(':') || /[\u0000-\u001f\u007f]/.test(part)) {
      throw new Error(`Invalid plugin package path: ${relativePath}`);
    }
  }
}

function sortedPayloadFiles(root) {
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
      validateRelativePath(relative);
      if (relative === INTEGRITY_FILE || relative === SIGNATURE_FILE) continue;
      if (stat.size > MAX_FILE_BYTES) throw new Error(`Plugin file exceeds 20 MiB: ${relative}`);
      totalBytes += stat.size;
      if (totalBytes > MAX_PACKAGE_BYTES) throw new Error('Plugin package exceeds 100 MiB');
      files.push(relative);
      if (files.length > MAX_FILES) throw new Error('Plugin package contains too many files');
    }
  }

  visit(root);
  return files.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function integrityRoot(files) {
  const hash = createHash('sha256');
  hash.update('zync-plugin-integrity-v1\n');
  for (const [relativePath, digest] of Object.entries(files)) {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(digest);
    hash.update('\n');
  }
  return `sha256:${hash.digest('hex')}`;
}

function signingPayload(metadata) {
  return `zync-plugin-signature-v1\npublisher=${metadata.publisher}\npluginId=${metadata.pluginId}\nversion=${metadata.pluginVersion}\nmanifestDigest=${metadata.manifestDigest}\nintegrityRoot=${metadata.integrityRoot}\npublishedAtMs=${metadata.publishedAtMs}\n`;
}

function assertOutside(source, candidate, label) {
  const relative = path.relative(source, candidate);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error(`${label} must be outside the plugin source directory`);
  }
}

export function generatePublisherKey(publisher, outputPath) {
  validatePublisher(publisher);
  const resolvedOutput = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  if (!jwk.d || !jwk.x) throw new Error('Failed to export the generated publisher key');
  const publicKey = toStandardBase64(jwk.x);
  const key = {
    version: 1,
    algorithm: 'ed25519',
    publisher,
    privateKey: toStandardBase64(jwk.d),
    publicKey,
    keyId: sha256(Buffer.from(publicKey, 'base64')),
  };
  fs.writeFileSync(resolvedOutput, `${JSON.stringify(key, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { publisher, keyId: key.keyId, outputPath: resolvedOutput };
}

export function signPluginDirectory(sourcePath, keyPath, outputPath, publishedAtMs = Date.now()) {
  const source = fs.realpathSync(sourcePath);
  const keyFile = fs.realpathSync(keyPath);
  const output = path.resolve(outputPath);
  if (!fs.statSync(source).isDirectory()) throw new Error('Plugin source must be a directory');
  assertOutside(source, keyFile, 'Publisher key');
  assertOutside(source, output, 'Signed output');
  if (fs.existsSync(output)) throw new Error(`Signed output already exists: ${output}`);
  if (!Number.isSafeInteger(publishedAtMs) || publishedAtMs <= 0) {
    throw new Error('Plugin release timestamp must be a positive integer');
  }

  const key = readJson(keyFile, 'Publisher key');
  validatePublisher(key.publisher);
  if (key.version !== 1 || key.algorithm !== 'ed25519') throw new Error('Unsupported publisher key format');
  const expectedKeyId = sha256(Buffer.from(key.publicKey, 'base64'));
  if (key.keyId !== expectedKeyId) throw new Error('Publisher key id does not match its public key');

  const temporary = `${output}.tmp-${randomUUID()}`;
  try {
    fs.cpSync(source, temporary, {
      recursive: true,
      errorOnExist: true,
      filter: (candidate) => {
        const relative = path.relative(source, candidate).split(path.sep).join('/');
        return relative !== INTEGRITY_FILE && relative !== SIGNATURE_FILE;
      },
    });
    const manifest = readJson(path.join(temporary, 'manifest.json'), 'Plugin manifest');
    if (manifest.publisher !== key.publisher) throw new Error('Publisher key does not match manifest publisher');
    if (typeof manifest.id !== 'string' || !manifest.id.startsWith(`${key.publisher}.`)) {
      throw new Error('Plugin id is not namespaced to the publisher key');
    }
    if (typeof manifest.version !== 'string' || !manifest.version) throw new Error('Plugin version is missing');

    const files = Object.create(null);
    for (const relative of sortedPayloadFiles(temporary)) {
      files[relative] = sha256(fs.readFileSync(path.join(temporary, relative)));
    }
    if (!files['manifest.json']) throw new Error('Plugin package is missing manifest.json');
    fs.writeFileSync(
      path.join(temporary, INTEGRITY_FILE),
      `${JSON.stringify({ version: 1, files }, null, 2)}\n`,
    );

    const metadata = {
      version: 1,
      algorithm: 'ed25519',
      publisher: key.publisher,
      pluginId: manifest.id,
      pluginVersion: manifest.version,
      keyId: key.keyId,
      publicKey: key.publicKey,
      publishedAtMs,
      manifestDigest: files['manifest.json'],
      integrityRoot: integrityRoot(files),
    };
    const privateKey = createPrivateKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: toBase64Url(key.publicKey),
        d: toBase64Url(key.privateKey),
      },
      format: 'jwk',
    });
    const signature = sign(null, Buffer.from(signingPayload(metadata)), privateKey).toString('base64');
    fs.writeFileSync(
      path.join(temporary, SIGNATURE_FILE),
      `${JSON.stringify({ ...metadata, signature }, null, 2)}\n`,
    );
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.renameSync(temporary, output);
    return { outputPath: output, pluginId: manifest.id, keyId: key.keyId };
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

export function verifySignedPlugin(sourcePath) {
  const source = fs.realpathSync(sourcePath);
  const manifest = readJson(path.join(source, 'manifest.json'), 'Plugin manifest');
  const integrity = readJson(path.join(source, INTEGRITY_FILE), 'Plugin integrity metadata');
  const signature = readJson(path.join(source, SIGNATURE_FILE), 'Plugin signature metadata');
  if (integrity.version !== 1 || signature.version !== 1 || signature.algorithm !== 'ed25519') {
    throw new Error('Unsupported signed plugin format');
  }
  const files = Object.create(null);
  for (const relative of sortedPayloadFiles(source)) {
    files[relative] = sha256(fs.readFileSync(path.join(source, relative)));
  }
  const declaredEntries = integrity.files && typeof integrity.files === 'object'
    ? Object.entries(integrity.files)
    : [];
  if (
    declaredEntries.length !== Object.keys(files).length
    || declaredEntries.some(([relative, digest]) => files[relative] !== digest)
  ) {
    throw new Error('Plugin integrity verification failed');
  }
  const root = integrityRoot(files);
  if (
    signature.publisher !== manifest.publisher
    || signature.pluginId !== manifest.id
    || signature.pluginVersion !== manifest.version
    || signature.manifestDigest !== files['manifest.json']
    || signature.integrityRoot !== root
  ) {
    throw new Error('Plugin signature identity does not match its package');
  }
  if (signature.keyId !== sha256(Buffer.from(signature.publicKey, 'base64'))) {
    throw new Error('Plugin signing key fingerprint is invalid');
  }
  const publicKey = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: toBase64Url(signature.publicKey) },
    format: 'jwk',
  });
  if (!verify(null, Buffer.from(signingPayload(signature)), publicKey, Buffer.from(signature.signature, 'base64'))) {
    throw new Error('Plugin publisher signature is invalid');
  }
  return { pluginId: manifest.id, publisher: manifest.publisher, keyId: signature.keyId };
}
