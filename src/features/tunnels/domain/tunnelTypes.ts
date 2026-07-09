/** Canonical tunnel type union — keep in sync with `SavedTunnel.tunnel_type` (Rust). */
export type TunnelType = 'local' | 'remote' | 'dynamic';

/** Sentinel values persisted for dynamic (SOCKS) forwards — no fixed remote target. */
export const DYNAMIC_REMOTE_HOST = '*';
export const DYNAMIC_REMOTE_PORT = 0;

export function isDynamicTunnel(type: TunnelType): boolean {
    return type === 'dynamic';
}

/** Port field used for local-side binds (local + dynamic). */
export function localBindPortKey(type: TunnelType): 'localPort' | 'remotePort' {
    return type === 'remote' ? 'remotePort' : 'localPort';
}

export function defaultTunnelName(
    type: TunnelType,
    localPort: number,
    remoteHost: string,
    remotePort: number,
): string {
    if (type === 'dynamic') {
        return `SOCKS ${localPort}`;
    }
    if (type === 'local') {
        return `Local ${localPort} -> ${remoteHost}:${remotePort}`;
    }
    return `Remote ${remotePort} -> Local ${localPort}`;
}

export function socks5Url(bindAddress: string | undefined, localPort: number): string {
    const host =
        bindAddress && bindAddress !== '0.0.0.0' ? bindAddress : '127.0.0.1';
    return `socks5://${host}:${localPort}`;
}