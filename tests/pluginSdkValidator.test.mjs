import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { knownPermissionIds, pluginApiVersion, validateManifest, validatePackageDirectory } from '../packages/plugin-sdk/validate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demo = path.join(root, 'tests', 'fixtures', 'plugins', 'manifest-v2-demo');
const base = JSON.parse(fs.readFileSync(path.join(demo, 'manifest.json'), 'utf8'));
const clone = value => structuredClone(value);
const messages = result => result.issues.map(issue => `${issue.path}: ${issue.message}`).join('\n');

assert.equal(validateManifest(base).valid, true, messages(validateManifest(base)));
assert.equal(validatePackageDirectory(demo).valid, true, messages(validatePackageDirectory(demo)));
assert.equal(validateManifest(base, { zyncVersion: '2.32.2' }).valid, true);
assert.equal(pluginApiVersion, '2.1.0');
const sshCommandManifest = clone(base);
sshCommandManifest.engines.pluginApi = '^2.1.0';
assert.equal(validateManifest(sshCommandManifest, { pluginApiVersion: '2.0.0' }).valid, false);
assert.equal(validateManifest(sshCommandManifest).valid, true);
const nativeManifestSource = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'plugins', 'manifest', 'mod.rs'), 'utf8');
assert.match(nativeManifestSource, new RegExp(`PLUGIN_API_VERSION: &str = "${pluginApiVersion.replaceAll('.', '\\.')}"`));
for (const [target, expectedPath] of [
  [{ zyncVersion: '2.31.9' }, 'engines.zync'],
  [{ zyncVersion: 'not-a-version' }, 'engines.zync'],
  [{ pluginApiVersion: '3.0.0' }, 'engines.pluginApi'],
]) {
  const result = validateManifest(base, target);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(issue => issue.path === expectedPath), messages(result));
}

const catalog = JSON.parse(fs.readFileSync(path.join(root, 'plugin-api', 'permissions.json'), 'utf8'));
assert.deepEqual([...knownPermissionIds].sort(), catalog.map(item => item.id).sort(), 'SDK catalog must track host permissions');

const cases = [
  ['manifest version', value => { value.manifestVersion = 1; }, 'manifestVersion'],
  ['version', value => { value.version = '01.0.0'; }, 'version'],
  ['prerelease version', value => { value.version = '1.0.0-beta.01'; }, 'version'],
  ['publisher namespace', value => { value.id = 'other.hello'; }, 'id'],
  ['missing engine', value => { delete value.engines.pluginApi; }, 'engines.pluginApi'],
  ['unsupported engine syntax', value => { value.engines.pluginApi = '^2.0.0 || ^3.0.0'; }, 'engines.pluginApi'],
  ['unknown required permission', value => { value.permissions.required[0].id = 'vault.secret.read'; }, 'permissions.required[0].id'],
  ['duplicate permission', value => { value.permissions.optional.push(clone(value.permissions.required[0])); }, 'permissions.optional'],
  ['undeclared contribution permission', value => { value.permissions.required = value.permissions.required.filter(item => item.id !== 'ui.pane.register'); }, 'contributes.paneKinds'],
  ['missing pane entry', value => { delete value.contributes.paneKinds[0].entry; }, 'contributes.paneKinds[0].entry'],
  ['escaping pane entry', value => { value.contributes.paneKinds[0].entry = '../secret.html'; }, 'contributes.paneKinds[0].entry'],
  ['network without hosts', value => { value.permissions.optional.find(item => item.id === 'network.fetch').hosts = []; }, 'permissions.optional'],
  ['network port smuggling', value => { value.permissions.optional.find(item => item.id === 'network.fetch').hosts = ['example.com:8080']; }, 'permissions.optional'],
  ['unknown contribution', value => { value.contributes.sidebar = []; }, 'contributes.sidebar'],
];
for (const [label, mutate, expectedPath] of cases) {
  const value = clone(base);
  mutate(value);
  const result = validateManifest(value);
  assert.equal(result.valid, false, `${label} should fail`);
  assert.ok(result.issues.some(issue => issue.path.startsWith(expectedPath)), `${label}: ${messages(result)}`);
}

const future = clone(base);
future.permissions.optional.push({ id: 'future.capability', reason: 'Forward-compatible access.' });
const futureResult = validateManifest(future);
assert.equal(futureResult.valid, true);
assert.ok(futureResult.issues.some(issue => issue.severity === 'warning'));

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'zync-plugin-validate-'));
try {
  fs.writeFileSync(path.join(fixture, 'manifest.json'), JSON.stringify(base));
  let result = validatePackageDirectory(fixture);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(issue => issue.message.includes('Referenced file is missing')));
  fs.mkdirSync(path.join(fixture, 'ui'));
  fs.writeFileSync(path.join(fixture, 'ui', 'counter.html'), '<p>Counter</p>');
  fs.writeFileSync(path.join(fixture, 'worker.js'), '');
  result = validatePackageDirectory(fixture);
  assert.equal(result.valid, true, messages(result));

  const command = spawnSync(process.execPath, [path.join(root, 'packages', 'plugin-sdk', 'bin', 'zync-plugin.mjs'), 'validate', fixture], { encoding: 'utf8' });
  assert.equal(command.status, 0, command.stderr);
  assert.match(command.stdout, /preflight passed/i);
  const incompatibleCommand = spawnSync(process.execPath, [path.join(root, 'packages', 'plugin-sdk', 'bin', 'zync-plugin.mjs'), 'validate', fixture, '--zync-version', '2.31.9'], { encoding: 'utf8' });
  assert.equal(incompatibleCommand.status, 1);
  assert.match(incompatibleCommand.stderr, /engines\.zync/);

  const largeFile = path.join(fixture, 'oversized.bin');
  fs.writeFileSync(largeFile, '');
  fs.truncateSync(largeFile, 20 * 1024 * 1024 + 1);
  const oversized = validatePackageDirectory(fixture);
  assert.equal(oversized.valid, false);
  assert.ok(oversized.issues.some(issue => issue.path === 'oversized.bin' && issue.message.includes('20 MiB')));
  fs.rmSync(largeFile);

  fs.writeFileSync(path.join(fixture, 'manifest.json'), '{bad json');
  const invalidCommand = spawnSync(process.execPath, [path.join(root, 'packages', 'plugin-sdk', 'bin', 'zync-plugin.mjs'), 'validate', fixture], { encoding: 'utf8' });
  assert.equal(invalidCommand.status, 1);
  assert.match(invalidCommand.stderr, /manifest\.json: Invalid JSON/);
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}

console.log('plugin SDK validator: manifest, package, catalog, and CLI checks OK');
