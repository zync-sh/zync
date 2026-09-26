import assert from 'node:assert/strict';
import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const assetProtocol = config.app?.security?.assetProtocol;
const csp = config.app?.security?.csp;
const devCsp = config.app?.security?.devCsp;
const disabledCspModification = config.app?.security?.dangerousDisableAssetCspModification;

assert.equal(assetProtocol?.enable, true);
assert.deepEqual(assetProtocol.scope, ['$APPCONFIG/plugins/**/*']);
assert.equal(assetProtocol.scope.some((entry) => entry === '**' || entry === '**/*'), false);

console.log('  ok Tauri asset protocol is limited to installed plugin assets');

for (const [name, policy] of [['production', csp], ['development', devCsp]]) {
  assert.equal(typeof policy, 'object', `${name} CSP must be configured`);
  assert.equal(policy['object-src'], "'none'");
  assert.equal(policy['base-uri'], "'none'");
  assert.equal(policy['form-action'], "'none'");
  assert.match(policy['worker-src'], /\bblob:/);
  assert.deepEqual(
    policy['script-src'].split(/\s+/),
    ["'self'", "'unsafe-inline'", 'asset:', 'http://asset.localhost'],
  );
  assert.deepEqual(policy['frame-src'].split(/\s+/), ["'self'", 'about:']);
}

assert.doesNotMatch(csp['connect-src'], /\s\*|wss?:/);
assert.match(devCsp['connect-src'], /ws:\/\/localhost:\*/);
assert.deepEqual(
  disabledCspModification,
  ['script-src'],
  'only script-src hash injection may be disabled for sandboxed srcDoc plugin compatibility',
);

console.log('  ok Tauri app CSP blocks remote scripts, frames, objects, and form submission');
