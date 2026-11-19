import { invoke } from '@tauri-apps/api/core';

interface VncBridge {
    sessionId: string;
    websocketUrl: string;
}

/** Start one viewer bridge bound to the current SSH transport and remote loopback port. */
export function openVncBridge(
    sessionId: string,
    connectionId: string,
    port: number,
    profile?: { id: string; useVault: boolean },
): Promise<VncBridge> {
    return invoke('vnc_start', {
        sessionId,
        connectionId,
        port,
        ...(profile && { profileId: profile.id, useVault: profile.useVault }),
    });
}

/** Start a direct viewer with its required TLS mode and optional native Vault binding. */
export function openDirectVncBridge(
    sessionId: string,
    host: string,
    port: number,
    options: { profileId?: string; tlsUsername?: string } = {},
): Promise<VncBridge> {
    return invoke('vnc_start_direct', { sessionId, host, port, ...options });
}

/** Retire a bridge even if the renderer cancelled before native startup completed. */
export function closeVncBridge(sessionId: string): Promise<void> {
    return invoke('vnc_stop', { sessionId });
}
