import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    createDashboardMetricsSampler,
    DASHBOARD_SAMPLE_TTL_MS,
    WINDOWS_DASHBOARD_COMMAND,
} from '../../src/components/dashboard/dashboardMetrics.js';
import {
    getConnectionBackendEpoch,
    isConnectionBackendLive,
    markConnectionBackendLive,
    markConnectionBackendOffline,
} from '../../src/lib/terminal/connectionBackend.js';

const linuxOutput = '0.3\n8192 1024\n3 hours\n81\n100G 20G 20%\nFixture Linux\n6.0-fixture\nx86_64';
const windowsOutput = JSON.stringify({
    cpu: 17,
    totalMem: 8192,
    usedMem: 2048,
    diskSize: 100 * 1024 ** 3,
    diskFree: 25 * 1024 ** 3,
    uptime: '2d 3h 4m',
    processes: 92,
    os: 'Fixture Windows — テスト',
    kernel: 'fixture-version',
    arch: 'fixture-arch',
});

function deferred() {
    let resolve!: (value: string) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

test('transport epochs never repeat after disconnect/reconnect and ignore inherited record names', () => {
    const id = 'dashboard-epoch-fixture';
    const first = markConnectionBackendLive(id);
    assert.equal(getConnectionBackendEpoch(id), first);
    markConnectionBackendOffline(id);
    assert.equal(getConnectionBackendEpoch(id), undefined);
    assert.equal(isConnectionBackendLive(id), false);
    const second = markConnectionBackendLive(id);
    assert.ok(second > first);
    assert.equal(getConnectionBackendEpoch(id), second);
    assert.equal(getConnectionBackendEpoch('toString'), undefined);
    assert.equal(isConnectionBackendLive('__proto__'), false);
    markConnectionBackendOffline(id);
});

test('multiple panes share one in-flight sample and brief successful result, then refresh once', async () => {
    let now = 0;
    let calls = 0;
    const pending = deferred();
    const sampler = createDashboardMetricsSampler({
        now: () => now,
        readEpoch: () => 1,
        execute: async () => {
            calls++;
            return calls === 1 ? pending.promise : linuxOutput;
        },
    });
    const first = sampler.sample('fixture', false);
    const second = sampler.sample('fixture', false);
    assert.equal(first, second);
    await Promise.resolve();
    assert.equal(calls, 1);
    pending.resolve(linuxOutput);
    const metrics = await first;
    assert.equal(metrics.cpu, 3);
    assert.deepEqual(metrics.ram, { used: 1024, total: 8192, percent: 12.5 });
    assert.deepEqual(metrics.disk, { used: '20G', total: '100G', percent: 20 });
    now = DASHBOARD_SAMPLE_TTL_MS - 1;
    assert.equal(await sampler.sample('fixture', false), metrics);
    assert.equal(calls, 1);
    now = DASHBOARD_SAMPLE_TTL_MS;
    const refreshed = sampler.sample('fixture', false);
    assert.equal(refreshed, sampler.sample('fixture', false));
    await refreshed;
    assert.equal(calls, 2);
});

test('failures are shared only while active and a later request can retry', async () => {
    let calls = 0;
    const pending = deferred();
    const sampler = createDashboardMetricsSampler({
        readEpoch: () => 1,
        execute: async () => {
            calls++;
            return calls === 1 ? pending.promise : linuxOutput;
        },
    });
    const first = sampler.sample('fixture', false);
    const second = sampler.sample('fixture', false);
    const rejected = assert.rejects(first, /fixture refusal/);
    pending.reject(new Error('fixture refusal'));
    await rejected;
    assert.equal(first, second);
    await sampler.sample('fixture', false);
    assert.equal(calls, 2);
});

test('replacement before the execution microtask prevents stale native submission', async () => {
    let epoch: number | undefined = 1;
    let calls = 0;
    const sampler = createDashboardMetricsSampler({
        readEpoch: () => epoch,
        execute: async () => {
            calls++;
            return linuxOutput;
        },
    });
    const pending = sampler.sample('fixture', false);
    epoch = 2;
    await assert.rejects(pending, /superseded/);
    assert.equal(calls, 0);
    await sampler.sample('fixture', false);
    assert.equal(calls, 1);
    epoch = undefined;
    await assert.rejects(sampler.sample('fixture', false), /no longer active/);
    assert.equal(calls, 1);
});

test('late old success cannot publish over a replacement sample', async () => {
    let epoch = 1;
    const old = deferred();
    let calls = 0;
    const sampler = createDashboardMetricsSampler({
        readEpoch: () => epoch,
        execute: async () => {
            calls++;
            return calls === 1 ? old.promise : linuxOutput;
        },
    });
    const pending = sampler.sample('fixture', false);
    const rejected = assert.rejects(pending, /superseded/);
    await Promise.resolve();
    epoch = 2;
    const current = await sampler.sample('fixture', false);
    old.resolve(linuxOutput.replace('Fixture Linux', 'Obsolete Linux'));
    await rejected;
    assert.equal(await sampler.sample('fixture', false), current);
    assert.equal(calls, 2);
});

test('late old failure cannot delete the replacement cache entry', async () => {
    let epoch = 1;
    let calls = 0;
    const old = deferred();
    const sampler = createDashboardMetricsSampler({
        readEpoch: () => epoch,
        execute: async () => {
            calls++;
            return calls === 1 ? old.promise : linuxOutput;
        },
    });
    const pending = sampler.sample('fixture', false);
    const rejected = assert.rejects(pending, /Connection not found/);
    await Promise.resolve();
    epoch = 2;
    const current = await sampler.sample('fixture', false);
    old.reject(new Error('Connection not found'));
    await rejected;
    assert.equal(await sampler.sample('fixture', false), current);
    assert.equal(calls, 2);
});

test('different connections stay independent and stable epoch metadata reuses the sample', async () => {
    let calls = 0;
    const epochs = new Map([
        ['first', 1],
        ['second', 2],
    ]);
    const sampler = createDashboardMetricsSampler({
        readEpoch: (id) => epochs.get(id),
        execute: async () => {
            calls++;
            return linuxOutput;
        },
    });
    const first = await sampler.sample('first', false);
    await sampler.sample('second', false);
    assert.equal(await sampler.sample('first', false), first);
    assert.equal(calls, 2);
    epochs.delete('first');
    await sampler.sample('second', false);
    epochs.set('first', 3);
    await sampler.sample('first', false);
    assert.equal(calls, 3);
});

test('local Windows sampling uses one combined JSON request and computes actual system-drive metrics', async () => {
    const commands: string[] = [];
    const sampler = createDashboardMetricsSampler({
        readEpoch: () => {
            throw new Error('Local samples do not need an SSH epoch');
        },
        execute: async (id, command) => {
            assert.equal(id, 'local');
            commands.push(command);
            return windowsOutput;
        },
    });
    const [first, second] = await Promise.all([
        sampler.sample('local', true),
        sampler.sample('local', true),
    ]);
    assert.equal(first, second);
    assert.equal(commands.length, 1);
    assert.equal(commands[0], WINDOWS_DASHBOARD_COMMAND);
    assert.deepEqual(first.ram, { used: 2048, total: 8192, percent: 25 });
    assert.deepEqual(first.disk, { used: '75G', total: '100G', percent: 75 });
    assert.deepEqual(first.info, {
        os: 'Fixture Windows — テスト',
        kernel: 'fixture-version',
        arch: 'fixture-arch',
    });
    assert.equal(first.uptime, '2d 3h 4m');
    assert.equal(first.processes, 92);
});

test('malformed samples are not cached and unavailable numeric fields never produce NaN', async () => {
    let calls = 0;
    const sampler = createDashboardMetricsSampler({
        readEpoch: () => undefined,
        execute: async () => {
            calls++;
            return calls === 1
                ? 'invalid json'
                : JSON.stringify({ cpu: null, totalMem: 0, diskSize: 0 });
        },
    });
    await assert.rejects(sampler.sample('local', true));
    const metrics = await sampler.sample('local', true);
    assert.equal(metrics.cpu, 0);
    assert.equal(metrics.ram.percent, 0);
    assert.equal(metrics.disk.percent, 0);
    assert.equal(calls, 2);
});
