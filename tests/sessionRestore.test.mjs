import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import ts from 'typescript';

import * as canvases from '../.tmp-agent-tests/src/features/workspace/domain/canvases.js';
import * as docking from '../.tmp-agent-tests/src/features/workspace/domain/docking.js';
import * as dockingTopology from '../.tmp-agent-tests/src/features/workspace/domain/dockingTopology.js';
import * as presentation from '../.tmp-agent-tests/src/features/workspace/domain/presentation.js';
import * as paneGroups from '../.tmp-agent-tests/src/lib/paneLayout/groups.js';
import * as paneLayout from '../.tmp-agent-tests/src/lib/paneLayout/index.js';
import * as regions from '../.tmp-agent-tests/src/lib/paneLayout/regions.js';
import { loadWorkspaceDomain } from './helpers/loadWorkspaceDomain.mjs';

/** Exercise production slice actions with only native IPC and feature services isolated. */
function loadSource(path, dependencies, globals = {}) {
    const { outputText } = ts.transpileModule(
        readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'),
        {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        },
    );
    const context = {
        exports: {},
        require: (name) => {
            assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
            return dependencies[name];
        },
        ...globals,
    };
    runInNewContext(outputText, context);
    return context.exports;
}

const contentPresentation = loadSource('src/features/workspace/domain/contentPresentation.ts', {
    './presentation': presentation,
});
const mainTabPresentation = loadWorkspaceDomain('features/workspace/domain/mainTabPresentation.ts');
const registrations = loadSource('src/features/workspace/domain/registrations.ts', {
    '../../../lib/paneLayout/types': loadSource('src/lib/paneLayout/types.ts', {}),
    '../../../lib/paneLayout/regions': regions,
});
const registrationAdapters = loadSource(
    'src/features/workspace/application/viewRegistrationAdapters.ts',
    {
        '../../../lib/paneLayout/regions': regions,
        '../domain/registrations': registrations,
        '../../plugins/application/pluginPanelInventory': loadSource(
            'src/features/plugins/application/pluginPanelInventory.ts',
            {},
        ),
    },
);
const sessionPersistence = loadSource('src/store/sessionPersistence.ts', {
    '../lib/paneLayout': paneLayout,
    '../features/workspace/domain/presentation': presentation,
    '../features/workspace/domain/contentPresentation': contentPresentation,
    '../features/workspace/domain/mainTabPresentation': mainTabPresentation,
    '../features/workspace/domain/docking': docking,
});

function harness({
    data = null,
    loadError,
    onLoad = async () => data,
    onSave = async () => {},
} = {}) {
    const calls = [];
    const warnings = [];
    const toasts = [];
    const session = loadSource(
        'src/store/sessionSlice.ts',
        {
            '@tauri-apps/api/core': {
                invoke: async (command, args) => {
                    calls.push({ command, args });
                    if (command === 'session_load') {
                        if (loadError) {
                            throw loadError;
                        }
                        return onLoad();
                    }
                    if (command === 'session_save') {
                        return onSave(args.data);
                    }
                    throw new Error(`Unexpected native command: ${command}`);
                },
            },
            './sessionPersistence': sessionPersistence,
            '../features/workspace/domain/contentPresentation': contentPresentation,
            '../features/workspace/domain/mainTabPresentation': mainTabPresentation,
            '../features/workspace/domain/docking': docking,
        },
        { setTimeout, clearTimeout, console: { warn: (...args) => warnings.push(args) } },
    );
    const unexpectedRuntimeWork = () => {
        throw new Error('Restore must not start runtime work');
    };
    const terminal = loadSource(
        'src/store/terminalSlice.ts',
        {
            '../features/usage': { track: unexpectedRuntimeWork },
            '../lib/terminal': {
                terminalService: new Proxy({}, { get: () => unexpectedRuntimeWork }),
            },
            './sessionSlice': { scheduleSaveSession: unexpectedRuntimeWork },
            '../lib/paneCloseBlockers': {},
            '../lib/paneLayout': paneLayout,
            '../lib/paneLayout/groups': paneGroups,
            '../features/workspace/application/viewRegistrationAdapters': registrationAdapters,
            '../features/workspace/application/contentLifecycle': {
                disposeWorkspaceContent: () => {},
            },
            '../features/workspace/domain/dockingTopology': dockingTopology,
            '../features/workspace/domain/canvases': canvases,
            '../features/workspace/domain/docking': docking,
            '../features/workspace/domain/paneTabRelease': loadWorkspaceDomain(
                'features/workspace/domain/paneTabRelease.ts',
            ),
            '../features/workspace/domain/contentPresentation': contentPresentation,
        },
        { window: { ipcRenderer: { invoke: unexpectedRuntimeWork, on: unexpectedRuntimeWork } } },
    );
    let state = {
        connections: [{ id: 'ssh-features' }, { id: 'ssh-terms' }],
        tabs: [],
        activeTabId: null,
        activeConnectionId: null,
        showWelcomeScreen: false,
        contentPresentation: {},
        showToast: (...args) => toasts.push(args),
        restoreTabState: (tabs, activeTabId, activeConnectionId, showWelcomeScreen) => {
            state = { ...state, tabs, activeTabId, activeConnectionId, showWelcomeScreen };
        },
    };
    const set = (patch) => {
        state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
    };
    const get = () => state;
    state = {
        ...state,
        ...terminal.createTerminalSlice(set, get),
        ...session.createSessionSlice(set, get),
    };
    return { get, set, calls, warnings, toasts, cleanup: session.resetSessionDebounce };
}

test('docking roundtrips dormant placement without creating or connecting content', async () => {
    const docking = {
        local: { version: 1, placements: { '["plugin","fixture","absent"]': 'bottom-panel' } },
    };
    const subject = harness({
        data: {
            version: 1,
            tabs: [],
            terminals: {},
            activeTerminalIds: {},
            workspaceDocking: docking,
        },
    });
    await subject.get().loadSession();
    assert.equal(JSON.stringify(subject.get().workspaceDocking), JSON.stringify(docking));
    assert.deepEqual(Object.keys(subject.get().terminals), []);
    assert.deepEqual(Object.keys(subject.get().paneLayouts), []);
    await subject.get().saveSession();
    assert.equal(
        JSON.stringify(
            subject.calls.find((call) => call.command === 'session_save').args.data
                .workspaceDocking,
        ),
        JSON.stringify(docking),
    );
    subject.cleanup();
});

test('unsupported docking blocks restoration before changing content or replacing runtime metadata', async () => {
    for (const workspaceDocking of [
        null,
        { local: { version: 2, placements: {} } },
        { local: { version: 1, placements: {}, unknown: true } },
    ]) {
        const subject = harness({
            data: { version: 1, tabs: [{ id: 'not-restored' }], workspaceDocking },
        });
        const prior = {
            prior: { version: 1, placements: { '["term","existing"]': 'primary-sidebar' } },
        };
        subject.set({ workspaceDocking: prior });
        await subject.get().loadSession();
        assert.equal(subject.get().sessionPersistenceBlocked, true);
        assert.equal(subject.get().workspaceDocking, prior);
        assert.equal(subject.get().tabs.length, 0);
        await subject.get().saveSession();
        assert.equal(subject.calls.length, 1);
        subject.cleanup();
    }
});

test('unsupported in-memory docking cannot be stripped by a save', async () => {
    const subject = harness();
    await subject.get().loadSession();
    const future = { local: { version: 2, placements: {} } };
    subject.set({ workspaceDocking: future });
    await subject.get().saveSession();
    assert.equal(subject.get().sessionPersistenceBlocked, true);
    assert.equal(subject.get().workspaceDocking, future);
    assert.equal(subject.calls.length, 1);
    subject.cleanup();
});

test('restoration includes feature/plugin-only scopes without creating terminal sessions', async () => {
    const files = paneLayout.singleFeaturePane('files', 'files-pane', 'files-instance');
    const plugin = paneLayout.singlePluginPane('fixture-plugin', 'plugin-pane', 'plugin-instance');
    const subject = harness({
        data: {
            version: 1,
            tabs: [],
            terminals: {},
            activeTerminalIds: {},
            paneLayouts: {
                local: { 'files-instance': files },
                'ssh-features': { 'plugin-instance': plugin },
                deleted: { 'files-instance': files },
            },
        },
    });
    await subject.get().loadSession();
    assert.equal(
        subject.get().paneLayouts.local['files-instance'].root.content.instanceId,
        'files-instance',
    );
    assert.equal(
        subject.get().paneLayouts['ssh-features']['plugin-instance'].root.content.pluginId,
        'fixture-plugin',
    );
    assert.equal(subject.get().terminals.local.length, 0);
    assert.equal(subject.get().terminals['ssh-features'].length, 0);
    assert.equal(subject.get().paneLayouts.deleted, undefined);
    assert.equal(subject.get().sessionLoaded, true);
    assert.equal(subject.get().isRestoring, false);
    assert.equal(subject.calls.length, 1);
    subject.cleanup();
});

test('restoration validates each scope and accepts native null option fields', async () => {
    const subject = harness({
        data: {
            version: 0,
            tabs: 'invalid-array',
            activeTerminalIds: { local: 12, 'ssh-terms': 'term-remote' },
            terminals: {
                local: [
                    null,
                    { id: 'bad', title: 42 },
                    {
                        id: 'local-shell',
                        title: 'Shell',
                        cwd: null,
                        initialPath: null,
                        isSynced: null,
                        shellOverride: null,
                        tabVisible: null,
                    },
                    { id: 'local-shell', title: 'Duplicate' },
                ],
                'ssh-features': 'not-an-array',
                'ssh-terms': [{ id: 'term-remote', title: 'Remote', cwd: '/fixture' }],
                deleted: [{ id: 'term-deleted', title: 'Deleted' }],
            },
            paneLayouts: {
                'ssh-features': {
                    'files-instance': paneLayout.singleFeaturePane(
                        'files',
                        'files-pane',
                        'files-instance',
                    ),
                },
            },
        },
    });
    await subject.get().loadSession();
    assert.equal(subject.get().tabs.length, 0);
    assert.equal(subject.get().terminals.local.length, 1);
    assert.equal(subject.get().terminals.local[0].id, 'local-shell');
    assert.equal(subject.get().terminals.local[0].pendingRestore, undefined);
    assert.equal(subject.get().terminals['ssh-terms'][0].pendingRestore, true);
    assert.equal(subject.get().terminals['ssh-terms'][0].lastKnownCwd, '/fixture');
    assert.ok(subject.get().paneLayouts['ssh-features']['files-instance']);
    assert.equal(subject.get().terminals.deleted, undefined);
    assert.equal(subject.warnings.length, 0);
    subject.cleanup();
});

test('malformed scope maps do not prevent startup', async () => {
    const subject = harness({
        data: {
            version: 1,
            tabs: [],
            terminals: ['not-a-map'],
            paneLayouts: false,
            activeTerminalIds: null,
        },
    });
    await subject.get().loadSession();
    assert.equal(subject.get().sessionLoaded, true);
    assert.equal(Object.keys(subject.get().terminals).length, 0);
    assert.equal(subject.warnings.length, 0);
    subject.cleanup();
});

test('unsupported native schema errors unblock startup but suppress subsequent saves', async () => {
    const subject = harness({ loadError: 'SESSION_UNSUPPORTED_VERSION: newer session file' });
    await subject.get().loadSession();
    assert.equal(subject.get().sessionLoaded, true);
    assert.equal(subject.get().sessionPersistenceBlocked, true);
    await subject.get().saveSession();
    await subject.get().saveSession();
    assert.equal(subject.calls.length, 1);
    assert.equal(subject.warnings.length, 1);
    assert.equal(subject.toasts.length, 1);
    assert.equal(subject.toasts[0][0], 'warning');
    assert.match(subject.toasts[0][1], /preserved.*will not be saved.*Update Zync/);
    await subject.get().loadSession();
    await subject.get().saveSession();
    assert.equal(subject.toasts.length, 1, 'Repeated loads and saves must not repeat the warning');
    subject.cleanup();
});

test('a future payload is also blocked before any partial restoration', async () => {
    const subject = harness({ data: { version: 2, tabs: [{ id: 'future' }], terminals: {} } });
    await subject.get().loadSession();
    assert.equal(subject.get().tabs.length, 0);
    assert.equal(subject.get().sessionPersistenceBlocked, true);
    assert.equal(subject.get().sessionLoaded, true);
    subject.cleanup();
});

test('a save-time schema rejection cancels queued writes and reports once', async () => {
    const subject = harness({
        onSave: async () => {
            throw 'SESSION_UNSUPPORTED_VERSION: file replaced by newer app';
        },
    });
    subject.set({ sessionLoaded: true });
    const first = subject.get().saveSession();
    subject.set({ activeConnectionId: 'changed' });
    const second = subject.get().saveSession();
    await Promise.all([first, second]);
    assert.equal(subject.calls.length, 1);
    assert.equal(subject.get().sessionPersistenceBlocked, true);
    assert.equal(subject.warnings.length, 1);
    assert.equal(subject.toasts.length, 1);
    subject.cleanup();
});

test('ordinary failed writes remain retryable and successful snapshots are dirty-checked', async () => {
    let attempts = 0;
    const subject = harness({
        onSave: async () => {
            if (++attempts === 1) {
                throw new Error('fixture I/O failure');
            }
        },
    });
    subject.set({ sessionLoaded: true });
    await subject.get().saveSession();
    await subject.get().saveSession();
    await subject.get().saveSession();
    assert.equal(attempts, 2);
    assert.equal(subject.get().sessionPersistenceBlocked, false);
    assert.equal(subject.warnings.length, 1);
    assert.equal(
        subject.toasts.length,
        0,
        'Unrelated I/O errors do not claim recovery-copy failure',
    );
    subject.cleanup();
});

test('recovery-copy failures warn once without blocking retries or exposing raw details', async () => {
    let attempts = 0;
    const privateDetail = 'private-profile-path';
    const subject = harness({
        onSave: async () => {
            attempts++;
            if (attempts === 1) {
                throw `SESSION_BACKUP_FAILED: ${privateDetail}`;
            }
            throw new Error(`SESSION_BACKUP_FAILED: ${privateDetail}`);
        },
    });
    subject.set({ sessionLoaded: true });
    await subject.get().saveSession();
    await subject.get().saveSession();
    assert.equal(attempts, 2, 'An unchanged failed snapshot remains retryable');
    assert.equal(subject.get().sessionPersistenceBlocked, false);
    assert.equal(subject.toasts.length, 1);
    assert.equal(subject.toasts[0][0], 'warning');
    assert.match(subject.toasts[0][1], /recovery copy.*previous saved workspace is unchanged/i);
    assert.equal(subject.toasts[0][1].includes(privateDetail), false);
    subject.cleanup();
});

test('successful saving and reload each begin a new recovery-copy warning episode', async () => {
    let failing = true;
    let attempts = 0;
    const subject = harness({
        onSave: async () => {
            attempts++;
            if (failing) {
                throw 'SESSION_BACKUP_FAILED: fixture';
            }
        },
    });
    subject.set({ sessionLoaded: true });
    await subject.get().saveSession();
    failing = false;
    await subject.get().saveSession();
    assert.equal(attempts, 2);
    failing = true;
    subject.set({ activeConnectionId: 'changed-after-success' });
    await subject.get().saveSession();
    assert.equal(subject.toasts.length, 2, 'A later failure is reported after a successful retry');
    await subject.get().saveSession();
    assert.equal(subject.toasts.length, 2);
    await subject.get().loadSession();
    await subject.get().saveSession();
    assert.equal(subject.toasts.length, 3, 'Reload clears only the failure-episode suppression');
    assert.equal(subject.get().sessionPersistenceBlocked, false);
    subject.cleanup();
});

function deferred() {
    let resolve;
    const promise = new Promise((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}

test('startup saves before or during a deferred load cannot overwrite the stored snapshot', async () => {
    const loaded = deferred();
    const subject = harness({ onLoad: () => loaded.promise });
    await subject.get().saveSession();
    assert.equal(subject.calls.length, 0);
    const loading = subject.get().loadSession();
    assert.equal(subject.get().isRestoring, true);
    await subject.get().saveSession();
    assert.equal(subject.calls.filter((call) => call.command === 'session_save').length, 0);
    loaded.resolve({
        version: 1,
        tabs: [],
        terminals: { local: [{ id: 'saved-shell', title: 'Saved shell' }] },
    });
    await loading;
    assert.equal(subject.get().terminals.local[0].id, 'saved-shell');
    assert.equal(subject.get().sessionLoaded, true);
    assert.equal(subject.get().isRestoring, false);
    await subject.get().saveSession();
    assert.equal(subject.calls.filter((call) => call.command === 'session_save').length, 1);
    subject.cleanup();
});

test('restore drains an in-flight write but discards stale queued snapshots', async () => {
    const written = deferred();
    const subject = harness({ onSave: () => written.promise });
    subject.set({ sessionLoaded: true });
    const first = subject.get().saveSession();
    await Promise.resolve();
    assert.equal(subject.calls.length, 1, 'First save has reached the native boundary');
    subject.set({ activeConnectionId: 'stale-queued-change' });
    const stale = subject.get().saveSession();
    const loading = subject.get().loadSession();
    assert.equal(subject.get().isRestoring, true);
    assert.equal(subject.calls.length, 1, 'Loading waits for the already-dispatched write');
    written.resolve();
    await Promise.all([first, stale, loading]);
    assert.deepEqual(
        subject.calls.map((call) => call.command),
        ['session_save', 'session_load'],
    );
    assert.equal(subject.get().sessionLoaded, true);
    assert.equal(subject.get().isRestoring, false);
    subject.cleanup();
});

test('superseded load results cannot restore stale data or release the current load gate', async () => {
    const earlier = deferred();
    const current = deferred();
    let loads = 0;
    const subject = harness({ onLoad: () => (++loads === 1 ? earlier.promise : current.promise) });
    const first = subject.get().loadSession();
    await Promise.resolve();
    const second = subject.get().loadSession();
    await Promise.resolve();
    earlier.resolve({ version: 1, tabs: [{ id: 'stale-tab' }], terminals: {} });
    await first;
    assert.equal(subject.get().tabs.length, 0);
    assert.equal(subject.get().sessionLoaded, false);
    assert.equal(subject.get().isRestoring, true);
    current.resolve({ version: 1, tabs: [], terminals: {} });
    await second;
    assert.equal(subject.get().sessionLoaded, true);
    assert.equal(subject.get().isRestoring, false);
    subject.cleanup();
});

test('reload invalidates the dirty snapshot when returning to a previously saved state', async () => {
    let disk = { version: 1, tabs: [], terminals: { local: [{ id: 'shell', title: 'A' }] } };
    const saves = [];
    const subject = harness({
        onLoad: async () => disk,
        onSave: async (data) => {
            saves.push(data);
        },
    });
    await subject.get().loadSession();
    const originalTerminals = subject.get().terminals;
    await subject.get().saveSession();
    assert.equal(saves.length, 1);

    disk = { version: 1, tabs: [], terminals: { local: [{ id: 'shell', title: 'B' }] } };
    await subject.get().loadSession();
    assert.equal(subject.get().terminals.local[0].title, 'B');
    subject.set({ terminals: originalTerminals });
    await subject.get().saveSession();
    assert.equal(saves.length, 2, 'Returning to A must write because reload observed B on disk');
    assert.equal(saves[1].terminals.local[0].title, 'A');
    subject.cleanup();
});

test('presentation aliases restore independently of the live inventory and remain in snapshots', async () => {
    const key = '["plugin","fixture-plugin","offline-instance"]';
    const metadata = {
        local: { version: 1, items: { [key]: { displayAlias: '  Plugin workspace  ' } } },
    };
    const subject = harness({
        data: { version: 1, tabs: [], terminals: {}, contentPresentation: metadata },
    });
    await subject.get().loadSession();
    assert.equal(
        subject.get().contentPresentation.local.items[key].displayAlias,
        'Plugin workspace',
    );
    assert.equal(
        Object.keys(subject.get().terminals).length,
        0,
        'Metadata cannot create terminal/plugin instances',
    );
    await subject.get().saveSession();
    const saved = subject.calls.find((call) => call.command === 'session_save').args.data;
    assert.equal(saved.contentPresentation.local.items[key].displayAlias, 'Plugin workspace');
    assert.equal(saved.contentPresentation.local.version, 3);
    subject.cleanup();
});

test('future presentation blocks restoration and save without dropping its envelope', async () => {
    const subject = harness({
        data: {
            version: 1,
            tabs: [{ id: 'not-restored' }],
            terminals: {},
            contentPresentation: { local: { version: 4, items: {} } },
        },
    });
    await subject.get().loadSession();
    assert.equal(subject.get().sessionPersistenceBlocked, true);
    assert.equal(subject.get().sessionLoaded, true);
    assert.equal(subject.get().tabs.length, 0);
    await subject.get().saveSession();
    assert.equal(subject.calls.length, 1);
    assert.equal(subject.toasts.length, 1);
    subject.cleanup();
});

test('v2 instance pins and dormant order survive restoration without creating resources', async () => {
    const present = '["term","shell"]';
    const absent = '["plugin","owner:panel","offline"]';
    const subject = harness({
        data: {
            version: 1,
            tabs: [],
            terminals: {},
            contentPresentation: {
                local: {
                    version: 2,
                    items: {
                        [present]: { displayAlias: 'Shell', pinned: true },
                        [absent]: { pinned: false },
                    },
                    order: [absent, present],
                },
            },
        },
    });
    await subject.get().loadSession();
    await subject.get().saveSession();
    const saved = subject.calls.find((call) => call.command === 'session_save').args.data;
    assert.equal(saved.contentPresentation.local.items[present].pinned, true);
    assert.equal(saved.contentPresentation.local.items[absent], undefined);
    assert.deepEqual(Array.from(saved.contentPresentation.local.order), [absent, present]);
    assert.equal(Object.keys(subject.get().terminals).length, 0);
    subject.cleanup();
});

test('unexpected in-memory presentation is never stripped by session serialization', async () => {
    const subject = harness();
    subject.set({ sessionLoaded: true, contentPresentation: { local: { version: 2 } } });
    await subject.get().saveSession();
    assert.equal(subject.calls.length, 0);
    assert.equal(subject.get().sessionPersistenceBlocked, true);
    assert.equal(subject.toasts.length, 1);
    subject.cleanup();
});

test('v3 hidden metadata restores without removing canonical sessions or creating dormant content', async () => {
    const present = '["term","shell"]';
    const absent = '["plugin","owner:panel","offline"]';
    const subject = harness({
        data: {
            version: 1,
            tabs: [],
            terminals: { local: [{ id: 'shell', title: 'Shell' }] },
            contentPresentation: {
                local: {
                    version: 3,
                    items: {
                        [present]: { displayAlias: 'Build', pinned: true, hidden: true },
                        [absent]: { hidden: false },
                    },
                    order: [absent, present],
                },
            },
        },
    });
    await subject.get().loadSession();
    assert.equal(subject.get().terminals.local.length, 1);
    assert.equal(subject.get().terminals.local[0].id, 'shell');
    assert.equal(subject.get().contentPresentation.local.items[present].hidden, true);
    assert.equal(subject.get().contentPresentation.local.items[absent], undefined);
    await subject.get().saveSession();
    const saved = subject.calls.find((call) => call.command === 'session_save').args.data;
    assert.equal(saved.terminals.local.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(saved.contentPresentation.local)), {
        version: 3,
        items: { [present]: { displayAlias: 'Build', pinned: true, hidden: true } },
        order: [absent, present],
    });
    subject.cleanup();
});

test('visibility fields in older schemas block restore rather than being silently stripped', async () => {
    const subject = harness({
        data: {
            version: 1,
            tabs: [{ id: 'not-restored' }],
            terminals: {},
            contentPresentation: {
                local: { version: 2, items: { '["term","shell"]': { hidden: true } } },
            },
        },
    });
    await subject.get().loadSession();
    assert.equal(subject.get().sessionPersistenceBlocked, true);
    assert.equal(subject.get().sessionLoaded, true);
    assert.equal(subject.get().tabs.length, 0);
    await subject.get().saveSession();
    assert.equal(subject.calls.length, 1);
    assert.equal(subject.toasts.length, 1);
    subject.cleanup();
});

test('unknown main-tab envelopes block the entire load before any content or tab restoration', async () => {
    for (const metadata of [
        null,
        { version: 3 },
        { version: 1, pinned: null },
        { version: 1, hidden: true },
    ]) {
        const subject = harness({
            data: {
                version: 1,
                tabs: [{ id: 'transient', tabType: 'settings', presentation: metadata }],
                terminals: { local: [{ id: 'not-restored', title: 'Shell' }] },
                contentPresentation: {
                    local: { version: 3, items: { '["term","not-restored"]': { hidden: true } } },
                },
            },
        });
        await subject.get().loadSession();
        assert.equal(subject.get().sessionPersistenceBlocked, true);
        assert.equal(subject.get().sessionLoaded, true);
        assert.equal(subject.get().tabs.length, 0);
        assert.equal(Object.keys(subject.get().terminals).length, 0);
        assert.equal(Object.keys(subject.get().contentPresentation).length, 0);
        await subject.get().saveSession();
        assert.equal(subject.calls.length, 1);
        assert.equal(subject.toasts.length, 1);
        subject.cleanup();
    }
});

test('main-tab snapshots normalize pins/order and still exclude transient settings', async () => {
    const subject = harness();
    await subject.get().loadSession();
    subject.set({
        tabs: [
            {
                id: 'a',
                type: 'connection',
                title: 'A',
                connectionId: 'local',
                view: 'terminal',
                presentation: { version: 1, pinned: false },
            },
            {
                id: 'settings',
                type: 'settings',
                title: 'Settings',
                view: 'terminal',
                presentation: { version: 1, pinned: true },
            },
            {
                id: 'b',
                type: 'connection',
                title: 'B',
                connectionId: 'local',
                view: 'terminal',
                presentation: { version: 1, pinned: true },
            },
        ],
        activeTabId: 'a',
    });
    await subject.get().saveSession();
    const saved = subject.calls.find((call) => call.command === 'session_save').args.data;
    assert.deepEqual(
        Array.from(saved.tabs, (tab) => tab.id),
        ['b', 'a'],
    );
    assert.equal(saved.tabs[0].presentation.pinned, true);
    assert.equal(saved.tabs[1].presentation, undefined);
    assert.equal(saved.activeTabId, 'a');
    assert.equal(subject.get().tabs.length, 3, 'Serialization cannot remove the live settings tab');
    subject.cleanup();
});

test('unsupported main-tab state at save time is preserved and warns only once', async () => {
    const subject = harness();
    await subject.get().loadSession();
    const tabs = [
        {
            id: 'future',
            type: 'connection',
            title: 'Future',
            view: 'terminal',
            presentation: { version: 2, other: true },
        },
    ];
    subject.set({ tabs });
    await subject.get().saveSession();
    await subject.get().saveSession();
    assert.equal(subject.get().tabs, tabs);
    assert.equal(subject.get().sessionPersistenceBlocked, true);
    assert.equal(subject.calls.length, 1);
    assert.equal(subject.toasts.length, 1);
    subject.cleanup();
});

test('main-tab snapshots persist unpinned decoration without changing live tab resources', async () => {
    const subject = harness();
    await subject.get().loadSession();
    const presentation = {
        version: 2,
        pinned: false,
        icon: 'star',
        accent: '#ABCDEF',
        closeButton: 'hidden',
    };
    const tab = {
        id: 'decorated',
        type: 'connection',
        title: 'Resource title',
        displayAlias: 'Build',
        connectionId: 'local',
        view: 'terminal',
        presentation,
    };
    subject.set({ tabs: [tab], activeTabId: tab.id });
    await subject.get().saveSession();
    const saved = subject.calls.find((call) => call.command === 'session_save').args.data;
    assert.deepEqual(JSON.parse(JSON.stringify(saved.tabs[0].presentation)), {
        version: 2,
        icon: 'star',
        accent: '#abcdef',
        closeButton: 'hidden',
    });
    for (const key of ['id', 'title', 'displayAlias', 'connectionId', 'view']) {
        assert.equal(saved.tabs[0][key], tab[key]);
    }
    assert.equal(subject.get().tabs[0], tab);
    assert.equal(presentation.pinned, false);
    assert.equal(presentation.accent, '#ABCDEF');
    subject.cleanup();
});

test('checked saves report readiness, unsupported data, failures and acknowledged retries', async () => {
    let fail = true;
    const subject = harness({
        onSave: async () => {
            if (fail) {
                throw new Error('disk unavailable');
            }
        },
    });
    assert.equal((await subject.get().saveSessionChecked()).reason, 'not-ready');
    await subject.get().loadSession();
    assert.equal((await subject.get().saveSessionChecked()).reason, 'failed');
    fail = false;
    assert.equal((await subject.get().saveSessionChecked()).ok, true);
    assert.equal((await subject.get().saveSessionChecked()).ok, true);
    assert.equal(
        subject.calls.filter((call) => call.command === 'session_save').length,
        2,
        'Retry writes, then deduplication acknowledges the saved snapshot',
    );
    subject.set({ contentPresentation: { local: { version: 99 } } });
    assert.equal((await subject.get().saveSessionChecked()).reason, 'unsupported');
    assert.equal((await subject.get().saveSessionChecked()).reason, 'unsupported');
    subject.cleanup();
});

test('unexpected native snapshot envelopes cannot clear the persistence guard', async () => {
    for (const data of [
        false,
        [],
        'snapshot',
        {},
        { version: '1' },
        { version: NaN },
        { version: Infinity },
        { version: -1 },
        { version: 0.5 },
    ]) {
        const subject = harness({ data });
        await subject.get().loadSession();
        assert.equal(subject.get().sessionPersistenceBlocked, true);
        assert.equal((await subject.get().saveSessionChecked()).reason, 'unsupported');
        assert.equal(subject.calls.length, 1);
        assert.equal(subject.toasts.length, 1);
        subject.cleanup();
    }
});

test('returning to saved A while B is in flight queues A after B', async () => {
    const gate = deferred();
    const writes = [];
    const subject = harness({
        onSave: async (data) => {
            writes.push(data.showWelcomeScreen);
            if (writes.length === 2) {
                await gate.promise;
            }
        },
    });
    await subject.get().loadSession();
    assert.equal((await subject.get().saveSessionChecked()).ok, true);
    subject.set({ showWelcomeScreen: true });
    const b = subject.get().saveSession();
    await Promise.resolve();
    subject.set({ showWelcomeScreen: false });
    const a = subject.get().saveSessionChecked();
    gate.resolve();
    await b;
    assert.equal((await a).ok, true);
    assert.deepEqual(writes, [false, true, false]);
    subject.cleanup();
});

test('restore invalidates both dispatched and queued checked acknowledgements', async () => {
    const gate = deferred();
    const subject = harness({ onSave: () => gate.promise });
    await subject.get().loadSession();
    const first = subject.get().saveSessionChecked();
    await Promise.resolve();
    subject.set({ showWelcomeScreen: true });
    const queued = subject.get().saveSessionChecked();
    const restore = subject.get().loadSession();
    gate.resolve();
    assert.equal((await first).reason, 'superseded');
    assert.equal((await queued).reason, 'superseded');
    await restore;
    assert.equal(subject.calls.filter((call) => call.command === 'session_save').length, 1);
    assert.equal(subject.get().isRestoring, false);
    subject.cleanup();
});

test('a lost acknowledgement invalidates the old successful snapshot before an undo', async () => {
    let disk;
    let writes = 0;
    const subject = harness({
        onSave: async (data) => {
            disk = data.showWelcomeScreen;
            if (++writes === 2) {
                throw new Error('acknowledgement lost after write');
            }
        },
    });
    await subject.get().loadSession();
    await subject.get().saveSessionChecked();
    subject.set({ showWelcomeScreen: true });
    assert.equal((await subject.get().saveSessionChecked()).reason, 'failed');
    assert.equal(disk, true);
    subject.set({ showWelcomeScreen: false });
    assert.equal((await subject.get().saveSessionChecked()).ok, true);
    assert.equal(writes, 3);
    assert.equal(
        disk,
        false,
        'The last acknowledged A cannot suppress an undo after an uncertain B write',
    );
    subject.cleanup();
});
