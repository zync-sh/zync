/** Tracks which SSH hosts have a live entry in the Tauri connections map. */

const liveEpochByConnection = new Map<string, number>();
let nextLiveEpoch = 0;

/** Assigns a fresh transport identity even after an offline interval removed the previous one. */
export function markConnectionBackendLive(connectionId: string): number {
    const epoch = ++nextLiveEpoch;
    liveEpochByConnection.set(connectionId, epoch);
    return epoch;
}

/** Invalidates transport-bound work before asynchronous disconnect cleanup completes. */
export function markConnectionBackendOffline(connectionId: string): void {
    liveEpochByConnection.delete(connectionId);
}

/** Returns the current runtime transport identity without retaining offline host records. */
export function getConnectionBackendEpoch(connectionId: string): number | undefined {
    return liveEpochByConnection.get(connectionId);
}

/** Indicates whether the frontend currently owns a live native SSH connection entry. */
export function isConnectionBackendLive(connectionId: string): boolean {
    return liveEpochByConnection.has(connectionId);
}
