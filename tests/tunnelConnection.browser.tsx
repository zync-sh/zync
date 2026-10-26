import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider as TooltipProvider } from '@radix-ui/react-tooltip';
import { TunnelManager } from '../src/components/tunnel/TunnelManager';
import { GlobalTunnelList } from '../src/components/tunnel/GlobalTunnelList';
import type { TunnelConfig } from '../src/components/tunnel/TunnelCard';
import { useAppStore } from '../src/store/useAppStore';
import '../src/index.css';
import './uiOverlays.browser.css';

const host = { id: 'tunnel-fixture', name: 'Forwarding lab', host: 'tunnel.invalid', username: 'observer', port: 22,
    icon: 'linux', status: 'disconnected' as const, lastConnected: 1 };
const saved = new Map<string, TunnelConfig>([['saved-api', { id: 'saved-api', connectionId: host.id, name: 'Saved API', type: 'local',
    localPort: 41000, remoteHost: '127.0.0.1', remotePort: 3000, bindAddress: '127.0.0.1', status: 'stopped' }]]);
const trace: string[] = [];
let finishConnect: ((connected: boolean) => void) | undefined;

/** An observable, synthetic IPC boundary records forbidden stop-all calls without contacting a host or native storage. */
function record(command: string) { trace.push(command); document.body.dataset.tunnelTrace = JSON.stringify(trace); }
window.ipcRenderer = {
    async invoke(command: string, argument?: unknown) {
        record(command);
        if (command === 'tunnel:list' || command === 'tunnel:getAll') return [...saved.values()].map(item => ({ ...item }));
        if (command === 'tunnel:save') { const tunnel = argument as TunnelConfig; saved.set(tunnel.id, { ...tunnel }); return; }
        if (command === 'tunnel:delete') { saved.delete(String(argument)); return; }
        if (command === 'tunnel:start' || command === 'tunnel:stop') {
            if (command === 'tunnel:start' && useAppStore.getState().connections[0]?.status !== 'connected') throw new Error('Fixture transport is offline');
            const tunnel = saved.get(String(argument));
            if (!tunnel) throw new Error('Fixture saved forward does not exist');
            saved.set(tunnel.id, { ...tunnel, status: command === 'tunnel:start' ? 'active' : 'stopped' }); return;
        }
        if (command === 'tunnel:reconcileConnection') return;
        throw new Error(`Unexpected tunnel fixture command: ${command}`);
    },
    send() {}, on() { return () => {}; }, off() {},
} as typeof window.ipcRenderer;

/** Publish mocked persistence/runtime state while retaining production components and the real user-action coordinator. */
function publish() { useAppStore.setState({ tunnels: { [host.id]: [...saved.values()].map(item => ({ ...item })) } }); }
function status(status: 'connected' | 'connecting' | 'disconnected') {
    useAppStore.setState(state => ({ connections: state.connections.map(item => ({ ...item, status })) }));
}
useAppStore.setState({ activeConnectionId: host.id, connections: [host], tunnels: {},
    connect: async id => {
        if (id !== host.id) throw new Error('Unexpected fixture host');
        record('connect:begin'); status('connecting');
        await new Promise<void>(resolve => { finishConnect = connected => {
            record(connected ? 'connect:completed' : 'connect:cancelled'); status(connected ? 'connected' : 'disconnected');
            finishConnect = undefined; resolve();
        }; });
    },
    disconnect: async () => { record('disconnect'); status('disconnected'); },
    loadTunnels: async (id, options) => {
        try { await window.ipcRenderer.invoke('tunnel:list', id); publish(); }
        catch (error) { if (options?.throwOnError) throw error; }
    },
    loadAllTunnels: async () => { await window.ipcRenderer.invoke('tunnel:getAll'); publish(); },
    saveTunnel: async tunnel => { await window.ipcRenderer.invoke('tunnel:save', tunnel); publish(); },
    deleteTunnel: async id => { await window.ipcRenderer.invoke('tunnel:delete', id); publish(); },
    startTunnel: async id => { await window.ipcRenderer.invoke('tunnel:start', id); publish(); },
    stopTunnel: async id => { await window.ipcRenderer.invoke('tunnel:stop', id); publish(); },
    reconcileTunnelsForConnection: async id => { await window.ipcRenderer.invoke('tunnel:reconcileConnection', id); },
    showToast: (_type, message) => { document.body.dataset.lastTunnelToast = message; },
});

/** Explicit fixture controls own mock connect completion and pane width; mounting either real list performs no remote work. */
function Fixture() {
    const [global, setGlobal] = useState(false);
    const [narrow, setNarrow] = useState(false);
    return <StrictMode><TooltipProvider><div className="flex h-screen flex-col bg-app-bg text-app-text">
        <div aria-label="Fixture controls" className="flex flex-wrap gap-3 border-b border-app-border p-2 text-xs">
            <button onClick={() => finishConnect?.(true)}>Complete connection fixture</button>
            <button onClick={() => finishConnect?.(false)}>Cancel connection fixture</button>
            <button onClick={() => status('disconnected')}>Disconnect fixture</button>
            <button onClick={() => setGlobal(value => !value)}>{global ? 'Show host tunnels fixture' : 'Show global tunnels fixture'}</button>
            <button onClick={() => setNarrow(value => !value)}>Toggle narrow pane fixture</button>
        </div>
        <main data-tunnel-fixture-panel className="min-h-0 min-w-0 flex-1" style={{ width: narrow ? 320 : '100%' }}>
            {global ? <GlobalTunnelList /> : <TunnelManager connectionId={host.id} />}
        </main>
    </div></TooltipProvider></StrictMode>;
}
document.body.dataset.overlayGalleryTheme = 'dark';
createRoot(document.getElementById('root')!).render(<Fixture />);
