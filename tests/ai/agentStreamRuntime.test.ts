import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    AGENT_STREAM_FLUSH_MS,
    createAgentEventScope,
    createAgentStreamBuffer,
    MAX_PENDING_STREAM_CHARS,
    type StreamSchedule,
} from '../../src/ai/store/agentStreamRuntime.js';

function scheduler() {
    const pending = new Map<number, () => void>();
    const delays: number[] = [];
    let next = 0;
    const schedule: StreamSchedule = (callback, delay) => {
        const id = next++;
        pending.set(id, callback);
        delays.push(delay);
        return () => {
            pending.delete(id);
        };
    };
    return {
        pending,
        delays,
        schedule,
        fire() {
            const callbacks = [...pending.values()];
            pending.clear();
            for (const callback of callbacks) {
                callback();
            }
        },
    };
}

test('many stream fragments share one timer and one update per adjacent group', () => {
    const clock = scheduler();
    const updates: string[] = [];
    const buffer = createAgentStreamBuffer(
        {
            isCurrent: () => true,
            appendThinking: (text) => updates.push(`thinking:${text}`),
            appendToolOutput: (id, text) => updates.push(`${id}:${text}`),
        },
        clock.schedule,
    );
    for (let index = 0; index < 1000; index++) {
        buffer.appendThinking('x');
    }
    assert.equal(clock.pending.size, 1);
    assert.deepEqual(clock.delays, [AGENT_STREAM_FLUSH_MS]);
    assert.deepEqual(updates, []);
    clock.fire();
    assert.deepEqual(updates, [`thinking:${'x'.repeat(1000)}`]);
    assert.equal(clock.pending.size, 0);
    buffer.appendToolOutput('tool-a', 'first');
    buffer.appendToolOutput('tool-a', '-second');
    buffer.appendThinking('reason');
    buffer.appendToolOutput('tool-b', 'other');
    clock.fire();
    assert.deepEqual(updates.slice(1), ['tool-a:first-second', 'thinking:reason', 'tool-b:other']);
});

test('structural boundaries flush before mutations and disposal flushes once while cancelling its timer', () => {
    const clock = scheduler();
    const updates: string[] = [];
    const buffer = createAgentStreamBuffer(
        {
            isCurrent: () => true,
            appendThinking: (text) => updates.push(`thinking:${text}`),
            appendToolOutput: (id, text) => updates.push(`${id}:${text}`),
        },
        clock.schedule,
    );
    buffer.appendThinking('reason');
    buffer.flush();
    updates.push('tool-start');
    buffer.appendToolOutput('tool', 'part');
    buffer.flush();
    updates.push('tool-done');
    assert.deepEqual(updates, ['thinking:reason', 'tool-start', 'tool:part', 'tool-done']);
    buffer.appendThinking('last');
    const staleTimer = [...clock.pending.values()][0];
    buffer.dispose();
    buffer.dispose();
    buffer.appendThinking('late');
    staleTimer();
    assert.deepEqual(updates.slice(-1), ['thinking:last']);
    assert.equal(clock.pending.size, 0);
});

test('cleared or replaced runs discard pending chunks and cannot be revived by late timers', () => {
    const clock = scheduler();
    const updates: string[] = [];
    let current = true;
    const buffer = createAgentStreamBuffer(
        {
            isCurrent: () => current,
            appendThinking: (text) => updates.push(text),
            appendToolOutput: (_id, text) => updates.push(text),
        },
        clock.schedule,
    );
    buffer.appendThinking('old run');
    current = false;
    clock.fire();
    buffer.appendToolOutput('old', 'late output');
    buffer.dispose();
    assert.deepEqual(updates, []);
    assert.equal(clock.pending.size, 0);
});

test('a cancelled old timer cannot consume or detach a newer pending timer', () => {
    const clock = scheduler();
    const updates: string[] = [];
    const buffer = createAgentStreamBuffer(
        {
            isCurrent: () => true,
            appendThinking: (text) => updates.push(text),
            appendToolOutput: (_id, text) => updates.push(text),
        },
        clock.schedule,
    );
    buffer.appendThinking('first');
    const oldTimer = [...clock.pending.values()][0];
    buffer.flush();
    buffer.appendThinking('second');
    oldTimer();
    assert.deepEqual(updates, ['first']);
    assert.equal(clock.pending.size, 1);
    clock.fire();
    assert.deepEqual(updates, ['first', 'second']);
});

test('a paused background scheduler cannot retain unlimited pending text', () => {
    const clock = scheduler();
    const updates: string[] = [];
    const buffer = createAgentStreamBuffer(
        {
            isCurrent: () => true,
            appendThinking: (text) => updates.push(text),
            appendToolOutput: (_id, text) => updates.push(text),
        },
        clock.schedule,
    );
    buffer.appendThinking('x');
    buffer.appendThinking('y'.repeat(MAX_PENDING_STREAM_CHARS));
    assert.equal(updates.length, 1);
    assert.equal(updates[0].length, MAX_PENDING_STREAM_CHARS + 1);
    assert.equal(clock.pending.size, 0);
    buffer.dispose();
});

test('ownership loss during a flush drops remaining groups', () => {
    const clock = scheduler();
    const updates: string[] = [];
    let current = true;
    const buffer = createAgentStreamBuffer(
        {
            isCurrent: () => current,
            appendThinking: (text) => {
                updates.push(text);
                current = false;
            },
            appendToolOutput: (_id, text) => updates.push(text),
        },
        clock.schedule,
    );
    buffer.appendThinking('first');
    buffer.appendToolOutput('old', 'must not resurrect');
    clock.fire();
    assert.deepEqual(updates, ['first']);
});

interface Payload {
    runId: string;
    text: string;
}

test('each resolved listener is released on cleanup even while another registration is pending', async () => {
    const scope = createAgentEventScope('run', () => true);
    let installedCleanup = 0;
    let lateCleanup = 0;
    let updates = 0;
    let forward: (payload: Payload) => void = () => {
        throw new Error('listener not installed');
    };
    let resolve: ((unlisten: () => void) => void) | undefined;
    const first = scope.register<Payload>(
        async () => () => {
            installedCleanup++;
        },
        () => {
            updates++;
        },
    );
    const late = scope.register<Payload>(
        (callback) => {
            forward = callback;
            return new Promise<() => void>((finish) => {
                resolve = finish;
            });
        },
        () => {
            updates++;
        },
    );
    await first;
    scope.dispose();
    assert.equal(installedCleanup, 1);
    forward({ runId: 'run', text: 'late event' });
    assert.equal(updates, 0);
    assert.ok(resolve);
    resolve(() => {
        lateCleanup++;
    });
    await late;
    scope.dispose();
    assert.equal(lateCleanup, 1);
    assert.equal(installedCleanup, 1);
});

test('event callbacks reject other run IDs and release their own listeners after ownership changes', async () => {
    let owned = true;
    let cleanups = 0;
    const updates: string[] = [];
    const scope = createAgentEventScope('old-run', () => owned);
    let forward: (payload: Payload) => void = () => {
        throw new Error('listener not installed');
    };
    await scope.register<Payload>(
        async (callback) => {
            forward = callback;
            return () => {
                cleanups++;
            };
        },
        (payload) => updates.push(payload.text),
    );
    forward({ runId: 'different-run', text: 'wrong' });
    forward({ runId: 'old-run', text: 'current' });
    assert.deepEqual(updates, ['current']);
    owned = false;
    forward({ runId: 'old-run', text: 'stale' });
    assert.deepEqual(updates, ['current']);
    assert.equal(cleanups, 1);
});

test('registration failure releases installed and eventually resolved listeners', async () => {
    const scope = createAgentEventScope('run', () => true);
    let installedCleanup = 0;
    let lateCleanup = 0;
    let resolve: ((unlisten: () => void) => void) | undefined;
    await scope.register<Payload>(
        async () => () => {
            installedCleanup++;
        },
        () => {},
    );
    const late = scope.register<Payload>(
        () =>
            new Promise<() => void>((finish) => {
                resolve = finish;
            }),
        () => {},
    );
    await assert.rejects(
        scope.register<Payload>(
            async () => {
                throw new Error('registration failed');
            },
            () => {},
        ),
        /registration failed/,
    );
    assert.equal(installedCleanup, 1);
    assert.ok(resolve);
    resolve(() => {
        lateCleanup++;
    });
    await late;
    assert.equal(lateCleanup, 1);
});

test('listener cleanup continues after one unsubscription fails and disposed scopes install nothing', async (context) => {
    const errors = context.mock.method(console, 'error', () => {});
    const scope = createAgentEventScope('run', () => true);
    let cleaned = 0;
    let installedAfterDisposal = 0;
    await scope.register<Payload>(
        async () => () => {
            throw new Error('unlisten failed');
        },
        () => {},
    );
    await scope.register<Payload>(
        async () => () => {
            cleaned++;
        },
        () => {},
    );
    scope.dispose();
    assert.equal(cleaned, 1);
    assert.equal(errors.mock.calls.length, 1);
    await scope.register<Payload>(
        async () => {
            installedAfterDisposal++;
            return () => {};
        },
        () => {},
    );
    assert.equal(installedAfterDisposal, 0);
});

test('native-shaped async unsubscribe rejection is observed without delaying other cleanup', async (context) => {
    const errors = context.mock.method(console, 'error', () => {});
    const scope = createAgentEventScope('run', () => true);
    let reject: ((reason?: unknown) => void) | undefined;
    const nativeCleanup = new Promise<void>((_resolve, fail) => {
        reject = fail;
    });
    let localReleased = 0;
    let otherReleased = 0;
    await scope.register<Payload>(
        async () => async () => {
            localReleased++;
            await nativeCleanup;
        },
        () => {},
    );
    await scope.register<Payload>(
        async () => () => {
            otherReleased++;
        },
        () => {},
    );
    scope.dispose();
    assert.equal(localReleased, 1);
    assert.equal(otherReleased, 1);
    assert.ok(reject);
    reject(new Error('native unsubscribe failed'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(errors.mock.calls.length, 1);
});
