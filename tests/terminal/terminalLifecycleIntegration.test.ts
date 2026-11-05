import assert from 'node:assert/strict';

import type { TerminalCache } from '../../src/lib/terminal/terminalCache.js';

const SESSION = 'lifecycle-integration';
interface Payload {
    data?: string;
    generation?: number;
    termId?: string;
    rows?: number;
    cols?: number;
}
const ipcCreates: Payload[] = [];
const ipcKills: Payload[] = [];
const ipcResizes: Payload[] = [];
const ipcWrites: Payload[] = [];

async function runTest(name: string, fn: () => void | Promise<void>) {
    try {
        await fn();
        console.log(`  ok ${name}`);
    } catch (error) {
        console.error(`  fail ${name}`);
        throw error;
    }
}

function seedCache(overrides: Partial<TerminalCache> = {}) {
    terminalCache.set(SESSION, {
        term: {
            rows: 24,
            cols: 80,
            clear: () => {},
            reset: () => {},
            write: () => {},
        },
        fitAddon: {},
        searchAddon: {},
        generation: 1,
        spawned: false,
        starting: false,
        listenerAttached: false,
        pendingInput: '',
        inputFlushTimer: null,
        lastResize: null,
        ligaturesEnabled: false,
        ...overrides,
    } as TerminalCache);
}

globalThis.window = {
    ipcRenderer: {
        invoke: (channel: string, payload: Payload) => {
            if (channel === 'terminal:write') {
                ipcWrites.push(payload);
            } else if (channel === 'terminal:resize') {
                ipcResizes.push(payload);
            } else {
                ipcCreates.push(payload);
            }
            return Promise.resolve();
        },
        send: (channel: string, payload: Payload) => {
            if (channel === 'terminal:kill') {
                ipcKills.push(payload);
            }
            if (channel === 'terminal:resize') {
                ipcResizes.push(payload);
            }
            if (channel === 'terminal:write') {
                ipcWrites.push(payload);
            }
        },
    },
    setTimeout,
    clearTimeout,
} as unknown as Window & typeof globalThis;

const { spawnTerminalSession, suspendTerminalPty } = await import(
    '../../src/lib/terminal/ptyLifecycle.js'
);
const { handleTerminalReady, queueTerminalInput } = await import(
    '../../src/lib/terminal/inputPipeline.js'
);
const { syncTerminalResize } = await import('../../src/lib/terminal/terminalResizeSync.js');
const { terminalCache } = await import('../../src/lib/terminal/terminalCache.js');

await runTest('spawn → ready → resize → suspend → respawn generation chain', async () => {
    terminalCache.clear();
    ipcCreates.length = 0;
    ipcKills.length = 0;
    ipcResizes.length = 0;
    ipcWrites.length = 0;
    seedCache();

    const term = terminalCache.get(SESSION)!.term;

    assert.equal(spawnTerminalSession({ termId: SESSION, connectionId: 'local', term }), true);
    assert.equal(terminalCache.get(SESSION)!.generation, 2);
    assert.equal(terminalCache.get(SESSION)!.starting, true);

    queueTerminalInput(SESSION, 'ls\r');
    assert.equal(ipcWrites.length, 0);

    assert.equal(handleTerminalReady(SESSION, 2), true);
    assert.equal(terminalCache.get(SESSION)!.starting, false);
    assert.equal(ipcWrites.length, 0, 'ready-gated input awaits geometry');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(ipcWrites.length, 1);
    assert.equal(ipcWrites[0].data, 'ls\r');

    syncTerminalResize(SESSION, term);
    assert.equal(ipcResizes.length, 1);
    assert.deepEqual(ipcResizes[0], {
        termId: SESSION,
        rows: 24,
        cols: 80,
        generation: 2,
        channelId: 0,
    });

    syncTerminalResize(SESSION, term);
    assert.equal(ipcResizes.length, 1, 'duplicate resize is deduped');

    suspendTerminalPty(SESSION, { panelHide: true });
    assert.equal(terminalCache.get(SESSION)!.generation, 3);
    assert.equal(terminalCache.get(SESSION)!.spawned, false);
    assert.equal(ipcKills.length, 1);

    assert.equal(handleTerminalReady(SESSION, 2), false, 'stale ready after suspend');

    assert.equal(spawnTerminalSession({ termId: SESSION, connectionId: 'local', term }), true);
    assert.equal(terminalCache.get(SESSION)!.generation, 4);
    assert.equal(ipcCreates[1].generation, 4);
});

console.log('Terminal lifecycle integration tests passed.');

const { attachTerminalLifecycleListeners } = await import(
    '../../src/lib/terminal/terminalLifecycleListeners.js'
);
await runTest(
    'late listener registration cannot attach to a replacement terminal owner',
    async () => {
        seedCache();
        const original = terminalCache.get(SESSION)!;
        const pending: Array<(cleanup: () => void) => void> = [];
        const handlers: Array<(event: { payload: { generation: number } }) => void> = [];
        let released = 0;
        const register = ((_name: string, callback: (typeof handlers)[number]) => {
            handlers.push(callback);
            return new Promise<() => void>((resolve) => pending.push(resolve));
        }) as typeof import('@tauri-apps/api/event').listen;
        attachTerminalLifecycleListeners(SESSION, original.term, register);
        seedCache({ generation: original.generation, spawned: true });
        const replacement = terminalCache.get(SESSION)!;
        for (const resolve of pending) {
            resolve(() => {
                released++;
            });
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        for (const handler of handlers) {
            handler({ payload: { generation: replacement.generation } });
        }
        assert.equal(released, 2);
        assert.equal(replacement.unlisten?.length ?? 0, 0);
        assert.equal(replacement.spawned, true);
        terminalCache.delete(SESSION);
    },
);
await runTest(
    'closing a terminal before native registration resolves releases both listeners',
    async () => {
        seedCache();
        const pending: Array<(cleanup: () => void) => void> = [];
        let released = 0;
        const register = (() =>
            new Promise<() => void>((resolve) =>
                pending.push(resolve),
            )) as typeof import('@tauri-apps/api/event').listen;
        attachTerminalLifecycleListeners(SESSION, terminalCache.get(SESSION)!.term, register);
        terminalCache.delete(SESSION);
        for (const resolve of pending) {
            resolve(() => {
                released++;
            });
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(released, 2);
    },
);
