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
): Promise<VncBridge> {
    return invoke('vnc_start', { sessionId, connectionId, port });
}

/** Start a direct viewer, optionally using the saved profile's native Vault binding. */
export function openDirectVncBridge(
    sessionId: string,
    host: string,
    port: number,
    profileId?: string,
): Promise<VncBridge> {
    return invoke('vnc_start_direct', { sessionId, host, port, ...(profileId && { profileId }) });
}

/** Retire a bridge even if the renderer cancelled before native startup completed. */
export function closeVncBridge(sessionId: string): Promise<void> {
    return invoke('vnc_stop', { sessionId });
}
