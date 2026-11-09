import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
    createDashboardDetailsSampler,
    DASHBOARD_FILESYSTEM_REFRESH_MS,
    DASHBOARD_PROCESS_REFRESH_MS,
    DASHBOARD_PROCESS_RESULT_LIMIT,
    DASHBOARD_PROCESS_SCAN_LIMIT,
    LINUX_MOUNTS_AWK,
    LINUX_PROCESS_DETAILS_COMMAND,
} from '../../src/components/dashboard/dashboardDetails.js';

type NameBytes = string | Uint8Array;
type ProcessRow = [number, NameBytes, string, number | null, number | null];
type FilesystemRow = [
    NameBytes,
    NameBytes,
    string,
    number | null,
    number | null,
    number | null,
    string | number | null,
    string | number | null,
];
const windowsMarker = 'ZYNC_DASHBOARD_DETAILS_V1';
const linuxMarker = 'ZYNC_DASHBOARD_DETAILS_V2';
const firstClock = '100,0,0,900,0,0,0,0';
const nextClock = '180,0,0,1020,0,0,0,0';

/** Encode the original bytes, including byte sequences JavaScript strings cannot represent. */
function hex(value: NameBytes): string {
    return (typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value)).toString(
        'hex',
    );
}

/** Build native-protocol fixtures without exposing parser internals to tests. */
function processFrame(
    rows: ProcessRow[],
    clock = firstClock,
    options: { windows?: boolean; cpus?: number; supported?: boolean; truncated?: boolean } = {},
): string {
    return [
        options.windows ? windowsMarker : linuxMarker,
        'processes',
        options.windows ? 'windows' : 'linux',
        options.supported === false ? '0' : '1',
        clock,
        options.cpus ?? '',
        ...rows.flatMap(([pid, name, identity, cpu, memory]) => [
            'P',
            pid,
            options.windows ? name : hex(name),
            identity,
            cpu ?? '',
            memory ?? '',
        ]),
        'END',
        options.truncated ? '1' : '0',
        '',
    ].join('\0');
}

/** Filesystem records deliberately retain whitespace and control characters in path fields. */
function filesystemFrame(
    rows: FilesystemRow[],
    options: { supported?: boolean; truncated?: boolean } = {},
): string {
    return [
        linuxMarker,
        'filesystems',
        'linux',
        options.supported === false ? '0' : '1',
        ...rows.flatMap(([source, mount, ...rest]) => [
            'F',
            hex(source),
            hex(mount),
            ...rest.map((value) => value ?? ''),
        ]),
        'END',
        options.truncated ? '1' : '0',
        '',
    ].join('\0');
}

test('sort changes share one acquisition but select different top-ten candidates', async () => {
    let calls = 0;
    const rows: ProcessRow[] = Array.from({ length: 20 }, (_, index) => [
        index + 1,
        'process ' + index,
        '1',
        index,
        (index + 1) * 1024,
    ]);
    const sampler = createDashboardDetailsSampler({
        readEpoch: () => 1,
        execute: async () => {
            calls++;
            return processFrame(rows);
        },
    });
    const [cpu, memory] = await Promise.all([
        sampler.processes('host', false, 'cpu'),
        sampler.processes('host', false, 'memory'),
    ]);
    assert.equal(calls, 1);
    assert.equal(cpu.items.length, DASHBOARD_PROCESS_RESULT_LIMIT);
    assert.equal(cpu.items[0].pid, 20);
    assert.equal(memory.items[0].pid, 20);
    assert.equal(cpu.truncated, false);
    assert.ok(cpu.items.every((item) => item.cpu === null));
});

test('Linux interval percentages preserve names and use whole-host capacity', async () => {
    let now = 0;
    const sampler = createDashboardDetailsSampler({
        now: () => now,
        readEpoch: () => 1,
        execute: async () =>
            now === 0
                ? processFrame([
                      [1, 'name ) with\nspaces', '42', 100, 4096],
                      [2, 'worker', '50', 10, 8192],
                  ])
                : processFrame(
                      [
                          [1, 'name ) with\nspaces', '42', 120, 4096],
                          [2, 'worker', '50', 70, 8192],
                      ],
                      nextClock,
                  ),
    });
    const first = await sampler.processes('host', false, 'cpu');
    assert.equal(first.items[0].cpu, null);
    now = DASHBOARD_PROCESS_REFRESH_MS;
    const next = await sampler.processes('host', false, 'cpu');
    assert.equal(next.items[0].pid, 2);
    assert.equal(next.items[0].cpu, 30);
    assert.equal(next.items[1].cpu, 10);
    assert.equal(next.items[1].name, 'name ) with\nspaces');
    assert.equal(next.sampledAt, now);
});

test('Linux process CPU accepts an I/O wait decrease only with a valid host interval', async () => {
    let now = 0;
    let clock = '100,0,0,900,50,0,0,0';
    const sampler = createDashboardDetailsSampler({
        now: () => now,
        readEpoch: () => 1,
        execute: async () =>
            processFrame(
                [[1, 'worker', '42', 100 + (20 * now) / DASHBOARD_PROCESS_REFRESH_MS, 4096]],
                clock,
            ),
    });
    await sampler.processes('host', false, 'cpu');
    now = DASHBOARD_PROCESS_REFRESH_MS;
    clock = '180,0,0,1030,40,0,0,0';
    assert.equal((await sampler.processes('host', false, 'cpu')).items[0].cpu, 10);
    now += DASHBOARD_PROCESS_REFRESH_MS;
    clock = '220,0,0,1035,20,0,0,0';
    assert.equal((await sampler.processes('host', false, 'cpu')).items[0].cpu, null);
});

test('PID reuse, unavailable fields and decreasing counters never fabricate process CPU', async () => {
    let now = 0;
    const sampler = createDashboardDetailsSampler({
        now: () => now,
        readEpoch: () => 1,
        execute: async () =>
            now === 0
                ? processFrame([
                      [1, 'original', '42', 100, 4096],
                      [2, 'worker', '50', 100, 8192],
                  ])
                : processFrame(
                      [
                          [1, 'replacement', '99', 120, null],
                          [2, 'worker', '50', 90, 8192],
                          [3, 'new', '', null, null],
                      ],
                      nextClock,
                  ),
    });
    await sampler.processes('host', false, 'cpu');
    now = DASHBOARD_PROCESS_REFRESH_MS;
    const next = await sampler.processes('host', false, 'cpu');
    assert.ok(next.items.every((item) => item.cpu === null));
    assert.equal(next.items.find((item) => item.pid === 1)?.memoryBytes, null);
});

test('host counter reset and an expired baseline require a new interval', async () => {
    let now = 0;
    let clock = firstClock;
    const sampler = createDashboardDetailsSampler({
        now: () => now,
        readEpoch: () => 1,
        execute: async () => processFrame([[1, 'worker', '42', now / 100, 4096]], clock),
    });
    await sampler.processes('host', false, 'cpu');
    now = DASHBOARD_PROCESS_REFRESH_MS;
    clock = '1,0,0,9,0,0,0,0';
    assert.equal((await sampler.processes('host', false, 'cpu')).items[0].cpu, null);
    now += DASHBOARD_PROCESS_REFRESH_MS;
    clock = '101,0,0,109,0,0,0,0';
    assert.equal((await sampler.processes('host', false, 'cpu')).items[0].cpu, 50);
    now += DASHBOARD_PROCESS_REFRESH_MS * 6;
    assert.equal((await sampler.processes('host', false, 'cpu')).items[0].cpu, null);
});

test('Windows uses CPU-second deltas, logical processor count and start-time identity', async () => {
    let now = 0;
    const sampler = createDashboardDetailsSampler({
        now: () => now,
        readEpoch: () => {
            throw new Error('Local sampling must not require an SSH epoch');
        },
        execute: async () =>
            processFrame(
                [[100, 'Windows worker', '2026-11-08T00:00:00Z', now ? 20 : 10, 65536]],
                now ? '110' : '100',
                { windows: true, cpus: 4 },
            ),
    });
    assert.equal((await sampler.processes('local', true, 'cpu')).items[0].cpu, null);
    now = DASHBOARD_PROCESS_REFRESH_MS;
    assert.equal((await sampler.processes('local', true, 'cpu')).items[0].cpu, 25);
});

test('Linux process names retain Unicode and tolerate invalid UTF-8 and empty comm values', async () => {
    const sampler = createDashboardDetailsSampler({
        readEpoch: () => 1,
        execute: async () =>
            processFrame([
                [1, 'worker \u2603', '1', 0, 4096],
                [2, Uint8Array.of(0xff), '2', 0, 4096],
                [3, '', '3', 0, 4096],
            ]),
    });
    const sample = await sampler.processes('host', false, 'cpu');
    assert.deepEqual(
        sample.items.map((item) => item.name),
        ['worker \u2603', '\ufffd', 'Unnamed process'],
    );
});

test('filesystems retain source/mount whitespace, inode use and explicit unavailable readings', async () => {
    let now = 0;
    let calls = 0;
    const sampler = createDashboardDetailsSampler({
        now: () => now,
        readEpoch: () => 1,
        execute: async () => {
            calls++;
            return filesystemFrame(
                [
                    [
                        '/dev/volume with space',
                        '/data/a\nfolder',
                        'ext4',
                        1000,
                        300,
                        600,
                        '34%',
                        '9%',
                    ],
                    ['other', '/other', '', null, null, null, null, null],
                ],
                { truncated: true },
            );
        },
    });
    const first = await sampler.filesystems('host', false);
    assert.equal(first.items[0].source, '/dev/volume with space');
    assert.equal(first.items[0].mount, '/data/a\nfolder');
    assert.equal(first.items[0].percent, 34);
    assert.equal(first.items[0].inodePercent, 9);
    assert.equal(first.items[0].availableBytes, 600);
    assert.equal(first.items[1].totalBytes, null);
    assert.equal(first.truncated, true);
    now = DASHBOARD_FILESYSTEM_REFRESH_MS - 1;
    assert.equal(await sampler.filesystems('host', false), first);
    assert.equal(calls, 1);
    now++;
    await sampler.filesystems('host', false);
    assert.equal(calls, 2);
});

test('filesystem records with identical display names retain their distinct byte paths', async () => {
    const sampler = createDashboardDetailsSampler({
        readEpoch: () => 1,
        execute: async () =>
            filesystemFrame([
                ['source', Uint8Array.of(0x2f, 0xfe), 'ext4', 10, 3, 7, '30%', null],
                ['source', Uint8Array.of(0x2f, 0xff), 'ext4', 20, 3, 17, '15%', null],
            ]),
    });
    const { items } = await sampler.filesystems('host', false);
    assert.deepEqual(
        items.map((item) => item.mount),
        ['/\ufffd', '/\ufffd'],
    );
    assert.notEqual(items[0].key, items[1].key);
    assert.deepEqual(
        items.map((item) => item.totalBytes),
        [10, 20],
    );
});

test('unsupported providers are explicit and do not invent empty healthy data', async () => {
    const sampler = createDashboardDetailsSampler({
        readEpoch: () => 1,
        execute: async (_id, command) =>
            command === LINUX_PROCESS_DETAILS_COMMAND
                ? processFrame([], '', { supported: false })
                : filesystemFrame([], { supported: false }),
    });
    const processes = await sampler.processes('host', false, 'cpu');
    const filesystems = await sampler.filesystems('host', false);
    assert.equal(processes.supported, false);
    assert.equal(filesystems.supported, false);
    assert.deepEqual(processes.items, []);
    assert.deepEqual(filesystems.items, []);
});

test('incomplete, oversized and duplicate-PID frames fail without poisoning retries', async () => {
    const tooMany: ProcessRow[] = Array.from(
        { length: DASHBOARD_PROCESS_SCAN_LIMIT + 1 },
        (_, index) => [index + 1, 'p', '1', 0, 0],
    );
    for (const invalid of [
        processFrame([[1, 'worker', '1', 0, 0]]).slice(0, -1),
        'noise' + processFrame([]),
        processFrame([
            [1, 'a', '1', 0, 0],
            [1, 'b', '1', 0, 0],
        ]),
        processFrame(tooMany),
        processFrame([[1, 'bad\0name', '1', 0, 0]]),
        processFrame([[1, 'worker', '1', 0, 0]]).replace(hex('worker'), 'f'),
    ]) {
        let calls = 0;
        const sampler = createDashboardDetailsSampler({
            readEpoch: () => 1,
            execute: async () =>
                ++calls === 1 ? invalid : processFrame([[1, 'worker', '1', 0, 0]]),
        });
        await assert.rejects(sampler.processes('host', false, 'cpu'));
        assert.equal((await sampler.processes('host', false, 'cpu')).items.length, 1);
        assert.equal(calls, 2);
    }
});

test('replacement before submission prevents native execution and rejects inactive targets', async () => {
    let epoch: number | undefined = 1;
    let calls = 0;
    const sampler = createDashboardDetailsSampler({
        readEpoch: () => epoch,
        execute: async () => {
            calls++;
            return processFrame([]);
        },
    });
    const pending = sampler.processes('host', false, 'cpu');
    epoch = 2;
    await assert.rejects(pending, /superseded/);
    assert.equal(calls, 0);
    epoch = undefined;
    await assert.rejects(sampler.processes('host', false, 'cpu'), /no longer active/);
    assert.equal(calls, 0);
});

test('late previous transport results cannot replace or delete the current detail sample', async () => {
    let epoch = 1;
    let resolve!: (output: string) => void;
    let calls = 0;
    const sampler = createDashboardDetailsSampler({
        readEpoch: () => epoch,
        execute: async () =>
            ++calls === 1
                ? new Promise<string>((yes) => {
                      resolve = yes;
                  })
                : processFrame([[2, 'current', '1', 0, 0]]),
    });
    const old = sampler.processes('host', false, 'cpu');
    const rejected = assert.rejects(old, /superseded/);
    await Promise.resolve();
    epoch = 2;
    const current = await sampler.processes('host', false, 'cpu');
    resolve(processFrame([[1, 'old', '1', 0, 0]]));
    await rejected;
    assert.deepEqual((await sampler.processes('host', false, 'cpu')).items, current.items);
    assert.equal(calls, 2);
});

test('a failed refresh clears the CPU baseline and does not retain rejected requests', async () => {
    let now = 0;
    let calls = 0;
    const sampler = createDashboardDetailsSampler({
        now: () => now,
        readEpoch: () => 1,
        execute: async () => {
            calls++;
            if (calls === 2) {
                throw new Error('temporary failure');
            }
            return processFrame(
                [[1, 'worker', '1', calls * 10, 1000]],
                calls === 1 ? firstClock : nextClock,
            );
        },
    });
    await sampler.processes('host', false, 'cpu');
    now = DASHBOARD_PROCESS_REFRESH_MS;
    await assert.rejects(sampler.processes('host', false, 'cpu'), /temporary failure/);
    assert.equal((await sampler.processes('host', false, 'cpu')).items[0].cpu, null);
});

interface AwkRunner {
    executable: string;
    arguments: string[];
}

/** Prefer native awk; Windows can exercise the same production program through an installed WSL. */
function availableAwk(): AwkRunner | undefined {
    for (const candidate of [
        { executable: 'awk', arguments: [] },
        { executable: 'wsl.exe', arguments: ['--exec', 'env', 'LC_ALL=C', 'awk'] },
    ]) {
        const result = spawnSync(
            candidate.executable,
            [...candidate.arguments, 'BEGIN { print "zync-awk-ready" }'],
            {
                encoding: 'utf8',
                timeout: 10_000,
                windowsHide: true,
            },
        );
        if (result.status === 0 && result.stdout.trim() === 'zync-awk-ready') {
            return candidate;
        }
    }
    return undefined;
}

test('production mount selection probes only visible local filesystems', async (context) => {
    const runner = availableAwk();
    if (!runner) {
        context.skip(
            'Neither native awk nor an executable WSL awk is available in this environment',
        );
        return;
    }
    const cases = [
        {
            name: 'remote root blocks a local data mount',
            input: '1 0 0:1 / / rw - nfs server:/root rw\n2 1 8:1 / /data rw - ext4 /dev/sdb rw\n',
            output: 'T 0\n',
        },
        {
            name: 'remote subtree blocks its local child while preserving local root',
            input: '1 0 8:1 / / rw - ext4 /dev/sda rw\n2 1 0:1 / /net rw - nfs server:/data rw\n3 2 8:2 / /net/data rw - xfs /dev/sdb rw\n',
            output: 'F 2f6465762f736461 2f / ext4\nT 0\n',
        },
        {
            name: 'local root permits its local data mount',
            input: '1 0 8:1 / / rw - ext4 /dev/sda rw\n2 1 8:2 / /data rw - xfs /dev/sdb rw\n',
            output: 'F 2f6465762f736461 2f / ext4\nF 2f6465762f736462 2f64617461 /data xfs\nT 0\n',
        },
        {
            name: 'a stacked mount covers the old filesystem and its hidden child',
            input:
                '1 0 8:1 / / rw - ext4 /dev/sda rw\n' +
                '4 2 8:4 / /data rw - ext4 /dev/top rw\n' +
                '3 2 8:3 / /data/logs rw - xfs /dev/hidden rw\n' +
                '2 1 8:2 / /data rw - xfs /dev/covered rw\n' +
                '5 4 8:5 / /data/live rw - xfs /dev/live rw\n',
            output:
                'F 2f6465762f736461 2f / ext4\n' +
                'F 2f6465762f746f70 2f64617461 /data ext4\n' +
                'F 2f6465762f6c697665 2f646174612f6c697665 /data/live xfs\n' +
                'T 0\n',
        },
        {
            name: 'whitespace and backslashes are framed as bytes and escaped for the probe',
            input: '1 0 8:1 / /logs\\040space\\134name\\012 rw - ext4 /dev/source\\011name rw\n',
            output:
                'F ' +
                hex('/dev/source\tname') +
                ' ' +
                hex('/logs space\\name\n') +
                ' /logs\\0040space\\0134name\\0012 ext4\nT 0\n',
        },
        {
            name: 'an incomplete topology cannot drive probes',
            input:
                '1 0 8:1 / / rw - ext4 /dev/sda rw\n' +
                '2 1 8:2 / /data rw - xfs /dev/sdb rw\n'.repeat(4096),
            output: 'T 1\n',
        },
    ];
    for (const fixture of cases) {
        await context.test(fixture.name, () => {
            const result = spawnSync(
                runner.executable,
                [...runner.arguments, '-v', 'limit=64', LINUX_MOUNTS_AWK],
                {
                    input: fixture.input,
                    env: { ...process.env, LC_ALL: 'C' },
                    encoding: 'utf8',
                    timeout: 10_000,
                    windowsHide: true,
                },
            );
            assert.equal(result.status, 0, result.stderr || String(result.error ?? 'awk failed'));
            assert.equal(result.stdout, fixture.output);
        });
    }
});
