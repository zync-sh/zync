import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';
import { createStore } from 'zustand/vanilla';

import * as connectionService from '../../src/features/connections/application/connectionService.js';
import type { Connection, Folder } from '../../src/features/connections/domain/types.js';
import type { AppStore } from '../../src/store/useAppStore.js';

const { loadSource } = (await import(
    pathToFileURL(path.resolve('tests/helpers/loadSource.mjs')).href
)) as {
    loadSource<T>(
        file: string,
        dependencies: Record<string, unknown>,
        globals?: Record<string, unknown>,
    ): T;
};

interface Write {
    connections: Connection[];
    folders: Folder[];
    resolve(): void;
    reject(error: Error): void;
}

const host: Connection = {
    id: 'metadata-fixture',
    name: 'Original name',
    host: 'original.invalid',
    username: 'fixture',
    port: 22,
    status: 'connected',
    tags: ['original'],
};

/** Execute the real slice and save queue with only native/runtime boundaries replaced. */
function fixture(initial: Connection[] = [host]) {
    const imports = ts.preProcessFile(
        readFileSync(path.resolve('src/store/connectionSlice.ts'), 'utf8'),
    ).importedFiles;
    const dependencies: Record<string, unknown> = Object.fromEntries(
        imports.map(({ fileName }) => [fileName, {}]),
    );
    const writes: Write[] = [];
    let next = 0;
    const waiting: Array<(write: Write) => void> = [];
    Object.assign(dependencies, {
        '../features/connections/application/connectionService': connectionService,
        '../features/connections/infrastructure/connectionPersistence': {
            saveConnectionsIpc: (connections: Connection[], folders: Folder[]) =>
                new Promise<void>((resolve, reject) => {
                    const write = {
                        connections: connections.map((connection) => ({ ...connection })),
                        folders,
                        resolve,
                        reject,
                    };
                    writes.push(write);
                    waiting.shift()?.(write);
                }),
        },
        '../features/connections/domain/errorSanitization': { connectionErrorMessage: String },
        '../features/connections/application/networkInterface': { cancelNetworkPrompts() {} },
        '../lib/shells/cache': { clearRemoteShellCache() {} },
    });
    const { createConnectionSlice } = loadSource<
        typeof import('../../src/store/connectionSlice.js')
    >('store/connectionSlice.ts', dependencies, { console: { error() {} } });
    const store = createStore<AppStore>()(
        (...args) =>
            ({
                ...createConnectionSlice(...args),
                connections: initial.map((connection) => ({ ...connection })),
                saveSession() {},
            }) as AppStore,
    );
    return {
        store,
        writes,
        nextWrite(): Promise<Write> {
            if (writes[next]) {
                return Promise.resolve(writes[next++]);
            }
            return new Promise((resolve) =>
                waiting.push((write) => {
                    next++;
                    resolve(write);
                }),
            );
        },
    };
}

test('dual-pane updates claim one icon immediately and queue only one pending save', {
    timeout: 3000,
}, async () => {
    const { store, writes, nextWrite } = fixture();
    const pending = store.getState().setConnectionIconIfMissing(host.id, 'linux');
    assert.equal(store.getState().connections[0].icon, 'linux');
    await Promise.all(
        Array.from({ length: 20 }, () =>
            store.getState().setConnectionIconIfMissing(host.id, 'ubuntu'),
        ),
    );
    const write = await nextWrite();
    assert.equal(writes.length, 1);
    assert.equal(write.connections[0].icon, 'linux');
    assert.deepEqual(write.connections[0].tags, ['original']);
    write.resolve();
    await pending;
    await store.getState().setConnectionIconIfMissing(host.id, 'ubuntu');
    assert.equal(writes.length, 1);
});

test('a prior pending same-target edit retains its new fields and receives the missing icon', {
    timeout: 3000,
}, async () => {
    const { store, nextWrite } = fixture();
    const manual = store.getState().editConnection({ ...host, name: 'Renamed', tags: ['manual'] });
    const first = await nextWrite();
    const automatic = store.getState().setConnectionIconIfMissing(host.id, 'linux');
    first.resolve();
    await manual;
    const metadata = await nextWrite();
    assert.equal(metadata.connections[0].name, 'Renamed');
    assert.deepEqual(metadata.connections[0].tags, ['manual']);
    assert.equal(metadata.connections[0].icon, 'linux');
    metadata.resolve();
    await automatic;
    assert.equal(store.getState().connections[0].icon, 'linux');
});

test('a pending manual icon or target change cannot be overwritten by old sampled metadata', {
    timeout: 3000,
}, async () => {
    for (const update of [
        { ...host, icon: 'custom' },
        { ...host, host: 'replacement.invalid' },
    ]) {
        const { store, nextWrite } = fixture();
        const manual = store.getState().editConnection(update);
        const first = await nextWrite();
        const automatic = store.getState().setConnectionIconIfMissing(host.id, 'linux');
        first.resolve();
        await manual;
        const metadata = await nextWrite();
        assert.equal(metadata.connections[0].host, update.host);
        assert.equal(metadata.connections[0].icon, update.icon);
        metadata.resolve();
        await automatic;
        assert.equal(store.getState().connections[0].icon, update.icon);
    }
});

test('deletion before a queued metadata save never upserts its old host', {
    timeout: 3000,
}, async () => {
    const blocker = { ...host, id: 'metadata-blocker' };
    const { store, nextWrite } = fixture([host, blocker]);
    const blocking = store.getState().setConnectionIconIfMissing(blocker.id, 'linux');
    const first = await nextWrite();
    const automatic = store.getState().setConnectionIconIfMissing(host.id, 'linux');
    store.getState().deleteConnection(host.id);
    first.resolve();
    await blocking;
    const metadata = await nextWrite();
    assert.equal(
        metadata.connections.some((connection) => connection.id === host.id),
        false,
    );
    metadata.resolve();
    await automatic;
    const deleted = await nextWrite();
    assert.equal(
        deleted.connections.some((connection) => connection.id === host.id),
        false,
    );
    deleted.resolve();
    assert.equal(
        store.getState().connections.some((connection) => connection.id === host.id),
        false,
    );
});

test('failed persistence rolls back only its own optimistic icon and permits retry', {
    timeout: 3000,
}, async () => {
    for (const icon of [undefined, '']) {
        const { store, nextWrite } = fixture([{ ...host, icon }]);
        const first = store.getState().setConnectionIconIfMissing(host.id, 'linux');
        const rejected = assert.rejects(first, /fixture save failure/);
        (await nextWrite()).reject(new Error('fixture save failure'));
        await rejected;
        assert.equal(store.getState().connections[0].icon, icon);
        const retry = store.getState().setConnectionIconIfMissing(host.id, 'linux');
        (await nextWrite()).resolve();
        await retry;
        assert.equal(store.getState().connections[0].icon, 'linux');
    }
});

test('save failure never rolls back a newer user icon or recreates a removed host', {
    timeout: 3000,
}, async () => {
    for (const remove of [false, true]) {
        const { store, nextWrite } = fixture();
        const pending = store.getState().setConnectionIconIfMissing(host.id, 'linux');
        const rejected = assert.rejects(pending, /fixture failure/);
        const write = await nextWrite();
        store.setState((state) => ({
            connections: remove
                ? []
                : state.connections.map((connection) => ({ ...connection, icon: 'manual' })),
        }));
        write.reject(new Error('fixture failure'));
        await rejected;
        assert.equal(store.getState().connections[0]?.icon, remove ? undefined : 'manual');
    }
});

test('missing hosts and existing manual icons produce no save or store notification', async () => {
    const { store, writes } = fixture([{ ...host, icon: 'manual' }]);
    let notifications = 0;
    store.subscribe(() => {
        notifications++;
    });
    await store.getState().setConnectionIconIfMissing(host.id, 'linux');
    await store.getState().setConnectionIconIfMissing('removed', 'linux');
    assert.equal(writes.length, 0);
    assert.equal(notifications, 0);
});
