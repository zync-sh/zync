import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    acceptGhostCommand,
    commitGhostCommand,
    fetchGhostSuggestionV2,
    resolveInlineSuggestion,
} from '../../src/lib/ghostSuggestions/client.js';
import {
    ghostInputByteLength,
    MAX_GHOST_COMMAND_BYTES,
} from '../../src/lib/ghostSuggestions/inputBudget.js';
import { InputTracker } from '../../src/lib/ghostSuggestions/inputTracker.js';
import {
    bindGhostTrackerRuntime,
    handleGhostInputEvent,
} from '../../src/lib/ghostSuggestions/runtime.js';

const limit = MAX_GHOST_COMMAND_BYTES;
const flushJobs = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture() {
    const lines: string[] = [];
    const history: string[] = [];
    const accepted: string[] = [];
    const tracker = new InputTracker({
        onLineChange: (line) => lines.push(line),
        onHistoryCommit: (line) => history.push(line),
        onAccept: (suffix) => accepted.push(suffix),
        onDismiss() {},
    });
    return { tracker, lines, history, accepted };
}

test('UTF-8 admission agrees with encoding at ASCII, Unicode and surrogate boundaries', () => {
    const encoder = new TextEncoder();
    for (const text of [
        '',
        'ascii',
        '界🦀é',
        '\ud800',
        '\udfff',
        '\ufeff',
        'x'.repeat(limit),
        '界'.repeat(Math.floor(limit / 3)),
        '🦀'.repeat(limit / 4),
    ]) {
        const bytes = encoder.encode(text).byteLength;
        assert.equal(ghostInputByteLength(text), bytes);
        if (bytes) {
            assert.equal(ghostInputByteLength(text, bytes - 1), null);
        }
    }
    assert.equal(ghostInputByteLength('x'.repeat(limit + 1)), null);
    assert.equal(ghostInputByteLength('界'.repeat(Math.floor(limit / 3) + 1)), null);
});

test('large raw and bracketed pastes are forwarded without expanding them into character arrays', () => {
    for (const text of ['界🦀'.repeat(300_000), `\x1b[200~${'x'.repeat(2_000_000)}\x1b[201~`]) {
        const f = fixture();
        f.tracker.feed('echo ');
        f.tracker.setSuggestion('old suffix');
        const changes = f.lines.length;
        // A boxed fixture guards iteration without modifying global string methods.
        const monitored = Object(text) as String;
        monitored[Symbol.iterator] = () => {
            throw new Error('oversized input must bypass iterable expansion');
        };
        assert.equal(handleGhostInputEvent(monitored as unknown as string, f.tracker), false);
        assert.equal(f.tracker.getLineBuffer(), '');
        assert.equal(f.tracker.getSuggestion(), '');
        assert.equal(f.tracker.isDesynced(), true);
        assert.equal(f.lines.length, changes);
        f.tracker.feed('a later tail');
        f.tracker.feed('\x7f');
        f.tracker.feed('\r');
        assert.deepEqual(f.history, []);
        f.tracker.feed('git status');
        f.tracker.feed('\r');
        assert.deepEqual(f.history, ['git status']);
    }
});

test('cumulative tracking is byte bounded and only explicit reset keys resume it', () => {
    for (const reset of ['\r', '\x03', '\x04', '\x15']) {
        const f = fixture();
        const boundary = `echo ${'x'.repeat(limit - 5)}`;
        f.tracker.feed(boundary.slice(0, 4000));
        f.tracker.feed(boundary.slice(4000));
        assert.equal(f.tracker.getLineBuffer(), boundary);
        f.tracker.feed('界');
        assert.equal(f.tracker.getLineBuffer(), '');
        f.tracker.feed('tail');
        assert.equal(f.tracker.getLineBuffer(), '');
        f.tracker.feed(reset);
        f.tracker.feed('echo recovered');
        f.tracker.feed('\r');
        assert.deepEqual(f.history, ['echo recovered']);
    }
});

test('incremental bytes account for split surrogate pairs, backspace, reset and accepted suffixes', () => {
    const f = fixture();
    const prefix = 'x'.repeat(limit - 4);
    f.tracker.feed(prefix);
    f.tracker.feed('\ud83e');
    f.tracker.feed('\udd80');
    assert.equal(f.tracker.getLineBuffer(), `${prefix}🦀`);
    f.tracker.feed('\x7f');
    f.tracker.setSuggestion('tail');
    assert.equal(handleGhostInputEvent('\x1b[C', f.tracker), true);
    assert.deepEqual(f.accepted, ['tail']);
    assert.equal(f.tracker.getLineBuffer(), `${prefix}tail`);
    f.tracker.feed('\r');
    assert.deepEqual(f.history, [`${prefix}tail`]);
    f.tracker.feed('git ');
    f.tracker.setSuggestion('x'.repeat(limit));
    assert.equal(f.tracker.getSuggestion(), '');
    f.tracker.appendToLineBuffer('x'.repeat(limit));
    assert.equal(f.tracker.getLineBuffer(), '');
    assert.equal(f.tracker.isDesynced(), true);
});

test('large secret input never resumes inference before the existing secret-prompt recovery', () => {
    const f = fixture();
    f.tracker.enterSecretInputMode();
    f.tracker.feed('x'.repeat(limit * 10));
    f.tracker.feed('\r');
    f.tracker.feed('second secret');
    assert.equal(f.tracker.isSecretInputMode(), true);
    assert.deepEqual(f.lines, []);
    assert.deepEqual(f.history, []);
    f.tracker.exitSecretInputMode();
    f.tracker.feed('git status');
    assert.deepEqual(f.lines, ['git status']);
});

test('oversize invalidation fences an active resolver and lets ordinary suggestions recover', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture();
    const pending: Array<(suffix: string) => void> = [];
    const published: string[] = [];
    const requests: string[] = [];
    const unbind = bindGhostTrackerRuntime({
        tracker: f.tracker,
        debounceMs: 30,
        resolveInlineSuggestion: (line) => {
            requests.push(line);
            return new Promise<string>((resolve) => pending.push(resolve));
        },
        onSuggestion: (suffix) => {
            if (suffix) {
                published.push(suffix);
            }
        },
        onAccept() {},
        onHistoryCommit() {},
        onClearUI() {},
    });
    try {
        f.tracker.feed('g');
        context.mock.timers.tick(30);
        f.tracker.feed('x'.repeat(limit * 2));
        pending[0]('stale result');
        await flushJobs();
        assert.deepEqual(published, []);
        assert.deepEqual(requests, ['g']);
        f.tracker.feed('\r');
        f.tracker.feed('git ');
        context.mock.timers.tick(30);
        pending[1]('status');
        await flushJobs();
        assert.deepEqual(published, ['status']);
        f.tracker.feed('x');
        context.mock.timers.tick(30);
        pending[2]('x'.repeat(limit));
        await flushJobs();
        assert.equal(f.tracker.getSuggestion(), '');
        assert.deepEqual(
            published,
            ['status'],
            'rejected suffix cannot reach the overlay callback',
        );
    } finally {
        unbind();
    }
});

test('all Ghost client entry points skip oversized IPC and bound complete suggestion responses', async () => {
    const previous = globalThis.window;
    const calls: string[] = [];
    let response = 'status';
    globalThis.window = {
        ipcRenderer: {
            invoke: async (name: string) => {
                calls.push(name);
                return { suffix: response, confidence: 1 };
            },
        },
    } as unknown as Window & typeof globalThis;
    try {
        const oversized = '界'.repeat(limit);
        await commitGhostCommand(oversized, 'local');
        await acceptGhostCommand(oversized, 'local');
        assert.equal(
            (await fetchGhostSuggestionV2({ prefix: oversized, scope: 'local' })).suffix,
            '',
        );
        assert.equal(await resolveInlineSuggestion({ line: oversized, scope: 'local' }), '');
        assert.deepEqual(calls, []);
        await commitGhostCommand('git status', 'local');
        await acceptGhostCommand('git status', 'local');
        assert.equal(await resolveInlineSuggestion({ line: 'git ', scope: 'local' }), 'status');
        response = 'x'.repeat(limit);
        assert.equal((await fetchGhostSuggestionV2({ prefix: 'git ', scope: 'local' })).suffix, '');
        assert.deepEqual(calls, [
            'ghost_commit',
            'ghost_accept',
            'ghost_suggest_v2',
            'ghost_suggest_v2',
        ]);
    } finally {
        if (previous) {
            globalThis.window = previous;
        } else {
            Reflect.deleteProperty(globalThis, 'window');
        }
    }
});

test('complete multi-megabyte paste still traverses the production terminal sender byte for byte', async () => {
    const previous = globalThis.window;
    const delivered: string[] = [];
    globalThis.window = {
        setTimeout,
        clearTimeout,
        ipcRenderer: {
            invoke: async (name: string, payload: { data?: string }) => {
                if (name === 'terminal:write') {
                    delivered.push(payload.data ?? '');
                }
            },
        },
    } as unknown as Window & typeof globalThis;
    const { queueTerminalInput } = await import('../../src/lib/terminal/inputPipeline.js');
    const { terminalCache, clearTerminalPendingInput } = await import(
        '../../src/lib/terminal/terminalCache.js'
    );
    const id = 'ghost-budget-byte-preservation';
    const entry = {
        term: { rows: 24, cols: 80 },
        generation: 1,
        spawned: true,
        starting: false,
        pendingInput: '',
        pendingInputBytes: 0,
        inputFlushTimer: null,
        desiredResize: null,
        lastResize: { rows: 24, cols: 80 },
    } as import('../../src/lib/terminal/terminalCache.js').TerminalCache;
    terminalCache.set(id, entry);
    try {
        const f = fixture();
        const paste = `\x1b[200~${'界🦀\t\r\n\ufeff'.repeat(200_000)}\x1b[201~`;
        for (const text of [paste, 'after paste\r']) {
            if (!handleGhostInputEvent(text, f.tracker)) {
                queueTerminalInput(id, text);
            }
        }
        await flushJobs();
        assert.equal(delivered.join(''), `${paste}after paste\r`);
        assert.equal(entry.pendingInputBytes, 0);
        assert.deepEqual(f.history, []);
        assert.equal(f.tracker.getLineBuffer(), '');
    } finally {
        clearTerminalPendingInput(id);
        terminalCache.delete(id);
        if (previous) {
            globalThis.window = previous;
        } else {
            Reflect.deleteProperty(globalThis, 'window');
        }
    }
});
