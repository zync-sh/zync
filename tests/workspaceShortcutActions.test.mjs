import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import ts from 'typescript';

// Compile source in memory: no native app imports or shared emitted test artifacts.
function evaluate(path, require, globals = {}) {
    const { outputText } = ts.transpileModule(
        readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8'),
        {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        },
    );
    const context = {
        exports: {},
        require,
        crypto: webcrypto,
        navigator: { platform: 'Win32' },
        ...globals,
    };
    runInNewContext(outputText, context);
    return context.exports;
}
const pureModules = new Map();
function pure(path) {
    if (pureModules.has(path)) {
        return pureModules.get(path);
    }
    const exported = {};
    pureModules.set(path, exported);
    Object.assign(
        exported,
        evaluate(path, (name) => {
            assert.ok(name.startsWith('.'), `Pure source cannot load ${name}`);
            const base = posix
                .normalize(posix.join(posix.dirname(path), name))
                .replace(/\.js$/, '');
            return pure(
                existsSync(new URL(`../src/${base}.ts`, import.meta.url))
                    ? `${base}.ts`
                    : `${base}/index.ts`,
            );
        }),
    );
    return exported;
}
function source(path, dependencies, globals) {
    return evaluate(
        path,
        (name) => {
            assert.ok(Object.hasOwn(dependencies, name), `Unexpected source dependency: ${name}`);
            return dependencies[name];
        },
        globals,
    );
}
const layout = pure('lib/paneLayout/index.ts');
const visibility = pure('features/workspace/domain/visibleContent.ts');
const registrations = pure('features/workspace/application/viewRegistrationAdapters.ts');
const route = pure('features/shortcuts/route.ts');
const catalog = pure('features/shortcuts/catalog.ts');
const pluginShortcuts = pure('features/shortcuts/pluginShortcuts.ts');
const key = (pane) => layout.paneContentKey(pane.content, pane.id);
const leaf = (id, content) => ({ type: 'pane', id, content });
const shell = leaf('shell-pane', { kind: 'term', termId: 'shell' });
const files = leaf('files-pane', { kind: 'feature', featureId: 'files', instanceId: 'files-one' });
const plugin = leaf('plugin-pane', {
    kind: 'plugin',
    pluginId: 'owner:panel',
    instanceId: 'plugin-one',
});
const dashboard = leaf('dashboard-pane', {
    kind: 'feature',
    featureId: 'dashboard',
    instanceId: 'dashboard-one',
});
const single = (pane) => ({ version: 1, root: pane, activePaneId: pane.id });
const splitNode = (first, second) => ({
    type: 'split',
    id: `split-${first.id}`,
    direction: 'horizontal',
    sizes: [0.5, 0.5],
    children: [first, second],
});
const split = (first, second, activePaneId = first.id) => ({
    version: 1,
    root: splitNode(first, second),
    activePaneId,
});
const event = (key = 'ArrowRight', target = 'app') => ({
    key,
    target,
    type: 'keydown',
    ctrlKey: true,
    shiftKey: true,
    altKey: false,
    metaKey: false,
    isComposing: false,
    repeat: false,
    defaultPrevented: false,
    stopPropagation: () => {},
    getModifierState: () => false,
});

function harness(
    paneGroups = {},
    view = 'terminal',
    { multiple = true, activeOwner = null, terminal = true, platformGlobals = {} } = {},
) {
    let state;
    const calls = { saves: 0, warnings: [], views: [], copies: [], resources: [] };
    const slice = source(
        'store/terminalSlice.ts',
        {
            '../features/usage': { track: () => {} },
            '../lib/terminal': {
                terminalService: { destroy: (...args) => calls.resources.push(args) },
            },
            './sessionSlice': {
                scheduleSaveSession: () => {
                    calls.saves++;
                },
            },
            '../lib/paneCloseBlockers': {
                isPaneCloseBlocked: () => false,
                isPaneLayoutCloseBlocked: () => false,
                paneCloseScope: () => ({}),
            },
            '../lib/paneLayout': layout,
            '../lib/paneLayout/groups': layout,
            '../features/workspace/application/viewRegistrationAdapters': registrations,
            '../features/workspace/application/contentLifecycle': {
                disposeWorkspaceContent: () => {},
            },
            '../features/workspace/domain/dockingTopology': pure(
                'features/workspace/domain/dockingTopology.ts',
            ),
            '../features/workspace/domain/canvases': pure('features/workspace/domain/canvases.ts'),
            '../features/workspace/domain/docking': pure('features/workspace/domain/docking.ts'),
            '../features/workspace/domain/paneTabRelease': pure(
                'features/workspace/domain/paneTabRelease.ts',
            ),
            '../features/workspace/domain/contentPresentation': pure(
                'features/workspace/domain/contentPresentation.ts',
            ),
        },
        { window: { ipcRenderer: { send: (...args) => calls.resources.push(args) } } },
    );
    const set = (patch) => {
        state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
    };
    const dockingSlice = source('store/workspaceDockingSlice.ts', {
        '../features/workspace/domain/dockingView': pure(
            'features/workspace/domain/dockingView.ts',
        ),
        '../features/workspace/application/regionDrop': pure(
            'features/workspace/application/regionDrop.ts',
        ),
        '../lib/paneLayout': layout,
        '../lib/paneLayout/regions': pure('lib/paneLayout/regions.ts'),
        '../features/workspace/domain/canvases': pure('features/workspace/domain/canvases.ts'),
        '../features/workspace/domain/docking': pure('features/workspace/domain/docking.ts'),
        '../features/workspace/domain/contentPresentation': pure(
            'features/workspace/domain/contentPresentation.ts',
        ),
        '../features/workspace/domain/visibleContent': visibility,
        '../features/workspace/application/viewRegistrationAdapters': registrations,
        './sessionSlice': {
            scheduleSaveSession: () => {
                calls.saves++;
            },
        },
    });
    state = {
        ...source('store/uiSlice.ts', {}).createUiSlice(set, () => state),
        ...slice.createTerminalSlice(set, () => state),
        ...dockingSlice.createWorkspaceDockingSlice(set, () => state),
        sessionLoaded: true,
        isRestoring: false,
        sessionPersistenceBlocked: false,
        settingsLoadGeneration: 0,
        saveSession: async () => {
            calls.saves++;
        },
        tabs: [{ id: 'main', type: 'connection', connectionId: 'local', title: 'Local', view }],
        activeTabId: 'main',
        activeConnectionId: 'local',
        showWelcomeScreen: false,
        terminals: {
            local: terminal
                ? [
                      {
                          id: 'shell',
                          title: 'Shell 1',
                          lastKnownCwd: '/project',
                          shellOverride: 'bash',
                      },
                  ]
                : [],
        },
        paneLayouts: { local: paneGroups },
        activePaneGroupOwner: { local: activeOwner },
        activeTerminalIds: { local: terminal ? 'shell' : null },
        contentPresentation: {},
        settings: {},
        workspaceViewRegistry: registrations.buildWorkspaceViewRegistrations([
            { id: 'owner:panel', pluginId: 'owner', title: 'Plugin', allowMultiple: multiple },
        ]),
        showToast: (...args) => calls.warnings.push(args),
        copyFilesListing: (...args) => calls.copies.push(args),
        setTabView: (id, next) => {
            calls.views.push([id, next]);
            set({ tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, view: next } : tab)) });
        },
    };
    const actions = source(
        'features/shortcuts/actions.ts',
        {
            '../../components/editor/overlayState': { isEditorOverlayOpen: () => false },
            '../../lib/paneLayout': layout,
            '../workspace/domain/visibleContent': visibility,
            '../workspace/domain/navigation': pure('features/workspace/domain/navigation.ts'),
            '../workspace/application/globalNavigation': pure(
                'features/workspace/application/globalNavigation.ts',
            ),
            '../workspace/application/hostWorkspaceSelection': pure(
                'features/workspace/application/hostWorkspaceSelection.ts',
            ),
            '../workspace/application/sidebarPresentation': pure(
                'features/workspace/application/sidebarPresentation.ts',
            ),
            '../workspace/domain/dockingView': pure('features/workspace/domain/dockingView.ts'),
            '../workspace/domain/canvases': pure('features/workspace/domain/canvases.ts'),
            '../workspace/domain/dockingNavigation': pure(
                'features/workspace/domain/dockingNavigation.ts',
            ),
            '../../store/useAppStore': { useAppStore: { getState: () => state } },
            './focus': { keyboardFocus: (target) => target },
            './catalog': catalog,
            './workspacePresentation': pure('features/shortcuts/workspacePresentation.ts'),
            '../../lib/terminal/terminalInteraction': {},
            '../../components/settings/constants/defaults': {},
        },
        platformGlobals,
    );
    return {
        get: () => state,
        set,
        calls,
        navigate: actions.runGlobalNavigation,
        run: (id, input = event()) => actions.runShortcutCommand(id, input),
    };
}

test('global navigation shortcuts reuse selection/manager actions without opening host sessions', () => {
    const events = [];
    const subject = harness({}, 'terminal', {
        platformGlobals: {
            window: { dispatchEvent: (event) => events.push(event.type) },
            CustomEvent: class {
                constructor(type) {
                    this.type = type;
                }
            },
        },
    });
    const sections = [],
        managers = [],
        selections = [];
    const selectSection = subject.get().setGlobalSidebarSection;
    subject.set({
        setGlobalSidebarSection: (section) => {
            sections.push(section);
            selectSection(section);
        },
        updateSettings: async () => {},
        activateTab: (id) => selections.push(id),
        openPublicUrlsTab: () => managers.push('public-urls'),
        openPortForwardingTab: () => managers.push('tunnels'),
        openSnippetsTab: () => managers.push('snippets'),
        openSettings: (section) => managers.push(section),
    });
    for (const [id, section] of [
        ['navigationHosts', 'hosts'],
        ['navigationVaults', 'vaults'],
    ]) {
        assert.equal(subject.run(id), true);
        assert.equal(sections.at(-1), section);
    }
    for (const [id, manager] of [
        ['navigationPublicUrls', 'public-urls'],
        ['navigationTunnels', 'tunnels'],
        ['navigationSnippets', 'snippets'],
    ]) {
        assert.equal(subject.run(id), true);
        assert.equal(managers.at(-1), manager);
        assert.equal(sections.at(-1), null);
    }
    assert.equal(subject.run('navigationPlugins'), true);
    assert.equal(sections.at(-1), 'plugins');
    assert.equal(managers.includes('plugins'), false);
    assert.equal(subject.run('navigationWorkspace'), true);
    assert.deepEqual(selections, ['main']);
    subject.set({ tabs: [{ id: 'global-snippets', type: 'connection', connectionId: 'global' }] });
    assert.equal(subject.run('navigationWorkspace'), false);
    assert.deepEqual(selections, ['main']);
    assert.equal(subject.run('navigationProfile'), true);
    assert.deepEqual(events, ['zync:open-profile-menu']);
    assert.deepEqual(subject.calls.resources, []);
});

const sidebarCommands = [
    ['hosts', 'navigationHosts'],
    ['vaults', 'navigationVaults'],
    ['plugins', 'navigationPlugins'],
    ['workspace', 'navigationWorkspace'],
];

for (const [section, command] of sidebarCommands) {
    test(`${section} shares click/shortcut toggling without changing host state or width`, () => {
        const preferences = pure(
            'features/workspace/domain/navigation.ts',
        ).DEFAULT_WORKSPACE_NAVIGATION;
        const present = pure(
            'features/workspace/application/sidebarPresentation.ts',
        ).sidebarPresentation;
        for (const position of ['default', 'left', 'right']) {
            if (section === 'workspace' && position === 'default') {
                continue;
            }
            for (const visible of [false, true]) {
                for (const collapsed of [false, true]) {
                    const subject = harness();
                    const updates = [];
                    subject.set({
                        settings: {
                            sidebarWidth: 341,
                            sidebarCollapsed: collapsed,
                            workspaceNavigation: {
                                ...preferences,
                                visible,
                                workspaceTabsPosition: position,
                            },
                        },
                        globalSidebarSection: section === 'workspace' && collapsed ? null : section,
                        updateSettings: async (patch) => {
                            updates.push(patch);
                            subject.set({ settings: { ...subject.get().settings, ...patch } });
                        },
                        activateTab: (id) =>
                            assert.equal(
                                id,
                                subject.get().activeTabId,
                                'workspace reuses the existing tab',
                            ),
                    });
                    const before = subject.get();
                    const isCollapsed = () =>
                        present(
                            subject.get().settings.workspaceNavigation,
                            subject.get().globalSidebarSection,
                            subject.get().settings.sidebarCollapsed,
                        ).collapsed;
                    assert.equal(subject.navigate(section), true);
                    assert.equal(isCollapsed(), !collapsed);
                    assert.equal(subject.run(command), true);
                    assert.equal(isCollapsed(), collapsed);
                    assert.equal(subject.navigate(section), true);
                    assert.equal(isCollapsed(), !collapsed);
                    assert.deepEqual(JSON.parse(JSON.stringify(updates)), [
                        { sidebarCollapsed: !collapsed },
                        { sidebarCollapsed: collapsed },
                        { sidebarCollapsed: !collapsed },
                    ]);
                    assert.equal(
                        subject.get().globalSidebarSection,
                        section === 'workspace' && !collapsed ? null : section,
                    );
                    assert.equal(subject.get().settings.sidebarWidth, 341);
                    for (const field of [
                        'tabs',
                        'terminals',
                        'paneLayouts',
                        'contentPresentation',
                        'activeTabId',
                        'activeConnectionId',
                    ]) {
                        assert.equal(subject.get()[field], before[field], field);
                    }
                    assert.equal(subject.calls.saves, 0);
                    assert.deepEqual(subject.calls.resources, []);
                }
            }
        }
    });
}

test('Hosts activation opens from other sections and follows resolved workspace visibility', () => {
    const preferences = pure(
        'features/workspace/domain/navigation.ts',
    ).DEFAULT_WORKSPACE_NAVIGATION;
    for (const section of ['vaults', 'plugins', 'workspace', null]) {
        for (const position of ['default', 'left', 'right']) {
            const subject = harness();
            const updates = [];
            subject.set({
                settings: {
                    sidebarCollapsed: false,
                    workspaceNavigation: {
                        ...preferences,
                        visible: true,
                        workspaceTabsPosition: position,
                    },
                },
                globalSidebarSection: section,
                updateSettings: async (patch) => {
                    updates.push(patch);
                    subject.set({ settings: { ...subject.get().settings, ...patch } });
                },
            });
            assert.equal(subject.navigate('hosts'), true);
            // An undocked workspace selection is already presenting Hosts.
            const closes = section === 'workspace' && position === 'default';
            assert.deepEqual(JSON.parse(JSON.stringify(updates)), [{ sidebarCollapsed: closes }]);
            assert.equal(subject.get().globalSidebarSection, 'hosts');
            assert.deepEqual(subject.calls.resources, []);
        }
    }
});

test('sidebar toggles report refused visibility saves through the existing error path', async () => {
    for (const [section] of sidebarCommands) {
        const subject = harness();
        const before = subject.get();
        const preferences = pure(
            'features/workspace/domain/navigation.ts',
        ).DEFAULT_WORKSPACE_NAVIGATION;
        subject.set({
            globalSidebarSection: section,
            settings: {
                sidebarCollapsed: false,
                workspaceNavigation: {
                    ...preferences,
                    visible: true,
                    workspaceTabsPosition: 'left',
                },
            },
            updateSettings: async () => {
                throw Error('Refused save');
            },
            activateTab: () => {},
        });
        assert.equal(subject.navigate(section), true);
        await Promise.resolve();
        assert.equal(subject.calls.warnings.length, 1);
        assert.equal(subject.calls.warnings[0][0], 'error');
        assert.equal(subject.get().settings.sidebarCollapsed, false);
        assert.equal(subject.get().tabs, before.tabs);
        assert.deepEqual(subject.calls.resources, []);
    }
});

for (const [section, command] of [
    ['vaults', 'navigationVaults'],
    ['plugins', 'navigationPlugins'],
]) {
    test(`${section} shortcut presents its destination with the activity bar disabled`, () => {
        const subject = harness();
        const preferences = pure(
            'features/workspace/domain/navigation.ts',
        ).DEFAULT_WORKSPACE_NAVIGATION;
        const present = pure(
            'features/workspace/application/sidebarPresentation.ts',
        ).sidebarPresentation;
        subject.set({
            settings: {
                sidebarCollapsed: true,
                workspaceNavigation: { ...preferences, visible: false },
            },
            globalSidebarSection: 'hosts',
            updateSettings: async (patch) =>
                subject.set({ settings: { ...subject.get().settings, ...patch } }),
        });
        const before = subject.get();
        assert.equal(subject.run(command), true);
        const shown = present(
            subject.get().settings.workspaceNavigation,
            subject.get().globalSidebarSection,
            subject.get().settings.sidebarCollapsed,
        );
        assert.equal(shown.collapsed, false);
        assert.equal(subject.get().tabs, before.tabs);
        assert.deepEqual(subject.calls.resources, []);
        assert.equal(shown.section, section);
    });
}

test('refused docked-workspace collapse preserves the actual visible section, not only the saved flag', async () => {
    const subject = harness();
    const preferences = pure(
        'features/workspace/domain/navigation.ts',
    ).DEFAULT_WORKSPACE_NAVIGATION;
    const present = pure(
        'features/workspace/application/sidebarPresentation.ts',
    ).sidebarPresentation;
    subject.set({
        settings: {
            sidebarCollapsed: false,
            workspaceNavigation: { ...preferences, visible: true, workspaceTabsPosition: 'left' },
        },
        globalSidebarSection: 'workspace',
        updateSettings: async () => {
            throw Error('Refused save');
        },
        activateTab: () => {},
    });
    const shown = () =>
        present(
            subject.get().settings.workspaceNavigation,
            subject.get().globalSidebarSection,
            subject.get().settings.sidebarCollapsed,
        );
    const before = shown();
    assert.equal(subject.navigate('workspace'), true);
    await Promise.resolve();
    assert.equal(subject.calls.warnings.length, 1);
    assert.equal(subject.get().settings.sidebarCollapsed, false);
    assert.deepEqual(subject.calls.resources, []);
    assert.deepEqual(shown(), before);
});

test('switching sidebar destinations opens the requested section instead of closing the whole panel', () => {
    const preferences = pure(
        'features/workspace/domain/navigation.ts',
    ).DEFAULT_WORKSPACE_NAVIGATION;
    const present = pure(
        'features/workspace/application/sidebarPresentation.ts',
    ).sidebarPresentation;
    for (const [destination, command] of sidebarCommands) {
        for (const selected of [...sidebarCommands.map(([section]) => section), null]) {
            if (selected === destination) {
                continue;
            }
            for (const collapsed of [false, true]) {
                const subject = harness();
                const updates = [];
                subject.set({
                    settings: {
                        sidebarCollapsed: collapsed,
                        workspaceNavigation: {
                            ...preferences,
                            visible: true,
                            workspaceTabsPosition: 'right',
                        },
                    },
                    globalSidebarSection: selected,
                    updateSettings: async (patch) => {
                        updates.push(patch);
                        subject.set({ settings: { ...subject.get().settings, ...patch } });
                    },
                    activateTab: () => {},
                });
                const before = subject.get();
                assert.equal(subject.run(command), true);
                assert.equal(subject.get().globalSidebarSection, destination);
                assert.equal(
                    present(
                        subject.get().settings.workspaceNavigation,
                        destination,
                        subject.get().settings.sidebarCollapsed,
                    ).collapsed,
                    false,
                );
                assert.deepEqual(JSON.parse(JSON.stringify(updates)), [
                    { sidebarCollapsed: false },
                ]);
                assert.equal(subject.get().tabs, before.tabs);
                assert.deepEqual(subject.calls.resources, []);
            }
        }
    }
});

test('full-tab destinations and undocked workspace never acquire sidebar toggle writes', () => {
    const preferences = pure(
        'features/workspace/domain/navigation.ts',
    ).DEFAULT_WORKSPACE_NAVIGATION;
    for (const destination of ['public-urls', 'tunnels', 'snippets', 'workspace']) {
        const subject = harness();
        const selections = [];
        const managers = [];
        subject.set({
            settings: {
                sidebarCollapsed: false,
                workspaceNavigation: { ...preferences, visible: true },
            },
            globalSidebarSection: 'hosts',
            updateSettings: () =>
                assert.fail('Full-tab navigation must not save sidebar visibility'),
            activateTab: (id) => selections.push(id),
            openPublicUrlsTab: () => managers.push('public-urls'),
            openPortForwardingTab: () => managers.push('tunnels'),
            openSnippetsTab: () => managers.push('snippets'),
        });
        assert.equal(subject.navigate(destination), true);
        assert.equal(subject.navigate(destination), true);
        assert.equal(subject.get().globalSidebarSection, null);
        assert.deepEqual(selections, destination === 'workspace' ? ['main', 'main'] : []);
        assert.deepEqual(managers, destination === 'workspace' ? [] : [destination, destination]);
        assert.deepEqual(subject.calls.resources, []);
    }
});

test('Plugins click adapter and shortcut select the sidebar without opening Settings or changing host state', () => {
    for (const section of ['hosts', 'vaults', null]) {
        const subject = harness();
        const updates = [];
        const preferences = pure(
            'features/workspace/domain/navigation.ts',
        ).DEFAULT_WORKSPACE_NAVIGATION;
        subject.set({
            settings: {
                sidebarCollapsed: false,
                workspaceNavigation: { ...preferences, visible: true },
            },
            globalSidebarSection: section,
            updateSettings: async (patch) => {
                updates.push(patch);
                subject.set({ settings: { ...subject.get().settings, ...patch } });
            },
            openSettings: () => assert.fail('Plugins must not open Settings by default'),
        });
        const before = subject.get();
        assert.equal(subject.navigate('plugins'), true);
        assert.equal(subject.run('navigationPlugins'), true);
        assert.deepEqual(JSON.parse(JSON.stringify(updates)), [
            { sidebarCollapsed: false },
            { sidebarCollapsed: true },
        ]);
        assert.equal(subject.get().globalSidebarSection, 'plugins');
        for (const field of [
            'tabs',
            'terminals',
            'paneLayouts',
            'contentPresentation',
            'activeTabId',
            'activeConnectionId',
        ]) {
            assert.equal(subject.get()[field], before[field], field);
        }
        assert.equal(subject.calls.saves, 0);
        assert.deepEqual(subject.calls.resources, []);
    }
});

test('navigation bindings obey terminal policy, overrides and repeat ownership', () => {
    const commands = catalog.SHORTCUT_CATALOG.filter(
        (row) => row.navigationAction || row.id === 'navigationProfile',
    );
    const calls = [];
    const run = (id) => {
        calls.push(id);
        return true;
    };
    for (const [index, command] of commands.entries()) {
        const key = command.defaultKeys.split('+').at(-1);
        const input = { ...event(key), shiftKey: false, altKey: true };
        assert.equal(
            route.routeShortcut(input, 'xterm', 'shell', catalog.SHORTCUT_CATALOG, {}, run),
            false,
        );
        assert.equal(
            route.routeShortcut(input, 'field', 'app', catalog.SHORTCUT_CATALOG, {}, run),
            false,
        );
        assert.equal(
            route.routeShortcut(input, 'app', 'shell', catalog.SHORTCUT_CATALOG, {}, run),
            true,
        );
        assert.equal(calls.at(-1), command.id);
        const before = calls.length;
        assert.equal(
            route.routeShortcut(
                { ...input, repeat: true },
                'app',
                'shell',
                catalog.SHORTCUT_CATALOG,
                {},
                run,
            ),
            true,
        );
        assert.equal(calls.length, before);
        const overrides = { [command.settingsKey]: `Ctrl+Shift+F${index + 1}` };
        assert.equal(
            route.routeShortcut(input, 'app', 'shell', catalog.SHORTCUT_CATALOG, overrides, run),
            false,
        );
        assert.equal(
            route.routeShortcut(
                event(`F${index + 1}`),
                'app',
                'shell',
                catalog.SHORTCUT_CATALOG,
                overrides,
                run,
            ),
            true,
        );
        assert.equal(calls.at(-1), command.id);
    }
});

test('sidebar recovery shortcut restores Hosts when global managers temporarily hide the sidebar', () => {
    const subject = harness({}, 'terminal', {
        platformGlobals: {
            window: { dispatchEvent: () => {} },
            CustomEvent: class {
                constructor(type) {
                    this.type = type;
                }
            },
            setTimeout: () => 1,
            clearTimeout: () => {},
        },
    });
    const preferences = pure(
        'features/workspace/domain/navigation.ts',
    ).DEFAULT_WORKSPACE_NAVIGATION;
    const updates = [];
    subject.set({
        settings: {
            sidebarCollapsed: false,
            workspaceNavigation: { ...preferences, visible: true },
        },
        globalSidebarSection: null,
        updateSettings: async (patch) => {
            updates.push(patch);
            subject.set({ settings: { ...subject.get().settings, ...patch } });
        },
    });
    assert.equal(subject.run('toggleSidebar'), true);
    assert.equal(subject.get().globalSidebarSection, 'hosts');
    assert.deepEqual(JSON.parse(JSON.stringify(updates)), [{ sidebarCollapsed: false }]);
    assert.equal(subject.run('toggleSidebar'), true);
    assert.equal(subject.get().settings.sidebarCollapsed, true);
    assert.deepEqual(subject.calls.resources, []);
});

test('the sidebar shortcut restores docked workspace presentation after a refused visibility save', async () => {
    const subject = harness({}, 'terminal', {
        platformGlobals: {
            window: { dispatchEvent: () => {} },
            CustomEvent: class {
                constructor(type) {
                    this.type = type;
                }
            },
            setTimeout: () => 1,
            clearTimeout: () => {},
        },
    });
    const preferences = pure(
        'features/workspace/domain/navigation.ts',
    ).DEFAULT_WORKSPACE_NAVIGATION;
    const present = pure(
        'features/workspace/application/sidebarPresentation.ts',
    ).sidebarPresentation;
    subject.set({
        settings: {
            sidebarCollapsed: false,
            workspaceNavigation: { ...preferences, visible: true, workspaceTabsPosition: 'right' },
        },
        globalSidebarSection: 'workspace',
        updateSettings: async () => {
            throw Error('Refused save');
        },
    });
    assert.equal(subject.run('toggleSidebar'), true);
    await Promise.resolve();
    assert.deepEqual(
        JSON.parse(
            JSON.stringify(
                present(
                    subject.get().settings.workspaceNavigation,
                    subject.get().globalSidebarSection,
                    subject.get().settings.sidebarCollapsed,
                ),
            ),
        ),
        { section: 'workspace', position: 'right', collapsed: false },
    );
    assert.equal(subject.calls.warnings.length, 1);
    assert.deepEqual(subject.calls.resources, []);
});

test('primary and alternative sidebar shortcuts toggle Hosts with the rail and restore the selected section without it', () => {
    const subject = harness({}, 'terminal', {
        platformGlobals: {
            window: { dispatchEvent: () => {} },
            CustomEvent: class {},
            setTimeout: () => 1,
            clearTimeout: () => {},
        },
    });
    const preferences = pure(
        'features/workspace/domain/navigation.ts',
    ).DEFAULT_WORKSPACE_NAVIGATION;
    subject.set({
        settings: {
            sidebarCollapsed: false,
            workspaceNavigation: { ...preferences, visible: true },
        },
        globalSidebarSection: 'vaults',
        updateSettings: async (patch) =>
            subject.set({ settings: { ...subject.get().settings, ...patch } }),
    });
    subject.run('toggleSidebarAlternative');
    assert.equal(subject.get().globalSidebarSection, 'hosts');
    assert.equal(subject.get().settings.sidebarCollapsed, false);
    subject.run('toggleSidebar');
    assert.equal(subject.get().settings.sidebarCollapsed, true);
    subject.set({
        settings: {
            sidebarCollapsed: false,
            workspaceNavigation: { ...preferences, visible: false },
        },
    });
    subject.get().setGlobalSidebarSection('vaults');
    subject.run('toggleSidebarAlternative');
    assert.equal(subject.get().settings.sidebarCollapsed, true);
    subject.run('toggleSidebar');
    assert.equal(subject.get().settings.sidebarCollapsed, false);
    assert.equal(subject.get().globalSidebarSection, 'vaults');
    subject.get().setGlobalSidebarSection(null);
    subject.run('toggleSidebarAlternative');
    assert.equal(
        subject.get().globalSidebarSection,
        'vaults',
        'reopening restores the last non-empty selection',
    );
});

test('directional navigation cannot focus a hidden sibling while one pane is maximized', () => {
    const subject = harness({ main: split(shell, files) }, 'terminal', { activeOwner: 'main' });
    assert.equal(subject.get().maximizeWorkspacePane('local', key(shell)), true);
    const before = subject.get();
    assert.equal(subject.run('focusSplitPane', event('ArrowRight')), false);
    assert.equal(subject.get(), before);
    subject.get().restoreWorkspacePane('local');
    assert.equal(subject.run('focusSplitPane', event('ArrowRight')), true);
    assert.equal(subject.get().paneLayouts.local.main.activePaneId, files.id);
});
function hide(subject, ...panes) {
    subject.set({
        contentPresentation: {
            local: {
                version: 3,
                items: Object.fromEntries(panes.map((pane) => [key(pane), { hidden: true }])),
            },
        },
    });
}
function assertNoWork(subject, before) {
    assert.equal(subject.get(), before, 'refusal must not mutate state or selection');
    assert.equal(subject.calls.saves, 0);
    assert.deepEqual(subject.calls.views, []);
    assert.deepEqual(subject.calls.copies, []);
    assert.deepEqual(subject.calls.resources, []);
}

test('split command targets the selected built-in canvas rather than the remembered shell canvas', () => {
    const oldShell = single(shell);
    const subject = harness({ shell: oldShell, files: single(files) }, 'files', {
        activeOwner: 'shell',
    });
    assert.equal(subject.run('splitPanes'), true);
    assert.equal(subject.get().paneLayouts.local.shell, oldShell);
    const panes = layout.collectLeaves(subject.get().paneLayouts.local.files.root);
    assert.equal(panes.length, 2);
    assert.equal(panes[0], files);
    assert.equal(panes[1].content.featureId, 'files');
    assert.notEqual(panes[1].content.instanceId, files.content.instanceId);
    assert.deepEqual(subject.calls.copies[0].slice(0, 2), ['local', 'files-one']);
    assert.equal(subject.get().activePaneGroupOwner.local, 'files');
    assert.deepEqual(subject.calls.views, [['main', 'terminal']]);
    assert.equal(subject.get().terminals.local.length, 1);
});

test('same-panel plugin instances split only the selected owner without changing existing identities', () => {
    const other = leaf('other-plugin', { ...plugin.content, instanceId: 'plugin-two' });
    const oldOther = single(other);
    const subject = harness({ other: oldOther, selected: single(plugin) }, 'plugin:owner:panel', {
        activeOwner: 'selected',
        terminal: false,
    });
    assert.equal(subject.run('splitPanes', event('ArrowUp')), true);
    assert.equal(subject.get().paneLayouts.local.other, oldOther);
    const current = subject.get().paneLayouts.local.selected;
    assert.equal(current.root.direction, 'vertical');
    const panes = layout.collectLeaves(current.root);
    assert.equal(panes[0], plugin);
    assert.notEqual(panes[1].content.instanceId, plugin.content.instanceId);
    assert.equal(subject.get().terminals.local.length, 0);
});

test('refused singleton split leaves the selected view and every resource unchanged', () => {
    const subject = harness(
        { shell: single(shell), selected: single(plugin) },
        'plugin:owner:panel',
        { activeOwner: 'shell', multiple: false },
    );
    const before = subject.get();
    assert.equal(subject.run('splitPanes'), false);
    assertNoWork(subject, before);
    assert.equal(subject.calls.warnings.length, 1, 'store retains its multiplicity feedback');
});

test('canonical four-pane capacity is enforced even when only one pane is visible', () => {
    const canonical = {
        version: 1,
        activePaneId: files.id,
        root: splitNode(splitNode(files, plugin), splitNode(shell, dashboard)),
    };
    const subject = harness({ selected: canonical }, 'files', { activeOwner: 'selected' });
    hide(subject, plugin, shell, dashboard);
    const before = subject.get();
    assert.equal(subject.run('splitPanes'), false);
    assertNoWork(subject, before);
    assert.equal(layout.collectLeaves(canonical.root).length, 4);
});

test('hidden focus is projected before splitting and the hidden original leaf stays retained', () => {
    const subject = harness({ selected: split(plugin, files, plugin.id) }, 'plugin:owner:panel', {
        activeOwner: 'selected',
        terminal: false,
    });
    hide(subject, plugin);
    assert.equal(subject.run('splitPanes'), true);
    const panes = layout.collectLeaves(subject.get().paneLayouts.local.selected.root);
    assert.equal(panes[0], plugin);
    assert.equal(panes.filter((pane) => pane.content.kind === 'plugin').length, 1);
    assert.equal(panes.filter((pane) => pane.content.kind === 'feature').length, 2);
});

test('standalone shell splits use its live ID without pre-creating a resource or changing its settings', () => {
    const subject = harness();
    assert.equal(subject.run('splitPanes', event('ArrowDown')), true);
    const current = subject.get().paneLayouts.local.shell;
    assert.equal(current.root.direction, 'vertical');
    assert.equal(layout.collectLeaves(current.root)[0].id, 'shell');
    assert.equal(subject.get().terminals.local.length, 2);
    assert.equal(subject.get().terminals.local[1].shellOverride, 'bash');
    assert.equal(subject.get().terminals.local[1].initialPath, '/project');
    assert.deepEqual(subject.calls.resources, []);
    assert.deepEqual(subject.calls.views, []);
});

test('all-hidden, unresolved and stale active workspaces cannot create or focus content', () => {
    for (const setup of [
        (subject) => hide(subject, plugin),
        (subject) => subject.set({ paneLayouts: { local: {} } }),
        (subject) => subject.set({ activeTabId: 'closed' }),
        (subject) => subject.set({ showWelcomeScreen: true }),
        (subject) => subject.set({ activeConnectionId: 'different' }),
        (subject) => subject.set({ tabs: [{ ...subject.get().tabs[0], type: 'settings' }] }),
    ]) {
        const subject = harness({ selected: single(plugin) }, 'plugin:owner:panel', {
            activeOwner: 'selected',
            terminal: false,
        });
        setup(subject);
        const before = subject.get();
        assert.equal(subject.run('splitPanes'), false);
        assert.equal(subject.run('focusSplitPane'), false);
        assertNoWork(subject, before);
    }
    for (const view of ['files', 'terminal']) {
        const subject = harness({}, view, { terminal: false });
        const before = subject.get();
        assert.equal(subject.run('splitPanes'), false);
        assertNoWork(subject, before);
    }
});

test('explicit store targets reject hidden, stale and split-container IDs without pre-focus mutation', () => {
    for (const target of ['missing', plugin.id, 'split-plugin-pane']) {
        const subject = harness({ selected: split(plugin, files) }, 'plugin:owner:panel', {
            activeOwner: 'selected',
        });
        hide(subject, plugin);
        const before = subject.get();
        assert.equal(subject.get().splitPanes('local', 'horizontal', 'after', target), false);
        assert.equal(subject.get().focusPaneInDirection('local', 'right', target), false);
        assertNoWork(subject, before);
    }
    const standalone = harness();
    const before = standalone.get();
    assert.equal(standalone.get().splitPanes('local', 'horizontal', 'after', 'missing'), false);
    assertNoWork(standalone, before);
});

test('focus command navigates the selected mixed feature/plugin canvas, not the remembered shell', () => {
    for (const view of ['files', 'plugin:owner:panel']) {
        const oldShell = single(shell);
        const subject = harness({ shell: oldShell, selected: split(files, plugin) }, view, {
            activeOwner: 'shell',
        });
        assert.equal(subject.run('focusSplitPane'), true);
        assert.equal(subject.get().paneLayouts.local.selected.activePaneId, plugin.id);
        assert.equal(subject.get().activePaneGroupOwner.local, 'selected');
        assert.equal(subject.get().paneLayouts.local.shell, oldShell);
        assert.deepEqual(subject.calls.views, []);
        assert.deepEqual(subject.calls.resources, []);
    }
});

test('focus repairs a hidden origin, skips hidden neighbors and declines an all-hidden group', () => {
    const nested = harness(
        {
            selected: {
                version: 1,
                activePaneId: files.id,
                root: splitNode(files, splitNode(plugin, dashboard)),
            },
        },
        'files',
        { activeOwner: 'selected', terminal: false },
    );
    hide(nested, plugin);
    assert.equal(nested.run('focusSplitPane'), true);
    assert.equal(nested.get().paneLayouts.local.selected.activePaneId, dashboard.id);
    assert.equal(
        layout.collectLeaves(nested.get().paneLayouts.local.selected.root).length,
        3,
        'focus does not remove hidden content',
    );
    const subject = harness({ selected: split(files, plugin) }, 'files', {
        activeOwner: 'selected',
        terminal: false,
    });
    hide(subject, files);
    assert.equal(subject.run('focusSplitPane'), true);
    assert.equal(subject.get().paneLayouts.local.selected.activePaneId, plugin.id);
    assert.equal(
        subject.get().focusPaneInDirection('local', 'left', plugin.id),
        false,
        'one visible leaf has no directional target',
    );
    hide(subject, files, plugin);
    const before = subject.get();
    const savesBefore = subject.calls.saves;
    assert.equal(subject.run('focusSplitPane'), false);
    assert.equal(subject.get(), before);
    assert.equal(subject.calls.saves, savesBefore);
});

test('one directional action repairs hidden focus and continues to its visible neighbor', () => {
    for (const explicit of [false, true]) {
        for (const direction of ['left', 'right']) {
            const subject = harness(
                {
                    selected: {
                        version: 1,
                        activePaneId: files.id,
                        root: splitNode(files, splitNode(plugin, dashboard)),
                    },
                },
                'files',
                { activeOwner: 'selected', terminal: false },
            );
            hide(subject, files);
            assert.equal(
                subject
                    .get()
                    .focusPaneInDirection('local', direction, explicit ? plugin.id : undefined),
                true,
            );
            assert.equal(
                subject.get().paneLayouts.local.selected.activePaneId,
                direction === 'right' ? dashboard.id : plugin.id,
            );
            assert.equal(subject.calls.saves, 1, 'repair and navigation commit focus only once');
            assert.deepEqual(subject.calls.resources, []);
            assert.equal(
                layout.collectLeaves(subject.get().paneLayouts.local.selected.root).length,
                3,
            );
        }
    }
});

test('legacy instance-less canvas selection preserves leaf identity and implicit store callers remain supported', () => {
    const legacy = leaf('saved-legacy', { kind: 'feature', featureId: 'files' });
    const subject = harness({ workspace: single(legacy) }, 'files', { terminal: false });
    assert.equal(subject.run('splitPanes'), true);
    assert.equal(layout.collectLeaves(subject.get().paneLayouts.local.workspace.root)[0], legacy);
    assert.equal(legacy.content.instanceId, undefined);
    const implicit = harness({ selected: split(files, plugin) }, 'terminal', {
        activeOwner: 'selected',
        terminal: false,
    });
    assert.equal(implicit.get().focusPaneInDirection('local', 'right'), true);
    assert.equal(implicit.get().paneLayouts.local.selected.activePaneId, plugin.id);
    assert.equal(implicit.get().splitPanes('local'), true);
    assert.equal(layout.collectLeaves(implicit.get().paneLayouts.local.selected.root).length, 3);
});

test('fields and terminal-first routing keep ownership; plugin bridge permissions do not expand', () => {
    const subject = harness({ selected: split(files, plugin) }, 'files', {
        activeOwner: 'selected',
        terminal: false,
    });
    const before = subject.get();
    assert.equal(subject.run('splitPanes', event('ArrowRight', 'field')), false);
    assert.equal(subject.run('focusSplitPane', event('ArrowRight', 'field')), false);
    const input = event('ArrowRight', 'xterm');
    assert.equal(
        route.routeShortcut(input, 'xterm', 'shell', catalog.SHORTCUT_CATALOG, {}, subject.run),
        false,
    );
    assertNoWork(subject, before);
    assert.equal(
        route.routeShortcut(input, 'xterm', 'app', catalog.SHORTCUT_CATALOG, {}, subject.run),
        true,
    );
    assert.equal(pluginShortcuts.isPluginShortcutCommandAllowed('splitPanes'), false);
    assert.equal(pluginShortcuts.isPluginShortcutCommandAllowed('focusSplitPane'), true);
});

test('directional shortcuts navigate visible dock geometry while preserving the center selection', () => {
    const subject = harness(
        { center: single(files), bottom: single(plugin), left: single(dashboard) },
        'files',
        { activeOwner: 'center', terminal: false },
    );
    subject.set({
        workspaceDocking: {
            local: {
                version: 1,
                placements: {
                    [key(plugin)]: 'bottom-panel',
                    [key(dashboard)]: 'primary-sidebar',
                },
            },
        },
    });
    const center = subject.get().activePaneGroupOwner;
    assert.equal(subject.run('focusSplitPane', event('ArrowDown')), true);
    assert.equal(subject.get().workspaceDockFocus.local, key(plugin));
    assert.equal(subject.get().activePaneGroupOwner, center);
    assert.equal(subject.run('focusSplitPane', event('ArrowLeft')), true);
    assert.equal(subject.get().workspaceDockFocus.local, key(dashboard));
    assert.equal(subject.run('focusSplitPane', event('ArrowRight')), true);
    assert.equal(subject.get().workspaceDockFocus.local, null);
    assert.equal(subject.get().activePaneGroupOwner.local, 'center');
    assert.deepEqual(subject.calls.views, []);
    assert.deepEqual(subject.calls.resources, []);
});

test('dock navigation excludes hidden and inactive center content and declines malformed allocation', () => {
    const subject = harness(
        { center: single(files), dock: single(plugin), inactive: single(dashboard) },
        'files',
        { activeOwner: 'center', terminal: false },
    );
    subject.set({
        workspaceDocking: {
            local: { version: 1, placements: { [key(plugin)]: 'secondary-sidebar' } },
        },
    });
    hide(subject, plugin);
    let before = subject.get();
    assert.equal(subject.run('focusSplitPane'), false);
    assertNoWork(subject, before);
    subject.set({ workspaceDocking: { local: { version: 99, placements: {} } } });
    before = subject.get();
    assert.equal(subject.run('focusSplitPane'), false);
    assertNoWork(subject, before);
});

test('dock navigation resolves content identities rather than ambiguous local pane IDs', () => {
    const duplicateId = leaf(files.id, plugin.content);
    const subject = harness({ center: single(files), dock: single(duplicateId) }, 'files', {
        activeOwner: 'center',
        terminal: false,
    });
    subject.set({
        workspaceDocking: {
            local: { version: 1, placements: { [key(duplicateId)]: 'secondary-sidebar' } },
        },
    });
    assert.equal(subject.run('focusSplitPane'), true);
    assert.equal(subject.get().workspaceDockFocus.local, key(duplicateId));
    assert.equal(subject.run('focusSplitPane', event('ArrowLeft')), true);
    assert.equal(subject.get().workspaceDockFocus.local, null);
    assert.equal(subject.get().activePaneGroupOwner.local, 'center');
});

test('split shortcut duplicates the focused dock without replacing the feature center or tab view', () => {
    const subject = harness({ center: single(files), dock: single(plugin) }, 'files', {
        activeOwner: 'center',
        terminal: false,
    });
    subject.set({
        workspaceDocking: { local: { version: 1, placements: { [key(plugin)]: 'bottom-panel' } } },
    });
    subject.get().focusWorkspaceContent('local', key(plugin));
    const before = subject.get();
    assert.equal(subject.run('splitPanes', event('ArrowDown')), true);
    const current = subject.get();
    assert.equal(current.paneLayouts.local.center, before.paneLayouts.local.center);
    assert.equal(current.activePaneGroupOwner, before.activePaneGroupOwner);
    const panes = layout.collectLeaves(current.paneLayouts.local.dock.root);
    assert.equal(panes.length, 2);
    assert.equal(current.workspaceDockFocus.local, key(panes[1]));
    assert.equal(current.workspaceDocking.local.placements[key(panes[1])], 'bottom-panel');
    assert.deepEqual(subject.calls.views, []);
    assert.deepEqual(subject.calls.resources, []);
});
