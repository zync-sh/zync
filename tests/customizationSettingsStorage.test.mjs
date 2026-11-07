import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import ts from 'typescript';

import { loadWorkspaceDomain as load } from './helpers/loadWorkspaceDomain.mjs';

const { createNavigationUpdater } = load('features/workspace/application/updateNavigation.ts');
const { createElementColorUpdater } = load(
    'features/appearance/application/updateElementColors.ts',
);
const { createThemeImportUpdater } = load('features/appearance/application/importTheme.ts');
const { createPreferencesQueue } = load('features/settings/application/acknowledgedPreferences.ts');
const { themeSettingsSnapshot, sameThemeSettings } = load(
    'features/appearance/domain/themeDocument.ts',
);
const { createChromeActionUpdater } = load('features/workspace/application/updateChromeActions.ts');
const { parseWorkspaceNavigation, resolveWorkspaceNavigation } = load(
    'features/workspace/domain/navigation.ts',
);
const { sidebarPresentation, setSidebarVisibility } = load(
    'features/workspace/application/sidebarPresentation.ts',
);
const { createUiSlice } = load('store/uiSlice.ts');
const { DEFAULT_KEYBOARD_SETTINGS, normalizeKeyboardSettings } = load(
    'features/shortcuts/policy.ts',
);
const { SHORTCUT_CATALOG } = load('features/shortcuts/catalog.ts');
const { resolveShortcutBindings } = load('features/shortcuts/bindings.ts');
const { normalizeTerminalRightClickAction } = load('lib/terminal/terminalMousePolicy.ts');
const { normalizeVncProfiles } = load('features/vnc/domain/profile.ts');
const { normalizeSerialProfiles } = load('features/serial/domain/profile.ts');
// Retired data is deliberately opaque; neither renderer nor native code decodes it.
const fixture = { version: 99, opaque: ['retain', null] };
const copy = (value) => structuredClone(value);
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
};

// Exercise the real slice wiring without starting unrelated feature services.
// Only unrelated settings normalizers are substituted with identities here.
const settingsFile = readFileSync(
    new URL('../src/store/settingsSlice.ts', import.meta.url),
    'utf8',
);
const source = ts.createSourceFile('settingsSlice.ts', settingsFile, ts.ScriptTarget.ES2022, true);
const declaration = source.statements
    .flatMap((node) => (ts.isVariableStatement(node) ? [...node.declarationList.declarations] : []))
    .find((node) => ts.isIdentifier(node.name) && node.name.text === 'createSettingsSlice');
const persist = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'persistSettingsUpdate',
);
assert.ok(declaration?.initializer);
assert.ok(persist);
const { outputText } = ts.transpileModule(
    `${persist.getText(source)}\nexport const createSettingsSlice = ${declaration.initializer.getText(source)};`,
    {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    },
);
function realStore(
    invoke,
    persistSettings = () =>
        assert.fail('generic settings writer must not save managed preferences'),
) {
    const module = { exports: {} };
    const identity = (value) => value;
    runInNewContext(outputText, {
        module,
        exports: module.exports,
        invoke,
        createPreferencesQueue,
        createNavigationUpdater,
        createElementColorUpdater,
        createThemeImportUpdater,
        themeSettingsSnapshot,
        sameThemeSettings,
        createChromeActionUpdater,
        parseWorkspaceNavigation,
        resolveWorkspaceNavigation,
        console: { error() {} },
        defaultSettings: {
            theme: 'default',
            terminal: {},
            privacy: {},
            ghostSuggestions: { providers: {} },
            keybindings: Object.fromEntries(
                SHORTCUT_CATALOG.filter((row) => row.settingsKey).map((row) => [
                    row.settingsKey,
                    row.defaultKeys,
                ]),
            ),
        },
        normalizeTerminalFontFamily: identity,
        normalizeTerminalFontSize: identity,
        normalizeTerminalFontWeight: identity,
        normalizeTerminalFontWeightBold: identity,
        resolveTerminalFontWeightBold: identity,
        normalizeIdleHostPtySuspendMinutes: identity,
        DEFAULT_KEYBOARD_SETTINGS,
        normalizeKeyboardSettings,
        normalizeTerminalRightClickAction,
        normalizeNotificationSettings: identity,
        normalizeStatusBarSettings: identity,
        normalizeSurveySettings: identity,
        normalizeVncProfiles,
        normalizeSerialProfiles,
        migrateFileViewKeybindings: identity,
        migrateSplitPaneKeybinding: identity,
        persistSettings,
    });
    let state;
    const set = (patch) => {
        state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
    };
    const get = () => state;
    state = { ...createUiSlice(set, get), ...module.exports.createSettingsSlice(set, get) };
    return { get, set };
}

test('terminal mouse preferences persist, normalize on load, and roll back failed writes', async () => {
    let disk = {
        theme: 'dark',
        terminal: { fontSize: 15, rightClickAction: 'auto', copyOnSelect: true },
    };
    const store = realStore(
        async () => copy(disk),
        async (patch) => {
            disk.terminal = { ...disk.terminal, ...patch.terminal };
        },
    );
    await store.get().loadSettings();
    assert.equal(store.get().settings.terminal.rightClickAction, 'auto');
    assert.equal(store.get().settings.terminal.copyOnSelect, true);
    await store
        .get()
        .updateTerminalSettings({ rightClickAction: 'passthrough', copyOnSelect: false });
    await store.get().loadSettings();
    assert.equal(store.get().settings.terminal.rightClickAction, 'auto');
    assert.equal(store.get().settings.terminal.copyOnSelect, false);
    assert.equal(store.get().settings.terminal.fontSize, 15);
    disk.terminal = { fontSize: 15, rightClickAction: 'unsupported', copyOnSelect: 'true' };
    await store.get().loadSettings();
    assert.equal(store.get().settings.terminal.rightClickAction, 'context-menu');
    assert.equal(store.get().settings.terminal.copyOnSelect, false);
    const failed = realStore(
        async () => copy(disk),
        async () => {
            throw new Error('disk unavailable');
        },
    );
    await failed.get().loadSettings();
    await assert.rejects(
        failed.get().updateTerminalSettings({ rightClickAction: 'paste', copyOnSelect: true }),
    );
    assert.equal(failed.get().settings.terminal.rightClickAction, 'context-menu');
    assert.equal(failed.get().settings.terminal.copyOnSelect, false);
    disk.terminal = { fontSize: 15 };
    await store.get().loadSettings();
    assert.equal(store.get().settings.terminal.rightClickAction, 'context-menu');
    assert.equal(store.get().settings.terminal.copyOnSelect, false);
});

test('fresh settings persist recommended reservations once; saved and legacy choices survive loading', async () => {
    let disk = {};
    const writes = [];
    const store = realStore(
        async () => structuredClone(disk),
        async (patch) => {
            writes.push(patch);
            disk = { ...disk, ...patch };
        },
    );
    await store.get().loadSettings();
    assert.equal(writes.length, 1);
    assert.ok(
        store
            .get()
            .settings.keyboard.terminalShortcutExceptions.includes('toggleSidebarAlternative'),
    );
    await store.get().loadSettings();
    assert.equal(writes.length, 1, 'reload does not reapply a preset');
    disk = {
        keyboard: {
            terminalFocusPolicy: 'shell',
            terminalShortcutExceptions: [],
            secondaryShortcutsVersion: 1,
        },
    };
    await store.get().loadSettings();
    assert.equal(store.get().settings.keyboard.terminalShortcutExceptions.length, 0);
    disk = { theme: 'dark' };
    await store.get().loadSettings();
    const migrated = store.get().settings.keyboard;
    assert.ok(migrated.terminalShortcutExceptions.includes('commandPaletteAlternative'));
    assert.ok(
        !migrated.terminalShortcutExceptions.includes('commandPalette'),
        'migration does not reserve the primary Ctrl+P',
    );
    await store.get().updateKeyboardSettings({ terminalShortcutExceptions: [] });
    await store.get().loadSettings();
    assert.equal(
        store.get().settings.keyboard.terminalShortcutExceptions.length,
        0,
        'a post-migration opt-out survives a real save and reload',
    );
});

test('loading an older custom profile preserves bindings and unrelated overrides without saving a conflicting default', async () => {
    const disk = {
        theme: 'light',
        accentColor: '#abcdef',
        sidebarWidth: 431,
        compactMode: false,
        terminal: { fontSize: 19, fontFamily: 'User Mono, monospace' },
        keybindings: {
            toggleSettings: 'Ctrl+Alt+3',
            commandPalette: 'Ctrl+Shift+B',
            newHostTerminal: '',
        },
        keyboard: { terminalFocusPolicy: 'app', terminalShortcutExceptions: [] },
    };
    const before = JSON.stringify(disk);
    const writes = [];
    const store = realStore(
        async () => structuredClone(disk),
        async (patch) => writes.push(patch),
    );
    for (let i = 0; i < 2; i++) {
        await store.get().loadSettings();
        const settings = store.get().settings;
        for (const [id, value] of Object.entries(disk.keybindings)) {
            assert.equal(settings.keybindings[id], value);
        }
        for (const key of ['theme', 'accentColor', 'sidebarWidth', 'compactMode']) {
            assert.equal(settings[key], disk[key]);
        }
        assert.equal(settings.terminal.fontSize, disk.terminal.fontSize);
        assert.equal(settings.terminal.fontFamily, disk.terminal.fontFamily);
        assert.equal(settings.keyboard.terminalFocusPolicy, 'app');
        for (const id of ['navigationPublicUrls', 'toggleSidebarAlternative']) {
            assert.equal(
                resolveShortcutBindings(
                    SHORTCUT_CATALOG.find((row) => row.id === id),
                    settings.keybindings,
                    SHORTCUT_CATALOG,
                    false,
                ).active.length,
                0,
            );
        }
    }
    assert.equal(JSON.stringify(disk), before);
    assert.equal(
        writes.length,
        0,
        'upgrading a non-empty settings profile performs no load-time save',
    );
});

test('settings reload defaults to visible navigation without rewriting saved hidden or unsupported choices', async () => {
    const defaults = JSON.parse(JSON.stringify(resolveWorkspaceNavigation(undefined)));
    for (const navigation of [
        undefined,
        { ...defaults, visible: false },
        { ...defaults, visible: true },
        { version: 99, visible: false },
    ]) {
        const disk = {
            theme: 'dark',
            ...(navigation !== undefined && { workspaceNavigation: navigation }),
        };
        const before = JSON.stringify(disk);
        const writes = [];
        const store = realStore(
            async () => structuredClone(disk),
            async (patch) => writes.push(patch),
        );
        for (let reload = 0; reload < 2; reload++) {
            await store.get().loadSettings();
            const raw = store.get().settings.workspaceNavigation;
            assert.deepEqual(
                raw === undefined ? undefined : JSON.parse(JSON.stringify(raw)),
                navigation,
            );
            assert.equal(
                resolveWorkspaceNavigation(raw).visible,
                navigation === undefined || navigation.visible === true,
            );
            assert.equal(resolveWorkspaceNavigation(raw).workspaceTabsPosition, 'default');
        }
        assert.equal(JSON.stringify(disk), before);
        assert.equal(writes.length, 0, 'the display default does not trigger a settings migration');
    }
});

test('chrome settings deep links are transient and clear on regular opening, consumption and close', () => {
    const store = realStore(() => assert.fail('opening settings must not write preferences'));
    const initial = store.get().settings;
    for (const [tab, area] of [
        ['layout', 'workspaceToolbar'],
        ['layout', 'statusBar'],
    ]) {
        store.get().openSettings(tab, area);
        assert.equal(store.get().isSettingsOpen, true);
        assert.equal(store.get().settingsFocusTab, tab);
        assert.equal(store.get().settingsFocusChromeArea, area);
        store.get().clearSettingsFocusTab();
        assert.equal(store.get().settingsFocusChromeArea, null);
        store.get().openSettings(tab, area);
        store.get().openSettings();
        assert.equal(store.get().settingsFocusChromeArea, null);
        store.get().openSettings(tab, area);
        store.get().closeSettings();
        assert.equal(store.get().isSettingsOpen, false);
        assert.equal(store.get().settingsFocusTab, null);
        assert.equal(store.get().settingsFocusChromeArea, null);
        assert.equal(store.get().settings, initial);
    }
});

test('retired presets have no updater and reject generic replacement before storage', async () => {
    const store = realStore(() => assert.fail('retired data must not reach storage'));
    store.set({ isLoadingSettings: false });
    assert.equal('updateWorkspaceLayoutPresets' in store.get(), false);
    for (const retained of [undefined, fixture, null, 'unknown']) {
        store.set({ settings: { ...store.get().settings, workspaceLayoutPresets: retained } });
        await assert.rejects(
            store.get().updateSettings({ workspaceLayoutPresets: { version: 1, presets: [] } }),
            /retired/,
        );
        assert.equal(store.get().settings.workspaceLayoutPresets, retained);
    }
});

test('unrelated generic settings saves retain opaque retired data without sending it in the patch', async () => {
    const writes = [];
    const store = realStore(
        () => assert.fail('no preset IPC'),
        async (patch) => writes.push(copy(patch)),
    );
    store.set({
        isLoadingSettings: false,
        settings: { ...store.get().settings, workspaceLayoutPresets: fixture },
    });
    await store.get().updateSettings({ compactMode: true });
    assert.deepEqual(writes, [{ compactMode: true }]);
    assert.equal(store.get().settings.workspaceLayoutPresets, fixture);
});

test('real element-color adapter acknowledges only its field and protects generic writes', async () => {
    const gate = deferred();
    const calls = [];
    const store = realStore((command, args) => {
        calls.push({ command, args });
        return gate.promise;
    });
    store.set({ isLoadingSettings: false });
    const saving = store
        .get()
        .updateElementColors({ type: 'set', key: 'mainTabs.background', color: '#ABCDEF' });
    await Promise.resolve();
    assert.equal(store.get().settings.elementColors, undefined);
    store.set({
        settings: { ...store.get().settings, theme: 'new-theme', workspaceLayoutPresets: fixture },
    });
    gate.resolve();
    await saving;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'settings_element_colors_save');
    assert.deepEqual(copy(calls[0].args.expected), { exists: false });
    assert.equal(store.get().settings.elementColors.overrides['mainTabs.background'], '#abcdef');
    assert.equal(store.get().settings.theme, 'new-theme');
    assert.equal(store.get().settings.workspaceLayoutPresets, fixture);
    await assert.rejects(
        store.get().updateSettings({ elementColors: { version: 1, overrides: {} } }),
        /element color editor/,
    );
});

test('real theme import adapter confirms one atomic command and retains unrelated settings', async () => {
    const theme = JSON.parse(
        readFileSync(new URL('./fixtures/themeDocument.json', import.meta.url), 'utf8'),
    ).theme;
    const gate = deferred();
    const calls = [];
    const store = realStore((command, args) => {
        calls.push({ command, args });
        return gate.promise;
    });
    store.set({ isLoadingSettings: false });
    const request = store.get().importTheme(theme);
    await Promise.resolve();
    assert.equal(store.get().settings.customTheme, undefined);
    store.set({
        settings: { ...store.get().settings, sidebarWidth: 333, workspaceLayoutPresets: fixture },
    });
    gate.resolve();
    await request;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'settings_theme_import');
    assert.deepEqual(Object.keys(calls[0].args.expected), [
        'theme',
        'accentColor',
        'customTheme',
        'elementColors',
    ]);
    assert.equal(calls[0].args.value.format, 'zync-theme');
    assert.equal(store.get().settings.theme, 'custom');
    assert.equal(store.get().settings.accentColor, null);
    assert.equal(store.get().settings.sidebarWidth, 333);
    assert.equal(store.get().settings.workspaceLayoutPresets, fixture);
    await assert.rejects(store.get().updateSettings({ customTheme: theme }), /theme import/);
});

test('real theme reload keeps future imported data and supersedes pending theme publication', async () => {
    const theme = JSON.parse(
        readFileSync(new URL('./fixtures/themeDocument.json', import.meta.url), 'utf8'),
    ).theme;
    const future = { format: 'zync-theme', version: 99, unknown: 'keep' };
    const gate = deferred();
    const store = realStore((command) =>
        command === 'settings_get'
            ? Promise.resolve({ theme: 'custom', customTheme: future })
            : gate.promise,
    );
    store.set({ isLoadingSettings: false });
    const request = store.get().importTheme(theme);
    await Promise.resolve();
    await store.get().loadSettings();
    gate.resolve();
    await assert.rejects(request, /settings changed/);
    assert.equal(store.get().settings.customTheme, future);
    await assert.rejects(store.get().importTheme(theme), /unsupported/);
});

test('theme failure leaves acknowledged state intact and a queued import can then succeed', async () => {
    const theme = JSON.parse(
        readFileSync(new URL('./fixtures/themeDocument.json', import.meta.url), 'utf8'),
    ).theme;
    const gate = deferred();
    const snapshots = [];
    const store = realStore(
        async () => {},
        (patch, expected) => {
            snapshots.push(copy(expected));
            return gate.promise;
        },
    );
    store.set({ isLoadingSettings: false });
    const first = store.get().updateSettings({ theme: 'light' });
    const rejected = assert.rejects(first, /lost acknowledgement/);
    const imported = store.get().importTheme(theme);
    await Promise.resolve();
    assert.equal(store.get().settings.theme, 'default');
    gate.reject(new Error('lost acknowledgement'));
    await rejected;
    await imported;
    assert.equal(snapshots[0].theme, 'default');
    assert.equal(store.get().settings.theme, 'custom');
    assert.equal(store.get().settings.accentColor, null);
    assert.equal(store.get().settings.customTheme.name, 'Ocean');
});

test('theme and semantic colors share ordering; a failed theme never blocks the next color edit', async () => {
    const gate = deferred();
    const store = realStore(
        async () => {},
        () => gate.promise,
    );
    store.set({ isLoadingSettings: false });
    const request = store.get().updateSettings({ theme: 'light' });
    const rejected = assert.rejects(request, /save refused/);
    const colored = store
        .get()
        .updateElementColors({ type: 'set', key: 'terminal.cursor', color: '#123456' });
    gate.reject(new Error('save refused'));
    await rejected;
    await colored;
    assert.equal(store.get().settings.theme, 'default');
    assert.equal(store.get().settings.elementColors.overrides['terminal.cursor'], '#123456');
});

test('rapid failed theme selections never display an unsaved intermediate choice', async () => {
    const first = deferred(),
        second = deferred();
    const snapshots = [];
    const store = realStore(
        async () => {},
        (patch, expected) => {
            snapshots.push(copy(expected));
            return snapshots.length === 1 ? first.promise : second.promise;
        },
    );
    store.set({ isLoadingSettings: false });
    const a = assert.rejects(store.get().updateSettings({ theme: 'light' }), /first failed/);
    const b = assert.rejects(store.get().updateSettings({ theme: 'dark' }), /second failed/);
    await Promise.resolve();
    assert.equal(snapshots.length, 1);
    assert.equal(store.get().settings.theme, 'default');
    first.reject(new Error('first failed'));
    await a;
    await Promise.resolve();
    second.reject(new Error('second failed'));
    await b;
    assert.equal(store.get().settings.theme, 'default');
    assert.equal(snapshots[1].theme, 'default');
});

test('successful rapid theme/accent edits use the previous acknowledgement, not an optimistic snapshot', async () => {
    const first = deferred();
    const calls = [];
    const store = realStore(
        async () => {},
        (patch, expected) => {
            calls.push(copy({ patch, expected }));
            return calls.length === 1 ? first.promise : Promise.resolve();
        },
    );
    store.set({ isLoadingSettings: false });
    const a = store.get().updateSettings({ theme: 'light' });
    const patch = { accentColor: '#123456' };
    const b = store.get().updateSettings(patch);
    patch.accentColor = '#ffffff';
    await Promise.resolve();
    assert.equal(calls.length, 1);
    assert.equal(store.get().settings.theme, 'default');
    first.resolve();
    await a;
    await b;
    assert.equal(calls[1].expected.theme, 'light');
    assert.equal(store.get().settings.theme, 'light');
    assert.equal(store.get().settings.accentColor, '#123456');
});

test('reloading settings supersedes an ordinary theme acknowledgement without rolling back loaded values', async () => {
    const gate = deferred();
    const store = realStore(
        () => Promise.resolve({ theme: 'loaded', privacy: {} }),
        () => gate.promise,
    );
    store.set({ isLoadingSettings: false });
    const request = store.get().updateSettings({ theme: 'light' });
    const rejected = assert.rejects(request, /settings changed/);
    await Promise.resolve();
    await store.get().loadSettings();
    gate.resolve();
    await rejected;
    assert.equal(store.get().settings.theme, 'loaded');
});

test('theme choice and color edit wait for an import and use its acknowledged palette', async () => {
    const theme = JSON.parse(
        readFileSync(new URL('./fixtures/themeDocument.json', import.meta.url), 'utf8'),
    ).theme;
    const gate = deferred();
    const calls = [];
    const store = realStore(
        (command, args) => {
            calls.push({ command, args });
            return command === 'settings_theme_import' ? gate.promise : Promise.resolve();
        },
        async (patch, expected) => {
            calls.push({ command: 'theme choice', patch, expected });
        },
    );
    store.set({ isLoadingSettings: false });
    const imported = store.get().importTheme(theme);
    const chosen = store.get().updateSettings({ theme: 'light' });
    const colored = store
        .get()
        .updateElementColors({ type: 'set', key: 'terminal.cursor', color: '#123456' });
    await Promise.resolve();
    assert.equal(calls.length, 1);
    gate.resolve();
    await imported;
    await chosen;
    await colored;
    assert.deepEqual(
        calls.map((call) => call.command),
        ['settings_theme_import', 'theme choice', 'settings_element_colors_save'],
    );
    assert.equal(calls[1].expected.theme, 'custom');
    assert.equal(calls[1].expected.customTheme.name, 'Ocean');
    assert.equal(store.get().settings.theme, 'light');
    assert.equal(store.get().settings.customTheme.name, 'Ocean');
    assert.equal(store.get().settings.elementColors.overrides['terminal.cursor'], '#123456');
});

test('appearance queues are isolated per settings store', async () => {
    const gate = deferred();
    const first = realStore(
        async () => {},
        () => gate.promise,
    );
    const second = realStore(
        async () => {},
        async () => {},
    );
    first.set({ isLoadingSettings: false });
    second.set({ isLoadingSettings: false });
    const pending = first.get().updateSettings({ theme: 'light' });
    await second.get().updateSettings({ theme: 'dark' });
    assert.equal(first.get().settings.theme, 'default');
    assert.equal(second.get().settings.theme, 'dark');
    gate.resolve();
    await pending;
    assert.equal(first.get().settings.theme, 'light');
});

test('real settings reload preserves future color envelopes and invalidates old color saves', async () => {
    const gate = deferred();
    const future = { version: 99, opaque: true };
    const store = realStore((command) =>
        command === 'settings_get' ? Promise.resolve({ elementColors: future }) : gate.promise,
    );
    store.set({ isLoadingSettings: false });
    const saving = store
        .get()
        .updateElementColors({ type: 'set', key: 'terminal.cursor', color: '#123456' });
    await Promise.resolve();
    await store.get().loadSettings();
    gate.resolve();
    await assert.rejects(saving, /saved, but settings changed/);
    assert.equal(store.get().settings.elementColors, future);
    await assert.rejects(store.get().updateElementColors({ type: 'reset-all' }), /unsupported/);
});

test('real chrome-action adapter acknowledges its fixed field and preserves unrelated and future settings', async () => {
    const gate = deferred();
    const calls = [];
    const store = realStore((command, args) => {
        calls.push({ command, args });
        return gate.promise;
    });
    store.set({ isLoadingSettings: false });
    const saving = store
        .get()
        .updateChromeActions({ type: 'hidden', id: 'status.ai', value: true });
    await Promise.resolve();
    assert.equal(store.get().settings.chromeActions, undefined);
    store.set({
        settings: { ...store.get().settings, theme: 'changed', elementColors: { version: 99 } },
    });
    gate.resolve();
    await saving;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'settings_chrome_actions_save');
    assert.deepEqual(copy(calls[0].args.expected), { exists: false });
    assert.deepEqual(copy(store.get().settings.chromeActions.statusBar.hidden), ['status.ai']);
    assert.equal(store.get().settings.theme, 'changed');
    assert.equal(store.get().settings.elementColors.version, 99);
    await assert.rejects(
        store.get().updateSettings({ chromeActions: calls[0].args.value }),
        /toolbar and status editor/,
    );
    const future = { version: 99 };
    store.set({ settings: { ...store.get().settings, chromeActions: future } });
    await assert.rejects(
        store.get().updateChromeActions({ type: 'reset', area: 'statusBar' }),
        /unsupported/,
    );
    assert.equal(store.get().settings.chromeActions, future);
});

test('real reload generation rejects stale results and old failures cannot end a newer loading state', async () => {
    for (const failOlder of [false, true]) {
        const older = deferred();
        const newer = deferred();
        const calls = [older, newer];
        const store = realStore((command) => {
            assert.equal(command, 'settings_get');
            return calls.shift().promise;
        });
        const first = store.get().loadSettings();
        const second = store.get().loadSettings();
        assert.equal(store.get().settingsLoadGeneration, 2);
        assert.equal(store.get().isLoadingSettings, true);
        assert.equal(store.get().isReloadingSettings, true);
        if (failOlder) {
            older.reject(Error('old read failed'));
        } else {
            older.resolve({ theme: 'stale' });
        }
        await first;
        assert.equal(store.get().isLoadingSettings, true);
        assert.equal(store.get().settings.theme, 'default');
        assert.equal(store.get().isReloadingSettings, true);
        newer.resolve({ theme: 'newest', workspaceLayoutPresets: { version: 99 } });
        await second;
        assert.equal(store.get().isLoadingSettings, false);
        assert.equal(store.get().settings.theme, 'newest');
        assert.equal(store.get().isReloadingSettings, false);
        assert.equal(store.get().settings.workspaceLayoutPresets.version, 99);
    }
});

test('real reload invalidates a color save even when both read snapshots contain no colors', async () => {
    const save = deferred();
    const read = deferred();
    const store = realStore((command) =>
        command === 'settings_get' ? read.promise : save.promise,
    );
    store.set({ isLoadingSettings: false });
    const write = store
        .get()
        .updateElementColors({ type: 'set', key: 'terminal.cursor', color: '#123456' });
    await Promise.resolve();
    const reload = store.get().loadSettings();
    assert.equal(
        store.get().isLoadingSettings,
        false,
        'background reload must not unmount the workspace through its boot gate',
    );
    assert.equal(store.get().isReloadingSettings, true);
    read.resolve({});
    await reload;
    save.resolve();
    await assert.rejects(write, /saved, but settings changed/);
    assert.equal(store.get().settings.elementColors, undefined);
});

test('background reload blocks customization writes without re-entering the workspace boot gate', async () => {
    const read = deferred();
    let writes = 0;
    const store = realStore((command) => {
        if (command !== 'settings_get') {
            writes++;
        }
        return read.promise;
    });
    store.set({ isLoadingSettings: false });
    const reload = store.get().loadSettings();
    assert.equal(store.get().isLoadingSettings, false);
    assert.equal(store.get().isReloadingSettings, true);
    await assert.rejects(
        store.get().updateElementColors({ type: 'set', key: 'terminal.cursor', color: '#123456' }),
        /loading/,
    );
    assert.equal(writes, 0);
    read.resolve({});
    await reload;
});

test('real navigation adapter confirms only its field and invalidates stale reload acknowledgements', async () => {
    const gate = deferred();
    const calls = [];
    const store = realStore((command, args) => {
        calls.push({ command, args });
        return gate.promise;
    });
    store.set({ isLoadingSettings: false });
    const saving = store.get().updateWorkspaceNavigation({ type: 'workspace-tabs', value: 'left' });
    await Promise.resolve();
    assert.equal(store.get().settings.workspaceNavigation, undefined);
    store.set({
        settings: { ...store.get().settings, theme: 'changed', workspaceLayoutPresets: fixture },
    });
    gate.resolve();
    await saving;
    assert.equal(calls[0].command, 'settings_navigation_save');
    assert.deepEqual(copy(calls[0].args.expected), { exists: false });
    assert.equal(store.get().settings.workspaceNavigation.workspaceTabsPosition, 'left');
    assert.equal(store.get().globalSidebarSection, 'workspace');
    assert.equal(store.get().settings.workspaceNavigation.visible, true);
    assert.equal(store.get().settings.theme, 'changed');
    assert.equal(store.get().settings.workspaceLayoutPresets, fixture);
    await store.get().updateWorkspaceNavigation({ type: 'workspace-tabs', value: 'default' });
    assert.equal(store.get().globalSidebarSection, 'hosts');
    await assert.rejects(
        store.get().updateSettings({ workspaceNavigation: calls[0].args.value }),
        /navigation editor/,
    );

    const delayed = deferred();
    const other = realStore((command) =>
        command === 'settings_get'
            ? Promise.resolve({ workspaceNavigation: { version: 99 } })
            : delayed.promise,
    );
    other.set({ isLoadingSettings: false });
    const pending = other.get().updateWorkspaceNavigation({ type: 'visible', value: false });
    await Promise.resolve();
    await other.get().loadSettings();
    delayed.resolve();
    await assert.rejects(pending, /settings changed/);
    assert.equal(other.get().settings.workspaceNavigation.version, 99);
});

test('refused strip placement keeps the previous sidebar section and preference identity', async () => {
    const store = realStore(() => Promise.reject(Error('refused')));
    store.set({ isLoadingSettings: false, globalSidebarSection: 'plugins' });
    const original = store.get().settings.workspaceNavigation;
    await assert.rejects(
        store.get().updateWorkspaceNavigation({ type: 'workspace-tabs', value: 'right' }),
    );
    assert.equal(store.get().globalSidebarSection, 'plugins');
    assert.equal(store.get().settings.workspaceNavigation, original);
});

function workspaceVisibilityStore(
    persistSettings,
    invoke = () => assert.fail('No resource/native navigation action expected'),
) {
    const store = realStore(invoke, persistSettings);
    const warnings = [];
    store.set({
        isLoadingSettings: false,
        showToast: (...args) => warnings.push(args),
        globalSidebarSection: 'workspace',
        settings: {
            ...store.get().settings,
            sidebarCollapsed: false,
            sidebarWidth: 341,
            workspaceNavigation: {
                ...resolveWorkspaceNavigation(undefined),
                visible: true,
                workspaceTabsPosition: 'left',
            },
        },
    });
    return {
        ...store,
        warnings,
        shown: () =>
            sidebarPresentation(
                store.get().settings.workspaceNavigation,
                store.get().globalSidebarSection,
                store.get().settings.sidebarCollapsed,
            ),
    };
}
const flushVisibilitySave = () => new Promise((resolve) => setImmediate(resolve));

test('real refused workspace visibility save restores selection and flag without undoing unrelated width edits', async () => {
    const gate = deferred();
    const store = workspaceVisibilityStore(() => gate.promise);
    const before = copy(store.shown());
    setSidebarVisibility(store.get, true);
    assert.equal(store.shown().collapsed, true);
    assert.equal(
        store.get().settings.sidebarCollapsed,
        true,
        'exercise the real optimistic settings writer',
    );
    store.set({ settings: { ...store.get().settings, sidebarWidth: 390 } });
    gate.reject(Error('Refused save'));
    await flushVisibilitySave();
    assert.deepEqual(copy(store.shown()), before);
    assert.equal(store.get().settings.sidebarWidth, 390);
    assert.equal(store.warnings.length, 1);
});

test('late visibility failures preserve newer selections and same-selection ABA actions', async () => {
    for (const destination of ['plugins', 'workspace']) {
        const gate = deferred();
        let writes = 0;
        const store = workspaceVisibilityStore(() =>
            ++writes === 1 ? gate.promise : Promise.resolve(),
        );
        setSidebarVisibility(store.get, true);
        setSidebarVisibility(store.get, false, destination);
        setSidebarVisibility(store.get, true, destination);
        await flushVisibilitySave();
        const latest = copy(store.shown());
        assert.equal(store.get().settings.sidebarCollapsed, true);
        gate.reject(Error('Old save failed'));
        await flushVisibilitySave();
        assert.deepEqual(copy(store.shown()), latest);
        assert.equal(store.get().settings.sidebarCollapsed, true);
        assert.equal(store.warnings.length, 1);
    }
});

test('a settings reload supersedes pending visibility recovery even when placement identity is unchanged', async () => {
    const gate = deferred();
    let loaded;
    const store = workspaceVisibilityStore(
        () => gate.promise,
        (command) => {
            assert.equal(command, 'settings_get');
            return Promise.resolve(loaded);
        },
    );
    setSidebarVisibility(store.get, true);
    loaded = store.get().settings;
    await store.get().loadSettings();
    const latest = copy(store.shown());
    gate.reject(Error('Old save failed'));
    await flushVisibilitySave();
    assert.deepEqual(copy(store.shown()), latest);
    assert.equal(store.get().settings.sidebarCollapsed, true);
});

test('acknowledged strip placement supersedes pending collapse without a stale visibility rollback', async () => {
    const gate = deferred();
    const store = workspaceVisibilityStore(
        () => gate.promise,
        () => Promise.resolve(),
    );
    setSidebarVisibility(store.get, true);
    await store.get().updateWorkspaceNavigation({ type: 'workspace-tabs', value: 'right' });
    const latest = copy(store.shown());
    assert.equal(latest.section, 'workspace');
    assert.equal(latest.position, 'right');
    assert.equal(latest.collapsed, false);
    gate.reject(Error('Old save failed'));
    await flushVisibilitySave();
    assert.deepEqual(copy(store.shown()), latest);
    assert.equal(store.get().settings.sidebarCollapsed, true);
});
