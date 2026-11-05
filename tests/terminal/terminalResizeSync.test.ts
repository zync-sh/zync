import assert from 'node:assert/strict';

import type { TerminalCache } from '../../src/lib/terminal/terminalCache.js';

const SESSION = 'resize-sync-test';
interface ResizePayload {
    termId: string;
    rows: number;
    cols: number;
    generation?: number;
    channelId?: number;
}
const ipcResizes: ResizePayload[] = [];
let resizeResult: (payload: ResizePayload) => Promise<void> = async () => {};
const originalWindow = globalThis.window;
globalThis.window = {
    ipcRenderer: {
        invoke: (channel: string, payload: ResizePayload) => {
            assert.equal(channel, 'terminal:resize');
            ipcResizes.push(payload);
            return resizeResult(payload);
        },
    },
} as unknown as Window & typeof globalThis;

const { clearTerminalResizeState, flushTerminalResize, syncTerminalResize } = await import(
    '../../src/lib/terminal/terminalResizeSync.js'
);
const { terminalCache } = await import('../../src/lib/terminal/terminalCache.js');

function terminalSize(rows: number, cols: number): TerminalCache['term'] {
    return { rows, cols } as TerminalCache['term'];
}

function currentSize(rows: number, cols: number): TerminalCache['term'] {
    const cached = terminalCache.get(SESSION);
    assert.ok(cached);
    Object.assign(cached.term, { rows, cols });
    return cached.term;
}

function seedCache(overrides: Partial<TerminalCache> = {}): TerminalCache {
    const cached = {
        term: terminalSize(24, 80),
        fitAddon: {},
        searchAddon: {},
        generation: 1,
        spawned: true,
        starting: false,
        listenerAttached: false,
        pendingInput: '',
        pendingInputBytes: 0,
        inputFlushTimer: null,
        desiredResize: null,
        lastResize: null,
        ligaturesEnabled: false,
        ...overrides,
    } as TerminalCache;
    terminalCache.set(SESSION, cached);
    return cached;
}

function deferred() {
    let resolve!: () => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<void>((complete, fail) => {
        resolve = complete;
        reject = fail;
    });
    return { promise, resolve, reject };
}

function settle(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

async function runTest(name: string, fn: () => void | Promise<void>): Promise<void> {
    terminalCache.clear();
    ipcResizes.length = 0;
    resizeResult = async () => {};
    try {
        await fn();
        console.log(`  ok ${name}`);
    } catch (error) {
        console.error(`  fail ${name}`);
        throw error;
    } finally {
        terminalCache.clear();
    }
}

try {
    await runTest('syncTerminalResize skips IPC when cache entry is missing', () => {
        syncTerminalResize(SESSION, terminalSize(24, 80));
        assert.equal(ipcResizes.length, 0);
    });

    await runTest('syncTerminalResize retains desired size while PTY is not spawned', () => {
        const cached = seedCache({ spawned: false });
        syncTerminalResize(SESSION, currentSize(40, 120));
        assert.equal(ipcResizes.length, 0);
        assert.deepEqual(cached.desiredResize, { rows: 40, cols: 120 });
    });

    await runTest('syncTerminalResize retains desired size while PTY is starting', () => {
        const cached = seedCache({ starting: true });
        syncTerminalResize(SESSION, currentSize(50, 160));
        assert.equal(ipcResizes.length, 0);
        assert.deepEqual(cached.desiredResize, { rows: 50, cols: 160 });
        assert.equal(cached.lastResize, null);
    });

    await runTest('syncTerminalResize sends IPC when PTY is live', async () => {
        const cached = seedCache();
        syncTerminalResize(SESSION, currentSize(24, 80));
        assert.equal(ipcResizes.length, 1);
        assert.deepEqual(ipcResizes[0], { termId: SESSION, rows: 24, cols: 80 });
        assert.equal(
            cached.lastResize,
            null,
            'unacknowledged geometry is not recorded as delivered',
        );
        assert.deepEqual(cached.desiredResize, { rows: 24, cols: 80 });
        await settle();
        assert.deepEqual(cached.lastResize, { rows: 24, cols: 80 });
    });

    await runTest('flushTerminalResize sends retained size after PTY becomes live', async () => {
        const cached = seedCache({
            term: terminalSize(48, 140),
            desiredResize: { rows: 48, cols: 140 },
        });
        assert.equal(flushTerminalResize(SESSION), true);
        assert.equal(ipcResizes.length, 1);
        assert.deepEqual(ipcResizes[0], { termId: SESSION, rows: 48, cols: 140 });
        assert.equal(cached.lastResize, null);
        await settle();
        assert.deepEqual(cached.lastResize, { rows: 48, cols: 140 });
    });

    await runTest('flushTerminalResize is a no-op while starting', () => {
        seedCache({
            starting: true,
            term: terminalSize(48, 140),
            desiredResize: { rows: 48, cols: 140 },
        });
        assert.equal(flushTerminalResize(SESSION), false);
        assert.equal(ipcResizes.length, 0);
    });

    await runTest('flushTerminalResize skips duplicate size', () => {
        seedCache({
            term: terminalSize(30, 100),
            lastResize: { rows: 30, cols: 100 },
            desiredResize: { rows: 30, cols: 100 },
        });
        assert.equal(flushTerminalResize(SESSION), false);
        assert.equal(ipcResizes.length, 0);
    });

    await runTest('clearTerminalResizeState resets desired and last-sent', () => {
        const cached = seedCache({
            desiredResize: { rows: 40, cols: 120 },
            lastResize: { rows: 24, cols: 80 },
        });
        clearTerminalResizeState(SESSION);
        assert.equal(cached.desiredResize, null);
        assert.equal(cached.lastResize, null);
    });

    await runTest(
        'resize bursts keep one invocation in flight and deliver only the latest size',
        async () => {
            const first = deferred();
            const latest = deferred();
            const cached = seedCache();
            resizeResult = () => (ipcResizes.length === 1 ? first.promise : latest.promise);
            syncTerminalResize(SESSION, currentSize(30, 100));
            syncTerminalResize(SESSION, currentSize(40, 120));
            syncTerminalResize(SESSION, currentSize(48, 140));
            assert.equal(ipcResizes.length, 1);
            assert.equal(cached.lastResize, null);
            assert.deepEqual(cached.desiredResize, { rows: 48, cols: 140 });
            first.resolve();
            await settle();
            assert.equal(ipcResizes.length, 2);
            assert.deepEqual(ipcResizes[1], { termId: SESSION, rows: 48, cols: 140 });
            assert.deepEqual(cached.lastResize, { rows: 30, cols: 100 });
            latest.resolve();
            await settle();
            assert.deepEqual(cached.lastResize, { rows: 48, cols: 140 });
            syncTerminalResize(SESSION, currentSize(48, 140));
            assert.equal(
                ipcResizes.length,
                2,
                'successfully acknowledged duplicates remain suppressed',
            );
        },
    );

    await runTest(
        'resizing back to an earlier acknowledged size still follows an in-flight change',
        async () => {
            const first = deferred();
            const cached = seedCache({ lastResize: { rows: 24, cols: 80 } });
            resizeResult = () => (ipcResizes.length === 1 ? first.promise : Promise.resolve());
            syncTerminalResize(SESSION, currentSize(40, 120));
            syncTerminalResize(SESSION, currentSize(24, 80));
            assert.equal(ipcResizes.length, 1);
            first.resolve();
            await settle();
            assert.equal(ipcResizes.length, 2);
            assert.deepEqual(ipcResizes[1], { termId: SESSION, rows: 24, cols: 80 });
            assert.deepEqual(cached.lastResize, { rows: 24, cols: 80 });
        },
    );

    await runTest(
        'failed admission retains desired geometry and the next sync retries it',
        async () => {
            const first = deferred();
            const cached = seedCache({ lastResize: { rows: 24, cols: 80 } });
            resizeResult = () => first.promise;
            syncTerminalResize(SESSION, currentSize(40, 120));
            first.reject(new Error('fixture resize admission failed'));
            await settle();
            assert.equal(
                cached.lastResize,
                null,
                'a failed resize leaves backend geometry uncertain',
            );
            assert.deepEqual(cached.desiredResize, { rows: 40, cols: 120 });
            resizeResult = async () => {};
            syncTerminalResize(SESSION, currentSize(40, 120));
            assert.equal(ipcResizes.length, 2);
            await settle();
            assert.deepEqual(cached.lastResize, { rows: 40, cols: 120 });
        },
    );

    await runTest('live owner identity accompanies the resize invocation', async () => {
        seedCache({ generation: 4, outputChannel: { id: 71 } as TerminalCache['outputChannel'] });
        syncTerminalResize(SESSION, currentSize(40, 120));
        assert.deepEqual(ipcResizes[0], {
            termId: SESSION,
            rows: 40,
            cols: 120,
            generation: 4,
            channelId: 71,
        });
        await settle();
    });

    await runTest(
        'failed admission still follows the newest request received while waiting',
        async () => {
            const first = deferred();
            const latest = deferred();
            const cached = seedCache({ lastResize: { rows: 24, cols: 80 } });
            resizeResult = () => (ipcResizes.length === 1 ? first.promise : latest.promise);
            syncTerminalResize(SESSION, currentSize(30, 100));
            syncTerminalResize(SESSION, currentSize(48, 140));
            first.reject(new Error('fixture superseded resize failed'));
            await settle();
            assert.equal(ipcResizes.length, 2);
            assert.deepEqual(ipcResizes[1], { termId: SESSION, rows: 48, cols: 140 });
            assert.equal(cached.lastResize, null);
            latest.resolve();
            await settle();
            assert.deepEqual(cached.lastResize, { rows: 48, cols: 140 });
        },
    );

    await runTest(
        'a rejected size change still corrects back to the earlier desired size',
        async () => {
            const first = deferred();
            const correction = deferred();
            const cached = seedCache({ lastResize: { rows: 24, cols: 80 } });
            resizeResult = () => (ipcResizes.length === 1 ? first.promise : correction.promise);
            syncTerminalResize(SESSION, currentSize(40, 120));
            syncTerminalResize(SESSION, currentSize(24, 80));
            first.reject(new Error('fixture resize outcome unknown'));
            await settle();
            assert.equal(
                ipcResizes.length,
                2,
                'the old acknowledgment cannot suppress corrective admission',
            );
            assert.deepEqual(ipcResizes[1], { termId: SESSION, rows: 24, cols: 80 });
            assert.equal(cached.lastResize, null);
            correction.resolve();
            await settle();
            assert.deepEqual(cached.lastResize, { rows: 24, cols: 80 });
        },
    );

    await runTest(
        'obsolete renderer callbacks cannot change a replacement terminal geometry',
        async () => {
            const old = seedCache({ outputChannel: { id: 71 } as TerminalCache['outputChannel'] });
            const current = seedCache({
                generation: 2,
                outputChannel: { id: 72 } as TerminalCache['outputChannel'],
            });
            Object.assign(old.term, { rows: 40, cols: 120 });
            syncTerminalResize(SESSION, old.term);
            assert.equal(ipcResizes.length, 0);
            assert.equal(current.desiredResize, null);
            syncTerminalResize(SESSION, current.term);
            assert.deepEqual(ipcResizes[0], {
                termId: SESSION,
                rows: 24,
                cols: 80,
                generation: 2,
                channelId: 72,
            });
            await settle();
        },
    );

    await runTest(
        'old resize acknowledgments cannot update a replaced generation, channel or cache',
        async () => {
            for (const replacement of ['generation', 'channel', 'cache']) {
                ipcResizes.length = 0;
                const first = deferred();
                const next = deferred();
                const old = seedCache({
                    outputChannel: { id: 71 } as TerminalCache['outputChannel'],
                });
                resizeResult = () => (ipcResizes.length === 1 ? first.promise : next.promise);
                syncTerminalResize(SESSION, currentSize(30, 100));
                let current = old;
                if (replacement === 'generation') {
                    old.generation++;
                } else if (replacement === 'channel') {
                    old.outputChannel = { id: 72 } as TerminalCache['outputChannel'];
                } else {
                    current = seedCache({
                        outputChannel: { id: 72 } as TerminalCache['outputChannel'],
                    });
                }
                syncTerminalResize(SESSION, currentSize(40, 120));
                assert.equal(ipcResizes.length, 2, `${replacement} starts a new owner queue`);
                first.resolve();
                await settle();
                assert.equal(
                    current.lastResize,
                    null,
                    `${replacement} rejects the obsolete acknowledgment`,
                );
                assert.deepEqual(current.desiredResize, { rows: 40, cols: 120 });
                next.resolve();
                await settle();
                assert.deepEqual(current.lastResize, { rows: 40, cols: 120 });
                terminalCache.clear();
            }
        },
    );

    await runTest(
        'clear invalidates a pending resize acknowledgment and allows a fresh request',
        async () => {
            const first = deferred();
            const cached = seedCache();
            resizeResult = () => first.promise;
            syncTerminalResize(SESSION, currentSize(30, 100));
            clearTerminalResizeState(SESSION);
            first.resolve();
            await settle();
            assert.equal(cached.lastResize, null);
            assert.equal(cached.desiredResize, null);
            resizeResult = async () => {};
            syncTerminalResize(SESSION, currentSize(30, 100));
            assert.equal(ipcResizes.length, 2);
            await settle();
            assert.deepEqual(cached.lastResize, { rows: 30, cols: 100 });
        },
    );
} finally {
    terminalCache.clear();
    globalThis.window = originalWindow;
}

console.log('Terminal resize sync tests passed.');
