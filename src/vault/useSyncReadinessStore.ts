import { create } from 'zustand';
import {
  SYNC_STATUS_CHANGED_EVENT,
  syncIpc,
  type SyncCollectionStatus,
  type SyncProvider,
  type SyncProviderStatus,
} from './syncIpc';
import {
  getProviderReadiness,
  getSyncEncryptionStateLabel,
  type ProviderReadiness,
} from './syncProviderGate';

/**
 * Single source of truth for provider OAuth + Google encryption readiness.
 *
 * Sync & Backup UI and All Hosts inventory both read from here so they cannot
 * diverge (e.g. Sync says "ready" while sidebar still says "Unlock…").
 *
 * Pure gate helpers live in `syncProviderGate.ts`; this store owns live state.
 */

export type SyncEncryptionLabel = ReturnType<typeof getSyncEncryptionStateLabel>;

const DEFAULT_PROVIDER: SyncProvider = 'google';

/** Monotonic token so out-of-order refresh() responses cannot clobber newer state. */
let refreshRequestSeq = 0;

interface SyncReadinessState {
  provider: SyncProvider;
  /** Google Drive OAuth / connection status. */
  oauth: SyncProviderStatus | null;
  /** Collection encryption status (configured, keyCached, …). */
  collection: SyncCollectionStatus | null;
  isLoading: boolean;
  lastError?: string;

  /** Derived — always recomputed when oauth/collection change. */
  readiness: ProviderReadiness;
  encryptionLabel: SyncEncryptionLabel;

  refresh: (provider?: SyncProvider) => Promise<void>;
  setOauth: (
    status:
      | SyncProviderStatus
      | null
      | ((prev: SyncProviderStatus | null) => SyncProviderStatus | null),
  ) => void;
  setCollection: (status: SyncCollectionStatus | null) => void;
  patchOauth: (patch: Partial<SyncProviderStatus>) => void;
}

function derive(
  oauth: SyncProviderStatus | null,
  collection: SyncCollectionStatus | null,
): Pick<SyncReadinessState, 'readiness' | 'encryptionLabel'> {
  return {
    readiness: getProviderReadiness(oauth, collection),
    encryptionLabel: getSyncEncryptionStateLabel(oauth, collection),
  };
}

export const useSyncReadinessStore = create<SyncReadinessState>((set, get) => ({
  provider: DEFAULT_PROVIDER,
  oauth: null,
  collection: null,
  isLoading: false,
  lastError: undefined,
  ...derive(null, null),

  setOauth: (statusOrUpdater) => {
    const prev = get().oauth;
    const next =
      typeof statusOrUpdater === 'function' ? statusOrUpdater(prev) : statusOrUpdater;
    set({
      oauth: next,
      ...derive(next, get().collection),
    });
  },

  setCollection: (collection) => {
    set({
      collection,
      ...derive(get().oauth, collection),
    });
  },

  patchOauth: (patch) => {
    const prev = get().oauth;
    const next: SyncProviderStatus = prev
      ? { ...prev, ...patch }
      : { connected: false, ...patch };
    set({
      oauth: next,
      ...derive(next, get().collection),
    });
  },

  refresh: async (provider = DEFAULT_PROVIDER) => {
    const token = ++refreshRequestSeq;
    set({ isLoading: true, lastError: undefined, provider });
    try {
      const [oauth, collection] = await Promise.all([
        syncIpc.status(provider),
        syncIpc.collectionStatus(provider),
      ]);
      // Discard stale responses if a newer refresh started meanwhile.
      if (token !== refreshRequestSeq) return;
      set({
        oauth,
        collection,
        isLoading: false,
        ...derive(oauth, collection),
      });
    } catch (error) {
      if (token !== refreshRequestSeq) return;
      const message = error instanceof Error ? error.message : String(error);
      set({ isLoading: false, lastError: message });
    }
  },
}));

// ── Global event bridge (once) ──────────────────────────────────────────────

let listenerAttached = false;

/**
 * Keep readiness in sync when connect/disconnect/unlock/lock/setup fire
 * `notifySyncStatusChanged`. Safe to call multiple times.
 */
export function ensureSyncReadinessListener(): void {
  if (listenerAttached || typeof window === 'undefined') return;
  listenerAttached = true;

  window.addEventListener(SYNC_STATUS_CHANGED_EVENT, ((event: Event) => {
    const detail = (event as CustomEvent<{
      provider?: string;
      status?: SyncProviderStatus;
    }>).detail;

    if (detail?.provider && detail.provider !== DEFAULT_PROVIDER) return;

    // Optimistic OAuth patch when the event carries a full provider status.
    if (detail?.status) {
      useSyncReadinessStore.getState().setOauth(detail.status);
    }

    // Always re-fetch collection + oauth so keyCached cannot go stale.
    void useSyncReadinessStore.getState().refresh(DEFAULT_PROVIDER);
  }) as EventListener);
}

/** Convenience selector hook pieces for consumers that only need readiness. */
export function selectSyncReadiness(state: SyncReadinessState): ProviderReadiness {
  return state.readiness;
}

export function selectIsProviderReady(state: SyncReadinessState): boolean {
  return state.readiness.isProviderReady;
}
