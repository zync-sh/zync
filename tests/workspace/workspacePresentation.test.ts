import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Connection, Tab } from '../../src/features/connections/domain/types.js';
import {
    normalizeDisplayAlias,
    parseDisplayAliasDraft,
    reorderItemsById,
    resolveDisplayTitle,
} from '../../src/features/workspace/domain/presentation.js';
import { buildSessionData, type TabSnapshot } from '../../src/store/sessionPersistence.js';
import { presentationStore as connectionStore } from './presentationFixture.js';

test('interactive alias validation counts canonical text and never truncates an overlong draft', () => {
    for (const [value, expected] of [
        ['e\u0301'.repeat(80), 'é'.repeat(80)],
        ['  Work' + ' \t\u202e'.repeat(100) + 'host  ', 'Work host'],
        ['😀'.repeat(80), '😀'.repeat(80)],
        ['\u200b\u2060\u202e', undefined],
    ] as const) {
        assert.deepEqual(parseDisplayAliasDraft(value), { ok: true, alias: expected });
    }
    for (const value of ['x'.repeat(81), '😀'.repeat(81), '\u0344'.repeat(41)]) {
        // NFC expands U+0344 into two combining marks; validate after that expansion too.
        assert.deepEqual(parseDisplayAliasDraft(value), { ok: false, reason: 'too-long' });
        assert.equal(
            Array.from(normalizeDisplayAlias(value) ?? '').length,
            80,
            'Persistence remains bounded for legacy input',
        );
    }
});

test('aliases normalize Unicode text and reject malformed values without becoming identifiers', () => {
    for (const value of [
        undefined,
        null,
        123,
        {},
        [],
        '',
        ' \n\t ',
        '\u202e',
        '\u200b',
        '\u2060',
    ]) {
        assert.equal(normalizeDisplayAlias(value), undefined);
    }
    assert.equal(normalizeDisplayAlias('  Cafe\u0301  🐱 工作  '), 'Café 🐱 工作');
    assert.equal(normalizeDisplayAlias('A\u202eB\nC'), 'A B C');
    assert.equal(Array.from(normalizeDisplayAlias('🐱'.repeat(100)) ?? '').length, 80);
    assert.equal(resolveDisplayTitle('Server', 'Build host'), 'Build host');
    assert.equal(resolveDisplayTitle('New server title', ' '), 'New server title');
});

test('reorder operates on stable IDs, shares item identity and handles stale or ambiguous targets', () => {
    const a = { id: 'a' },
        b = { id: 'b' },
        c = { id: 'c' };
    const items = [a, b, c];
    assert.deepEqual(reorderItemsById(items, 'a', 'c'), [b, c, a]);
    assert.deepEqual(reorderItemsById(items, 'c', 'a'), [c, a, b]);
    for (const [from, to] of [
        ['a', 'a'],
        ['missing', 'a'],
        ['a', 'missing'],
    ]) {
        assert.equal(reorderItemsById(items, from, to), items);
    }
    const duplicate = [a, b, a];
    assert.equal(reorderItemsById(duplicate, 'a', 'b'), duplicate);
    assert.deepEqual(items, [a, b, c]);
});

test('alias actions preserve resource identity, dynamic titles and host configuration', () => {
    const store = connectionStore();
    const connection: Connection = {
        id: 'host',
        name: 'Actual host',
        host: 'localhost',
        port: 22,
        username: 'test',
        status: 'disconnected',
    };
    const tab: Tab = {
        id: 'workspace',
        type: 'connection',
        title: 'Actual host',
        connectionId: 'host',
        view: 'terminal',
    };
    store.set({ connections: [connection], tabs: [tab] });
    store.get().setTabDisplayAlias('workspace', '  My workspace ');
    assert.equal(store.get().tabs[0].displayAlias, 'My workspace');
    assert.equal(store.get().tabs[0].id, tab.id);
    assert.equal(store.get().tabs[0].title, tab.title);
    assert.equal(store.get().tabs[0].connectionId, tab.connectionId);
    assert.equal(store.get().connections[0], connection);
    const aliased = store.get().tabs;
    store.get().setTabDisplayAlias('missing', 'No-op');
    assert.equal(store.get().tabs, aliased);
    store.get().setTabDisplayAlias('workspace', undefined);
    assert.equal(store.get().tabs[0].displayAlias, undefined);
    assert.equal(resolveDisplayTitle(store.get().tabs[0].title), 'Actual host');
});

test('legacy index reorder delegates safely and stale drag IDs cannot insert undefined tabs', () => {
    const store = connectionStore();
    const tabs: Tab[] = ['a', 'b', 'c'].map((id) => ({
        id,
        type: 'connection',
        title: id,
        view: 'terminal',
    }));
    store.set({ tabs });
    for (const [from, to] of [
        [-1, 0],
        [0, -1],
        [0, 3],
        [0.5, 1],
        [NaN, 1],
        [0, Infinity],
    ]) {
        store.get().reorderTabs(from, to);
        assert.equal(store.get().tabs, tabs);
    }
    store.get().reorderWorkspaceTab('gone', 'a');
    assert.equal(store.get().tabs, tabs);
    store.get().reorderTabs(0, 2);
    assert.deepEqual(
        Array.from(store.get().tabs, (tab) => tab.id),
        ['b', 'c', 'a'],
    );
});

test('session snapshot and restore roundtrip aliases independently of canonical titles', () => {
    const store = connectionStore();
    store.set({
        tabs: [
            {
                id: 'local-tab',
                type: 'connection',
                title: 'Local terminal',
                connectionId: 'local',
                view: 'terminal',
                displayAlias: '  Work  ',
            },
        ],
        activeTabId: 'local-tab',
    });
    const snapshot = buildSessionData({ ...store.get(), terminals: {}, activeTerminalIds: {} });
    assert.equal(snapshot.tabs[0].displayAlias, 'Work');
    assert.equal(snapshot.tabs[0].title, 'Local terminal');
    store.get().restoreTabState(snapshot.tabs, snapshot.activeTabId ?? null, 'local');
    assert.equal(store.get().tabs[0].displayAlias, 'Work');
    assert.equal(store.get().tabs[0].title, 'Local terminal');
    const legacy = { ...snapshot.tabs[0] };
    delete legacy.displayAlias;
    store
        .get()
        .restoreTabState(
            [legacy, legacy, { ...legacy, id: '' }, null] as TabSnapshot[],
            'local-tab',
            'local',
        );
    assert.equal(store.get().tabs.length, 1);
    assert.equal(store.get().tabs[0].displayAlias, undefined);
    store
        .get()
        .restoreTabState(
            [{ ...legacy, tabType: 'unknown' }, { ...legacy, connectionId: 'deleted' }, legacy],
            'local-tab',
            'local',
        );
    assert.equal(
        store.get().tabs.length,
        1,
        'Invalid snapshots cannot shadow a later valid duplicate',
    );
    assert.equal(store.get().tabs[0].connectionId, 'local');
});
