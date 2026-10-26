import { useAppStore } from '../../../store/useAppStore';
import { createUserTunnelActions } from './userTunnelActions';

/** Global and per-host UI share admission; callbacks always read current store state after prompts or reconnects. */
export const userTunnelActions = createUserTunnelActions({
    connectionStatus: connectionId => useAppStore.getState().connections.find(connection => connection.id === connectionId)?.status,
    subscribeConnectionStatus: (connectionId, listener) => useAppStore.subscribe((state, previous) => {
        const status = state.connections.find(connection => connection.id === connectionId)?.status;
        if (status !== previous.connections.find(connection => connection.id === connectionId)?.status) listener(status);
    }),
    tunnelStatus: tunnel => useAppStore.getState().tunnels[tunnel.connectionId]?.find(saved => saved.id === tunnel.id)?.status,
    connect: connectionId => useAppStore.getState().connect(connectionId, { preserveWorkspace: true }),
    refreshTunnels: connectionId => useAppStore.getState().loadTunnels(connectionId, { throwOnError: true }),
    startTunnel: (id, connectionId) => useAppStore.getState().startTunnel(id, connectionId),
});
