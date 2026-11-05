import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import type { ConversationMessage } from '../../src/ai/types/agent';

const values = new Map<string, string>();
let storageWrites = 0;
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
        get length() {
            return values.size;
        },
        clear() {
            values.clear();
        },
        key(index: number) {
            return [...values.keys()][index] ?? null;
        },
        getItem(key: string) {
            return values.get(key) ?? null;
        },
        setItem(key: string, value: string) {
            storageWrites++;
            values.set(key, value);
        },
        removeItem(key: string) {
            values.delete(key);
        },
    } satisfies Storage,
});
after(() => {
    if (previousStorage) {
        Object.defineProperty(globalThis, 'localStorage', previousStorage);
    } else {
        Reflect.deleteProperty(globalThis, 'localStorage');
    }
});

const { partializeConversations, useAgentRunStore } = await import(
    '../../src/ai/store/agentRunStore.js'
);
type ToolMessage = Extract<ConversationMessage, { type: 'tool-call' }>;
type ThinkingMessage = Extract<ConversationMessage, { type: 'thinking' }>;
type DoneMessage = Extract<ConversationMessage, { type: 'done' }>;

function makeToolCall(overrides: Partial<ToolMessage> = {}): ToolMessage {
    return {
        type: 'tool-call',
        id: 'msg-1',
        toolCallId: 'tc-1',
        toolName: 'run_command',
        input: { command: 'ls -la', reason: 'list files' },
        output: 'total 16\ndrwxr-xr-x  ...',
        status: 'done',
        ...overrides,
    };
}

function makeThinking(overrides: Partial<ThinkingMessage> = {}): ThinkingMessage {
    return {
        type: 'thinking',
        id: 'think-1',
        text: 'I should check the nginx config first.',
        ...overrides,
    };
}

function makeDone(overrides: Partial<DoneMessage> = {}): DoneMessage {
    return {
        type: 'done',
        id: 'done-1',
        success: true,
        summary: 'Deployed nginx successfully.',
        actions: ['✔ Checked config', '✔ Restarted nginx'],
        ...overrides,
    };
}

function tool(scope: string): ToolMessage {
    const message = useAgentRunStore
        .getState()
        .getMessages(scope)
        .find((message) => message.type === 'tool-call');
    assert.ok(message?.type === 'tool-call');
    return message;
}

test('clears output and strips diff from tool-call messages', () => {
    const result = partializeConversations({
        'ssh:prod': [
            makeToolCall({
                output: 'secret_token=abc123 found in config',
                diff: { before: 'old', after: 'new', path: '/etc/nginx.conf' },
            }),
        ],
    });
    const message = result['ssh:prod'][0];
    assert.ok(message.type === 'tool-call');
    assert.equal(message.output, '', 'original output leaked into persistence');
    assert.ok(!('diff' in message), 'diff field leaked into persistence');
    assert.equal(message.toolName, 'run_command');
    assert.deepEqual(message.input, { command: 'ls -la', reason: 'list files' });
});

test('resets running tool-call status to done on persist', () => {
    const message = partializeConversations({ scope: [makeToolCall({ status: 'running' })] })
        .scope[0];
    assert.ok(message.type === 'tool-call');
    assert.equal(message.status, 'done');
});

test('preserves error status on tool-call messages', () => {
    const message = partializeConversations({ scope: [makeToolCall({ status: 'error' })] })
        .scope[0];
    assert.ok(message.type === 'tool-call');
    assert.equal(message.status, 'error');
});

test('filters out thinking messages', () => {
    const messages: ConversationMessage[] = [
        { type: 'user', id: 'u1', text: 'deploy nginx' },
        makeThinking(),
        makeToolCall(),
        makeDone(),
    ];
    const types = partializeConversations({ scope: messages }).scope.map((message) => message.type);
    assert.ok(!types.includes('thinking'), 'thinking message leaked into persistence');
    assert.ok(types.includes('user'));
    assert.ok(types.includes('tool-call'));
    assert.ok(types.includes('done'));
});

test('caps messages at MAX_PERSISTED_MESSAGES (60)', () => {
    const messages: ConversationMessage[] = Array.from({ length: 80 }, (_, index) => ({
        type: 'user',
        id: `u${index}`,
        text: `goal ${index}`,
    }));
    const result = partializeConversations({ scope: messages }).scope;
    assert.equal(result.length, 60);
    assert.equal(result[0].id, 'u20');
    assert.equal(result[59].id, 'u79');
});

test('backfills actions field for legacy done messages without it', () => {
    // This deliberately models the older persisted shape missing the newly required field.
    const legacyDone = {
        type: 'done',
        id: 'done-old',
        success: true,
        summary: 'Done.',
    } as DoneMessage;
    const message = partializeConversations({ scope: [legacyDone] }).scope[0];
    assert.ok(message.type === 'done');
    assert.deepEqual(message.actions, []);
    assert.equal(message.summary, 'Done.');
});

test('preserves done messages that already have actions', () => {
    const message = partializeConversations({ scope: [makeDone()] }).scope[0];
    assert.ok(message.type === 'done');
    assert.deepEqual(message.actions, ['✔ Checked config', '✔ Restarted nginx']);
});

test('handles multiple scopes independently', () => {
    const result = partializeConversations({
        'ssh:prod': [makeToolCall({ output: 'prod secret' })],
        local: [makeToolCall({ output: 'local secret' })],
    });
    assert.equal(Object.keys(result).length, 2);
    for (const scope of ['ssh:prod', 'local']) {
        const message = result[scope][0];
        assert.ok(message.type === 'tool-call');
        assert.equal(message.output, '', `${scope} secret leaked`);
    }
});

test('final preview replaces the live prefix with the tail, artifact path and exit annotation', () => {
    const store = useAgentRunStore.getState();
    const scope = 'final-preview';
    store.addToolCall(scope, 'call', 'run_command', {});
    store.appendToolOutput(scope, 'call', 'partial live prefix');
    const final = 'head\n[truncated: see artifacts/call.txt]\nfinal stderr [Exit code: 7]';
    store.setToolStatus(scope, 'call', 'error', final);
    assert.equal(tool(scope).output, final);
    assert.equal(tool(scope).status, 'error');
    store.appendToolOutput(scope, 'call', 'late chunk');
    assert.equal(tool(scope).output, final);
});

test('empty final output replaces live text; status-only callers preserve existing output', () => {
    const store = useAgentRunStore.getState();
    const scope = 'empty-preview';
    store.addToolCall(scope, 'empty', 'run_command', {});
    store.appendToolOutput(scope, 'empty', 'live text');
    store.setToolStatus(scope, 'empty', 'done', '');
    assert.equal(tool(scope).output, '');
    store.appendToolOutput(scope, 'empty', 'late success chunk');
    assert.equal(tool(scope).output, '');

    store.addToolCall('status-only', 'legacy', 'run_command', {});
    store.appendToolOutput('status-only', 'legacy', 'legacy live output');
    store.setToolStatus('status-only', 'legacy', 'done');
    assert.equal(tool('status-only').output, 'legacy live output');
});

test('final snapshots remain excluded from persisted output', () => {
    const persisted = JSON.parse(values.get('zync-agent-conversations') ?? '{}') as {
        state: { conversations: Record<string, ConversationMessage[]> };
    };
    const message = persisted.state.conversations['final-preview'][0];
    assert.ok(message.type === 'tool-call');
    assert.equal(message.output, '');
});

test('reused provider IDs update only the latest block and terminal results ignore duplicate events', () => {
    const store = useAgentRunStore.getState();
    const scope = 'reused-provider-id';
    store.addToolCall(scope, 'call_0', 'run_command', {});
    store.appendToolOutput(scope, 'call_0', 'old live');
    store.setToolStatus(scope, 'call_0', 'done', 'old final');
    store.addToolCall(scope, 'call_0', 'write_file', {});
    store.appendToolOutput(scope, 'call_0', 'new live');
    store.setToolDiff(scope, 'call_0', 'before', 'after', 'file.txt');
    store.setToolStatus(scope, 'call_0', 'error', 'new final');
    store.setToolStatus(scope, 'call_0', 'done', 'duplicate terminal');
    store.appendToolOutput(scope, 'call_0', 'late chunk');
    store.setToolDiff(scope, 'call_0', 'late before', 'late after', 'other.txt');
    const messages = store.getMessages(scope);
    const old = messages[0];
    const current = messages[1];
    assert.ok(old.type === 'tool-call' && current.type === 'tool-call');
    assert.equal(old.output, 'old final');
    assert.equal(old.diff, undefined);
    assert.equal(current.output, 'new final');
    assert.equal(current.status, 'error');
    assert.deepEqual(current.diff, { before: 'before', after: 'after', path: 'file.txt' });
});

test('latest matching tool owns events even when an older interrupted block still says running', () => {
    const store = useAgentRunStore.getState();
    const scope = 'interrupted-provider-id';
    store.addToolCall(scope, 'call_0', 'run_command', {});
    store.appendToolOutput(scope, 'call_0', 'interrupted output');
    store.addToolCall(scope, 'call_0', 'run_command', {});
    store.appendToolOutput(scope, 'call_0', 'current output');
    store.setToolStatus(scope, 'call_0', 'done', 'current final');
    const old = store.getMessages(scope)[0];
    const current = store.getMessages(scope)[1];
    assert.ok(old.type === 'tool-call' && current.type === 'tool-call');
    assert.equal(old.output, 'interrupted output');
    assert.equal(old.status, 'running');
    assert.equal(current.output, 'current final');
});

test('ephemeral chunks and diffs bypass partialization and storage while terminal history persists immediately', () => {
    const store = useAgentRunStore.getState();
    const scope = 'ephemeral-storage';
    store.startRun(scope, 'stream-run', 'goal');
    store.addToolCall(scope, 'call', 'run_command', {});
    const original = useAgentRunStore.persist.getOptions().partialize;
    assert.ok(original);
    let partializations = 0;
    useAgentRunStore.persist.setOptions({
        partialize(state) {
            partializations++;
            return original(state);
        },
    });
    const before = storageWrites;
    try {
        for (let index = 0; index < 1000; index++) {
            store.appendThinking(scope, 'stream-run', 'private reasoning');
            store.appendToolOutput(scope, 'call', 'private output');
            store.setToolDiff(scope, 'call', 'private old', 'private new', 'file.txt');
        }
        store.clearThinking(scope, 'stream-run');
        store.endRun(scope);
        assert.equal(partializations, 0, 'transient updates must bypass persist entirely');
        assert.equal(storageWrites, before);

        store.setToolStatus(scope, 'call', 'done', 'private final result');
        assert.equal(storageWrites, before + 1);
        assert.equal(partializations, 1);
        store.setToolStatus(scope, 'call', 'error', 'duplicate final result');
        store.appendToolOutput(scope, 'call', 'late output');
        assert.equal(storageWrites, before + 1);
        const serialized = values.get('zync-agent-conversations') ?? '';
        assert.ok(!serialized.includes('private '));
        const persisted = JSON.parse(serialized) as {
            state: { activeRunIds?: unknown; conversations: Record<string, ConversationMessage[]> };
        };
        assert.equal(persisted.state.activeRunIds, undefined);
        const message = persisted.state.conversations[scope].find(
            (message) => message.type === 'tool-call',
        );
        assert.ok(message?.type === 'tool-call');
        assert.equal(message.status, 'done');
        assert.equal(message.output, '');
        assert.equal(message.diff, undefined);

        store.addDone(scope, true, 'completed summary', ['completed action']);
        assert.equal(storageWrites, before + 2);
        assert.ok(values.get('zync-agent-conversations')?.includes('completed summary'));
    } finally {
        useAgentRunStore.persist.setOptions({ partialize: original });
    }
});

test('buffer cleanup cannot restore pending chunks to a cleared or replaced conversation', async () => {
    const { createAgentStreamBuffer } = await import('../../src/ai/store/agentStreamRuntime.js');
    const store = useAgentRunStore.getState();
    for (const replacement of [false, true]) {
        const scope = `buffer-cleanup-${replacement}`;
        store.startRun(scope, 'old-run', 'old goal');
        store.addToolCall(scope, 'call', 'run_command', {});
        let cancels = 0;
        const buffer = createAgentStreamBuffer(
            {
                isCurrent: () => store.getActiveRunId(scope) === 'old-run',
                appendThinking: (text) => store.appendThinking(scope, 'old-run', text),
                appendToolOutput: (id, text) => store.appendToolOutput(scope, id, text),
            },
            () => () => {
                cancels++;
            },
        );
        buffer.appendThinking('stale reasoning');
        buffer.appendToolOutput('call', 'stale tool output');
        if (replacement) {
            store.startRun(scope, 'replacement-run', 'replacement goal');
        } else {
            store.clearConversation(scope);
        }
        const before = store.getMessages(scope);
        const beforeWrites = storageWrites;
        buffer.dispose();
        assert.equal(store.getMessages(scope), before);
        assert.equal(storageWrites, beforeWrites);
        assert.equal(cancels, 1);
        assert.ok(!JSON.stringify(before).includes('stale'));
    }
});
