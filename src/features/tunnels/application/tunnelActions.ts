import type { TunnelConfig } from '../../../components/tunnel/TunnelCard';

export type StartTunnelById = (tunnelId: string, connectionId: string) => Promise<void>;
export type StopTunnelById = (tunnelId: string, connectionId: string) => Promise<void>;
export type SaveTunnelConfig = (tunnel: TunnelConfig) => Promise<void>;

export async function startTunnelConfig(
    tunnel: TunnelConfig,
    startTunnel: StartTunnelById,
): Promise<void> {
    await startTunnel(tunnel.id, tunnel.connectionId);
}

export async function stopTunnelConfig(
    tunnel: TunnelConfig,
    stopTunnel: StopTunnelById,
): Promise<void> {
    await stopTunnel(tunnel.id, tunnel.connectionId);
}

export async function revertTunnelOriginalPort(
    tunnel: TunnelConfig,
    saveTunnel: SaveTunnelConfig,
): Promise<TunnelConfig | null> {
    if (!tunnel.originalPort) return null;

    const portKey = tunnel.type === 'remote' ? 'remotePort' : 'localPort';
    const revertedTunnel = {
        ...tunnel,
        [portKey]: tunnel.originalPort,
        originalPort: undefined,
        status: 'stopped',
        error: undefined,
    } as TunnelConfig;

    await saveTunnel(revertedTunnel);
    return revertedTunnel;
}