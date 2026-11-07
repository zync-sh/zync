import assert from 'node:assert/strict';
import { test } from 'node:test';

import { history, isolateHistory, undoDepth } from '@codemirror/commands';
import { EditorState, Transaction } from '@codemirror/state';

import { canSerializeCodeMirrorSession } from '../../src/components/editor/codemirror/sessionPreflight.js';
import { createPlainCursorIndex } from '../../src/components/editor/editorStatusReport.js';
import { indexPlainSearchMatches } from '../../src/components/editor/plainSearchIndex.js';

test('packed find offsets retain every match across block boundaries', () => {
    const input = 'ab '.repeat(50_000);
    const matches = indexPlainSearchMatches(input, 'ab');
    assert.equal(matches.length, 50_000);
    for (const index of [0, 4095, 4096, 8192, 49_999]) {
        assert.deepEqual(matches.at(index), { start: index * 3, end: index * 3 + 2 });
    }
    assert.equal(matches.at(-1), undefined);
    assert.equal(matches.at(matches.length), undefined);
    assert.equal(indexPlainSearchMatches(input, '').length, 0);
    assert.equal(
        indexPlainSearchMatches('aaaaa', 'aa').length,
        2,
        'retain existing non-overlapping search semantics',
    );
});

test('indexed cursor status preserves UTF-16 offsets, CRLF, trailing lines and clamping', () => {
    const index = createPlainCursorIndex(`${'x'.repeat(4095)}\n😀first\r\nsecond\n`);
    assert.deepEqual(index.position(-20), { line: 1, column: 1 });
    assert.deepEqual(index.position(4095), { line: 1, column: 4096 });
    assert.deepEqual(index.position(4096), { line: 2, column: 1 });
    assert.deepEqual(index.position(4098), { line: 2, column: 3 });
    assert.deepEqual(index.position(4105), { line: 3, column: 1 });
    assert.deepEqual(index.position(4200), { line: 4, column: 1 });
    assert.deepEqual(index.position(10), { line: 1, column: 11 });
});

const limits = { maxEntries: 8, maxEntryCharacters: 1024, maxTotalCharacters: 2048 };

test('snapshot preflight rejects oversized documents before flattening state', () => {
    const state = EditorState.create({ doc: 'x'.repeat(2048), extensions: history() });
    assert.equal(canSerializeCodeMirrorSession(state, 0, limits), false);
    assert.equal(state.doc.length, 2048, 'live document remains complete');
});

test('snapshot preflight recognizes retained deleted text even when the live document is tiny', () => {
    let state = EditorState.create({ doc: '', extensions: history() });
    state = state.update({
        changes: { from: 0, insert: 'x'.repeat(2048) },
        annotations: Transaction.userEvent.of('input'),
    }).state;
    state = state.update({
        changes: { from: 0, to: state.doc.length },
        annotations: [Transaction.userEvent.of('delete'), isolateHistory.of('full')],
    }).state;
    assert.equal(state.doc.length, 0);
    assert.ok(undoDepth(state) > 0);
    assert.equal(canSerializeCodeMirrorSession(state, 0, limits), false);
    assert.ok(undoDepth(state) > 0, 'preflight must not trim the active undo history');
});

test('snapshot preflight accepts ordinary history and checks saved baseline size', () => {
    let state = EditorState.create({ doc: 'original', extensions: history() });
    state = state.update({ changes: { from: 0, to: state.doc.length, insert: 'edited' } }).state;
    assert.equal(canSerializeCodeMirrorSession(state, 'original'.length, limits), true);
    assert.equal(canSerializeCodeMirrorSession(state, 2048, limits), false);
});
