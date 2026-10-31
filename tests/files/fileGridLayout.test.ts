import assert from 'node:assert/strict';

import {
    computeFileGridMetrics,
    FILE_LIST_COLUMNS,
    FILE_LIST_SORT_INITIAL,
    fileGridColumnPitch,
    fileGridInlineOffset,
    fileGridScrollTarget,
    fileHoverHint,
    fileIconGridTemplateColumns,
    fileListSortTooltip,
    formatFileExplorerDate,
    formatFileIdentity,
    formatFileListDate,
    formatFileListType,
    sortFileEntries,
} from '../../src/components/file-manager/fileGridLayout';
import type { FileEntry } from '../../src/components/file-manager/types';

function runTest(name: string, fn: () => void) {
    try {
        fn();
        console.log(`  ok ${name}`);
    } catch (error) {
        console.error(`  fail ${name}`);
        throw error;
    }
}

function entry(
    name: string,
    type: FileEntry['type'] = '-',
    size = 0,
    lastModified = 0,
    owner = '',
    group = '',
): FileEntry {
    return { name, type, size, lastModified, permissions: '', path: `/${name}`, owner, group };
}

runTest('sortFileEntries puts directories first then name', () => {
    const sorted = sortFileEntries(
        [entry('b.txt'), entry('a', 'd'), entry('c.txt')],
        'name',
        'asc',
    );
    assert.deepEqual(
        Array.from(sorted, (f) => f.name),
        ['a', 'b.txt', 'c.txt'],
    );
});

runTest('sortFileEntries reverses non-dir comparison on desc', () => {
    const sorted = sortFileEntries(
        [entry('b.txt', '-', 2), entry('a.txt', '-', 1)],
        'size',
        'desc',
    );
    assert.deepEqual(
        Array.from(sorted, (f) => f.name),
        ['b.txt', 'a.txt'],
    );
});

runTest('computeFileGridMetrics compact column count', () => {
    const m = computeFileGridMetrics(332, true);
    assert.equal(m.gap, 6);
    assert.equal(m.minTrack, 90);
    assert.equal(m.columnCount, 3);
    assert.equal(m.columnWidth, 96);
    assert.ok(m.minTrack * m.columnCount <= 332);
});

runTest(
    'fileIconGridTemplateColumns keeps tile widths stable and fits a narrow single track',
    () => {
        assert.equal(fileIconGridTemplateColumns(108), 'repeat(auto-fill, min(100%, 108px))');
    },
);

runTest('grid columns retain minimum tracks and share marquee geometry during resizing', () => {
    assert.equal(fileIconGridTemplateColumns(108, 9), 'repeat(9, min(100%, 108px))');
    assert.equal(fileGridColumnPitch(900, 108, 8), 116);
    assert.equal(fileGridColumnPitch(1200, 108, 8), 116);
    assert.equal(fileGridColumnPitch(60, 108, 8), 68);
});

runTest('computeFileGridMetrics zoom minTrack is independent of viewport', () => {
    const a = computeFileGridMetrics(200, false, 2);
    const b = computeFileGridMetrics(900, false, 2);
    assert.equal(a.minTrack, 128);
    assert.equal(b.minTrack, 128);
    assert.equal(a.gap, 8);
    assert.ok(b.columnCount > a.columnCount);
});

runTest('fileGridScrollTarget rejects a cell past the live grid', () => {
    assert.equal(fileGridScrollTarget(23, 8, 2), null);
    assert.deepEqual({ ...fileGridScrollTarget(23, 8, 4) }, { rowIndex: 2, columnIndex: 7 });
    assert.equal(fileGridScrollTarget(-1, 8, 4), null);
    assert.equal(fileGridScrollTarget(0, 8, 0), null);
});

runTest('FILE_LIST_COLUMNS preserves fixed Name, Modified and Size tracks', () => {
    assert.equal(FILE_LIST_COLUMNS, '25rem 9rem 5rem');
});

runTest('formatFileListDate uses time today and short date otherwise', () => {
    const now = Date.parse('2026-09-10T15:00:00');
    assert.ok(formatFileListDate(Date.parse('2026-09-10T08:32:00'), now).length > 0);
    const thisYear = formatFileListDate(Date.parse('2026-03-19T12:00:00'), now);
    assert.ok(thisYear.length > 0);
    assert.equal(thisYear.includes('2026'), false);
    assert.equal(formatFileListDate(Date.parse('2025-11-20T12:00:00'), now).includes('2025'), true);
    assert.equal(formatFileListDate(0, now), '');
    const y2kMs = Date.parse('2000-06-15T12:00:00Z');
    assert.equal(formatFileListDate(y2kMs, now).includes('2000'), true);
    const y2kSeconds = Math.floor(y2kMs / 1000);
    assert.equal(formatFileListDate(y2kSeconds, now).includes('2000'), true);
});

runTest('formatFileListType matches Explorer-style labels', () => {
    assert.equal(formatFileListType(entry('docs', 'd')), 'File folder');
    assert.equal(formatFileListType(entry('link', 'l')), 'Link');
    assert.equal(formatFileListType(entry('.config')), 'CONFIG File');
    assert.equal(formatFileListType(entry('shot.png')), 'PNG File');
    assert.equal(formatFileListType(entry('.bash_history')), 'File');
    assert.equal(formatFileListType(entry('README')), 'File');
});

runTest('formatFileIdentity joins owner:group', () => {
    assert.equal(formatFileIdentity('admin', 'admin'), 'admin:admin');
    assert.equal(formatFileIdentity('root', 'staff'), 'root:staff');
    assert.equal(formatFileIdentity('', ''), '');
    assert.equal(formatFileIdentity('root', ''), 'root');
});

runTest('fileListSortTooltip explains current and next sort', () => {
    assert.equal(FILE_LIST_SORT_INITIAL.size, 'desc');
    assert.equal(FILE_LIST_SORT_INITIAL.modified, 'desc');
    assert.ok(fileListSortTooltip('name', 'name', 'asc').includes('A to Z'));
    assert.ok(fileListSortTooltip('name', 'name', 'asc').includes('Z to A'));
    assert.ok(fileListSortTooltip('modified', 'name', 'asc').includes('newest first'));
});

runTest('sortFileEntries compares combined owner:group', () => {
    const byOwner = sortFileEntries(
        [entry('b.txt', '-', 0, 0, 'root', 'root'), entry('a.txt', '-', 0, 0, 'alice', 'alice')],
        'owner',
        'asc',
    );
    assert.deepEqual(
        Array.from(byOwner, (f) => f.name),
        ['a.txt', 'b.txt'],
    );
});

runTest('fileHoverHint lists name and folder', () => {
    const text = fileHoverHint(entry('docs', 'd'));
    assert.ok(text.includes('docs'));
    assert.ok(text.includes('Folder'));
});

console.log('fileGridLayout tests passed.');

runTest('fixed grid tracks share centered offsets with virtual marquee geometry', () => {
    assert.equal(fileGridInlineOffset(338, 86, 6, 3), 34);
    assert.equal(fileGridInlineOffset(178, 86, 6, 2), 0);
    assert.equal(fileGridInlineOffset(60, 108, 8, 1), 0);
    assert.equal(fileGridInlineOffset(80, 108, 8, 2), 0);
});
