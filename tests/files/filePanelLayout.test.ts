import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { KeyboardEvent } from 'react';
import * as jsx from 'react/jsx-runtime';

import type { FilePanelLayout } from '../../src/components/file-manager/filePanelLayout';
import { isMatch } from '../../src/lib/keyboard';
import { loadSource } from './helpers/loadSource';

const chrome = loadSource<typeof import('../../src/components/file-manager/fileChrome')>(
    'components/file-manager/fileChrome.ts',
);
const policy = loadSource<typeof import('../../src/components/file-manager/filePanelLayout')>(
    'components/file-manager/filePanelLayout.ts',
    { './fileChrome': chrome },
);
const { filePanelLayout } = policy;
const inlineBudget =
    chrome.FILE_PLACES_WIDTH_PX +
    chrome.FILE_PROPERTIES_WIDTH_PX +
    chrome.FILE_INSPECTOR_LISTING_MIN_WIDTH_PX;

test('Places uses its existing pane-width boundary and narrow panes retain modal surfaces', () => {
    for (const width of [NaN, Infinity, -1, 0, chrome.FILE_CHROME_NARROW_MAX - 1]) {
        assert.equal(filePanelLayout(width).placesInline, false);
        assert.equal(filePanelLayout(width).propertiesInline, false);
    }
    assert.equal(filePanelLayout(chrome.FILE_CHROME_NARROW_MAX).placesInline, true);
});

test('Properties reserves enough room for Places and the listing regardless of toggle state', () => {
    const propertiesAndListing =
        chrome.FILE_PROPERTIES_WIDTH_PX + chrome.FILE_INSPECTOR_LISTING_MIN_WIDTH_PX;
    for (let width = propertiesAndListing; width < inlineBudget; width++) {
        assert.equal(filePanelLayout(width).propertiesInline, false);
    }
    for (const width of [inlineBudget, inlineBudget + 1, inlineBudget * 2]) {
        assert.equal(filePanelLayout(width).propertiesInline, true);
        assert.ok(
            width - chrome.FILE_PLACES_WIDTH_PX - chrome.FILE_PROPERTIES_WIDTH_PX >=
                chrome.FILE_INSPECTOR_LISTING_MIN_WIDTH_PX,
        );
    }
});

test('resize measurements share presentation identity until a boundary changes', () => {
    assert.equal(filePanelLayout(1), filePanelLayout(chrome.FILE_CHROME_NARROW_MAX - 1));
    assert.equal(filePanelLayout(chrome.FILE_CHROME_NARROW_MAX), filePanelLayout(inlineBudget - 1));
    assert.equal(filePanelLayout(inlineBudget), filePanelLayout(inlineBudget * 2));
    assert.notEqual(filePanelLayout(inlineBudget - 1), filePanelLayout(inlineBudget));
});

test('the pane observer publishes mode changes, retains hidden-pane layout and disconnects', () => {
    const effects: (() => () => void)[] = [];
    const published: FilePanelLayout[] = [];
    const node = { clientWidth: inlineBudget + 50 };
    let observerCallback: () => void = () => {
        throw new Error('ResizeObserver was not registered');
    };
    let disconnected = false;
    let initial: FilePanelLayout | undefined;
    const { useFilePanelLayout } = loadSource<
        typeof import('../../src/components/file-manager/useFilePanelLayout')
    >(
        'components/file-manager/useFilePanelLayout.ts',
        {
            './filePanelLayout': policy,
            react: {
                useLayoutEffect: (effect: () => () => void) => effects.push(effect),
                useState: (initialize: () => FilePanelLayout) => {
                    initial = initialize();
                    return [initial, (next: FilePanelLayout) => published.push(next)];
                },
            },
        },
        {
            ResizeObserver: class {
                constructor(callback: () => void) {
                    observerCallback = callback;
                }
                observe(target: HTMLElement) {
                    assert.equal(target, node);
                }
                disconnect() {
                    disconnected = true;
                }
            },
        },
    );

    useFilePanelLayout({ current: node as unknown as HTMLElement });
    assert.ok(initial);
    assert.equal(
        initial.propertiesInline,
        false,
        'Unmeasured layout does not assume the window is the pane',
    );
    const cleanup = effects[0]();
    assert.equal(published.length, 1);
    assert.equal(published[0].propertiesInline, true);
    for (let width = node.clientWidth - 1; width >= inlineBudget; width--) {
        node.clientWidth = width;
        observerCallback();
    }
    assert.equal(published.length, 1, 'Resize pixels within one presentation never publish');
    node.clientWidth = 0;
    observerCallback();
    assert.equal(published.length, 1, 'Hiding a retained pane does not migrate its inspector');
    node.clientWidth = inlineBudget - 1;
    observerCallback();
    assert.equal(published.length, 2);
    assert.equal(published[1].placesInline, true);
    assert.equal(published[1].propertiesInline, false);
    node.clientWidth = chrome.FILE_CHROME_NARROW_MAX - 1;
    observerCallback();
    assert.equal(published.length, 3);
    assert.equal(published[2].placesInline, false);
    cleanup();
    assert.equal(disconnected, true);
});

test('inline Properties owns Escape even after tooltip dismissal, while modal details defer to the dialog', () => {
    const stub = () => null;
    const { PropertiesPanel } = loadSource<
        typeof import('../../src/components/file-manager/PropertiesPanel')
    >('components/file-manager/PropertiesPanel.tsx', {
        'react/jsx-runtime': jsx,
        'lucide-react': { Folder: stub, Info: stub, X: stub },
        './FileEntryIcon': { FileEntryIcon: stub },
        '../../lib/keyboard': { isMatch },
        '../../features/files/domain/filePermissions': { unixModeString: stub },
        './FilePermissionsSection': { FilePermissionsSection: stub },
        './FolderSizeValue': { FolderSizeValue: stub },
        '../ui/Button': { Button: stub },
        './fileSelectionSummary': {
            fileSelectionSummary: () => ({}),
            fileSelectionSizeLabel: () => '',
        },
        '../../lib/utils': {
            cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
            formatBytes: String,
        },
        './fileGridLayout': { formatFileListDate: String, formatFileListType: String },
        '../ui/IconButton': { IconButton: stub },
        '../ui/Tooltip': { Tooltip: stub },
    });
    for (const showHeader of [true, false]) {
        for (const overrides of [
            {},
            { defaultPrevented: true },
            { key: 'Enter' },
            { isComposing: true },
            { ctrlKey: true },
        ]) {
            let closes = 0,
                prevented = false,
                stopped = false;
            const event = {
                key: 'Escape',
                ctrlKey: false,
                metaKey: false,
                altKey: false,
                shiftKey: false,
                isComposing: false,
                ...overrides,
            };
            const panel = PropertiesPanel({ files: [], onClose: () => closes++, showHeader });
            const props = panel.props as { onKeyDown: (event: KeyboardEvent<HTMLElement>) => void };
            props.onKeyDown({
                nativeEvent: event,
                preventDefault: () => {
                    prevented = true;
                },
                stopPropagation: () => {
                    stopped = true;
                },
            } as unknown as KeyboardEvent<HTMLElement>);
            const shouldClose =
                showHeader && event.key === 'Escape' && !event.isComposing && !event.ctrlKey;
            assert.equal(closes, shouldClose ? 1 : 0);
            assert.equal(prevented, shouldClose);
            assert.equal(stopped, shouldClose);
        }
    }
});
