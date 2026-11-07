import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

import type { ContextMenuItem } from '../../src/components/ui/ContextMenu.js';
import type { Tab } from '../../src/features/connections/domain/types.js';
import * as sidebarPresentation from '../../src/features/workspace/application/sidebarPresentation.js';
import type {
    ChromeActionArea,
    ChromeActionChange,
    ChromeActionId,
} from '../../src/features/workspace/domain/chromeActions.js';
import * as domain from '../../src/features/workspace/domain/chromeActions.js';

/** Render production components with explicit boundary substitutes and actual preference policy. */
function source<T>(
    path: string,
    dependencies: Record<string, unknown>,
    globals: Record<string, unknown> = {},
): T {
    const module = { exports: {} };
    runInNewContext(
        ts.transpileModule(readFileSync(resolve(path), 'utf8'), {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
                jsx: ts.JsxEmit.ReactJSX,
            },
        }).outputText,
        {
            module,
            exports: module.exports,
            ...globals,
            require: (name: string) => {
                assert.ok(Object.hasOwn(dependencies, name), name);
                return dependencies[name];
            },
        },
    );
    return module.exports as T;
}
const chrome = source<typeof import('../../src/components/layout/ChromeActionItems.js')>(
    'src/components/layout/ChromeActionItems.tsx',
    {
        react: React,
        'react/jsx-runtime': jsx,
        '../../features/workspace/domain/chromeActions': domain,
    },
);
/** Preserve indicator identity and theme classes while replacing unrelated subscription-owning controls. */
const marker = (name: string) => (props: React.HTMLAttributes<HTMLElement>) =>
    React.createElement('span', { 'data-indicator': name, className: props.className }, name);
type ActionItem = Extract<ContextMenuItem, { action: () => void }>;
const isAction = (item: ContextMenuItem): item is ActionItem =>
    'action' in item && typeof item.action === 'function';
const menuModule = source<typeof import('../../src/components/layout/chromeVisibilityMenu.js')>(
    'src/components/layout/chromeVisibilityMenu.ts',
    {
        '../../features/workspace/domain/chromeActions': domain,
    },
);

/** Visibility menus contain actions; fail if a separator or submenu unexpectedly enters the policy projection. */
function chromeVisibilityMenu(
    ...args: Parameters<typeof menuModule.chromeVisibilityMenu>
): ActionItem[] {
    const items = menuModule.chromeVisibilityMenu(...args);
    assert.ok(items.every(isAction));
    return items;
}

/** Render the actual status bar with SSH or a standalone profile selected. */
function status(
    value: unknown,
    { rightBell = true, tab }: { rightBell?: boolean; tab?: Tab } = {},
) {
    const state = {
        activeConnectionId: tab ? null : 'ssh',
        activeTabId: tab?.id ?? null,
        tabs: tab ? [tab] : [],
        connections: [{ id: 'ssh', status: 'connected', name: 'Host A' }],
        settings: { chromeActions: value, statusBar: {}, keybindings: {} },
        editorDiagnosticsCount: 2,
        editorDiagnosticsSeverity: 'error',
        editorDiagnosticsVisible: false,
        lastAction: { type: 'error', message: 'Protected failure message' },
    };
    const latency: Array<{
        connectionId: string | null | undefined;
        enabled: boolean;
        isLive: boolean;
    }> = [];
    const Icon = marker('icon');
    const { StatusBar } = source<typeof import('../../src/components/layout/StatusBar.js')>(
        'src/components/layout/StatusBar.tsx',
        {
            '../../features/workspace/application/sidebarPresentation': sidebarPresentation,
            '../../features/shortcuts/actions': { runShortcutCommand() {} },
            'react/jsx-runtime': jsx,
            'lucide-react': {
                Cable: marker('serial-icon'),
                CircleAlert: Icon,
                Monitor: marker('monitor-icon'),
                PanelLeft: Icon,
                Sparkles: Icon,
                Wifi: Icon,
                WifiOff: Icon,
            },
            '../../features/connections/application/tabService': {
                LOCAL_TERMINAL_CONNECTION_ID: 'local',
            },
            '../../features/editor/editorStatus': { useEditorStatus: () => 'Line 7, Column 3' },
            '../../lib/shortcuts': { formatShortcutLabel: (value: string) => value },
            '../../store/useAppStore': {
                useAppStore: (select: (snapshot: typeof state) => unknown) => select(state),
            },
            './ChromeActionItems': chrome,
            './useChromeCustomizationMenu': { useChromeCustomizationMenu: () => ({}) },
            '../../lib/utils': { cn: (...values: unknown[]) => values.filter(Boolean).join(' ') },
            '../ui/Tooltip': { Tooltip: ({ children }: React.PropsWithChildren) => children },
            '../file-manager/StatusBarTransferIndicator': {
                StatusBarTransferIndicator: marker('transfers'),
            },
            '../../features/updater/StatusBarUpdateIndicator': {
                StatusBarUpdateIndicator: marker('updates'),
            },
            '../../features/feedbackInbox/StatusBarInboxIndicator': {
                StatusBarInboxIndicator: marker('inbox'),
            },
            '../notifications/NotificationBell': {
                NotificationBell: marker('notifications'),
                useNotificationBellPlacement: () => ({
                    showInStatusLeft: !rightBell,
                    showInStatusRight: rightBell,
                }),
            },
            '../../features/statusBar': {
                DEFAULT_STATUS_BAR_SETTINGS: { showConnectionLatency: true },
                StatusBarLatency: marker('latency'),
                useConnectionLatency: (options: (typeof latency)[number]) => {
                    latency.push(options);
                    return 20;
                },
            },
        },
        { window: { electronUtils: { platform: 'win32' } } },
    );
    return { html: renderToStaticMarkup(React.createElement(StatusBar)), latency };
}

test('real status bar keeps mandatory indicators, connection identity and latency when optional controls are hidden', () => {
    let preferences = domain.parseChromeActions(undefined)!;
    preferences = domain.changeChromeActions(preferences, {
        type: 'hidden',
        id: 'status.editor',
        value: true,
    })!;
    preferences = domain.changeChromeActions(preferences, {
        type: 'hidden',
        id: 'status.ai',
        value: true,
    })!;
    const { html, latency } = status(preferences);
    assert.doesNotMatch(html, /Line 7|Toggle AI Sidebar/);
    for (const text of [
        'transfers',
        'updates',
        'inbox',
        'notifications',
        'Protected failure message',
        'Host A',
        'Show diagnostics (2)',
        'Hide Sidebar',
    ]) {
        assert.ok(html.includes(text), text);
    }
    assert.deepEqual(structuredClone(latency), [
        { connectionId: 'ssh', enabled: true, isLive: true },
    ]);
});

test('status ordering changes only its lane and notification placement remains feature-owned', () => {
    const defaults = status(undefined).html;
    const preferences = domain.changeChromeActions(domain.parseChromeActions(undefined)!, {
        type: 'move',
        id: 'status.ai',
        targetId: 'status.editor',
    })!;
    const html = status(preferences).html;
    assert.ok(defaults.indexOf('Line 7') < defaults.indexOf('Toggle AI Sidebar'));
    assert.ok(html.indexOf('Toggle AI Sidebar') < html.indexOf('Line 7'));
    assert.ok(html.indexOf('Host A') < html.indexOf('Toggle AI Sidebar'));
    const leftBell = status(preferences, { rightBell: false }).html;
    assert.equal((leftBell.match(/data-indicator="notifications"/g) || []).length, 1);
    assert.ok(leftBell.indexOf('data-indicator="notifications"') < leftBell.indexOf('Host A'));
    assert.equal(
        status({ version: 99 }).html,
        defaults,
        'Unsupported raw preferences display safe defaults',
    );
});

test('standalone Serial and VNC profiles show neutral identity without SSH latency or no-connection text', () => {
    for (const [type, title, icon] of [
        ['serial', 'Router console', 'serial-icon'],
        ['vnc', 'Office desktop', 'monitor-icon'],
    ] as const) {
        const { html, latency } = status(undefined, {
            tab: { id: `${type}-tab`, type, title, view: type },
        });
        assert.ok(html.includes(title));
        assert.ok(html.includes(`data-indicator="${icon}" class="text-app-muted shrink-0"`));
        assert.doesNotMatch(html, /No Connection|Host A|data-indicator="latency"/);
        assert.deepEqual(structuredClone(latency), [
            { connectionId: null, enabled: true, isLive: false },
        ]);
    }
});

test('customization editor offers visibility and scoped reset only, while explaining action groups', () => {
    const { ChromeActionsSection } = source<
        typeof import('../../src/components/settings/tabs/layout/ChromeActionsSection.js')
    >('src/components/settings/tabs/layout/ChromeActionsSection.tsx', {
        react: React,
        'react/jsx-runtime': jsx,
        '../../../../features/workspace/domain/chromeActions': domain,
        '../../common/Section': { Section: ({ children }: React.PropsWithChildren) => children },
        '../../../ui/Button': {
            Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
                React.createElement('button', props, children),
        },
        '../../../ui/Switch': {
            Switch: ({
                label,
                checked,
                disabled,
                showLabel,
                description,
            }: {
                label: string;
                checked: boolean;
                disabled?: boolean;
                showLabel?: boolean;
                description?: string;
            }) =>
                React.createElement(
                    'button',
                    { role: 'switch', 'aria-label': label, 'aria-checked': checked, disabled },
                    showLabel && label,
                    description,
                ),
        },
    });
    const render = (area: ChromeActionArea) =>
        renderToStaticMarkup(
            React.createElement(ChromeActionsSection, {
                area,
                value: undefined,
                onChange: async () => {},
            }),
        );
    const html = render('workspaceToolbar');
    for (const markup of [html, render('statusBar')]) {
        assert.doesNotMatch(markup, /draggable|Drag |Move |change the order|Workspace layouts/);
        assert.equal(
            (markup.match(/<button(?![^>]*role="switch")/g) ?? []).length,
            1,
            'only the scoped reset button remains alongside visibility switches',
        );
    }
    assert.match(html, /split buttons show or hide together/);
    assert.match(html, /session snippets and terminal controls/);
    assert.match(html, /The Add button stays available/);
    for (const area of domain.CHROME_ACTION_AREAS) {
        const markup = render(area);
        const expected = domain.CHROME_ACTIONS.filter(
            (action) => action.area === area && action.optional,
        );
        assert.equal((markup.match(/data-chrome-action-row=/g) ?? []).length, expected.length);
        for (const action of expected) {
            assert.ok(
                markup.includes(`>${action.label}`),
                'shared labeled switch renders a clickable label',
            );
        }
        for (const action of domain.CHROME_ACTIONS.filter(
            (action) => action.area === area && !action.optional,
        )) {
            assert.ok(
                !markup.includes(`data-chrome-action-row="${action.id}"`),
                'protected actions are not presented as editable rows',
            );
        }
        assert.doesNotMatch(markup, /Always available when relevant/);
    }
    assert.match(
        render('statusBar'),
        /Essential status indicators and sidebar recovery remain available when needed/,
    );
});

test('visibility menus mirror optional Settings choices, saved order and checks, protecting loading/future choices', () => {
    const calls: Array<[ChromeActionId, boolean]> = [];
    let value = domain.parseChromeActions(undefined)!;
    value = domain.changeChromeActions(value, {
        type: 'hidden',
        id: 'terminal.find',
        value: true,
    })!;
    value = domain.changeChromeActions(value, {
        type: 'move',
        id: 'workspace.sessionTools',
        targetId: 'terminal.find',
    })!;
    const toolbar = chromeVisibilityMenu(value, 'workspaceToolbar', (...args) => calls.push(args));
    assert.deepEqual(
        Array.from(toolbar, (item) => item.label),
        ['Session tools', 'Find in terminal', 'Split controls'],
    );
    assert.equal(toolbar[1].checked, false);
    toolbar[1].action();
    toolbar[0].action();
    assert.deepEqual(Array.from(calls), [
        ['terminal.find', false],
        ['workspace.sessionTools', true],
    ]);
    const status = chromeVisibilityMenu(value, 'statusBar', (...args) => calls.push(args));
    assert.deepEqual(
        Array.from(status, (item) => item.label),
        ['Editor position', 'AI assistant'],
    );
    assert.ok(status.every((item) => item.checked && !item.disabled));
    status[0].action();
    assert.deepEqual(calls.at(-1), ['status.editor', true]);
    const movedStatus = domain.changeChromeActions(value, {
        type: 'move',
        id: 'status.ai',
        targetId: 'status.editor',
    })!;
    const hiddenStatus = domain.changeChromeActions(movedStatus, {
        type: 'hidden',
        id: 'status.ai',
        value: true,
    })!;
    const recovery = chromeVisibilityMenu(hiddenStatus, 'statusBar', (...args) => calls.push(args));
    assert.deepEqual(
        Array.from(recovery, (item) => item.label),
        ['AI assistant', 'Editor position'],
    );
    assert.equal(recovery[0].checked, false);
    recovery[0].action();
    assert.deepEqual(calls.at(-1), ['status.ai', false]);
    for (const [preferences, busy] of [
        [{ version: 99 }, false],
        [undefined, true],
    ] as const) {
        for (const area of domain.CHROME_ACTION_AREAS) {
            const entries = chromeVisibilityMenu(
                preferences,
                area,
                () => assert.fail('read-only menu'),
                busy,
            );
            assert.deepEqual(
                Array.from(entries, (item) => item.label),
                Array.from(
                    domain.CHROME_ACTIONS.filter(
                        (action) => action.area === area && action.optional,
                    ),
                    (action) => action.label,
                ),
            );
            for (const entry of entries) {
                assert.equal(entry.disabled, true);
                entry.action();
            }
        }
    }
});

test('shared chrome context shortcuts route both areas, respect nested menus and restore keyboard focus', async () => {
    for (const area of domain.CHROME_ACTION_AREAS) {
        let anchor: { x: number; y: number; keyboard: boolean } | null = null;
        let saving = false;
        let stateIndex = 0;
        let refIndex = 0;
        const refs: Array<{ current: unknown }> = [];
        const calls: unknown[] = [];
        const body = {};
        const document: { body: object; activeElement: object } = { body, activeElement: body };
        class Element {
            closest() {
                return opener;
            }
        }
        const opener = {
            isConnected: true,
            focus: () => {
                calls.push('focus');
                document.activeElement = opener;
            },
        };
        const store = {
            settings: {} as { chromeActions?: unknown },
            openSettings: (...args: unknown[]) => calls.push(args),
            updateChromeActions: async (_intent: ChromeActionChange): Promise<void> => {},
            showToast: (...args: unknown[]) => calls.push(args),
        };
        const { useChromeCustomizationMenu } = source<
            typeof import('../../src/components/layout/useChromeCustomizationMenu.js')
        >(
            'src/components/layout/useChromeCustomizationMenu.tsx',
            {
                react: {
                    useEffect() {},
                    useRef: (initial: unknown) => (refs[refIndex++] ??= { current: initial }),
                    useState: () =>
                        stateIndex++ === 0
                            ? [
                                  anchor,
                                  (next: typeof anchor) => {
                                      anchor = next;
                                  },
                              ]
                            : [
                                  saving,
                                  (next: boolean) => {
                                      saving = next;
                                  },
                              ],
                },
                'react/jsx-runtime': jsx,
                '../../store/useAppStore': {
                    useAppStore: (select: (snapshot: typeof store) => unknown) => select(store),
                },
                '../ui/ContextMenu': { ContextMenu: () => null },
                './chromeVisibilityMenu': { chromeVisibilityMenu },
            },
            { document, Element },
        );
        const render = () => {
            stateIndex = 0;
            refIndex = 0;
            return useChromeCustomizationMenu(area);
        };
        const currentAnchor = (): { x: number; y: number; keyboard: boolean } => {
            assert.ok(anchor);
            return anchor;
        };
        const menu = () => {
            const value = render().menu;
            assert.ok(value);
            return value;
        };
        const event = {
            target: new Element(),
            currentTarget: { getBoundingClientRect: () => ({ left: 10, bottom: 20 }) },
            clientX: 30,
            clientY: 40,
            key: 'F10',
            shiftKey: true,
            defaultPrevented: false,
            stopped: false,
            preventDefault() {
                this.defaultPrevented = true;
            },
            stopPropagation() {
                this.stopped = true;
            },
        };
        render().onContextMenu({
            ...event,
            defaultPrevented: true,
        } as unknown as React.MouseEvent<HTMLElement>);
        assert.equal(anchor, null);
        render().onContextMenu(event as unknown as React.MouseEvent<HTMLElement>);
        assert.equal(currentAnchor().keyboard, false);
        assert.equal(currentAnchor().x, 30);
        assert.equal(event.stopped, true);
        event.defaultPrevented = false;
        render().onKeyDown(event as unknown as React.KeyboardEvent<HTMLElement>);
        assert.equal(currentAnchor().keyboard, true);
        assert.equal(currentAnchor().x, 10);
        assert.equal(currentAnchor().y, 20);
        assert.equal(menu().props.autoFocus, true);
        menu().props.items.at(-1).action();
        assert.deepEqual(Array.from(calls), ['focus', ['layout', area]]);
        calls.length = 0;
        document.activeElement = { closest: () => null };
        menu().props.onClose();
        assert.deepEqual(Array.from(calls), [], 'outside-control focus is not stolen');
        assert.equal(anchor, null);
        render().item.action?.();
        assert.deepEqual(
            Array.from(calls),
            [['layout', area]],
            'an embedding menu retains ownership of its opener',
        );
        calls.length = 0;
        let reject: (error: Error) => void = () => assert.fail('No pending save');
        store.updateChromeActions = (intent: ChromeActionChange) => {
            calls.push(structuredClone(intent));
            return new Promise((_, fail) => {
                reject = fail;
            });
        };
        const optional = render()
            .items.filter(isAction)
            .find((entry) => entry.checked !== undefined && !entry.disabled)!;
        optional.action();
        optional.action();
        assert.equal(calls.length, 1, 'pending changes reject duplicate actions');
        assert.equal((calls[0] as ChromeActionChange).type, 'hidden');
        assert.equal((calls[0] as Extract<ChromeActionChange, { type: 'hidden' }>).value, true);
        assert.ok(
            render()
                .items.filter(isAction)
                .filter((entry) => entry.checked !== undefined)
                .every((entry) => entry.disabled),
        );
        reject(Error('private failure details'));
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(saving, false);
        assert.deepEqual(calls[1], [
            'error',
            'Could not save action visibility. Please try again.',
        ]);
        assert.equal(
            store.settings.chromeActions,
            undefined,
            'a failed save does not optimistically change checks',
        );
    }
});
