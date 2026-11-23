import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { loadSource } from './helpers/loadSource.mjs';

const require = createRequire(import.meta.url);
const runtime = require('react/jsx-runtime');
const { Provider } = require('@radix-ui/react-tooltip');
const controls = loadSource('components/ui/controlStyles.ts');
const utils = loadSource('lib/utils.ts', {
    clsx: require('clsx'),
    'tailwind-merge': require('tailwind-merge'),
});
let captured = [];
const jsx = Object.fromEntries(
    ['jsx', 'jsxs'].map((name) => [
        name,
        (type, props, key) => {
            captured.push({ type, props });
            return runtime[name](type, props, key);
        },
    ]),
);
jsx.Fragment = runtime.Fragment;
const common = {
    react: require('react'),
    'react/jsx-runtime': jsx,
    'lucide-react': require('lucide-react'),
    '../../lib/utils': utils,
    '../../lib/utils.js': utils,
    '../../../lib/utils': utils,
    './controlStyles.js': controls,
    '../../ui/controlStyles': controls,
};
const { Button } = loadSource('components/ui/Button.tsx', common);
const { IconButton } = loadSource('components/ui/IconButton.tsx', {
    ...common,
    './Button.js': { Button },
});
const { Tooltip } = loadSource('components/ui/Tooltip.tsx', {
    ...common,
    '@radix-ui/react-tooltip': require('@radix-ui/react-tooltip'),
});
common['../../ui/Tooltip'] = { Tooltip };
const calls = [];
const state = {
    activeConnectionId: 'host',
    tabs: [{ connectionId: 'host' }],
    settings: { compactMode: false },
    openTab: (id) => calls.push(['open', id]),
    disconnect: (id) => calls.push(['disconnect', id]),
};
common['../../../store/useAppStore'] = { useAppStore: (selector) => selector(state) };
const { SidebarSection } = loadSource('components/layout/sidebar/SidebarSection.tsx', {
    ...common,
    '../../ui/ZPortal': { ZPortal: ({ children }) => children },
});
const { SidebarActionButton } = loadSource(
    'components/layout/sidebar/SidebarActionButton.tsx',
    common,
);
const { SplitSidebarActionButton } = loadSource(
    'components/layout/sidebar/SplitSidebarActionButton.tsx',
    common,
);
const { ConnectionItem } = loadSource('components/layout/sidebar/ConnectionItem.tsx', {
    '../../../features/connections/domain/hostAppearance': loadSource(
        'features/connections/domain/hostAppearance.ts',
    ),
    ...common,
    '../../ui/IconButton': { IconButton },
    '../../../lib/dragDrop': { getCurrentDragSource: () => null },
    '../../icons/OSIcon': { OSIcon: () => null },
    './HostLocationChips': { HostLocationChips: () => null },
    '../../../features/connections/presentation/useConnectionDisplayLabels': {
        useConnectionDisplayLabels: (conn) => ({
            primary: conn.name,
            secondary: conn.host,
            ariaLabel: conn.name,
        }),
    },
});
const conn = {
    id: 'host',
    name: 'Fixture host',
    host: 'example.invalid',
    username: 'fixture',
    port: 22,
    status: 'connected',
};
function render(component, props) {
    captured = [];
    calls.length = 0;
    return renderToStaticMarkup(
        React.createElement(Provider, null, React.createElement(component, props)),
    );
}
function assertInset(html) {
    const controls =
        html.match(/<(?:button|div)\b[^>]*(?:role="button"|type="button")[^>]*>/g) ?? [];
    assert.ok(controls.length > 0);
    for (const element of controls) {
        for (const token of [
            'focus-visible:ring-1',
            'focus-visible:ring-inset',
            'focus-visible:ring-control-focus',
        ]) {
            assert.ok(element.includes(token), element);
        }
        assert.doesNotMatch(element, /focus-visible:ring-2|focus-visible:ring-offset/);
    }
    assert.doesNotMatch(html, /\stitle=/);
}

test('sidebar headers and split actions use contained theme focus without native tooltips', () => {
    assertInset(
        render(SidebarSection, {
            title: 'All Hosts',
            count: 102,
            variant: 'action',
            createMenu: [{ id: 'host', label: 'New host', onSelect() {} }],
        }),
    );
    assert.ok(
        captured.some(
            ({ type, props }) => type === Tooltip && props.content === 'Create in All Hosts',
        ),
    );
    assertInset(render(SidebarActionButton, { label: 'Forwarding', onClick() {} }));
    assertInset(
        render(SplitSidebarActionButton, {
            label: 'Vault',
            expanded: true,
            badge: 3,
            badgeTitle: '3 unsecured hosts',
            toggleAriaLabel: 'Toggle vault menu',
            onPrimaryClick() {},
            onToggleClick() {},
        }),
    );
    assert.deepEqual(
        captured.filter((item) => item.type === Tooltip).map((item) => item.props.content),
        ['3 unsecured hosts', 'Toggle vault menu'],
    );
});

test('host icon actions share styled tooltips and preserve click/keyboard isolation', () => {
    assertInset(
        render(ConnectionItem, {
            conn,
            isCollapsed: false,
            onEdit: (host) => calls.push(['edit', host.id]),
            onOpenContextMenu() {},
        }),
    );
    assert.deepEqual(
        captured.filter((item) => item.type === Tooltip).map((item) => item.props.content),
        ['Connected', 'Disconnect', 'Edit connection'],
    );
    const row = captured.find((item) => item.props.role === 'button').props;
    for (const [label, action] of [
        ['Disconnect', 'disconnect'],
        ['Edit connection', 'edit'],
    ]) {
        const button = captured.find(
            (item) => item.type === IconButton && item.props.label === label,
        ).props;
        let stopped = false;
        const event = {
            stopPropagation() {
                stopped = true;
            },
        };
        button.onClick(event);
        assert.equal(stopped, true);
        assert.deepEqual(calls.pop(), [action, 'host']);
        for (const key of ['Enter', ' ']) {
            stopped = false;
            button.onKeyDown({
                ...event,
                key,
                preventDefault() {
                    assert.fail('Native button activation must remain available');
                },
            });
            assert.equal(stopped, true);
        }
    }
    assert.equal(calls.length, 0);
    row.onKeyDown({ key: 'Enter', preventDefault() {} });
    assert.deepEqual(calls, [['open', 'host']]);
});

test('background, connecting and error status hints use Zync tooltip with conditional disconnect', () => {
    for (const [status, tabs, hint] of [
        ['connected', [], 'Connected (background)'],
        ['connecting', [], 'Connecting…'],
        ['error', [], 'Connection error'],
        ['disconnected', [], undefined],
    ]) {
        state.tabs = tabs;
        const html = render(ConnectionItem, {
            conn: { ...conn, status },
            isCollapsed: false,
            onEdit() {},
            onOpenContextMenu() {},
        });
        assertInset(html);
        const hints = captured
            .filter((item) => item.type === Tooltip)
            .map((item) => item.props.content);
        assert.equal(hints.includes('Disconnect'), status === 'connected');
        if (hint) {
            assert.ok(hints.includes(hint));
        } else {
            assert.deepEqual(hints, ['Edit connection']);
        }
    }
});
