import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import ts from 'typescript';

// Execute the production actions; isolate native I/O, persistence timers and React
// rendering, not the capacity rules or the canonical layout operations under test.
function source(path, dependencies, globals = {}) {
    const { outputText } = ts.transpileModule(
        readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8'),
        {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
                jsx: ts.JsxEmit.ReactJSX,
            },
        },
    );
    const context = {
        exports: {},
        crypto: webcrypto,
        ...globals,
        require: (name) => {
            if (typeof dependencies === 'function') {
                return dependencies(name);
            }
            assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
            return dependencies[name];
        },
    };
    runInNewContext(outputText, context);
    return context.exports;
}
const cache = new Map();
function pure(path) {
    if (cache.has(path)) {
        return cache.get(path);
    }
    const result = {};
    cache.set(path, result);
    Object.assign(
        result,
        source(path, (name) => {
            assert.ok(name.startsWith('.'), `Unexpected service import: ${name}`);
            const base = posix.normalize(posix.join(posix.dirname(path), name));
            return pure(
                existsSync(new URL(`../src/${base}.ts`, import.meta.url))
                    ? `${base}.ts`
                    : `${base}/index.ts`,
            );
        }),
    );
    return result;
}
const layout = pure('lib/paneLayout/index.ts');
const paneGroups = pure('lib/paneLayout/groups.ts');
const topology = pure('features/workspace/domain/dockingTopology.ts');
const docking = pure('features/workspace/domain/docking.ts');
const dockingView = pure('features/workspace/domain/dockingView.ts');
const dockingNavigation = pure('features/workspace/domain/dockingNavigation.ts');
const { terminalForConnectionStartup } = pure(
    'features/workspace/application/reconnectTerminal.ts',
);
const registrations = pure('features/workspace/application/viewRegistrationAdapters.ts');
const { activatePluginNavigation } = pure('features/workspace/application/pluginNavigation.ts');
const pluginViewId = pure('features/workspace/domain/registrations.ts').pluginWorkspaceViewId(
    'owner',
    'owner:panel',
);
const leaf = (id, content = { kind: 'term', termId: id }) => ({ type: 'pane', id, content });
const files = leaf('files-pane', { kind: 'feature', featureId: 'files', instanceId: 'files-one' });
const plugin = leaf('plugin-pane', {
    kind: 'plugin',
    pluginId: 'owner:panel',
    instanceId: 'plugin-one',
});
const key = (pane) => layout.paneContentKey(pane.content, pane.id);
const group = (...panes) => ({
    version: 1,
    activePaneId: panes[0].id,
    root: panes.slice(1).reduce(
        (root, pane) => ({
            type: 'split',
            id: `split-${pane.id}`,
            direction: 'horizontal',
            sizes: [0.5, 0.5],
            children: [root, pane],
        }),
        panes[0],
    ),
});
const elements = (node) =>
    node && typeof node === 'object' && node.props
        ? [node, ...[node.props.children].flat(Infinity).flatMap(elements)]
        : [];
const surfaceKeys = (surfaces) => [...surfaces].map((surface) => surface.key).sort();
const tabRelease = pure('features/workspace/domain/paneTabRelease.ts');

// Execute the actual tab-selection callbacks, not a hand-written copy of their routing.
const mainSource = ts.createSourceFile(
    'MainLayout.tsx',
    readFileSync(new URL('../src/components/layout/MainLayout.tsx', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
);
const selectionCallbacks = new Map();
function collectSelectionCallbacks(node) {
    if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        ['selectContent', 'handleTabSelect', 'handlePluginTabSelect'].includes(node.name.text)
    ) {
        selectionCallbacks.set(node.name.text, node.initializer.arguments[0].getText(mainSource));
    }
    ts.forEachChild(node, collectSelectionCallbacks);
}
collectSelectionCallbacks(mainSource);
function tabSelection(subject, view = 'terminal') {
    const calls = { views: [], instances: [] };
    const context = {
        useAppStore: { getState: subject.get },
        tab: { id: 'main', connectionId: 'local', view },
        setTabView: (...args) => calls.views.push(args),
        setActiveFeatureTabId: (id) => calls.instances.push(id),
        setActiveTerminal: subject.get().setActiveTerminal,
        featureTabs: [],
        activeFeatureTabId: null,
        workspacePluginPanels: [{ id: 'owner:panel' }],
        selectExistingWorkspaceContent: pure(
            'features/workspace/application/selectExistingContent.ts',
        ).selectExistingWorkspaceContent,
        findWorkspaceContentPane: pure('features/workspace/domain/contentInventory.ts')
            .findWorkspaceContentPane,
        isCoreTabView: (value) => value === 'terminal' || layout.isSplitFeatureId(value),
        isPluginTabView: (value) => value.startsWith('plugin:'),
        console,
        ...layout,
    };
    runInNewContext(
        ts.transpileModule(
            [...selectionCallbacks]
                .map(([name, callback]) => `const ${name} = ${callback};`)
                .join('\n') + '\nglobalThis.actions = { handleTabSelect, handlePluginTabSelect };',
            {
                compilerOptions: { target: ts.ScriptTarget.ES2022 },
            },
        ).outputText,
        context,
    );
    return { ...context.actions, calls };
}

test('production shell/plugin tab clicks focus persistent docks without replacing the center view', () => {
    const sideShell = leaf('side-shell');
    for (const pane of [sideShell, plugin]) {
        for (const view of ['terminal', 'files', 'plugin:owner:panel']) {
            const center = leaf('center');
            const subject = harness({ center: group(center), side: group(pane) }, [pane]);
            const before = subject.get();
            const actions = tabSelection(subject, view);
            if (pane === plugin) {
                actions.handlePluginTabSelect(key(pane));
            } else {
                actions.handleTabSelect('terminal', pane.content.termId);
            }
            const next = subject.get();
            assert.equal(next.workspaceDockFocus.local, key(pane));
            for (const field of [
                'activeTerminalIds',
                'activePaneGroupOwner',
                'paneLayouts',
                'terminals',
                'workspaceDocking',
            ]) {
                assert.equal(next[field], before[field], field);
            }
            assert.equal(
                dockingView.workspaceDockingView(next, 'local').projection.value.regions.workspace
                    .length,
                1,
            );
            assert.equal(
                actions.calls.views.length +
                    actions.calls.instances.length +
                    subject.calls.saves +
                    subject.calls.resources.length,
                0,
            );
            // Repeated dock selection is inert, while selecting the center restores normal input focus.
            if (pane === plugin) {
                actions.handlePluginTabSelect(key(pane));
            } else {
                actions.handleTabSelect('terminal', pane.content.termId);
            }
            assert.equal(subject.get(), next);
            actions.handleTabSelect('terminal', 'center');
            assert.equal(subject.get().workspaceDockFocus.local, null);
            assert.equal(subject.get().activeTerminalIds.local, 'center');
        }
    }
});

test('direct shell activation of a dock respects exact identity and shared focus validation', () => {
    const dock = leaf('side-shell');
    const subject = harness({ center: group(leaf('center')), side: group(dock) }, [dock]);
    const before = subject.get();
    subject.get().setActiveTerminal('local', 'side-shell');
    assert.equal(subject.get().workspaceDockFocus.local, key(dock));
    assert.equal(subject.get().activeTerminalIds, before.activeTerminalIds);
    assert.equal(subject.get().activePaneGroupOwner, before.activePaneGroupOwner);
    assert.equal(subject.calls.saves, 0);
    const focused = subject.get();
    subject.get().setActiveTerminal('local', 'missing');
    assert.equal(subject.get(), focused);
    subject.set({
        contentPresentation: { local: { version: 3, items: { [key(dock)]: { hidden: true } } } },
    });
    const hidden = subject.get();
    subject.get().setActiveTerminal('local', 'side-shell');
    assert.equal(subject.get(), hidden);
});

test('an entirely docked group tab focuses its retained member without replacing the center', () => {
    const side = group(files, plugin);
    const subject = harness({ center: group(leaf('center')), side }, [files, plugin]);
    const before = subject.get();
    subject.tabBar().onSplitSelect('side');
    const next = subject.get();
    assert.equal(next.workspaceDockFocus.local, key(files));
    assert.equal(next.activePaneGroupOwner, before.activePaneGroupOwner);
    assert.equal(next.activeTerminalIds, before.activeTerminalIds);
    assert.equal(next.paneLayouts, before.paneLayouts);
    assert.equal(
        subject.calls.views.length + subject.calls.resources.length + subject.calls.saves,
        0,
    );
    assert.equal(
        dockingView.workspaceDockingView(next, 'local').projection.value.regions.workspace.length,
        1,
    );
});

test('dock tab selection refuses stale, hidden and invalid metadata without changing the center', () => {
    for (const failure of ['hidden', 'missing', 'future']) {
        for (const pane of [leaf('side-shell'), plugin]) {
            const subject = harness({ center: group(leaf('center')), side: group(pane) }, [pane]);
            if (failure === 'hidden') {
                subject.set({
                    contentPresentation: {
                        local: { version: 3, items: { [key(pane)]: { hidden: true } } },
                    },
                });
            }
            if (failure === 'missing') {
                subject.set({
                    paneLayouts: { local: { center: subject.get().paneLayouts.local.center } },
                    terminals: {
                        local: subject
                            .get()
                            .terminals.local.filter((term) => term.id !== pane.content.termId),
                    },
                });
            }
            if (failure === 'future') {
                subject.set({
                    workspaceDocking: {
                        local: {
                            version: 99,
                            placements: subject.get().workspaceDocking.local.placements,
                        },
                    },
                });
            }
            const before = subject.get();
            const actions = tabSelection(subject, 'files');
            if (pane.content.kind === 'plugin') {
                actions.handlePluginTabSelect(key(pane));
            } else {
                actions.handleTabSelect('terminal', pane.content.termId);
            }
            assert.equal(subject.get(), before);
            assert.equal(
                actions.calls.views.length +
                    actions.calls.instances.length +
                    subject.calls.saves +
                    subject.calls.resources.length,
                0,
            );
        }
    }
});

test('drag-back release atomically inserts the exact shell, feature or plugin before/after a tab or its own group', () => {
    const shell = leaf('shell'),
        neighbor = leaf('neighbor');
    const members = [shell, files, plugin];
    for (const released of members) {
        for (const own of [false, true]) {
            for (const after of [false, true]) {
                const subject = harness(
                    { main: group(...members), neighbor: group(neighbor) },
                    [],
                    { blockClose: true },
                );
                const dormant = key(leaf('dormant'));
                const order = [dormant, ...members.map(key), key(neighbor)];
                subject.set({
                    contentPresentation: {
                        local: {
                            version: 3,
                            items: { [key(released)]: { displayAlias: 'Keep alias' } },
                            order,
                        },
                    },
                });
                const before = subject.get();
                const insertion = {
                    source: {
                        contentId: key(released),
                        memberIds: members.map(key),
                        pinned: false,
                    },
                    target: own ? members.map(key) : [key(neighbor)],
                    after,
                };
                assert.equal(
                    before.releasePaneFromSplit('local', { contentId: key(released) }, insertion),
                    true,
                );
                const next = subject.get();
                const remaining = order.filter((id) => id !== key(released));
                const anchors = insertion.target.filter((id) => id !== key(released));
                const position = after
                    ? Math.max(...anchors.map((id) => remaining.indexOf(id))) + 1
                    : Math.min(...anchors.map((id) => remaining.indexOf(id)));
                remaining.splice(position, 0, key(released));
                assert.deepEqual(Array.from(next.contentPresentation.local.order), remaining);
                assert.equal(
                    next.contentPresentation.local.items,
                    before.contentPresentation.local.items,
                );
                assert.equal(next.paneLayouts.local.neighbor, before.paneLayouts.local.neighbor);
                const canvases = pure('features/workspace/domain/canvases.ts').workspaceCanvases(
                    next.terminals.local,
                    next.paneLayouts.local,
                );
                const located = pure('features/workspace/domain/canvases.ts').findWorkspacePane(
                    canvases,
                    { contentId: key(released) },
                );
                assert.equal(layout.collectLeaves(located.layout.root).length, 1);
                if (released.content.kind !== 'term') {
                    assert.equal(located.leaf, released);
                }
                assert.equal(
                    Object.values(next.paneLayouts.local)
                        .flatMap((item) => layout.collectLeaves(item.root))
                        .filter((pane) => key(pane) === key(released)).length,
                    released.content.kind === 'term' ? 0 : 1,
                );
                assert.equal(subject.calls.saves, 1);
                assert.equal(
                    subject.calls.resources.length +
                        subject.calls.copies.length +
                        subject.calls.loads.length,
                    0,
                );
            }
        }
    }
});

test('drag-back release refuses stale membership, pins, hidden targets and write/budget failures without partial unsplitting', () => {
    const shell = leaf('shell'),
        neighbor = leaf('neighbor');
    for (const failure of [
        'source',
        'target',
        'self',
        'pin',
        'hidden',
        'restoring',
        'blocked',
        'loading',
        'future',
        'budget',
    ]) {
        const subject = harness({ main: group(shell, files), other: group(neighbor) });
        const insertion = {
            source: { contentId: key(files), memberIds: [key(shell), key(files)], pinned: false },
            target: [key(neighbor)],
            after: true,
        };
        if (failure === 'source') {
            insertion.source.memberIds = [key(files)];
        }
        if (failure === 'target') {
            insertion.target = [key(leaf('closed'))];
        }
        if (failure === 'self') {
            insertion.target = [key(files)];
        }
        if (failure === 'pin' || failure === 'hidden') {
            subject.set({
                contentPresentation: {
                    local: {
                        version: 3,
                        items: {
                            [key(neighbor)]:
                                failure === 'pin' ? { pinned: true } : { hidden: true },
                        },
                    },
                },
            });
        }
        if (failure === 'restoring') {
            subject.set({ isRestoring: true });
        }
        if (failure === 'blocked') {
            subject.set({ sessionPersistenceBlocked: true });
        }
        if (failure === 'loading') {
            subject.set({ sessionLoaded: false });
        }
        if (failure === 'future') {
            subject.set({ contentPresentation: { local: { version: 99, items: {} } } });
        }
        if (failure === 'budget') {
            subject.set({
                contentPresentation: {
                    local: {
                        version: 3,
                        items: {},
                        order: Array.from({ length: 256 }, (_, i) => key(leaf(`absent-${i}`))),
                    },
                },
            });
        }
        const before = subject.get();
        assert.equal(
            before.releasePaneFromSplit('local', { contentId: key(files) }, insertion),
            false,
            failure,
        );
        noWork(subject, before);
    }
});

test('drag source resolution matches exact legacy/plugin identity without creating missing instances', () => {
    const canvases = [{ owner: 'main', layout: group(files, plugin) }];
    assert.equal(
        tabRelease.paneTabReleaseSource(canvases, {
            kind: 'plugin',
            pluginId: plugin.content.pluginId,
            instanceId: 'closed',
            sourcePaneId: plugin.id,
        }),
        null,
    );
    const source = tabRelease.paneTabReleaseSource(canvases, layout.paneDockPayload(plugin));
    assert.equal(source.contentId, key(plugin));
    assert.deepEqual(Array.from(source.memberIds), [key(files), key(plugin)]);
    assert.equal(
        tabRelease.paneTabReleaseSource(canvases, layout.paneDockPayload(plugin), {
            version: 3,
            items: { [key(plugin)]: { hidden: true } },
        }),
        null,
    );
});

test('drag-back without saved ranks uses the same canonical inventory order as strip reordering', () => {
    const neighbor = leaf('neighbor');
    const subject = harness({ main: group(files, plugin), neighbor: group(neighbor) });
    const insertion = {
        source: { contentId: key(plugin), memberIds: [key(files), key(plugin)], pinned: false },
        target: [key(files), key(plugin)],
        after: true,
    };
    assert.equal(
        subject.get().releasePaneFromSplit('local', { contentId: key(plugin) }, insertion),
        true,
    );
    assert.deepEqual(Array.from(subject.get().contentPresentation.local.order), [
        key(neighbor),
        key(files),
        key(plugin),
    ]);
});

test('drag-back follows grouped-tab pin priority without rewriting individual pin flags', () => {
    const shell = leaf('shell'),
        neighbor = leaf('neighbor');
    const subject = harness({ main: group(files, plugin), other: group(shell, neighbor) });
    subject.set({
        contentPresentation: {
            local: {
                version: 3,
                items: { [key(plugin)]: { pinned: true }, [key(shell)]: { pinned: true } },
            },
        },
    });
    const items = subject.get().contentPresentation.local.items;
    assert.equal(
        subject.get().releasePaneFromSplit(
            'local',
            { contentId: key(plugin) },
            {
                source: {
                    contentId: key(plugin),
                    memberIds: [key(files), key(plugin)],
                    pinned: true,
                },
                target: [key(shell), key(neighbor)],
                after: true,
            },
        ),
        true,
    );
    assert.equal(subject.get().contentPresentation.local.items, items);
    assert.deepEqual(Array.from(subject.get().contentPresentation.local.order).slice(0, 2), [
        key(shell),
        key(plugin),
    ]);
});

test('plugin navigation opens once and repeated activation focuses the same canonical instance', () => {
    const subject = harness({ main: group(leaf('shell')) });
    const before = subject.get();
    assert.equal(activatePluginNavigation(subject.get, pluginViewId), true);
    const opened = subject.get();
    const panes = Object.values(opened.paneLayouts.local).flatMap((item) =>
        layout.collectLeaves(item.root),
    );
    assert.equal(panes.filter((pane) => pane.content.kind === 'plugin').length, 1);
    assert.equal(activatePluginNavigation(subject.get, pluginViewId), true);
    assert.equal(subject.get().paneLayouts, opened.paneLayouts);
    assert.equal(subject.get().terminals, before.terminals);
    assert.deepEqual(subject.calls.resources, []);
    assert.deepEqual(subject.calls.views, [
        ['main', 'plugin:owner:panel'],
        ['main', 'plugin:owner:panel'],
    ]);
});

test('plugin navigation prefers current instance and keeps center selection when focusing a dock', () => {
    const second = leaf('plugin-two', { ...plugin.content, instanceId: 'plugin-two' });
    const subject = harness(
        { main: group(leaf('shell')), one: group(plugin), two: group(second) },
        [plugin, second],
    );
    subject.set({ workspaceDockFocus: { local: key(second) } });
    const before = subject.get();
    assert.equal(activatePluginNavigation(subject.get, pluginViewId), true);
    assert.equal(subject.get(), before);
    assert.deepEqual(subject.calls.views, []);
    assert.deepEqual(subject.calls.resources, []);
});

test('plugin navigation reveals only an existing hidden instance and retains its alias and pin', () => {
    const subject = harness({ main: group(plugin) }, [plugin]);
    const presentation = pure(
        'store/workspacePresentationSlice.ts',
    ).createWorkspacePresentationSlice(subject.set, subject.get);
    subject.set({
        setContentHidden: presentation.setContentHidden,
        contentPresentation: {
            local: {
                version: 3,
                items: { [key(plugin)]: { hidden: true, pinned: true, displayAlias: 'Kept' } },
            },
        },
    });
    const before = subject.get();
    assert.equal(activatePluginNavigation(subject.get, pluginViewId), true);
    assert.equal(subject.get().paneLayouts, before.paneLayouts);
    assert.deepEqual(
        JSON.parse(JSON.stringify(subject.get().contentPresentation.local.items[key(plugin)])),
        { pinned: true, displayAlias: 'Kept' },
    );
    assert.equal(subject.get().workspaceDockFocus.local, key(plugin));
    assert.deepEqual(subject.calls.resources, []);
    assert.deepEqual(subject.calls.views, []);
});

test('plugin navigation refuses absent, ambiguous, restoring, protected and foreign active contexts', () => {
    const originalRegistry = registrations.buildWorkspaceViewRegistrations([
        { id: 'owner:panel', pluginId: 'owner', title: 'One' },
    ]);
    const originalPlugin = originalRegistry.registrations.find(
        (view) => view.source.kind === 'plugin',
    );
    const ambiguous = {
        ...originalRegistry,
        registrations: [
            ...originalRegistry.registrations,
            {
                ...originalPlugin,
                id: 'plugin:other:owner%3Apanel',
                source: { kind: 'plugin', pluginId: 'other', panelId: 'owner:panel' },
            },
        ],
    };
    for (const patch of [
        { sessionLoaded: false },
        { isRestoring: true },
        { sessionPersistenceBlocked: true },
        { activeConnectionId: 'other' },
        { activeTabId: 'missing' },
        { showWelcomeScreen: true },
        { workspaceViewRegistry: registrations.buildWorkspaceViewRegistrations() },
        { workspaceDocking: { local: { version: 99 } } },
        { workspaceViewRegistry: ambiguous },
    ]) {
        const subject = harness({ main: group(plugin) });
        subject.set(patch);
        const before = subject.get();
        assert.equal(activatePluginNavigation(subject.get, pluginViewId), false);
        noWork(subject, before);
    }
    const subject = harness({ main: group(plugin), duplicate: group(plugin) });
    const before = subject.get();
    assert.equal(activatePluginNavigation(subject.get, pluginViewId), false);
    noWork(subject, before);
});

test('plugin navigation fails safely on capacity, refused reveal and context changes during publication', () => {
    const subject = harness({ full: group(leaf('a'), leaf('b'), leaf('c'), files) }, [
        leaf('a'),
        leaf('b'),
        leaf('c'),
        files,
    ]);
    const before = subject.get();
    assert.equal(activatePluginNavigation(subject.get, pluginViewId), false);
    noWork(subject, before);
    const hidden = harness({ main: group(plugin) });
    hidden.set({
        contentPresentation: { local: { version: 3, items: { [key(plugin)]: { hidden: true } } } },
        setContentHidden: () => false,
    });
    const original = hidden.get();
    assert.equal(activatePluginNavigation(hidden.get, pluginViewId), false);
    noWork(hidden, original);
    const switched = harness({ main: group(leaf('shell')) });
    const ensure = switched.get().ensurePluginPane;
    switched.set({
        ensurePluginPane: (...args) => {
            const created = ensure(...args);
            switched.set({ activeTabId: 'other' });
            return created;
        },
    });
    assert.equal(activatePluginNavigation(switched.get, pluginViewId), false);
    assert.deepEqual(switched.calls.views, []);
    assert.deepEqual(switched.calls.resources, []);
});

test('plugin navigation rejects same-tab scope rebinding and a focus publication superseded by tab selection', () => {
    const rebound = harness({ main: group(leaf('shell')) });
    const ensure = rebound.get().ensurePluginPane;
    rebound.set({
        ensurePluginPane: (...args) => {
            const created = ensure(...args);
            rebound.set({
                activeConnectionId: 'other',
                tabs: [{ ...rebound.get().tabs[0], connectionId: 'other' }],
            });
            return created;
        },
    });
    assert.equal(activatePluginNavigation(rebound.get, pluginViewId), false);
    assert.equal(rebound.get().activePaneGroupOwner.local, 'main');
    assert.deepEqual(rebound.calls.views, []);
    const switched = harness({ main: group(plugin) });
    const focus = switched.get().focusWorkspaceContent;
    switched.set({
        focusWorkspaceContent: (...args) => {
            const accepted = focus(...args);
            switched.set({ activeTabId: 'other' });
            return accepted;
        },
    });
    assert.equal(activatePluginNavigation(switched.get, pluginViewId), false);
    assert.deepEqual(switched.calls.views, []);
});

test('reconnect uses visible center shells, standalone fallback and live ownership', () => {
    const shell = leaf('shell');
    const subject = harness({ mixed: group(shell, files), plugin: group(plugin) });
    assert.equal(terminalForConnectionStartup(subject.get(), 'local', 'shell'), 'shell');
    subject.set({
        contentPresentation: { local: { version: 3, items: { [key(shell)]: { hidden: true } } } },
    });
    assert.equal(terminalForConnectionStartup(subject.get(), 'local', 'shell'), null);
    subject.set({ contentPresentation: {}, activePaneGroupOwner: { local: 'plugin' } });
    assert.equal(terminalForConnectionStartup(subject.get(), 'local', 'shell'), null);
    subject.set({ paneLayouts: {}, activePaneGroupOwner: { local: null } });
    assert.equal(terminalForConnectionStartup(subject.get(), 'local', 'shell'), 'shell');
    subject.set({ terminals: {} });
    assert.equal(terminalForConnectionStartup(subject.get(), 'local', 'shell'), null);
    subject.set({
        paneLayouts: { local: { mixed: group(shell, files) } },
        activePaneGroupOwner: { local: 'mixed' },
    });
    assert.equal(
        terminalForConnectionStartup(subject.get(), 'local', 'shell'),
        null,
        'orphan shell cannot spawn',
    );
});

test('reconnect sees persistent docks beside terminal, feature and plugin center views', () => {
    const dock = leaf('docked-shell');
    const subject = harness({ mixed: group(files, plugin), other: group(dock) }, [dock]);
    for (const view of ['terminal', 'files', 'plugin:owner:panel']) {
        subject.set({ tabs: [{ ...subject.get().tabs[0], view }] });
        const before = subject.get();
        assert.equal(
            terminalForConnectionStartup(before, 'local', 'docked-shell'),
            'docked-shell',
            view,
        );
        noWork(subject, before);
    }
    subject.set({
        contentPresentation: { local: { version: 3, items: { [key(dock)]: { hidden: true } } } },
    });
    assert.equal(terminalForConnectionStartup(subject.get(), 'local', 'docked-shell'), null);
});

test('reconnect prefers the primary visible shell but can wait for another visible shell', () => {
    const primary = leaf('primary');
    const second = leaf('second');
    const subject = harness({ main: group(primary), other: group(second) }, [second]);
    assert.equal(terminalForConnectionStartup(subject.get(), 'local', 'primary'), 'primary');
    subject.set({
        contentPresentation: { local: { version: 3, items: { [key(primary)]: { hidden: true } } } },
    });
    assert.equal(terminalForConnectionStartup(subject.get(), 'local', 'primary'), 'second');
    assert.equal(terminalForConnectionStartup(subject.get(), 'local', null), 'second');
});

test('reconnect never waits for background, invalid or unsupported allocations', () => {
    const shell = leaf('shell');
    const subject = harness({ main: group(shell) }, [shell]);
    const original = subject.get();
    const cases = [
        { activeTabId: 'missing' },
        { tabs: [{ ...original.tabs[0], type: 'settings' }] },
        { tabs: [{ ...original.tabs[0], connectionId: 'other' }] },
        { workspaceDocking: { local: { version: 99, placements: {} } } },
        { paneLayouts: { local: { one: group(shell), two: group(shell) } } },
    ];
    for (const patch of cases) {
        subject.set({ ...original, ...patch });
        const before = subject.get();
        assert.equal(terminalForConnectionStartup(before, 'local', 'shell'), null);
        noWork(subject, before);
    }
});

test('ungroup releases the exact docked resource to its tab without recreating content or touching other metadata', () => {
    const shell = leaf('shell');
    const dormant = key(leaf('dormant'));
    for (const released of [shell, files, plugin]) {
        const subject = harness({ main: group(shell, files, plugin) }, [released], {
            blockClose: true,
        });
        const original = subject.get();
        subject.set({
            workspaceDockFocus: { local: key(released) },
            contentPresentation: {
                local: {
                    version: 3,
                    items: { [key(released)]: { displayAlias: 'Retain me', pinned: true } },
                },
            },
            workspaceDocking: {
                local: {
                    ...original.workspaceDocking.local,
                    placements: {
                        ...original.workspaceDocking.local.placements,
                        [dormant]: 'primary-sidebar',
                    },
                    sizes: { primary: 0.2, secondary: 0.2, bottom: 0.3 },
                },
            },
        });
        const metadata = subject.get().contentPresentation;
        assert.equal(
            subject.get().releasePaneFromSplit('local', { contentId: key(released) }),
            true,
        );
        const next = subject.get();
        assert.equal(next.workspaceDocking.local.placements[key(released)], undefined);
        assert.equal(next.workspaceDocking.local.placements[dormant], 'primary-sidebar');
        assert.equal(next.workspaceDocking.local.sizes.bottom, 0.3);
        assert.equal(next.workspaceDockFocus.local, null);
        assert.equal(next.contentPresentation, metadata);
        if (released === shell) {
            assert.equal(next.activeTerminalIds.local, 'shell');
            assert.equal(next.activePaneGroupOwner.local, null);
            assert.equal(next.terminals.local.find((item) => item.id === 'shell').tabVisible, true);
        } else {
            assert.equal(next.paneLayouts.local[released.content.instanceId].root, released);
            assert.equal(next.activePaneGroupOwner.local, released.content.instanceId);
        }
        assert.equal(subject.calls.saves, 1);
        assert.equal(
            subject.calls.resources.length +
                subject.calls.copies.length +
                subject.calls.loads.length,
            0,
        );
    }
});

test('ungrouping a single docked canvas releases its allocation and selects the same content without rebuilding its tree', () => {
    for (const released of [leaf('docked-shell'), files, plugin]) {
        const subject = harness({ main: group(leaf('center')), dock: group(released) }, [released]);
        subject.set({ workspaceDockFocus: { local: key(released) } });
        const before = subject.get();
        assert.equal(
            paneGroups.releasePaneFromGroups(before.paneLayouts.local, released.id, 'dock'),
            undefined,
            'tree-level release remains split-only',
        );
        assert.equal(before.releasePaneFromSplit('local', { contentId: key(released) }), true);
        const after = subject.get();
        assert.equal(after.workspaceDocking.local?.placements[key(released)], undefined);
        assert.equal(after.workspaceDockFocus.local, null);
        assert.equal(after.activePaneGroupOwner.local, 'dock');
        assert.equal(after.paneLayouts, before.paneLayouts);
        assert.equal(after.terminals, before.terminals);
        assert.equal(after.contentPresentation, before.contentPresentation);
        if (released.content.kind === 'term') {
            assert.equal(after.activeTerminalIds.local, released.content.termId);
        }
        assert.deepEqual(subject.calls.resources, []);
        assert.equal(subject.calls.saves, 1);
    }
    const standalone = harness({ main: group(leaf('center')) }, [leaf('standalone')], {
        extraTerms: ['standalone'],
    });
    assert.equal(
        standalone.get().releasePaneFromSplit('local', { contentId: key(leaf('standalone')) }),
        true,
    );
    assert.equal(standalone.get().activePaneGroupOwner.local, null);
    assert.equal(standalone.get().activeTerminalIds.local, 'standalone');
    const hiddenTab = harness({ main: group(leaf('center')) }, [leaf('standalone')], {
        extraTerms: ['standalone'],
    });
    hiddenTab.set({
        terminals: {
            local: hiddenTab
                .get()
                .terminals.local.map((tab) =>
                    tab.id === 'standalone' ? { ...tab, tabVisible: false } : tab,
                ),
        },
    });
    const prior = hiddenTab.get();
    assert.equal(prior.releasePaneFromSplit('local', { contentId: key(leaf('standalone')) }), true);
    assert.equal(
        hiddenTab.get().terminals.local.find((tab) => tab.id === 'standalone').tabVisible,
        true,
    );
    assert.equal(
        hiddenTab.get().terminals.local.find((tab) => tab.id === 'center'),
        prior.terminals.local.find((tab) => tab.id === 'center'),
    );
    assert.equal(hiddenTab.get().paneLayouts, prior.paneLayouts);
    assert.equal(hiddenTab.calls.saves, 1);
    assert.deepEqual(hiddenTab.calls.resources, []);
});

test('validated projection snapshots match action reads and do not bypass unrelated future metadata', () => {
    const subject = harness({ main: group(leaf('center'), files), dock: group(plugin) }, [plugin]);
    const state = subject.get();
    const parsed = docking.parseWorkspaceDocking(state.workspaceDocking);
    assert.equal(parsed.ok, true);
    assert.deepEqual(
        dockingView.projectWorkspaceDockingView(state, 'local', parsed),
        dockingView.workspaceDockingView(state, 'local'),
    );
    for (const patch of [
        { activePaneGroupOwner: { local: 'dock' } },
        { workspaceDockFocus: { local: key(plugin) } },
        {
            contentPresentation: {
                local: { version: 3, items: { [key(files)]: { hidden: true } } },
            },
        },
    ]) {
        const next = { ...state, ...patch };
        assert.deepEqual(
            dockingView.projectWorkspaceDockingView(next, 'local', parsed),
            dockingView.workspaceDockingView(next, 'local'),
        );
    }
    const invalid = {
        ...state,
        workspaceDocking: { ...state.workspaceDocking, foreign: { version: 99 } },
    };
    const failed = docking.parseWorkspaceDocking(invalid.workspaceDocking);
    assert.equal(failed.ok, false);
    const view = dockingView.projectWorkspaceDockingView(invalid, 'local', failed);
    assert.equal(view.projection.reason, 'unsupported-docking');
    assert.equal(view.canvases.length, 2, 'invalid metadata still retains canonical resources');
    assert.equal(
        dockingView.workspaceDockingView(invalid, 'local').projection.reason,
        'unsupported-docking',
        'actions revalidate fresh state',
    );
});

test('ungroup rejects ambiguous legacy IDs and addresses an exact resource despite colliding local IDs', () => {
    const other = { ...plugin, id: files.id };
    const subject = harness(
        { main: group(files, leaf('first')), other: group(other, leaf('second')) },
        [other],
    );
    let before = subject.get();
    assert.equal(subject.get().releasePaneFromSplit('local', files.id), false);
    noWork(subject, before);
    assert.equal(paneGroups.releasePaneFromGroups(before.paneLayouts.local, files.id), undefined);
    assert.equal(subject.get().releasePaneFromSplit('local', { contentId: key(other) }), true);
    assert.equal(subject.get().paneLayouts.local.main, before.paneLayouts.local.main);
    assert.equal(subject.get().paneLayouts.local[other.content.instanceId].root, other);
});

test('ungroup refuses stale, hidden, future-format and unwritable dock requests without partial release', () => {
    for (const patch of [
        { sessionLoaded: false },
        { isRestoring: true },
        { sessionPersistenceBlocked: true },
        { workspaceDocking: { local: { version: 99, placements: {} } } },
        {
            contentPresentation: {
                local: { version: 3, items: { [key(plugin)]: { hidden: true } } },
            },
        },
    ]) {
        for (const groups of [
            { main: group(files, plugin) },
            { main: group(files), dock: group(plugin) },
        ]) {
            const subject = harness(groups, [plugin]);
            subject.set(patch);
            const before = subject.get();
            assert.equal(
                subject.get().releasePaneFromSplit('local', { contentId: key(plugin) }),
                false,
            );
            noWork(subject, before);
        }
    }
    const subject = harness({ main: group(files, plugin) }, [plugin]);
    const before = subject.get();
    assert.equal(subject.get().releasePaneFromSplit('local', { contentId: 'closed' }), false);
    noWork(subject, before);
});

test('ungroup preserves every canvas when promotion would collide with an existing owner', () => {
    const collision = group(leaf('unrelated'));
    const subject = harness(
        { main: group(files, plugin), [plugin.content.instanceId]: collision },
        [files],
    );
    const before = subject.get();
    assert.equal(subject.get().releasePaneFromSplit('local', { contentId: key(files) }), false);
    noWork(subject, before);
});

test('legacy unsplit action delegates to exact dock focus, including shells, instead of the remembered center', () => {
    const shell = leaf('shell');
    for (const released of [shell, files, plugin]) {
        const subject = harness({ main: group(shell, files, plugin) }, [released]);
        subject.set({ workspaceDockFocus: { local: key(released) } });
        subject.get().unsplitPanes('local');
        assert.equal(subject.calls.saves, 1);
        assert.equal(subject.get().workspaceDocking.local?.placements[key(released)], undefined);
        assert.equal(subject.get().workspaceDockFocus.local, null);
    }
});

test('real ungroup menu uses its exact canvas or dock focus and does not switch views after refusal', () => {
    const other = { ...plugin, id: files.id };
    const subject = harness(
        { main: group(files, leaf('first')), other: group(other, leaf('second')) },
        [other],
    );
    const selected = [];
    const props = {
        onPluginTabSelect: (id) => selected.push(id),
        onTabSelect: () => assert.fail('wrong kind'),
    };
    subject.tabBar(props).onSplitUnsplit('missing', files.id);
    assert.equal(subject.calls.saves, 0);
    subject.tabBar(props).onSplitUnsplit('other', other.id);
    assert.deepEqual(selected, [key(other)]);
    assert.equal(subject.get().paneLayouts.local[other.content.instanceId].root, other);

    const docked = harness({ main: group(files, plugin) }, [plugin]);
    docked.set({ workspaceDockFocus: { local: key(plugin) }, sessionPersistenceBlocked: true });
    docked.tabBar(props).onUnsplit();
    assert.equal(selected.length, 1);
    docked.set({ sessionPersistenceBlocked: false });
    docked.tabBar(props).onUnsplit();
    assert.deepEqual(selected, [key(other), key(plugin)]);
});

function harness(
    groups,
    docked = [],
    { activeOwner = Object.keys(groups)[0], extraTerms = [], onInvoke, blockClose = false } = {},
) {
    let state;
    const calls = {
        saves: 0,
        copies: [],
        resources: [],
        loads: [],
        views: [],
        warnings: [],
        tracks: [],
    };
    const window = {
        ipcRenderer: {
            send: (...args) => calls.resources.push(args),
            invoke: async (...args) => {
                calls.resources.push(args);
                return onInvoke ? onInvoke(...args) : '/home/user';
            },
        },
    };
    const storeModule = source(
        'store/terminalSlice.ts',
        {
            '../features/usage': { track: (...args) => calls.tracks.push(args) },
            '../lib/terminal': {
                terminalService: { destroy: (...args) => calls.resources.push(args) },
            },
            './sessionSlice': {
                scheduleSaveSession: () => {
                    calls.saves++;
                },
            },
            '../lib/paneCloseBlockers': {
                isPaneCloseBlocked: () => blockClose,
                isPaneLayoutCloseBlocked: () => blockClose,
                paneCloseScope: () => ({}),
            },
            '../lib/paneLayout': layout,
            '../lib/paneLayout/groups': paneGroups,
            '../features/workspace/application/viewRegistrationAdapters': registrations,
            '../features/workspace/application/contentLifecycle': {
                disposeWorkspaceContent: () => {},
            },
            '../features/workspace/domain/dockingTopology': topology,
            '../features/workspace/domain/canvases': pure('features/workspace/domain/canvases.ts'),
            '../features/workspace/domain/docking': docking,
            '../features/workspace/domain/paneTabRelease': pure(
                'features/workspace/domain/paneTabRelease.ts',
            ),
            '../features/workspace/domain/contentPresentation': pure(
                'features/workspace/domain/contentPresentation.ts',
            ),
        },
        { window },
    );
    const set = (patch) => {
        state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
    };
    const dockingModule = source('store/workspaceDockingSlice.ts', {
        '../features/workspace/domain/dockingView': dockingView,
        '../features/workspace/application/regionDrop': pure(
            'features/workspace/application/regionDrop.ts',
        ),
        '../lib/paneLayout': layout,
        '../lib/paneLayout/regions': pure('lib/paneLayout/regions.ts'),
        '../features/workspace/domain/canvases': pure('features/workspace/domain/canvases.ts'),
        '../features/workspace/domain/docking': docking,
        '../features/workspace/domain/contentPresentation': pure(
            'features/workspace/domain/contentPresentation.ts',
        ),
        '../features/workspace/domain/visibleContent': pure(
            'features/workspace/domain/visibleContent.ts',
        ),
        '../features/workspace/application/viewRegistrationAdapters': registrations,
        './sessionSlice': {
            scheduleSaveSession: () => {
                calls.saves++;
            },
        },
    });
    const terminals = [
        ...new Set(
            Object.values(groups)
                .flatMap((item) => layout.visibleTermIds(item))
                .concat(extraTerms),
        ),
    ].map((id) => ({ id, title: id, tabVisible: true }));
    state = {
        ...storeModule.createTerminalSlice(set, () => state),
        ...dockingModule.createWorkspaceDockingSlice(set, () => state),
        tabs: [
            {
                id: 'main',
                type: 'connection',
                connectionId: 'local',
                title: 'Local',
                view: 'terminal',
            },
        ],
        activeTabId: 'main',
        activeConnectionId: 'local',
        showWelcomeScreen: false,
        terminals: { local: terminals },
        paneLayouts: { local: groups },
        activeTerminalIds: { local: terminals[0]?.id ?? null },
        activePaneGroupOwner: { local: activeOwner },
        contentPresentation: {},
        workspaceDocking: {
            local: {
                version: 1,
                placements: Object.fromEntries(docked.map((pane) => [key(pane), 'bottom-panel'])),
            },
        },
        workspaceViewRegistry: registrations.buildWorkspaceViewRegistrations([
            { id: 'owner:panel', pluginId: 'owner', title: 'Plugin', allowMultiple: true },
        ]),
        connections: [{ id: 'local', status: 'connected' }],
        currentPath: {},
        settings: { enableVibrancy: false, windowOpacity: 1 },
        sessionLoaded: true,
        isRestoring: false,
        sessionPersistenceBlocked: false,
        saveSession: async () => {
            calls.saves++;
        },
        forgetContentPresentation: () => {},
        showToast: (...args) => calls.warnings.push(args),
        copyFilesListing: (...args) => calls.copies.push(args),
        loadFiles: async (...args) => calls.loads.push(args),
        setTabView: (...args) => calls.views.push(args),
    };
    const useAppStore = Object.assign((selector) => selector(state), { getState: () => state });
    const openHere = source(
        'components/layout/tabDock/openHere.ts',
        {
            '../../../lib/paneLayout': layout,
            '../../../store/useAppStore': { useAppStore },
            '../../../features/workspace/domain/dockingTopology': topology,
            '../../../features/workspace/domain/canvases': pure(
                'features/workspace/domain/canvases.ts',
            ),
            '../../../features/workspace/domain/visibleContent': pure(
                'features/workspace/domain/visibleContent.ts',
            ),
            './openHerePaths': pure('components/layout/tabDock/openHerePaths.ts'),
        },
        { window },
    );
    function tabBar(props = {}) {
        const { WorkspaceTabBar } = source(
            'components/layout/WorkspaceTabBar.tsx',
            {
                react: { memo: (component) => component, useMemo: (fn) => fn() },
                'react/jsx-runtime': { jsx: (type, props) => ({ type, props }) },
                '../../store/useAppStore': { useAppStore },
                '../../hooks/useAvailableShells': { useAvailableShells: () => ({ shells: [] }) },
                '../../features/connections/application/tabService': {
                    LOCAL_TERMINAL_CONNECTION_ID: 'local',
                },
                './CombinedTabBar': { CombinedTabBar: () => {} },
                './tabDock': {},
                '../../features/workspace/domain/contentInventory': pure(
                    'features/workspace/domain/contentInventory.ts',
                ),
                '../../features/workspace/domain/visibleContent': pure(
                    'features/workspace/domain/visibleContent.ts',
                ),
                '../../features/workspace/domain/dockingView': dockingView,
                '../../features/workspace/domain/dockingTopology': topology,
                '../../lib/paneLayout': layout,
            },
            { window },
        );
        return WorkspaceTabBar({
            connectionId: 'local',
            tabId: 'main',
            activeView: 'terminal',
            featureTabs: [],
            activeFeatureTabId: null,
            pinnedFeatures: [],
            pluginPanels: [],
            ...props,
        }).props;
    }
    function manager(props = {}) {
        const HostLayer = () => null;
        const DockingFrame = () => null;
        const Button = () => null;
        const jsx = (type, props) => ({ type, props });
        const { TerminalManager } = source(
            'components/terminal/TerminalManager.tsx',
            {
                react: {
                    useMemo: (fn) => fn(),
                    useEffect: () => {},
                    useRef: (value) => ({ current: value }),
                },
                'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
                'zustand/react/shallow': { useShallow: (fn) => fn },
                'lucide-react': {
                    Terminal: () => null,
                    Plus: () => null,
                    X: () => null,
                    Zap: () => null,
                },
                '@tauri-apps/api/event': {
                    once: () => {
                        throw new Error(
                            'Renderer must not subscribe to native events during render',
                        );
                    },
                },
                '../../lib/utils': { cn: (...parts) => parts.filter(Boolean).join(' ') },
                '../../store/useAppStore': { useAppStore },
                '../../lib/paneLayout': layout,
                '../../lib/terminal/inputPipeline': {
                    queueTerminalInput: () => {
                        throw new Error('Renderer must not write terminal input during render');
                    },
                },
                '../../features/shortcuts/workspacePresentation': {},
                '../../features/workspace/domain/docking': docking,
                '../../features/workspace/domain/visibleContent': pure(
                    'features/workspace/domain/visibleContent.ts',
                ),
                '../../features/workspace/domain/dockingView': dockingView,
                '../workspace/PaneSurfaceLayer': { PaneSurfaceLayer: HostLayer },
                '../workspace/WorkspaceDockingFrame': { WorkspaceDockingFrame: DockingFrame },
                '../workspace/WorkspaceRegionDropTargets': {
                    WorkspaceRegionDropTargets: () => null,
                },
                '../workspace/workspaceDockingSurfaces': pure(
                    'components/workspace/workspaceDockingSurfaces.ts',
                ),
                '../workspace/usePaneSurfaceGeometry': {
                    usePaneSurfaceGeometry: () => ({
                        registerSlot: () => {},
                        registerHost: () => {},
                    }),
                },
                './PaneLayoutView': { PaneLayoutView: () => null },
                './PaneLeafView': { PaneLeafView: () => null },
                '../ui/Button': { Button },
            },
            { window },
        );
        const tree = TerminalManager({
            connectionId: 'local',
            isWorkspaceActive: true,
            isTerminalView: true,
            hideTabs: true,
            ...props,
        });
        const nodes = elements(tree);
        const layers = nodes.filter((node) => node.type === HostLayer);
        assert.equal(layers.length, 1, 'The real renderer owns exactly one retained host layer');
        return {
            tree,
            nodes,
            layer: layers[0].props,
            frame: nodes.find((node) => node.type === DockingFrame)?.props,
            reset: nodes.find(
                (node) => node.type === Button && node.props.children === 'Reset docking locations',
            )?.props,
        };
    }
    return { get: () => state, set, calls, openHere, tabBar, manager };
}
function noWork(subject, before) {
    assert.equal(subject.get(), before, 'Refusal must preserve the complete store and selection');
    assert.equal(subject.calls.saves, 0);
    for (const name of ['copies', 'resources', 'loads', 'views', 'tracks']) {
        assert.deepEqual(subject.calls[name], [], name);
    }
}

test('maximize and restore are transient, exact-identity operations across all pane kinds', () => {
    for (const pane of [leaf('shell'), files, plugin]) {
        const other = leaf('other');
        const subject = harness({ main: group(pane, other) });
        const before = subject.get();
        assert.equal(before.maximizeWorkspacePane('local', key(pane)), true);
        const next = subject.get();
        assert.equal(next.maximizedWorkspacePanes.local.contentId, key(pane));
        for (const field of [
            'terminals',
            'paneLayouts',
            'workspaceDocking',
            'contentPresentation',
        ]) {
            assert.equal(next[field], before[field]);
        }
        const rendered = subject.manager();
        assert.deepEqual(
            surfaceKeys(rendered.layer.surfaces.filter((surface) => surface.visible)),
            [key(pane)],
        );
        const surface = rendered.layer.surfaces.find((surface) => surface.visible);
        assert.equal(surface.split, true);
        const props = rendered.layer.renderSurface(surface).props;
        assert.equal(props.maximized, true);
        props.onToggleMaximize();
        assert.equal(subject.get().maximizedWorkspacePanes.local, undefined);
        assert.equal(
            subject.manager().layer.surfaces.filter((surface) => surface.visible).length,
            2,
        );
        assert.deepEqual(subject.calls.resources, []);
        assert.equal(subject.calls.saves, 0, 'already-focused geometry toggles never persist');
    }
});

test('docked maximize keeps placement, input ownership and retained siblings; stale cleanup cannot clear its replacement', () => {
    const subject = harness({ main: group(leaf('shell'), files), dock: group(plugin) }, [plugin]);
    const placements = subject.get().workspaceDocking;
    assert.equal(subject.get().maximizeWorkspacePane('local', key(plugin)), true);
    const request = subject.get().maximizedWorkspacePanes.local;
    assert.equal(subject.get().workspaceDockFocus.local, key(plugin));
    assert.equal(subject.get().workspaceDocking, placements);
    assert.equal(subject.manager().layer.surfaces.length, 3);
    subject.get().restoreWorkspacePane('local');
    assert.equal(subject.get().maximizeWorkspacePane('local', key(plugin)), true);
    subject.get().restoreWorkspacePane('local', request);
    assert.ok(subject.get().maximizedWorkspacePanes.local);
    subject.get().closePaneInSplit('local', { contentId: key(plugin) });
    assert.equal(subject.get().maximizedWorkspacePanes.local, undefined);
});

test('maximize refuses unavailable, hidden, inactive, solitary and invalid-capacity targets without side effects', () => {
    for (const patch of [
        { sessionLoaded: false },
        { isRestoring: true },
        { showWelcomeScreen: true },
        { activeConnectionId: 'other' },
        { activeTabId: 'absent' },
        { workspaceDocking: { local: { version: 99 } } },
        {
            contentPresentation: {
                local: { version: 3, items: { [key(files)]: { hidden: true } } },
            },
        },
    ]) {
        const subject = harness({ main: group(leaf('shell'), files) });
        subject.set(patch);
        const before = subject.get();
        assert.equal(before.maximizeWorkspacePane('local', key(files)), false);
        noWork(subject, before);
    }
    for (const groups of [
        { main: group(files) },
        { main: group(leaf('shell'), files), duplicate: group(files) },
    ]) {
        const subject = harness(groups);
        const before = subject.get();
        assert.equal(before.maximizeWorkspacePane('local', key(files)), false);
        noWork(subject, before);
    }
});

test('selection, focus and hiding restore geometry immediately without revealing or closing resources', () => {
    for (const change of [
        (subject) => subject.get().focusWorkspaceContent('local', key(leaf('shell'))),
        (subject) =>
            subject.set({
                contentPresentation: {
                    local: { version: 3, items: { [key(files)]: { hidden: true } } },
                },
            }),
        (subject) =>
            subject.set({
                activePaneGroupOwner: { local: 'other' },
                activeTerminalIds: { local: 'other' },
            }),
    ]) {
        const subject = harness({ main: group(files, leaf('shell')), other: group(leaf('other')) });
        assert.equal(subject.get().maximizeWorkspacePane('local', key(files)), true);
        change(subject);
        const view = dockingView.workspaceDockingView(subject.get(), 'local');
        assert.equal(view.projection.value.maximizedContentId, undefined);
        assert.equal(subject.manager().layer.surfaces.length, 3);
        assert.deepEqual(subject.calls.resources, []);
    }
});

test('reset docking reveals the reset arrangement and preserves another workspace maximize request', () => {
    const subject = harness({ main: group(leaf('shell'), files) }, [files]);
    assert.equal(subject.get().maximizeWorkspacePane('local', key(files)), true);
    const other = { contentId: 'other', selectedOwner: 'other' };
    subject.set({ maximizedWorkspacePanes: { ...subject.get().maximizedWorkspacePanes, other } });
    assert.equal(subject.get().resetWorkspaceDocking('local'), true);
    assert.equal(subject.get().maximizedWorkspacePanes.local, undefined);
    assert.equal(subject.get().maximizedWorkspacePanes.other, other);
    assert.equal(subject.manager().layer.surfaces.filter((surface) => surface.visible).length, 2);
});

test('region drops move each existing content kind through allocation only, without cloning or selecting it', () => {
    for (const pane of [leaf('shell'), files, plugin]) {
        for (const destination of [
            'primary-sidebar',
            'secondary-sidebar',
            'bottom-panel',
            'workspace',
        ]) {
            const subject = harness(
                { main: group(pane) },
                destination === 'workspace' ? [pane] : [],
            );
            const before = subject.get();
            assert.equal(
                before.dropWorkspaceContent('local', layout.paneDockPayload(pane), destination),
                key(pane),
            );
            assert.equal(
                subject.get().workspaceDocking.local?.placements[key(pane)],
                destination === 'workspace' ? undefined : destination,
            );
            for (const field of [
                'terminals',
                'paneLayouts',
                'contentPresentation',
                'activeTerminalIds',
                'activePaneGroupOwner',
                'workspaceDockFocus',
            ]) {
                assert.equal(subject.get()[field], before[field], field);
            }
            assert.equal(subject.calls.saves, 1);
            for (const name of ['copies', 'resources', 'loads', 'views', 'tracks']) {
                assert.deepEqual(subject.calls[name], []);
            }
        }
    }
});

test('region drops reject disappeared, hidden, ambiguous, foreign and mismatched drag sources', () => {
    for (const [payload, patch] of [
        [{ kind: 'term', termId: 'missing' }, {}],
        [layout.paneDockPayload(files), { paneLayouts: {} }],
        [{ ...layout.paneDockPayload(files), sourcePaneId: 'closed' }, {}],
        [
            layout.paneDockPayload(files),
            {
                contentPresentation: {
                    local: { version: 3, items: { [key(files)]: { hidden: true } } },
                },
            },
        ],
        [layout.paneDockPayload(files), { paneLayouts: { other: { main: group(files) } } }],
        [
            layout.paneDockPayload(files),
            { paneLayouts: { local: { one: group(files), two: group(files) } } },
        ],
        [{ kind: 'feature', featureId: 'files' }, {}],
    ]) {
        const subject = harness({ main: group(files) });
        subject.set(patch);
        const before = subject.get();
        assert.equal(before.dropWorkspaceContent('local', payload, 'bottom-panel'), null);
        noWork(subject, before);
    }
});

test('region guide preflight and commits share readiness, capacity, format and registration restrictions', () => {
    const preflight = pure(
        'features/workspace/application/regionDrop.ts',
    ).workspaceRegionDropContent;
    for (const patch of [
        { sessionLoaded: false },
        { isRestoring: true },
        { sessionPersistenceBlocked: true },
        { workspaceDocking: { local: { version: 99, placements: {} } } },
        { workspaceViewRegistry: registrations.buildWorkspaceViewRegistrations([]) },
    ]) {
        const subject = harness({ main: group(plugin) });
        subject.set(patch);
        const before = subject.get();
        assert.equal(
            preflight(before, 'local', layout.paneDockPayload(plugin), 'primary-sidebar'),
            null,
        );
        assert.equal(
            before.dropWorkspaceContent('local', layout.paneDockPayload(plugin), 'primary-sidebar'),
            null,
        );
        noWork(subject, before);
    }
    const full = harness({
        source: group(files),
        full: group(...['a', 'b', 'c', 'd'].map((id) => leaf(id))),
    });
    const before = full.get();
    assert.equal(
        before.dropWorkspaceContent('local', layout.paneDockPayload(files), 'bottom-panel'),
        null,
    );
    noWork(full, before);
    const missing = harness({ main: group(plugin) }, [plugin]);
    missing.set({ workspaceViewRegistry: registrations.buildWorkspaceViewRegistrations([]) });
    assert.equal(
        missing.get().dropWorkspaceContent('local', layout.paneDockPayload(plugin), 'workspace'),
        key(plugin),
        'An unavailable plugin can return to its workspace without permission expansion',
    );
});

test('real guide adapter is context-scoped, filters occupied destinations and previews collapse of a sole source region', () => {
    const subject = harness({ main: group(plugin) }, [plugin]);
    const projection = pure(
        'features/workspace/domain/dockingProjection.ts',
    ).projectWorkspaceDocking(
        [{ owner: 'main', layout: subject.get().paneLayouts.local.main }],
        new Map([[key(plugin), 'bottom-panel']]),
        new Set(),
        'main',
    ).value;
    let live = { contextId: 'one', payload: layout.paneDockPayload(plugin) };
    const Guides = () => null;
    const jsx = (type, props) => ({ type, props });
    const { WorkspaceRegionDropTargets } = source(
        'components/workspace/WorkspaceRegionDropTargets.tsx',
        {
            react: { useSyncExternalStore: (_subscribe, snapshot) => snapshot() },
            'react/jsx-runtime': { jsx, jsxs: jsx },
            'zustand/react/shallow': { useShallow: (fn) => fn },
            '../../store/useAppStore': { useAppStore: (selector) => selector(subject.get()) },
            '../../features/workspace/application/regionDrop': pure(
                'features/workspace/application/regionDrop.ts',
            ),
            '../../lib/paneLayout/regions': pure('lib/paneLayout/regions.ts'),
            '../../lib/paneLayout': layout,
            '../layout/tabDock/session': {
                getTabDockLive: () => live,
                subscribeTabDock: () => () => {},
            },
            './RegionDropGuides': { RegionDropGuides: Guides },
        },
    );
    const render = () =>
        WorkspaceRegionDropTargets({ scope: 'local', contextId: 'one', projection });
    assert.deepEqual(Array.from(render().props.destinations), [
        'workspace',
        'primary-sidebar',
        'secondary-sidebar',
    ]);
    assert.equal(
        render().props.occupied.size,
        0,
        'The source bottom region will disappear when its only content moves',
    );
    live = { ...live, contextId: 'foreign' };
    assert.equal(render(), null);
    live = { ...live, contextId: 'one' };
    subject.set({ sessionPersistenceBlocked: true });
    assert.equal(render(), null);
    subject.set({
        sessionPersistenceBlocked: false,
        workspaceViewRegistry: registrations.buildWorkspaceViewRegistrations([]),
    });
    assert.deepEqual(Array.from(render().props.destinations), ['workspace']);
});

test('region resize merges only its fraction into current metadata without resource or selection work', () => {
    const subject = harness({ main: group(leaf('shell'), files, plugin) }, [files, plugin]);
    subject.set({
        workspaceDocking: {
            local: {
                version: 1,
                placements: {
                    [key(files)]: 'primary-sidebar',
                    [key(plugin)]: 'bottom-panel',
                },
            },
        },
    });
    const before = subject.get();
    assert.equal(before.resizeWorkspaceDockRegion('local', 'primary-sidebar', 0.3), true);
    assert.equal(subject.get().resizeWorkspaceDockRegion('local', 'bottom-panel', 0.45), true);
    assert.deepEqual(JSON.parse(JSON.stringify(subject.get().workspaceDocking.local.sizes)), {
        primary: 0.3,
        secondary: 0.24,
        bottom: 0.45,
    });
    for (const field of [
        'terminals',
        'paneLayouts',
        'contentPresentation',
        'activePaneGroupOwner',
        'activeTerminalIds',
        'workspaceDockFocus',
    ]) {
        assert.equal(subject.get()[field], before[field], field);
    }
    assert.equal(subject.calls.saves, 2);
    assert.equal(subject.get().resizeWorkspaceDockRegion('local', 'bottom-panel', 0.45), true);
    assert.equal(subject.calls.saves, 2, 'An unchanged fraction does not schedule another save');
    for (const name of ['copies', 'resources', 'loads', 'views', 'tracks']) {
        assert.deepEqual(subject.calls[name], []);
    }
});

test('region resize rejects absent, hidden, protected and malformed allocations without saving', () => {
    for (const patch of [
        { sessionLoaded: false },
        { isRestoring: true },
        { sessionPersistenceBlocked: true },
        { workspaceDocking: { local: { version: 99, placements: {} } } },
        { paneLayouts: {} },
        {
            contentPresentation: {
                local: { version: 3, items: { [key(plugin)]: { hidden: true } } },
            },
        },
    ]) {
        const subject = harness({ main: group(files, plugin) }, [plugin]);
        subject.set(patch);
        const before = subject.get();
        assert.equal(before.resizeWorkspaceDockRegion('local', 'bottom-panel', 0.3), false);
        noWork(subject, before);
    }
    for (const [region, size] of [
        ['workspace', 0.3],
        ['toString', 0.3],
        ['primary-sidebar', 0.3],
        ['bottom-panel', 0.9],
        ['bottom-panel', NaN],
    ]) {
        const subject = harness({ main: group(files, plugin) }, [plugin]);
        const before = subject.get();
        assert.equal(before.resizeWorkspaceDockRegion('local', region, size), false);
        noWork(subject, before);
    }
});

test('production frame exposes resize only while visible and writable and delegates a fresh scoped commit', () => {
    const subject = harness({ main: group(files, plugin) }, [plugin]);
    assert.equal(typeof subject.manager().frame.onResize, 'function');
    assert.equal(subject.manager().frame.onResize('bottom-panel', 0.33), true);
    assert.equal(subject.get().workspaceDocking.local.sizes.bottom, 0.33);
    assert.equal(subject.manager({ isWorkspaceActive: false }).frame.onResize, undefined);
    subject.set({ isRestoring: true });
    assert.equal(subject.manager().frame.onResize, undefined);
    subject.set({ isRestoring: false, sessionPersistenceBlocked: true });
    assert.equal(subject.manager().frame.onResize, undefined);
});
function reservedWorkspace() {
    const shell = leaf('shell');
    const dock = leaf('dock');
    return harness({ main: group(shell, files, plugin), dock: group(dock) }, [dock]);
}

test('real workspace renderer binds all canonical hosts to one layer and focuses docks without switching the center', () => {
    const shell = leaf('shell');
    const other = leaf('other');
    const subject = harness(
        { main: group(shell, files), other: group(other), plugin: group(plugin) },
        [plugin],
    );
    const before = subject.get();
    const rendered = subject.manager();
    assert.deepEqual(
        surfaceKeys(rendered.layer.surfaces),
        surfaceKeys([shell, files, other, plugin].map((pane) => ({ key: key(pane) }))),
    );
    assert.deepEqual(
        surfaceKeys(rendered.layer.surfaces.filter((surface) => surface.visible)),
        [key(shell), key(files), key(plugin)].sort(),
    );
    assert.deepEqual(surfaceKeys(rendered.layer.surfaces.filter((surface) => surface.focused)), [
        key(shell),
    ]);
    const dock = rendered.layer.surfaces.find((surface) => surface.key === key(plugin));
    const props = rendered.layer.renderSurface(dock).props;
    assert.equal(props.node, plugin);
    assert.equal(props.layout, before.paneLayouts.local.plugin);
    props.onFocusContent();
    assert.equal(subject.get().activePaneGroupOwner, before.activePaneGroupOwner);
    assert.equal(subject.get().activeTerminalIds, before.activeTerminalIds);
    assert.deepEqual(
        surfaceKeys(subject.manager().layer.surfaces.filter((surface) => surface.focused)),
        [key(plugin)],
    );
    assert.equal(subject.calls.saves, 0);
    assert.deepEqual(subject.calls.resources, []);
});

test('real renderer keeps persistent dock identities when selecting another center or deactivating the workspace', () => {
    const shell = leaf('shell');
    const other = leaf('other');
    const subject = harness(
        { main: group(shell, files), other: group(other), plugin: group(plugin) },
        [plugin],
    );
    const before = subject.get();
    subject.get().focusWorkspaceContent('local', key(other));
    const rendered = subject.manager();
    assert.deepEqual(
        surfaceKeys(rendered.layer.surfaces.filter((surface) => surface.visible)),
        [key(other), key(plugin)].sort(),
    );
    for (const surface of rendered.layer.surfaces) {
        const original = [shell, files, other, plugin].find((pane) => key(pane) === surface.key);
        assert.equal(surface.node, original, 'Allocations retain the exact canonical leaf');
    }
    assert.equal(subject.get().terminals, before.terminals);
    const inactive = subject.manager({ isWorkspaceActive: false });
    assert.equal(inactive.layer.surfaces.length, 4);
    assert.ok(inactive.layer.surfaces.every((surface) => !surface.visible && !surface.focused));
});

test('real renderer honors feature/plugin selection while leaving connection-wide docks visible', () => {
    const shell = leaf('shell');
    const subject = harness({ main: group(shell), files: group(files), plugin: group(plugin) }, [
        shell,
    ]);
    for (const [selection, center] of [
        [{ featureInstanceId: 'files-one' }, files],
        [{ pluginPanelId: 'owner:panel' }, plugin],
    ]) {
        const rendered = subject.manager(selection);
        assert.deepEqual(
            surfaceKeys(rendered.layer.surfaces.filter((surface) => surface.visible)),
            [key(shell), key(center)].sort(),
        );
        assert.equal(rendered.frame.projection.regions.workspace[0].layout.root, center);
    }
});

test('empty-center recovery says all hidden only when every canonical canvas has no visible projection', () => {
    const center = leaf('center');
    const fallback = 'ALL HIDDEN RECOVERY';
    const subject = harness({ center: group(center), dock: group(plugin), other: group(files) }, [
        plugin,
    ]);
    const text = (props) =>
        elements(
            subject.manager({ ...props, hiddenContentFallback: fallback }).frame.emptyWorkspace,
        )
            .flatMap((node) => [node.props.children].flat(Infinity))
            .filter((value) => typeof value === 'string');
    assert.ok(
        !text({ hiddenContentIds: new Set([key(center), key(files)]) }).includes(fallback),
        'a visible dock is not all-hidden',
    );
    assert.ok(
        !text({ hiddenContentIds: new Set([key(center), key(plugin)]) }).includes(fallback),
        'an unselected visible canvas remains recoverable by selecting its tab',
    );
    assert.ok(
        text({ hiddenContentIds: new Set([key(center), key(plugin), key(files)]) }).includes(
            fallback,
        ),
    );
    subject.set({
        contentPresentation: {
            local: {
                version: 3,
                items: Object.fromEntries(
                    [center, plugin, files].map((pane) => [key(pane), { hidden: true }]),
                ),
            },
        },
    });
    assert.ok(
        text({}).includes(fallback),
        'store visibility and externally supplied hiding follow the same projection',
    );
    assert.ok(
        !elements(
            harness({}).manager({ hiddenContentFallback: fallback }).frame.emptyWorkspace,
        ).some((node) => node.props.children === fallback),
        'empty inventory is not hidden inventory',
    );
});

test('real renderer retains resource inventory on unsupported metadata and never offers destructive format recovery', () => {
    const subject = harness({ main: group(files, plugin) });
    subject.set({ workspaceDocking: { local: { version: 99, placements: {} } } });
    const before = subject.get();
    const rendered = subject.manager();
    assert.equal(rendered.frame, undefined);
    assert.equal(rendered.reset, undefined);
    assert.deepEqual(surfaceKeys(rendered.layer.surfaces), [key(files), key(plugin)].sort());
    assert.ok(rendered.layer.surfaces.every((surface) => !surface.visible && !surface.focused));
    noWork(subject, before);
});

test('a plugin awaiting enrollment shows a status instead of an empty canvas or replacement-terminal action', () => {
    for (const groups of [{}, { main: group(leaf('shell')) }]) {
        const subject = harness(groups);
        const before = subject.get();
        const rendered = subject.manager({ pluginPanelId: 'pending:panel' });
        const fallback = elements(rendered.frame.emptyWorkspace);
        assert.ok(
            fallback.some(
                (node) =>
                    node.props.role === 'status' &&
                    node.props.children === 'Preparing plugin pane...',
            ),
        );
        assert.ok(!fallback.some((node) => node.props.children === 'Open New Terminal'));
        assert.ok(rendered.layer.surfaces.every((surface) => !surface.visible));
        noWork(subject, before);
    }
});

test('spatial navigation matches region proportions, nested splits and equal canonical pieces', () => {
    const a = leaf('a');
    const b = leaf('b');
    const c = leaf('c');
    const d = leaf('d');
    const subject = harness({ center: group(a), bottomOne: group(b, c), bottomTwo: group(d) }, [
        b,
        c,
        d,
    ]);
    const projection = dockingView.workspaceDockingView(subject.get(), 'local').projection;
    assert.equal(projection.ok, true);
    const rects = dockingNavigation.workspaceDockingRects(projection.value, { bottom: 0.4 });
    const bounds = (id) => JSON.parse(JSON.stringify(rects.find((rect) => rect.id === key(id))));
    assert.deepEqual(bounds(a), { id: key(a), x: 0, y: 0, w: 1, h: 0.6 });
    assert.deepEqual(bounds(b), { id: key(b), x: 0, y: 0.6, w: 0.25, h: 0.4 });
    assert.deepEqual(bounds(c), { id: key(c), x: 0.25, y: 0.6, w: 0.25, h: 0.4 });
    assert.deepEqual(bounds(d), { id: key(d), x: 0.5, y: 0.6, w: 0.5, h: 0.4 });
    for (const [from, direction, to] of [
        [b, 'right', c],
        [c, 'right', d],
        [d, 'left', c],
        [c, 'up', a],
    ]) {
        assert.equal(
            dockingNavigation.neighborWorkspaceContentId(
                { ...projection.value, focusedContentId: key(from) },
                direction,
                { bottom: 0.4 },
            ),
            key(to),
        );
    }
    assert.equal(
        dockingNavigation.neighborWorkspaceContentId(
            { ...projection.value, focusedContentId: key(d) },
            'right',
        ),
        null,
    );
});

test('recovery-only invalid topology cannot give a hidden retained host input ownership', () => {
    const panes = ['a', 'b', 'c', 'd'].map((id) => leaf(id));
    const dock = leaf('dock');
    const subject = harness({ center: group(...panes), dock: group(dock) }, [dock]);
    const before = subject.get();
    assert.equal(before.focusWorkspaceContent('local', key(dock)), false);
    assert.equal(before.focusWorkspaceContent('local', key(panes[0])), false);
    noWork(subject, before);
});

test('real renderer recovery resets only known allocation metadata and respects session write gates', () => {
    const panes = ['a', 'b', 'c', 'd'].map((id) => leaf(id));
    const dock = leaf('dock');
    const subject = harness({ main: group(...panes), dock: group(dock) }, [dock]);
    subject.set({ sessionPersistenceBlocked: true });
    assert.equal(subject.manager().reset.disabled, true);
    subject.set({ sessionPersistenceBlocked: false });
    const before = subject.get();
    const invalid = subject.manager();
    assert.equal(invalid.frame, undefined);
    assert.equal(invalid.reset.disabled, false);
    invalid.reset.onClick();
    assert.equal(subject.get().paneLayouts, before.paneLayouts);
    assert.equal(subject.get().terminals, before.terminals);
    assert.equal(subject.get().workspaceDocking.local, undefined);
    assert.deepEqual(
        surfaceKeys(subject.manager().layer.surfaces.filter((surface) => surface.visible)),
        panes.map(key).sort(),
    );
    assert.equal(subject.calls.saves, 1);
    assert.deepEqual(subject.calls.resources, []);
});

test('full dock reservations refuse standalone shell, feature and plugin creation without work', () => {
    const panes = ['a', 'b', 'c', 'd'].map((id) => leaf(id));
    for (const action of [
        (s) => s.createTerminal('local'),
        (s) => s.ensureFeaturePane('local', 'files', 'new-files'),
        (s) => s.ensurePluginPane('local', 'new:plugin'),
    ]) {
        const subject = harness(
            Object.fromEntries(panes.map((pane) => [pane.id, group(pane)])),
            panes,
        );
        const before = subject.get();
        assert.ok(!action(before));
        noWork(subject, before);
        assert.equal(subject.calls.warnings.length, 1);
    }
});

test('existing content can still be ensured at capacity without recreating its resources', () => {
    const panes = [files, plugin, leaf('a'), leaf('b')];
    const subject = harness(Object.fromEntries(panes.map((pane) => [pane.id, group(pane)])), panes);
    const before = subject.get();
    assert.equal(before.ensureFeaturePane('local', 'files', 'files-one'), true);
    assert.equal(before.ensurePluginPane('local', 'owner:panel'), true);
    assert.equal(before.ensureTerminal('local'), 'a');
    noWork(subject, before);
});

test('every duplicate kind reserves center capacity before state, copying or persistence', () => {
    for (const paneId of ['shell', files.id, plugin.id]) {
        const subject = reservedWorkspace();
        const before = subject.get();
        assert.equal(before.splitPanes('local', 'horizontal', 'after', paneId), false);
        noWork(subject, before);
    }
    const subject = reservedWorkspace();
    const before = subject.get();
    assert.equal(
        before.splitFeaturePane('local', 'files', 'horizontal', 'files-one'),
        'refused-cap',
    );
    noWork(subject, before);
});

test('seeding two new Files panes honors reservations and never creates refused listing state', () => {
    const docked = ['a', 'b', 'c'].map((id) => leaf(id));
    const subject = harness(
        Object.fromEntries(docked.map((pane) => [pane.id, group(pane)])),
        docked,
    );
    const before = subject.get();
    assert.equal(before.splitFeaturePane('local', 'files'), 'refused-cap');
    noWork(subject, before);
});

test('self-docking shells and duplicating feature/plugin instances are refused atomically at capacity', () => {
    for (const [payload, paneId] of [
        [{ kind: 'term', termId: 'shell' }, 'shell'],
        [files.content, files.id],
        [plugin.content, plugin.id],
    ]) {
        const subject = reservedWorkspace();
        const before = subject.get();
        assert.equal(before.dockInSplit('local', payload, 'right', paneId), 'refused-cap');
        noWork(subject, before);
    }
});

test('cross-owner moves and new feature/plugin inserts cannot overfill the reserved center', () => {
    for (const payload of [
        { kind: 'term', termId: 'extra' },
        { kind: 'feature', featureId: 'files' },
        { kind: 'plugin', pluginId: 'new:plugin' },
    ]) {
        const subject = reservedWorkspace();
        subject.set({
            terminals: {
                local: [...subject.get().terminals.local, { id: 'extra', title: 'Extra' }],
            },
        });
        const before = subject.get();
        assert.equal(before.dockInSplit('local', payload, 'right', 'shell'), 'refused-cap');
        noWork(subject, before);
    }
});

test('reordering existing same-canvas panes is allowed at capacity and retains exact content', () => {
    const subject = reservedWorkspace();
    const before = subject.get();
    assert.equal(
        before.dockInSplit('local', { ...files.content, sourcePaneId: files.id }, 'left', 'shell'),
        'moved',
    );
    assert.equal(subject.get().terminals.local, before.terminals.local);
    assert.equal(
        layout
            .collectLeaves(subject.get().paneLayouts.local.main.root)
            .find((pane) => pane.id === files.id).content,
        files.content,
    );
    assert.deepEqual(subject.calls.copies, []);
    assert.deepEqual(subject.calls.resources, []);
});

test('accepted duplication copies Files once after validation and retains the original listing identity', () => {
    const dock = leaf('dock');
    const subject = harness({ main: group(files, leaf('shell')), dock: group(dock) }, [dock]);
    assert.equal(
        subject.get().splitFeaturePane('local', 'files', 'horizontal', 'files-one'),
        'opened',
    );
    const leaves = layout.collectLeaves(subject.get().paneLayouts.local.main.root);
    assert.equal(leaves.length, 3);
    assert.equal(
        leaves.find((pane) => pane.id === files.id),
        files,
    );
    assert.equal(subject.calls.copies.length, 1);
    assert.equal(subject.calls.copies[0][1], 'files-one');
    assert.ok(leaves.some((pane) => pane.content.instanceId === subject.calls.copies[0][2]));
    assert.equal(subject.calls.saves, 1);
});

test('hidden panes still reserve capacity, dormant assignments do not, and scopes stay isolated', () => {
    const subject = reservedWorkspace();
    subject.set({
        contentPresentation: {
            local: { version: 3, items: { [key(leaf('dock'))]: { hidden: true } } },
        },
    });
    assert.equal(
        topology.allowsAdditionalCenterPane(
            subject.get(),
            'local',
            subject.get().paneLayouts.local.main,
        ),
        false,
    );
    subject.set({
        workspaceDocking: {
            local: { version: 1, placements: { [key(leaf('dormant'))]: 'bottom-panel' } },
        },
    });
    assert.equal(
        topology.allowsAdditionalCenterPane(
            subject.get(),
            'local',
            subject.get().paneLayouts.local.main,
        ),
        true,
    );
    assert.ok(subject.get().createTerminal('other'));
    assert.equal(subject.get().terminals.other.length, 1);
});

test('unknown docking metadata refuses topology creation without overwriting the stored envelope', () => {
    for (const action of [
        (s) => s.createTerminal('local'),
        (s) => s.ensureFeaturePane('local', 'files', 'new'),
        (s) => s.ensurePluginPane('local', 'new:plugin'),
        (s) => s.splitPanes('local'),
        (s) => s.splitFeaturePane('local', 'files'),
    ]) {
        const subject = harness({ main: group(leaf('shell')) });
        subject.set({ workspaceDocking: { local: { version: 2, placements: {} } } });
        const before = subject.get();
        action(before);
        noWork(subject, before);
    }
});

test('the real tab-bar custom-shell handler refuses before creating an orphan shell', () => {
    const subject = reservedWorkspace();
    const before = subject.get();
    const props = subject.tabBar();
    assert.equal(props.canSplit, false);
    props.onSplitNewShell('right', { id: 'bash', label: 'Bash' });
    noWork(subject, before);
});

test('open-here actions refuse before navigating shells or loading/copying files', async () => {
    for (const action of [
        (s) => s.openHere.openFilesHere('local', '/project', 'right', 'shell'),
        (s) => s.openHere.openTerminalHere('local', '/project', { edge: 'right' }),
        (s) => s.openHere.openTerminalHere('local', '/project', { edge: 'right', synced: true }),
    ]) {
        const subject = reservedWorkspace();
        subject.set({
            terminals: {
                local: [
                    ...subject.get().terminals.local,
                    { id: 'synced-shell', title: 'Synced', isSynced: true },
                ],
            },
        });
        const before = subject.get();
        await action(subject);
        noWork(subject, before);
    }
});

test('open-Files distinguishes no destination from exhausted pane capacity before doing work', async () => {
    const empty = harness({});
    const before = empty.get();
    await empty.openHere.openFilesHere('local', '/project', 'right');
    noWork(empty, before);
    assert.equal(empty.calls.warnings.length, 1);
    assert.equal(empty.calls.warnings[0][0], 'info');
    assert.match(empty.calls.warnings[0][1], /Open a terminal or select a workspace pane/);
    assert.doesNotMatch(empty.calls.warnings[0][1], /no room/);
    const full = reservedWorkspace();
    const fullBefore = full.get();
    await full.openHere.openFilesHere('local', '/project', 'right', 'shell');
    noWork(full, fullBefore);
    assert.equal(full.calls.warnings.length, 1);
    assert.match(full.calls.warnings[0][1], /no room for another pane/);
});

test('Files overlay split reserves its seed pane as well as the new shell', async () => {
    const docked = ['a', 'b', 'c'].map((id) => leaf(id));
    const subject = harness(
        Object.fromEntries(docked.map((pane) => [pane.id, group(pane)])),
        docked,
    );
    const before = subject.get();
    assert.equal(subject.openHere.canSplitBesideFiles('local'), false);
    await subject.openHere.openTerminalHere('local', '/project', { edge: 'right' });
    noWork(subject, before);
});

test('an accepted open-Files split navigates only the new instance, not the existing default listing', async () => {
    const subject = harness({ main: group(leaf('shell')) });
    await subject.openHere.openFilesHere('local', '/project', 'right', 'shell');
    const accepted = subject.get().paneLayouts.local.main;
    const pane = layout
        .collectLeaves(accepted.root)
        .find((item) => item.id === accepted.activePaneId);
    assert.equal(pane.content.featureId, 'files');
    assert.deepEqual(subject.calls.loads, [
        ['local', '/project', false, false, pane.content.instanceId],
    ]);
    assert.deepEqual(subject.calls.views, [['main', 'terminal']]);
});

test('open-Files preflight targets the requested shell canvas rather than remembered selection', async () => {
    const subject = reservedWorkspace();
    subject.set({
        terminals: { local: [...subject.get().terminals.local, { id: 'other', title: 'Other' }] },
    });
    await subject.openHere.openFilesHere('local', '/elsewhere', 'right', 'other');
    assert.equal(layout.collectLeaves(subject.get().paneLayouts.local.main.root).length, 3);
    assert.equal(layout.collectLeaves(subject.get().paneLayouts.local.other.root).length, 2);
    assert.equal(subject.calls.loads.length, 1);
});

test('accepted custom-shell splits retain the requested launch settings in a feature-only canvas', () => {
    const subject = harness({ main: group(files) });
    const props = subject.tabBar({ activeView: 'files', activeFeatureTabId: 'files-one' });
    assert.equal(props.canSplit, true);
    props.onSplitNewShell('right', { id: 'bash', label: 'Bash' });
    const terminal = subject.get().terminals.local[0];
    assert.equal(terminal.shellOverride, 'bash');
    assert.equal(terminal.title, 'Bash');
    const leaves = layout.collectLeaves(subject.get().paneLayouts.local.main.root);
    assert.equal(leaves.length, 2);
    assert.equal(
        leaves.find((pane) => pane.id === files.id),
        files,
    );
    assert.ok(leaves.some((pane) => pane.content.termId === terminal.id));
    assert.deepEqual(subject.calls.resources, []);
});

test('custom-shell insertion into any dock kind publishes once and keeps the center and original resources', () => {
    for (const pane of [leaf('docked-shell'), files, plugin]) {
        const center = group(leaf('center-shell'));
        const subject = harness({ center, other: group(pane) }, [pane]);
        subject.set({ workspaceDockFocus: { local: key(pane) } });
        const original = subject.get();
        const props = subject.tabBar({ activeView: 'files' });
        assert.equal(props.canSplit, true);
        props.onSplitNewShell('left', { id: 'bash', label: 'Bash' });
        const next = subject.get();
        const created = next.terminals.local.find(
            (item) => !original.terminals.local.some((prior) => prior.id === item.id),
        );
        assert.ok(created);
        assert.equal(created.shellOverride, 'bash');
        assert.equal(next.workspaceDocking.local.placements[key(leaf(created.id))], 'bottom-panel');
        assert.equal(next.workspaceDockFocus.local, key(leaf(created.id)));
        assert.equal(next.activePaneGroupOwner.local, original.activePaneGroupOwner.local);
        assert.equal(next.activeTerminalIds.local, original.activeTerminalIds.local);
        assert.equal(next.paneLayouts.local.center, center);
        assert.equal(
            layout
                .collectLeaves(next.paneLayouts.local.other.root)
                .find((item) => key(item) === key(pane)),
            pane,
        );
        assert.equal(subject.calls.saves, 1, 'no transient standalone shell publication');
        assert.equal(
            subject.calls.views.length +
                subject.calls.copies.length +
                subject.calls.resources.length,
            0,
        );
    }
});

test('a dock insertion reserves against other canvases before shell creation, even if its own canvas is small', () => {
    const subject = harness(
        { center: group(leaf('a'), leaf('b'), leaf('c')), other: group(files) },
        [files],
    );
    subject.set({ workspaceDockFocus: { local: key(files) } });
    const before = subject.get();
    const props = subject.tabBar();
    assert.equal(props.canSplit, false);
    props.onSplitNewShell('right', { id: 'bash', label: 'Bash' });
    noWork(subject, before);
    assert.equal(
        before.splitPanes(
            'local',
            'horizontal',
            'after',
            { contentId: key(files) },
            { shellOverride: 'bash' },
        ),
        false,
    );
    noWork(subject, before);
});

test('explicit shell options do not duplicate a single-instance plugin or inherit a different shell override', () => {
    const subject = harness({ main: group(plugin) });
    subject.set({
        workspaceViewRegistry: registrations.buildWorkspaceViewRegistrations([
            { id: 'owner:panel', pluginId: 'owner', title: 'Plugin', allowMultiple: false },
        ]),
    });
    assert.equal(
        subject
            .get()
            .splitPanes(
                'local',
                'horizontal',
                'after',
                { contentId: key(plugin) },
                { initialPath: '/project', isSynced: true },
            ),
        true,
    );
    const created = subject.get().terminals.local[0];
    assert.equal(created.title, 'Synced Terminal');
    assert.equal(created.initialPath, '/project');
    assert.equal(created.lastKnownCwd, '/project');
    assert.equal(subject.get().syncedTerminalId.local, created.id);
    assert.equal(
        layout
            .collectLeaves(subject.get().paneLayouts.local.main.root)
            .filter((item) => item.content.kind === 'plugin').length,
        1,
    );
    assert.equal(subject.calls.warnings.length, 0);
    subject.set({ terminals: { local: [{ ...created, shellOverride: 'powershell' }] } });
    assert.equal(
        subject
            .get()
            .splitPanes('local', 'horizontal', 'after', { contentId: key(leaf(created.id)) }, {}),
        true,
    );
    assert.equal(subject.get().terminals.local[1].shellOverride, undefined);
});

test('open-Files beside a dock uses an exact new listing identity and leaves the selected center view unchanged', async () => {
    const shell = leaf('docked-shell');
    const subject = harness({ center: group(plugin), other: group(shell) }, [shell]);
    const original = subject.get();
    await subject.openHere.openFilesHere('local', '/dock-project', 'right', 'docked-shell');
    const next = subject.get();
    const created = layout
        .collectLeaves(next.paneLayouts.local.other.root)
        .find((item) => item.content.kind === 'feature');
    assert.ok(created);
    assert.equal(next.workspaceDocking.local.placements[key(created)], 'bottom-panel');
    assert.equal(next.activePaneGroupOwner.local, original.activePaneGroupOwner.local);
    assert.equal(next.paneLayouts.local.center, original.paneLayouts.local.center);
    assert.deepEqual(subject.calls.loads, [
        ['local', '/dock-project', false, false, created.content.instanceId],
    ]);
    assert.deepEqual(subject.calls.views, []);
    assert.equal(subject.calls.saves, 1);
});

test('open-Files preserves its captured exact target across asynchronous focus changes', async () => {
    let resolveHome;
    const subject = harness({ first: group(leaf('shell')), second: group(leaf('other')) }, [], {
        onInvoke: () =>
            new Promise((resolve) => {
                resolveHome = resolve;
            }),
    });
    const pending = subject.openHere.openFilesHere('local', '', 'right');
    subject.set({
        activePaneGroupOwner: { local: 'second' },
        activeTerminalIds: { local: 'other' },
    });
    resolveHome('/project');
    await pending;
    assert.equal(layout.collectLeaves(subject.get().paneLayouts.local.first.root).length, 2);
    assert.equal(layout.collectLeaves(subject.get().paneLayouts.local.second.root).length, 1);
    assert.equal(subject.calls.loads.length, 1);
});

test('moving non-terminal content to a feature-only center retains the existing remembered shell mapping', () => {
    const subject = harness({ first: group(files), other: group(plugin) }, [], {
        extraTerms: ['remembered-shell'],
    });
    const remembered = subject.get().activeTerminalIds;
    assert.equal(
        subject.get().dockInSplit('local', layout.paneDockPayload(files), 'right', {
            contentId: key(plugin),
        }),
        'moved',
    );
    assert.equal(subject.get().activeTerminalIds, remembered);
    assert.equal(
        pure('features/workspace/domain/visibleContent.ts').implicitTerminalTarget(
            subject.get(),
            'local',
        ),
        'remembered-shell',
    );
});

test('a protected or closed dock refuses new Files before listing changes and does not seed a replacement', async () => {
    const shell = leaf('shell');
    for (const patch of [
        { sessionLoaded: false },
        { sessionPersistenceBlocked: true },
        { isRestoring: true },
        { terminals: {}, paneLayouts: {} },
    ]) {
        const subject = harness({ main: group(shell) }, [shell]);
        subject.set(patch);
        const before = subject.get();
        await subject.openHere.openFilesHere('local', '/project', 'right', 'shell');
        noWork(subject, before);
    }
});

test('open-Files revalidates after directory resolution and performs no listing mutation on refusal', async () => {
    let resolveHome;
    const home = new Promise((resolve) => {
        resolveHome = resolve;
    });
    const subject = harness({ main: group(leaf('shell')) }, [], { onInvoke: () => home });
    const pending = subject.openHere.openFilesHere('local', '', 'right', 'shell');
    const full = reservedWorkspace().get();
    subject.set({
        paneLayouts: full.paneLayouts,
        terminals: full.terminals,
        workspaceDocking: full.workspaceDocking,
    });
    const before = subject.get();
    resolveHome('/home/user');
    await pending;
    assert.equal(subject.get(), before);
    assert.equal(subject.calls.resources.length, 1);
    assert.equal(subject.calls.resources[0][0], 'fs_cwd');
    assert.equal(subject.calls.resources[0][1].connectionId, 'local');
    for (const name of ['copies', 'loads', 'views', 'tracks']) {
        assert.deepEqual(subject.calls[name], []);
    }
    assert.equal(subject.calls.saves, 0);
});

test('closing the host while resolving its directory never recreates a shell or Files pane', async () => {
    for (const kind of ['files', 'shell']) {
        let resolveHome;
        const subject = harness({ main: group(leaf('shell')) }, [], {
            onInvoke: () =>
                new Promise((resolve) => {
                    resolveHome = resolve;
                }),
        });
        const pending =
            kind === 'files'
                ? subject.openHere.openFilesHere('local', '', 'right', 'shell')
                : subject.openHere.openTerminalHere('local', '', { edge: 'right' });
        subject.set({ tabs: [] });
        const before = subject.get();
        resolveHome('/home/user');
        await pending;
        assert.equal(subject.get(), before);
        assert.equal(subject.calls.saves, 0);
        assert.deepEqual(subject.calls.copies, []);
        assert.deepEqual(subject.calls.loads, []);
        assert.equal(
            subject.calls.resources.length,
            1,
            'Only the initial read-only home lookup was allowed',
        );
    }
});

test('post-dock Files loading uses the explicitly addressed shell even if selection changes', async () => {
    const subject = harness({ main: group(leaf('shell')), other: group(leaf('other')) });
    const dock = subject.get().dockInSplit;
    subject.set({
        dockInSplit: (...args) => {
            const result = dock(...args);
            // Selection can be repaired independently by a synchronous store subscriber.
            subject.set({
                activePaneGroupOwner: { local: 'other' },
                activeTerminalIds: { local: 'other' },
            });
            return result;
        },
    });
    await subject.openHere.openFilesHere('local', '/project', 'right', 'shell');
    const pane = layout
        .collectLeaves(subject.get().paneLayouts.local.main.root)
        .find((item) => item.content.kind === 'feature');
    assert.deepEqual(subject.calls.loads, [
        ['local', '/project', false, false, pane.content.instanceId],
    ]);
});

test('hiding the target during a directory lookup cannot leave a newly created orphan shell', async () => {
    let resolveHome;
    const subject = harness({ main: group(files) }, [], {
        onInvoke: () =>
            new Promise((resolve) => {
                resolveHome = resolve;
            }),
    });
    const pending = subject.openHere.openTerminalHere('local', '', { edge: 'right' });
    subject.set({
        contentPresentation: { local: { version: 3, items: { [key(files)]: { hidden: true } } } },
    });
    const before = subject.get();
    resolveHome('/home/user');
    await pending;
    assert.equal(subject.get(), before);
    assert.equal(subject.calls.saves, 0);
    assert.deepEqual(subject.calls.copies, []);
    assert.deepEqual(subject.calls.views, []);
    assert.equal(subject.get().terminals.local.length, 0);
});

test('a remembered synced shell without Files is not treated as an existing Files split', async () => {
    const docked = ['a', 'b', 'c'].map((id) => leaf(id));
    const subject = harness(
        {
            main: group(leaf('shell')),
            ...Object.fromEntries(docked.map((pane) => [pane.id, group(pane)])),
        },
        docked,
    );
    subject.set({
        terminals: {
            local: subject
                .get()
                .terminals.local.map((term) => ({ ...term, isSynced: term.id === 'shell' })),
        },
    });
    const before = subject.get();
    await subject.openHere.openTerminalHere('local', '/project', { synced: true, edge: 'right' });
    noWork(subject, before);
});

test('Open Terminal here inserts once into the exact docked Files instance and preserves the center', async () => {
    const sibling = { ...files, content: { ...files.content, instanceId: 'files-two' } };
    const subject = harness({ center: group(sibling), dock: group(files) }, [files]);
    const before = subject.get();
    await subject.openHere.openTerminalHere('local', '/dock-project', {
        edge: 'right',
        instanceId: 'files-one',
        synced: true,
    });
    const next = subject.get();
    assert.equal(next.terminals.local.length, 1);
    const created = next.terminals.local[0];
    assert.equal(created.initialPath, '/dock-project');
    assert.equal(created.isSynced, true);
    assert.equal(next.syncedTerminalId.local, created.id);
    assert.equal(next.workspaceDocking.local.placements[key(leaf(created.id))], 'bottom-panel');
    assert.equal(next.paneLayouts.local.center, before.paneLayouts.local.center);
    assert.equal(next.activePaneGroupOwner.local, before.activePaneGroupOwner.local);
    assert.equal(next.activeTerminalIds, before.activeTerminalIds);
    assert.equal(subject.calls.saves, 1);
    assert.equal(
        subject.calls.resources.length + subject.calls.views.length + subject.calls.copies.length,
        0,
    );
});

test('legacy Files seeding and a new shell publish together without a temporary standalone tab', async () => {
    const subject = harness({ center: group(leaf('shell')) });
    const original = subject.get().paneLayouts.local.center;
    await subject.openHere.openTerminalHere('local', '/legacy', { edge: 'right' });
    const next = subject.get();
    assert.equal(next.terminals.local.length, 2);
    assert.equal(next.paneLayouts.local.center, original);
    const seeded = layout.collectLeaves(next.paneLayouts.local.workspace.root);
    assert.equal(seeded.length, 2);
    assert.equal(
        seeded.filter(
            (pane) => pane.content.kind === 'feature' && pane.content.featureId === 'files',
        ).length,
        1,
    );
    assert.equal(subject.calls.saves, 1);
    assert.equal(subject.calls.copies.length, 1);
    assert.equal(subject.calls.resources.length, 0);
});

test('moving a synced shell out of a dock frees its reservation before adding it to a full center', async () => {
    const subject = reservedWorkspace();
    subject.set({
        terminals: {
            local: subject
                .get()
                .terminals.local.map((term) => ({ ...term, isSynced: term.id === 'dock' })),
        },
    });
    assert.equal(
        subject.openHere.canSplitBesideFiles('local', {
            instanceId: files.content.instanceId,
            synced: true,
        }),
        true,
    );
    await subject.openHere.openTerminalHere('local', '/project', {
        edge: 'right',
        instanceId: files.content.instanceId,
        synced: true,
    });
    assert.equal(layout.collectLeaves(subject.get().paneLayouts.local.main.root).length, 4);
    assert.equal(subject.get().workspaceDocking.local?.placements[key(leaf('dock'))], undefined);
    assert.equal(subject.calls.resources.length, 1);
    assert.equal(subject.calls.resources[0][0], 'terminal:navigate');
    assert.equal(subject.calls.resources[0][1].termId, 'dock');
});

test('synced docking rejects a cross-canvas reservation conflict before sending native navigation', async () => {
    const subject = harness(
        {
            center: group(leaf('a'), leaf('b'), leaf('c')),
            dock: group(files),
            source: group(leaf('synced')),
        },
        [files],
    );
    subject.set({
        terminals: {
            local: subject
                .get()
                .terminals.local.map((term) => ({ ...term, isSynced: term.id === 'synced' })),
        },
    });
    const before = subject.get();
    assert.equal(
        subject.openHere.canSplitBesideFiles('local', {
            instanceId: files.content.instanceId,
            synced: true,
        }),
        false,
    );
    await subject.openHere.openTerminalHere('local', '/project', {
        edge: 'right',
        instanceId: files.content.instanceId,
        synced: true,
    });
    noWork(subject, before);
});

test('Open Terminal here keeps its original Files identity through a delayed directory lookup', async () => {
    let resolveHome;
    const second = { ...files, content: { ...files.content, instanceId: 'files-two' } };
    const subject = harness({ first: group(files), second: group(second) }, [], {
        onInvoke: () =>
            new Promise((resolve) => {
                resolveHome = resolve;
            }),
    });
    const pending = subject.openHere.openTerminalHere('local', '', {
        edge: 'right',
        instanceId: files.content.instanceId,
    });
    subject.set({ activePaneGroupOwner: { local: 'second' } });
    resolveHome('/home/user');
    await pending;
    assert.equal(layout.collectLeaves(subject.get().paneLayouts.local.first.root).length, 2);
    assert.equal(subject.get().paneLayouts.local.second.root, second);
    assert.equal(subject.get().terminals.local[0].initialPath, '/home/user');
    assert.equal(subject.calls.saves, 1);
});

test('stale Files instances and a synced shell closed during directory resolution never create replacements', async () => {
    const stale = harness({ main: group(files) });
    const before = stale.get();
    await stale.openHere.openTerminalHere('local', '/project', {
        edge: 'right',
        instanceId: 'closed',
    });
    noWork(stale, before);
    let resolveHome;
    const subject = harness({ main: group(files) }, [], {
        extraTerms: ['synced'],
        onInvoke: () =>
            new Promise((resolve) => {
                resolveHome = resolve;
            }),
    });
    subject.set({ terminals: { local: [{ id: 'synced', title: 'Synced', isSynced: true }] } });
    const pending = subject.openHere.openTerminalHere('local', '', {
        edge: 'right',
        instanceId: files.content.instanceId,
        synced: true,
    });
    subject.set({ terminals: { local: [] } });
    const closed = subject.get();
    resolveHome('/home/user');
    await pending;
    assert.equal(subject.get(), closed);
    assert.equal(subject.calls.resources.length, 1);
    assert.equal(subject.calls.saves, 0);
});

test('failed synced navigation retains the accepted layout without recreating resources or claiming a new cwd', async () => {
    const subject = harness({ main: group(files) }, [], {
        extraTerms: ['synced'],
        onInvoke: () => {
            throw new Error('navigation failed');
        },
    });
    subject.set({ terminals: { local: [{ id: 'synced', title: 'Synced', isSynced: true }] } });
    await subject.openHere.openTerminalHere('local', '/project', {
        edge: 'right',
        instanceId: files.content.instanceId,
        synced: true,
    });
    assert.equal(layout.collectLeaves(subject.get().paneLayouts.local.main.root).length, 2);
    assert.equal(subject.get().terminals.local.length, 1);
    assert.equal(subject.get().terminals.local[0].lastKnownCwd, undefined);
    assert.equal(subject.calls.saves, 1);
    assert.equal(subject.calls.views.length, 0);
    assert.equal(subject.calls.warnings[0][0], 'error');
});

test('concurrent Follow with Terminal requests reuse the newly enrolled synced shell', async () => {
    const subject = harness({ main: group(files) });
    await Promise.all(
        [1, 2].map(() =>
            subject.openHere.openTerminalHere('local', '/project', {
                edge: 'right',
                instanceId: files.content.instanceId,
                synced: true,
            }),
        ),
    );
    assert.equal(subject.get().terminals.local.length, 1);
    assert.equal(layout.collectLeaves(subject.get().paneLayouts.local.main.root).length, 2);
    assert.equal(subject.get().syncedTerminalId.local, subject.get().terminals.local[0].id);
    assert.equal(subject.calls.resources.length, 1);
    assert.equal(subject.calls.resources[0][0], 'terminal:navigate');
});

test('synchronous disposal after a synced move cannot dispatch a navigation command to the removed shell', async () => {
    const subject = harness({ main: group(files) }, [], { extraTerms: ['synced'] });
    const dock = subject.get().dockInSplit;
    subject.set({
        terminals: { local: [{ id: 'synced', title: 'Synced', isSynced: true }] },
        dockInSplit: (...args) => {
            const result = dock(...args);
            subject.set({ terminals: { local: [] } });
            return result;
        },
    });
    await subject.openHere.openTerminalHere('local', '/project', {
        edge: 'right',
        instanceId: files.content.instanceId,
        synced: true,
    });
    assert.equal(subject.calls.resources.length, 0);
    assert.equal(subject.calls.views.length, 0);
});

test('dock duplication and launch respect the registered locations for the incoming kind', () => {
    for (const pane of [leaf('shell'), files, plugin]) {
        const subject = harness({ main: group(pane) }, [pane]);
        const registry = subject.get().workspaceViewRegistry;
        subject.set({
            workspaceViewRegistry: {
                ...registry,
                registrations: registry.registrations.map((item) => ({
                    ...item,
                    allowedLocations: ['workspace'],
                })),
            },
        });
        const before = subject.get();
        assert.equal(
            before.splitPanes('local', 'horizontal', 'after', { contentId: key(pane) }),
            false,
        );
        noWork(subject, before);
        assert.equal(
            before.openTerminalInSplit('local', 'right', { contentId: key(pane) }),
            'no-target',
        );
        noWork(subject, before);
        if (pane === files) {
            assert.equal(
                before.splitFeaturePane('local', 'files', 'horizontal', files.content.instanceId),
                'no-target',
            );
            noWork(subject, before);
        }
    }
});

test('new-shell docking cannot overwrite a live terminal identity through its internal launch path', () => {
    const subject = harness({ main: group(files) }, [], { extraTerms: ['existing'] });
    const before = subject.get();
    assert.equal(
        before.dockInSplit(
            'local',
            { kind: 'term', termId: 'existing' },
            'right',
            { contentId: key(files) },
            undefined,
            undefined,
            { initialPath: '/project' },
        ),
        'no-target',
    );
    noWork(subject, before);
});

test('Files context menu passes its instance to distinct new-shell and synced-shell preflights and actions', async () => {
    const file = ts.createSourceFile(
        'FileManager.tsx',
        readFileSync(new URL('../src/components/FileManager.tsx', import.meta.url), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
    );
    const helper = file.statements.find(
        (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'terminalHereMenuItems',
    );
    assert.ok(helper);
    const { outputText } = ts.transpileModule(`export ${helper.getText(file)}`, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            jsx: ts.JsxEmit.ReactJSX,
        },
    });
    const calls = [];
    let done = 0;
    const context = {
        exports: {},
        Terminal: () => {},
        Zap: () => {},
        require: (name) => {
            assert.equal(name, 'react/jsx-runtime');
            return { jsx: () => ({}) };
        },
        canSplitBesideFiles: (scope, options) => {
            calls.push(['preflight', scope, options]);
            return options.synced === true;
        },
        openHerePlacementItems: (standalone, split, disabled) => ({ standalone, split, disabled }),
        openTerminalHere: async (...args) => {
            calls.push(['launch', ...args]);
        },
    };
    runInNewContext(outputText, context);
    const items = context.exports.terminalHereMenuItems(
        'local',
        '/instance',
        undefined,
        () => {
            done++;
        },
        'exact-files',
    );
    assert.equal(items[0].children.disabled, true);
    assert.equal(items[1].children.disabled, false);
    assert.equal(calls[0][2].instanceId, 'exact-files');
    assert.equal(calls[1][2].instanceId, 'exact-files');
    items[1].children.split('left');
    await Promise.resolve();
    assert.equal(calls[2][3].instanceId, 'exact-files');
    assert.equal(calls[2][3].synced, true);
    assert.equal(calls[2][3].edge, 'left');
    assert.equal(done, 1);
    const uses = [];
    const visit = (node) => {
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === 'terminalHereMenuItems'
        ) {
            uses.push(node);
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    assert.equal(uses.length, 2);
    assert.ok(
        uses.every((node) => node.arguments[4]?.getText(file) === 'instanceId'),
        'both real menu entry points supply their instance',
    );
});

test('repositioning a live synced shell within an existing full Files canvas stays allowed', async () => {
    const subject = reservedWorkspace();
    subject.set({
        terminals: {
            local: subject
                .get()
                .terminals.local.map((term) => ({ ...term, isSynced: term.id === 'shell' })),
        },
    });
    const originalCount = subject.get().terminals.local.length;
    await subject.openHere.openTerminalHere('local', '/project', { synced: true, edge: 'left' });
    assert.equal(subject.calls.resources.length, 1);
    assert.equal(subject.calls.resources[0][0], 'terminal:navigate');
    assert.equal(subject.calls.resources[0][1].termId, 'shell');
    assert.equal(subject.get().terminals.local.length, originalCount);
    assert.equal(layout.collectLeaves(subject.get().paneLayouts.local.main.root).length, 3);
});

test('implicit synced-terminal reuse cannot navigate a hidden shell or an unsupported topology', async () => {
    for (const hidden of [true, false]) {
        const subject = reservedWorkspace();
        subject.set({
            terminals: {
                local: subject
                    .get()
                    .terminals.local.map((term) => ({ ...term, isSynced: term.id === 'shell' })),
            },
            ...(hidden
                ? {
                      contentPresentation: {
                          local: { version: 3, items: { [key(leaf('shell'))]: { hidden: true } } },
                      },
                  }
                : { workspaceDocking: { local: { version: 2, placements: {} } } }),
        });
        const before = subject.get();
        await subject.openHere.openTerminalHere('local', '/project', {
            synced: true,
            edge: 'right',
        });
        noWork(subject, before);
    }
});

test('a synced shell hidden during native navigation receives no stale follow-up selection', async () => {
    let resolveNavigate;
    let entered;
    const navigationStarted = new Promise((resolve) => {
        entered = resolve;
    });
    const subject = reservedWorkspace();
    // Build the same full canvas with a deferred native operation.
    const delayed = harness(subject.get().paneLayouts.local, [leaf('dock')], {
        onInvoke: () => {
            entered();
            return new Promise((resolve) => {
                resolveNavigate = resolve;
            });
        },
    });
    delayed.set({
        terminals: {
            local: delayed
                .get()
                .terminals.local.map((term) => ({ ...term, isSynced: term.id === 'shell' })),
        },
    });
    const pending = delayed.openHere.openTerminalHere('local', '/project', {
        synced: true,
        edge: 'right',
    });
    await navigationStarted;
    delayed.set({
        contentPresentation: {
            local: { version: 3, items: { [key(leaf('shell'))]: { hidden: true } } },
        },
    });
    const before = delayed.get();
    resolveNavigate();
    await pending;
    assert.equal(delayed.get().paneLayouts, before.paneLayouts);
    assert.equal(delayed.get().terminals.local.length, before.terminals.local.length);
    assert.deepEqual(delayed.calls.views, []);
    assert.deepEqual(delayed.calls.copies, []);
    assert.equal(
        delayed.calls.resources.length,
        1,
        'Already completed native navigation is not falsely rolled back',
    );
});

test('production move changes only allocation and retains each resource and its canonical tree', () => {
    const subject = harness({ main: group(leaf('shell'), files), plugin: group(plugin) });
    const before = subject.get();
    assert.equal(before.moveWorkspaceContent('local', key(files), 'primary-sidebar'), true);
    assert.equal(subject.get().workspaceDocking.local.placements[key(files)], 'primary-sidebar');
    for (const field of [
        'terminals',
        'paneLayouts',
        'activePaneGroupOwner',
        'activeTerminalIds',
        'tabs',
    ]) {
        assert.equal(subject.get()[field], before[field], field);
    }
    assert.deepEqual(subject.calls.resources, []);
    assert.deepEqual(subject.calls.copies, []);
    assert.equal(subject.calls.saves, 1);
    assert.equal(subject.get().moveWorkspaceContent('local', key(files), 'primary-sidebar'), true);
    assert.equal(subject.calls.saves, 1, 'No-op moves do not save');
    const view = dockingView.workspaceDockingView(subject.get(), 'local');
    assert.equal(view.projection.ok, true);
    assert.equal(view.projection.value.regions['primary-sidebar'][0].layout.root, files);
    assert.equal(view.projection.value.regions.workspace[0].layout.root.id, 'shell');
});

test('moving a new dock cannot overfill a different center canvas when it is selected later', () => {
    const subject = harness({
        main: group(...['a', 'b', 'c', 'd'].map((id) => leaf(id))),
        side: group(files),
    });
    const before = subject.get();
    assert.equal(before.moveWorkspaceContent('local', key(files), 'bottom-panel'), false);
    noWork(subject, before);
});

test('dock focus is transient and does not replace the selected center or remembered shell', () => {
    const subject = harness({ main: group(leaf('shell')), side: group(files, plugin) }, [
        files,
        plugin,
    ]);
    const before = subject.get();
    assert.equal(before.focusWorkspaceContent('local', key(plugin)), true);
    for (const field of [
        'terminals',
        'paneLayouts',
        'activePaneGroupOwner',
        'activeTerminalIds',
        'tabs',
        'workspaceDocking',
    ]) {
        assert.equal(subject.get()[field], before[field]);
    }
    assert.equal(subject.calls.saves, 0);
    assert.equal(
        dockingView.workspaceDockingView(subject.get(), 'local').projection.value.focusedContentId,
        key(plugin),
    );
    const focusedState = subject.get();
    assert.equal(focusedState.focusWorkspaceContent('local', key(plugin)), true);
    assert.equal(subject.get(), focusedState, 'Repeated focus must not churn the store');
    subject.get().setActiveTerminal('local', 'shell');
    assert.equal(subject.get().workspaceDockFocus.local, null);
    assert.equal(
        dockingView.workspaceDockingView(subject.get(), 'local').projection.value.focusedContentId,
        key(leaf('shell')),
    );
});

test('exact content-key focus disambiguates identical local pane IDs in different canvases', () => {
    const first = leaf('reused', { kind: 'term', termId: 'first' });
    const second = leaf('reused', { kind: 'term', termId: 'second' });
    const subject = harness({ main: group(first), side: group(second) }, [second]);
    assert.equal(subject.get().focusWorkspaceContent('local', key(second)), true);
    assert.equal(subject.get().activePaneGroupOwner.local, 'main');
    assert.equal(
        pure('features/workspace/domain/visibleContent.ts').implicitTerminalTarget(
            subject.get(),
            'local',
        ),
        'second',
    );
    assert.equal(subject.get().moveWorkspaceContent('local', key(second), 'workspace'), true);
    assert.equal(subject.get().focusWorkspaceContent('local', key(second)), true);
    assert.equal(subject.get().activePaneGroupOwner.local, 'side');
    assert.equal(subject.get().activeTerminalIds.local, 'second');
});

test('hidden, stale, foreign and duplicated identities cannot acquire dock focus or move content', () => {
    const subject = harness({ main: group(leaf('shell')), side: group(files) }, [files]);
    subject.set({
        contentPresentation: { local: { version: 3, items: { [key(files)]: { hidden: true } } } },
    });
    const before = subject.get();
    assert.equal(before.focusWorkspaceContent('local', key(files)), false);
    assert.equal(before.focusWorkspaceContent('local', key(plugin)), false);
    assert.equal(before.moveWorkspaceContent('foreign', key(files), 'workspace'), false);
    noWork(subject, before);
    subject.set({ paneLayouts: { local: { main: group(files), duplicate: group(files) } } });
    const ambiguous = subject.get();
    assert.equal(ambiguous.focusWorkspaceContent('local', key(files)), false);
    assert.equal(ambiguous.moveWorkspaceContent('local', key(files), 'workspace'), false);
    noWork(subject, ambiguous);
});

test('movement obeys registration locations but returning an unavailable plugin stays recoverable', () => {
    const subject = harness({ main: group(leaf('shell')), side: group(plugin) }, [plugin]);
    subject.set({ workspaceViewRegistry: registrations.buildWorkspaceViewRegistrations() });
    const before = subject.get();
    assert.equal(before.moveWorkspaceContent('local', key(plugin), 'primary-sidebar'), false);
    noWork(subject, before);
    assert.equal(subject.get().moveWorkspaceContent('local', key(plugin), 'workspace'), true);
    assert.equal(subject.get().workspaceDocking.local, undefined);
    assert.equal(subject.get().paneLayouts.local.side.root, plugin);
});

test('allocation writes validate readiness, schema and sizes; reset keeps content, pins and visibility', () => {
    for (const gate of [
        { sessionLoaded: false },
        { isRestoring: true },
        { sessionPersistenceBlocked: true },
        { workspaceDocking: { local: { version: 2, placements: {} } } },
    ]) {
        const subject = harness({ main: group(files) });
        subject.set(gate);
        const before = subject.get();
        assert.equal(before.moveWorkspaceContent('local', key(files), 'bottom-panel'), false);
        assert.equal(
            before.setWorkspaceDockSizes('local', { primary: 0.2, secondary: 0.2, bottom: 0.3 }),
            false,
        );
        assert.equal(before.resetWorkspaceDocking('local'), false);
        noWork(subject, before);
    }
    const subject = harness({ main: group(files) }, [files]);
    const before = subject.get();
    assert.equal(
        before.setWorkspaceDockSizes('local', { primary: 0.99, secondary: 0.2, bottom: 0.3 }),
        false,
    );
    noWork(subject, before);
    assert.equal(
        subject.get().setWorkspaceDockSizes('local', { primary: 0.2, secondary: 0.2, bottom: 0.3 }),
        true,
    );
    subject.get().focusWorkspaceContent('local', key(files));
    assert.equal(subject.get().resetWorkspaceDocking('local'), true);
    assert.equal(subject.get().workspaceDocking.local, undefined);
    assert.equal(subject.get().workspaceDockFocus.local, null);
    assert.equal(subject.get().paneLayouts, before.paneLayouts);
    assert.equal(subject.get().contentPresentation, before.contentPresentation);
});

test('docked duplication inherits its source location without selecting that canvas or replacing remembered input', () => {
    for (const pane of [files, plugin, leaf('dock-shell')]) {
        const subject = harness({ center: group(leaf('center')), source: group(pane) }, [pane]);
        subject.get().focusWorkspaceContent('local', key(pane));
        const before = subject.get();
        assert.equal(before.splitPanes('local', 'vertical'), true);
        const next = subject.get();
        const duplicated = layout
            .collectLeaves(next.paneLayouts.local.source.root)
            .find((item) => key(item) !== key(pane));
        assert.ok(duplicated);
        assert.equal(duplicated.content.kind, pane.content.kind);
        assert.equal(next.workspaceDocking.local.placements[key(duplicated)], 'bottom-panel');
        assert.equal(next.workspaceDockFocus.local, key(duplicated));
        assert.equal(next.activePaneGroupOwner, before.activePaneGroupOwner);
        assert.equal(next.activeTerminalIds, before.activeTerminalIds);
        assert.equal(
            next.paneLayouts.local.source.activePaneId,
            before.paneLayouts.local.source.activePaneId,
        );
        assert.equal(next.paneLayouts.local.center, before.paneLayouts.local.center);
        assert.equal(subject.calls.copies.length, pane === files ? 1 : 0);
        assert.equal(subject.calls.saves, 1);
        assert.deepEqual(subject.calls.resources, []);
    }
});

test('new dock reservations and bounded metadata are checked before duplicate resources or listings are published', () => {
    const center = [leaf('a'), leaf('b'), leaf('c')];
    const full = harness({ center: group(...center), source: group(files) }, [files]);
    let before = full.get();
    assert.equal(
        before.splitPanes('local', 'horizontal', 'after', { contentId: key(files) }),
        false,
    );
    noWork(full, before);
    const bounded = harness({ center: group(leaf('center')), source: group(files) }, [files]);
    bounded.set({
        workspaceDocking: {
            local: {
                version: 1,
                placements: {
                    ...Object.fromEntries(
                        Array.from({ length: 255 }, (_, index) => [
                            key(leaf(`dormant-${index}`)),
                            'bottom-panel',
                        ]),
                    ),
                    [key(files)]: 'bottom-panel',
                },
            },
        },
    });
    before = bounded.get();
    assert.equal(
        before.splitPanes('local', 'horizontal', 'after', { contentId: key(files) }),
        false,
    );
    noWork(bounded, before);
    for (const gate of [
        { sessionLoaded: false },
        { isRestoring: true },
        { sessionPersistenceBlocked: true },
    ]) {
        const subject = harness({ center: group(leaf('center')), source: group(files) }, [files]);
        subject.set(gate);
        before = subject.get();
        assert.equal(
            before.splitPanes('local', 'horizontal', 'after', { contentId: key(files) }),
            false,
        );
        noWork(subject, before);
    }
});

test('exact split and close targets resolve the live content instead of a colliding local pane ID', () => {
    const other = leaf(files.id, plugin.content);
    const subject = harness({ first: group(files), second: group(other) });
    const before = subject.get();
    assert.equal(before.splitPanes('local', 'horizontal', 'after', files.id), false);
    assert.equal(before.closePaneInSplit('local', files.id), false);
    noWork(subject, before);
    assert.equal(
        subject.get().splitPanes('local', 'horizontal', 'after', { contentId: key(other) }),
        true,
    );
    assert.equal(subject.get().paneLayouts.local.first, before.paneLayouts.local.first);
    assert.equal(layout.collectLeaves(subject.get().paneLayouts.local.second.root).length, 2);
    assert.equal(subject.get().closePaneInSplit('local', { contentId: key(other) }), true);
    assert.equal(subject.get().paneLayouts.local.first, before.paneLayouts.local.first);
    assert.ok(
        !Object.values(subject.get().paneLayouts.local)
            .flatMap((canvas) => layout.collectLeaves(canvas.root))
            .some((item) => key(item) === key(other)),
    );
});

test('successful exact close cleans only removed docking identities; blocked closes preserve everything', () => {
    const shell = leaf('center');
    const subject = harness({ center: group(shell), source: group(files, plugin) }, [
        files,
        plugin,
    ]);
    subject.set({
        workspaceDocking: {
            local: {
                version: 1,
                placements: {
                    ...subject.get().workspaceDocking.local.placements,
                    [key(leaf('dormant'))]: 'primary-sidebar',
                },
                sizes: { primary: 0.2, secondary: 0.2, bottom: 0.3 },
            },
        },
    });
    subject.get().focusWorkspaceContent('local', key(plugin));
    const center = subject.get().paneLayouts.local.center;
    assert.equal(subject.get().closePaneInSplit('local', { contentId: key(plugin) }), true);
    assert.equal(subject.get().workspaceDocking.local.placements[key(plugin)], undefined);
    assert.equal(subject.get().workspaceDocking.local.placements[key(files)], 'bottom-panel');
    assert.equal(
        subject.get().workspaceDocking.local.placements[key(leaf('dormant'))],
        'primary-sidebar',
    );
    assert.equal(subject.get().workspaceDocking.local.sizes.bottom, 0.3);
    assert.equal(subject.get().workspaceDockFocus.local, null);
    assert.equal(subject.get().paneLayouts.local.center, center);
    const blocked = harness({ center: group(shell), source: group(files) }, [files], {
        blockClose: true,
    });
    const before = blocked.get();
    assert.equal(before.closePaneInSplit('local', { contentId: key(files) }), false);
    noWork(blocked, before);
});

test('post-close cleanup ignores still-live content and preserves unknown future metadata', () => {
    const subject = harness({ source: group(files) }, [files]);
    const before = subject.get();
    before.forgetClosedWorkspaceDocking('local', [key(files)]);
    noWork(subject, before);
    const future = { local: { version: 99, placements: { [key(plugin)]: 'bottom-panel' } } };
    subject.set({ workspaceDocking: future, workspaceDockFocus: { local: key(plugin) } });
    subject.get().forgetClosedWorkspaceDocking('local', [key(plugin)]);
    assert.equal(subject.get().workspaceDocking, future);
    assert.equal(subject.get().workspaceDockFocus.local, null);
    assert.equal(subject.calls.saves, 0);
});

test('divider updates use their canonical owner and reject ambiguous or stale targets without saving', () => {
    const first = group(files, leaf('a'));
    const second = group(plugin, leaf('b'));
    second.root = { ...second.root, id: first.root.id };
    const subject = harness({ first, second });
    const before = subject.get();
    before.resizePanes('local', first.root.id, [0.3, 0.7], true);
    // The test store merges identity no-op patches, so assert domain references and effects.
    assert.equal(subject.get().paneLayouts, before.paneLayouts);
    assert.equal(subject.calls.saves, 0);
    subject.get().resizePanes('local', first.root.id, [0.3, 0.7], true, 'missing');
    assert.equal(subject.get().paneLayouts, before.paneLayouts);
    assert.equal(subject.calls.saves, 0);
    subject.get().resizePanes('local', first.root.id, [0.3, 0.7], true, 'second');
    assert.equal(subject.get().paneLayouts.local.first, first);
    assert.deepEqual([...subject.get().paneLayouts.local.second.root.sizes], [0.3, 0.7]);
    assert.equal(subject.calls.saves, 1);
});

test('closing a docked shell pane releases its allocation without terminating its existing session', () => {
    for (const grouped of [false, true]) {
        const dock = leaf('dock-shell');
        const subject = harness(
            { center: group(leaf('center')), ...(grouped && { source: group(dock, files) }) },
            [dock],
            { extraTerms: grouped ? [] : ['dock-shell'] },
        );
        subject.get().focusWorkspaceContent('local', key(dock));
        const before = subject.get();
        assert.equal(before.closePaneInSplit('local', { contentId: key(dock) }), true);
        const next = subject.get();
        assert.equal(next.workspaceDocking.local?.placements[key(dock)], undefined);
        assert.equal(next.workspaceDockFocus.local, null);
        assert.equal(next.terminals.local.length, before.terminals.local.length);
        assert.ok(next.terminals.local.some((tab) => tab.id === 'dock-shell' && tab.tabVisible));
        assert.equal(next.activePaneGroupOwner.local, 'center');
        assert.equal(next.activeTerminalIds.local, 'center');
        assert.equal(next.paneLayouts.local.center, before.paneLayouts.local.center);
        assert.ok(
            subject.manager().layer.surfaces.find((surface) => surface.key === key(dock))
                ?.visible === false,
        );
        assert.deepEqual(subject.calls.resources, []);
        assert.equal(subject.calls.saves, 1);
    }
});

test('a non-selected dock close preserves the remembered center shell and unrelated allocation', () => {
    const dockA = leaf('dock-a');
    const dockB = leaf('dock-b');
    const subject = harness({ center: group(leaf('center')), source: group(files, dockA, dockB) }, [
        files,
    ]);
    const before = subject.get();
    assert.equal(before.closePaneInSplit('local', { contentId: key(files) }), true);
    assert.equal(subject.get().activeTerminalIds.local, 'center');
    assert.equal(subject.get().activePaneGroupOwner.local, 'center');
    assert.equal(subject.get().paneLayouts.local.center, before.paneLayouts.local.center);
    assert.deepEqual(subject.calls.resources, []);
});

test('a docked shell release requires writable allocation state and stale exact close targets remain inert', () => {
    for (const gate of [
        { sessionPersistenceBlocked: true },
        { isRestoring: true },
        { sessionLoaded: false },
    ]) {
        const dock = leaf('dock');
        const subject = harness({ center: group(leaf('center')) }, [dock], {
            extraTerms: ['dock'],
        });
        subject.set(gate);
        const before = subject.get();
        assert.equal(before.closePaneInSplit('local', { contentId: key(dock) }), false);
        noWork(subject, before);
    }
    const subject = harness({ center: group(files) });
    const before = subject.get();
    assert.equal(before.closePaneInSplit('local', { contentId: key(plugin) }), false);
    noWork(subject, before);
});

test('the feature split adapter duplicates the addressed dock instance even when another leaf owns canonical focus', () => {
    const center = leaf('center');
    const sibling = leaf('sibling');
    const subject = harness({ center: group(center), source: group(sibling, files) }, [files]);
    const before = subject.get();
    assert.equal(before.splitFeaturePane('local', 'files', 'vertical', 'files-one'), 'opened');
    const next = subject.get();
    const duplicate = layout
        .collectLeaves(next.paneLayouts.local.source.root)
        .find((pane) => ![files.id, sibling.id].includes(pane.id));
    assert.equal(next.workspaceDocking.local.placements[key(duplicate)], 'bottom-panel');
    assert.equal(next.workspaceDockFocus.local, key(duplicate));
    assert.equal(next.activePaneGroupOwner, before.activePaneGroupOwner);
    assert.equal(next.activeTerminalIds, before.activeTerminalIds);
    assert.equal(next.paneLayouts.local.source.activePaneId, sibling.id);
    assert.deepEqual(subject.calls.copies, [['local', 'files-one', duplicate.content.instanceId]]);
    assert.equal(subject.calls.saves, 1);
    assert.deepEqual(subject.calls.resources, []);
});

test('self drops duplicate each content kind into its existing dock without replacing the selected center', () => {
    for (const pane of [leaf('dock'), files, plugin]) {
        const center = leaf('center');
        const subject = harness({ center: group(center), source: group(pane) }, [pane]);
        const before = subject.get();
        assert.equal(
            before.dockInSplit('local', layout.paneDockPayload(pane), 'right', {
                contentId: key(pane),
            }),
            'opened',
        );
        const next = subject.get();
        const leaves = layout.collectLeaves(next.paneLayouts.local.source.root);
        const duplicate = leaves.find((item) => key(item) !== key(pane));
        assert.equal(leaves.length, 2);
        assert.equal(
            leaves.find((item) => item.id === pane.id),
            pane,
        );
        assert.equal(next.workspaceDocking.local.placements[key(duplicate)], 'bottom-panel');
        assert.equal(next.workspaceDockFocus.local, key(duplicate));
        assert.equal(next.activeTerminalIds, before.activeTerminalIds);
        assert.equal(next.activePaneGroupOwner.local, before.activePaneGroupOwner.local);
        assert.equal(next.paneLayouts.local.center, before.paneLayouts.local.center);
        assert.equal(subject.calls.saves, 1);
        assert.deepEqual(subject.calls.resources, []);
        assert.equal(subject.calls.copies.length, pane === files ? 1 : 0);
    }
});

test('edge drops move existing content into and out of a persistent region without cloning resources', () => {
    for (const pane of [leaf('shell'), files, plugin]) {
        const center = leaf('center');
        const dock = leaf('dock');
        const subject = harness({ center: group(center, pane), target: group(dock) }, [dock]);
        const before = subject.get();
        assert.equal(
            before.dockInSplit('local', layout.paneDockPayload(pane), 'right', {
                contentId: key(dock),
            }),
            'moved',
        );
        let next = subject.get();
        assert.equal(next.workspaceDocking.local.placements[key(pane)], 'bottom-panel');
        assert.equal(next.workspaceDockFocus.local, key(pane));
        assert.equal(next.activeTerminalIds, before.activeTerminalIds);
        const current = layout
            .collectLeaves(next.paneLayouts.local.target.root)
            .find((item) => key(item) === key(pane));
        assert.equal(current.content, pane.content);
        assert.equal(current.id, pane.id);
        assert.equal(
            next.dockInSplit('local', layout.paneDockPayload(current), 'left', {
                contentId: key(center),
            }),
            'moved',
        );
        next = subject.get();
        assert.equal(next.workspaceDocking.local.placements[key(pane)], undefined);
        assert.equal(next.workspaceDocking.local.placements[key(dock)], 'bottom-panel');
        assert.equal(next.workspaceDockFocus.local, null);
        const combined = Object.values(next.paneLayouts.local).flatMap((item) =>
            layout.collectLeaves(item.root),
        );
        assert.equal(combined.filter((item) => key(item) === key(pane)).length, 1);
        assert.equal(combined.find((item) => key(item) === key(pane)).content, pane.content);
        assert.equal(next.terminals.local.length, before.terminals.local.length);
        assert.deepEqual(subject.calls.resources, []);
        assert.deepEqual(subject.calls.copies, []);
        assert.equal(subject.calls.saves, 2);
    }
});

test('drop targeting disambiguates local pane IDs and preserves modern resource identity when their containers collide', () => {
    const first = leaf('shared', files.content);
    const second = leaf('shared', plugin.content);
    const subject = harness({ first: group(first), second: group(second) });
    const before = subject.get();
    assert.equal(
        before.dockInSplit('local', layout.paneDockPayload(first), 'right', 'shared'),
        'no-target',
    );
    noWork(subject, before);
    assert.equal(
        before.dockInSplit('local', layout.paneDockPayload(first), 'right', {
            contentId: key(second),
        }),
        'moved',
    );
    const next = subject.get();
    assert.equal(next.paneLayouts.local.first, undefined);
    const leaves = layout.collectLeaves(next.paneLayouts.local.second.root);
    assert.equal(new Set(leaves.map((item) => item.id)).size, 2);
    assert.equal(leaves.find((item) => key(item) === key(first)).content, first.content);
    assert.equal(
        leaves.find((item) => key(item) === key(second)),
        second,
    );
    assert.deepEqual(subject.calls.resources, []);
    assert.deepEqual(subject.calls.copies, []);
    assert.equal(subject.calls.saves, 1);
});

test('stale, mismatched and ambiguous drag sources never create replacement content', () => {
    const other = leaf('other-plugin', { ...plugin.content, instanceId: 'plugin-two' });
    for (const payload of [
        { ...files.content, sourcePaneId: 'stale' },
        { ...files.content, sourcePaneId: plugin.id },
        { kind: 'plugin', pluginId: plugin.content.pluginId },
    ]) {
        const subject = harness({ main: group(files, plugin), other: group(other) });
        const before = subject.get();
        assert.equal(
            before.dockInSplit('local', payload, 'right', { contentId: key(files) }),
            'no-target',
        );
        noWork(subject, before);
    }
    const legacy = leaf('shared', { kind: 'feature', featureId: 'files' });
    const target = leaf('shared');
    const subject = harness({ legacy: group(legacy), target: group(target) });
    const before = subject.get();
    assert.equal(
        before.dockInSplit('local', layout.paneDockPayload(legacy), 'right', {
            contentId: key(target),
        }),
        'no-target',
    );
    noWork(subject, before);
});

test('region drops enforce cross-canvas reservations, registration policy and session write gates before work', () => {
    for (const gate of [
        { sessionLoaded: false },
        { isRestoring: true },
        { sessionPersistenceBlocked: true },
    ]) {
        for (const payload of [
            layout.paneDockPayload(files),
            layout.paneDockPayload(leaf('dock')),
        ]) {
            const subject = harness({ main: group(files), target: group(leaf('dock')) }, [
                leaf('dock'),
            ]);
            subject.set(gate);
            const before = subject.get();
            assert.equal(
                before.dockInSplit('local', payload, 'right', { contentId: key(leaf('dock')) }),
                'no-target',
            );
            noWork(subject, before);
        }
    }
    const full = ['a', 'b', 'c'].map((id) => leaf(id));
    const subject = harness(
        { main: group(files), target: group(leaf('dock')), full: group(...full) },
        [leaf('dock')],
    );
    const before = subject.get();
    assert.equal(
        before.dockInSplit('local', layout.paneDockPayload(files), 'right', {
            contentId: key(leaf('dock')),
        }),
        'refused-cap',
    );
    noWork(subject, before);
    const missing = harness({ main: group(plugin), target: group(leaf('dock')) }, [leaf('dock')]);
    missing.set({ workspaceViewRegistry: registrations.buildWorkspaceViewRegistrations([]) });
    const snapshot = missing.get();
    assert.equal(
        snapshot.dockInSplit('local', layout.paneDockPayload(plugin), 'right', {
            contentId: key(leaf('dock')),
        }),
        'no-target',
    );
    noWork(missing, snapshot);
});

test('promoting a moved pane source cannot overwrite an unrelated canvas owner', () => {
    const survivor = leaf('survivor', {
        kind: 'feature',
        featureId: 'dashboard',
        instanceId: 'survivor',
    });
    const center = leaf('center');
    const existing = group(plugin);
    const subject = harness({
        source: group(files, survivor),
        survivor: existing,
        target: group(center),
    });
    assert.equal(
        subject.get().dockInSplit('local', layout.paneDockPayload(files), 'right', {
            contentId: key(center),
        }),
        'moved',
    );
    assert.equal(subject.get().paneLayouts.local.survivor, existing);
    assert.equal(subject.get().paneLayouts.local.source.root, survivor);
    assert.deepEqual(subject.calls.resources, []);
});

test('real feature and plugin menu splits use exact content targets and preserve docked-center selection', () => {
    for (const docked of [false, true]) {
        const center = leaf('center');
        const subject = harness(
            { center: group(center), source: group(files) },
            docked ? [files] : [],
        );
        const props = subject.tabBar({
            activeView: 'files',
            activeFeatureTabId: 'files-one',
            featureTabs: [{ id: 'files-one', featureId: 'files', instanceId: 'files-one' }],
        });
        const before = subject.get();
        props.onOpenSplitFeature('files', 'bottom');
        const next = subject.get();
        assert.equal(layout.collectLeaves(next.paneLayouts.local.source.root).length, 2);
        assert.equal(next.paneLayouts.local.center, before.paneLayouts.local.center);
        assert.equal(
            next.paneLayouts.local.workspace,
            undefined,
            'a live feature must not seed an overlay canvas',
        );
        assert.equal(subject.calls.copies.length, 1);
        assert.deepEqual(subject.calls.resources, []);
        assert.deepEqual(subject.calls.views, docked ? [] : [['main', 'terminal']]);
    }
    const second = leaf(plugin.id, { ...plugin.content, instanceId: 'plugin-two' });
    const subject = harness({ first: group(plugin), second: group(second) }, [second]);
    const before = subject.get();
    subject.tabBar().onOpenSplitPlugin(plugin.content.pluginId, 'right', key(second));
    assert.equal(subject.get().paneLayouts.local.first, before.paneLayouts.local.first);
    assert.equal(layout.collectLeaves(subject.get().paneLayouts.local.second.root).length, 2);
    assert.deepEqual(subject.calls.views, []);
    assert.deepEqual(subject.calls.resources, []);
});

test('pointer hit testing and drag-session updates preserve the exact content target independently of local leaf ID', () => {
    class Element {
        constructor(contentId, left) {
            this.dataset = { paneId: 'shared', paneContentId: contentId };
            this.left = left;
        }
        closest() {
            return false;
        }
        getBoundingClientRect() {
            return { left: this.left, top: 0, width: 100, height: 100 };
        }
    }
    const hit = source(
        'components/layout/tabDock/hit.ts',
        {
            '../../../lib/paneLayout': layout,
            '../../../lib/paneLayout/regions': pure('lib/paneLayout/regions.ts'),
        },
        {
            HTMLElement: Element,
            getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
        },
    );
    const boxes = [new Element(key(files), 0), new Element(key(plugin), 100)];
    const surface = {
        querySelectorAll: (selector) => (selector === '[data-pane-id]' ? boxes : []),
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
    };
    assert.equal(hit.dockTargetFromPointer(1, 50, surface).contentId, key(files));
    assert.equal(hit.dockTargetFromPointer(101, 50, surface).contentId, key(plugin));
    const session = source('components/layout/tabDock/session.ts', {});
    let notifications = 0;
    const unsubscribe = session.subscribeTabDock(() => {
        notifications++;
    });
    session.startTabDock(layout.paneDockPayload(files));
    const target = hit.dockTargetFromPointer(1, 50, surface);
    session.patchTabDockTarget(target);
    session.patchTabDockTarget({ ...target, contentId: key(plugin) });
    assert.equal(session.getTabDockLive().target.contentId, key(plugin));
    assert.equal(notifications, 3);
    session.patchTabDockTarget({ ...target, contentId: key(plugin) });
    assert.equal(notifications, 3);
    unsubscribe();
    session.stopTabDock();
});
