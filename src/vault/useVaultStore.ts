import { create } from 'zustand';

import { type VaultItem, type VaultResetLocalResult, type VaultStatus, vaultIpc } from './ipc.js';
import { isVaultInUseError } from './vaultLoading.js';

interface VaultStore {
    status: VaultStatus | null;
    items: VaultItem[];
    isLoading: boolean;
    error: string | null;
    unlockPromptOpen: boolean;
    unlockPromptWaiters: Array<(unlocked: boolean) => void>;

    refresh: () => Promise<void>;
    refreshItems: () => Promise<void>;
    initialize: (passphrase: string, rememberOnDevice?: boolean) => Promise<void>;
    unlock: (passphrase: string, rememberOnDevice?: boolean) => Promise<void>;
    unlockWithRecoveryKey: (recoveryKey: string, rememberOnDevice?: boolean) => Promise<void>;
    forgetDevice: () => Promise<void>;
    changePassphrase: (
        newPassphrase: string,
        options?: { currentPassphrase?: string; rememberOnDevice?: boolean },
    ) => Promise<void>;
    resetLocal: () => Promise<VaultResetLocalResult>;
    lock: () => Promise<void>;
    deleteItem: (itemId: string) => Promise<void>;
    clearError: () => void;
    openUnlockModal: () => void;
    requestUnlock: () => Promise<boolean>;
    finishUnlockPrompt: (unlocked: boolean) => void;
}

/** Revisions fence reads across native mutations without retaining decrypted metadata. */
let mutationEpoch = 0;
const mutations = new Set<Promise<unknown>>();

/** Track native writes so reads wait for completion and cannot publish an older snapshot. */
async function mutateVault<T>(operation: () => Promise<T>): Promise<T> {
    mutationEpoch++;
    const pending = Promise.resolve().then(operation);
    mutations.add(pending);
    try {
        return await pending;
    } finally {
        mutations.delete(pending);
        mutationEpoch++;
    }
}

/** One active read plus a coalesced fresh follow-up; all callers await the latest requested snapshot. */
function refreshQueue(
    read: (current: () => boolean) => Promise<void>,
    retryOnMutation = false,
): () => Promise<void> {
    let revision = 0;
    let pending: Promise<void> | undefined;
    return () => {
        revision++;
        if (pending) {
            return pending;
        }
        const run = Promise.resolve().then(async () => {
            try {
                let observed: number;
                let epoch: number;
                do {
                    while (mutations.size) {
                        await Promise.allSettled([...mutations]);
                    }
                    observed = revision;
                    epoch = mutationEpoch;
                    /** A newer refresh or native mutation revokes this snapshot. */
                    const current = () => observed === revision && epoch === mutationEpoch;
                    try {
                        await read(current);
                    } catch (error) {
                        if (current()) {
                            throw error;
                        }
                    }
                } while (observed !== revision || (retryOnMutation && epoch !== mutationEpoch));
            } finally {
                if (pending === run) {
                    pending = undefined;
                }
            }
        });
        pending = run;
        return run;
    };
}

export const useVaultStore = create<VaultStore>((set, get) => ({
    status: null,
    items: [],
    isLoading: false,
    error: null,
    unlockPromptOpen: false,
    unlockPromptWaiters: [],

    clearError: () => set({ error: null }),

    openUnlockModal: () => set({ unlockPromptOpen: true }),

    /** Recheck current status before joining the shared unlock prompt. */
    requestUnlock: async () => {
        let refreshFailed = false;
        try {
            await get().refresh();
        } catch {
            refreshFailed = true;
            // Status refresh failed; vault-in-use is handled below, otherwise offer unlock UI.
        }
        if (get().status?.status === 'unlocked') {
            return true;
        }
        if (refreshFailed && isVaultInUseError(get().error)) {
            return false;
        }

        return new Promise<boolean>((resolve) => {
            set((state) => ({
                unlockPromptOpen: true,
                unlockPromptWaiters: [...state.unlockPromptWaiters, resolve],
            }));
        });
    },

    /** Resolve all current prompt waiters with the same unlock outcome. */
    finishUnlockPrompt: (unlocked: boolean) => {
        const waiters = get().unlockPromptWaiters;
        set({ unlockPromptOpen: false, unlockPromptWaiters: [] });
        for (const resolve of waiters) {
            resolve(unlocked);
        }
    },

    /** Refresh status and metadata with latest-request freshness. */
    refresh: refreshQueue(async (current) => {
        const isInitialLoad = get().status === null;
        if (isInitialLoad) {
            set({ isLoading: true, error: null });
        }
        try {
            const status = await vaultIpc.status();
            if (!current()) {
                return;
            }
            set({ status });
            if (status.status === 'unlocked') {
                try {
                    await get().refreshItems();
                } catch (e) {
                    if (!current()) {
                        return;
                    }
                    // refreshItems failed — clear items so the UI doesn't show stale data
                    // but keep the confirmed unlocked status; do not propagate so the
                    // outer catch does not reset status to null.
                    set({ items: [], error: extractErrorMessage(e) });
                }
            } else {
                set({ items: [] });
            }
        } catch (e) {
            if (!current()) {
                return;
            }
            set({ status: null, items: [], error: extractErrorMessage(e) });
            throw e;
        } finally {
            if (current()) {
                set({ isLoading: false });
            }
        }
    }, true),

    /** Share metadata reads and retry mutation-invalidated snapshots before callers settle. */
    refreshItems: refreshQueue(async (current) => {
        try {
            const items = await vaultIpc.itemList();
            if (!current()) {
                return;
            }
            set((state) => ({
                items,
                status:
                    state.status?.status === 'unlocked'
                        ? { ...state.status, itemCount: items.length }
                        : state.status,
            }));
        } catch (e: unknown) {
            if (!current()) {
                return;
            }
            const msg = extractErrorMessage(e);
            console.warn('[Vault] refreshItems failed:', e);
            set({ items: [], error: msg });
            throw e;
        }
    }, true),

    /** Initialize through the existing native boundary while fencing older reads. */
    initialize: async (passphrase: string, rememberOnDevice = false) => {
        set({ isLoading: true, error: null });
        try {
            const status = await mutateVault(() =>
                vaultIpc.initialize(passphrase, rememberOnDevice),
            );
            set({ status, isLoading: false });
        } catch (e: unknown) {
            const msg = extractErrorMessage(e);
            set({ isLoading: false, error: msg });
            throw e;
        }
    },

    /** Unlock and acquire metadata after the mutation completes. */
    unlock: async (passphrase: string, rememberOnDevice = false) => {
        set({ isLoading: true, error: null });
        try {
            const status = await mutateVault(() => vaultIpc.unlock(passphrase, rememberOnDevice));
            set({ status });
            await get().refreshItems();
        } catch (e: unknown) {
            const msg = extractErrorMessage(e);
            set({ error: msg });
            throw e;
        } finally {
            set({ isLoading: false });
        }
    },

    /** Preserve recovery-key unlock semantics and refresh the resulting metadata. */
    unlockWithRecoveryKey: async (recoveryKey: string, rememberOnDevice = false) => {
        set({ isLoading: true, error: null });
        try {
            const status = await mutateVault(() =>
                vaultIpc.unlockWithRecoveryKey(recoveryKey, rememberOnDevice),
            );
            set({ status });
            await get().refreshItems();
        } catch (e: unknown) {
            const msg = extractErrorMessage(e);
            set({ error: msg });
            throw e;
        } finally {
            set({ isLoading: false });
        }
    },

    /** Fence remembered-device changes before reacquiring status. */
    forgetDevice: async () => {
        try {
            await mutateVault(() => vaultIpc.forgetDevice());
            await get().refresh();
        } catch (e: unknown) {
            const msg = extractErrorMessage(e);
            set({ error: msg });
            throw e;
        }
    },

    /** Apply native passphrase rotation without allowing older reads to overwrite its result. */
    changePassphrase: async (newPassphrase, options) => {
        set({ isLoading: true, error: null });
        try {
            const status = await mutateVault(() =>
                vaultIpc.changePassphrase(newPassphrase, options),
            );
            set({ status, isLoading: false, error: null });
        } catch (e: unknown) {
            const msg = extractErrorMessage(e);
            set({ isLoading: false, error: msg });
            throw e;
        }
    },

    /** Reset local vault state and discard obsolete metadata reads. */
    resetLocal: async () => {
        set({ isLoading: true, error: null });
        try {
            const result = await mutateVault(() => vaultIpc.resetLocal());
            set({ status: result.status, items: [], isLoading: false, error: null });
            return result;
        } catch (e: unknown) {
            const msg = extractErrorMessage(e);
            set({ isLoading: false, error: msg });
            throw e;
        }
    },

    /** Lock natively, clear visible metadata, and confirm the current locked status. */
    lock: async () => {
        try {
            await mutateVault(() => vaultIpc.lock());
            set({ items: [] });
            await get().refresh();
        } catch (e) {
            console.error('Failed to lock vault', e);
            set({ error: extractErrorMessage(e) });
            throw e;
        }
    },

    /** Delete one item and await a fresh status/list snapshot. */
    deleteItem: async (itemId: string) => {
        try {
            await mutateVault(() => vaultIpc.itemDelete(itemId));
            await get().refresh();
        } catch (e: unknown) {
            const msg = extractErrorMessage(e);
            set({ error: msg });
            throw e;
        }
    },
}));

/** Preserve native error codes and messages for the existing UI contract. */
function extractErrorMessage(e: unknown): string {
    if (e && typeof e === 'object') {
        const obj = e as Record<string, unknown>;
        const code = typeof obj.code === 'string' ? obj.code : null;
        const message = typeof obj.message === 'string' ? obj.message : null;
        if (code && message) {
            return `${code}: ${message}`;
        }
        if (message) {
            return message;
        }
        if (code) {
            return code;
        }
    }
    return String(e);
}
