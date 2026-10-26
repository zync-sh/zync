import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadSource } from './helpers/loadSource.mjs';

const require = createRequire(import.meta.url);
const { Provider: TooltipProvider } = require('@radix-ui/react-tooltip');
const cache = new Map();
function load(relative) {
    const file = relative.startsWith('src/') ? fileURLToPath(new URL(`../${relative}`, import.meta.url)) : relative;
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });
    runInNewContext(outputText, { module, exports: module.exports, navigator: { platform: 'Win32' },
        require: name => {
            if (!name.startsWith('.')) return require(name);
            const base = path.resolve(path.dirname(file), name.replace(/\.js$/, ''));
            const found = [base + '.ts', base + '.tsx', path.join(base, 'index.ts')].find(existsSync);
            assert.ok(found, name); return load(found);
        } });
    return module.exports;
}
const domain = load('src/features/workspace/domain/navigation.ts');
const { createNavigationUpdater } = load('src/features/workspace/application/updateNavigation.ts');
const { ActivityBar } = load('src/components/layout/navigation/ActivityBar.tsx');
const { NavigationFrame } = load('src/components/layout/navigation/NavigationFrame.tsx');
const defaults = () => structuredClone(domain.DEFAULT_WORKSPACE_NAVIGATION);
const renderNavigation = props => renderToStaticMarkup(React.createElement(TooltipProvider, null, React.createElement(ActivityBar, props)));
const plain = value => JSON.parse(JSON.stringify(value));

test('whole-strip placement accepts only shell edges and never a pane interior or outside drop', () => {
    const { navigationStripDropTarget: target } = load('src/features/workspace/domain/navigationStripPlacement.ts');
    const bounds = { left: 10, right: 810, top: 20, bottom: 620 };
    for (const [point, value] of [[{ x: 12, y: 300 }, 'left'], [{ x: 808, y: 300 }, 'right'],
        [{ x: 400, y: 22 }, 'default'], [{ x: 400, y: 300 }, null], [{ x: 9, y: 300 }, null],
        [{ x: 400, y: 621 }, null]]) assert.equal(target(point, bounds), value);
    assert.equal(target({ x: 50, y: 60 }, { left: 0, right: 100, top: 0, bottom: 100 }), null);
});

test('explicit docking reveals its recovery icon without changing other navigation choices', () => {
    const before = { ...defaults(), visible: false, hidden: ['workspace', 'plugins'], position: 'right' };
    const docked = domain.changeWorkspaceNavigation(before, { type: 'workspace-tabs', value: 'left' });
    assert.equal(docked.visible, true); assert.equal(docked.position, 'right');
    assert.deepEqual(Array.from(docked.hidden), ['plugins']); assert.deepEqual(Array.from(docked.order), before.order);
    assert.equal(before.visible, false); assert.deepEqual(before.hidden, ['workspace', 'plugins']);
    const html = renderNavigation({ preferences: docked, hasWorkspace: true, keybindings: {}, onCommand() {}, onCustomize() {},
        workspaceLabel: 'Ubuntu', workspaceBadge: React.createElement('span', null, 'U') });
    assert.match(html, /aria-label="Host workspace — Ubuntu"/); assert.match(html, /data-workspace-host-badge/);
});

test('all sidebar controls agree on shared section visibility, mirrored placement and undocking recovery', () => {
    const { sidebarPresentation: present } = load('src/features/workspace/application/sidebarPresentation.ts');
    const right = { ...defaults(), visible: true, workspaceTabsPosition: 'right' };
    assert.deepEqual(plain(present(right, 'workspace', true)), { section: 'workspace', position: 'right', collapsed: false });
    assert.deepEqual(plain(present(right, 'plugins', false)), { section: 'plugins', position: 'right', collapsed: false });
    assert.equal(present(right, null, false).collapsed, true);
    assert.equal(present({ ...right, workspaceTabsPosition: 'default' }, 'workspace', false).section, 'hosts');
    assert.equal(present({ version: 99 }, 'workspace', false).section, 'hosts');
});

test('workspace selection reuses the active or last host, excludes global snippets and never creates a tab', () => {
    const { selectHostWorkspaceTab: select } = load('src/features/workspace/application/hostWorkspaceSelection.ts');
    const tabs = [{ id: 'first', type: 'connection', connectionId: 'a' }, { id: 'last', type: 'connection', connectionId: 'b' },
        { id: 'snippets', type: 'connection', connectionId: 'global' }];
    assert.equal(select(tabs, 'last', 'a', 'a'), tabs[1]);
    assert.equal(select(tabs, 'snippets', 'global', 'b'), tabs[1]);
    assert.equal(select([tabs[2]], 'snippets', 'global'), undefined);
    const { activateGlobalNavigation } = load('src/features/workspace/application/globalNavigation.ts');
    const calls = [];
    activateGlobalNavigation('workspace', { workspaceDocked: true, selectWorkspace: () => true, showSection: value => calls.push(value) });
    assert.deepEqual(calls, ['workspace']); assert.equal(tabs.length, 3);
});

test('strip context menus offer the same three acknowledged placement choices with radio state', () => {
    const { workspaceTabsMenu } = load('src/components/layout/navigation/workspaceTabsMenu.ts');
    const calls = [];
    const items = workspaceTabsMenu('right', value => calls.push(value));
    assert.deepEqual(plain(items.map(item => [item.label, item.checked, item.checkType])),
        [['Current position', false, 'radio'], ['Left sidebar', false, 'radio'], ['Right sidebar', true, 'radio']]);
    items[0].action(); assert.deepEqual(calls, ['default']);
    assert.ok(workspaceTabsMenu('default', () => {}, true).every(item => item.disabled));
});

test('shared sidebar resizing rounds fractional geometry to native-safe integers on both edges', () => {
    for (const side of ['left', 'right']) {
        const commits = [], frames = new Map(), changes = [], events = [];
        let nextFrame = 0, captured = false;
        const body = { style: { cursor: 'original' } };
        const { useSidebarResize } = loadSource('components/layout/sidebar/useSidebarResize.ts', {
            react: { useCallback: fn => fn, useEffect() {}, useRef: value => ({ current: value }),
                useState: value => [value, next => changes.push(next)] },
        }, { document: { body }, window: { dispatchEvent: event => events.push(event.type) },
            CustomEvent: class { constructor(type) { this.type = type; } },
            requestAnimationFrame: fn => { frames.set(++nextFrame, fn); return nextFrame; },
            cancelAnimationFrame: id => frames.delete(id) });
        const { handlers, width, sidebarRef } = useSidebarResize(288.6, value => {
            assert.ok(Number.isInteger(value), 'native sidebarWidth requires an integer');
            assert.ok(value >= 200 && value <= 600);
            commits.push(value);
        }, side);
        assert.equal(width, 289, 'saved fractional width is normalized too');
        const style = { setProperty(name, value) { this[name] = value; } };
        sidebarRef.current = { style };
        const node = { parentElement: { getBoundingClientRect: () => ({ width: 289 }) }, setAttribute() {},
            setPointerCapture() { captured = true; }, hasPointerCapture: () => captured,
            releasePointerCapture() { captured = false; } };
        const event = { pointerId: 7, button: 0, isPrimary: true, currentTarget: node, clientX: 300, preventDefault() {} };
        handlers.onPointerDown(event); assert.equal(captured, true); assert.equal(body.style.cursor, 'col-resize');
        handlers.onPointerMove({ ...event, clientX: side === 'right' ? 280 : 320 });
        handlers.onPointerMove({ ...event, clientX: side === 'right' ? 247.65 : 352.35 });
        assert.equal(frames.size, 1); assert.deepEqual(commits, []);
        const [id, paint] = frames.entries().next().value; frames.delete(id); paint();
        assert.equal(style.width, '341.35px', 'pointer painting keeps subpixel motion');
        assert.deepEqual(changes, [true], 'drag frames do not update React width state');
        handlers.onPointerUp(event);
        assert.deepEqual(commits, [341]); assert.equal(style.width, '341px'); assert.equal(captured, false);
        assert.equal(frames.size, 1, 'transitions resume after final width paint');
        const [releaseId, release] = frames.entries().next().value; frames.delete(releaseId); release();
        assert.equal(body.style.cursor, 'original');
        assert.deepEqual(events, ['zync:layout-transition-start', 'zync:layout-transition-end']);
        handlers.onKeyDown({ key: side === 'right' ? 'ArrowLeft' : 'ArrowRight', preventDefault() {} });
        assert.equal(commits.at(-1), 357);
        handlers.onKeyDown({ key: 'End', preventDefault() {} }); assert.equal(commits.at(-1), 600);
        handlers.onKeyDown({ key: 'Home', preventDefault() {} }); assert.equal(commits.at(-1), 200);
        handlers.onPointerDown(event);
        handlers.onPointerMove({ ...event, clientX: side === 'right' ? -100 : 1000 });
        handlers.onPointerCancel(event); assert.equal(commits.at(-1), 600); assert.equal(captured, false);
        assert.equal(frames.size, 1); assert.equal(body.style.cursor, 'original');
    }
});

test('navigation context menu lists visible and hidden destinations in saved order with current shortcuts', () => {
    const { navigationContextMenu } = load('src/components/layout/navigation/navigationContextMenu.ts');
    const { GLOBAL_NAVIGATION_ENTRIES: entries } = load('src/components/layout/navigation/navigationItems.ts');
    const calls = [];
    const preferences = { ...defaults(), visible: true, hidden: ['snippets'],
        order: ['snippets', ...defaults().order.filter(id => id !== 'snippets')] };
    const items = navigationContextMenu({ preferences, entries, keybindings: { toggleSidebar: 'Ctrl+Shift+F9' },
        editable: true, onChange: action => calls.push(plain(action)), onCustomize() {} });
    const selectable = items.filter(item => 'checked' in item && !item.disabled);
    assert.equal(selectable.length, 8);
    assert.equal(selectable[0].label, 'Snippets'); assert.equal(selectable[0].checked, false);
    const hosts = selectable.find(item => item.label === 'Hosts');
    assert.equal(hosts.checked, true); assert.equal(hosts.shortcut, 'Ctrl+Shift+F9 / Ctrl+Shift+B');
    assert.equal(calls.length, 0);
    hosts.action(); selectable[0].action();
    assert.deepEqual(calls, [{ type: 'hidden', id: 'hosts', value: true }, { type: 'hidden', id: 'snippets', value: false }]);
    assert.deepEqual(preferences.hidden, ['snippets']);
    for (const name of ['Settings', 'Profile']) {
        const item = items.find(item => item.label === name);
        assert.equal(item.checked, true); assert.equal(item.disabled, true); assert.ok(item.shortcut);
    }
});

test('navigation menu reuses position/order ports and disables mutations while saving or read-only', () => {
    const { navigationContextMenu } = load('src/components/layout/navigation/navigationContextMenu.ts');
    const { GLOBAL_NAVIGATION_ENTRIES: entries } = load('src/components/layout/navigation/navigationItems.ts');
    const calls = [];
    const preferences = { ...defaults(), visible: true, position: 'right' };
    const build = editable => navigationContextMenu({ preferences, entries, keybindings: {}, selectedId: 'hosts', editable,
        onChange: action => calls.push(plain(action)), onCustomize: () => calls.push('customize') });
    const items = build(true);
    const positions = items.find(item => item.label === 'Navigation position').children;
    assert.deepEqual(plain(positions.map(item => [item.label, item.checked, item.checkType])), [['Left', false, 'radio'], ['Right', true, 'radio']]);
    positions[0].action();
    const arrange = items.find(item => item.label === 'Arrange item').children;
    assert.equal(arrange[0].disabled, true); arrange[1].action();
    items.find(item => item.label === 'Hide navigation bar').action();
    items.find(item => item.label === 'Customize navigation').action();
    assert.deepEqual(calls, [{ type: 'position', value: 'left' }, { type: 'move', id: 'hosts', targetId: 'public-urls' }, { type: 'visible', value: false }, 'customize']);
    const locked = build(false);
    for (const item of locked) if (!('separator' in item) && item.label !== 'Customize navigation' && item.label !== 'Arrange item') assert.equal(item.disabled, true);
    assert.ok(locked.find(item => item.label === 'Arrange item').children.every(item => item.disabled));
});

test('activity-bar context menu auto-focuses only when opened from the keyboard', () => {
    const ContextMenu = () => null;
    let menu = null;
    const { ActivityBar: IsolatedBar } = loadSource('components/layout/navigation/ActivityBar.tsx', {
        react: { useRef: value => ({ current: value }), useEffect() {}, useState: initial => initial === null
            ? [menu, value => { menu = value; }] : [initial, () => {}] },
        'react/jsx-runtime': require('react/jsx-runtime'),
        '../../../lib/utils': { cn: (...values) => values.filter(Boolean).join(' ') },
        '../../../features/shortcuts/labels': load('src/features/shortcuts/labels.ts'),
        '../../../features/workspace/domain/navigation': domain,
        '../../ui/Button': { Button: () => null }, '../../ui/Tooltip': { Tooltip: () => null },
        '../../ui/controlStyles': load('src/components/ui/controlStyles.ts'), '../../ui/ContextMenu': { ContextMenu },
        './navigationContextMenu': load('src/components/layout/navigation/navigationContextMenu.ts'),
        './navigationItems': load('src/components/layout/navigation/navigationItems.ts'),
        '../tabDrag/useTabDragPointer': { useTabDragPointer: () => ({ begin() {}, consumeClickIfDragged: () => false }) },
        '../tabDrag/preview': {}, '../tabDrag/reorder': {},
    });
    const props = { preferences: { ...defaults(), visible: true }, hasWorkspace: true, keybindings: {}, onCommand() {}, onCustomize() {} };
    const node = { dataset: { navigationItem: 'hosts' }, querySelector: () => null, getBoundingClientRect: () => ({ right: 32, top: 20 }) };
    const event = { target: { closest: () => node }, preventDefault() {}, stopPropagation() {}, clientX: 16, clientY: 30 };
    IsolatedBar(props).props.onContextMenu(event);
    assert.equal(menu.keyboard, false);
    assert.equal(IsolatedBar(props).props.children.at(-1).props.autoFocus, false);
    IsolatedBar(props).props.onKeyDown({ ...event, key: 'F10', shiftKey: true });
    assert.equal(menu.keyboard, true);
    assert.equal(IsolatedBar(props).props.children.at(-1).props.autoFocus, true);
});

test('Settings and Profile render once in the footer or title-bar fallback, never both', () => {
    const { outputText } = ts.transpileModule(readFileSync(new URL('../src/components/layout/GlobalUtilityActions.tsx', import.meta.url), 'utf8'), {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });
    for (const visible of [true, false]) {
        const exports = {};
        const dependencies = {
            'react/jsx-runtime': require('react/jsx-runtime'),
            'lucide-react': { Settings: () => null },
            '../../store/useAppStore': { useAppStore: selector => selector({ settings: { workspaceNavigation: { ...defaults(), visible }, keybindings: {} }, openSettings: () => {} }) },
            '../../features/workspace/domain/navigation': domain,
            '../ui/IconButton': { IconButton: ({ label }) => React.createElement('button', { 'aria-label': label }) },
            './ProfileSyncMenu': { ProfileSyncMenu: () => React.createElement('button', { 'aria-label': 'Profile' }) },
            '../ui/Tooltip': { Tooltip: ({ children }) => children },
            '../../features/shortcuts/labels': { shortcutHint: () => 'Ctrl+,' },
        };
        runInNewContext(outputText, { exports, require: name => { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; } });
        for (const location of ['activity', 'topbar']) {
            const markup = renderToStaticMarkup(React.createElement(exports.GlobalUtilityActions, { location }));
            const expected = (location === 'activity') === visible ? 1 : 0;
            for (const label of ['Settings', 'Profile']) assert.equal((markup.match(new RegExp(`aria-label="${label}"`, 'g')) ?? []).length, expected);
        }
    }
});


const legacy = version => ({ version, visible: true, position: 'bottom', showLabels: true,
    order: [...domain.LEGACY_NAVIGATION_IDS], hidden: ['files', 'snippets'] });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function preferencesPort(initial, save = async () => {}) {
    let value = initial; let generation = 0; let loading = false;
    const writes = [];
    const port = {
        read: () => ({ loading, value, generation }),
        save: async (expected, next) => { writes.push({ expected: plain(expected), value: plain(next) }); await save(expected, next); },
        publish: (before, next) => {
            if (before.generation !== generation || before.value !== value || loading) return false;
            value = next; return true;
        },
    };
    return { port, writes, value: () => value, reload: next => { generation++; value = next; }, loading: next => { loading = next; } };
}

test('global navigation defaults are visible, strict, bounded and protect utility access', () => {
    assert.equal(domain.parseWorkspaceNavigation(undefined), domain.DEFAULT_WORKSPACE_NAVIGATION);
    assert.equal(domain.resolveWorkspaceNavigation(undefined), domain.DEFAULT_WORKSPACE_NAVIGATION);
    assert.equal(defaults().visible, true);
    assert.equal(defaults().workspaceTabsPosition, 'default', 'host strip sidebar placement remains opt-in');
    for (const bad of [null, [], {}, { ...defaults(), version: 99 }, { ...defaults(), extra: true },
        { ...defaults(), visible: 1 }, { ...defaults(), position: 'top' }, { ...defaults(), position: 'bottom' },
        { ...defaults(), order: ['hosts'] }, { ...defaults(), hidden: ['hosts', 'hosts'] },
        { ...defaults(), hidden: ['settings'] }, { ...defaults(), hidden: ['profile'] },
        { ...defaults(), workspaceTabsPosition: 'bottom' }, { ...defaults(), workspaceTabsPosition: undefined }]) {
        assert.equal(domain.parseWorkspaceNavigation(bad), null);
        assert.deepEqual(plain(domain.resolveWorkspaceNavigation(bad)), { ...defaults(), visible: false }, 'unsupported settings retain the hidden read-only fallback');
    }
    const parsed = domain.parseWorkspaceNavigation(defaults());
    parsed.order.reverse(); assert.notDeepEqual(plain(parsed), defaults());
});

test('workspace strip placement rejects non-string JSON values without changing the input', () => {
    for (const value of [null, true, false, 0, 1, {}, [], ['left', 'right']]) {
        const raw = { ...defaults(), workspaceTabsPosition: value };
        const before = structuredClone(raw);
        assert.equal(domain.parseWorkspaceNavigation(raw), null);
        assert.deepEqual(plain(domain.resolveWorkspaceNavigation(raw)), { ...defaults(), visible: false });
        assert.deepEqual(raw, before);
    }
});

test('global audits are additive to saved v3 navigation without a load-time rewrite', () => {
    const before = { ...defaults(), visible: false, position: 'right',
        order: defaults().order.filter(id => id !== 'security-audits'), hidden: ['tunnels'] };
    const original = structuredClone(before);
    assert.ok(domain.parseWorkspaceNavigation(before));
    const resolved = domain.resolveWorkspaceNavigation(before);
    assert.deepEqual(plain(resolved), before, 'old v3 navigation retains its exact saved choices');
    assert.deepEqual(before, original, 'loading never mutates the saved envelope');
    const projected = domain.navigationOrder(resolved, domain.NAVIGATION_IDS);
    assert.equal(projected.at(-1), 'security-audits', 'the new destination is appended for display');
    assert.equal(projected.filter(id => id === 'security-audits').length, 1);
    const edited = domain.changeWorkspaceNavigation(resolved, { type: 'hidden', id: 'security-audits', value: true });
    assert.deepEqual(Array.from(edited.hidden), ['tunnels', 'security-audits']);
    assert.equal(edited.visible, false); assert.equal(edited.position, 'right');
    assert.equal(edited.version, 3, 'explicit edits do not require a schema version bump');
    assert.ok(domain.parseWorkspaceNavigation(edited));
});

test('workspace strip placement rejects singleton arrays like the native codec', () => {
    for (const value of [['default'], ['left'], ['right']]) {
        assert.equal(domain.parseWorkspaceNavigation({ ...defaults(), workspaceTabsPosition: value }), null);
    }
});

test('legacy v1/v2 data projects global-only chrome without a load-time write or host-plugin promotion', () => {
    for (const version of [1, 2]) {
        const raw = legacy(version);
        if (version === 2) raw.order.push('plugin:owner:panel');
        const original = structuredClone(raw);
        assert.equal(domain.parseWorkspaceNavigation(raw).version, version);
        const resolved = domain.resolveWorkspaceNavigation(raw);
        assert.equal(resolved.version, 3); assert.equal(resolved.position, 'left');
        assert.deepEqual(Array.from(resolved.hidden), ['snippets']);
        for (const obsolete of ['files', 'dashboard', 'ai', 'plugin:owner:panel']) assert.equal(resolved.order.includes(obsolete), false);
        assert.deepEqual(raw, original);
        const updated = domain.changeWorkspaceNavigation(domain.parseWorkspaceNavigation(raw), { type: 'labels', value: false });
        assert.equal(updated.version, 3); assert.equal(updated.showLabels, false);
    }
});

test('saved visible and hidden choices survive resolution across every supported version', () => {
    for (const version of [1, 2, 3]) for (const visible of [false, true]) {
        const raw = { ...(version === 3 ? defaults() : legacy(version)), visible };
        const before = structuredClone(raw);
        const resolved = domain.resolveWorkspaceNavigation(raw);
        assert.equal(resolved.visible, visible);
        assert.equal(resolved.workspaceTabsPosition, 'default');
        assert.deepEqual(raw, before, 'resolving defaults never rewrites saved choices');
    }
});

test('global order, visibility and host-tab placement are independent bounded choices', () => {
    let current = domain.changeWorkspaceNavigation(defaults(), { type: 'move', id: 'snippets', targetId: 'hosts' });
    assert.equal(current.order[0], 'snippets');
    current = domain.changeWorkspaceNavigation(current, { type: 'hidden', id: 'snippets', value: true });
    current = domain.changeWorkspaceNavigation(current, { type: 'workspace-tabs', value: 'right' });
    current = domain.changeWorkspaceNavigation(current, { type: 'reset' });
    assert.equal(current.visible, true, 'Reset restores the visible activity-bar default');
    assert.equal(current.workspaceTabsPosition, 'right');
    assert.deepEqual(Array.from(current.hidden), []);
    for (const utility of ['settings', 'profile']) {
        assert.throws(() => domain.changeWorkspaceNavigation(current, { type: 'hidden', id: utility, value: true }));
        assert.equal(domain.changeWorkspaceNavigation(current, { type: 'move', id: utility, targetId: 'hosts' }), current);
    }
    assert.equal(domain.changeWorkspaceNavigation(current, { type: 'move', id: 'gone', targetId: 'hosts' }), current);
    assert.throws(() => domain.changeWorkspaceNavigation(current, { type: 'workspace-tabs', value: 'bottom' }));
});

test('canonical dormant plugin data stays bounded without making host plugins global entries', () => {
    const { pluginWorkspaceViewId, isPluginWorkspaceViewId } = load('src/features/workspace/domain/registrations.ts');
    for (const [owner, panel] of [['owner', 'owner:panel'], ['ä😀', '面板/one']]) assert.equal(isPluginWorkspaceViewId(pluginWorkspaceViewId(owner, panel)), true);
    for (const bad of ['plugin:owner:owner:panel', 'plugin::pane', 'plugin:owner:%ff', 'plugin:owner:%2f', 'plugin:owner:%70ane', 'plugin:owner:with%20space', 'plugin:owner:%E2%80%AE']) assert.equal(isPluginWorkspaceViewId(bad), false);
    const id = pluginWorkspaceViewId('owner', 'panel');
    const current = { ...defaults(), order: [...defaults().order, id], hidden: [id] };
    assert.ok(domain.parseWorkspaceNavigation(current));
    const { GLOBAL_NAVIGATION_ENTRIES: entries } = load('src/components/layout/navigation/navigationItems.ts');
    assert.equal(entries.some(entry => entry.id === id), false);
    const ids = Array.from({ length: 300 }, (_, index) => pluginWorkspaceViewId('owner', 'pane-' + index));
    assert.equal(domain.navigationOrder(defaults(), ids).length, domain.MAX_NAVIGATION_ITEMS);
});

test('serialized confirmed saves publish only after acknowledgement and compose rapid choices', async () => {
    const gate = deferred();
    const state = preferencesPort(undefined, async () => { await gate.promise; });
    const update = createNavigationUpdater(state.port);
    const first = update({ type: 'visible', value: false });
    const second = update({ type: 'move', id: 'snippets', targetId: 'hosts' });
    await Promise.resolve();
    assert.equal(state.value(), undefined); assert.equal(state.writes.length, 1);
    gate.resolve(); await Promise.all([first, second]);
    assert.equal(state.value().visible, false); assert.equal(state.value().order[0], 'snippets');
    assert.deepEqual(state.writes[0].expected, { exists: false });
    await update({ type: 'move', id: 'snippets', targetId: 'snippets' });
    assert.equal(state.writes.length, 2);
});

test('reload supersedes acknowledged writes, including absent-key ABA reloads', async () => {
    for (const fresh of [undefined, { version: 99, opaque: true }]) {
        const gate = deferred(); const state = preferencesPort(undefined, () => gate.promise);
        const saving = createNavigationUpdater(state.port)({ type: 'visible', value: false });
        await Promise.resolve(); state.reload(fresh); gate.resolve();
        await assert.rejects(saving, /settings changed/); assert.equal(state.value(), fresh);
    }
});

test('failed acknowledgement retries through native comparison even for an apparent reset no-op', async () => {
    let fail = true; const state = preferencesPort(undefined, async () => { if (fail) throw Error('lost reply'); });
    const update = createNavigationUpdater(state.port);
    await assert.rejects(update({ type: 'visible', value: false }), /lost reply/);
    assert.equal(state.value(), undefined);
    fail = false; await update({ type: 'reset' });
    assert.equal(state.writes.length, 2); assert.equal(state.value().visible, true);
});

test('unsupported and loading preferences refuse mutation without writing', async () => {
    for (const initial of [null, { version: 99 }, ...['default', 'left', 'right'].map(value => ({
        ...defaults(), workspaceTabsPosition: [value],
    }))]) {
        const state = preferencesPort(initial);
        await assert.rejects(createNavigationUpdater(state.port)({ type: 'reset' }));
        assert.equal(state.writes.length, 0); assert.equal(state.value(), initial);
    }
    const state = preferencesPort(undefined); state.loading(true);
    await assert.rejects(createNavigationUpdater(state.port)({ type: 'workspace-tabs', value: 'left' }));
    assert.equal(state.writes.length, 0);
});

test('navigation renders global destinations rather than active-host feature shortcuts', () => {
    const props = { hasWorkspace: false, keybindings: {}, onCommand() {}, onCustomize() {}, onGlobal() {} };
    assert.match(renderNavigation({ ...props, preferences: defaults() }), /aria-label="Global navigation"/, 'missing preferences render the default bar');
    assert.equal(renderNavigation({ ...props, preferences: { ...defaults(), visible: false } }), '', 'an explicit hidden choice still removes the bar');
    const html = renderNavigation({ ...props, preferences: { ...defaults(), visible: true, showLabels: true } });
    assert.match(html, /aria-label="Global navigation"/);
    for (const label of ['Hosts', 'Public URLs', 'Port Forwarding', 'Security hardening audit', 'Snippets', 'Vaults', 'Plugins']) assert.ok(html.includes('aria-label="' + label + '"'));
    assert.doesNotMatch(html, /data-navigation-item="workspace"/, 'workspace navigation is opt-in via strip placement');
    for (const label of ['Files', 'Dashboard', 'AI Command Bar']) assert.equal(html.includes('aria-label="' + label + '"'), false);
    assert.match(html, /data-tab-drag-axis="vertical"/); assert.doesNotMatch(html, /role="tab/);
    assert.doesNotMatch(html, /title=/, 'navigation uses shared tooltips, not native titles');
    const navigationButtons = html.match(/<button\b[^>]*data-workspace-tab-trigger[^>]*>/g) ?? [];
    assert.equal(navigationButtons.length, 8);
    for (const button of navigationButtons) {
        assert.match(button, /focus-visible:ring-1/);
        assert.match(button, /focus-visible:ring-inset/);
        assert.match(button, /focus-visible:ring-control-focus/);
        assert.doesNotMatch(button, /focus-visible:ring-2/, 'focus stays within the clipped icon strip');
    }
    assert.doesNotMatch(html, /<span class="min-w-0 truncate">/, 'legacy label preference cannot widen the icon bar');
    const hidden = renderNavigation({ ...props, preferences: { ...defaults(), visible: true, hidden: defaults().order.filter(id => !['settings', 'profile'].includes(id)) } });
    assert.equal((hidden.match(/<button /g) || []).length, 1);
});

test('every predefined destination has a configurable catalog command and matching hint', () => {
    const { GLOBAL_NAVIGATION_ENTRIES } = load('src/components/layout/navigation/navigationItems.ts');
    const { SHORTCUT_CATALOG } = load('src/features/shortcuts/catalog.ts');
    const { shortcutHint } = load('src/features/shortcuts/labels.ts');
    for (const entry of GLOBAL_NAVIGATION_ENTRIES) {
        const id = entry.shortcutId ?? entry.action.commandId;
        const command = SHORTCUT_CATALOG.find(row => row.id === id);
        assert.ok(command?.configurable && command.settingsKey && command.defaultKeys, entry.id);
        if (entry.action.kind === 'global' && entry.id !== 'hosts') assert.equal(command.navigationAction, entry.action.id);
        if (entry.id === 'hosts') assert.equal(id, 'toggleSidebar', 'visible Hosts uses the contextual sidebar shortcut');
        assert.ok(shortcutHint(id, {}));
        assert.ok(shortcutHint(id, { [command.settingsKey]: 'Ctrl+Shift+F9' }).startsWith('Ctrl+Shift+F9'));
        const alternatives = SHORTCUT_CATALOG.filter(row => row.actionId === id);
        const removed = Object.fromEntries([command, ...alternatives].map(row => [row.settingsKey, '']));
        assert.equal(shortcutHint(id, removed), undefined, 'removed bindings are absent from hints');
    }
    for (const id of ['navigationProfile', 'toggleSettings']) assert.ok(SHORTCUT_CATALOG.find(row => row.id === id)?.configurable);
});

test('all allocations keep one content cell and one retained iframe', () => {
    for (const position of ['left', 'right']) {
        const html = renderToStaticMarkup(React.createElement(NavigationFrame, { position, navigation: 'Navigation' }, React.createElement('iframe', { title: 'test' })));
        assert.equal((html.match(/data-workspace-body/g) || []).length, 1);
        assert.match(html, /grid-row:2;grid-column:2/); assert.equal((html.match(/<iframe/g) || []).length, 1);
    }
});

test('global navigation controller calls only explicit manager/selection ports', () => {
    const { activateGlobalNavigation } = load('src/features/workspace/application/globalNavigation.ts');
    const calls = [];
    const port = { showSection: section => calls.push(['section', section]), selectWorkspace: () => { calls.push(['workspace']); return true; },
        openPublicUrls: () => calls.push(['public']), openForwarding: () => calls.push(['forwarding']), openSnippets: () => calls.push(['snippets']),
        openSecurityAudits: () => calls.push(['audits']) };
    for (const action of ['hosts', 'vaults', 'plugins']) { calls.length = 0; assert.equal(activateGlobalNavigation(action, port), true); assert.deepEqual(calls, [['section', action]]); }
    for (const [action, result] of [['public-urls', 'public'], ['tunnels', 'forwarding'], ['snippets', 'snippets'], ['security-audits', 'audits']]) {
        calls.length = 0; activateGlobalNavigation(action, port); assert.deepEqual(calls, [[result], ['section', null]]);
    }
    calls.length = 0; assert.equal(activateGlobalNavigation('workspace', { ...port, selectWorkspace: () => false }), false); assert.deepEqual(calls, []);
    assert.equal(activateGlobalNavigation('files', port), false);
});

test('Plugins sidebar has installed/marketplace sections, grouped themes and an explicit Settings action', () => {
    const plugins = [
        { path: '/alpha', manifest: { id: 'tool.alpha', name: 'Alpha Tool', version: '1.2.0', description: 'A useful tool' }, enabled: true },
        { path: '/beta', manifest: { id: 'tool.beta', name: 'Beta Tool', version: '2.0.0' }, enabled: false },
        { path: 'builtin://dark', manifest: { id: 'com.zync.theme.dark', name: 'Dark Theme', type: 'theme' } },
        { path: 'builtin://light', manifest: { id: 'com.zync.theme.light', name: 'Light Theme', type: 'theme' } },
        { path: 'builtin://theme-manager', manifest: { id: 'com.zync.theme.manager', name: 'Internal manager' } },
    ];
    const calls = [];
    let query = '', section = 'installed';
    const { PluginsSidebarContent, installedPluginActions } = loadSource('components/plugins/PluginsSidebarContent.tsx', {
        react: { ...React, useState: initial => [initial === 'installed' ? section : query, () => {}] },
        'react/jsx-runtime': require('react/jsx-runtime'), 'lucide-react': require('lucide-react'),
        '../../features/plugins/presentation/pluginInventory': load('src/features/plugins/presentation/pluginInventory.ts'),
        '../ui/Button': load('src/components/ui/Button.tsx'), '../ui/IconButton': load('src/components/ui/IconButton.tsx'),
        '../ui/Input': load('src/components/ui/Input.tsx'), '../ui/Tooltip': load('src/components/ui/Tooltip.tsx'),
        '../ui/StateMessage': load('src/components/ui/StateMessage.tsx'),
        '../ui/controlStyles': load('src/components/ui/controlStyles.ts'),
        '../settings/common/SegmentedControl': load('src/components/settings/common/SegmentedControl.tsx'),
        '../settings/common/IconResolver': { IconResolver: () => null },
        '../layout/sidebar/SidebarActionButton': load('src/components/layout/sidebar/SidebarActionButton.tsx'),
        './PluginSidebarItem': load('src/components/plugins/PluginSidebarItem.tsx'),
    });
    const actions = Object.fromEntries(['onOpenSettings', 'onChooseTheme', 'onRefresh', 'onDetails', 'onToggle', 'onUninstall', 'onInspect', 'onRetryRuntime']
        .map(name => [name, argument => calls.push([name, argument])]));
    const props = { plugins, registry: [], loadingPlugins: false, loadingRegistry: false, busy: false, needsRestart: false, runtimeHealth: [], ...actions };
    const render = overrides => renderToStaticMarkup(React.createElement(TooltipProvider, null,
        React.createElement(PluginsSidebarContent, { ...props, ...overrides })));
    let html = render();
    assert.match(html, /Alpha Tool/); assert.match(html, /Beta Tool/);
    assert.match(html, /role="tab"[^>]*>Marketplace/); assert.match(html, /Enabled/); assert.match(html, /Disabled/);
    assert.match(html, /Zync Built-in Themes/); assert.match(html, /2 built-in themes/); assert.match(html, /Choose theme/);
    assert.doesNotMatch(html, /Dark Theme|Light Theme/);
    assert.match(html, /Actions for Alpha Tool/);
    assert.doesNotMatch(html, /Internal manager/);
    assert.match(html, /Plugin settings/); assert.doesNotMatch(html, /title=/);
    assert.deepEqual(calls, [], 'mounting and rendering do not open settings');
    query = 'TOOL.BETA'; html = render();
    assert.match(html, /Beta Tool/); assert.doesNotMatch(html, /Alpha Tool/);
    query = 'not found'; assert.match(render(), /No matching plugins/);
    query = ''; assert.match(render({ plugins: [] }), /No plugins installed/);
    html = render({ loadingPlugins: true }); assert.match(html, /Loading plugins/); assert.doesNotMatch(html, /Alpha Tool/);
    assert.match(render({ pluginsError: 'Could not load installed plugins' }), /role="alert"/);
    section = 'marketplace';
    html = render({ registry: [{ id: 'verified', name: 'Verified plugin', version: '1.0.0', registryVerified: true },
        { id: 'legacy', name: 'Unverified plugin', version: '1.0.0' }] });
    assert.match(html, /Verified plugin/); assert.match(html, /Review &amp; install/); assert.match(html, /Unverified catalog entry/);
    assert.match(html, /disabled=""[^>]*>Review &amp; install/);
    assert.deepEqual(calls, [], 'browsing either section never opens settings or installs a plugin');
    const items = installedPluginActions(plugins[0], undefined, undefined, actions);
    for (const label of ['Details and permissions', 'Disable', 'Uninstall']) items.find(item => item.label === label).action();
    assert.deepEqual(calls.map(([name]) => name), ['onDetails', 'onToggle', 'onUninstall']);
    const builtinItems = installedPluginActions({ ...plugins[0], path: 'builtin://editor' }, undefined, undefined, actions);
    assert.equal(builtinItems.some(item => item.label === 'Uninstall'), false);
});
