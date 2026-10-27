import { createStore } from 'zustand/vanilla';

import type { FileEntry } from '../../src/components/file-manager/types';
import { acquireFileDestination } from '../../src/features/files/application/fileDestinationReservations';
import { bindNotifyDispatcher, unbindNotifyDispatcher } from '../../src/features/notifications';
import { createTransferSlice } from '../../src/store/transferSlice';
import type { AppStore } from '../../src/store/useAppStore';

interface ListingRequest {
    connectionId: string;
    path: string;
    resolve: (entries: FileEntry[]) => void;
}

function equal(actual: unknown, expected: unknown, message: string): void {
    if (!Object.is(actual, expected)) {
        throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
    }
}

function sameValues(actual: unknown, expected: unknown, message: string): void {
    equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

const requests: ListingRequest[] = [];
let nativeOverride: ((command: string, args: unknown) => Promise<unknown>) | null = null;
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
        ipcRenderer: {
            invoke(command: string, args: { connectionId: string; path: string }) {
                if (nativeOverride) {
                    return nativeOverride(command, args);
                }
                equal(command, 'fs_list', 'Refresh must issue directory reads only');
                if (requests.length >= 8) {
                    throw new Error('Unexpected unbounded refresh requests');
                }
                return new Promise<FileEntry[]>((resolve) => requests.push({ ...args, resolve }));
            },
        },
    },
});

// The real slice captures its native bridge during module initialization.
const { acknowledgeMovedClipboard, createFileSystemSlice, filesStoreKey, splitFileName } =
    await import('../../src/store/fileSystemSlice');
let serial = 0;

function fixture(connectionId = `refresh-fixture-${++serial}`) {
    // Other application slices are intentionally absent: accidental cross-feature access must fail.
    const store = createStore<AppStore>()((...args) => {
        const initial: Partial<AppStore> = {
            ...createFileSystemSlice(...args),
            ...createTransferSlice(...args),
            connections: [],
            disconnect: () => {
                throw new Error('A refresh must not disconnect this fixture');
            },
            setLastAction: () => {},
        };
        return initial as AppStore;
    });
    return { store, connectionId };
}

function entry(name: string, folder: string): FileEntry {
    return {
        name,
        path: `${folder}/${name}`,
        type: '-',
        size: 1,
        lastModified: 1,
        permissions: '644',
        owner: '',
        group: '',
    };
}

function takeRequest(path: string): ListingRequest {
    const index = requests.findIndex((request) => request.path === path);
    if (index === -1) {
        throw new Error(`Expected a listing request for ${path}`);
    }
    return requests.splice(index, 1)[0];
}

async function run(name: string, test: () => Promise<void>): Promise<void> {
    equal(requests.length, 0, 'Previous test must finish all native reads');
    await test();
    equal(requests.length, 0, 'Every expected native read must be consumed');
    console.log(`  ok ${name}`);
}

function deferred() {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

const paneStateFields = [
    'files',
    'currentPath',
    'history',
    'historyIndex',
    'isLoading',
    'error',
    'listingReadDenial',
] as const;

function assertDisposedPane(state: AppStore, key: string): void {
    for (const field of paneStateFields) {
        equal(
            Object.hasOwn(state[field], key),
            false,
            `Closed pane must release its ${field} entry`,
        );
    }
}

try {
    await run('Keep Both shares filename rules while preserving dotted folder names', async () => {
        sameValues(
            splitFileName('project.v2', true),
            { base: 'project.v2', ext: '' },
            'A directory has no file extension',
        );
        sameValues(
            splitFileName('report.txt'),
            { base: 'report', ext: '.txt' },
            'Keep normal file extensions',
        );
        sameValues(splitFileName('.env'), { base: '.env', ext: '' }, 'Keep dotfiles intact');
    });
    await run(
        'a connection refresh reads the base and every split instance at its own path',
        async () => {
            const { store, connectionId } = fixture();
            const left = filesStoreKey(connectionId, 'left');
            const right = filesStoreKey(connectionId, 'right');
            const histories = { [connectionId]: ['/base'], [left]: ['/left'], [right]: ['/right'] };
            store.setState({
                currentPath: { [connectionId]: '/base', [left]: '/left', [right]: '/right' },
                history: histories,
                historyIndex: { [connectionId]: 0, [left]: 0, [right]: 0 },
            });

            let finished = false;
            const refresh = store
                .getState()
                .refreshConnectionFiles(connectionId)
                .then(() => {
                    finished = true;
                });
            sameValues(
                requests.map((request) => request.path).sort(),
                ['/base', '/left', '/right'],
                'Refresh each listing once',
            );
            equal(
                store.getState().isLoading[left],
                undefined,
                'Background refresh must not replace the listing with a spinner',
            );
            const base = takeRequest('/base');
            const leftRequest = takeRequest('/left');
            const rightRequest = takeRequest('/right');
            for (const request of [base, leftRequest, rightRequest]) {
                equal(request.connectionId, connectionId, 'Use the actual endpoint identity');
            }
            base.resolve([entry('base-result', '/base')]);
            leftRequest.resolve([entry('left-result', '/left')]);
            await Promise.resolve();
            equal(finished, false, 'The refresh promise must include every instance');
            rightRequest.resolve([entry('right-result', '/right')]);
            await refresh;

            equal(
                store.getState().files[left][0].name,
                'left-result',
                'Keep split results independent',
            );
            equal(
                store.getState().files[right][0].name,
                'right-result',
                'Keep the other split independent',
            );
            sameValues(
                store.getState().history,
                histories,
                'Refresh must preserve navigation history',
            );
        },
    );

    await run(
        'a split-only connection refresh does not require a base listing or match another host prefix',
        async () => {
            const { store, connectionId } = fixture();
            const pane = filesStoreKey(connectionId, 'pane');
            const unrelatedId = `${connectionId}-other`;
            const unrelatedPane = filesStoreKey(unrelatedId, 'pane');
            const untouched = [entry('unrelated', '/unrelated')];
            store.setState({
                currentPath: {
                    [pane]: '/pane',
                    [unrelatedId]: '/unrelated',
                    [unrelatedPane]: '/unrelated-pane',
                    [filesStoreKey(connectionId, 'unresolved')]: '',
                },
                files: { [unrelatedId]: untouched },
            });

            const refresh = store.getState().refreshConnectionFiles(connectionId);
            equal(requests.length, 1, 'Only the resolved matching instance needs a read');
            takeRequest('/pane').resolve([entry('pane-result', '/pane')]);
            await refresh;
            equal(
                store.getState().files[pane][0].name,
                'pane-result',
                'Refresh the split without a base key',
            );
            equal(
                store.getState().currentPath[connectionId],
                undefined,
                'Do not create a base path',
            );
            equal(
                store.getState().files[unrelatedId],
                untouched,
                'Do not touch a similarly named endpoint',
            );
            equal(
                store.getState().files[unrelatedPane],
                undefined,
                'Do not load its split instance',
            );
        },
    );

    await run(
        'completion refresh uses the current folder rather than a former transfer destination',
        async () => {
            const { store, connectionId } = fixture();
            store.getState().setPath(connectionId, '/transfer-destination', 'pane');
            store.getState().setPath(connectionId, '/user-current-folder', 'pane');
            const refresh = store.getState().refreshConnectionFiles(connectionId);
            equal(requests.length, 1, 'Read the currently open folder once');
            takeRequest('/user-current-folder').resolve([]);
            await refresh;
            equal(
                store.getState().currentPath[filesStoreKey(connectionId, 'pane')],
                '/user-current-folder',
                'Do not navigate back after a transfer',
            );
        },
    );

    await run('navigation started during a refresh wins over its late listing reply', async () => {
        const { store, connectionId } = fixture();
        const pane = filesStoreKey(connectionId, 'pane');
        store.getState().setPath(connectionId, '/old', 'pane');
        const refresh = store.getState().refreshConnectionFiles(connectionId);
        const old = takeRequest('/old');
        const navigation = store.getState().loadFiles(connectionId, '/new', false, false, 'pane');
        takeRequest('/new').resolve([entry('new-result', '/new')]);
        await navigation;
        old.resolve([entry('stale-result', '/old')]);
        await refresh;
        equal(store.getState().currentPath[pane], '/new', 'The old refresh cannot undo navigation');
        equal(
            store.getState().files[pane][0].name,
            'new-result',
            'The old refresh cannot replace the newer listing',
        );
    });

    await run('a connection without an open resolved path performs no work', async () => {
        const { store, connectionId } = fixture();
        await store.getState().refreshConnectionFiles(connectionId);
        equal(requests.length, 0, 'Do not open a file manager implicitly');
    });

    await run(
        'disposing base and split Files panes releases only their own browsing state',
        async () => {
            for (const instanceId of [undefined, 'closing']) {
                const { store, connectionId } = fixture();
                const closed = filesStoreKey(connectionId, instanceId);
                const survivors = [
                    filesStoreKey(connectionId, instanceId ? undefined : 'sibling'),
                    filesStoreKey(connectionId, 'retained'),
                    filesStoreKey(`${connectionId}-other`, 'closing'),
                ];
                const keys = [closed, ...survivors];
                store.setState({
                    files: Object.fromEntries(keys.map((key) => [key, [entry(key, '/folder')]])),
                    currentPath: Object.fromEntries(keys.map((key) => [key, '/folder'])),
                    history: Object.fromEntries(keys.map((key) => [key, ['/previous', '/folder']])),
                    historyIndex: Object.fromEntries(keys.map((key) => [key, 1])),
                    isLoading: Object.fromEntries(keys.map((key) => [key, true])),
                    error: Object.fromEntries(keys.map((key) => [key, 'Permission denied'])),
                    listingReadDenial: Object.fromEntries(
                        keys.map((key) => [key, { path: '/private', connection: undefined }]),
                    ),
                    recentPaths: { [connectionId]: ['/folder', '/previous'] },
                });
                store
                    .getState()
                    .setClipboard(
                        [entry('clipboard', '/folder')],
                        connectionId,
                        '/folder',
                        'copy',
                        instanceId,
                    );
                const before = store.getState();
                store.getState().disposeFilesInstance(connectionId, instanceId);
                store.getState().disposeFilesInstance(connectionId, instanceId);
                const after = store.getState();
                assertDisposedPane(after, closed);
                for (const key of survivors) {
                    for (const field of paneStateFields) {
                        equal(
                            after[field][key],
                            before[field][key],
                            `Retain another pane's ${field}`,
                        );
                    }
                }
                equal(
                    after.recentPaths,
                    before.recentPaths,
                    'Recent folders belong to the connection, not the closed pane',
                );
                equal(
                    after.clipboard,
                    before.clipboard,
                    'Closing a pane must not consume the shared copy intent',
                );
            }
        },
    );

    await run(
        'disposed Files instances are excluded from direct and connection-wide refresh',
        async () => {
            for (const instanceId of [undefined, 'closing']) {
                const { store, connectionId } = fixture();
                const retainedInstance = instanceId ? undefined : 'retained';
                store.getState().setPath(connectionId, '/closed', instanceId);
                store.getState().setPath(connectionId, '/retained', retainedInstance);
                store.getState().disposeFilesInstance(connectionId, instanceId);
                await store.getState().refreshFiles(connectionId, instanceId);
                equal(requests.length, 0, 'Direct refresh cannot recreate a closed instance');
                const refresh = store.getState().refreshConnectionFiles(connectionId);
                sameValues(
                    requests.map((request) => request.path),
                    ['/retained'],
                    'Only the surviving Files pane needs a read',
                );
                takeRequest('/retained').resolve([entry('retained-result', '/retained')]);
                await refresh;
                assertDisposedPane(store.getState(), filesStoreKey(connectionId, instanceId));
                equal(
                    store.getState().files[filesStoreKey(connectionId, retainedInstance)][0].name,
                    'retained-result',
                    'Keep refreshing the surviving pane',
                );
            }
        },
    );

    await run(
        'late listing results cannot revive a disposed pane or trigger recovery reads',
        async () => {
            for (const outcome of [
                'success',
                'Permission denied',
                'No such file',
                'DISCONNECTED: late reply',
                'Connection not found',
            ]) {
                const { store, connectionId } = fixture();
                const key = filesStoreKey(connectionId, 'closing');
                const completion = deferred();
                const commands: string[] = [];
                store.setState({ recentPaths: { [connectionId]: ['/retained-recent'] } });
                const recents = store.getState().recentPaths;
                nativeOverride = async (command) => {
                    commands.push(command);
                    equal(command, 'fs_list', 'Only the accepted listing read is allowed');
                    await completion.promise;
                    return [entry('stale', '/closed')];
                };
                try {
                    const loading = store
                        .getState()
                        .loadFiles(connectionId, '/closed', false, false, 'closing');
                    store.getState().disposeFilesInstance(connectionId, 'closing');
                    const refresh = store.getState().refreshFiles(connectionId, 'closing');
                    if (outcome === 'success') {
                        completion.resolve();
                    } else {
                        completion.reject(new Error(outcome));
                    }
                    await Promise.all([loading, refresh]);
                    assertDisposedPane(store.getState(), key);
                    equal(
                        store.getState().recentPaths,
                        recents,
                        'A closed pane cannot add a late recent folder',
                    );
                    sameValues(
                        commands,
                        ['fs_list'],
                        'Disposal invalidates the pending refresh target and suppresses stale fallback reads',
                    );
                } finally {
                    nativeOverride = null;
                }
            }
        },
    );

    await run('closing during home resolution prevents a later directory request', async () => {
        for (const rejected of [false, true]) {
            const { store, connectionId } = fixture();
            const completion = deferred();
            const commands: string[] = [];
            store.setState({
                connections: [
                    { id: connectionId, homePath: '' } as AppStore['connections'][number],
                ],
            });
            nativeOverride = async (command) => {
                commands.push(command);
                if (command === 'fs_cwd') {
                    await completion.promise;
                    return '/home/fixture';
                }
                equal(command, 'fs_list', 'Home resolution cannot perform a mutation');
                return [];
            };
            try {
                const loading = store
                    .getState()
                    .loadFiles(connectionId, '~', false, false, 'closing');
                store.getState().disposeFilesInstance(connectionId, 'closing');
                if (rejected) {
                    completion.reject(new Error('Home lookup ended after close'));
                } else {
                    completion.resolve();
                }
                await loading;
                await store.getState().refreshFiles(connectionId, 'closing');
                assertDisposedPane(store.getState(), filesStoreKey(connectionId, 'closing'));
                sameValues(
                    commands,
                    ['fs_cwd'],
                    'A closed home lookup cannot start or retain another read',
                );
            } finally {
                nativeOverride = null;
            }
        }
    });

    await run(
        'reopening the same Files identity never accepts the previous lifetime listing',
        async () => {
            for (const startNewRead of [false, true]) {
                for (const rejected of [false, true]) {
                    const { store, connectionId } = fixture();
                    const key = filesStoreKey(connectionId, 'reopened');
                    const completion = deferred();
                    let calls = 0;
                    nativeOverride = async (command) => {
                        equal(command, 'fs_list', 'Reopening requires listing reads only');
                        if (++calls === 1) {
                            await completion.promise;
                            return [entry('stale', '/same-folder')];
                        }
                        return [entry('fresh', '/same-folder')];
                    };
                    try {
                        const oldRead = store
                            .getState()
                            .loadFiles(connectionId, '/same-folder', false, false, 'reopened');
                        store.getState().disposeFilesInstance(connectionId, 'reopened');
                        store.getState().setPath(connectionId, '/same-folder', 'reopened');
                        if (startNewRead) {
                            await store
                                .getState()
                                .loadFiles(connectionId, '/same-folder', false, false, 'reopened');
                        }
                        const reopened = store.getState();
                        if (rejected) {
                            completion.reject(new Error('Permission denied'));
                        } else {
                            completion.resolve();
                        }
                        await oldRead;
                        for (const field of paneStateFields) {
                            equal(
                                store.getState()[field][key],
                                reopened[field][key],
                                `Old lifetime cannot change reopened ${field}`,
                            );
                        }
                        equal(
                            store.getState().recentPaths,
                            reopened.recentPaths,
                            'Old lifetime cannot replace reopened recents',
                        );
                        if (!startNewRead) {
                            await store
                                .getState()
                                .loadFiles(connectionId, '/same-folder', false, false, 'reopened');
                        }
                        equal(
                            store.getState().files[key][0].name,
                            'fresh',
                            'The reopened pane can load normally',
                        );
                    } finally {
                        nativeOverride = null;
                    }
                }
            }
        },
    );

    await run(
        'late mkdir and rename failures do not recreate closed or reopened pane state',
        async () => {
            for (const operation of ['mkdir', 'rename']) {
                for (const reopen of [false, true]) {
                    for (const reason of [
                        'DISCONNECTED: mutation ended after close',
                        'Permission denied',
                    ]) {
                        const { store, connectionId } = fixture();
                        const key = filesStoreKey(connectionId, 'closing');
                        const mutation = deferred();
                        const read = deferred();
                        const commands: string[] = [];
                        store.getState().setPath(connectionId, '/destination', 'closing');
                        bindNotifyDispatcher(() => {});
                        nativeOverride = async (command) => {
                            commands.push(command);
                            if (command === 'fs_list') {
                                await read.promise;
                                return [entry('fresh', '/destination')];
                            }
                            equal(
                                command,
                                operation === 'mkdir' ? 'fs_mkdir' : 'fs_rename',
                                'Do not replay or replace an accepted mutation',
                            );
                            await mutation.promise;
                        };
                        try {
                            const work =
                                operation === 'mkdir'
                                    ? store
                                          .getState()
                                          .createFolder(connectionId, 'created', 'closing')
                                    : store
                                          .getState()
                                          .renameEntry(connectionId, 'old', 'new', 'closing');
                            store.getState().disposeFilesInstance(connectionId, 'closing');
                            const loading = reopen
                                ? store
                                      .getState()
                                      .loadFiles(
                                          connectionId,
                                          '/destination',
                                          false,
                                          false,
                                          'closing',
                                      )
                                : null;
                            const beforeFailure = store.getState();
                            mutation.reject(new Error(reason));
                            await work;
                            if (reopen) {
                                equal(
                                    store.getState().isLoading[key],
                                    true,
                                    'The reopened listing still owns its loading indicator',
                                );
                                equal(
                                    store.getState().error[key],
                                    beforeFailure.error[key],
                                    'A former mutation cannot supply the reopened pane error',
                                );
                                read.resolve();
                                await loading;
                                equal(
                                    store.getState().files[key][0].name,
                                    'fresh',
                                    'Finish the reopened listing normally',
                                );
                            } else {
                                assertDisposedPane(store.getState(), key);
                            }
                            sameValues(
                                commands,
                                [
                                    operation === 'mkdir' ? 'fs_mkdir' : 'fs_rename',
                                    ...(reopen ? ['fs_list'] : []),
                                ],
                                'Only the original mutation and explicit reopened read may run',
                            );
                            acquireFileDestination(
                                connectionId,
                                operation === 'mkdir' ? '/destination/created' : '/destination/old',
                            ).release();
                        } finally {
                            nativeOverride = null;
                            unbindNotifyDispatcher();
                        }
                    }
                }
            }
        },
    );

    await run(
        'listing denials retain the attempted path, not the still-visible parent, and clear on retry',
        async () => {
            const { store, connectionId } = fixture();
            const pane = filesStoreKey(connectionId, 'pane');
            const other = filesStoreKey(connectionId, 'other');
            store.getState().setPath(connectionId, '/parent', 'pane');
            nativeOverride = async () => {
                throw 'SFTP read_dir failed: Permission denied: Permission denied';
            };
            try {
                await store
                    .getState()
                    .loadFiles(connectionId, '/parent/private', false, false, 'pane');
                equal(
                    store.getState().currentPath[pane],
                    '/parent',
                    'Failed navigation retains the successful parent',
                );
                equal(
                    store.getState().listingReadDenial[pane]?.path,
                    '/parent/private',
                    'Bind denial to the attempted child',
                );
                equal(
                    store.getState().listingReadDenial[other],
                    undefined,
                    'Other panes do not acquire this failure',
                );
                store.getState().copyFilesListing(connectionId, 'pane', 'other');
                equal(
                    store.getState().listingReadDenial[other]?.path,
                    '/parent/private',
                    'A copied error retains its own target',
                );
                nativeOverride = async () => [];
                await store.getState().refreshFiles(connectionId, 'pane');
                equal(
                    store.getState().listingReadDenial[pane],
                    null,
                    'Fresh reads clear old evidence',
                );
                equal(store.getState().error[pane], null, 'Retry clears the corresponding banner');
            } finally {
                nativeOverride = null;
            }
        },
    );

    await run(
        'late failures and replaced connections cannot supply read-denial evidence',
        async () => {
            const { store, connectionId } = fixture();
            const failure = deferred();
            nativeOverride = async (_command, args) => {
                if ((args as { path: string }).path === '/private') {
                    await failure.promise;
                }
                return [];
            };
            try {
                const oldRead = store.getState().loadFiles(connectionId, '/private');
                await store.getState().loadFiles(connectionId, '/newer');
                failure.reject(new Error('Permission denied'));
                await oldRead;
                equal(
                    store.getState().listingReadDenial[connectionId],
                    null,
                    'Stale rejection cannot overwrite a newer read',
                );
                const connection = {
                    id: connectionId,
                    status: 'connected',
                } as AppStore['connections'][number];
                store.setState({ connections: [connection] });
                nativeOverride = async () => {
                    store.setState({ connections: [{ ...connection }] });
                    throw 'Permission denied';
                };
                await store.getState().loadFiles(connectionId, '/private');
                equal(
                    store.getState().listingReadDenial[connectionId],
                    null,
                    'A previous connection cannot deny access for its replacement',
                );
                for (const reason of [
                    'session closed',
                    'Read-only file system',
                    'Cannot read /Permission denied: No such file',
                ]) {
                    nativeOverride = async () => {
                        throw reason;
                    };
                    await store.getState().loadFiles(connectionId, '/');
                    equal(
                        store.getState().listingReadDenial[connectionId],
                        null,
                        'Only a read-access denial supplies evidence',
                    );
                }
            } finally {
                nativeOverride = null;
            }
        },
    );

    await run(
        'delete immediately hides native local/SSH paths and refreshes all matching panes after completion',
        async () => {
            for (const [local, instanceId] of [
                [true, undefined],
                [true, 'peer'],
                [false, 'peer'],
            ] as const) {
                const { store, connectionId } = fixture(local ? 'local' : undefined);
                const key = filesStoreKey(connectionId, instanceId);
                const directory = local ? 'C:/delete-fixture' : '/delete-fixture';
                const removed = {
                    ...entry('remove.txt', directory),
                    path: local ? 'C:\\delete-fixture\\remove.txt' : `${directory}/remove.txt`,
                };
                const kept = entry('keep.txt', directory);
                const peer = filesStoreKey(connectionId, 'peer');
                const other = filesStoreKey(connectionId, 'other');
                const unrelated = [entry('unrelated', '/unrelated')];
                store.setState({
                    currentPath: {
                        [connectionId]: directory,
                        [peer]: directory,
                        [other]: '/other',
                        foreign: '/unrelated',
                    },
                    files: {
                        [connectionId]: [removed, kept],
                        [peer]: [removed, kept],
                        [other]: [],
                        foreign: unrelated,
                    },
                });
                const native = deferred();
                const reads: string[] = [];
                let mutations = 0;
                nativeOverride = async (command, args) => {
                    if (command === 'fs_list') {
                        const request = args as { connectionId: string; path: string };
                        equal(request.connectionId, connectionId, 'Never refresh another endpoint');
                        reads.push(request.path);
                        return request.path === directory ? [kept] : [];
                    }
                    equal(command, 'fs_delete_batch', 'Keep the existing native delete command');
                    sameValues(
                        args,
                        { connectionId, paths: [removed.path] },
                        'Keep native listing path bytes unchanged',
                    );
                    mutations++;
                    await native.promise;
                };
                try {
                    const deletion = store
                        .getState()
                        .deleteEntries(connectionId, [removed.path], instanceId);
                    sameValues(
                        store.getState().files[key],
                        [kept],
                        'Hide the deleted entry without waiting for native completion',
                    );
                    equal(reads.length, 0, 'Do not refresh before native acknowledges deletion');
                    native.resolve();
                    await deletion;
                    equal(mutations, 1, 'Submit the deletion once');
                    sameValues(
                        reads.sort(),
                        [directory, directory, '/other'].sort(),
                        'Reconcile base and split panes at their current paths',
                    );
                    sameValues(
                        store.getState().files[peer].map((file) => file.path),
                        [kept.path],
                        'A sibling pane no longer shows the deleted item',
                    );
                    equal(
                        store.getState().files.foreign,
                        unrelated,
                        'Leave unrelated endpoint listings untouched',
                    );
                    acquireFileDestination(connectionId, removed.path).release();
                } finally {
                    native.resolve();
                    nativeOverride = null;
                }
            }
        },
    );

    await run(
        'partial and opaque delete failures restore only the owned optimistic view',
        async () => {
            for (const partial of [true, false]) {
                const { store, connectionId } = fixture();
                const deleted = entry('deleted', '/folder');
                const failed = entry('failed', '/folder');
                const kept = entry('kept', '/folder');
                const expected = partial ? [failed, kept] : [deleted, failed, kept];
                store.setState({
                    currentPath: { [connectionId]: '/folder' },
                    files: { [connectionId]: [deleted, failed, kept] },
                });
                const native = deferred();
                const read = deferred();
                const refreshing = deferred();
                const messages: string[] = [];
                bindNotifyDispatcher((_level, message) => {
                    messages.push(message);
                    return 'delete-test';
                });
                nativeOverride = async (command) => {
                    if (command === 'fs_delete_batch') {
                        return native.promise;
                    }
                    equal(command, 'fs_list', 'A failed batch is reconciled with a fresh listing');
                    refreshing.resolve();
                    await read.promise;
                    return expected;
                };
                try {
                    const deletion = store
                        .getState()
                        .deleteEntries(connectionId, [deleted.path, failed.path]);
                    native.reject(
                        partial
                            ? {
                                  message: 'Some files could not be deleted',
                                  failed_paths: [failed.path],
                              }
                            : new Error('Permission denied'),
                    );
                    await refreshing.promise;
                    sameValues(
                        store.getState().files[connectionId],
                        expected,
                        'Restore failures while awaiting the authoritative read',
                    );
                    equal(messages.length, 1, 'Report one delete error');
                    read.resolve();
                    await deletion;
                    sameValues(
                        store.getState().files[connectionId].map((file) => file.path),
                        expected.map((file) => file.path),
                        'Keep the reconciled listing',
                    );
                    acquireFileDestination(connectionId, failed.path).release();
                } finally {
                    read.resolve();
                    nativeOverride = null;
                    unbindNotifyDispatcher();
                }
            }
        },
    );

    await run(
        'empty deletion does no IPC and disconnected deletion does not trigger refresh or reconnect',
        async () => {
            const { store, connectionId } = fixture();
            const original = [entry('keep', '/folder')];
            store.setState({
                currentPath: { [connectionId]: '/folder' },
                files: { [connectionId]: original },
            });
            const calls: string[] = [];
            nativeOverride = async (command) => {
                calls.push(command);
                throw new Error('DISCONNECTED: Connection closed');
            };
            try {
                await store.getState().deleteEntries(connectionId, []);
                equal(calls.length, 0, 'An empty selection has no side effects');
                equal(
                    store.getState().files[connectionId],
                    original,
                    'Keep the existing listing identity',
                );
                await store.getState().deleteEntries(connectionId, [original[0].path]);
                sameValues(
                    calls,
                    ['fs_delete_batch'],
                    'Do not automatically repeat a mutation or reconnect through refresh',
                );
                sameValues(
                    store.getState().files[connectionId],
                    original,
                    'Restore the unchanged failed entry',
                );
                equal(
                    store.getState().error[connectionId],
                    'DISCONNECTED',
                    'Keep the established disconnected presentation',
                );
            } finally {
                nativeOverride = null;
            }
        },
    );

    await run(
        'a late failed delete cannot restore a snapshot over navigation or a newer listing update',
        async () => {
            for (const navigate of [true, false]) {
                const { store, connectionId } = fixture();
                const removed = entry('old', '/old');
                store.setState({
                    currentPath: { [connectionId]: '/old' },
                    files: { [connectionId]: [removed] },
                });
                const native = deferred();
                const read = deferred();
                const refreshing = deferred();
                const newPath = navigate ? '/new' : '/old';
                const newer = [entry('newer', newPath)];
                let refreshStarted = false;
                nativeOverride = async (command) => {
                    if (command === 'fs_delete_batch') {
                        return native.promise;
                    }
                    equal(command, 'fs_list', 'Reconcile through the shared listing reader');
                    if (!refreshStarted) {
                        return newer;
                    }
                    refreshing.resolve();
                    await read.promise;
                    return newer;
                };
                try {
                    const deletion = store.getState().deleteEntries(connectionId, [removed.path]);
                    if (navigate) {
                        await store.getState().loadFiles(connectionId, newPath);
                    } else {
                        store.setState({ files: { [connectionId]: newer } });
                    }
                    const currentFiles = store.getState().files[connectionId];
                    refreshStarted = true;
                    native.reject(new Error('Permission denied'));
                    await refreshing.promise;
                    equal(
                        store.getState().files[connectionId],
                        currentFiles,
                        'Never replay the old snapshot into a newer view',
                    );
                    read.resolve();
                    await deletion;
                    equal(
                        store.getState().currentPath[connectionId],
                        newPath,
                        'Do not navigate back after the failure',
                    );
                } finally {
                    read.resolve();
                    nativeOverride = null;
                }
            }
        },
    );

    await run(
        'delete completion refreshes an in-flight navigation target rather than the old displayed folder',
        async () => {
            const { store, connectionId } = fixture();
            const removed = entry('old', '/old');
            store.setState({
                currentPath: { [connectionId]: '/old' },
                files: { [connectionId]: [removed] },
            });
            const native = deferred();
            const refreshing = deferred();
            let reads = 0;
            nativeOverride = async (command, args) => {
                if (command === 'fs_delete_batch') {
                    return native.promise;
                }
                equal(command, 'fs_list', 'Completion only reads metadata');
                const request = args as { connectionId: string; path: string };
                return new Promise<FileEntry[]>((resolve) => {
                    requests.push({ ...request, resolve });
                    if (++reads === 2) {
                        refreshing.resolve();
                    }
                });
            };
            try {
                const deletion = store.getState().deleteEntries(connectionId, [removed.path]);
                const navigation = store.getState().loadFiles(connectionId, '/new');
                const original = takeRequest('/new');
                native.resolve();
                // The navigation request was taken above, so this waits for its fresh successor.
                await refreshing.promise;
                const refreshed = takeRequest('/new');
                refreshed.resolve([entry('fresh', '/new')]);
                await deletion;
                original.resolve([entry('stale', '/new')]);
                await navigation;
                equal(
                    store.getState().currentPath[connectionId],
                    '/new',
                    'The pending user navigation wins',
                );
                equal(
                    store.getState().files[connectionId][0].name,
                    'fresh',
                    'Its older reply cannot replace the post-delete read',
                );
            } finally {
                native.resolve();
                nativeOverride = null;
            }
        },
    );

    await run(
        'a completion refresh cannot cancel navigation while its home path is resolving',
        async () => {
            const { store, connectionId } = fixture();
            store.setState({
                currentPath: { [connectionId]: '/old' },
                files: { [connectionId]: [] },
                history: { [connectionId]: ['/old'] },
                historyIndex: { [connectionId]: 0 },
            });
            const cwd = deferred();
            const reads: string[] = [];
            nativeOverride = async (command, args) => {
                if (command === 'fs_cwd') {
                    await cwd.promise;
                    return '/home/test';
                }
                equal(command, 'fs_list', 'Home resolution only reads directory metadata');
                const path = (args as { path: string }).path;
                reads.push(path);
                return [entry('home-result', path)];
            };
            try {
                const navigation = store.getState().loadFiles(connectionId, '~');
                const refresh = store.getState().refreshConnectionFiles(connectionId);
                cwd.resolve();
                await Promise.all([navigation, refresh]);
                sameValues(
                    reads,
                    ['/home/test'],
                    'Home resolution performs the fresh read, not a refresh of the old folder',
                );
                equal(
                    store.getState().currentPath[connectionId],
                    '/home/test',
                    'Preserve the user navigation',
                );
                sameValues(
                    store.getState().history[connectionId],
                    ['/old', '/home/test'],
                    'Preserve its history entry',
                );
            } finally {
                cwd.resolve();
                nativeOverride = null;
            }
        },
    );

    await run(
        'an unresolved home request does not leave ordinary refresh permanently pending',
        async () => {
            const { store, connectionId } = fixture();
            store.setState({
                currentPath: { [connectionId]: '/old' },
                files: { [connectionId]: [] },
            });
            const reads: string[] = [];
            nativeOverride = async (command, args) => {
                if (command === 'fs_cwd') {
                    return '~';
                }
                equal(
                    command,
                    'fs_list',
                    'After failed home resolution refresh the current real folder',
                );
                reads.push((args as { path: string }).path);
                return [];
            };
            try {
                await store.getState().loadFiles(connectionId, '~');
                await store.getState().refreshFiles(connectionId);
                sameValues(
                    reads,
                    ['/old'],
                    'A completed unresolved request must not block later refresh',
                );
            } finally {
                nativeOverride = null;
            }
        },
    );

    await run(
        'paste outcomes before the first listing cannot revive a disposed Files view',
        async () => {
            for (const op of ['copy', 'cut'] as const) {
                for (const outcome of [
                    'success',
                    'DISCONNECTED: native outcome unavailable',
                    'Permission denied',
                ]) {
                    const { store, connectionId } = fixture();
                    const key = filesStoreKey(connectionId, 'closing');
                    const source = entry('source', '/source');
                    const submitted = deferred();
                    const mutation = deferred();
                    const commands: string[] = [];
                    let completed = false;
                    store.getState().setClipboard([source], connectionId, '/source', op);
                    const clipboard = store.getState().clipboard;
                    bindNotifyDispatcher(() => {});
                    nativeOverride = async (command) => {
                        commands.push(command);
                        if (command === 'fs_exists') {
                            return false;
                        }
                        equal(
                            command,
                            op === 'copy' ? 'fs_copy_batch' : 'fs_rename_batch',
                            'Keep the accepted native mutation route',
                        );
                        submitted.resolve();
                        await mutation.promise;
                    };
                    try {
                        const work = store
                            .getState()
                            .pasteEntries(
                                connectionId,
                                [source.path],
                                op,
                                '/destination',
                                'closing',
                            )
                            .then((result) => {
                                completed = true;
                                return result;
                            });
                        await submitted.promise;
                        equal(
                            store.getState().currentPath[key],
                            undefined,
                            'No first listing or path has initialized this view',
                        );
                        store.getState().disposeFilesInstance(connectionId, 'closing');
                        await Promise.resolve();
                        equal(
                            completed,
                            false,
                            'Closing the view does not finish or cancel the accepted mutation',
                        );
                        if (outcome === 'success') {
                            mutation.resolve();
                        } else {
                            mutation.reject(new Error(outcome));
                        }
                        equal(
                            await work,
                            outcome === 'success',
                            'Preserve the actual native paste result after close',
                        );
                        assertDisposedPane(store.getState(), key);
                        equal(
                            store.getState().clipboard,
                            op === 'cut' && outcome === 'success' ? null : clipboard,
                            'Only an acknowledged move may consume the shared clipboard',
                        );
                        const nativeCommand = op === 'copy' ? 'fs_copy_batch' : 'fs_rename_batch';
                        equal(
                            commands.filter((command) => command === nativeCommand).length,
                            1,
                            'Submit the mutation exactly once',
                        );
                        equal(
                            commands.every(
                                (command) => command === 'fs_exists' || command === nativeCommand,
                            ),
                            true,
                            'Closing or completing a paste cannot add cancellation, replay or listing requests',
                        );
                        acquireFileDestination(connectionId, '/destination/source').release();
                    } finally {
                        nativeOverride = null;
                        unbindNotifyDispatcher();
                    }
                }
            }
        },
    );

    await run(
        'same-endpoint copy cancellation is quiet without hiding an uncertain close',
        async () => {
            for (const error of ['Cancelled', 'Cancelled; destination close failed']) {
                const { store, connectionId } = fixture();
                const messages: string[] = [];
                store.getState().setPath(connectionId, '/destination');
                const source = entry('source', '/source');
                store.getState().setClipboard([source], connectionId, '/source', 'copy');
                bindNotifyDispatcher((_type, message) => messages.push(message));
                nativeOverride = async (command) => {
                    if (command === 'fs_exists') {
                        return false;
                    }
                    equal(command, 'fs_copy_batch', 'Keep the existing same-endpoint copy route');
                    throw error;
                };
                try {
                    equal(
                        await store.getState().pasteEntries(connectionId, [source.path], 'copy'),
                        false,
                        'Cancellation/failure never reports success',
                    );
                    equal(
                        messages.length,
                        error === 'Cancelled' ? 0 : 1,
                        'Only a genuine failure needs a notification',
                    );
                    equal(
                        store.getState().isLoading[connectionId],
                        false,
                        'Finish the browsing loading state',
                    );
                    const reservation = acquireFileDestination(connectionId, '/destination/source');
                    reservation.release();
                } finally {
                    nativeOverride = null;
                    unbindNotifyDispatcher();
                }
            }
        },
    );

    await run(
        'a failed same-endpoint move returns failure and preserves the cut clipboard',
        async () => {
            for (const error of [
                'Destination write denied',
                'DISCONNECTED: Rename outcome unconfirmed',
            ]) {
                const { store, connectionId } = fixture();
                store.getState().setPath(connectionId, '/destination');
                const source = entry('source', '/source');
                store.getState().setClipboard([source], connectionId, '/source', 'cut');
                const clipboard = store.getState().clipboard;
                nativeOverride = async (command) => {
                    if (command === 'fs_exists') {
                        return false;
                    }
                    equal(command, 'fs_rename_batch', 'Only the requested move may mutate');
                    throw error;
                };
                try {
                    const moved = await store
                        .getState()
                        .pasteEntries(connectionId, [source.path], 'cut');
                    equal(
                        moved,
                        false,
                        'A swallowed mutation failure cannot be mistaken for success',
                    );
                    equal(
                        store.getState().clipboard,
                        clipboard,
                        'Retain the original clipboard for review',
                    );
                } finally {
                    nativeOverride = null;
                }
            }
        },
    );

    await run(
        'acknowledged moves remove only the original cut entries on the matching endpoint',
        async () => {
            const first = entry('first', '/source');
            const second = entry('second', '/source');
            const clipboard = {
                intentId: 'original-cut',
                files: [first, second],
                sourceConnectionId: 'host',
                sourcePath: '/source',
                op: 'cut' as const,
            };
            const partial = acknowledgeMovedClipboard(clipboard, clipboard, 'host', [first.path]);
            sameValues(partial?.files, [second], 'Retain unresolved cut entries');
            equal(
                partial?.intentId,
                clipboard.intentId,
                'Partial acknowledgement retains the original intent identity',
            );
            equal(
                acknowledgeMovedClipboard(clipboard, clipboard, 'different-host', [first.path]),
                clipboard,
                'Other endpoint acknowledgements cannot clear this cut',
            );
            const copied = { ...clipboard, op: 'copy' as const };
            equal(
                acknowledgeMovedClipboard(copied, copied, 'host', [first.path]),
                copied,
                'Copy intent remains reusable',
            );
            const newer = { ...clipboard, intentId: 'newer-cut' };
            equal(
                acknowledgeMovedClipboard(newer, clipboard, 'host', [first.path]),
                newer,
                'Do not modify a newer user intent',
            );
            equal(
                acknowledgeMovedClipboard(clipboard, null, 'host', [first.path]),
                clipboard,
                'An absent captured intent cannot authorize acknowledgement',
            );
            equal(
                acknowledgeMovedClipboard(clipboard, clipboard, 'host', ['/unknown']),
                clipboard,
                'Unknown paths do not alter clipboard identity',
            );
            equal(
                acknowledgeMovedClipboard(partial, clipboard, 'host', [second.path]),
                null,
                'A concurrent completion can acknowledge against the original captured intent',
            );
        },
    );

    await run(
        'a confirmed partial move preserves the unattempted cut entries and newer clipboard',
        async () => {
            const { store, connectionId } = fixture();
            const first = entry('first', '/source');
            const second = entry('second', '/source');
            store.getState().setPath(connectionId, '/destination');
            store.getState().setClipboard([first, second], connectionId, '/source', 'cut');
            const sourceKey = filesStoreKey(connectionId, 'source');
            store.setState({ files: { [sourceKey]: [first, second] } });
            const submitted = deferred();
            const mutation = deferred();
            nativeOverride = async (command) => {
                if (command === 'fs_exists') {
                    return false;
                }
                equal(command, 'fs_rename_batch', 'Only the requested move may mutate');
                submitted.resolve();
                await mutation.promise;
            };
            try {
                const moved = store.getState().pasteEntries(connectionId, [first.path], 'cut');
                await submitted.promise;
                mutation.resolve();
                equal(await moved, true, 'Success requires the native batch acknowledgement');
                sameValues(
                    store.getState().clipboard?.files,
                    [second],
                    'Acknowledge only this successful subset',
                );

                const nextSubmitted = deferred();
                const nextMutation = deferred();
                nativeOverride = async (command) => {
                    if (command === 'fs_exists') {
                        return false;
                    }
                    equal(command, 'fs_rename_batch', 'Keep the mutation boundary explicit');
                    nextSubmitted.resolve();
                    await nextMutation.promise;
                };
                const nextMove = store.getState().pasteEntries(connectionId, [second.path], 'cut');
                await nextSubmitted.promise;
                store
                    .getState()
                    .setClipboard(
                        [entry('new-selection', '/elsewhere')],
                        connectionId,
                        '/elsewhere',
                        'cut',
                    );
                const newerClipboard = store.getState().clipboard;
                nextMutation.resolve();
                equal(await nextMove, true, 'The earlier write still completes');
                equal(
                    store.getState().clipboard,
                    newerClipboard,
                    'Its outcome cannot consume a newer selection',
                );
            } finally {
                nativeOverride = null;
            }
        },
    );

    await run(
        'two panes can acknowledge disjoint moves from one cut intent in either completion order',
        async () => {
            for (const completionOrder of [
                [0, 1],
                [1, 0],
            ]) {
                const { store, connectionId } = fixture();
                const first = entry('first', '/source');
                const second = entry('second', '/source');
                store.getState().setPath(connectionId, '/left', 'left');
                store.getState().setPath(connectionId, '/right', 'right');
                store.getState().setClipboard([first, second], connectionId, '/source', 'cut');
                const originalIntentId = store.getState().clipboard?.intentId;
                const submitted = [deferred(), deferred()];
                const mutations = [deferred(), deferred()];
                let nextSubmission = 0;
                nativeOverride = async (command) => {
                    if (command === 'fs_exists') {
                        return false;
                    }
                    equal(
                        command,
                        'fs_rename_batch',
                        'Both pane moves use the native batch acknowledgement',
                    );
                    const index = nextSubmission++;
                    submitted[index].resolve();
                    await mutations[index].promise;
                };
                try {
                    const moves = [
                        store
                            .getState()
                            .pasteEntries(connectionId, [first.path], 'cut', undefined, 'left'),
                        store
                            .getState()
                            .pasteEntries(connectionId, [second.path], 'cut', undefined, 'right'),
                    ];
                    await Promise.all(submitted.map((item) => item.promise));
                    mutations[completionOrder[0]].resolve();
                    equal(await moves[completionOrder[0]], true, 'First acknowledgement succeeds');
                    sameValues(
                        store.getState().clipboard?.files,
                        [completionOrder[0] === 0 ? second : first],
                        'Retain only the pending source',
                    );
                    equal(
                        store.getState().clipboard?.intentId,
                        originalIntentId,
                        'Both operations still belong to the same user cut intent',
                    );
                    mutations[completionOrder[1]].resolve();
                    equal(
                        await moves[completionOrder[1]],
                        true,
                        'Concurrent acknowledgement succeeds',
                    );
                    equal(
                        store.getState().clipboard,
                        null,
                        'Every acknowledged source leaves the original cut intent',
                    );
                } finally {
                    nativeOverride = null;
                }
            }
        },
    );

    await run(
        'setting an identical clipboard selection creates a fresh intent protected from old outcomes',
        async () => {
            const { store, connectionId } = fixture();
            const source = entry('source', '/source');
            store.getState().setClipboard([source], connectionId, '/source', 'cut');
            const oldIntent = store.getState().clipboard;
            store.getState().setClipboard([source], connectionId, '/source', 'cut');
            const newIntent = store.getState().clipboard;
            equal(
                oldIntent?.intentId === newIntent?.intentId,
                false,
                'A repeated user action is not the old intent',
            );
            equal(
                acknowledgeMovedClipboard(newIntent, oldIntent, connectionId, [source.path]),
                newIntent,
                'An old completion cannot consume an identical newer selection',
            );
        },
    );

    await run(
        'a late successful paste cannot append old-folder entries or clear new-folder loading',
        async () => {
            const { store, connectionId } = fixture();
            const pane = filesStoreKey(connectionId, 'pane');
            const source = entry('source', '/source');
            store.getState().setPath(connectionId, '/destination', 'pane');
            store.getState().setClipboard([source], connectionId, '/source', 'cut');
            const submitted = deferred();
            const mutation = deferred();
            nativeOverride = async (command) => {
                if (command === 'fs_exists') {
                    return false;
                }
                equal(command, 'fs_rename_batch', 'Await the requested move');
                submitted.resolve();
                await mutation.promise;
            };
            try {
                const moved = store
                    .getState()
                    .pasteEntries(connectionId, [source.path], 'cut', undefined, 'pane');
                await submitted.promise;
                const freshListing = [entry('new-folder-file', '/new')];
                store.getState().setPath(connectionId, '/new', 'pane');
                store.setState({ files: { [pane]: freshListing }, isLoading: { [pane]: true } });
                mutation.resolve();
                equal(await moved, true, 'Keep the actual successful move result');
                equal(
                    store.getState().files[pane],
                    freshListing,
                    'Do not pollute the newer folder',
                );
                equal(
                    store.getState().isLoading[pane],
                    true,
                    'The newer navigation owns its loading state',
                );
                equal(
                    store.getState().clipboard,
                    null,
                    'Actual movement still acknowledges the original cut intent',
                );
            } finally {
                nativeOverride = null;
            }
        },
    );

    await run(
        'pasting a cut into its own folder leaves the original entry and clipboard intact',
        async () => {
            const { store, connectionId } = fixture();
            const source = entry('source', '/same');
            store.getState().setPath(connectionId, '/same');
            store.getState().setClipboard([source], connectionId, '/same', 'cut');
            const clipboard = store.getState().clipboard;
            const listing = [source];
            store.setState({ files: { [connectionId]: listing } });
            nativeOverride = async () => {
                throw new Error('A same-path no-op must not mutate');
            };
            try {
                equal(
                    await store.getState().pasteEntries(connectionId, [source.path], 'cut'),
                    false,
                    'No mutation was acknowledged',
                );
                equal(store.getState().clipboard, clipboard, 'Do not consume skipped cut entries');
                equal(
                    store.getState().files[connectionId],
                    listing,
                    'Do not remove the skipped source from its listing',
                );
            } finally {
                nativeOverride = null;
            }
        },
    );

    await run('a newer read of the same folder owns its listing and loading state', async () => {
        const { store, connectionId } = fixture();
        const source = entry('source', '/source');
        store.getState().setPath(connectionId, '/destination');
        const before = [entry('before', '/destination')];
        store.setState({ files: { [connectionId]: before } });
        const submitted = deferred();
        const mutation = deferred();
        let resolveListing!: (entries: FileEntry[]) => void;
        nativeOverride = async (command) => {
            if (command === 'fs_exists') {
                return false;
            }
            if (command === 'fs_list') {
                return new Promise<FileEntry[]>((resolve) => {
                    resolveListing = resolve;
                });
            }
            equal(command, 'fs_copy_batch', 'Await the requested copy');
            submitted.resolve();
            await mutation.promise;
        };
        try {
            const copied = store.getState().pasteEntries(connectionId, [source.path], 'copy');
            await submitted.promise;
            const refreshed = store.getState().loadFiles(connectionId, '/destination', true);
            mutation.resolve();
            equal(await copied, true, 'The copy outcome is independent of the newer read');
            equal(
                store.getState().files[connectionId],
                before,
                'Do not append an optimistic entry while the newer read owns the view',
            );
            equal(
                store.getState().isLoading[connectionId],
                true,
                'Do not clear a newer same-path request',
            );
            resolveListing([entry('refreshed', '/destination')]);
            await refreshed;
            equal(
                store.getState().files[connectionId][0].name,
                'refreshed',
                'Use the actual newer listing result',
            );
        } finally {
            nativeOverride = null;
        }
    });

    await run(
        'a busy path rejects a whole paste batch before mutation and releases earlier admissions',
        async () => {
            const { store, connectionId } = fixture();
            store.getState().setPath(connectionId, '/destination');
            const sources = [entry('first', '/source'), entry('second', '/source')];
            store.getState().setClipboard(sources, connectionId, '/source', 'cut');
            const clipboard = store.getState().clipboard;
            const busy = acquireFileDestination(connectionId, '/destination/second');
            let mutations = 0;
            nativeOverride = async (command) => {
                if (command === 'fs_exists') {
                    return false;
                }
                mutations += 1;
            };
            try {
                equal(
                    await store.getState().pasteEntries(
                        connectionId,
                        sources.map((source) => source.path),
                        'cut',
                    ),
                    false,
                    'Do not partially submit an admitted batch',
                );
                equal(mutations, 0, 'No batch may start if one destination is busy');
                equal(
                    store.getState().clipboard,
                    clipboard,
                    'Busy admission cannot acknowledge an unattempted cut',
                );
                equal(
                    store.getState().isLoading[connectionId],
                    false,
                    'Busy admission must not leave the listing loading',
                );
                acquireFileDestination(connectionId, '/destination/first').release();
                acquireFileDestination(connectionId, '/source/first').release();
            } finally {
                busy.release();
                nativeOverride = null;
            }
        },
    );

    await run('cutting an active writer source is rejected before the move starts', async () => {
        const { store, connectionId } = fixture();
        store.getState().setPath(connectionId, '/destination');
        const busy = acquireFileDestination(connectionId, '/source/file');
        let mutations = 0;
        nativeOverride = async (command) => {
            if (command === 'fs_exists') {
                return false;
            }
            mutations += 1;
        };
        try {
            equal(
                await store.getState().pasteEntries(connectionId, ['/source/file'], 'cut'),
                false,
                'An active writer must not be retargeted',
            );
            equal(mutations, 0, 'Do not submit a rename of an active destination');
            acquireFileDestination(connectionId, '/destination/file').release();
        } finally {
            busy.release();
            nativeOverride = null;
        }
    });

    await run(
        'ordinary uploads retain destination admission through the real native result',
        async () => {
            const { store, connectionId } = fixture();
            store.getState().setPath(connectionId, '/destination');
            const native = deferred();
            let calls = 0;
            let refreshReads = 0;
            nativeOverride = async (command, args) => {
                if (command === 'fs_list') {
                    refreshReads++;
                    return [entry('file', '/destination')];
                }
                equal(command, 'fs_transfer_file', 'Upload uses the shared staged native adapter');
                calls += 1;
                await native.promise;
                const request = args as Record<string, unknown>;
                return {
                    version: 1,
                    id: request.transferId,
                    sourceConnectionId: request.sourceConnectionId,
                    sourcePath: request.sourcePath,
                    destinationConnectionId: request.destinationConnectionId,
                    destinationPath: request.destinationPath,
                    stagePath: '/destination/.zync-transfer-test.part',
                    backupPath: '/destination/.zync-transfer-test.backup',
                    backupExpected: false,
                    phase: 'completed',
                    createdAt: 1,
                    transferred: 1,
                    total: 1,
                    destinationUnchanged: false,
                    warning: null,
                    error: null,
                };
            };
            try {
                await store.getState().uploadFiles(connectionId, ['/source/file']);
                equal(
                    store.getState().transfers[0].status,
                    'pending',
                    'Starting an upload must not claim completion',
                );
                await store.getState().uploadFiles(connectionId, ['/other/file']);
                equal(calls, 1, 'A second upload cannot overwrite an active destination');
                equal(
                    store.getState().transfers[1].status,
                    'failed',
                    'Retain the rejected upload receipt',
                );
                equal(
                    store.getState().transfers[1].error?.startsWith('Destination is busy:'),
                    true,
                    'Explain why the upload was rejected',
                );
                equal(
                    refreshReads,
                    0,
                    'A rejected admission does not refresh an unchanged destination',
                );
                native.resolve();
                for (let i = 0; i < 5; i += 1) {
                    await Promise.resolve();
                }
                equal(
                    store.getState().transfers[0].status,
                    'completed',
                    'Record the actual first upload completion',
                );
                equal(
                    refreshReads,
                    1,
                    'An accepted native receipt refreshes without waiting for an event',
                );
                acquireFileDestination(connectionId, '/destination/file').release();
            } finally {
                native.resolve();
                nativeOverride = null;
            }
        },
    );

    await run(
        'ordinary mutations cannot rename, delete or create over an active destination',
        async () => {
            const { store, connectionId } = fixture();
            store.getState().setPath(connectionId, '/destination');
            store.setState({ refreshFiles: async () => {} });
            const busy = acquireFileDestination(connectionId, '/destination/file');
            let mutations = 0;
            nativeOverride = async () => {
                mutations += 1;
            };
            try {
                await store.getState().createFolder(connectionId, 'file');
                await store.getState().renameEntry(connectionId, 'file', 'other');
                await store.getState().renameEntry(connectionId, 'other', 'file');
                await store.getState().deleteEntries(connectionId, ['/destination/file']);
                equal(mutations, 0, 'Busy guards must precede each native mutation');
                acquireFileDestination(connectionId, '/destination/other').release();
            } finally {
                busy.release();
                nativeOverride = null;
            }
        },
    );

    await run(
        'a Windows case-only rename is one admitted mutation, not competing self-leases',
        async () => {
            const { store, connectionId } = fixture();
            store.getState().setPath(connectionId, 'C:/destination');
            store.setState({ refreshFiles: async () => {} });
            let mutations = 0;
            nativeOverride = async (command) => {
                equal(command, 'fs_rename', 'Keep the original rename operation');
                mutations += 1;
            };
            try {
                await store.getState().renameEntry(connectionId, 'File', 'file');
                equal(mutations, 1, 'A single rename may own both of its paths');
                acquireFileDestination(connectionId, 'C:/destination/file').release();
            } finally {
                nativeOverride = null;
            }
        },
    );
} finally {
    if (windowDescriptor) {
        Object.defineProperty(globalThis, 'window', windowDescriptor);
    } else {
        Reflect.deleteProperty(globalThis, 'window');
    }
}
