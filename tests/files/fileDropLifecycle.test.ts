import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { listen } from '@tauri-apps/api/event';

import { registerFileDropListeners } from '../../src/hooks/useTauriFileDrop.js';

const jobs = () => new Promise<void>((resolve) => setImmediate(resolve));

test('late native drop registration is immediately released and setup stops', async () => {
    let resolve!: (unlisten: () => void) => void;
    let calls = 0;
    let releases = 0;
    const register = (() => {
        calls++;
        return new Promise<() => void>((yes) => {
            resolve = yes;
        });
    }) as typeof listen;
    const dispose = registerFileDropListeners(
        () => assert.fail('disposed drop'),
        () => assert.fail('disposed state'),
        register,
    );
    dispose();
    resolve(() => {
        releases++;
    });
    await jobs();
    assert.equal(calls, 1);
    assert.equal(releases, 1);
});

test('partial native drop setup failure unwinds every acquired listener', async (context) => {
    context.mock.method(console, 'warn', () => {});
    let calls = 0;
    let releases = 0;
    const register = (async () => {
        if (++calls === 3) {
            throw new Error('fixture registration failure');
        }
        return () => {
            releases++;
        };
    }) as typeof listen;
    const dispose = registerFileDropListeners(
        () => {},
        () => {},
        register,
    );
    await jobs();
    assert.equal(calls, 3);
    assert.equal(releases, 2);
    dispose();
    assert.equal(releases, 2);
});

test('native primary and fallback drops deliver once and disposal disables handlers', async () => {
    const handlers = new Map<string, (event: { payload: unknown }) => void>();
    let releases = 0;
    const drops: string[][] = [];
    const register = (async (name: string, handler: (event: { payload: unknown }) => void) => {
        handlers.set(name, handler);
        return () => {
            releases++;
        };
    }) as typeof listen;
    const dispose = registerFileDropListeners(
        (paths) => drops.push(paths),
        () => {},
        register,
    );
    await jobs();
    handlers.get('zync://file-drop')!({ payload: ['/fixture'] });
    handlers.get('tauri://drop')!({ payload: { paths: ['/fixture'] } });
    assert.deepEqual(drops, [['/fixture']]);
    dispose();
    handlers.get('zync://file-drop')!({ payload: ['/late'] });
    assert.equal(releases, 7);
    assert.equal(drops.length, 1);
});

test('native async cleanup failures are handled without abandoning other registrations', async (context) => {
    const warn = context.mock.method(console, 'warn', () => {});
    let releases = 0;
    const register = (async () => async () => {
        if (++releases === 1) {
            throw new Error('fixture async teardown failure');
        }
    }) as typeof listen;
    const dispose = registerFileDropListeners(
        () => {},
        () => {},
        register,
    );
    await jobs();
    dispose();
    await jobs();
    assert.equal(releases, 7);
    assert.equal(warn.mock.callCount(), 1);
});
