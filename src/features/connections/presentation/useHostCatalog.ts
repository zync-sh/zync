import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
    SYNC_STATUS_CHANGED_EVENT,
    type SyncProvider,
    type SyncRemoteHostInventoryItem,
    syncIpc,
} from '../../../vault/syncIpc';
import {
    ensureSyncReadinessListener,
    type HostInventoryAccount,
    useSyncReadinessStore,
} from '../../../vault/useSyncReadinessStore';
import {
    catalogLocationsByLogicalId,
    filterHostCatalog,
    type HostCatalogEntry,
    type HostCatalogFilter,
    type HostLocationTag,
    localConnectionsFromCatalog,
    mergeHostCatalog,
    remoteOnlyCatalogEntries,
    searchHostCatalog,
} from '../domain/hostCatalog';
import {
    CONNECTIONS_CLEARED_EVENT,
    clearAllHostInventoryCaches,
    readHostInventoryCache,
    writeHostInventoryCache,
} from '../domain/hostInventoryCache';
import type { Connection } from '../domain/types';

export type HostInventoryStatus =
    | 'idle'
    | 'loading'
    | 'ready' /** Live fetch succeeded this session window. */
    | 'cached'
    | 'unavailable'
    | 'not_configured'
    | 'locked'
    | 'error';

export interface UseHostCatalogResult {
    filter: HostCatalogFilter;
    setFilter: (filter: HostCatalogFilter) => void;
    entries: HostCatalogEntry[];
    filteredEntries: HostCatalogEntry[];
    localConnections: Connection[];
    remoteOnlyEntries: HostCatalogEntry[];
    locationsByLogicalId: Map<string, HostLocationTag[]>;
    inventoryStatus: HostInventoryStatus;
    /** True when rows include last-known provider data that may be stale. */
    inventoryFromCache: boolean;
    inventoryError?: string;
    /** Last inventory scan stats (for empty-state diagnostics). */
    lastInventoryScan?: { scanned: number; failed: number; skipped: number };
    /** Provider OAuth connected (filters/refresh only make sense when true). */
    providerConnected: boolean;
    providerReady: boolean;
    refreshInventory: () => Promise<void>;
    materializingIds: Set<string>;
    setMaterializing: (logicalId: string, active: boolean) => void;
}

const PRIMARY_PROVIDER: SyncProvider = 'google';

interface InventorySnapshot {
    account: HostInventoryAccount | null;
    hosts: SyncRemoteHostInventoryItem[];
    status: HostInventoryStatus;
    fromCache: boolean;
    error?: string;
    scan?: UseHostCatalogResult['lastInventoryScan'];
}

/** Read inventory only for a verified account. Unknown identities can use live rows only. */
function cachedInventory(
    account: HostInventoryAccount | null,
    status?: HostInventoryStatus,
): InventorySnapshot {
    const hosts = account?.key
        ? (readHostInventoryCache(PRIMARY_PROVIDER, account.key)?.hosts ?? [])
        : [];
    return {
        account,
        hosts,
        status: status ?? (hosts.length ? 'cached' : 'idle'),
        fromCache: hosts.length > 0,
    };
}

/**
 * Loads provider host inventory (when available) and merges with local connections.
 *
 * Location membership is remembered after the first successful list:
 * locking the collection does not clear [google] chips or provider-only rows.
 * Unlock + refresh re-fetches for freshness; lock alone does not require a re-list
 * to know a host still belongs to Google.
 */
export function useHostCatalog(
    connections: Connection[],
    searchTerm: string,
): UseHostCatalogResult {
    useEffect(() => {
        ensureSyncReadinessListener();
    }, []);

    // Shared with Sync & Backup — never re-derive OAuth / encryption separately.
    const readiness = useSyncReadinessStore((s) => s.readiness);
    const account = useSyncReadinessStore((s) => s.hostInventoryAccount);
    const refreshReadiness = useSyncReadinessStore((s) => s.refresh);
    const providerConnected = readiness.isConnected;
    const providerReady = readiness.isProviderReady;

    const [filter, setFilterState] = useState<HostCatalogFilter>('all');
    const [snapshot, setSnapshot] = useState(() => cachedInventory(account));
    const requestSequence = useRef(0);
    const lastRequestedAccount = useRef<HostInventoryAccount | null | undefined>(undefined);
    // Mask an old account's rows in the first render after the identity changes.
    const inventory = useMemo(
        () =>
            snapshot.account === account
                ? snapshot
                : cachedInventory(account, account ? undefined : 'unavailable'),
        [account, snapshot],
    );
    const [materializingIds, setMaterializingIds] = useState<Set<string>>(() => new Set());

    const setMaterializing = useCallback((logicalId: string, active: boolean) => {
        setMaterializingIds((prev) => {
            const next = new Set(prev);
            if (active) {
                next.add(logicalId);
            } else {
                next.delete(logicalId);
            }
            return next;
        });
    }, []);

    const refreshInventory = useCallback(async () => {
        const request = ++requestSequence.current;
        setSnapshot((previous) => (previous.error ? { ...previous, error: undefined } : previous));

        // Use the shared readiness status before selecting a cache or reading Drive.
        await refreshReadiness(PRIMARY_PROVIDER);
        if (request !== requestSequence.current) {
            return;
        }
        const { readiness: next, hostInventoryAccount: activeAccount } =
            useSyncReadinessStore.getState();
        lastRequestedAccount.current = activeAccount;
        if (!activeAccount) {
            setSnapshot(cachedInventory(null, 'unavailable'));
            return;
        }
        if (!next.isEncryptionConfigured || !next.isEncryptionUnlocked) {
            setSnapshot(
                cachedInventory(
                    activeAccount,
                    next.isEncryptionConfigured ? 'locked' : 'not_configured',
                ),
            );
            return;
        }

        const cached = cachedInventory(activeAccount);
        setSnapshot((previous) => {
            if (!cached.fromCache) {
                return { ...cached, status: 'loading' };
            }
            if (previous.account !== activeAccount || previous.hosts.length === 0) {
                return cached;
            }
            const status = previous.status === 'ready' ? 'ready' : 'cached';
            return previous.status === status && !previous.error
                ? previous
                : { ...previous, status, error: undefined };
        });

        // The same email gets a new session after reconnecting.
        const canPublish = () => {
            const state = useSyncReadinessStore.getState();
            return (
                request === requestSequence.current &&
                state.hostInventoryAccount === activeAccount &&
                state.readiness.isProviderReady
            );
        };
        try {
            const result = await syncIpc.hostsRemoteInventory(PRIMARY_PROVIDER);
            if (!canPublish()) {
                return;
            }
            const hosts = result.hosts ?? [];
            const scan = {
                scanned: result.scanned ?? 0,
                failed: result.failed ?? 0,
                skipped: result.skipped ?? 0,
            };
            if (hosts.length === 0 && scan.failed > 0) {
                setSnapshot({
                    account: activeAccount,
                    hosts,
                    status: 'error',
                    fromCache: false,
                    scan,
                    error:
                        `Found ${scan.scanned} host file(s) on Drive but could not decrypt ${scan.failed}. ` +
                        'The collection key on this device does not match the key that encrypted those files. ' +
                        'Using the same passphrase after a full local reset is not enough if the key was regenerated. ' +
                        'Fix: in Sync & Backup, remove this broken link and either recover from a machine that still has the key, ' +
                        'or start a new empty collection and re-upload hosts.',
                });
                return;
            }
            if (activeAccount.key) {
                writeHostInventoryCache({
                    provider: PRIMARY_PROVIDER,
                    accountKey: activeAccount.key,
                    collectionId: result.collectionId,
                    fetchedAt: Date.now(),
                    hosts,
                });
            }
            setSnapshot({ account: activeAccount, hosts, status: 'ready', fromCache: false, scan });
        } catch (error) {
            if (!canPublish()) {
                return;
            }
            setSnapshot({
                ...cachedInventory(activeAccount, 'error'),
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }, [refreshReadiness]);

    useEffect(() => {
        if (lastRequestedAccount.current !== account) {
            void refreshInventory();
        }
    }, [account, refreshInventory]);

    useEffect(
        () => () => {
            requestSequence.current++;
            lastRequestedAccount.current = undefined;
        },
        [],
    );

    useEffect(() => {
        const onSyncStatus = (event: Event) => {
            const detail = (event as CustomEvent<{ provider?: string }>).detail;
            if (detail?.provider && detail.provider !== PRIMARY_PROVIDER) {
                return;
            }
            // Readiness store also refreshes on this event; inventory re-gates off shared state.
            void refreshInventory();
        };
        window.addEventListener(SYNC_STATUS_CHANGED_EVENT, onSyncStatus as EventListener);
        return () => {
            window.removeEventListener(SYNC_STATUS_CHANGED_EVENT, onSyncStatus as EventListener);
        };
    }, [refreshInventory]);

    /**
     * Selecting Remote re-checks readiness + inventory via the shared store.
     */
    const setFilter = useCallback(
        (next: HostCatalogFilter) => {
            setFilterState(next);
            if (next === 'remote') {
                void refreshInventory();
            }
        },
        [refreshInventory],
    );

    // Clear all connections: drop provider inventory from UI until user refreshes.
    // (Do not auto re-fetch here — otherwise Google rows instantly reappear.)
    useEffect(() => {
        const onConnectionsCleared = () => {
            requestSequence.current++;
            clearAllHostInventoryCaches();
            setSnapshot(
                cachedInventory(useSyncReadinessStore.getState().hostInventoryAccount, 'idle'),
            );
        };
        window.addEventListener(CONNECTIONS_CLEARED_EVENT, onConnectionsCleared);
        return () => {
            window.removeEventListener(CONNECTIONS_CLEARED_EVENT, onConnectionsCleared);
        };
    }, []);

    const entries = useMemo(
        () => mergeHostCatalog(connections, inventory.hosts),
        [connections, inventory.hosts],
    );

    const filteredEntries = useMemo(() => {
        const byFilter = filterHostCatalog(entries, filter);
        return searchHostCatalog(byFilter, searchTerm);
    }, [entries, filter, searchTerm]);

    const localConnections = useMemo(
        () => localConnectionsFromCatalog(filteredEntries),
        [filteredEntries],
    );

    const remoteOnlyEntries = useMemo(
        () => remoteOnlyCatalogEntries(filteredEntries),
        [filteredEntries],
    );

    const locationsByLogicalId = useMemo(() => catalogLocationsByLogicalId(entries), [entries]);

    return {
        filter,
        setFilter,
        entries,
        filteredEntries,
        localConnections,
        remoteOnlyEntries,
        locationsByLogicalId,
        inventoryStatus: inventory.status,
        inventoryFromCache: inventory.fromCache,
        inventoryError: inventory.error,
        lastInventoryScan: inventory.scan,
        providerConnected,
        providerReady,
        refreshInventory,
        materializingIds,
        setMaterializing,
    };
}
