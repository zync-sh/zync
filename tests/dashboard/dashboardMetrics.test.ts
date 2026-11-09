import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    createDashboardMetricsSampler,
    DASHBOARD_CPU_BASELINE_TTL_MS,
    DASHBOARD_NETWORK_INTERFACE_LIMIT,
    DASHBOARD_SAMPLE_TTL_MS,
    WINDOWS_DASHBOARD_COMMAND,
} from '../../src/components/dashboard/dashboardMetrics.js';
import {
    getConnectionBackendEpoch,
    isConnectionBackendLive,
    markConnectionBackendLive,
    markConnectionBackendOffline,
} from '../../src/lib/terminal/connectionBackend.js';

const baselineCpu = 'cpu 100 20 30 800 40 5 3 2 50 10';
const nextCpu = 'cpu 140 30 50 910 50 8 9 3 80 15';
const linuxOutput = `${baselineCpu}\n8192 1024\n3 hours\n81\n100G 20G 20%\nFixture Linux\n6.0-fixture\nx86_64`;

/** Vary the aggregate CPU counters without changing the other combined sample fields. */
function linuxSample(cpu: string): string {
    return linuxOutput.replace(baselineCpu, cpu);
}

/** Append the collector's optional versioned fields to a legacy-compatible sample. */
function extendedLinuxSample(cpu: string, fields: readonly string[]): string {
    return `${linuxSample(cpu)}\n__ZYNC_DASHBOARD_V1__\n${fields.join('\n')}\n__ZYNC_DASHBOARD_END__\n`;
}

const unavailableMemory = { available: null, cached: null, swap: null };
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
    assert.equal(metrics.cpu, null);
    assert.deepEqual(metrics.ram, { used: 1024, total: 8192, percent: 12.5, ...unavailableMemory });
    assert.deepEqual(metrics.cpuDetails, { cores: null, loadAverage: null, iowait: null });
    assert.equal(metrics.network, null);
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

test('cached samples retain their acquisition timestamp until a real refresh completes', async () => {
    let now = 1000;
    let calls = 0;
    const pending = deferred();
    const sampler = createDashboardMetricsSampler({
        now: () => now,
        readEpoch: () => 1,
        execute: async () => {
            calls++;
            return calls === 1 ? linuxOutput : pending.promise;
        },
    });
    const first = await sampler.sample('fixture', false);
    assert.equal(first.sampledAt, 1000);
    now += DASHBOARD_SAMPLE_TTL_MS - 1;
    const cached = await sampler.sample('fixture', false);
    assert.equal(cached, first);
    assert.equal(cached.sampledAt, 1000);
    assert.equal(calls, 1);
    now++;
    const refresh = sampler.sample('fixture', false);
    assert.equal(refresh, sampler.sample('fixture', false));
    await Promise.resolve();
    now += 500;
    pending.resolve(linuxSample(nextCpu));
    const second = await refresh;
    assert.notEqual(second, first);
    assert.equal(second.sampledAt, 4500);
    assert.equal(second.cpu, 40);
    assert.equal(calls, 2);
    now++;
    assert.equal(await sampler.sample('fixture', false), second);
    assert.equal(second.sampledAt, 4500);
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
    assert.equal(first.cpu, 17);
    assert.deepEqual(first.ram, { used: 2048, total: 8192, percent: 25, ...unavailableMemory });
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
                : JSON.stringify({ cpu: null, totalMem: null, diskSize: 100 * 1024 ** 3 });
        },
    });
    await assert.rejects(sampler.sample('local', true));
    const metrics = await sampler.sample('local', true);
    assert.equal(metrics.cpu, null);
    assert.deepEqual(metrics.ram, { used: null, total: null, percent: null, ...unavailableMemory });
    assert.deepEqual(metrics.disk, { used: null, total: '100G', percent: null });
    assert.equal(metrics.processes, null);
    assert.equal(calls, 2);
});

test('Linux CPU measures shared counter deltas, excluding guest time and idle plus iowait', async () => {
    let now = 0;
    let calls = 0;
    const sampler = createDashboardMetricsSampler({
        now: () => now,
        readEpoch: () => 1,
        execute: async (_id, command) => {
            assert.match(command, /\/proc\/stat/);
            assert.doesNotMatch(command.split(';')[0], /loadavg|\bsleep\b/);
            assert.match(command, /ps -e -o pid=/);
            assert.doesNotMatch(command, /ps aux/);
            calls++;
            return calls === 1 ? linuxOutput : linuxSample(nextCpu);
        },
    });
    assert.equal((await sampler.sample('fixture', false)).cpu, null);
    now = DASHBOARD_SAMPLE_TTL_MS;
    const next = sampler.sample('fixture', false);
    assert.equal(next, sampler.sample('fixture', false));
    const measured = await next;
    assert.equal(measured.cpu, 40);
    assert.deepEqual(measured.ram, {
        used: 1024,
        total: 8192,
        percent: 12.5,
        ...unavailableMemory,
    });
    assert.equal(measured.cpuDetails.iowait, 5);
    assert.deepEqual(measured.disk, { used: '20G', total: '100G', percent: 20 });
    assert.equal(calls, 2);
});

test('Linux CPU distinguishes measured idle and fully busy intervals from unavailable data', async () => {
    for (const [current, expected] of [
        ['cpu 100 20 30 900 40 5 3 2 50 10', 0],
        ['cpu 200 20 30 800 40 5 3 2 50 10', 100],
    ] as const) {
        let now = 0;
        const sampler = createDashboardMetricsSampler({
            now: () => now,
            readEpoch: () => 1,
            execute: async () => (now === 0 ? linuxOutput : linuxSample(current)),
        });
        await sampler.sample('fixture', false);
        now = DASHBOARD_SAMPLE_TTL_MS;
        assert.equal((await sampler.sample('fixture', false)).cpu, expected);
    }
});

test('invalid Linux counters clear the baseline until two valid samples are available', async (context) => {
    for (const invalid of [
        '0.3',
        'unavailable',
        'cpu0 100 20 30 800 40 5 3 2 50 10',
        'cpu 100 20 30',
        'cpu 100 -20 30 800',
        'cpu 100 20.5 30 800',
        'cpu 100 NaN 30 800',
        'cpu 9007199254740992 0 0 800',
        'cpu 9007199254740991 0 0 800',
    ]) {
        await context.test(invalid, async () => {
            let now = 0;
            let index = 0;
            const responses = [baselineCpu, invalid, baselineCpu, nextCpu];
            const sampler = createDashboardMetricsSampler({
                now: () => now,
                readEpoch: () => 1,
                execute: async () => linuxSample(responses[index++]),
            });
            for (const expected of [null, null, null, 40]) {
                const metrics = await sampler.sample('fixture', false);
                assert.equal(metrics.cpu, expected);
                assert.equal(metrics.ram.percent, 12.5);
                now += DASHBOARD_SAMPLE_TTL_MS;
            }
        });
    }
});

test('Linux CPU remains available when only I/O wait decreases and deltas are valid', async () => {
    let now = 0;
    const sampler = createDashboardMetricsSampler({
        now: () => now,
        readEpoch: () => 1,
        execute: async () =>
            now === 0 ? linuxOutput : linuxSample('cpu 140 20 30 870 30 5 3 2 50 10'),
    });
    await sampler.sample('fixture', false);
    now = DASHBOARD_SAMPLE_TTL_MS;
    const sample = await sampler.sample('fixture', false);
    assert.equal(sample.cpu, 40);
    assert.equal(sample.cpuDetails.iowait, null);
});

test('reset or unusable Linux counter deltas do not fabricate utilization', async (context) => {
    for (const current of [
        'cpu 10 2 3 80 4 0 0 0 5 1',
        'cpu 140 20 30 805 30 5 3 2 50 10', // Positive total delta but negative idle delta.
        'cpu 100 20 30 805 30 5 3 2 50 10', // Negative total delta.
        'cpu 140 19 50 1000 50 8 9 3 80 15',
        baselineCpu,
    ]) {
        await context.test(current, async () => {
            let now = 0;
            const sampler = createDashboardMetricsSampler({
                now: () => now,
                readEpoch: () => 1,
                execute: async () => (now === 0 ? linuxOutput : linuxSample(current)),
            });
            await sampler.sample('fixture', false);
            now = DASHBOARD_SAMPLE_TTL_MS;
            const sample = await sampler.sample('fixture', false);
            assert.equal(sample.cpu, null);
            assert.equal(sample.cpuDetails.iowait, null);
        });
    }
});

test('a valid reset sample becomes the next baseline instead of retaining the old counters', async () => {
    let now = 0;
    let index = 0;
    const responses = [baselineCpu, 'cpu 10 0 0 90', 'cpu 35 0 0 165'];
    const sampler = createDashboardMetricsSampler({
        now: () => now,
        readEpoch: () => 1,
        execute: async () => linuxSample(responses[index++]),
    });
    for (const expected of [null, null, 25]) {
        assert.equal((await sampler.sample('fixture', false)).cpu, expected);
        now += DASHBOARD_SAMPLE_TTL_MS;
    }
});

test('inactive Linux baselines expire without timers or extra execution', async () => {
    let now = 0;
    let calls = 0;
    const sampler = createDashboardMetricsSampler({
        now: () => now,
        readEpoch: () => 1,
        execute: async () => {
            calls++;
            return calls === 1 ? linuxOutput : linuxSample(nextCpu);
        },
    });
    await sampler.sample('fixture', false);
    now = DASHBOARD_CPU_BASELINE_TTL_MS;
    assert.equal((await sampler.sample('fixture', false)).cpu, null);
    assert.equal(calls, 2);
});

test('Linux CPU baselines are isolated by host, transport epoch and sampling platform', async () => {
    let now = 0;
    let epoch = 1;
    let calls = 0;
    const sampler = createDashboardMetricsSampler({
        now: () => now,
        readEpoch: () => epoch,
        execute: async (_id, command) => {
            calls++;
            return command === WINDOWS_DASHBOARD_COMMAND
                ? windowsOutput
                : calls === 1
                  ? linuxOutput
                  : linuxSample(nextCpu);
        },
    });
    await sampler.sample('first', false);
    now = DASHBOARD_SAMPLE_TTL_MS;
    assert.equal((await sampler.sample('second', false)).cpu, null);
    assert.equal((await sampler.sample('first', false)).cpu, 40);
    epoch = 2;
    assert.equal((await sampler.sample('first', false)).cpu, null);
    await sampler.sample('first', true);
    assert.equal((await sampler.sample('first', false)).cpu, null);
});

test('a late previous transport sample cannot seed the replacement CPU baseline', async () => {
    let now = 0;
    let epoch = 1;
    let calls = 0;
    const pending = deferred();
    const sampler = createDashboardMetricsSampler({
        now: () => now,
        readEpoch: () => epoch,
        execute: async () => {
            calls++;
            return calls === 1 ? pending.promise : linuxSample(nextCpu);
        },
    });
    const obsolete = sampler.sample('fixture', false);
    const rejected = assert.rejects(obsolete, /superseded/);
    await Promise.resolve();
    epoch = 2;
    assert.equal((await sampler.sample('fixture', false)).cpu, null);
    pending.resolve(linuxOutput);
    await rejected;
    now = DASHBOARD_SAMPLE_TTL_MS;
    assert.equal((await sampler.sample('fixture', false)).cpu, null);
    assert.equal(calls, 3);
});

test('failed Linux sampling clears the baseline before retrying', async () => {
    let now = 0;
    let calls = 0;
    const sampler = createDashboardMetricsSampler({
        now: () => now,
        readEpoch: () => 1,
        execute: async () => {
            calls++;
            if (calls === 2) {
                throw new Error('temporary command failure');
            }
            return calls === 1 ? linuxOutput : linuxSample(nextCpu);
        },
    });
    await sampler.sample('fixture', false);
    now = DASHBOARD_SAMPLE_TTL_MS;
    await assert.rejects(sampler.sample('fixture', false), /temporary command failure/);
    assert.equal((await sampler.sample('fixture', false)).cpu, null);
});

test('Windows CPU keeps measured zero and fractional values but rejects unavailable percentages', async () => {
    for (const cpu of [0, 17.5, 100, null, undefined, '17', -1, 101]) {
        const sampler = createDashboardMetricsSampler({
            readEpoch: () => 1,
            execute: async () => JSON.stringify({ cpu }),
        });
        const expected = typeof cpu === 'number' && cpu >= 0 && cpu <= 100 ? cpu : null;
        assert.equal((await sampler.sample('fixture', true)).cpu, expected);
    }
});

test('Linux details separate load, logical processors, available/cache memory and swap from CPU utilization', async () => {
    const sampler = createDashboardMetricsSampler({
        readEpoch: () => 1,
        execute: async () =>
            extendedLinuxSample(baselineCpu, [
                'cores 8',
                'load 0.25 1.50 3.00',
                'mem MemAvailable 6291456',
                'mem Cached 2097152',
                'mem SwapTotal 2097152',
                'mem SwapFree 1048576',
                'network ready',
                'net eth0 1000 2000',
            ]),
    });
    const metrics = await sampler.sample('fixture', false);
    assert.equal(metrics.cpu, null);
    assert.deepEqual(metrics.cpuDetails, { cores: 8, loadAverage: [0.25, 1.5, 3], iowait: null });
    assert.deepEqual(metrics.ram, {
        used: 1024,
        total: 8192,
        percent: 12.5,
        available: 6144,
        cached: 2048,
        swap: { used: 1024, total: 2048 },
    });
    assert.deepEqual(metrics.network, [
        { name: 'eth0', receiveBytesPerSecond: null, transmitBytesPerSecond: null },
    ]);
    assert.equal(metrics.processes, 81);
});

test('Linux network rates use acquisition elapsed time, retain cache timestamps and share requests', async () => {
    let now = 1000;
    let calls = 0;
    const sampler = createDashboardMetricsSampler({
        now: () => now,
        readEpoch: () => 1,
        execute: async () => {
            calls++;
            return extendedLinuxSample(calls === 1 ? baselineCpu : nextCpu, [
                'network ready',
                calls === 1 ? 'net eth0 1000 4000' : 'net eth0 3000 6000',
            ]);
        },
    });
    const first = await sampler.sample('fixture', false);
    now = 3000;
    assert.equal(await sampler.sample('fixture', false), first);
    now = 5000;
    const refresh = sampler.sample('fixture', false);
    assert.equal(refresh, sampler.sample('fixture', false));
    assert.deepEqual((await refresh).network, [
        { name: 'eth0', receiveBytesPerSecond: 500, transmitBytesPerSecond: 500 },
    ]);
    assert.equal(calls, 2);
});

test('Linux network counter resets, new interfaces and unavailable samples require a fresh baseline', async () => {
    let now = 0;
    let index = 0;
    const fields = [
        ['network ready', 'net eth0 1000 2000', 'net lo 100 100'],
        ['network ready', 'net eth0 900 2100', 'net lo 130 100'],
        ['network ready', 'net eth0 1200 2400', 'net added0 3000 6000'],
        ['network unavailable'],
        ['network ready', 'net eth0 1500 2700'],
        ['network ready', 'net eth0 1800 3000'],
    ];
    const sampler = createDashboardMetricsSampler({
        now: () => now,
        readEpoch: () => 1,
        execute: async () => extendedLinuxSample(baselineCpu, fields[index++]),
    });
    await sampler.sample('fixture', false);
    now += DASHBOARD_SAMPLE_TTL_MS;
    assert.deepEqual((await sampler.sample('fixture', false)).network, [
        { name: 'eth0', receiveBytesPerSecond: null, transmitBytesPerSecond: null },
        { name: 'lo', receiveBytesPerSecond: 10, transmitBytesPerSecond: 0 },
    ]);
    now += DASHBOARD_SAMPLE_TTL_MS;
    assert.deepEqual((await sampler.sample('fixture', false)).network, [
        { name: 'eth0', receiveBytesPerSecond: 100, transmitBytesPerSecond: 100 },
        { name: 'added0', receiveBytesPerSecond: null, transmitBytesPerSecond: null },
    ]);
    now += DASHBOARD_SAMPLE_TTL_MS;
    assert.equal((await sampler.sample('fixture', false)).network, null);
    now += DASHBOARD_SAMPLE_TTL_MS;
    assert.equal((await sampler.sample('fixture', false)).network?.[0].receiveBytesPerSecond, null);
    now += DASHBOARD_SAMPLE_TTL_MS;
    assert.equal((await sampler.sample('fixture', false)).network?.[0].receiveBytesPerSecond, 100);
});

test('Linux network baselines never cross hosts, reconnects or an idle retention boundary', async () => {
    let now = 0;
    let epoch = 1;
    let counter = 1000;
    const sampler = createDashboardMetricsSampler({
        now: () => now,
        readEpoch: () => epoch,
        execute: async () =>
            extendedLinuxSample(baselineCpu, ['network ready', `net eth0 ${counter} ${counter}`]),
    });
    await sampler.sample('first', false);
    now += DASHBOARD_SAMPLE_TTL_MS;
    counter = 1300;
    assert.equal((await sampler.sample('second', false)).network?.[0].receiveBytesPerSecond, null);
    assert.equal((await sampler.sample('first', false)).network?.[0].receiveBytesPerSecond, 100);
    epoch = 2;
    counter = 1600;
    assert.equal((await sampler.sample('first', false)).network?.[0].receiveBytesPerSecond, null);
    now += DASHBOARD_CPU_BASELINE_TTL_MS;
    counter = 1900;
    assert.equal((await sampler.sample('first', false)).network?.[0].receiveBytesPerSecond, null);
});

test('late previous-epoch network counters cannot replace the live baseline', async () => {
    let now = 0;
    let epoch = 1;
    let calls = 0;
    const old = deferred();
    const sampler = createDashboardMetricsSampler({
        now: () => now,
        readEpoch: () => epoch,
        execute: async () => {
            calls++;
            return calls === 1
                ? old.promise
                : extendedLinuxSample(baselineCpu, [
                      'network ready',
                      calls === 2 ? 'net eth0 500 500' : 'net eth0 800 800',
                  ]);
        },
    });
    const obsolete = sampler.sample('fixture', false);
    const rejected = assert.rejects(obsolete, /superseded/);
    await Promise.resolve();
    epoch = 2;
    await sampler.sample('fixture', false);
    old.resolve(extendedLinuxSample(baselineCpu, ['network ready', 'net eth0 100 100']));
    await rejected;
    now += DASHBOARD_SAMPLE_TTL_MS;
    assert.equal((await sampler.sample('fixture', false)).network?.[0].receiveBytesPerSecond, 100);
});

test('malformed or incomplete Linux extensions do not shift or invent legacy metrics', async () => {
    for (const extension of [
        '\nnet eth0 1 2',
        '\n__ZYNC_DASHBOARD_V1__\ncores 8',
        '\n__ZYNC_DASHBOARD_V1__\ncores 8\n__ZYNC_DASHBOARD_V1__\n__ZYNC_DASHBOARD_END__',
    ]) {
        const sampler = createDashboardMetricsSampler({
            readEpoch: () => 1,
            execute: async () => linuxOutput + extension,
        });
        const metrics = await sampler.sample('fixture', false);
        assert.deepEqual(metrics.cpuDetails, { cores: null, loadAverage: null, iowait: null });
        assert.equal(metrics.network, null);
        assert.equal(metrics.ram.available, null);
        assert.equal(metrics.info.os, 'Fixture Linux');
        assert.equal(metrics.processes, 81);
    }
});

test('empty POSIX summary slots preserve adjacent readings and remain unavailable', async () => {
    const lines = extendedLinuxSample('', ['cores 8', 'mem MemAvailable 6291456']).split('\n');
    for (const index of [1, 2, 3, 4, 7]) {
        lines[index] = '';
    }
    const sampler = createDashboardMetricsSampler({
        readEpoch: () => 1,
        execute: async () => lines.join('\n'),
    });
    const metrics = await sampler.sample('fixture', false);
    assert.equal(metrics.cpu, null);
    assert.equal(metrics.cpuDetails.cores, 8);
    assert.deepEqual(metrics.ram, {
        used: null,
        total: null,
        percent: null,
        available: 6144,
        cached: null,
        swap: null,
    });
    assert.deepEqual(metrics.disk, { used: null, total: null, percent: null });
    assert.equal(metrics.processes, null);
    assert.equal(metrics.uptime, '');
    assert.deepEqual(metrics.info, { os: 'Fixture Linux', kernel: '6.0-fixture', arch: '' });
});

test('misaligned framed POSIX replies fail before caching data from the wrong rows', async () => {
    let calls = 0;
    const output = extendedLinuxSample(baselineCpu, ['cores 8']);
    const sampler = createDashboardMetricsSampler({
        readEpoch: () => 1,
        execute: async () => (++calls === 1 ? output.replace('100G 20G 20%\n', '') : output),
    });
    await assert.rejects(sampler.sample('fixture', false), /Invalid POSIX dashboard summary rows/);
    const metrics = await sampler.sample('fixture', false);
    assert.equal(metrics.cpu, null);
    assert.equal(metrics.info.os, 'Fixture Linux');
    assert.deepEqual(metrics.disk, { used: '20G', total: '100G', percent: 20 });
    assert.equal(calls, 2);
});

test('measured zero summary values remain distinct from missing data', async () => {
    const sampler = createDashboardMetricsSampler({
        readEpoch: () => 1,
        execute: async () =>
            JSON.stringify({
                totalMem: 8192,
                usedMem: 0,
                diskSize: 100 * 1024 ** 3,
                diskFree: 100 * 1024 ** 3,
                processes: 0,
            }),
    });
    const metrics = await sampler.sample('fixture', true);
    assert.deepEqual(metrics.ram, { used: 0, total: 8192, percent: 0, ...unavailableMemory });
    assert.deepEqual(metrics.disk, { used: '0G', total: '100G', percent: 0 });
    assert.equal(metrics.processes, 0);
});

test('invalid optional fields and duplicate interfaces remain unavailable, while configured zero swap is real', async () => {
    const sampler = createDashboardMetricsSampler({
        readEpoch: () => 1,
        execute: async () =>
            extendedLinuxSample(baselineCpu, [
                'cores 0',
                'load 1 invalid 3',
                'mem MemAvailable -1',
                'mem Cached 999999999',
                'mem SwapTotal 0',
                'mem SwapFree 0',
                'network ready',
                'net eth0 1 2',
                'net eth0 3 4',
            ]),
    });
    const metrics = await sampler.sample('fixture', false);
    assert.deepEqual(metrics.cpuDetails, { cores: null, loadAverage: null, iowait: null });
    assert.equal(metrics.ram.available, null);
    assert.equal(metrics.ram.cached, null);
    assert.deepEqual(metrics.ram.swap, { used: 0, total: 0 });
    assert.equal(metrics.network, null);
});

test('Windows optional CIM details use measured values and retain explicit unsupported fields', async () => {
    const sampler = createDashboardMetricsSampler({
        readEpoch: () => 1,
        execute: async () =>
            JSON.stringify({
                ...JSON.parse(windowsOutput),
                cores: 16,
                availableMem: 6144,
                cachedMem: 512,
                swapUsed: 256,
                swapTotal: 4096,
                network: [
                    {
                        name: 'Ethernet adapter',
                        receiveBytesPerSecond: 1000,
                        transmitBytesPerSecond: 0,
                    },
                ],
            }),
    });
    const metrics = await sampler.sample('fixture', true);
    assert.deepEqual(metrics.cpuDetails, { cores: 16, loadAverage: null, iowait: null });
    assert.deepEqual(metrics.ram, {
        used: 2048,
        total: 8192,
        percent: 25,
        available: 6144,
        cached: 512,
        swap: { used: 256, total: 4096 },
    });
    assert.deepEqual(metrics.network, [
        { name: 'Ethernet adapter', receiveBytesPerSecond: 1000, transmitBytesPerSecond: 0 },
    ]);
});

test('collector interface output is bounded and missing Windows providers are not reported as zero', async () => {
    const sampler = createDashboardMetricsSampler({
        readEpoch: () => 1,
        execute: async () =>
            JSON.stringify({
                ...JSON.parse(windowsOutput),
                cores: -1,
                cachedMem: null,
                availableMem: null,
                swapUsed: null,
                swapTotal: null,
                network: Array.from(
                    { length: DASHBOARD_NETWORK_INTERFACE_LIMIT + 1 },
                    (_, index) => ({
                        name: `eth${index}`,
                        receiveBytesPerSecond: 1,
                        transmitBytesPerSecond: 1,
                    }),
                ),
            }),
    });
    const metrics = await sampler.sample('fixture', true);
    assert.deepEqual(metrics.cpuDetails, { cores: null, loadAverage: null, iowait: null });
    assert.equal(metrics.ram.available, null);
    assert.equal(metrics.ram.cached, null);
    assert.equal(metrics.ram.swap, null);
    assert.equal(metrics.network, null);
});

test('Linux framing accepts CRLF without losing optional fields or legacy positions', async () => {
    const sampler = createDashboardMetricsSampler({
        readEpoch: () => 1,
        execute: async () =>
            extendedLinuxSample(baselineCpu, [
                'cores 4',
                'load 0.1 0.2 0.3',
                'network ready',
            ]).replaceAll('\n', '\r\n'),
    });
    const metrics = await sampler.sample('fixture', false);
    assert.equal(metrics.cpuDetails.cores, 4);
    assert.deepEqual(metrics.cpuDetails.loadAverage, [0.1, 0.2, 0.3]);
    assert.deepEqual(metrics.network, []);
    assert.equal(metrics.info.os, 'Fixture Linux');
});

test('unsafe and negative network counters do not fabricate rates and recover only after valid adjacency', async () => {
    let now = 0;
    let index = 0;
    const counters = [
        'net eth0 100 100',
        'net eth0 9007199254740992 400',
        'net eth0 -1 500',
        'net eth0 1000 1000',
        'net eth0 1300 1300',
    ];
    const sampler = createDashboardMetricsSampler({
        now: () => now,
        readEpoch: () => 1,
        execute: async () => extendedLinuxSample(baselineCpu, ['network ready', counters[index++]]),
    });
    for (const expected of [null, null, null, null, 100]) {
        assert.equal(
            (await sampler.sample('fixture', false)).network?.[0].receiveBytesPerSecond,
            expected,
        );
        now += DASHBOARD_SAMPLE_TTL_MS;
    }
});
