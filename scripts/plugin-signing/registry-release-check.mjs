import {
  MAX_REGISTRY_BYTES,
  validateTrustedRootPublicKeys,
  verifySignedRegistryBytes,
} from './registry-signing.mjs';

const MAX_REGISTRY_REDIRECTS = 3;

export async function checkPublishedRegistry({
  registryUrl,
  trustedRootPublicKeys,
  minimumVersion = 1,
  minimumValidityMs = 24 * 60 * 60 * 1_000,
  currentTimeMs = Date.now(),
  fetchImpl = globalThis.fetch,
}) {
  positiveInteger(minimumVersion, 'Minimum registry version');
  if (!Number.isSafeInteger(minimumValidityMs) || minimumValidityMs < 0) {
    throw new Error('Minimum registry validity must be a non-negative integer');
  }
  if (typeof fetchImpl !== 'function') throw new Error('Registry check requires fetch support');
  validateTrustedRootPublicKeys(trustedRootPublicKeys);

  let currentUrl = httpsUrl(registryUrl, 'Registry URL');
  let redirects = 0;
  let response;
  while (true) {
    response = await fetchImpl(currentUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status < 300 || response.status >= 400) break;
    if (redirects >= MAX_REGISTRY_REDIRECTS) throw new Error('Registry endpoint redirected too many times');
    const location = response.headers.get('location');
    if (!location) throw new Error('Registry endpoint returned a redirect without a location');
    currentUrl = httpsUrl(new URL(location, currentUrl).href, 'Registry redirect');
    redirects += 1;
  }
  if (!response.ok) throw new Error(`Registry endpoint returned HTTP ${response.status}`);

  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new Error('Registry endpoint returned an invalid Content-Length');
    }
    if (parsedLength > MAX_REGISTRY_BYTES) throw new Error('Registry endpoint exceeds 2 MiB');
  }
  const bytes = await readBoundedResponseBody(response);
  const verified = verifySignedRegistryBytes(bytes, trustedRootPublicKeys, currentTimeMs);
  if (verified.version < minimumVersion) {
    throw new Error(`Registry version ${verified.version} is below required version ${minimumVersion}`);
  }
  if (verified.expiresAtMs - currentTimeMs < minimumValidityMs) {
    throw new Error('Registry expires before the required release validation window');
  }
  return {
    ...verified,
    finalUrl: currentUrl.href,
    redirects,
    bytes: bytes.length,
  };
}

function httpsUrl(value, label) {
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

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

async function readBoundedResponseBody(response) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REGISTRY_BYTES) {
        await reader.cancel('Registry response exceeded its size limit');
        throw new Error('Registry endpoint exceeds 2 MiB');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}
