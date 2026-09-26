#!/usr/bin/env node
import {
  generatePublisherKey,
  signPluginDirectory,
  verifySignedPlugin,
} from './package-signing.mjs';
import {
  buildSignedRegistryFromFile,
  generateRegistryRootKey,
  verifySignedRegistry,
} from './registry-signing.mjs';
import { checkPublishedRegistry } from './registry-release-check.mjs';

function options(args) {
  const parsed = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith('--') || !value) throw new Error(`Invalid option: ${name ?? ''}`);
    parsed.set(name.slice(2), value);
  }
  return parsed;
}

function required(parsed, name) {
  const value = parsed.get(name);
  if (!value) throw new Error(`Missing required option --${name}`);
  return value;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function timestamp(value, label) {
  const numeric = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    throw new Error(`${label} must be milliseconds since Unix epoch or an ISO date`);
  }
  return numeric;
}

function usage() {
  return [
    'Zync plugin signing tool',
    '',
    'Generate a publisher key:',
    '  npm run plugin:keygen -- --publisher dev.example --out C:\\safe\\publisher-key.json',
    '',
    'Create a signed plugin folder:',
    '  npm run plugin:sign -- --source ./my-plugin --key C:\\safe\\publisher-key.json --out ./dist/my-plugin-signed',
    '',
    'Verify a signed plugin folder:',
    '  npm run plugin:verify -- --source ./dist/my-plugin-signed',
    '',
    'Generate an offline marketplace root key:',
    '  npm run plugin:registry-keygen -- --out C:\\safe\\registry-root-key.json',
    '',
    'Build signed marketplace metadata:',
    '  npm run plugin:registry-build -- --releases ./registry-releases.json --key C:\\safe\\registry-root-key.json --version 1 --expires-at 2026-12-31T00:00:00Z --out ./dist/registry.json',
    '',
    'Verify signed marketplace metadata:',
    '  npm run plugin:registry-verify -- --registry ./dist/registry.json --key C:\\safe\\registry-root-key.json',
    '',
    'Check a published staging or production registry:',
    '  npm run plugin:registry-check -- --url https://plugins.example.com/registry.json --root-keys BASE64_PUBLIC_KEY --minimum-version 1',
  ].join('\n');
}

try {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || rest.includes('--help')) {
    console.log(usage());
    process.exit(0);
  }
  const parsed = options(rest);
  if (command === 'keygen') {
    const result = generatePublisherKey(required(parsed, 'publisher'), required(parsed, 'out'));
    console.log(`Publisher key created: ${result.outputPath}`);
    console.log(`Key fingerprint: ${result.keyId}`);
    console.log('Keep this file private and backed up. Never place it inside a plugin folder.');
  } else if (command === 'sign') {
    const result = signPluginDirectory(
      required(parsed, 'source'),
      required(parsed, 'key'),
      required(parsed, 'out'),
    );
    console.log(`Signed ${result.pluginId}: ${result.outputPath}`);
    console.log(`Key fingerprint: ${result.keyId}`);
  } else if (command === 'verify') {
    const result = verifySignedPlugin(required(parsed, 'source'));
    console.log(`Valid signature: ${result.pluginId}`);
    console.log(`Publisher: ${result.publisher}`);
    console.log(`Key fingerprint: ${result.keyId}`);
  } else if (command === 'registry-keygen') {
    const result = generateRegistryRootKey(required(parsed, 'out'));
    console.log(`Registry root key created: ${result.outputPath}`);
    console.log(`Key fingerprint: ${result.keyId}`);
    console.log(`Release public key: ${result.publicKey}`);
    console.log('Keep the key file offline, private, and backed up. Release builds need only the public key.');
  } else if (command === 'registry-build') {
    const result = buildSignedRegistryFromFile({
      descriptorPath: required(parsed, 'releases'),
      keyPath: required(parsed, 'key'),
      outputPath: required(parsed, 'out'),
      version: positiveInteger(required(parsed, 'version'), 'Registry version'),
      issuedAtMs: parsed.has('issued-at')
        ? timestamp(required(parsed, 'issued-at'), 'Registry issue time')
        : Date.now(),
      expiresAtMs: timestamp(required(parsed, 'expires-at'), 'Registry expiry time'),
    });
    console.log(`Signed registry created: ${result.outputPath}`);
    console.log(`Registry version: ${result.version}`);
    console.log(`Plugin releases: ${result.pluginCount}`);
    console.log(`Revocations: ${result.revocationCount}`);
    console.log(`Root key fingerprint: ${result.keyId}`);
  } else if (command === 'registry-verify') {
    const result = verifySignedRegistry(
      required(parsed, 'registry'),
      required(parsed, 'key'),
      parsed.has('at') ? timestamp(required(parsed, 'at'), 'Verification time') : Date.now(),
    );
    console.log(`Valid registry version: ${result.version}`);
    console.log(`Plugin releases: ${result.pluginCount}`);
    console.log(`Revocations: ${result.revocationCount}`);
    console.log(`Root key fingerprint: ${result.keyId}`);
  } else if (command === 'registry-check') {
    const minimumValidityHours = parsed.has('min-valid-for-hours')
      ? positiveInteger(required(parsed, 'min-valid-for-hours'), 'Minimum validity hours')
      : 24;
    const result = await checkPublishedRegistry({
      registryUrl: required(parsed, 'url'),
      trustedRootPublicKeys: required(parsed, 'root-keys'),
      minimumVersion: parsed.has('minimum-version')
        ? positiveInteger(required(parsed, 'minimum-version'), 'Minimum registry version')
        : 1,
      minimumValidityMs: minimumValidityHours * 60 * 60 * 1_000,
    });
    console.log(`Published registry is valid: version ${result.version}`);
    console.log(`Endpoint: ${result.finalUrl}`);
    console.log(`Plugin releases: ${result.pluginCount}`);
    console.log(`Revocations: ${result.revocationCount}`);
    console.log(`Root key fingerprint: ${result.keyId}`);
    console.log(`Expires: ${new Date(result.expiresAtMs).toISOString()}`);
  } else {
    throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
