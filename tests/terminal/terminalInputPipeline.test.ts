import assert from 'node:assert/strict';

import type { TerminalCache } from '../../src/lib/terminal/terminalCache.js';

const SESSION = 'input-pipeline-test';
/** Ordered IPC log: { channel, payload } — preserves write vs resize order. */
interface Payload {
    data?: string;
    termId?: string;
    rows?: number;
    cols?: number;
    generation?: number;
    channelId?: number;
}
const ipcCalls: Array<{ channel: string; payload: Payload }> = [];

async function runTest(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`  ok ${name}`);
    } catch (error) {
        console.error(`  fail ${name}`);
        throw error;
    }
}

function seedCache(
    overrides: Omit<Partial<TerminalCache>, 'term'> & {
        term?: Partial<TerminalCache['term']>;
    } = {},
) {
    terminalCache.set(SESSION, {
        term: { rows: 24, cols: 80 },
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
        lastResize: { rows: 24, cols: 80 },
        ligaturesEnabled: false,
        ...overrides,
    } as TerminalCache);
}

globalThis.window = {
    ipcRenderer: {
        send: (channel: string, payload: Payload) => {
            ipcCalls.push({ channel, payload });
        },
        invoke: async (channel: string, payload: Payload) => {
            ipcCalls.push({ channel, payload });
        },
    },
    setTimeout,
    clearTimeout,
} as unknown as Window & typeof globalThis;

const {
    canSendTerminalInput,
    flushPendingInput,
    handleTerminalReady,
    queueTerminalInput,
    terminalInputChunk,
    TERMINAL_INPUT_CHUNK_BYTES,
} = await import('../../src/lib/terminal/inputPipeline.js');
const { clearTerminalPendingInput, terminalCache } = await import(
    '../../src/lib/terminal/terminalCache.js'
);
const { useAppStore } = await import('../../src/store/useAppStore.js');

await runTest(
    'legacy sends keep ordered delivery and cannot cross a lazy-import owner change',
    async () => {
        const previous = window.ipcRenderer;
        const { ipcRenderer } = await import('../../src/lib/tauri-ipc.js');
        window.ipcRenderer = previous;
        try {
            terminalCache.clear();
            ipcCalls.length = 0;
            seedCache();
            ipcRenderer.send('terminal:write', { termId: SESSION, data: 'first\r' });
            ipcRenderer.send('terminal:write', { termId: SESSION, data: 'second\r' });
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(ipcCalls.map((call) => call.payload.data).join(''), 'first\rsecond\r');
            for (const change of ['generation', 'channel', 'cache']) {
                const cached = terminalCache.get(SESSION)!;
                const count = ipcCalls.length;
                ipcRenderer.send('terminal:write', { termId: SESSION, data: 'stale\r' });
                if (change === 'generation') {
                    cached.generation++;
                } else if (change === 'channel') {
                    cached.outputChannel = { id: 99 } as TerminalCache['outputChannel'];
                } else {
                    seedCache();
                }
                await new Promise<void>((resolve) => setImmediate(resolve));
                assert.equal(
                    ipcCalls.length,
                    count,
                    `${change} replacement discards delayed input`,
                );
            }
        } finally {
            window.ipcRenderer = previous;
            clearTerminalPendingInput(SESSION);
        }
    },
);

await runTest('canSendTerminalInput is false while starting', () => {
    terminalCache.clear();
    ipcCalls.length = 0;
    seedCache({ starting: true });
    assert.equal(canSendTerminalInput(SESSION), false);
});

await runTest('queueTerminalInput buffers without IPC while starting', () => {
    terminalCache.clear();
    ipcCalls.length = 0;
    seedCache({ starting: true });
    queueTerminalInput(SESSION, 'abc');
    assert.equal(terminalCache.get(SESSION)!.pendingInput, 'abc');
    assert.equal(ipcCalls.length, 0);
});

await runTest('handleTerminalReady acknowledges geometry before buffered input', async () => {
    terminalCache.clear();
    ipcCalls.length = 0;
    seedCache({
        starting: true,
        pendingInput: 'ls\r',
        generation: 2,
        term: { rows: 48, cols: 140 },
        desiredResize: { rows: 48, cols: 140 },
    });
    assert.equal(handleTerminalReady(SESSION, 2), true);
    assert.equal(terminalCache.get(SESSION)!.starting, false);
    assert.equal(ipcCalls.length, 1);
    assert.equal(ipcCalls[0].channel, 'terminal:resize');
    assert.deepEqual(ipcCalls[0].payload, { termId: SESSION, rows: 48, cols: 140 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(ipcCalls.length, 2);
    assert.equal(ipcCalls[1].channel, 'terminal:write');
    assert.equal(ipcCalls[1].payload.data, 'ls\r');
});

await runTest(
    'a paste synchronizes UI-only geometry and awaits the latest resize acknowledgment',
    async () => {
        terminalCache.clear();
        ipcCalls.length = 0;
        seedCache();
        const { syncTerminalResize } = await import('../../src/lib/terminal/terminalResizeSync.js');
        const cached = terminalCache.get(SESSION)!;
        const previous = window.ipcRenderer.invoke;
        const acknowledgments: Array<() => void> = [];
        window.ipcRenderer.invoke = (channel: string, payload: Payload) => {
            ipcCalls.push({ channel, payload });
            if (channel === 'terminal:resize') {
                return new Promise<void>((resolve) => acknowledgments.push(resolve));
            }
            return Promise.resolve();
        };
        try {
            Object.assign(cached.term, { cols: 100, rows: 30 });
            queueTerminalInput(SESSION, 'complete paste\r');
            Object.assign(cached.term, { cols: 45, rows: 15 });
            syncTerminalResize(SESSION, cached.term);
            assert.equal(ipcCalls.length, 1);
            acknowledgments.shift()!();
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.deepEqual(
                ipcCalls.map((call) => call.channel),
                ['terminal:resize', 'terminal:resize'],
            );
            acknowledgments.shift()!();
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(ipcCalls[2].channel, 'terminal:write');
            assert.equal(ipcCalls[2].payload.data, 'complete paste\r');
        } finally {
            window.ipcRenderer.invoke = previous;
            clearTerminalPendingInput(SESSION);
        }
    },
);

await runTest('an advisory resize failure does not discard a paste before writing it', async () => {
    terminalCache.clear();
    ipcCalls.length = 0;
    seedCache();
    const cached = terminalCache.get(SESSION)!;
    const previous = window.ipcRenderer.invoke;
    window.ipcRenderer.invoke = async (channel: string, payload: Payload) => {
        ipcCalls.push({ channel, payload });
        if (channel === 'terminal:resize') {
            throw new Error('fixture resize failure');
        }
    };
    try {
        Object.assign(cached.term, { cols: 100, rows: 30 });
        queueTerminalInput(SESSION, 'preserved text\r');
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(
            ipcCalls
                .filter((call) => call.channel === 'terminal:write')
                .map((call) => call.payload.data)
                .join(''),
            'preserved text\r',
        );
        assert.equal(cached.lastResize, null, 'failed geometry remains unacknowledged');
        assert.equal(cached.pendingInputBytes, 0);
    } finally {
        window.ipcRenderer.invoke = previous;
        clearTerminalPendingInput(SESSION);
    }
});

await runTest('handleTerminalReady flushes retained terminal size', async () => {
    terminalCache.clear();
    ipcCalls.length = 0;
    seedCache({
        starting: true,
        generation: 2,
        term: { rows: 50, cols: 160 },
        desiredResize: { rows: 50, cols: 160 },
        lastResize: null,
    });
    assert.equal(handleTerminalReady(SESSION, 2), true);
    const resizes = ipcCalls.filter((call) => call.channel === 'terminal:resize');
    assert.equal(resizes.length, 1);
    assert.deepEqual(resizes[0].payload, { termId: SESSION, rows: 50, cols: 160 });
    assert.equal(terminalCache.get(SESSION)!.lastResize, null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(terminalCache.get(SESSION)!.lastResize, { rows: 50, cols: 160 });
});

await runTest('handleTerminalReady clears idle-suspend guard after successful spawn', () => {
    terminalCache.clear();
    seedCache({
        starting: true,
        generation: 2,
        suspendedByIdle: true,
        idleSuspendNoticeShown: true,
    });
    assert.equal(handleTerminalReady(SESSION, 2), true);
    assert.equal(terminalCache.get(SESSION)!.suspendedByIdle, false);
    assert.equal(terminalCache.get(SESSION)!.idleSuspendNoticeShown, false);
});

await runTest('flushPendingInput is a no-op while starting', () => {
    terminalCache.clear();
    ipcCalls.length = 0;
    seedCache({ starting: true, pendingInput: 'pwd' });
    flushPendingInput(SESSION);
    assert.equal(ipcCalls.length, 0);
    assert.equal(terminalCache.get(SESSION)!.pendingInput, 'pwd');
});

await runTest('queueTerminalInput buffers without IPC when PTY is suspended', () => {
    terminalCache.clear();
    ipcCalls.length = 0;
    seedCache({ spawned: false, starting: false });
    queueTerminalInput(SESSION, 'echo');
    assert.equal(terminalCache.get(SESSION)!.pendingInput, 'echo');
    assert.equal(ipcCalls.length, 0);
});

await runTest('canSendTerminalInput is false when PTY is not spawned', () => {
    terminalCache.clear();
    seedCache({ spawned: false, starting: false });
    assert.equal(canSendTerminalInput(SESSION), false);
});

await runTest('handleTerminalReady rejects stale generation', () => {
    terminalCache.clear();
    ipcCalls.length = 0;
    seedCache({ starting: true, pendingInput: 'pwd', generation: 3 });
    assert.equal(handleTerminalReady(SESSION, 2), false);
    assert.equal(terminalCache.get(SESSION)!.starting, true);
    assert.equal(ipcCalls.length, 0);
});

await runTest('queueTerminalInput no-ops when cache entry is missing', () => {
    terminalCache.clear();
    ipcCalls.length = 0;
    queueTerminalInput(SESSION, 'echo hi');
    assert.equal(ipcCalls.length, 0);
});

console.log('Terminal input pipeline tests passed.');

await runTest(
    'large Unicode pastes use one bounded acknowledged packet and preserve following input',
    async () => {
        terminalCache.clear();
        ipcCalls.length = 0;
        seedCache();
        const acknowledge: Array<() => void> = [];
        const previous = window.ipcRenderer.invoke;
        window.ipcRenderer.invoke = (channel: string, payload: Payload) => {
            ipcCalls.push({ channel, payload });
            return new Promise<void>((resolve) => acknowledge.push(resolve));
        };
        try {
            const text = 'a界🦀\x1b[200~'.repeat(180000) + '\r\x1b[201~';
            queueTerminalInput(SESSION, text);
            queueTerminalInput(SESSION, 'next\r');
            assert.equal(ipcCalls.length, 1, 'the second packet must await native admission');
            const state = terminalCache.get(SESSION)!;
            assert.equal(
                state.inputWrite!.sources[0],
                text,
                'retain the original source, not encoded copies',
            );
            assert.equal(state.inputWrite!.sources.length, 2);
            while (state.pendingInputBytes > 0) {
                const release = acknowledge.shift();
                assert.ok(release);
                release();
                await new Promise<void>((resolve) => setImmediate(resolve));
            }
            assert.equal(ipcCalls.map((call) => call.payload.data || '').join(''), text + 'next\r');
            assert.ok(ipcCalls.length > 100);
            for (const call of ipcCalls) {
                assert.ok(
                    new TextEncoder().encode(call.payload.data).length <=
                        TERMINAL_INPUT_CHUNK_BYTES,
                );
            }
            assert.equal(state.inputWrite!.sources.length, 0);
        } finally {
            window.ipcRenderer.invoke = previous;
            clearTerminalPendingInput(SESSION);
        }
    },
);

await runTest(
    'closing reports an unsent tail without warning for a lone submitted exit packet',
    async () => {
        const previousInvoke = window.ipcRenderer.invoke;
        const previousToast = useAppStore.getState().showToast;
        const messages: string[] = [];
        useAppStore.setState({
            showToast: (_type, message) => {
                messages.push(message);
            },
        });
        try {
            for (const data of ['exit\r', 'x'.repeat(TERMINAL_INPUT_CHUNK_BYTES * 3)]) {
                terminalCache.clear();
                ipcCalls.length = 0;
                seedCache();
                let acknowledge!: () => void;
                window.ipcRenderer.invoke = () =>
                    new Promise<void>((resolve) => {
                        acknowledge = resolve;
                    });
                queueTerminalInput(SESSION, data);
                clearTerminalPendingInput(SESSION, true);
                acknowledge();
                await new Promise<void>((resolve) => setImmediate(resolve));
            }
            assert.equal(messages.length, 1);
        } finally {
            window.ipcRenderer.invoke = previousInvoke;
            useAppStore.setState({ showToast: previousToast });
            clearTerminalPendingInput(SESSION);
        }
    },
);

await runTest('UTF-8 chunk boundaries preserve surrogate pairs and control bytes', () => {
    const text = 'a'.repeat(TERMINAL_INPUT_CHUNK_BYTES - 1) + '🦀界\r\x03\x1b';
    let offset = 0;
    let joined = '';
    while (offset < text.length) {
        const packet = terminalInputChunk(text, offset);
        assert.ok(packet.bytes <= TERMINAL_INPUT_CHUNK_BYTES);
        assert.ok(packet.end > offset);
        joined += packet.data;
        offset = packet.end;
    }
    assert.equal(joined, text);
});

await runTest('UTF-8 packets preserve BOM content and exact multibyte boundaries', () => {
    const encoder = new TextEncoder();
    const characters = [
        '\u0080',
        '\u07ff',
        '\u0800',
        '\ufeff',
        '\uffff',
        '\u{10000}',
        '\u{10ffff}',
    ];
    const samples = ['\ufeffleading BOM remains content'];
    for (const character of characters) {
        const width = encoder.encode(character).length;
        for (const prefixBytes of [
            TERMINAL_INPUT_CHUNK_BYTES - width,
            TERMINAL_INPUT_CHUNK_BYTES - width + 1,
            TERMINAL_INPUT_CHUNK_BYTES,
        ]) {
            samples.push('x'.repeat(prefixBytes) + character + '\r\x1b[201~');
        }
        const exact = terminalInputChunk(
            'x'.repeat(TERMINAL_INPUT_CHUNK_BYTES - width) + character,
            0,
        );
        assert.equal(exact.bytes, TERMINAL_INPUT_CHUNK_BYTES);
    }
    for (const sample of samples) {
        let offset = 0;
        let delivered = '';
        while (offset < sample.length) {
            const packet = terminalInputChunk(sample, offset);
            assert.ok(packet.end > offset);
            assert.ok(packet.bytes <= TERMINAL_INPUT_CHUNK_BYTES);
            assert.equal(encoder.encode(packet.data).length, packet.bytes);
            delivered += packet.data;
            offset = packet.end;
        }
        assert.equal(delivered, sample);
        assert.deepEqual(encoder.encode(delivered), encoder.encode(sample));
    }
});

await runTest(
    'late acknowledgments cannot replay into a replacement owner or generation',
    async () => {
        for (const replace of [false, true]) {
            terminalCache.clear();
            ipcCalls.length = 0;
            seedCache();
            const previous = window.ipcRenderer.invoke;
            let acknowledge!: () => void;
            window.ipcRenderer.invoke = (channel: string, payload: Payload) => {
                ipcCalls.push({ channel, payload });
                return new Promise<void>((resolve) => {
                    acknowledge = resolve;
                });
            };
            try {
                queueTerminalInput(SESSION, 'x'.repeat(TERMINAL_INPUT_CHUNK_BYTES * 3));
                const old = terminalCache.get(SESSION)!;
                clearTerminalPendingInput(SESSION);
                assert.equal(old.inputWrite, undefined);
                if (replace) {
                    seedCache();
                } else {
                    old.generation++;
                }
                acknowledge();
                await new Promise<void>((resolve) => setImmediate(resolve));
                assert.equal(ipcCalls.length, 1);
                assert.equal(terminalCache.get(SESSION)!.pendingInputBytes, 0);
            } finally {
                window.ipcRenderer.invoke = previous;
                clearTerminalPendingInput(SESSION);
            }
        }
    },
);

await runTest(
    'delivery failures report uncertainty and never retry the failed packet automatically',
    async () => {
        terminalCache.clear();
        ipcCalls.length = 0;
        seedCache();
        const previous = window.ipcRenderer.invoke;
        const previousToast = useAppStore.getState().showToast;
        const messages: string[] = [];
        useAppStore.setState({
            showToast: (_type, text) => {
                messages.push(text);
            },
        });
        window.ipcRenderer.invoke = async (channel: string, payload: Payload) => {
            ipcCalls.push({ channel, payload });
            throw new Error('fixture closed writer');
        };
        try {
            queueTerminalInput(SESSION, 'private-paste'.repeat(10000));
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(ipcCalls.length, 1);
            assert.equal(messages.length, 1);
            assert.ok(!messages[0].includes('private-paste'));
            assert.equal(terminalCache.get(SESSION)!.pendingInputBytes, 0);
            queueTerminalInput(SESSION, 'never-auto-retry\r');
            assert.equal(ipcCalls.length, 1);
        } finally {
            window.ipcRenderer.invoke = previous;
            useAppStore.setState({ showToast: previousToast });
            clearTerminalPendingInput(SESSION);
        }
    },
);

await runTest(
    'large input queued before ready remains complete and carries its native owner',
    async () => {
        terminalCache.clear();
        ipcCalls.length = 0;
        seedCache({ starting: true, outputChannel: { id: 123 } as TerminalCache['outputChannel'] });
        const text = '界🦀'.repeat(70000);
        queueTerminalInput(SESSION, text);
        assert.equal(ipcCalls.length, 0);
        handleTerminalReady(SESSION, 1);
        while (terminalCache.get(SESSION)!.pendingInputBytes) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        const writes = ipcCalls.filter((call) => call.channel === 'terminal:write');
        assert.equal(writes.map((call) => call.payload.data).join(''), text);
        assert.ok(
            writes.every((call) => call.payload.generation === 1 && call.payload.channelId === 123),
        );
    },
);

await runTest(
    'short typing retains the existing batching delay and acknowledged byte accounting',
    async () => {
        terminalCache.clear();
        ipcCalls.length = 0;
        seedCache();
        queueTerminalInput(SESSION, 'abc');
        assert.equal(ipcCalls.length, 0);
        await new Promise((resolve) => setTimeout(resolve, 15));
        assert.equal(ipcCalls.length, 1);
        assert.equal(ipcCalls[0].payload.data, 'abc');
        assert.equal(terminalCache.get(SESSION)!.pendingInputBytes, 0);
    },
);
