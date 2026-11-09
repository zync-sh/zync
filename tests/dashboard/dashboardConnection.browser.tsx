import { Activity } from 'lucide-react';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';

import { Dashboard } from '../../src/components/dashboard/Dashboard';
import {
    LINUX_FILESYSTEM_DETAILS_COMMAND,
    LINUX_PROCESS_DETAILS_COMMAND,
    WINDOWS_FILESYSTEM_DETAILS_COMMAND,
    WINDOWS_PROCESS_DETAILS_COMMAND,
} from '../../src/components/dashboard/dashboardDetails';
import type { DashboardHistoryPoint } from '../../src/components/dashboard/dashboardMetrics';
import { ResourceWidget } from '../../src/components/dashboard/ResourceWidget';
import {
    markConnectionBackendLive,
    markConnectionBackendOffline,
} from '../../src/lib/terminal/connectionBackend';
import { useAppStore } from '../../src/store/useAppStore';

let calls = 0;
let connects = 0;
let cancellations = 0;
let holdNext = false;
const pendingSamples: Array<{ resolve(): void; reject(error: Error): void }> = [];
const pendingMetadata: Array<() => void> = [];
let metadataWrites = 0;
let linuxSamples = 0;
let processCalls = 0;
let filesystemCalls = 0;
let holdNextProcess = false;
const pendingProcessSamples: Array<{ resolve(): void; reject(error: Error): void }> = [];
const processIntervals = new Map<string, number>();

/** Advance aggregate kernel counters by a measured interval with 30% busy time. */
function nextLinuxSample(): string {
    const interval = linuxSamples++;
    const cpu = `cpu ${100 + interval * 20} 0 ${50 + interval * 10} ${800 + interval * 60} ${20 + interval * 10} 0 0 0 0 0`;
    return [
        cpu,
        '8192 1024',
        '3 hours',
        '81',
        '100G 20G 20%',
        'Fixture Linux',
        '6.0-fixture',
        'x86_64',
        '__ZYNC_DASHBOARD_V1__',
        'cores 4',
        'load 0.3 0.2 0.1',
        'mem MemAvailable 6291456',
        'mem Cached 1048576',
        'mem SwapTotal 2097152',
        'mem SwapFree 1572864',
        'network ready',
        `net eth0 ${1000 + interval * 3072} ${2000 + interval * 1536}`,
        'net lo 0 0',
        '__ZYNC_DASHBOARD_END__',
    ].join('\n');
}

/** Frame process names as fields and advance CPU totals without exposing real host processes. */
function nextProcessSample(connectionId: string, windows: boolean): string {
    const interval = processIntervals.get(connectionId) ?? 0;
    processIntervals.set(connectionId, interval + 1);
    const aggregate = [
        1000 + interval * 400,
        0,
        200 + interval * 100,
        5000 + interval * 1500,
        0,
        0,
        0,
        0,
    ].join(',');
    const fields = [
        windows ? 'ZYNC_DASHBOARD_DETAILS_V1' : 'ZYNC_DASHBOARD_DETAILS_V2',
        'processes',
        windows ? 'windows' : 'linux',
        '1',
        windows ? String(100 + interval * 10) : aggregate,
        windows ? '4' : '',
    ];
    for (let pid = 1; pid <= 12; pid++) {
        const name =
            pid === 1
                ? 'cpu-burner fixture'
                : pid === 12
                  ? 'memory-heavy <fixture>'
                  : `worker ${pid}`;
        const delta = pid === 1 ? 200 : pid === 12 ? 1 : 24 - pid;
        const ticks = 50 + interval * delta;
        fields.push(
            'P',
            String(pid),
            windows ? name : linuxDetailText(name),
            String(1000 + pid),
            String(windows ? ticks / 50 : ticks),
            String((pid === 12 ? 512 : pid) * 1024 ** 2),
        );
    }
    return [...fields, 'END', '1', ''].join('\0');
}

/** Match the Linux collector's ASCII transport for literal UTF-8 field values. */
function linuxDetailText(value: string): string {
    return Array.from(new TextEncoder().encode(value), (byte) =>
        byte.toString(16).padStart(2, '0'),
    ).join('');
}

/** Preserve literal spaces and markup-like names in the same NUL framing as the collector. */
function filesystemSample(windows: boolean): string {
    const text = (value: string) => (windows ? value : linuxDetailText(value));
    return [
        windows ? 'ZYNC_DASHBOARD_DETAILS_V1' : 'ZYNC_DASHBOARD_DETAILS_V2',
        'filesystems',
        windows ? 'windows' : 'linux',
        '1',
        'F',
        text('/dev/fixture disk café <unsafe>'),
        text('/srv/data with spaces'),
        windows ? 'NTFS' : 'ext4',
        String(100 * 1024 ** 3),
        String(25 * 1024 ** 3),
        String(70 * 1024 ** 3),
        '25',
        '0',
        'F',
        text('/dev/empty-fixture'),
        text('/srv/empty fixture'),
        windows ? 'NTFS' : 'ext4',
        String(1024 ** 3),
        '0',
        String(1024 ** 3),
        '0',
        '',
        'END',
        '0',
        '',
    ].join('\0');
}

/** Simulate tab visibility through the production document-visibility listener. */
function setFixtureDocumentHidden(hidden: boolean): void {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event('visibilitychange'));
}

/** Give both the dashboard and its portal the same document-level fixture palette. */
function applyFixtureTheme(mode: 'light' | 'dark'): void {
    const palette =
        mode === 'light'
            ? {
                  bg: '#f4f4f5',
                  panel: '#ffffff',
                  surface: '#e4e4e7',
                  border: '#d4d4d8',
                  text: '#18181b',
                  muted: '#52525b',
                  accent: '#4f46e5',
              }
            : {
                  bg: '#09090b',
                  panel: '#18181b',
                  surface: '#27272a',
                  border: '#3f3f46',
                  text: '#e4e4e7',
                  muted: '#a1a1aa',
                  accent: '#797bce',
              };
    for (const [key, color] of Object.entries(palette)) {
        document.documentElement.style.setProperty(`--color-app-${key}`, color);
    }
    document.body.dataset.fixtureTheme = mode;
}
const windowsSample = JSON.stringify({
    cpu: 17,
    cores: 8,
    availableMem: 6144,
    cachedMem: 512,
    swapUsed: 128,
    swapTotal: 1024,
    network: [
        { name: 'Ethernet fixture', receiveBytesPerSecond: 4096, transmitBytesPerSecond: 2048 },
    ],
    totalMem: 8192,
    usedMem: 2048,
    diskSize: 100 * 1024 ** 3,
    diskFree: 25 * 1024 ** 3,
    uptime: '2d 3h 4m',
    processes: 92,
    os: 'Fixture Windows',
    kernel: 'fixture-version',
    arch: 'fixture-arch',
});
let attempt: { connectionId: string; cancelled: boolean; resolve(): void } | undefined;
const host = {
    id: 'dashboard-fixture',
    name: 'Monitoring lab',
    host: 'dashboard.invalid',
    username: 'observer',
    port: 22,
    icon: 'linux',
    status: 'disconnected' as const,
    lastConnected: 1,
};
const timeoutError =
    'Connection timed out while connecting to dashboard.invalid:22 (synthetic socket timeout).';
const unknownError =
    'Synthetic transport diagnostic: opaque failure 0xF17; fixture-only details that do not belong in the summary.';
const metricError =
    'Synthetic metrics refresh failed: the dashboard retained its last successful sample; inspect this complete diagnostic in Metric details.';

/** Only the current noncancelled fixture attempt may publish a successful connection. */
function completeConnection() {
    if (!attempt) {
        return;
    }
    if (attempt.cancelled) {
        document.body.dataset.ignoredLateCompletion = 'true';
    } else {
        markConnectionBackendLive(attempt.connectionId);
        useAppStore.setState((state) => ({
            connections: state.connections.map((item) =>
                item.id === attempt?.connectionId
                    ? {
                          ...item,
                          status: 'connected',
                          lastConnected: (item.lastConnected ?? 1) + 1,
                          lastError: undefined,
                      }
                    : item,
            ),
        }));
    }
    attempt.resolve();
}

/** Replace only the transport identity while retaining the host's connected UI status. */
function replaceConnectionTransport(): void {
    markConnectionBackendLive(host.id);
    useAppStore.setState((state) => ({
        connections: state.connections.map((connection) =>
            connection.id === host.id
                ? { ...connection, lastConnected: (connection.lastConnected ?? 1) + 1 }
                : connection,
        ),
    }));
}

/** Disposable UI-only telemetry; this fixture never opens a transport or runs a real command. */
window.ipcRenderer = {
    async invoke(channel: string, args: { connectionId: string; command: string }) {
        if (channel === 'connections:save') {
            document.body.dataset.metadataWrites = String(++metadataWrites);
            return new Promise<void>((resolve) => pendingMetadata.push(resolve));
        }
        if (channel !== 'ssh:exec') {
            throw new Error(`Unexpected dashboard fixture command: ${channel}`);
        }
        const windowsProcesses = args.command === WINDOWS_PROCESS_DETAILS_COMMAND;
        if (args.command === LINUX_PROCESS_DETAILS_COMMAND || windowsProcesses) {
            document.body.dataset.processCalls = String(++processCalls);
            document.body.dataset.lastProcessTarget = args.connectionId;
            const sample = nextProcessSample(args.connectionId, windowsProcesses);
            if (holdNextProcess) {
                holdNextProcess = false;
                document.body.dataset.pendingProcesses = '1';
                return new Promise<string>((resolve, reject) =>
                    pendingProcessSamples.push({ resolve: () => resolve(sample), reject }),
                );
            }
            return sample;
        }
        const windowsFilesystems = args.command === WINDOWS_FILESYSTEM_DETAILS_COMMAND;
        if (args.command === LINUX_FILESYSTEM_DETAILS_COMMAND || windowsFilesystems) {
            document.body.dataset.filesystemCalls = String(++filesystemCalls);
            document.body.dataset.lastFilesystemTarget = args.connectionId;
            return filesystemSample(windowsFilesystems);
        }
        if (args.command === 'df -h' || args.command?.includes('Get-PSDrive')) {
            if (typeof args.connectionId !== 'string') {
                throw new Error('Quick Actions must supply connectionId');
            }
            document.body.dataset.lastQuickActionTarget = args.connectionId;
            document.body.dataset.lastQuickActionCommand = args.command;
            return 'Quick action fixture output';
        }
        document.body.dataset.metricCalls = String(++calls);
        document.body.dataset.lastMetricTarget = args.connectionId;
        const sample = args.connectionId === 'local' ? windowsSample : nextLinuxSample();
        if (holdNext) {
            holdNext = false;
            document.body.dataset.pendingSamples = '1';
            return new Promise<string>((resolve, reject) =>
                pendingSamples.push({ resolve: () => resolve(sample), reject }),
            );
        }
        return sample;
    },
} as typeof window.ipcRenderer;
useAppStore.setState({
    activeConnectionId: host.id,
    connections: [host],
    connect: async (id) => {
        document.body.dataset.connectCalls = String(++connects);
        useAppStore.setState((state) => ({
            connections: state.connections.map((item) =>
                item.id === id ? { ...item, status: 'connecting' } : item,
            ),
        }));
        await new Promise<void>((resolve) => {
            attempt = { connectionId: id, cancelled: false, resolve };
        });
    },
    cancelConnect: async (id) => {
        document.body.dataset.cancelCalls = String(++cancellations);
        if (attempt?.connectionId !== id || attempt.cancelled) {
            return;
        }
        attempt.cancelled = true;
        markConnectionBackendOffline(id);
        useAppStore.setState((state) => ({
            connections: state.connections.map((item) =>
                item.id === id ? { ...item, status: 'disconnected' } : item,
            ),
        }));
        attempt.resolve();
    },
    openConnectionModal: (id) => {
        document.body.dataset.editedHost = id ?? '';
    },
    disconnect: async (id) => {
        document.body.dataset.unexpectedDisconnect = id;
        markConnectionBackendOffline(id);
        useAppStore.setState((state) => ({
            connections: state.connections.map((item) =>
                item.id === id ? { ...item, status: 'disconnected' } : item,
            ),
        }));
    },
});

useAppStore.subscribe((state) => {
    document.body.dataset.currentIcon =
        state.connections.find((connection) => connection.id === host.id)?.icon || '';
});

/** Connection controls simulate completed/cancelled host flows without bypassing production dashboard behavior. */
function Fixture() {
    const [visible, setVisible] = useState(true);
    const [second, setSecond] = useState(false);
    const [target, setTarget] = useState(host.id);
    const [paneWidth, setPaneWidth] = useState<number | undefined>();
    const changeStatus = (status: 'disconnected' | 'error', lastError?: string) => {
        markConnectionBackendOffline(host.id);
        useAppStore.setState((state) => ({
            connections: state.connections.map((item) => ({
                ...item,
                status,
                lastError: status === 'error' ? lastError : undefined,
            })),
        }));
    };
    return (
        <StrictMode>
            <div className="flex h-screen flex-col bg-app-bg text-app-text">
                <div
                    aria-label="Fixture controls"
                    className="flex max-h-40 shrink-0 flex-wrap gap-3 overflow-auto border-b border-app-border p-2 text-xs"
                >
                    <button onClick={completeConnection}>Complete connection fixture</button>
                    <button onClick={replaceConnectionTransport}>Replace transport fixture</button>
                    <button onClick={() => changeStatus('disconnected')}>Disconnect fixture</button>
                    <button onClick={() => changeStatus('error', timeoutError)}>
                        Fail connection fixture
                    </button>
                    <button onClick={() => changeStatus('error', unknownError)}>
                        Unknown failure fixture
                    </button>
                    <button onClick={() => setVisible((value) => !value)}>
                        Toggle visibility fixture
                    </button>
                    <button onClick={() => useAppStore.setState({ connections: [] })}>
                        Remove host fixture
                    </button>
                    <button
                        onClick={() =>
                            useAppStore.setState({ activeConnectionId: 'other-workspace' })
                        }
                    >
                        Activate other workspace fixture
                    </button>
                    <button onClick={() => setSecond(true)}>Show second dashboard fixture</button>
                    <button onClick={() => setPaneWidth(340)}>Narrow dashboard pane fixture</button>
                    <button onClick={() => setPaneWidth(700)}>Medium dashboard pane fixture</button>
                    <button onClick={() => setPaneWidth(undefined)}>
                        Wide dashboard pane fixture
                    </button>
                    <button onClick={() => applyFixtureTheme('light')}>Light theme fixture</button>
                    <button onClick={() => applyFixtureTheme('dark')}>Dark theme fixture</button>
                    <button onClick={() => setFixtureDocumentHidden(true)}>
                        Hide document fixture
                    </button>
                    <button onClick={() => setFixtureDocumentHidden(false)}>
                        Show document fixture
                    </button>
                    <button
                        onClick={() => {
                            holdNextProcess = true;
                        }}
                    >
                        Hold next process sample fixture
                    </button>
                    <button
                        onClick={() => {
                            pendingProcessSamples.shift()?.resolve();
                            document.body.dataset.pendingProcesses = String(
                                pendingProcessSamples.length,
                            );
                        }}
                    >
                        Release process sample fixture
                    </button>
                    <button
                        onClick={() => {
                            pendingProcessSamples
                                .shift()
                                ?.reject(new Error('Connection not found'));
                            document.body.dataset.pendingProcesses = String(
                                pendingProcessSamples.length,
                            );
                        }}
                    >
                        Reject process sample fixture
                    </button>
                    <button
                        onClick={() =>
                            useAppStore.setState((state) => ({
                                connections: state.connections.map((connection) => ({
                                    ...connection,
                                    icon: undefined,
                                })),
                            }))
                        }
                    >
                        Clear sampled icon fixture
                    </button>
                    <button onClick={() => pendingMetadata.shift()?.()}>
                        Release metadata save fixture
                    </button>
                    <button
                        onClick={() => {
                            holdNext = true;
                        }}
                    >
                        Hold next sample fixture
                    </button>
                    <button
                        onClick={() => {
                            holdNext = true;
                            setTarget('local');
                            setSecond(true);
                        }}
                    >
                        Show two local dashboards fixture
                    </button>
                    <button
                        onClick={() => {
                            pendingSamples.shift()?.resolve();
                            document.body.dataset.pendingSamples = String(pendingSamples.length);
                        }}
                    >
                        Release sample fixture
                    </button>
                    <button
                        onClick={() => {
                            pendingSamples.shift()?.reject(new Error(metricError));
                            document.body.dataset.pendingSamples = String(pendingSamples.length);
                        }}
                    >
                        Reject sample fixture
                    </button>
                    <button
                        onClick={() => {
                            pendingSamples.shift()?.reject(new Error('Connection not found'));
                            document.body.dataset.pendingSamples = String(pendingSamples.length);
                        }}
                    >
                        Reject old sample fixture
                    </button>
                </div>
                <main
                    data-dashboard-fixture
                    className="min-h-0 flex-1"
                    style={{ width: paneWidth, maxWidth: '100%' }}
                >
                    <Dashboard
                        connectionId={target}
                        isVisible={visible}
                    />
                    {second && (
                        <Dashboard
                            connectionId={target}
                            isVisible={visible}
                        />
                    )}
                </main>
            </div>
        </StrictMode>
    );
}
const historyStart = Date.UTC(2026, 10, 8, 12);

/** Supply known acquisition times so chart geometry can be checked without polling or IPC. */
function historyPoints(values: number[], offsets = values.map((_, index) => index * 3000)) {
    return values.map(
        (value, index): DashboardHistoryPoint => ({
            sampledAt: historyStart + offsets[index],
            value,
        }),
    );
}

const historyCases = [
    { title: 'Flat full usage', data: historyPoints([100, 100, 100]) },
    { title: 'Flat steady usage', data: historyPoints([43.4, 43.4, 43.4]) },
    { title: 'Rising usage', data: historyPoints([0, 50, 100]) },
    { title: 'Uneven timing', data: historyPoints([20, 40, 60], [0, 3000, 12_000]) },
    {
        title: 'Interrupted usage',
        data: historyPoints([20, 30, 80, 90], [0, 3000, 33_000, 36_000]),
    },
    { title: 'One measured sample', data: historyPoints([37.5]) },
    {
        title: 'Bounded history',
        data: [
            ...historyPoints(Array.from({ length: 25 }, (_, index) => index * 4)),
            { sampledAt: historyStart + 72_000, value: 96 },
            { sampledAt: Number.NaN, value: 60 },
            { sampledAt: historyStart + 75_000, value: Number.NaN },
        ],
    },
];

/** Exercise the production chart using static observations, with no real host connection. */
function HistoryFixture() {
    const [narrow, setNarrow] = useState(false);
    return (
        <div className="min-h-screen bg-app-bg p-4 text-app-text">
            <div className="mb-4 flex flex-wrap gap-4 text-sm">
                <button onClick={() => setNarrow(true)}>Narrow history fixture</button>
                <button onClick={() => setNarrow(false)}>Wide history fixture</button>
                <button onClick={() => applyFixtureTheme('light')}>Light history fixture</button>
                <button onClick={() => applyFixtureTheme('dark')}>Dark history fixture</button>
            </div>
            <main
                aria-label="History examples"
                style={{
                    width: narrow ? 300 : undefined,
                    maxWidth: '100%',
                    gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : undefined,
                }}
                className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3"
            >
                {historyCases.map(({ title, data }) => (
                    <ResourceWidget
                        key={title}
                        title={title}
                        value={`${
                            data
                                .filter(
                                    (point) =>
                                        Number.isFinite(point.sampledAt) &&
                                        Number.isFinite(point.value),
                                )
                                .at(-1)?.value
                        }%`}
                        subtext="Measured fixture observations"
                        icon={Activity}
                        data={data}
                    />
                ))}
            </main>
        </div>
    );
}

const showHistory = new URLSearchParams(window.location.search).get('history') === '1';
if (showHistory) {
    applyFixtureTheme('dark');
}
createRoot(document.getElementById('root')!).render(showHistory ? <HistoryFixture /> : <Fixture />);
