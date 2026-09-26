import { useCallback, useEffect, useRef, useState } from 'react';
import type { ShellEntry } from '../lib/shells/types';
import { loadRemoteShellCache, saveRemoteShellCache } from '../lib/shells/cache';
import { ShellDiscoveryGate } from '../lib/shells/discoveryGate';

/** Local platform shell cache (single machine, single app run). */
const localCache: { windows: ShellEntry[] | null; unix: ShellEntry[] | null } = {
    windows: null,
    unix: null,
};

interface UseAvailableShellsArgs {
    isWindows: boolean;
    connectionId?: string;
    remoteReady?: boolean;
}

export interface UseAvailableShellsResult {
    shells: ShellEntry[];
    isLoading: boolean;
    error: string | null;
    refetch: () => void;
}

function initialShells(isLocal: boolean, localCacheKey: 'windows' | 'unix', connectionId: string): ShellEntry[] {
    if (isLocal) {
        return localCache[localCacheKey] ?? [];
    }
    return loadRemoteShellCache(connectionId) ?? [];
}

function formatShellFetchError(err: unknown): string {
    return err instanceof Error ? err.message : String(err || 'Unable to load shells');
}

/**
 * Detects available shells.
 *
 * Local: auto-fetched on mount, cached in-memory for the app session.
 * Remote: lazy — caller must invoke `refetch()` (typically when the shell
 * picker dropdown is opened). Results are cached per-connection in
 * localStorage so subsequent app launches show the list instantly.
 */
export function useAvailableShells({ isWindows, connectionId = 'local', remoteReady = false }: UseAvailableShellsArgs): UseAvailableShellsResult {
    const isLocal = connectionId === 'local';
    const localCacheKey = isWindows ? 'windows' : 'unix';
    const scopeKey = `${isLocal ? 'local' : 'remote'}:${localCacheKey}:${connectionId}`;

    const [shells, setShells] = useState<ShellEntry[]>(() => initialShells(isLocal, localCacheKey, connectionId));
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Track in-flight fetch so concurrent refetch calls coalesce.
    const inFlightRef = useRef<Promise<void> | null>(null);
    const scopeKeyRef = useRef(scopeKey);
    const isMountedRef = useRef(true);
    const discoveryGate = useRef(new ShellDiscoveryGate(scopeKey, isLocal || remoteReady));

    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
        };
    }, []);

    const fetchShells = useCallback(async () => {
        const gate = discoveryGate.current;
        if (!isMountedRef.current || gate.scope !== scopeKey) return;
        const generation = gate.request();
        // Remember picker demand, but never invoke remote discovery while offline.
        if (generation === null) return;
        if (inFlightRef.current) return inFlightRef.current;
        const fetchScopeKey = scopeKey;
        const isCurrent = () => isMountedRef.current
            && scopeKeyRef.current === fetchScopeKey && gate.isCurrent(generation);

        const task = (async () => {
            if (!isCurrent()) return;
            setIsLoading(true);
            setError(null);
            try {
                const command = isLocal
                    ? (isWindows ? 'shell:getWindowsShells' : 'shell:getAvailableShells')
                    : 'shell:getConnectionShells';
                const detected: ShellEntry[] = isLocal
                    ? await window.ipcRenderer.invoke(command)
                    : await window.ipcRenderer.invoke(command, { connectionId });

                if (!isCurrent()) return;

                setShells(detected);
                if (isLocal) {
                    localCache[localCacheKey] = detected;
                } else {
                    saveRemoteShellCache(connectionId, detected);
                }
            } catch (err) {
                if (!isCurrent()) return;
                // On failure keep whatever we already have visible (cached or empty).
                // The caller can re-invoke refetch() — typically the next time the
                // user reopens the dropdown.
                console.warn('[useAvailableShells] fetch failed:', err);
                setError(formatShellFetchError(err));
            } finally {
                if (isCurrent()) {
                    setIsLoading(false);
                    inFlightRef.current = null;
                }
            }
        })();

        inFlightRef.current = task;
        return task;
    }, [isLocal, isWindows, connectionId, localCacheKey, scopeKey]);

    useEffect(() => {
        const scopeChanged = scopeKeyRef.current !== scopeKey;
        const changed = discoveryGate.current.update(scopeKey, isLocal || remoteReady);
        scopeKeyRef.current = scopeKey;
        if (changed) {
            inFlightRef.current = null;
            if (scopeChanged) setShells(initialShells(isLocal, localCacheKey, connectionId));
            setError(null);
            setIsLoading(false);
        }
        // A picker opened while offline resumes once ready. After a reconnect,
        // refresh only if discovery was previously requested for this host.
        if (!isLocal && changed && discoveryGate.current.shouldRetry()) void fetchShells();
    }, [scopeKey, isLocal, remoteReady, connectionId, localCacheKey, fetchShells]);

    // Local shells: auto-fetch on mount (cheap, used for the `+` default).
    // Remote shells: stay lazy — caller drives via refetch().
    useEffect(() => {
        if (!isLocal) return;
        if (localCache[localCacheKey] !== null) return;
        void fetchShells();
    }, [isLocal, localCacheKey, fetchShells]);

    const refetch = useCallback(() => {
        void fetchShells();
    }, [fetchShells]);

    return { shells, isLoading, error, refetch };
}
