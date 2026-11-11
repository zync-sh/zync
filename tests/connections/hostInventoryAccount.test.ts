import assert from 'node:assert/strict';
import test from 'node:test';

import {
    clearAllHostInventoryCaches,
    readHostInventoryCache,
    writeHostInventoryCache,
} from '../../src/features/connections/domain/hostInventoryCache.js';
import {
    __resetSyncIpcInvokeForTests,
    __setSyncIpcInvokeForTests,
    type SyncProviderStatus,
} from '../../src/vault/syncIpc.js';
import { useSyncReadinessStore } from '../../src/vault/useSyncReadinessStore.js';

const accountA = 'first@example.test';
const accountB = 'second@example.test';
const unlocked = {
    provider: 'google',
    configured: true,
    hasRecoveryKey: false,
    keyCached: true,
} as const;
const state = useSyncReadinessStore.getState;

test.beforeEach(() => {
    clearAllHostInventoryCaches();
    useSyncReadinessStore.setState(useSyncReadinessStore.getInitialState(), true);
});

test.afterEach(() => {
    __resetSyncIpcInvokeForTests();
    clearAllHostInventoryCaches();
});

test('sign-out clears both caches and a same-account reconnect creates a new session', () => {
    const storage = new Map<string, string>();
    const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', {
        configurable: true,
        value: {
            get length() {
                return storage.size;
            },
            key: (index: number) => [...storage.keys()][index] ?? null,
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
            removeItem: (key: string) => storage.delete(key),
        },
    });
    try {
        state().setOauth({ connected: true, email: accountA });
        const first = state().hostInventoryAccount;
        writeHostInventoryCache({
            provider: 'google',
            accountKey: accountA,
            fetchedAt: 1,
            hosts: [],
        });
        assert.equal(storage.size, 1);
        state().setOauth({ connected: false });
        assert.equal(state().hostInventoryAccount, null);
        assert.equal(readHostInventoryCache('google', accountA), null);
        assert.equal(storage.size, 0);
        state().setOauth({ connected: true, email: accountA });
        assert.notEqual(state().hostInventoryAccount, first);
    } finally {
        if (original) {
            Object.defineProperty(globalThis, 'sessionStorage', original);
        } else {
            Reflect.deleteProperty(globalThis, 'sessionStorage');
        }
    }
});

test('locking and normalizing the same account preserves its cache, switching clears it', () => {
    state().setOauth({ connected: true, email: accountA });
    state().setCollection(unlocked);
    const first = state().hostInventoryAccount;
    writeHostInventoryCache({ provider: 'google', accountKey: accountA, fetchedAt: 1, hosts: [] });
    state().setCollection({ ...unlocked, keyCached: false });
    state().setOauth({ connected: true, email: accountA.toUpperCase() });
    assert.equal(state().hostInventoryAccount, first);
    assert.equal(state().readiness.isEncryptionUnlocked, false);
    assert.ok(readHostInventoryCache('google', accountA));

    state().setOauth({ connected: true, email: accountB });
    assert.equal(state().hostInventoryAccount?.key, accountB);
    assert.equal(readHostInventoryCache('google', accountA), null);
});

test('a pending readiness response cannot restore the signed-out account', async () => {
    state().setOauth({ connected: true, email: accountA });
    let completeStatus!: (status: SyncProviderStatus) => void;
    const oldStatus = new Promise<SyncProviderStatus>((resolve) => {
        completeStatus = resolve;
    });
    __setSyncIpcInvokeForTests(async <T>(command: string) => {
        if (command === 'sync_status') {
            return (await oldStatus) as T;
        }
        assert.equal(command, 'sync_collection_status');
        return unlocked as T;
    });
    const pending = state().refresh();
    state().setOauth({ connected: false });
    completeStatus({ connected: true, email: accountA });
    await pending;
    assert.equal(state().hostInventoryAccount, null);
    assert.equal(state().readiness.isConnected, false);
    assert.equal(state().isLoading, false);
});
