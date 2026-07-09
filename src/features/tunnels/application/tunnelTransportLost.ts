import { markConnectionBackendOffline } from '../../../lib/terminal/connectionBackend';
import { suspendAllTerminalsForConnection } from '../../../lib/terminal/suspendAllTerminals';
import { useAppStore } from '../../../store/useAppStore';

type TransportLostPayload = {
    connectionId?: string;
};

const handledConnections = new Set<string>();

/** Stop active tunnels and sync connection state when the SSH transport drops unexpectedly. */
export function handleConnectionTransportLost(payload: TransportLostPayload): void {
    const connectionId = payload?.connectionId;
    if (!connectionId || handledConnections.has(connectionId)) {
        return;
    }
    handledConnections.add(connectionId);

    const store = useAppStore.getState();

    // Suspend before terminal-exit from SSH EOF — otherwise tabs are auto-closed.
    suspendAllTerminalsForConnection(store.terminals[connectionId], { panelHide: true });
    markConnectionBackendOffline(connectionId);

    void store.handleTransportLost(connectionId).finally(() => {
        handledConnections.delete(connectionId);
    });
}

export function registerTunnelTransportLostListener(): () => void {
    const handler = (_: unknown, payload: TransportLostPayload) => {
        handleConnectionTransportLost(payload);
    };

    window.ipcRenderer.on('connection:transport-lost', handler);
    return () => {
        window.ipcRenderer.off('connection:transport-lost', handler);
    };
}