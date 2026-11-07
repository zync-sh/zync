import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import { Plus } from 'lucide-react';
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

import { Button } from '../.tmp-agent-tests/src/components/ui/Button.js';
import * as layout from '../.tmp-agent-tests/src/lib/paneLayout/index.js';
import { loadWorkspaceDomain } from './helpers/loadWorkspaceDomain.mjs';

function loadSource(path, dependencies = {}, globals = {}) {
    const { outputText } = ts.transpileModule(
        readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'),
        {
            fileName: path,
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
                jsx: ts.JsxEmit.ReactJSX,
            },
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
const presentation = loadSource('src/features/workspace/domain/presentation.ts');
const metadata = loadSource('src/features/workspace/domain/contentPresentation.ts', {
    './presentation': presentation,
});
const projection = loadSource('src/features/workspace/domain/tabPresentation.ts', {
    './contentPresentation': metadata,
});
const chromeActions = loadSource('src/components/layout/ChromeActionItems.tsx', {
    react: React,
    'react/jsx-runtime': jsx,
    '../../features/workspace/domain/chromeActions': loadWorkspaceDomain(
        'features/workspace/domain/chromeActions.ts',
    ),
});
const inventory = loadSource('src/features/workspace/domain/contentInventory.ts', {
    '../../../lib/paneLayout/contentIdentity': layout,
    '../../../lib/paneLayout/query': layout,
});
const termId = layout.paneContentKey({ kind: 'term', termId: 'shell' }, 'shell');
const featureId = layout.paneContentKey(
    { kind: 'feature', featureId: 'files', instanceId: 'files-one' },
    'files-pane',
);
const pluginId = layout.paneContentKey(
    { kind: 'plugin', pluginId: 'owner:panel', instanceId: 'plugin-one' },
    'plugin-pane',
);
const tabs = [
    { id: 'shell-tab', contentIds: [termId] },
    { id: 'files-tab', contentIds: [featureId] },
    { id: 'plugin-tab', contentIds: [pluginId] },
];
const ids = (result) => Array.from(result, (value) => value.item.id);

test('default and alias-only metadata preserve exact default tab order and item references', () => {
    for (const scope of [
        undefined,
        { version: 2, items: { [pluginId]: { displayAlias: 'Plugin name' } } },
    ]) {
        const result = projection.projectWorkspaceTabs(tabs, scope);
        assert.deepEqual(
            ids(result),
            tabs.map((item) => item.id),
        );
        assert.ok(result.every((value, index) => value.item === tabs[index] && !value.pinned));
    }
});

test('pins and saved order cross content types without mutating the canonical inventory', () => {
    const scope = {
        version: 2,
        items: { [pluginId]: { pinned: true } },
        order: [featureId, termId, pluginId],
    };
    const result = projection.projectWorkspaceTabs(tabs, scope);
    assert.deepEqual(ids(result), ['plugin-tab', 'files-tab', 'shell-tab']);
    assert.deepEqual(
        Array.from(result, (item) => item.pinned),
        [true, false, false],
    );
    assert.deepEqual(
        tabs.map((item) => item.id),
        ['shell-tab', 'files-tab', 'plugin-tab'],
    );
});

test('a split appears once and follows the earliest projected member rather than its mutable owner', () => {
    const scope = {
        version: 2,
        items: { [pluginId]: { pinned: true } },
        order: [termId, featureId, pluginId],
    };
    for (const owner of ['original-owner', 'promoted-owner']) {
        const grouped = [tabs[0], { id: owner, contentIds: [featureId, pluginId] }];
        const result = projection.projectWorkspaceTabs(grouped, scope);
        assert.deepEqual(ids(result), [owner, 'shell-tab']);
        assert.equal(result[0].pinned, true);
        assert.equal(result.length, 2);
    }
    assert.deepEqual(
        ids(projection.projectWorkspaceTabs(tabs, scope)),
        ['plugin-tab', 'shell-tab', 'files-tab'],
        'ungrouped members recover their own ranks',
    );
});

test('stale preferences never create tabs and new live content retains default relative order', () => {
    const scope = { version: 2, items: { absent: { pinned: true } }, order: ['absent', pluginId] };
    assert.deepEqual(ids(projection.projectWorkspaceTabs(tabs, scope)), [
        'plugin-tab',
        'shell-tab',
        'files-tab',
    ]);
    assert.deepEqual(ids(projection.projectWorkspaceTabs([], scope)), []);
});

const Icon = () => React.createElement('svg', { 'aria-hidden': true });
const groupChrome = loadSource('src/components/layout/PaneGroupTabChrome.tsx', {
    'react/jsx-runtime': jsx,
});
const addTooltips = [];
const { TabAddButton } = loadSource('src/components/layout/TabAddButton.tsx', {
    react: React,
    'react/jsx-runtime': jsx,
    'lucide-react': { Plus },
    '../ui/Button': { Button },
    '../ui/Tooltip': {
        Tooltip: (props) => {
            addTooltips.push(props);
            return props.children;
        },
    },
    '../../lib/utils': { cn: (...values) => values.filter(Boolean).join(' ') },
});

test('both tab strips share add-button sizing, icon, native semantics and themed menu state', () => {
    for (const label of ['Create or go', 'Open a tab']) {
        for (const open of [false, true]) {
            const html = renderToStaticMarkup(
                React.createElement(TabAddButton, {
                    label,
                    open,
                    id: 'add-trigger',
                    'aria-controls': 'add-menu',
                }),
            );
            assert.equal((html.match(/<button\b/g) ?? []).length, 1);
            assert.match(html, /type="button"/);
            assert.ok(html.includes(`aria-label="${label}"`));
            assert.ok(html.includes(`aria-expanded="${open}"`));
            assert.match(html, /aria-haspopup="dialog"/);
            assert.match(html, /id="add-trigger"/);
            assert.match(html, /aria-controls="add-menu"/);
            assert.match(html, /h-7 w-7/);
            assert.match(html, /<svg[^>]*class="[^"]*h-4 w-4"[^>]*aria-hidden="true"/);
            assert.match(html, /stroke-width="2"/);
            assert.doesNotMatch(html, /title=|text-white|stroke-width="3"/);
            assert.ok(
                html.includes(
                    open
                        ? 'bg-app-accent/20 text-app-text'
                        : 'text-app-muted hover:bg-app-surface hover:text-app-text',
                ),
            );
            assert.equal(addTooltips.at(-1).content, label);
            assert.equal(addTooltips.at(-1).disabled, open);
        }
    }
    for (const path of ['TabBar', 'CombinedTabBar']) {
        const source = readFileSync(
            new URL(`../src/components/layout/${path}.tsx`, import.meta.url),
            'utf8',
        );
        assert.match(source, /import \{ TabAddButton \} from '\.\/TabAddButton'/);
        assert.equal((source.match(/<TabAddButton\b/g) ?? []).length, 1);
        assert.doesNotMatch(source, /<Plus\b/);
    }
});

test('shared add button forwards its native focus ref and caller event handlers', () => {
    const ref = React.createRef();
    const clicked = [];
    const onClick = (event) => clicked.push(event);
    const onKeyDown = () => {};
    const element = TabAddButton.render(
        { label: 'Open a tab', open: false, onClick, onKeyDown, disabled: true },
        ref,
    );
    const button = element.props.children;
    assert.equal(button.props.ref, ref);
    assert.equal(button.props.onClick, onClick);
    assert.equal(button.props.onKeyDown, onKeyDown);
    assert.equal(button.props.disabled, true);
    const event = {};
    button.props.onClick(event);
    assert.deepEqual(clicked, [event]);
});

test('group chrome describes actual members, bounds icon density and preserves full accessible names', () => {
    const members = ['Shell A', 'Files', 'Plugin A', 'Shell B'].map((label, index) => ({
        id: String(index),
        label,
        icon: React.createElement(Icon),
    }));
    for (const count of [1, 2, 3, 4]) {
        const selected = members.slice(0, count);
        const summary = groupChrome.describePaneGroup(selected, 4 - count);
        assert.equal(summary.count, count);
        assert.equal(
            summary.label,
            count === 2 ? 'Shell A · Files' : count > 2 ? `Shell A · ${count} panes` : 'Shell A',
        );
        for (const member of selected) {
            assert.ok(summary.description.includes(member.label));
        }
        const markup = renderToStaticMarkup(
            React.createElement(groupChrome.PaneGroupTabIcon, { members: selected }),
        );
        assert.equal((markup.match(/<svg/g) ?? []).length, Math.min(2, count));
        assert.equal((markup.match(/data-pane-group-member=/g) ?? []).length, Math.min(2, count));
        assert.match(markup, /inline-flex h-5/);
        assert.doesNotMatch(
            markup,
            /\babsolute\b/,
            'Member icons must remain readable, not overlap',
        );
        assert.doesNotMatch(markup, /<button/);
        assert.equal(
            summary.closeDescription,
            `Close pane group (4 panes${count < 4 ? `, including ${4 - count} hidden` : ''}): ${count === 2 ? 'Shell A · Files' : 'Shell A'}`,
        );
    }
    assert.equal(
        groupChrome.describePaneGroup([], 2).description,
        'Pane group, 0 visible panes (2 hidden)',
    );
});
test('compact group separators preserve user aliases and count only visible members', () => {
    const members = Object.freeze([
        Object.freeze({ id: 'a', label: 'C++ project', icon: null }),
        Object.freeze({ id: 'b', label: '日本語 · Files', icon: null }),
        Object.freeze({ id: 'c', label: 'Plugin', icon: null }),
    ]);
    assert.equal(
        groupChrome.describePaneGroup(members.slice(0, 2), 2).label,
        'C++ project · 日本語 · Files',
    );
    const summary = groupChrome.describePaneGroup(members, 1);
    assert.equal(summary.label, 'C++ project · 3 panes');
    assert.equal(
        summary.description,
        'Pane group, 3 visible panes: C++ project, 日本語 · Files, Plugin (1 hidden)',
    );
    assert.equal(
        summary.closeDescription,
        'Close pane group (4 panes, including 1 hidden): C++ project',
    );
});

test('shared pane drag preview contains the resource icon and title only', () => {
    const { TabDragPreview } = loadSource('src/components/layout/TabDragPreview.tsx', {
        'react/jsx-runtime': jsx,
    });
    const markup = renderToStaticMarkup(
        React.createElement(TabDragPreview, { icon: React.createElement(Icon) }, 'Shell A'),
    );
    assert.match(markup, /Shell A/);
    assert.equal(
        (markup.match(/<svg/g) ?? []).length,
        1,
        'Only the supplied resource icon is rendered',
    );
    assert.doesNotMatch(markup, /<button|lucide-x/);
});

test('group drag preview shares compact tab spacing without changing host preview density', () => {
    const preview = loadSource('src/components/layout/TabDragPreview.tsx', {
        'react/jsx-runtime': jsx,
    });
    const compact = renderToStaticMarkup(
        React.createElement(
            preview.TabDragPreview,
            {
                compact: true,
                icon: React.createElement(Icon),
            },
            groupChrome.describePaneGroup([
                { id: 'a', label: 'Shell A' },
                { id: 'b', label: 'Files' },
                { id: 'c', label: 'Plugin' },
            ]).label,
        ),
    );
    assert.ok(compact.includes(preview.COMPACT_TAB_ROW_CLASSES));
    assert.ok(compact.includes(preview.COMPACT_TAB_LABEL_CLASSES));
    assert.doesNotMatch(compact, /py-1\.5|<button/);
    assert.match(compact, /Shell A · 3 panes/);
    assert.doesNotMatch(compact, /data-pane-group-count/);
    const host = renderToStaticMarkup(
        React.createElement(preview.TabDragPreview, { icon: null }, 'Host'),
    );
    assert.match(host, /h-8 text-sm/);
});

test('content strip and empty recovery area do not opt into native window dragging', () => {
    for (const items of [
        {},
        { [termId]: { hidden: true }, [featureId]: { hidden: true }, [pluginId]: { hidden: true } },
    ]) {
        const markup = renderStrip({ version: 3, items });
        assert.match(markup, /data-workspace-tab-strip/);
        assert.match(markup, /aria-label="Workspace tabs"[^>]*class="[^"]*\bdrag-none\b/);
        assert.doesNotMatch(markup, /app-drag-region|data-tauri-drag-region/);
    }
});

function renderStrip(
    scope,
    {
        grouped = false,
        legacyPinned = false,
        actionPreferences,
        navigation,
        tools = false,
        docking = {},
        dockFocus = null,
        activeView = 'files',
        findProbe = {},
        extraTerminals = [],
    } = {},
) {
    const files = layout.singleFeaturePane('files', 'files-pane', 'files-one');
    const plugin = layout.singlePluginPane('owner:panel', 'plugin-pane', 'plugin-one');
    const paneGroups = grouped
        ? {
              'files-one': layout.splitPane(
                  files,
                  files.root.id,
                  'horizontal',
                  plugin.root.content,
                  4,
                  'after',
                  plugin.root.id,
              ).layout,
          }
        : { 'files-one': files, 'plugin-one': plugin };
    const terminals = [{ id: 'shell', title: 'Shell A' }, ...extraTerminals];
    const state = {
        terminals: { local: terminals },
        paneLayouts: { local: paneGroups },
        workspaceDocking: docking,
        workspaceDockFocus: { local: dockFocus },
        activeTerminalIds: { local: 'shell' },
        contentPresentation: { local: scope },
        activePaneGroupOwner: { local: null },
        settings: { chromeActions: actionPreferences, workspaceNavigation: navigation },
    };
    const component = loadSource(
        'src/components/layout/CombinedTabBar.tsx',
        {
            react: React,
            'react/jsx-runtime': Object.fromEntries(
                Object.entries(jsx).map(([name, factory]) => [
                    name,
                    typeof factory !== 'function'
                        ? factory
                        : (type, props, ...rest) => {
                              if (
                                  type === 'button' &&
                                  props?.['aria-label'] === 'Find in terminal'
                              ) {
                                  findProbe.click = props.onClick;
                              }
                              return factory(type, props, ...rest);
                          },
                ]),
            ),
            '../../store/useAppStore': { useAppStore: (selector) => selector(state) },
            '../../features/workspace/domain/navigation': loadWorkspaceDomain(
                'features/workspace/domain/navigation.ts',
            ),
            '../../features/workspace/domain/registrations': loadWorkspaceDomain(
                'features/workspace/domain/registrations.ts',
            ),
            '../ui/MenuSubmenu': { isInsideMenu: () => false },
            './ChromeActionItems': chromeActions,
            './useChromeCustomizationMenu': { useChromeCustomizationMenu: () => ({}) },
            './TabDragPreview': loadSource('src/components/layout/TabDragPreview.tsx', {
                'react/jsx-runtime': jsx,
            }),
            './PaneGroupTabChrome': groupChrome,
            './TabAddButton': { TabAddButton },
            './ContentTabTrigger': loadSource('src/components/layout/ContentTabTrigger.tsx', {
                'react/jsx-runtime': jsx,
                '../workspace/DockIndicator': loadSource(
                    'src/components/workspace/DockIndicator.tsx',
                    {
                        'react/jsx-runtime': jsx,
                        'lucide-react': {
                            PanelBottom: Icon,
                            PanelLeft: Icon,
                            PanelRight: Icon,
                            PanelsTopLeft: Icon,
                        },
                        '../../lib/utils': { cn: (...args) => args.filter(Boolean).join(' ') },
                    },
                ),
            }),
            './navigation/WorkspaceStripHandle': { WorkspaceStripHandle: () => null },
            'zustand/react/shallow': { useShallow: (selector) => selector },
            '../../lib/utils': { cn: (...args) => args.filter(Boolean).join(' ') },
            '../../features/workspace/domain/contentInventory': inventory,
            '../../features/workspace/domain/presentation': presentation,
            '../../features/workspace/domain/tabPresentation': projection,
            '../../features/workspace/domain/docking': loadWorkspaceDomain(
                'features/workspace/domain/docking.ts',
            ),
            '../../features/workspace/domain/dockingView': loadWorkspaceDomain(
                'features/workspace/domain/dockingView.ts',
            ),
            '../../features/workspace/domain/dockPresentation': loadWorkspaceDomain(
                'features/workspace/domain/dockPresentation.ts',
            ),
            'lucide-react': {
                FolderOpen: Icon,
                Plus: Icon,
                X: Icon,
                Pin: Icon,
                PanelRight: Icon,
                Search: Icon,
                Terminal: Icon,
            },
            '../ui/ContextMenu': { ContextMenu: () => null },
            '../workspace/workspaceActionsContext': { useWorkspaceContextActions: () => null },
            '../icons/ShellIcon': { ShellIcon: Icon },
            '../icons/PluginIcon': { PluginIcon: Icon },
            './featureMeta': { FEATURE_META: { files: { label: 'Files', icon: Icon } } },
            '../../lib/shortcuts': { formatShortcutLabel: (value) => value },
            '../../features/shortcuts/catalog': { SHORTCUT_CATALOG: [] },
            '../../features/shortcuts/labels': loadWorkspaceDomain('features/shortcuts/labels.ts'),
            '../../store/settingsSlice': {
                defaultSettings: { keybindings: { splitPanes: 'Ctrl+Shift+D' } },
            },
            '../ui/Tooltip': { Tooltip: ({ children }) => children },
            '../../lib/paneLayout': layout,
            './workspaceOpen': { WorkspaceOpenMenu: () => null },
            './tabDock': {
                useDockTabPointer: () => ({ begin: () => {}, consumeClickIfDragged: () => false }),
                splitOpenMenuItems: () => [],
            },
            '../../lib/dragDrop': { useInternalFileDrag: () => false },
            '../../lib/terminal/fileDropToTerminal': { acceptFilePathDrag: () => false },
            '../../lib/terminal/connectionIds': loadWorkspaceDomain(
                'lib/terminal/connectionIds.ts',
            ),
            '../../lib/terminal/pasteFileDropToTerminal': { pasteFilePathsIntoTerminal: () => {} },
            '../../lib/terminal/terminalCache': {
                terminalCache: new Map(
                    terminals.map((term) => [term.id, { term: { element: `${term.id}-element` } }]),
                ),
            },
            '../../lib/terminal/terminalInteraction': {
                openTerminalFind: (element) => {
                    findProbe.target = element;
                },
            },
        },
        { window: {} },
    );
    const noop = () => {};
    return renderToStaticMarkup(
        React.createElement(component.CombinedTabBar, {
            connectionId: 'local',
            tabId: 'main',
            activeView,
            activeTerminalId: 'shell',
            featureTabs: [
                {
                    id: legacyPinned ? 'pinned:files' : 'files-one',
                    featureId: 'files',
                    instanceId: 'files-one',
                },
            ],
            activeFeatureTabId: 'files-one',
            pinnedFeatures: legacyPinned ? ['files'] : [],
            pluginPanels: [{ id: 'owner:panel', title: 'Plugin A', allowMultiple: true }],
            onTabSelect: noop,
            onPluginTabSelect: noop,
            onPluginTabClose: noop,
            onFeatureTabSelect: noop,
            onFeatureTabClose: noop,
            onTerminalClose: noop,
            onNewTerminal: noop,
            onTogglePin: noop,
            onSplit: tools ? noop : undefined,
            onToggleSessionTools: tools ? noop : undefined,
        }),
    );
}

test('Find follows visible dock focus instead of the selected center tab', () => {
    const docking = { local: { version: 1, placements: { [termId]: 'secondary-sidebar' } } };
    const findProbe = {};
    assert.match(
        renderStrip(undefined, { docking, dockFocus: termId, findProbe }),
        /aria-label="Find in terminal"/,
    );
    findProbe.click();
    assert.equal(findProbe.target, 'shell-element');
    assert.doesNotMatch(
        renderStrip(
            { version: 3, items: { [termId]: { hidden: true } } },
            { docking, dockFocus: termId },
        ),
        /aria-label="Find in terminal"/,
    );
    assert.doesNotMatch(
        renderStrip(undefined, {
            activeView: 'terminal',
            docking: { local: { version: 1, placements: { [featureId]: 'secondary-sidebar' } } },
            dockFocus: featureId,
        }),
        /aria-label="Find in terminal"/,
    );
    assert.match(
        renderStrip(undefined, { activeView: 'terminal' }),
        /aria-label="Find in terminal"/,
    );
});

test('Find opens the docked shell search rather than a different center shell search', () => {
    const dockKey = layout.paneContentKey({ kind: 'term', termId: 'second' }, 'second');
    const findProbe = {};
    renderStrip(undefined, {
        activeView: 'terminal',
        extraTerminals: [{ id: 'second', title: 'Shell B' }],
        docking: { local: { version: 1, placements: { [dockKey]: 'secondary-sidebar' } } },
        dockFocus: dockKey,
        findProbe,
    });
    findProbe.click();
    assert.equal(findProbe.target, 'second-element');
});

test('production strip renders mixed content in projected DOM order and keeps pinned close actions', () => {
    const defaultMarkup = renderStrip();
    assert.ok(defaultMarkup.indexOf('Shell A') < defaultMarkup.indexOf('Files'));
    assert.ok(defaultMarkup.indexOf('Files') < defaultMarkup.indexOf('Plugin A'));
    const markup = renderStrip({
        version: 2,
        items: { [pluginId]: { pinned: true } },
        order: [featureId, termId, pluginId],
    });
    assert.ok(markup.indexOf('Plugin A') < markup.indexOf('Files'));
    assert.ok(markup.indexOf('Files') < markup.indexOf('Shell A'));
    assert.match(markup, /aria-label="Close Plugin A"/);
    assert.equal((markup.match(/title="Pinned content"/g) ?? []).length, 1);
    assert.doesNotMatch(markup, /style="[^"]*order:/);
});

test('every docked content kind keeps its tab and exposes shared location/focus markers without native titles', () => {
    const docking = {
        local: {
            version: 1,
            placements: {
                [termId]: 'primary-sidebar',
                [featureId]: 'secondary-sidebar',
                [pluginId]: 'bottom-panel',
            },
        },
    };
    for (const dockFocus of [termId, featureId, pluginId]) {
        const html = renderStrip(undefined, { docking, dockFocus });
        assert.equal((html.match(/data-dock-indicator="true"/g) ?? []).length, 3);
        assert.equal((html.match(/data-dock-focused="true"/g) ?? []).length, 1);
        for (const location of ['left', 'right', 'bottom']) {
            assert.ok(html.includes(`Docked ${location}`));
        }
        assert.ok(html.includes('focused dock'));
        assert.doesNotMatch(html, /title="(?:Files|Plugin A|Shell A)"/);
        assert.equal((html.match(/data-workspace-tab-trigger="true"/g) ?? []).length, 3);
    }
    assert.doesNotMatch(
        renderStrip(undefined, { docking: { local: { ...docking.local, version: 99 } } }),
        /data-dock-indicator/,
    );
    const hidden = renderStrip(
        { version: 3, items: { [pluginId]: { hidden: true } } },
        { docking, dockFocus: pluginId },
    );
    assert.equal((hidden.match(/data-dock-indicator="true"/g) ?? []).length, 2);
    assert.doesNotMatch(hidden, /focused dock/);
});

test('mixed groups describe their persistent members without falsely claiming focus-only activation', () => {
    const docking = { local: { version: 1, placements: { [featureId]: 'secondary-sidebar' } } };
    const html = renderStrip(undefined, { grouped: true, docking, dockFocus: featureId });
    assert.match(html, /Includes panes docked right/);
    assert.doesNotMatch(html, /focused dock/);
    assert.equal((html.match(/data-dock-indicator="true"/g) ?? []).length, 1);
});

test('host tab placement changes one existing inventory, not main host tabs or content order', () => {
    const defaults = loadWorkspaceDomain(
        'features/workspace/domain/navigation.ts',
    ).DEFAULT_WORKSPACE_NAVIGATION;
    for (const position of ['default', 'left', 'right']) {
        const markup = renderStrip(undefined, {
            navigation: { ...defaults, workspaceTabsPosition: position },
        });
        assert.match(
            markup,
            new RegExp(
                `data-tab-drag-axis="${position === 'default' ? 'horizontal' : 'vertical'}"`,
            ),
        );
        assert.equal((markup.match(/data-tab-drag-strip=/g) ?? []).length, 1);
        for (const label of ['Close Shell A', 'Close Files', 'Close Plugin A']) {
            assert.equal((markup.match(new RegExp(`aria-label="${label}"`, 'g')) ?? []).length, 1);
        }
        assert.ok(markup.indexOf('Shell A') < markup.indexOf('Files'));
        assert.ok(markup.indexOf('Files') < markup.indexOf('Plugin A'));
    }
});

test('production split tab follows a pinned child once; legacy launcher semantics remain separate', () => {
    const markup = renderStrip(
        { version: 2, items: { [pluginId]: { pinned: true } } },
        { grouped: true },
    );
    assert.ok(markup.indexOf('Files · Plugin A') < markup.indexOf('Shell A'));
    assert.equal(
        (markup.match(/aria-label="Close pane group \(2 panes\): Files · Plugin A"/g) ?? []).length,
        1,
    );
    assert.equal((markup.match(/title="Pinned content"/g) ?? []).length, 1);
    assert.doesNotMatch(markup, /aria-label="Close Plugin A"|aria-label="Close Files"/);
    const launcherMarkup = renderStrip(undefined, { legacyPinned: true });
    assert.doesNotMatch(launcherMarkup, /aria-label="Close Files"|title="Pinned content"/);
});

test('group chrome follows aliases and hidden members without changing group content identity', () => {
    const markup = renderStrip(
        { version: 3, items: { [featureId]: { displayAlias: 'Project files' } } },
        { grouped: true },
    );
    assert.match(markup, /aria-label="Pane group, 2 visible panes: Project files, Plugin A"/);
    assert.match(markup, /data-tab-label[^>]*>Project files · Plugin A</);
    assert.doesNotMatch(markup, /data-pane-group-count/);
    assert.doesNotMatch(markup, /Split 1/);
    const hidden = renderStrip(
        { version: 3, items: { [featureId]: { hidden: true } } },
        { grouped: true },
    );
    assert.match(hidden, /aria-label="Pane group, 1 visible pane: Plugin A \(1 hidden\)"/);
    assert.match(hidden, /data-tab-label[^>]*>Plugin A</);
    assert.doesNotMatch(hidden, /data-pane-group-count/);
    assert.match(hidden, /aria-label="Close pane group \(2 panes, including 1 hidden\): Plugin A"/);
    assert.ok(hidden.includes(JSON.stringify([featureId, pluginId]).replaceAll('"', '&quot;')));
});

test('native content selection controls name their action and keep close buttons as siblings', () => {
    for (const grouped of [false, true]) {
        const markup = renderStrip(undefined, { grouped });
        const buttons = markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
        const triggers = buttons.filter((button) => button.includes('data-workspace-tab-trigger'));
        assert.equal(triggers.length, grouped ? 2 : 3);
        for (const trigger of triggers) {
            assert.match(trigger, /type="button"/);
            assert.match(trigger, /aria-label="[^"]+"/);
            assert.match(trigger, /aria-pressed="(?:true|false)"/);
            assert.equal((trigger.match(/<button\b/g) ?? []).length, 1);
            assert.doesNotMatch(trigger, /aria-label="Close /);
        }
        assert.doesNotMatch(markup, /role="group"[^>]*tabindex="0"/);
    }
});

test('real toolbar projects registered actions without changing content or opening resources', () => {
    const { parseChromeActions, changeChromeActions } = loadWorkspaceDomain(
        'features/workspace/domain/chromeActions.ts',
    );
    const first = renderStrip(undefined, { tools: true });
    assert.ok(
        first.indexOf('aria-label="Split side by side"') <
            first.indexOf('aria-label="Toggle session tools"'),
    );
    const moved = changeChromeActions(parseChromeActions(undefined), {
        type: 'move',
        id: 'workspace.sessionTools',
        targetId: 'workspace.splits',
    });
    const reordered = renderStrip(undefined, { tools: true, actionPreferences: moved });
    assert.ok(
        reordered.indexOf('aria-label="Toggle session tools"') <
            reordered.indexOf('aria-label="Split side by side"'),
    );
    const hidden = changeChromeActions(moved, {
        type: 'hidden',
        id: 'workspace.splits',
        value: true,
    });
    const markup = renderStrip(undefined, { tools: true, actionPreferences: hidden });
    assert.doesNotMatch(markup, /aria-label="Split side by side"/);
    assert.match(markup, /aria-label="Toggle session tools"/);
    for (const title of ['Shell A', 'Files', 'Plugin A']) {
        assert.ok(markup.includes(title));
    }
    assert.equal(
        renderStrip(undefined, { tools: true, actionPreferences: { version: 99 } }),
        first,
    );
});
