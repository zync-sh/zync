import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWorkspaceOpenItems } from '../../src/components/layout/workspaceOpen/buildWorkspaceOpenItems';
import {
    filterWorkspaceOpenItems,
    groupWorkspaceOpenItems,
    visibleWorkspaceOpenItems,
    workspaceOpenEscapeAction,
} from '../../src/components/layout/workspaceOpen/filterWorkspaceOpenItems';
import { canOpenFeatureInWorkspace } from '../../src/features/workspace/domain/registrations';

test('includes New Shell and registered plugin panes', () => {
    const items = buildWorkspaceOpenItems({
        shells: [{ id: 'bash', label: 'Bash' }],
        canOpenFeature: true,
        features: [{ id: 'files', isOpen: true, isActive: false }],
        plugins: [{ id: 'dev.example:monitor', title: 'Process Monitor', isOpen: false }],
    });
    assert.equal(
        items.some((item) => item.kind === 'new-shell'),
        true,
    );
    assert.equal(
        items.some((item) => item.kind === 'plugin' && item.pluginId === 'dev.example:monitor'),
        true,
    );
    assert.equal(
        items.some((item) => item.kind === 'feature' && item.featureId === 'files'),
        true,
    );
});

test('labels an existing plugin pane as Open rather than New tab', () => {
    const items = buildWorkspaceOpenItems({
        shells: [],
        canOpenFeature: true,
        features: [],
        plugins: [{ id: 'dev.example:monitor', title: 'Process Monitor', isOpen: true }],
    });
    const plugin = items.find((item) => item.kind === 'plugin');
    assert.equal(plugin?.hint, 'Open');
});

test('omits feature rows when the workspace cannot open features', () => {
    const items = buildWorkspaceOpenItems({
        shells: [],
        canOpenFeature: false,
        features: [{ id: 'files', isOpen: false, isActive: false }],
    });
    assert.equal(
        items.every((item) => item.kind !== 'feature'),
        true,
    );
});

test('keeps the active feature available for another tab', () => {
    const items = buildWorkspaceOpenItems({
        shells: [],
        canOpenFeature: true,
        features: [{ id: 'dashboard', isOpen: true, isActive: true }],
    });
    const dashboard = items.find((item) => item.featureId === 'dashboard');
    assert.ok(dashboard);
    assert.equal(dashboard.disabled, undefined);
    assert.equal(dashboard.hint, 'New tab');
});

test('root hides individual shells behind Other shells', () => {
    const items = buildWorkspaceOpenItems({
        shells: [
            { id: 'pwsh', label: 'PowerShell' },
            { id: 'bash', label: 'Bash' },
        ],
        canOpenFeature: true,
        features: [],
    });
    const root = visibleWorkspaceOpenItems(items, '', 'root');
    assert.equal(
        root.some((item) => item.kind === 'other-shells'),
        true,
    );
    assert.equal(
        root.some((item) => item.kind === 'shell'),
        false,
    );
    assert.equal(
        root.some((item) => item.kind === 'feature'),
        true,
    );
});

test('search on root still finds shells', () => {
    const items = buildWorkspaceOpenItems({
        shells: [{ id: 'pwsh', label: 'PowerShell' }],
        canOpenFeature: true,
        features: [],
    });
    const files = filterWorkspaceOpenItems(items, 'file');
    assert.equal(
        files.some((item) => item.id === 'feature:files'),
        true,
    );
    assert.equal(
        files.every(
            (item) =>
                item.label.toLowerCase().includes('file') ||
                item.keywords.some((k) => k.includes('file')),
        ),
        true,
    );
    const found = visibleWorkspaceOpenItems(items, 'power', 'root');
    assert.equal(
        found.some((item) => item.kind === 'shell'),
        true,
    );
    assert.equal(
        found.some((item) => item.kind === 'other-shells'),
        false,
    );
    assert.equal(visibleWorkspaceOpenItems(items, 'zzzz', 'root').length, 0);
});

test('shells view lists only shells', () => {
    const items = buildWorkspaceOpenItems({
        shells: [{ id: 'pwsh', label: 'PowerShell' }],
        canOpenFeature: true,
        features: [],
    });
    const listed = visibleWorkspaceOpenItems(items, '', 'shells');
    assert.equal(listed.length, 1);
    assert.equal(listed[0].kind, 'shell');
});

test('Escape goes back from Other shells and closes on root', () => {
    assert.equal(workspaceOpenEscapeAction('shells'), 'back');
    assert.equal(workspaceOpenEscapeAction('root'), 'close');
});

test('groups drop empty sections', () => {
    const items = buildWorkspaceOpenItems({
        shells: [],
        canOpenFeature: false,
    });
    const groups = groupWorkspaceOpenItems(items);
    assert.deepEqual(
        groups.map((section) => section.group),
        ['create'],
    );
});

test('does not add extra Files in split rows', () => {
    const items = buildWorkspaceOpenItems({
        shells: [],
        canOpenFeature: true,
        features: [{ id: 'files', isOpen: false, isActive: false }],
    });
    assert.equal(
        items.some((item) => item.kind === 'feature' && item.featureId === 'files'),
        true,
    );
    assert.equal(
        items.every((item) => item.kind !== 'split-feature'),
        true,
    );
    assert.equal(
        items.some((item) => item.label.endsWith(' in split')),
        false,
    );
});

test('omits Files when the workspace cannot open features', () => {
    const items = buildWorkspaceOpenItems({
        shells: [],
        canOpenFeature: false,
        features: [{ id: 'files', isOpen: false, isActive: false }],
    });
    assert.equal(
        items.some((item) => item.featureId === 'files'),
        false,
    );
    assert.equal(
        items.every((item) => item.kind !== 'feature' && item.kind !== 'split-feature'),
        true,
    );
});

test('open menu stays at tab rows and never adds split-feature entries', () => {
    const items = buildWorkspaceOpenItems({
        shells: [],
        canOpenFeature: true,
        features: [
            { id: 'files', isOpen: true, isActive: false },
            { id: 'port-forwarding', isOpen: true, isActive: false },
            { id: 'dashboard', isOpen: true, isActive: false },
            { id: 'snippets', isOpen: true, isActive: false },
        ],
    });
    const features = items.filter((item) => item.kind === 'feature');
    const creatable = ['files', 'port-forwarding', 'dashboard', 'snippets', 'security', 'vnc'];
    assert.deepEqual(
        features.map((item) => item.featureId),
        creatable,
    );
    assert.equal(features.length, creatable.length);
    assert.equal(items.filter((item) => item.kind === 'new-shell').length, 1);
    assert.equal(
        items.every((item) => item.kind !== 'split-feature'),
        true,
    );
    assert.equal(items.length, creatable.length + 1);
    assert.equal(
        canOpenFeatureInWorkspace('serial', 'local'),
        true,
        'Existing Serial panes remain registered even though new sessions use saved connections',
    );
    for (const workspaceScope of ['local', 'remote'] as const) {
        const scopedFeatures = buildWorkspaceOpenItems({
            shells: [],
            canOpenFeature: true,
            workspaceScope,
        }).filter((item) => item.kind === 'feature');
        assert.equal(
            scopedFeatures.some((item) => item.featureId === 'serial'),
            false,
        );
        assert.equal(
            scopedFeatures.some((item) => item.featureId === 'vnc'),
            workspaceScope === 'remote',
        );
    }
});
