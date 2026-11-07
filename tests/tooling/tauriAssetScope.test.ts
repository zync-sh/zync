import assert from 'node:assert/strict';
import fs from 'node:fs';

interface AppSecurityConfig {
    assetProtocol?: { enable: boolean; scope: string[] };
    csp?: Record<string, string>;
    devCsp?: Record<string, string>;
    dangerousDisableAssetCspModification?: unknown;
}

const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8')) as {
    app?: { security?: AppSecurityConfig };
};
const assetProtocol = config.app?.security?.assetProtocol;
const csp = config.app?.security?.csp;
const devCsp = config.app?.security?.devCsp;
const disabledCspModification = config.app?.security?.dangerousDisableAssetCspModification;
const cargoManifest = fs.readFileSync('src-tauri/Cargo.toml', 'utf8');
const cargoLock = fs.readFileSync('src-tauri/Cargo.lock', 'utf8');

// Tauri's Windows custom-protocol origin check was fixed in 2.11.1.
const minimumSafeTauri = [2, 11, 1];
for (const [name, source] of [
    ['requirement', cargoManifest],
    ['lockfile', cargoLock],
]) {
    const versionText =
        name === 'requirement'
            ? source.match(/^tauri = \{ version = "([^"]+)"/m)?.[1]
            : source.match(/\[\[package\]\]\s+name = "tauri"\s+version = "([^"]+)"/)?.[1];
    assert.ok(versionText, `Tauri ${name} must exist`);
    const version = versionText.split('.').map(Number);
    const isPatched =
        version.some(
            (part, index) =>
                part > minimumSafeTauri[index] &&
                version
                    .slice(0, index)
                    .every((earlier, earlierIndex) => earlier === minimumSafeTauri[earlierIndex]),
        ) || version.every((part, index) => part === minimumSafeTauri[index]);
    assert.ok(isPatched, `Tauri ${name} must include the custom-protocol origin fix`);
}

assert.equal(assetProtocol?.enable, true);
assert.ok(assetProtocol);
assert.deepEqual(assetProtocol.scope, ['$APPCONFIG/plugins/**/*']);
assert.equal(
    assetProtocol.scope.some((entry) => entry === '**' || entry === '**/*'),
    false,
);

console.log('  ok Tauri asset protocol is limited to installed plugin assets');

assert.ok(csp && devCsp);
for (const [name, policy] of [
    ['production', csp],
    ['development', devCsp],
] as const) {
    assert.equal(typeof policy, 'object', `${name} CSP must be configured`);
    assert.equal(policy['object-src'], "'none'");
    assert.equal(policy['base-uri'], "'none'");
    assert.equal(policy['form-action'], "'none'");
    assert.match(policy['worker-src'], /\bblob:/);
    assert.deepEqual(policy['script-src'].split(/\s+/), [
        "'self'",
        "'unsafe-inline'",
        'asset:',
        'http://asset.localhost',
    ]);
    assert.deepEqual(policy['frame-src'].split(/\s+/), [
        "'self'",
        'about:',
        'zync-plugin-pane:',
        'http://zync-plugin-pane.localhost',
    ]);
}

assert.doesNotMatch(csp['connect-src'], /\s\*/);
assert.deepEqual(
    csp['connect-src'].split(/\s+/).filter((entry) => /^wss?:/i.test(entry)),
    ['ws://127.0.0.1:*'],
    'production WebSockets are limited to the VNC bridge on IPv4 loopback',
);
assert.match(devCsp['connect-src'], /ws:\/\/localhost:\*/);
assert.deepEqual(
    disabledCspModification,
    ['script-src'],
    'only script-src hash injection may be disabled for sandboxed srcDoc plugin compatibility',
);

console.log('  ok Tauri app CSP blocks remote scripts, frames, objects, and form submission');
