import {
    getAutoStartTunnels,
    type AutoStartTunnelLike,
    type StartTunnelFn,
    type TunnelErrorLogger,
} from '../../connections/application/tunnelAutoStartService.js';

const activeBeforeDisconnect = new Map<string, string[]>();

export function snapshotActiveTunnelsForReconnect(
    connectionId: string,
    tunnels: Array<{ id: string; status?: string }>,
): void {
    const activeIds = tunnels
        .filter((tunnel) => tunnel.status === 'active')
        .map((tunnel) => tunnel.id);

    if (activeIds.length > 0) {
        activeBeforeDisconnect.set(connectionId, activeIds);
    }
}

function getReconnectTunnelIds(connectionId: string): string[] {
    return activeBeforeDisconnect.get(connectionId) ?? [];
}

function clearReconnectTunnelIds(connectionId: string): void {
    activeBeforeDisconnect.delete(connectionId);
}

export type RestartTunnelsAfterConnectOptions = {
    connectionId: string;
    tunnels: AutoStartTunnelLike[];
    startTunnel: StartTunnelFn;
    onTunnelError: TunnelErrorLogger;
};

/** Restart auto-start tunnels plus any that were active before the last disconnect. */
export async function restartTunnelsAfterConnect({
    connectionId,
    tunnels,
    startTunnel,
    onTunnelError,
}: RestartTunnelsAfterConnectOptions): Promise<number> {
    const remembered = getReconnectTunnelIds(connectionId);
    const autoStartIds = getAutoStartTunnels(tunnels).map((tunnel) => tunnel.id);
    const toStart = [...new Set([...remembered, ...autoStartIds])];
    clearReconnectTunnelIds(connectionId);

    if (toStart.length === 0) {
        return 0;
    }

    const results = await Promise.allSettled(
        toStart.map((tunnelId) => startTunnel(tunnelId, connectionId)),
    );

    let successCount = 0;
    results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
            successCount += 1;
            return;
        }
        const tunnel = tunnels.find((entry) => entry.id === toStart[index]);
        onTunnelError(
            tunnel ?? { id: toStart[index], name: toStart[index] },
            result.reason,
        );
    });

    return successCount;
}