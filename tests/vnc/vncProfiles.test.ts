import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    DEFAULT_VNC_RESOLUTION,
    DEFAULT_VNC_SCALE,
    formatVncEndpoint,
    matchesVncSshHost,
    normalizeVncHost,
    normalizeVncProfiles,
    VNC_RESOLUTION_MAX_DIMENSION,
    VNC_RESOLUTION_PRESETS,
    VNC_SSH_LOOPBACK,
    validateVncProfileDraft,
    vncDestinationKey,
} from '../../src/features/vnc/domain/profile.js';

test('direct VNC profiles accept DNS, IPv4 and IPv6 without interpreting URLs or embedded ports', () => {
    for (const [input, expected] of [
        [' desktop.example.com. ', 'desktop.example.com.'],
        ['localhost', 'localhost'],
        ['192.168.0.3', '192.168.0.3'],
        ['[2001:0DB8::1]', '2001:db8::1'],
        ['::1', '::1'],
        ['::ffff:192.168.0.3', '::ffff:c0a8:3'],
    ]) {
        assert.equal(normalizeVncHost(input), expected);
    }
    for (const invalid of [
        '',
        'http://desktop.example.com',
        'desktop.example.com:5900',
        'user@desktop.example.com',
        '[::1]:5900',
        'fe80::1%eth0',
        '127.000.0.1',
        '127.1',
        '256.0.0.1',
        '2130706433',
        'desktop..example.com',
        '_desktop.local',
    ]) {
        assert.equal(normalizeVncHost(invalid), null, invalid);
    }
    assert.equal(formatVncEndpoint({ host: '::1', port: 5900 }), '[::1]:5900');
});

test('SSH profiles restore their saved route and reject malformed routes without falling back to Direct', () => {
    const ssh = { id: 'saved-ssh', host: 'ssh.example.test', port: 22, username: 'user' };
    const draft = { name: 'Desktop', host: '', port: '5901', ssh };
    const profile = validateVncProfileDraft(draft).value;
    assert.ok(profile);
    assert.equal(profile.host, VNC_SSH_LOOPBACK);
    assert.deepEqual(profile.ssh, ssh);
    assert.deepEqual(normalizeVncProfiles([{ id: 'saved-vnc', ...profile }]), [
        { id: 'saved-vnc', ...profile },
    ]);
    assert.deepEqual(
        normalizeVncProfiles([{ id: 'saved-vnc', ...profile, ssh: { ...ssh, id: 'local' } }]),
        [],
    );
    assert.equal(matchesVncSshHost(ssh, { ...ssh }), true);
    assert.equal(matchesVncSshHost(ssh, { ...ssh, username: 'other' }), false);
    assert.equal(matchesVncSshHost(ssh), false);
    assert.notEqual(vncDestinationKey(profile), vncDestinationKey({ ...profile, ssh: undefined }));
    assert.notEqual(
        vncDestinationKey(profile),
        vncDestinationKey({ ...profile, ssh: { ...ssh, port: 2222 } }),
    );
});

test('profile inputs validate names and a separate numeric port', () => {
    const draft = { name: ' Desktop ', host: 'localhost', port: '65535' };
    assert.deepEqual(validateVncProfileDraft(draft).value, {
        name: 'Desktop',
        host: 'localhost',
        port: 65535,
        resolution: DEFAULT_VNC_RESOLUTION,
        scale: DEFAULT_VNC_SCALE,
    });
    for (const port of ['', '0', '65536', '5e3', '5900.0', '+5900', '59 00']) {
        assert.ok(validateVncProfileDraft({ ...draft, port }).errors?.port, port);
    }
    assert.ok(validateVncProfileDraft({ ...draft, name: ' ' }).errors?.name);
});

test('VNC profiles retain only a valid stable Vault reference', () => {
    const draft = { name: 'Desktop', host: 'localhost', port: '5900' };
    const credentialId = 'vnc.office:password-1';
    const withReference = validateVncProfileDraft({ ...draft, credentialId: ` ${credentialId} ` });
    assert.equal(withReference.value?.credentialId, credentialId);
    assert.equal(validateVncProfileDraft(draft).value?.credentialId, undefined);
    for (const invalid of ['', 'x y', 'https://other.test/', 'x\nother', 'a'.repeat(129)]) {
        assert.ok(
            validateVncProfileDraft({ ...draft, credentialId: invalid }).errors?.credentialId,
        );
    }

    const [linked, malformed] = normalizeVncProfiles([
        {
            ...withReference.value,
            id: 'linked',
            password: 'discarded',
            itemId: 'transient-vault-row',
        },
        { ...withReference.value, id: 'malformed', credentialId: { password: 'discarded' } },
    ]);
    assert.deepEqual(linked, { ...withReference.value, id: 'linked' });
    assert.equal(malformed.host, 'localhost');
    assert.equal(malformed.credentialId, undefined);
});

test('preset and custom dimensions are saved as the same fixed request with independent viewer scale', () => {
    const endpoint = { name: 'Desktop', host: 'localhost', port: '5900' };
    for (const { width, height } of [...VNC_RESOLUTION_PRESETS, { width: 5120, height: 1440 }]) {
        const result = validateVncProfileDraft({
            ...endpoint,
            resolution: { mode: 'fixed', width: String(width), height: String(height) },
            scale: 125,
        });
        assert.deepEqual(result.value?.resolution, { mode: 'fixed', width, height });
        assert.equal(result.value?.scale, 125);
    }
    assert.deepEqual(
        validateVncProfileDraft({ ...endpoint, resolution: { mode: 'auto' } }).value?.resolution,
        { mode: 'auto' },
    );
});

test('custom resolution validates whole dimensions and bounds the total framebuffer request', () => {
    const endpoint = { name: 'Desktop', host: 'localhost', port: '5900' };
    for (const width of ['', '0', '-1', '1.5', '5e3', String(VNC_RESOLUTION_MAX_DIMENSION + 1)]) {
        const invalid = validateVncProfileDraft({
            ...endpoint,
            resolution: { mode: 'fixed', width, height: '1080' },
        });
        assert.ok(invalid.errors?.width, width);
    }
    assert.ok(
        validateVncProfileDraft({
            ...endpoint,
            resolution: { mode: 'fixed', width: '1920', height: 'bad' },
        }).errors?.height,
    );
    assert.ok(
        validateVncProfileDraft({
            ...endpoint,
            resolution: { mode: 'fixed', width: '8192', height: '8192' },
        }).errors?.resolution,
    );
    assert.deepEqual(
        validateVncProfileDraft({
            ...endpoint,
            resolution: { mode: 'fixed', width: '4096', height: '2160' },
        }).value?.resolution,
        { mode: 'fixed', width: 4096, height: 2160 },
    );
});

test('loading settings retains only valid device metadata and removes credentials and duplicate IDs', () => {
    const first = { id: 'one', name: 'First', host: 'host.local', port: 5900 };
    const second = { id: 'two', name: 'Desk', host: '::1', port: 5901 };
    assert.deepEqual(normalizeVncProfiles(undefined), []);
    assert.deepEqual(
        normalizeVncProfiles([
            first,
            null,
            { ...first, id: 'bad host', host: 'ws://example.com' },
            { ...first, id: 'bad-port', port: '5900' },
            {
                ...first,
                name: 'Renamed',
                autoResize: 'false',
                password: 'discarded',
                connectionId: 'unrelated-ssh',
            },
            { ...second, host: '[::1]', autoResize: false, credential: 'discarded' },
        ]),
        [
            { ...first, name: 'Renamed', resolution: { mode: 'auto' }, scale: 'fit' },
            { ...second, resolution: { mode: 'server' }, scale: 'fit' },
        ],
    );
});

test('stored profiles migrate prior auto-resize and retain usable endpoints with invalid display settings', () => {
    const endpoint = { name: 'Desktop', host: 'localhost', port: 5900 };
    assert.deepEqual(
        normalizeVncProfiles([
            { ...endpoint, id: 'implicit-auto' },
            { ...endpoint, id: 'explicit-auto', autoResize: true },
            { ...endpoint, id: 'legacy-server', autoResize: false },
            {
                ...endpoint,
                id: 'fixed',
                autoResize: true,
                resolution: { mode: 'fixed', width: 1600, height: 900, password: 'discarded' },
                scale: 100,
            },
            {
                ...endpoint,
                id: 'malformed',
                resolution: { mode: 'fixed', width: 8192, height: 8192 },
                scale: '100',
            },
        ]),
        [
            { ...endpoint, id: 'implicit-auto', resolution: { mode: 'auto' }, scale: 'fit' },
            { ...endpoint, id: 'explicit-auto', resolution: { mode: 'auto' }, scale: 'fit' },
            { ...endpoint, id: 'legacy-server', resolution: { mode: 'server' }, scale: 'fit' },
            {
                ...endpoint,
                id: 'fixed',
                resolution: { mode: 'fixed', width: 1600, height: 900 },
                scale: 100,
            },
            {
                ...endpoint,
                id: 'malformed',
                resolution: DEFAULT_VNC_RESOLUTION,
                scale: DEFAULT_VNC_SCALE,
            },
        ],
    );
});
