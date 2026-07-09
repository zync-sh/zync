import type { TunnelConfig } from '../../../components/tunnel/TunnelCard';

const PORT_CONFLICT_PATTERN =
    /Port (\d+) is already in use.*?Port (\d+) is available/;

export type PortConflictSuggestion = {
    tunnel: TunnelConfig;
    currentPort: number;
    suggestedPort: number;
};

export function parsePortConflictError(
    error: unknown,
    tunnel: TunnelConfig,
): PortConflictSuggestion | null {
    const message = error instanceof Error ? error.message : String(error ?? '');
    const match = message.match(PORT_CONFLICT_PATTERN);
    if (!match) return null;

    return {
        tunnel,
        currentPort: Number.parseInt(match[1], 10),
        suggestedPort: Number.parseInt(match[2], 10),
    };
}

export function tunnelWithSwappedPort(tunnel: TunnelConfig, port: number): TunnelConfig {
    const portKey = tunnel.type === 'remote' ? 'remotePort' : 'localPort';
    const currentPort = tunnel[portKey as 'localPort' | 'remotePort'];
    return {
        ...tunnel,
        [portKey]: port,
        originalPort: tunnel.originalPort ?? currentPort,
    } as TunnelConfig;
}