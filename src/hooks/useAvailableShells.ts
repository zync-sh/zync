import { useCallback, useEffect, useRef, useState } from 'react';
import type { ShellEntry } from '../lib/shells/types';
import { loadRemoteShellCache, saveRemoteShellCache } from '../lib/shells/cache';

/** Local platform shell cache (single machine, single app run). */
const localCache: { windows: ShellEntry[] | null; unix: ShellEntry[] | null } = {
    windows: null,
    unix: null,
};

interface UseAvailableShellsArgs {
    isWindows: boolean;
    connectionId?: string;
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
export function useAvailableShells({ isWindows, connectionId = 'local' }: UseAvailableShellsArgs): UseAvailableShellsResult {
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

    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
        };
    }, []);

    useEffect(() => {
        if (scopeKeyRef.current === scopeKey) return;
        scopeKeyRef.current = scopeKey;
        inFlightRef.current = null;
        if (!isMountedRef.current) return;
        setShells(initialShells(isLocal, localCacheKey, connectionId));
        setError(null);
        setIsLoading(false);
    }, [connectionId, isLocal, localCacheKey, scopeKey]);

    const fetchShells = useCallback(async () => {
        if (inFlightRef.current) return inFlightRef.current;
        const fetchScopeKey = scopeKey;

        const task = (async () => {
            if (!isMountedRef.current || scopeKeyRef.current !== fetchScopeKey) return;
            setIsLoading(true);
            setError(null);
            try {
                const command = isLocal
                    ? (isWindows ? 'shell:getWindowsShells' : 'shell:getAvailableShells')
                    : 'shell:getConnectionShells';
                const detected: ShellEntry[] = isLocal
                    ? await window.ipcRenderer.invoke(command)
                    : await window.ipcRenderer.invoke(command, { connectionId });

                if (!isMountedRef.current || scopeKeyRef.current !== fetchScopeKey) return;

                setShells(detected);
                if (isLocal) {
                    localCache[localCacheKey] = detected;
                } else {
                    saveRemoteShellCache(connectionId, detected);
                }
            } catch (err) {
                if (!isMountedRef.current || scopeKeyRef.current !== fetchScopeKey) return;
                // On failure keep whatever we already have visible (cached or empty).
                // The caller can re-invoke refetch() — typically the next time the
                // user reopens the dropdown.
                console.warn('[useAvailableShells] fetch failed:', err);
                setError(formatShellFetchError(err));
            } finally {
                if (isMountedRef.current && scopeKeyRef.current === fetchScopeKey) {
                    setIsLoading(false);
                    inFlightRef.current = null;
                }
            }
        })();

        inFlightRef.current = task;
        return task;
    }, [isLocal, isWindows, connectionId, localCacheKey, scopeKey]);

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
