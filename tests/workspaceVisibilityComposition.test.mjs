import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

/** Run current production source without shared compilation or native application services. */
function loadSource(path, dependencies = {}) {
    const { outputText } = ts.transpileModule(readFileSync(new URL(`../src/${path}.ts`, import.meta.url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });
    const context = { exports: {}, require: name => {
        assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
        return dependencies[name];
    } };
    runInNewContext(outputText, context);
    return context.exports;
}

const types = loadSource('lib/paneLayout/types');
const query = loadSource('lib/paneLayout/query', { './types': types });
const identity = loadSource('lib/paneLayout/contentIdentity');
const ops = loadSource('lib/paneLayout/ops', { './ids': {}, './query': query, './dock': {}, './intro': {}, './types': types });
const groups = loadSource('lib/paneLayout/groups', { './persist': {}, './ops': ops, './query': query, './contentIdentity': identity });
const projection = loadSource('lib/paneLayout/visibility', { './contentIdentity': identity, './query': query });
const regions = loadSource('lib/paneLayout/regions', { './contentIdentity': identity, './query': query, './visibility': projection });
const layout = { ...types, ...query, ...ops, ...groups, ...identity, ...projection };
const inventory = loadSource('features/workspace/domain/contentInventory', {
    '../../../lib/paneLayout/contentIdentity': identity, '../../../lib/paneLayout/query': query,
});
const titles = loadSource('features/workspace/domain/presentation');
const metadata = loadSource('features/workspace/domain/contentPresentation', { './presentation': titles });
const registrations = loadSource('features/workspace/domain/registrations', {
    '../../../lib/paneLayout/types': types, '../../../lib/paneLayout/regions': regions,
});
const presentationSlice = loadSource('store/workspacePresentationSlice', {
    '../lib/paneLayout': layout, '../lib/paneLayout/contentIdentity': identity,
    '../features/workspace/domain/presentation': titles, '../features/workspace/domain/contentInventory': inventory,
    '../features/workspace/domain/contentPresentation': metadata, '../features/workspace/domain/registrations': registrations,
});
const visibility = loadSource('features/workspace/domain/visibleContent', {
    '../../../lib/paneLayout': layout, './contentInventory': inventory, './contentPresentation': metadata,
});
const selection = loadSource('features/workspace/application/selectExistingContent', {
    '../../../lib/paneLayout': layout, '../domain/contentInventory': inventory, '../domain/visibleContent': visibility,
});

const mainSource = ts.createSourceFile('MainLayout.tsx',
    readFileSync(new URL('../src/components/layout/MainLayout.tsx', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

test('main tab activation changes visibility without replaying motion or broad transitions', () => {
    const visibilityClasses = [];
    function collect(node, inTabContent = false) {
        const inside = inTabContent || (ts.isFunctionExpression(node) && node.name?.text === 'TabContent');
        if (inside && ts.isJsxAttribute(node) && node.name.getText(mainSource) === 'className'
            && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression
            && /\bisActive\b/.test(node.initializer.expression.getText(mainSource))) {
            visibilityClasses.push(node.initializer.expression.getText(mainSource));
        }
        ts.forEachChild(node, child => collect(child, inside));
    }
    collect(mainSource);
    assert.equal(visibilityClasses.length, 8, 'Cover all seven global tab bodies, including saved audits, and the host/Snippets body');
    for (const expression of visibilityClasses) {
        for (const forceOpaqueShell of [false, true]) {
            for (const terminalTransparencyEnabled of [false, true]) {
                const classes = isActive => runInNewContext(expression, {
                    cn: (...values) => values.filter(Boolean).join(' '),
                    isActive, forceOpaqueShell, terminalTransparencyEnabled, tab: { view: 'terminal' },
                }).split(/\s+/);
                const active = classes(true);
                const inactive = classes(false);
                assert.ok(!active.includes('hidden'), 'Selected tab is immediately visible');
                assert.ok(inactive.includes('hidden'), 'Unselected retained tab stays hidden');
                assert.deepEqual(inactive.filter(value => value !== 'hidden'), active,
                    'Switching only changes visibility, not motion or geometry');
                assert.ok(!active.some(value => /^(?:animate-|fade-|zoom-|slide-|transition(?:-|$)|duration-)/.test(value)),
                    `Tab body must not delay selection with motion: ${active.join(' ')}`);
            }
        }
    }
});

const callbackNames = ['selectContent', 'selectedContentId', 'setContentHidden', 'revealAllContent'];
const callbacks = new Map();
function collectCallbacks(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && callbackNames.includes(node.name.text)
        && node.initializer && ts.isCallExpression(node.initializer)
        && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === 'useCallback') {
        assert.ok(!callbacks.has(node.name.text), `Ambiguous application callback: ${node.name.text}`);
        callbacks.set(node.name.text, node.initializer.arguments[0].getText(mainSource));
    }
    ts.forEachChild(node, collectCallbacks);
}
collectCallbacks(mainSource);
for (const name of callbackNames) assert.ok(callbacks.has(name), `Missing production MainLayout callback: ${name}`);
const compositionScript = ts.transpileModule(`globalThis.compose = (tab, activeFeatureTabId, setActiveFeatureTabId, setTabView) => {
    ${callbackNames.map(name => `const ${name} = ${callbacks.get(name)};`).join('\n')}
    return { ${callbackNames.join(', ')} };
}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

const leaf = (id, content) => ({ type: 'pane', id, content });
const shell = leaf('shell-pane', { kind: 'term', termId: 'shell' });
const files = leaf('files-pane', { kind: 'feature', featureId: 'files', instanceId: 'files-one' });
const plugin = leaf('plugin-pane', { kind: 'plugin', pluginId: 'owner:panel', instanceId: 'plugin-one' });
const otherPlugin = leaf('other-plugin-pane', { kind: 'plugin', pluginId: 'owner:panel', instanceId: 'plugin-two' });
const single = pane => ({ version: 1, root: pane, activePaneId: pane.id });
const split = (first, second, activePaneId = first.id) => ({ version: 1, activePaneId,
    root: { type: 'split', id: `split-${first.id}`, direction: 'horizontal', sizes: [0.4, 0.6], children: [first, second] } });
const key = pane => identity.paneContentKey(pane.content, pane.id);

/** Only focus/view boundaries are modeled; metadata actions and application callbacks are real. */
function harness({ paneGroups = {}, terminals = [], owner = null, activeTerminal = terminals[0]?.id ?? null,
    view = 'terminal', featureInstance = null, presentation = {} } = {}) {
    const calls = { focus: [], terminals: [], views: [], instances: [], saves: 0 };
    let tab = { id: 'workspace-tab', connectionId: 'local', view };
    let activeFeatureTabId = featureInstance;
    const forbidden = () => assert.fail('Visibility composition must not open, close, ensure, or disconnect resources');
    let state = {
        terminals: { local: terminals }, paneLayouts: { local: paneGroups }, activeTerminalIds: { local: activeTerminal },
        activePaneGroupOwner: { local: owner }, sessionLoaded: true, isRestoring: false, sessionPersistenceBlocked: false,
        saveSession: async () => { calls.saves++; },
        createTerminal: forbidden, ensureTerminal: forbidden, ensureFeaturePane: forbidden, ensurePluginPane: forbidden,
        closeTerminal: forbidden, closePaneGroup: forbidden, closePaneInSplit: forbidden, disconnect: forbidden,
        focusPane: (scope, paneId) => {
            const entry = Object.entries(state.paneLayouts[scope] ?? {}).find(([, canvas]) => query.findNode(canvas.root, paneId));
            assert.ok(entry, 'Focus must address an existing canonical pane');
            const [currentOwner, canvas] = entry;
            const pane = query.findNode(canvas.root, paneId);
            assert.equal(state.contentPresentation[scope]?.items[key(pane)]?.hidden, undefined);
            calls.focus.push([scope, paneId]);
            set({ paneLayouts: { ...state.paneLayouts, [scope]: { ...state.paneLayouts[scope],
                [currentOwner]: ops.focusPane(canvas, paneId) } },
            activePaneGroupOwner: { ...state.activePaneGroupOwner, [scope]: currentOwner },
            ...(query.isTermContent(pane.content) && { activeTerminalIds: { ...state.activeTerminalIds, [scope]: pane.content.termId } }),
            });
        },
        setActiveTerminal: (scope, id) => {
            assert.ok(state.terminals[scope]?.some(item => item.id === id));
            calls.terminals.push([scope, id]);
            set({ activeTerminalIds: { ...state.activeTerminalIds, [scope]: id },
                activePaneGroupOwner: { ...state.activePaneGroupOwner, [scope]: null } });
        },
    };
    const set = patch => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; };
    state = { ...state, ...presentationSlice.createWorkspacePresentationSlice(set, () => state), contentPresentation: presentation };
    const context = { useAppStore: { getState: () => state }, ...visibility, ...selection,
        isSplitFeatureId: types.isSplitFeatureId, isPluginTabView: value => value.startsWith('plugin:') && value.length > 7 };
    runInNewContext(compositionScript, context);
    const actions = () => context.compose(tab, activeFeatureTabId,
        id => { activeFeatureTabId = id; calls.instances.push(id); },
        (id, nextView) => { assert.equal(id, tab.id); tab = { ...tab, view: nextView }; calls.views.push(nextView); });
    return { get: () => state, set, calls, actions, ui: () => ({ tab, activeFeatureTabId }),
        clearConnection: () => { tab = { ...tab, connectionId: undefined }; } };
}

test('production inactive hide preserves current canvas, local feature selection and resources', () => {
    const subject = harness({ paneGroups: { files: single(files), other: single(plugin) }, owner: 'files',
        view: 'files', featureInstance: 'files-one' });
    const before = subject.get().paneLayouts;
    assert.equal(subject.actions().selectedContentId(), key(files));
    assert.equal(subject.actions().setContentHidden(key(plugin), true), true);
    assert.equal(subject.get().paneLayouts, before);
    assert.equal(subject.get().activePaneGroupOwner.local, 'files');
    assert.equal(subject.ui().activeFeatureTabId, 'files-one');
    assert.deepEqual(subject.calls.focus, []);
    assert.deepEqual(subject.calls.views, []);
    assert.equal(subject.calls.saves, 1);
});

test('production active hide selects a visible sibling before a globally pinned item and syncs feature chrome', () => {
    const mixed = split(shell, files);
    const subject = harness({ paneGroups: { mixed, plugin: single(plugin) }, owner: 'mixed',
        terminals: [{ id: 'shell', title: 'Shell' }],
        presentation: { local: { version: 3, items: { [key(plugin)]: { pinned: true } }, order: [key(plugin), key(files)] } } });
    const terminals = subject.get().terminals;
    assert.equal(subject.actions().setContentHidden(key(shell), true), true);
    assert.equal(subject.actions().selectedContentId(), key(files));
    assert.equal(subject.get().activePaneGroupOwner.local, 'mixed');
    assert.equal(subject.get().paneLayouts.local.mixed.root, mixed.root, 'Selection cannot rewrite split geometry');
    assert.equal(subject.get().terminals, terminals);
    assert.deepEqual(subject.calls.focus, [['local', files.id]]);
    assert.equal(subject.ui().tab.view, 'files');
    assert.equal(subject.ui().activeFeatureTabId, 'files-one');
});

test('production active hide without siblings selects another group by saved visual order', () => {
    const subject = harness({ paneGroups: { files: single(files), first: single(plugin), second: single(otherPlugin) }, owner: 'files',
        view: 'files', featureInstance: 'files-one',
        presentation: { local: { version: 3, items: {}, order: [key(otherPlugin), key(plugin), key(files)] } } });
    assert.equal(subject.actions().setContentHidden(key(files), true), true);
    assert.equal(subject.get().activePaneGroupOwner.local, 'second');
    assert.deepEqual(subject.calls.focus, [['local', otherPlugin.id]]);
    assert.equal(subject.ui().tab.view, 'plugin:owner:panel');
    assert.equal(subject.actions().selectedContentId(), key(otherPlugin));
});

test('production all-hidden leaves canonical inventory and topology intact without replacement resources', () => {
    const canvas = single(files);
    const subject = harness({ paneGroups: { files: canvas }, owner: 'files', view: 'files', featureInstance: 'files-one' });
    const before = subject.get();
    assert.equal(subject.actions().setContentHidden(key(files), true), true);
    assert.equal(subject.get().paneLayouts, before.paneLayouts);
    assert.equal(subject.get().terminals, before.terminals);
    assert.equal(subject.get().activePaneGroupOwner, before.activePaneGroupOwner);
    assert.equal(subject.actions().selectedContentId(), key(files));
    assert.equal(visibility.visibleContentFallback(subject.get(), 'local', key(files)), undefined);
    assert.deepEqual(subject.calls.focus, []);
    assert.deepEqual(subject.calls.views, []);
    assert.deepEqual(subject.calls.instances, []);
    assert.equal(subject.calls.saves, 1);
});

test('production reveal-all repairs missing selection and keeps aliases, pins, order and dormant preferences', () => {
    const dormant = '["plugin","owner:panel","dormant"]';
    const order = [key(files), dormant, key(plugin)];
    const subject = harness({ paneGroups: { files: single(files), plugin: single(plugin) },
        presentation: { local: { version: 3, items: {
            [key(files)]: { hidden: true, displayAlias: 'My files', pinned: true },
            [key(plugin)]: { hidden: true }, [dormant]: { hidden: true, displayAlias: 'Unavailable' },
        }, order } } });
    assert.equal(subject.actions().selectedContentId(), null);
    assert.equal(subject.actions().revealAllContent(), true);
    assert.equal(subject.ui().tab.view, 'files');
    assert.equal(subject.ui().activeFeatureTabId, 'files-one');
    assert.equal(subject.get().activePaneGroupOwner.local, 'files');
    assert.equal(subject.get().contentPresentation.local.items[key(files)].displayAlias, 'My files');
    assert.equal(subject.get().contentPresentation.local.items[key(files)].pinned, true);
    assert.equal(subject.get().contentPresentation.local.items[dormant].hidden, undefined);
    assert.equal(subject.get().contentPresentation.local.order, order);
    assert.equal(subject.calls.saves, 1);
    assert.deepEqual(Object.keys(subject.get().paneLayouts.local), ['files', 'plugin']);
});

test('production blocked or disconnected-scope actions have no metadata, focus or view side effects', () => {
    const subject = harness({ paneGroups: { files: single(files) }, owner: 'files', view: 'files', featureInstance: 'files-one',
        presentation: { local: { version: 3, items: { [key(files)]: { hidden: true } } } } });
    subject.set({ sessionPersistenceBlocked: true });
    const before = subject.get();
    assert.equal(subject.actions().setContentHidden(key(files), false), false);
    assert.equal(subject.actions().revealAllContent(), false);
    assert.equal(subject.get(), before);
    subject.clearConnection();
    assert.equal(subject.actions().setContentHidden(key(files), false), false);
    assert.equal(subject.actions().revealAllContent(), false);
    assert.deepEqual(subject.calls, { focus: [], terminals: [], views: [], instances: [], saves: 0 });
});

test('production callbacks re-resolve moved owners and pane allocations at invocation time', () => {
    const subject = harness({ paneGroups: { original: single(files), other: single(otherPlugin) }, owner: 'original',
        view: 'files', featureInstance: 'files-one' });
    const captured = subject.actions();
    const movedFiles = { ...files, id: 'moved-files-pane' };
    const movedPlugin = { ...plugin, id: 'moved-plugin-pane' };
    const moved = split(movedFiles, movedPlugin);
    subject.set({ paneLayouts: { local: { other: single(otherPlugin), newOwner: moved } },
        activePaneGroupOwner: { local: 'newOwner' } });
    assert.equal(captured.selectedContentId(), key(files));
    assert.equal(captured.setContentHidden(key(files), true), true);
    assert.deepEqual(subject.calls.focus, [['local', movedPlugin.id]]);
    assert.equal(subject.get().activePaneGroupOwner.local, 'newOwner');
    assert.equal(subject.get().paneLayouts.local.newOwner.root, moved.root);
    assert.equal(subject.get().paneLayouts.local.original, undefined);
    assert.equal(subject.actions().selectedContentId(), key(plugin));
});

test('production reveal restores a hidden standalone shell without a pane or resource allocation', () => {
    const terminals = [{ id: 'shell', title: 'Shell' }];
    const subject = harness({ terminals, presentation: { local: { version: 3, items: { [key(shell)]: { hidden: true } } } } });
    assert.equal(subject.actions().revealAllContent(), true);
    assert.deepEqual(subject.calls.terminals, [['local', 'shell']]);
    assert.equal(subject.get().terminals.local, terminals);
    assert.deepEqual(Object.keys(subject.get().paneLayouts.local), []);
    assert.equal(subject.ui().tab.view, 'terminal');
    assert.equal(subject.ui().activeFeatureTabId, null);
});

test('production single-item reveal preserves unrelated current selection and closed identities stay rejected', () => {
    const subject = harness({ paneGroups: { files: single(files), plugin: single(plugin) }, owner: 'files',
        view: 'files', featureInstance: 'files-one',
        presentation: { local: { version: 3, items: { [key(plugin)]: { hidden: true } } } } });
    const before = subject.get().paneLayouts;
    assert.equal(subject.actions().setContentHidden(key(plugin), false), true);
    assert.equal(subject.actions().selectedContentId(), key(files));
    assert.equal(subject.get().paneLayouts, before);
    assert.deepEqual(subject.calls.focus, []);
    assert.deepEqual(subject.calls.views, []);
    subject.set({ paneLayouts: { local: { files: single(files) } } });
    assert.equal(subject.actions().setContentHidden(key(plugin), true), false);
    assert.equal(subject.calls.saves, 1);
    assert.equal(subject.get().contentPresentation.local, undefined);
});
