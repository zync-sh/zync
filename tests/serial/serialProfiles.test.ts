import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import ts from 'typescript';

import {
    isSerialProfileId,
    normalizeSerialProfiles,
    type SerialProfile,
    type SerialProfileDraft,
    sameSerialConnectionInputs,
    validateSerialProfileDraft,
} from '../../src/features/serial/domain/profile.js';
import { DEFAULT_SERIAL_SETTINGS } from '../../src/features/serial/domain/serialSettings.js';
import { createPreferencesQueue } from '../../src/features/settings/application/acknowledgedPreferences.js';
import { buildSessionData } from '../../src/store/sessionPersistence.js';
import type { AppStore } from '../../src/store/useAppStore.js';
import { presentationStore } from '../workspace/presentationFixture.js';

const draft: SerialProfileDraft = {
    name: ' Router console ',
    portId: ' COM8 ',
    baud: '115200',
    settings: { ...DEFAULT_SERIAL_SETTINGS },
    lineEnding: 'cr',
};
const profile: SerialProfile = {
    id: 'router-console',
    ...validateSerialProfileDraft(draft).value!,
};

/** Isolate native preference persistence while exercising the real slice's queue and publication. */
function settingsStore(save: (patch: { serialProfiles: SerialProfile[] }) => Promise<void>) {
    const source = ts.createSourceFile(
        'settingsSlice.ts',
        readFileSync('src/store/settingsSlice.ts', 'utf8'),
        ts.ScriptTarget.ES2022,
        true,
    );
    const declaration = source.statements
        .flatMap((node) =>
            ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [],
        )
        .find((node) => ts.isIdentifier(node.name) && node.name.text === 'createSettingsSlice');
    const persist = source.statements.find(
        (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'persistSettingsUpdate',
    );
    assert.ok(declaration?.initializer && persist);
    const { outputText } = ts.transpileModule(
        `${persist.getText(source)}\nexport const createSettingsSlice = ${declaration.initializer.getText(source)};`,
        { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
    );
    const module = { exports: {} as typeof import('../../src/store/settingsSlice.js') };
    runInNewContext(outputText, {
        module,
        exports: module.exports,
        crypto,
        defaultSettings: { serialProfiles: [], privacy: {} },
        createPreferencesQueue,
        createNavigationUpdater: () => undefined,
        createElementColorUpdater: () => undefined,
        createChromeActionUpdater: () => undefined,
        createThemeImportUpdater: () => undefined,
        isSerialProfileId,
        validateSerialProfileDraft,
        persistSettings: save,
    });
    let state: AppStore;
    const set = (patch: Partial<AppStore> | ((before: AppStore) => Partial<AppStore>)) => {
        state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
    };
    const closed: string[] = [];
    state = {
        ...module.exports.createSettingsSlice(set, () => state, undefined as never),
        isLoadingSettings: false,
        tabs: [],
        closeTab: (id: string) => closed.push(id),
    } as unknown as AppStore;
    return { get: () => state, set, closed };
}

test('Serial profiles validate driver-neutral port names, framing and whole positive baud rates', () => {
    for (const portId of [
        'COM8',
        '/dev/ttyUSB0',
        '/dev/cu.usbserial-123',
        '/dev/serial/by-id/device',
    ]) {
        const { value } = validateSerialProfileDraft({ ...draft, portId });
        assert.equal(value?.portId, portId);
        assert.equal(value?.name, 'Router console');
        assert.equal(value?.settings.baudRate, 115200);
    }
    for (const baud of ['', '0', '-1', '+9600', '1e5', '9600.5', '4294967296']) {
        assert.ok(validateSerialProfileDraft({ ...draft, baud }).errors?.baud, baud);
    }
    assert.ok(validateSerialProfileDraft({ ...draft, name: '  ' }).errors?.name);
    assert.ok(validateSerialProfileDraft({ ...draft, portId: 'COM8\0' }).errors?.portId);
    assert.ok(
        validateSerialProfileDraft({
            ...draft,
            settings: { ...draft.settings, dataBits: 9 } as never,
        }).errors?.settings,
    );
    assert.ok(
        validateSerialProfileDraft({ ...draft, lineEnding: 'invalid' as never }).errors?.lineEnding,
    );
});

test('loading Serial profiles keeps only known valid metadata and unique identities', () => {
    assert.deepEqual(normalizeSerialProfiles(undefined), []);
    assert.deepEqual(
        normalizeSerialProfiles([
            null,
            { ...profile, id: 'bad identity' },
            { ...profile, id: 'bad-framing', settings: { ...profile.settings, parity: 'mark' } },
            { ...profile, id: 'bad-baud', settings: { ...profile.settings, baudRate: '9600' } },
            {
                ...profile,
                documentId: 'transient-grant',
                sessionId: 'native-session',
                password: 'discard',
            },
            { ...profile, name: 'Updated', settings: { ...profile.settings, injected: 'discard' } },
        ]),
        [{ ...profile, name: 'Updated' }],
    );
});

test('Serial profile saves publish only after acknowledgement, reject deleted edits and preserve native errors', async () => {
    let release: () => void = () => assert.fail('save has not started');
    let calls = 0;
    const store = settingsStore(async () => {
        calls++;
        await new Promise<void>((resolve) => {
            release = resolve;
        });
    });
    const pending = store.get().saveSerialProfile(draft, undefined, { creationId: profile.id });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.get().settings.serialProfiles.length, 0);
    release();
    assert.deepEqual(structuredClone(await pending), profile);
    assert.deepEqual(structuredClone(store.get().settings.serialProfiles), [profile]);
    await assert.rejects(store.get().saveSerialProfile(draft, 'removed'), /no longer exists/);
    assert.equal(calls, 1);
    const failed = settingsStore(async () => {
        throw new Error('disk unavailable');
    });
    await assert.rejects(failed.get().saveSerialProfile(draft), /disk unavailable/);
    assert.equal(failed.get().settings.serialProfiles.length, 0);
    await assert.rejects(store.get().updateSettings({ serialProfiles: [] }), /profile editor/);
});

test('a save conflict can retry its original Serial creation identity without duplicating a committed profile', async () => {
    let release: () => void = () => assert.fail('save has not started');
    let disk: SerialProfile[] = [];
    let first = true;
    const store = settingsStore(async (patch) => {
        disk = structuredClone(patch.serialProfiles);
        if (first) {
            first = false;
            await new Promise<void>((resolve) => {
                release = resolve;
            });
        }
    });
    const pending = store.get().saveSerialProfile(draft, undefined, { creationId: profile.id });
    await new Promise((resolve) => setImmediate(resolve));
    store.set({
        settingsLoadGeneration: store.get().settingsLoadGeneration + 1,
        settings: { ...store.get().settings, serialProfiles: disk },
    });
    release();
    await assert.rejects(pending, /changed during the save/);
    await store
        .get()
        .saveSerialProfile({ ...draft, name: 'Renamed' }, undefined, { creationId: profile.id });
    assert.equal(store.get().settings.serialProfiles.length, 1);
    assert.equal(store.get().settings.serialProfiles[0].name, 'Renamed');
    assert.equal(disk.length, 1);
});

test('deleting a Serial profile closes its own tab only after a successful metadata write', async () => {
    const failed = settingsStore(async () => {
        throw new Error('disk unavailable');
    });
    failed.set({
        settings: { ...failed.get().settings, serialProfiles: [profile] },
        tabs: [
            {
                id: 'console',
                type: 'serial',
                title: profile.name,
                view: 'serial',
                serialProfileId: profile.id,
            },
        ],
    });
    await assert.rejects(failed.get().deleteSerialProfile(profile.id), /disk unavailable/);
    assert.deepEqual(failed.closed, []);
    assert.equal(failed.get().settings.serialProfiles.length, 1);
    const store = settingsStore(async () => undefined);
    store.set({
        settings: { ...store.get().settings, serialProfiles: [profile] },
        tabs: failed.get().tabs,
    });
    await store.get().deleteSerialProfile(profile.id);
    assert.deepEqual(store.closed, ['console']);
    assert.equal(store.get().settings.serialProfiles.length, 0);
});

test('standalone Serial tabs deduplicate, have no local shell binding and consume explicit open only once', () => {
    const store = presentationStore();
    store.set({ settings: { serialProfiles: [profile] } as AppStore['settings'] });
    store.get().openSerialTab(profile.id);
    const tab = store.get().tabs[0];
    assert.equal(tab.type, 'serial');
    assert.equal(tab.connectionId, undefined);
    assert.equal(store.get().activeConnectionId, null);
    assert.equal(tab.serialConnectRequest, undefined);
    store.get().openSerialTab(profile.id, { connect: true });
    assert.equal(store.get().tabs.length, 1);
    assert.equal(store.get().takeSerialConnectRequest(tab.id, profile), true);
    assert.equal(store.get().takeSerialConnectRequest(tab.id, profile), false);
    store.get().openSerialTab('missing', { connect: true });
    assert.equal(store.get().tabs.length, 1);
});

test('stale Serial connection requests cannot open changed hardware or run in an inactive tab', () => {
    const store = presentationStore();
    store.set({ settings: { serialProfiles: [profile] } as AppStore['settings'] });
    store.get().openSerialTab(profile.id, { connect: true });
    const tab = store.get().tabs[0];
    store.set({ activeTabId: 'another-tab' });
    assert.equal(store.get().takeSerialConnectRequest(tab.id, profile), false);
    assert.ok(store.get().tabs[0].serialConnectRequest);
    store.set({ activeTabId: tab.id });
    const changed = { ...profile, settings: { ...profile.settings, baudRate: 9600 } };
    store.set({ settings: { ...store.get().settings, serialProfiles: [changed] } });
    assert.equal(store.get().takeSerialConnectRequest(tab.id, profile), false);
    assert.equal(store.get().tabs[0].serialConnectRequest, undefined);
    store.get().openSerialTab(profile.id, { connect: true });
    assert.equal(
        store.get().takeSerialConnectRequest(tab.id, profile),
        false,
        'wait for the new profile to commit',
    );
    assert.equal(store.get().takeSerialConnectRequest(tab.id, changed), true);
    assert.equal(sameSerialConnectionInputs(profile, { ...profile, lineEnding: 'crlf' }), false);
});

test('Serial session snapshots exclude transient opens and restore only one idle tab per live profile', () => {
    const store = presentationStore();
    store.set({ settings: { serialProfiles: [profile] } as AppStore['settings'], connections: [] });
    store.get().openSerialTab(profile.id, { connect: true });
    const saved = buildSessionData(store.get());
    assert.equal(saved.tabs[0].serialProfileId, profile.id);
    assert.ok(!('serialConnectRequest' in saved.tabs[0]));
    store.get().restoreTabState(
        [
            { ...saved.tabs[0], connectionId: 'local', view: 'terminal' },
            { ...saved.tabs[0], id: 'duplicate' },
            { ...saved.tabs[0], id: 'missing', serialProfileId: 'removed' },
        ],
        saved.tabs[0].id,
        'local',
    );
    assert.equal(store.get().tabs.length, 1);
    assert.equal(store.get().tabs[0].view, 'serial');
    assert.equal(store.get().tabs[0].title, profile.name);
    assert.equal(store.get().tabs[0].connectionId, undefined);
    assert.equal(store.get().tabs[0].serialConnectRequest, undefined);
    assert.equal(store.get().activeConnectionId, null);
});
