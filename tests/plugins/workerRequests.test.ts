import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

import { createOptionalPermissionRequester } from '../../src/features/plugins/runtime/pluginOptionalPermission.js';

interface RequestApi {
    request(type: string, payload?: unknown): Promise<unknown>;
    pendingRequests: Map<string, unknown>;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((finish) => {
        resolve = finish;
    });
    return { promise, resolve };
}

/** Execute the shipped worker bootstrap with structured cloning and deterministic timer boundaries. */
function workerFixture() {
    const source = fs.readFileSync('src/context/PluginContext.tsx', 'utf8');
    const start =
        source.indexOf('const WORKER_BOOTSTRAP = `') + 'const WORKER_BOOTSTRAP = `'.length;
    assert.ok(start > 25);
    const end = source.indexOf('`;', start);
    const messages: { type: string; payload: { requestId: string } }[] = [];
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    const context = vm.createContext({
        console,
        setTimeout: (callback: () => void) => {
            timers.set(++nextTimer, callback);
            return nextTimer;
        },
        clearTimeout: (id: number) => timers.delete(id),
        postMessage: (message: (typeof messages)[number]) =>
            messages.push(structuredClone(message)),
    });
    context.self = context;
    vm.runInContext(`${source.slice(start, end)};globalThis.fixtureApi = zync;`, context);
    return {
        api: context.fixtureApi as RequestApi,
        messages,
        timers,
        receive: (type: string, payload: Record<string, unknown>) =>
            context.onmessage({ data: { type, payload } }),
        expire: () => {
            for (const callback of [...timers.values()]) {
                callback();
            }
        },
    };
}

test('uncloneable payloads release pending requests and timers immediately', async () => {
    const worker = workerFixture();
    for (let i = 0; i < 100; i++) {
        await assert.rejects(worker.api.request('api:storage:set', { value: () => undefined }));
    }
    assert.equal(worker.api.pendingRequests.size, 0);
    assert.equal(worker.timers.size, 0);
    assert.equal(worker.messages.length, 0);
    const payload = Object.defineProperty({}, 'value', {
        enumerable: true,
        get: () => {
            throw undefined;
        },
    });
    let rejected = false;
    await worker.api.request('api:storage:set', payload).then(
        () => assert.fail('throw undefined must reject'),
        () => {
            rejected = true;
        },
    );
    assert.equal(rejected, true);
    assert.equal(worker.api.pendingRequests.size, 0);
});

test('shared permission dialog pauses both requests without pausing native policy work', async () => {
    const prompt = {
        pluginName: 'Fixture',
        capability: 'ssh.terminal.open',
        reason: 'Open a terminal',
        packageDigest: 'fixture-digest',
    };
    const inspection = deferred<typeof prompt>();
    const approval = deferred<boolean>();
    const saved = deferred<null>();
    const firstPhases: boolean[] = [];
    const followerPhases: boolean[] = [];
    let inspections = 0;
    let dialogs = 0;
    const request = createOptionalPermissionRequester({
        inspect: (_, __, digest) => {
            inspections++;
            return digest ? saved.promise : inspection.promise;
        },
        confirm: () => {
            dialogs++;
            return approval.promise;
        },
    });
    const first = request(
        'runtime',
        prompt.capability,
        () => true,
        (waiting) => {
            firstPhases.push(waiting);
        },
    );
    assert.deepEqual(firstPhases, []);
    inspection.resolve(prompt);
    await Promise.resolve();
    const follower = request(
        'runtime',
        prompt.capability,
        () => true,
        (waiting) => {
            followerPhases.push(waiting);
        },
    );
    assert.deepEqual(firstPhases, [true]);
    assert.deepEqual(followerPhases, [true]);
    approval.resolve(true);
    await Promise.resolve();
    assert.deepEqual(firstPhases, [true, false]);
    assert.deepEqual(followerPhases, [true, false]);
    assert.equal(dialogs, 1);
    assert.equal(inspections, 2);
    saved.resolve(null);
    assert.deepEqual(await Promise.all([first, follower]), [true, true]);
});

test('request identity cannot be overridden and replies release only their own waiter', async () => {
    const worker = workerFixture();
    const first = worker.api.request('api:storage:get', { requestId: 'forged' });
    const second = worker.api.request('api:storage:get', {});
    assert.notEqual(worker.messages[0].payload.requestId, 'forged');
    assert.notEqual(worker.messages[0].payload.requestId, worker.messages[1].payload.requestId);
    await worker.receive('api:storage:get:response', {
        requestId: worker.messages[1].payload.requestId,
        result: 'second',
    });
    assert.equal(await second, 'second');
    assert.equal(worker.api.pendingRequests.size, 1);
    await worker.receive('api:storage:get:response', {
        requestId: worker.messages[0].payload.requestId,
        result: 'first',
    });
    assert.equal(await first, 'first');
    assert.equal(worker.timers.size, 0);
});

test('ordinary expired responses release admission without replaying work', async () => {
    const worker = workerFixture();
    const request = worker.api.request('api:terminal:context', {});
    const rejected = assert.rejects(request, /outcome is unknown/);
    worker.expire();
    await rejected;
    assert.equal(worker.api.pendingRequests.size, 0);
    assert.equal(worker.messages.length, 1);
    await worker.receive('api:terminal:context:response', {
        requestId: worker.messages[0].payload.requestId,
        result: 'late',
    });
    assert.equal(worker.timers.size, 0);
});

test('user dialogs and optional permission waits do not expire on response deadlines', async () => {
    const worker = workerFixture();
    const dialog = worker.api.request('api:ui:confirm', {});
    assert.equal(worker.timers.size, 0);
    const read = worker.api.request('api:terminal:context', {});
    const requestId = worker.messages[1].payload.requestId;
    await worker.receive('host:request:phase', { requestId, waitingForUser: true });
    assert.equal(worker.timers.size, 0);
    worker.expire();
    assert.equal(worker.api.pendingRequests.size, 2);
    await worker.receive('host:request:phase', { requestId, waitingForUser: false });
    assert.equal(worker.timers.size, 1);
    await worker.receive('api:terminal:context:response', { requestId, result: 'ready' });
    await worker.receive('api:ui:confirm:response', {
        requestId: worker.messages[0].payload.requestId,
        result: true,
    });
    assert.equal(await read, 'ready');
    assert.equal(await dialog, true);
    assert.equal(worker.timers.size, 0);
});

test('outstanding request admission is bounded and recovers after responses', async () => {
    const worker = workerFixture();
    const pending = Array.from({ length: 256 }, () => worker.api.request('api:ui:confirm', {}));
    await assert.rejects(worker.api.request('api:ui:confirm', {}), /Too many outstanding/);
    assert.equal(worker.api.pendingRequests.size, 256);
    for (const message of worker.messages) {
        await worker.receive('api:ui:confirm:response', {
            requestId: message.payload.requestId,
            result: true,
        });
    }
    await Promise.all(pending);
    assert.equal(worker.api.pendingRequests.size, 0);
    const next = worker.api.request('api:ui:confirm', {});
    await worker.receive('api:ui:confirm:response', {
        requestId: worker.messages.at(-1)!.payload.requestId,
        result: true,
    });
    assert.equal(await next, true);
});

test('long I/O and remote work retain their accepted request until the actual response', async () => {
    const worker = workerFixture();
    const types = [
        'api:filesystem:write-text',
        'api:filesystem:read-text',
        'api:ssh-command:execute',
        'api:ssh-filesystem:read-text',
        'api:network:fetch',
        'api:storage:set',
    ];
    const pending = types.map((type) => worker.api.request(type, {}));
    assert.equal(worker.timers.size, 0);
    for (let i = 0; i < 20; i++) {
        worker.expire();
    }
    assert.equal(worker.api.pendingRequests.size, types.length);
    for (const [index, message] of worker.messages.entries()) {
        await worker.receive(`${message.type}:response`, {
            requestId: message.payload.requestId,
            result: index,
        });
    }
    assert.deepEqual(
        await Promise.all(pending),
        types.map((_, index) => index),
    );
});
