import { create } from 'zustand';
import { vaultIpc, type VaultStatus, type VaultItem } from './ipc';

interface VaultStore {
  status: VaultStatus | null;
  items: VaultItem[];
  isLoading: boolean;
  error: string | null;

  refresh: () => Promise<void>;
  refreshItems: () => Promise<void>;
  initialize: (passphrase: string) => Promise<void>;
  unlock: (passphrase: string) => Promise<void>;
  unlockWithRecoveryKey: (recoveryKey: string) => Promise<void>;
  lock: () => Promise<void>;
  deleteItem: (itemId: string) => Promise<void>;
  clearError: () => void;
}

export const useVaultStore = create<VaultStore>((set, get) => ({
  status: null,
  items: [],
  isLoading: false,
  error: null,

  clearError: () => set({ error: null }),

  refresh: async () => {
    set({ isLoading: true, error: null });
    try {
      const status = await vaultIpc.status();
      set({ status });
      if (status.status === 'unlocked') {
        try {
          await get().refreshItems();
        } catch (e) {
          // refreshItems failed — clear items so the UI doesn't show stale data
          // but keep the confirmed unlocked status; do not propagate so the
          // outer catch does not reset status to null.
          set({ items: [], error: extractErrorMessage(e) });
        }
      } else {
        set({ items: [] });
      }
    } catch (e) {
      set({ status: null, items: [], error: extractErrorMessage(e) });
      throw e;
    } finally {
      set({ isLoading: false });
    }
  },

  refreshItems: async () => {
    try {
      const items = await vaultIpc.itemList();
      set({ items });
    } catch (e: unknown) {
      const msg = extractErrorMessage(e);
      console.warn('[Vault] refreshItems failed:', e);
      set({ items: [], error: msg });
      throw e;
    }
  },

  initialize: async (passphrase: string) => {
    set({ isLoading: true, error: null });
    try {
      const status = await vaultIpc.initialize(passphrase);
      set({ status, isLoading: false });
    } catch (e: unknown) {
      const msg = extractErrorMessage(e);
      set({ isLoading: false, error: msg });
      throw e;
    }
  },

  unlock: async (passphrase: string) => {
    set({ isLoading: true, error: null });
    try {
      const status = await vaultIpc.unlock(passphrase);
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

  unlockWithRecoveryKey: async (recoveryKey: string) => {
    set({ isLoading: true, error: null });
    try {
      const status = await vaultIpc.unlockWithRecoveryKey(recoveryKey);
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

  lock: async () => {
    try {
      await vaultIpc.lock();
      set({ items: [] });
      await get().refresh();
    } catch (e) {
      console.error('Failed to lock vault', e);
      set({ error: extractErrorMessage(e) });
      throw e;
    }
  },

  deleteItem: async (itemId: string) => {
    try {
      await vaultIpc.itemDelete(itemId);
      await get().refresh();
    } catch (e: unknown) {
      const msg = extractErrorMessage(e);
      set({ error: msg });
      throw e;
    }
  },
}));

function extractErrorMessage(e: unknown): string {
  if (e && typeof e === 'object') {
    const obj = e as Record<string, unknown>;
    if (typeof obj.message === 'string') return obj.message;
    if (typeof obj.code === 'string') return obj.code;
  }
  return String(e);
}
