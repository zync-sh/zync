import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import { Dashboard } from '../../src/components/dashboard/Dashboard';
import {
    markConnectionBackendLive,
    markConnectionBackendOffline,
} from '../../src/lib/terminal/connectionBackend';
import { useAppStore } from '../../src/store/useAppStore';

let calls = 0;
let connects = 0;
let cancellations = 0;
let holdNext = false;
const pendingSamples: Array<{ resolve(value: string): void; reject(error: Error): void }> = [];
const pendingMetadata: Array<() => void> = [];
let metadataWrites = 0;
const linuxSample = '0.3\n8192 1024\n3 hours\n81\n100G 20G 20%\nFixture Linux\n6.0-fixture\nx86_64';
const windowsSample = JSON.stringify({
    cpu: 17,
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
        document.body.dataset.metricCalls = String(++calls);
        document.body.dataset.lastMetricTarget = args.connectionId;
        if (holdNext) {
            holdNext = false;
            document.body.dataset.pendingSamples = '1';
            return new Promise<string>((resolve, reject) =>
                pendingSamples.push({ resolve, reject }),
            );
        }
        return args.connectionId === 'local' ? windowsSample : linuxSample;
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
                    className="flex flex-wrap gap-3 border-b border-app-border p-2 text-xs"
                >
                    <button onClick={completeConnection}>Complete connection fixture</button>
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
                            pendingSamples
                                .shift()
                                ?.resolve(target === 'local' ? windowsSample : linuxSample);
                            document.body.dataset.pendingSamples = String(pendingSamples.length);
                        }}
                    >
                        Release sample fixture
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
createRoot(document.getElementById('root')!).render(<Fixture />);
