import type { TunnelType } from '../domain/tunnelTypes';

export const TUNNEL_TYPE_META: Record<TunnelType, { label: string; flag: string }> = {
    local: { label: 'Local', flag: '-L' },
    remote: { label: 'Remote', flag: '-R' },
    dynamic: { label: 'Dynamic', flag: '-D' },
};

export function tunnelHostDisplayLabel(hostLabel: string | undefined): string | null {
    const label = hostLabel?.trim();
    return label || null;
}

/** Remote-side endpoint for flow display on tunnel cards. */
export function formatTunnelServiceEndpoint(
    remoteHost: string,
    port: number,
): { host: string; port: number; tagged: boolean } {
    const h = remoteHost.trim();
    if (h === '127.0.0.1' || h === 'localhost') {
        return { host: 'localhost', port, tagged: false };
    }
    return { host: h, port, tagged: false };
}

export interface TunnelFlowDisplay {
    source: string;
    /** Host side of the arrow — plain host or connection display name. */
    targetHost: string;
    targetPort: number | null;
    targetTagged: boolean;
    inbound: boolean;
}

export function formatTunnelFlow(
    tunnel: {
        type: TunnelType;
        localPort: number;
        remoteHost: string;
        remotePort: number;
    },
    hostLabel?: string,
): TunnelFlowDisplay {
    if (tunnel.type === 'dynamic') {
        return {
            source: String(tunnel.localPort),
            targetHost: 'SOCKS proxy',
            targetPort: null,
            targetTagged: false,
            inbound: false,
        };
    }

    if (tunnel.type === 'local') {
        const endpoint = formatTunnelServiceEndpoint(tunnel.remoteHost, tunnel.remotePort);
        return {
            source: String(tunnel.localPort),
            targetHost: endpoint.host,
            targetPort: endpoint.port,
            targetTagged: endpoint.tagged,
            inbound: false,
        };
    }

    const label = tunnelHostDisplayLabel(hostLabel);
    return {
        source: String(tunnel.remotePort),
        targetHost: label ?? 'localhost',
        targetPort: tunnel.localPort,
        targetTagged: !!label,
        inbound: true,
    };
}

export function tunnelCopyAddress(tunnel: {
    type: TunnelType;
    localPort: number;
    bindAddress?: string;
}, socksUrl: string): string {
    if (tunnel.type === 'dynamic') return socksUrl;
    return `localhost:${tunnel.localPort}`;
}