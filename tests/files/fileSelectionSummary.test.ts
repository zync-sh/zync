import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { FileSelectionMark } from '../../src/components/file-manager/FileSelectionMark';
import {
    filePropertiesEntries,
    fileSelectionSizeLabel,
    fileSelectionSummary,
} from '../../src/components/file-manager/fileSelectionSummary';
import type { FileEntry } from '../../src/components/file-manager/types';

const file = (name: string, size: number, type: FileEntry['type'] = '-'): FileEntry => ({
    name,
    size,
    type,
    lastModified: 0,
    permissions: '',
    path: `/${name}`,
    owner: '',
    group: '',
});

test('Properties resolves large selections in one listing pass while preserving selection order', () => {
    let nameReads = 0;
    const count = 5000;
    const entries = Array.from({ length: count }, (_, index) => {
        const entry = file(`entry-${index}`, index);
        Object.defineProperty(entry, 'name', {
            get() {
                nameReads++;
                return `entry-${index}`;
            },
        });
        return entry;
    });
    const names = Array.from({ length: count }, (_, index) => `entry-${count - index - 1}`);
    const selected = filePropertiesEntries(entries, names, null, true);
    assert.equal(nameReads, count, 'Selection size must not multiply directory scans');
    assert.equal(selected.length, count);
    for (let index = 0; index < count; index++) {
        assert.equal(selected[index], entries[count - index - 1]);
    }
    nameReads = 0;
    assert.deepEqual(filePropertiesEntries(entries, [], 'entry-0', true), [entries[0]]);
    assert.equal(nameReads, 1, 'A small selection stops once its requested names are found');
});

test('Properties preserves duplicate selection names, first listing matches and missing-name behavior', () => {
    const first = Object.freeze(file('same', 1));
    const duplicate = Object.freeze(file('same', 2));
    const hidden = Object.freeze(file('.hidden', 3));
    const focused = Object.freeze(file('focused', 4));
    const entries = Object.freeze([first, duplicate, hidden, focused]);
    const names = Object.freeze(['.hidden', 'missing', 'same', 'same']);
    assert.deepEqual(filePropertiesEntries(entries, names, 'focused', true), [
        hidden,
        first,
        first,
    ]);
    assert.deepEqual(filePropertiesEntries(entries, ['missing'], 'focused', true), []);
    assert.deepEqual(filePropertiesEntries(entries, [], 'focused', true), [focused]);
    assert.deepEqual(filePropertiesEntries(entries, [], 'missing', true), []);
    assert.deepEqual(filePropertiesEntries(entries, [], null, true), []);
    assert.equal(entries.length, 4);
    assert.deepEqual(names, ['.hidden', 'missing', 'same', 'same']);
});

test('closed Properties does not inspect a listing or resolve a focused fallback', () => {
    const unread = new Proxy<FileEntry[]>([], {
        get() {
            throw new Error('Closed Properties must not touch directory entries');
        },
    });
    assert.deepEqual(filePropertiesEntries(unread, ['selected'], 'focused', false), []);
    assert.deepEqual(filePropertiesEntries(unread, [], 'focused', false), []);
    assert.deepEqual(filePropertiesEntries(unread, [], null, true), []);
});

test('selection summary never mistakes directory metadata for recursive size or follows links', () => {
    const entries = [
        file('a.txt', 1024),
        file('empty', 0),
        file('folder', 4096, 'd'),
        file('link', 8192, 'l'),
    ];
    assert.deepEqual(
        fileSelectionSummary(
            entries,
            entries.map((entry) => entry.name),
        ),
        {
            count: 4,
            files: 2,
            folders: 1,
            links: 1,
            bytes: 1024,
            unknownSizes: 1,
        },
    );
    assert.deepEqual(fileSelectionSummary(entries, ['folder']), {
        count: 1,
        files: 0,
        folders: 1,
        links: 0,
        bytes: 0,
        unknownSizes: 1,
    });
});

test('selection summary retains hidden selections, ignores vanished/duplicate names and never mutates its inputs', () => {
    const entries = Object.freeze([
        Object.freeze(file('.hidden', 256)),
        Object.freeze(file('a.txt', 1024)),
    ]);
    const names = Object.freeze(['.hidden', '.hidden', 'gone']);
    assert.deepEqual(fileSelectionSummary(entries, names), {
        count: 1,
        files: 1,
        folders: 0,
        links: 0,
        bytes: 256,
        unknownSizes: 0,
    });
    assert.equal(fileSelectionSummary(entries, []).count, 0);
    assert.equal(names.length, 3);
});

test('invalid or unsafe file sizes stay explicitly unknown instead of poisoning the total', () => {
    const entries = [
        file('valid', 100),
        file('negative', -1),
        file('nan', NaN),
        file('infinite', Infinity),
        file('overflow', Number.MAX_SAFE_INTEGER),
    ];
    const result = fileSelectionSummary(
        entries,
        entries.map((entry) => entry.name),
    );
    assert.equal(result.count, 5);
    assert.equal(result.bytes, 100);
    assert.equal(result.unknownSizes, 4);
});

test('unknown totals are quiet while known, empty and partial file totals stay truthful', () => {
    const entries = [
        file('folder', 4096, 'd'),
        file('unknown', NaN),
        file('file', 1024),
        file('empty', 0),
        file('link', 8192, 'l'),
    ];
    const label = (names: string[]) => fileSelectionSizeLabel(fileSelectionSummary(entries, names));
    for (const names of [[], ['folder'], ['unknown'], ['folder', 'unknown'], ['link']]) {
        assert.equal(label(names), '');
    }
    assert.equal(label(['empty']), '0 B');
    assert.equal(label(['file']), '1 KB');
    assert.equal(label(['file', 'folder']), 'Partial · 1 KB');
});

test('selection mark is shared visual feedback, never a second interactive control inside an option', () => {
    for (const selected of [false, true]) {
        const html = renderToStaticMarkup(createElement(FileSelectionMark, { selected }));
        assert.match(html, /data-file-select="" aria-hidden="true"/);
        assert.match(html, /files-selection-box/);
        assert.equal(html.includes('<svg'), selected);
        assert.doesNotMatch(html, /<input|<button|tabindex=|role="checkbox"/);
    }
});
