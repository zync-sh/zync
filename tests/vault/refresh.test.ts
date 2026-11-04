import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type VaultItem, type VaultStatus, vaultIpc } from '../../src/vault/ipc.js';
import { useVaultStore } from '../../src/vault/useVaultStore.js';

const unlocked: VaultStatus = { status: 'unlocked', vaultId: 'fixture', itemCount: 0 };
const locked: VaultStatus = {
    status: 'locked',
    vaultId: 'fixture',
    itemCount: 0,
    rememberedOnDevice: false,
};
const item = { id: 'fixture' } as VaultItem;
const jobs = () => new Promise<void>((resolve) => setImmediate(resolve));

test('a caller at the final promise continuation boundary still receives a fresh read', async (context) => {
    useVaultStore.setState({ status: unlocked, items: [], error: null });
    let calls = 0;
    const done = deferred<void>();
    context.mock.method(vaultIpc, 'itemList', async () => (++calls === 1 ? [item] : []));
    const unsubscribe = useVaultStore.subscribe((state) => {
        if (state.items[0] === item) {
            queueMicrotask(() =>
                queueMicrotask(() => {
                    useVaultStore
                        .getState()
                        .refreshItems()
                        .then(() => done.resolve(), done.reject);
                }),
            );
        }
    });
    try {
        await useVaultStore.getState().refreshItems();
        await done.promise;
        assert.equal(calls, 2);
        assert.deepEqual(useVaultStore.getState().items, []);
    } finally {
        unsubscribe();
    }
});

test('a failed device mutation cannot strand an invalidated initial status load', async (context) => {
    useVaultStore.setState({ status: null, items: [], error: null, isLoading: false });
    const old = deferred<VaultStatus>();
    const device = deferred<void>();
    let calls = 0;
    context.mock.method(vaultIpc, 'status', () =>
        ++calls === 1 ? old.promise : Promise.resolve(locked),
    );
    context.mock.method(vaultIpc, 'forgetDevice', () => device.promise);
    const read = useVaultStore.getState().refresh();
    await jobs();
    const failed = assert.rejects(useVaultStore.getState().forgetDevice(), /device failure/);
    old.resolve(unlocked);
    device.reject(new Error('device failure'));
    await Promise.all([read, failed]);
    assert.equal(useVaultStore.getState().status?.status, 'locked');
    assert.equal(useVaultStore.getState().isLoading, false);
});
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

test('an obsolete item error cannot clear a newer requested snapshot', async (context) => {
    useVaultStore.setState({ status: unlocked, items: [item], error: null });
    const old = deferred<VaultItem[]>();
    let calls = 0;
    context.mock.method(vaultIpc, 'itemList', () =>
        ++calls === 1 ? old.promise : Promise.resolve([item]),
    );
    const first = useVaultStore.getState().refreshItems();
    await jobs();
    const next = useVaultStore.getState().refreshItems();
    old.reject(new Error('obsolete failure'));
    await Promise.all([first, next]);
    assert.deepEqual(useVaultStore.getState().items, [item]);
    assert.equal(useVaultStore.getState().error, null);
    assert.equal(calls, 2);
});

test('refresh waits for a pending vault mutation before reading status', async (context) => {
    useVaultStore.setState({ status: unlocked, items: [item], error: null });
    const operation = deferred<void>();
    let statuses = 0;
    context.mock.method(vaultIpc, 'lock', () => operation.promise);
    context.mock.method(vaultIpc, 'status', async () => {
        statuses++;
        return locked;
    });
    const lock = useVaultStore.getState().lock();
    const refresh = useVaultStore.getState().refresh();
    await jobs();
    assert.equal(statuses, 0);
    operation.resolve();
    await Promise.all([lock, refresh]);
    assert.equal(useVaultStore.getState().status?.status, 'locked');
    assert.deepEqual(useVaultStore.getState().items, []);
});

test('simultaneous refreshes share acquisition; later refresh performs a fresh read', async (context) => {
    useVaultStore.setState({ status: null, items: [], error: null, isLoading: false });
    let statuses = 0;
    let lists = 0;
    context.mock.method(vaultIpc, 'status', async () => {
        statuses++;
        return unlocked;
    });
    context.mock.method(vaultIpc, 'itemList', async () => {
        lists++;
        return [item];
    });
    await Promise.all(Array.from({ length: 20 }, () => useVaultStore.getState().refresh()));
    assert.equal(statuses, 1);
    assert.equal(lists, 1);
    assert.equal(useVaultStore.getState().status?.status, 'unlocked');
    await useVaultStore.getState().refresh();
    assert.equal(statuses, 2);
    assert.equal(lists, 2);
});

test('requests arriving during a list coalesce a fresh follow-up, never a stale post-write result', async (context) => {
    useVaultStore.setState({ status: unlocked, items: [], error: null });
    const old = deferred<VaultItem[]>();
    let lists = 0;
    context.mock.method(vaultIpc, 'itemList', () =>
        ++lists === 1 ? old.promise : Promise.resolve([item]),
    );
    const first = useVaultStore.getState().refreshItems();
    await jobs();
    const followers = Array.from({ length: 20 }, () => useVaultStore.getState().refreshItems());
    old.resolve([]);
    await Promise.all([first, ...followers]);
    assert.equal(lists, 2);
    assert.deepEqual(useVaultStore.getState().items, [item]);
});

for (const fails of [false, true]) {
    test(`an item refresh retries after a concurrent ${fails ? 'failed' : 'successful'} mutation`, async (context) => {
        useVaultStore.setState({ status: unlocked, items: [], error: null });
        const old = deferred<VaultItem[]>();
        const fresh = deferred<VaultItem[]>();
        const operation = deferred<VaultStatus>();
        let lists = 0;
        let completed = false;
        context.mock.method(vaultIpc, 'itemList', () =>
            ++lists === 1 ? old.promise : fresh.promise,
        );
        context.mock.method(vaultIpc, 'changePassphrase', () => operation.promise);
        const read = useVaultStore
            .getState()
            .refreshItems()
            .then(() => {
                completed = true;
            });
        await jobs();
        const mutation = useVaultStore.getState().changePassphrase('fixture-passphrase');
        const mutationResult = fails ? assert.rejects(mutation, /mutation failure/) : mutation;
        old.resolve([item]);
        await jobs();
        const completedDuringMutation = completed;
        const listsDuringMutation = lists;
        if (fails) {
            operation.reject(new Error('mutation failure'));
        } else {
            operation.resolve(unlocked);
        }
        await jobs();
        const completedBeforeFreshResult = completed;
        fresh.resolve([]);
        await Promise.all([read, mutationResult]);
        assert.equal(completedDuringMutation, false, 'callers must wait for the mutation');
        assert.equal(listsDuringMutation, 1, 'the retry must not read during a pending mutation');
        assert.equal(completedBeforeFreshResult, false, 'callers must await the fresh result');
        assert.equal(lists, 2, 'mutation completion alone must request a fresh read');
        assert.deepEqual(useVaultStore.getState().items, []);
    });
}

test('lock fences an older list and a fresh locked-vault error reaches waiting callers', async (context) => {
    useVaultStore.setState({ status: unlocked, items: [item], error: null });
    const old = deferred<VaultItem[]>();
    let lists = 0;
    context.mock.method(vaultIpc, 'itemList', () =>
        ++lists === 1 ? old.promise : Promise.reject(new Error('vault_locked')),
    );
    context.mock.method(vaultIpc, 'lock', async () => {});
    context.mock.method(vaultIpc, 'status', async () => locked);
    const read = useVaultStore.getState().refreshItems();
    await jobs();
    await useVaultStore.getState().lock();
    const failed = assert.rejects(read, /vault_locked/);
    old.resolve([item]);
    await failed;
    assert.equal(useVaultStore.getState().status?.status, 'locked');
    assert.deepEqual(useVaultStore.getState().items, []);
    assert.equal(lists, 2);
    assert.equal(useVaultStore.getState().error, 'vault_locked');
});

test('lock and an overlapping full refresh settle after an invalidated item read', {
    timeout: 5000,
}, async (context) => {
    useVaultStore.setState({ status: null, items: [], error: null, isLoading: false });
    const old = deferred<VaultItem[]>();
    let statuses = 0;
    let lists = 0;
    context.mock.method(vaultIpc, 'status', async () => (++statuses === 1 ? unlocked : locked));
    context.mock.method(vaultIpc, 'itemList', () =>
        ++lists === 1 ? old.promise : Promise.reject(new Error('vault_locked')),
    );
    context.mock.method(vaultIpc, 'lock', async () => {});
    const read = useVaultStore.getState().refresh();
    await jobs();
    const lock = useVaultStore.getState().lock();
    await jobs();
    old.resolve([item]);
    await Promise.all([read, lock]);
    assert.equal(statuses, 2);
    assert.equal(lists, 2);
    assert.equal(useVaultStore.getState().status?.status, 'locked');
    assert.deepEqual(useVaultStore.getState().items, []);
    assert.equal(useVaultStore.getState().isLoading, false);
});

test('obsolete status cannot overwrite reset or leave the initial loading flag stuck', async (context) => {
    useVaultStore.setState({ status: null, items: [], error: null, isLoading: false });
    const old = deferred<VaultStatus>();
    let calls = 0;
    context.mock.method(vaultIpc, 'status', () =>
        ++calls === 1 ? old.promise : Promise.resolve({ status: 'uninitialized' }),
    );
    context.mock.method(vaultIpc, 'resetLocal', async () => ({
        status: { status: 'uninitialized' },
        clearedAuthRefs: 0,
    }));
    const read = useVaultStore.getState().refresh();
    await jobs();
    await useVaultStore.getState().resetLocal();
    old.resolve(unlocked);
    await read;
    assert.equal(useVaultStore.getState().status?.status, 'uninitialized');
    assert.deepEqual(useVaultStore.getState().items, []);
    assert.equal(useVaultStore.getState().isLoading, false);
});

test('fresh errors release admission and an ordinary retry recovers', async (context) => {
    useVaultStore.setState({ status: null, items: [], error: null, isLoading: false });
    const mock = context.mock.method(vaultIpc, 'status', async () => {
        throw new Error('vault_in_use');
    });
    await assert.rejects(useVaultStore.getState().refresh(), /vault_in_use/);
    assert.equal(useVaultStore.getState().isLoading, false);
    mock.mock.mockImplementation(async () => locked);
    await useVaultStore.getState().refresh();
    assert.equal(useVaultStore.getState().status?.status, 'locked');
});
