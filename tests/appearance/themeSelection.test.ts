import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import ts from 'typescript';

import { createThemeImportUpdater } from '../../src/features/appearance/application/importTheme.js';
import { createElementColorUpdater } from '../../src/features/appearance/application/updateElementColors.js';
import type { ElementColors } from '../../src/features/appearance/domain/elementColors.js';
import {
    sameThemeSettings,
    type ThemeDocument,
    type ThemeSettingsSnapshot,
    themeSettingsSnapshot,
    validateThemeDocument,
} from '../../src/features/appearance/domain/themeDocument.js';
import { themeSelectionPatch } from '../../src/features/appearance/domain/themeSelection.js';
import { createElementColorStyle } from '../../src/features/appearance/presentation/elementColorStyle.js';
import { createPreferencesQueue } from '../../src/features/settings/application/acknowledgedPreferences.js';
import type { AppStore } from '../../src/store/useAppStore.js';

const emptyColors: ElementColors = { version: 1, overrides: {} };

/** Use the portable fixture with distinct overrides for the two tab strips. */
function savedTheme(): ThemeDocument {
    const fixture = JSON.parse(readFileSync('tests/fixtures/themeDocument.json', 'utf8'));
    const theme = validateThemeDocument(fixture.theme);
    theme.elements.overrides['mainTabs.activeBackground'] = '#f0c9da';
    theme.elements.overrides['contentTabs.activeBackground'] = '#b2d2b0';
    return theme;
}

function snapshot(): ThemeSettingsSnapshot {
    const theme = savedTheme();
    return {
        theme: 'custom',
        accentColor: '#aabbcc',
        customTheme: theme,
        elementColors: theme.elements,
    };
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

interface PreferenceWrite {
    command: string;
    args: Record<string, unknown>;
}

/** Run the actual slice and native IPC wrapper with only unrelated feature services stubbed. */
function settingsStore(save: (write: PreferenceWrite) => Promise<void> = async () => {}) {
    const tree = ts.createSourceFile(
        'settingsSlice.ts',
        readFileSync('src/store/settingsSlice.ts', 'utf8'),
        ts.ScriptTarget.ES2022,
        true,
    );
    const declaration = tree.statements
        .flatMap((node) =>
            ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [],
        )
        .find((node) => ts.isIdentifier(node.name) && node.name.text === 'createSettingsSlice');
    const helpers = ['persistSettingsUpdate', 'persistSettings'].map((name) => {
        const node = tree.statements.find(
            (item) => ts.isFunctionDeclaration(item) && item.name?.text === name,
        );
        assert.ok(node, `Missing production helper ${name}`);
        return node.getText(tree);
    });
    assert.ok(declaration?.initializer);
    const { outputText } = ts.transpileModule(
        `${helpers.join('\n')}\nexport const createSettingsSlice = ${declaration.initializer.getText(tree)};`,
        {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        },
    );
    const module = { exports: {} as typeof import('../../src/store/settingsSlice.js') };
    const writes: PreferenceWrite[] = [];
    runInNewContext(outputText, {
        module,
        exports: module.exports,
        defaultSettings: { ...snapshot(), privacy: {}, serialProfiles: [], vncProfiles: [] },
        createPreferencesQueue,
        createThemeImportUpdater,
        createElementColorUpdater,
        createNavigationUpdater: () => undefined,
        createChromeActionUpdater: () => undefined,
        themeSelectionPatch,
        themeSettingsSnapshot,
        sameThemeSettings,
        invoke: async (command: string, args: Record<string, unknown>) => {
            const write = { command, args: structuredClone(args) };
            writes.push(write);
            await save(write);
        },
    });
    let state: AppStore;
    const set = (patch: Partial<AppStore> | ((current: AppStore) => Partial<AppStore>)) => {
        state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
    };
    state = {
        ...module.exports.createSettingsSlice(set, () => state, undefined as never),
        isLoadingSettings: false,
        globalSidebarSelectionRevision: 0,
        tabs: [
            {
                id: 'local',
                type: 'connection',
                connectionId: 'local',
                title: 'Local Terminal',
                view: 'terminal',
                presentation: { version: 2, pinned: true, accent: '#334455' },
            },
        ],
        contentPresentation: {
            local: {
                version: 3,
                items: {
                    '["feature","files","files-one"]': { pinned: true, displayAlias: 'Documents' },
                },
            },
        },
    } as unknown as AppStore;
    return { get: () => state, set, writes };
}

test('preset, plugin and same-theme selection reset every global override without deleting the custom document', () => {
    for (const themeId of ['dark', 'light', 'oxide', 'external-palette']) {
        const current = { ...snapshot(), theme: themeId };
        const before = structuredClone(current);
        const patch = themeSelectionPatch(current, themeId);
        assert.deepEqual(patch, { theme: themeId, accentColor: null, elementColors: emptyColors });
        assert.deepEqual(current, before);
        assert.equal(Object.hasOwn(patch, 'customTheme'), false);
    }
});

test('selecting Custom restores its saved element colors instead of merging current overrides', () => {
    const current = snapshot();
    current.elementColors = { version: 1, overrides: { 'sidebar.background': '#112233' } };
    const document = current.customTheme as ThemeDocument;
    const patch = themeSelectionPatch(current, 'custom');
    assert.deepEqual(patch.elementColors, document.elements);
    assert.equal(patch.elementColors.overrides['sidebar.background'], undefined);
    patch.elementColors.overrides['mainTabs.activeBackground'] = '#000000';
    assert.equal(document.elements.overrides['mainTabs.activeBackground'], '#f0c9da');
});

test('unknown element formats fail closed while unused future custom documents remain intact', () => {
    for (const elementColors of [
        { version: 99, overrides: {} },
        { version: 1, overrides: { 'future.background': '#123456' } },
    ]) {
        const current = { ...snapshot(), elementColors };
        const before = structuredClone(current);
        assert.throws(() => themeSelectionPatch(current, 'oxide'), /unsupported/i);
        assert.deepEqual(current, before);
    }
    for (const elementColors of [undefined, null]) {
        const current = {
            ...snapshot(),
            elementColors,
            customTheme: { version: 99, future: 'keep' },
        };
        const before = structuredClone(current);
        assert.deepEqual(themeSelectionPatch(current, 'dark').elementColors, emptyColors);
        assert.deepEqual(current, before);
        assert.throws(() => themeSelectionPatch(current, 'custom'), /valid custom theme/i);
    }
    assert.throws(() => themeSelectionPatch(snapshot(), undefined), /valid theme/i);
});

test('the settings slice publishes a theme reset only after its native acknowledgement and preserves tab metadata', async () => {
    const gate = deferred();
    const store = settingsStore(() => gate.promise);
    const before = store.get();
    const pending = store.get().updateSettings({ theme: 'oxide' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
        store.get().settings,
        before.settings,
        'Pending native writes do not repaint the theme',
    );
    assert.equal(store.writes.length, 1);
    assert.equal(store.writes[0].command, 'settings_theme_set');
    assert.deepEqual(store.writes[0].args.expected, themeSettingsSnapshot(before.settings));
    assert.deepEqual(store.writes[0].args.settings, { theme: 'oxide', accentColor: null });
    gate.resolve();
    await pending;
    assert.equal(store.get().settings.theme, 'oxide');
    assert.deepEqual(store.get().settings.elementColors, emptyColors);
    assert.equal(store.get().settings.customTheme, before.settings.customTheme);
    assert.equal(store.get().tabs, before.tabs);
    assert.equal(store.get().contentPresentation, before.contentPresentation);
});

test('failed selection leaves the old palette and overrides intact and does not poison retry', async () => {
    let fail = true;
    const store = settingsStore(async () => {
        if (fail) {
            throw new Error('disk unavailable');
        }
    });
    const before = store.get().settings;
    await assert.rejects(store.get().updateSettings({ theme: 'dark' }), /disk unavailable/);
    assert.equal(store.get().settings, before);
    fail = false;
    await store.get().updateSettings({ theme: 'dark' });
    assert.equal(store.get().settings.theme, 'dark');
    assert.deepEqual(store.get().settings.elementColors, emptyColors);
});

test('loading and unknown saved colors cannot be replaced through a theme selection', async () => {
    const store = settingsStore();
    store.set({ isReloadingSettings: true });
    await assert.rejects(store.get().updateSettings({ theme: 'dark' }), /loading/i);
    const unknown = { version: 99, overrides: { future: '#123456' } };
    store.set({
        isReloadingSettings: false,
        settings: { ...store.get().settings, elementColors: unknown },
    });
    await assert.rejects(store.get().updateSettings({ theme: 'dark' }), /unsupported/i);
    assert.equal(store.get().settings.elementColors, unknown);
    assert.equal(store.writes.length, 0);
});

test('reloads, replacement colors and loading changes cannot be overwritten by a late theme acknowledgement', async () => {
    for (const race of ['generation', 'colors', 'loading']) {
        const gate = deferred();
        const store = settingsStore(() => gate.promise);
        const pending = store.get().updateSettings({ theme: 'oxide' });
        await new Promise((resolve) => setImmediate(resolve));
        if (race === 'generation') {
            store.set({ settingsLoadGeneration: store.get().settingsLoadGeneration + 1 });
        } else if (race === 'colors') {
            store.set({
                settings: {
                    ...store.get().settings,
                    elementColors: {
                        version: 1,
                        overrides: { 'mainTabs.activeBackground': '#998877' },
                    },
                },
            });
        } else {
            store.set({ isReloadingSettings: true });
        }
        const replacement = store.get().settings;
        gate.resolve();
        await assert.rejects(pending, /settings changed/i);
        assert.equal(store.get().settings, replacement);
    }
});

test('an accent-only edit retains global element overrides and independently owned tab styling', async () => {
    const store = settingsStore();
    const before = store.get();
    await store.get().updateSettings({ accentColor: '#123456' });
    assert.deepEqual(store.writes[0].args.settings, { accentColor: '#123456' });
    assert.equal(store.get().settings.elementColors, before.settings.elementColors);
    assert.equal(store.get().settings.customTheme, before.settings.customTheme);
    assert.equal(store.get().tabs, before.tabs);
    assert.equal(store.get().contentPresentation, before.contentPresentation);
});

test('an element edit queued after theme selection starts from the cleared acknowledged overrides', async () => {
    const gate = deferred();
    const store = settingsStore(async (write) => {
        if (write.command === 'settings_theme_set') {
            await gate.promise;
        }
    });
    const selecting = store.get().updateSettings({ theme: 'oxide' });
    const editing = store
        .get()
        .updateElementColors({ type: 'set', key: 'sidebar.background', color: '#123456' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.writes.length, 1);
    gate.resolve();
    await Promise.all([selecting, editing]);
    assert.equal(store.writes[1].command, 'settings_element_colors_save');
    assert.deepEqual(store.writes[1].args.expected, { exists: true, value: emptyColors });
    assert.deepEqual(store.get().settings.elementColors, {
        version: 1,
        overrides: { 'sidebar.background': '#123456' },
    });
});

test('theme selection waits for earlier color edits and uses their acknowledged snapshot', async () => {
    const gate = deferred();
    const store = settingsStore(async (write) => {
        if (write.command === 'settings_element_colors_save') {
            await gate.promise;
        }
    });
    const editing = store
        .get()
        .updateElementColors({ type: 'set', key: 'sidebar.background', color: '#123456' });
    const selecting = store.get().updateSettings({ theme: 'light' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.writes.length, 1);
    gate.resolve();
    await Promise.all([editing, selecting]);
    assert.equal(store.writes[1].command, 'settings_theme_set');
    const expected = store.writes[1].args.expected as ThemeSettingsSnapshot;
    assert.equal(
        (expected.elementColors as ElementColors).overrides['sidebar.background'],
        '#123456',
    );
    assert.deepEqual(store.get().settings.elementColors, emptyColors);
});

test('theme import and later selection share one queue and retain the newly saved custom document', async () => {
    const gate = deferred();
    const store = settingsStore(async (write) => {
        if (write.command === 'settings_theme_import') {
            await gate.promise;
        }
    });
    const imported = savedTheme();
    imported.name = 'Another theme';
    imported.elements = { version: 1, overrides: { 'control.background': '#112233' } };
    const importing = store.get().importTheme(imported);
    const selecting = store.get().updateSettings({ theme: 'oxide' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.writes.length, 1);
    gate.resolve();
    await Promise.all([importing, selecting]);
    assert.deepEqual(
        (store.writes[1].args.expected as ThemeSettingsSnapshot).customTheme,
        imported,
    );
    assert.deepEqual(store.get().settings.customTheme, imported);
    assert.deepEqual(store.get().settings.elementColors, emptyColors);
});

interface FakeStyle {
    nonce: string;
    dataset: Record<string, string>;
    textContent: string;
    remove(): void;
}

/** Exercise stylesheet replacement without a browser, including the release CSP nonce. */
function styleRoot() {
    const styles: FakeStyle[] = [];
    const root = {
        querySelector: () => ({ nonce: 'theme-selection-test' }),
        createElement: (tag: string) => {
            assert.equal(tag, 'style');
            const style: FakeStyle = {
                nonce: '',
                dataset: {},
                textContent: '',
                remove() {
                    const index = styles.indexOf(style);
                    if (index >= 0) {
                        styles.splice(index, 1);
                    }
                },
            };
            return style;
        },
        head: {
            appendChild(style: FakeStyle) {
                assert.equal(style.nonce, 'theme-selection-test');
                styles.push(style);
            },
        },
        defaultView: { dispatchEvent: () => true },
    } as unknown as Document;
    return { root, styles };
}

test('switching away removes both old tab-strip color rules and Custom restores only its saved rules', async () => {
    const store = settingsStore();
    const fixture = styleRoot();
    let terminalRefreshes = 0;
    const owner = createElementColorStyle(fixture.root, () => {
        terminalRefreshes++;
    });
    owner.update(store.get().settings.elementColors);
    const original = fixture.styles[0];
    assert.match(original.textContent, /data-zync-color="mainTab".*background-color:#f0c9da/);
    assert.match(original.textContent, /data-zync-color="contentTab".*background-color:#b2d2b0/);
    await store.get().updateSettings({ theme: 'oxide' });
    owner.update(store.get().settings.elementColors);
    assert.equal(fixture.styles.length, 0, 'The new theme inherits its own tab backgrounds');
    await store.get().updateSettings({ theme: 'custom' });
    owner.update(store.get().settings.elementColors);
    assert.equal(fixture.styles.length, 1);
    assert.notEqual(fixture.styles[0], original);
    assert.match(fixture.styles[0].textContent, /background-color:#f0c9da/);
    assert.match(fixture.styles[0].textContent, /background-color:#b2d2b0/);
    assert.equal(
        terminalRefreshes,
        3,
        'Terminal overrides reset and restore with the same theme transition',
    );
    owner.dispose();
    assert.equal(fixture.styles.length, 0);
});
