import assert from 'node:assert/strict';

import {
    FILE_LIST_LAYOUT_LIMIT,
    FILE_LIST_LAYOUT_STORAGE_KEY,
    type FileDetailColumn,
    fileListColumns,
    fileListColumnWidth,
    fileListTracks,
    fileListWidth,
    fileNameParts,
    fileOptionId,
    loadFileListPreferences,
    normalizeFileListPreferences,
    saveFileListPreferences,
} from '../../src/components/file-manager/fileListPresentation';

assert.deepEqual(fileListColumns([]), ['name', 'modified', 'size']);
const details = Object.freeze(['owner', 'type', 'type', 'name', 'unknown']);
// Exercise stale or unknown persisted values at the runtime preference boundary.
assert.deepEqual(fileListColumns(details as readonly FileDetailColumn[]), [
    'name',
    'modified',
    'type',
    'owner',
    'size',
]);
assert.deepEqual(details, ['owner', 'type', 'type', 'name', 'unknown']);
assert.equal(fileListTracks(fileListColumns([])), '25rem 9rem 5rem');
assert.equal(fileListTracks(fileListColumns(['type', 'owner'])), '25rem 9rem 6.5rem 8rem 5rem');
assert.equal(fileListWidth(fileListColumns([])), '39rem');
assert.equal(fileListWidth(fileListColumns(['type'])), '45.5rem');
assert.equal(fileListWidth(fileListColumns(['type', 'owner'])), '53.5rem');
assert.deepEqual(fileNameParts(' report.v2.md'), { base: ' report.v2', extension: '.md' });
assert.deepEqual(fileNameParts('.env'), { base: '.env', extension: '' });
assert.deepEqual(fileNameParts('file.'), { base: 'file.', extension: '' });
assert.deepEqual(fileNameParts('name  '), { base: 'name  ', extension: '' });
assert.deepEqual(fileNameParts('file.unreasonablylongextension'), {
    base: 'file.unreasonablylongextension',
    extension: '',
});
assert.deepEqual(fileNameParts('backup.tar.gz'), { base: 'backup', extension: '.tar.gz' });
assert.deepEqual(fileNameParts('types.d.ts'), { base: 'types', extension: '.d.ts' });
assert.notEqual(fileOptionId('pane-a', 2), fileOptionId('pane-b', 2));
assert.notEqual(fileOptionId('pane-a', 2), fileOptionId('pane-a', 3));
console.log('Files column, literal-name and scoped identity presentation tests passed.');

const defaults = normalizeFileListPreferences(undefined);
assert.equal(fileListColumnWidth('name', 0), 12);
assert.equal(fileListColumnWidth('name', 10000), 80);
assert.equal(fileListColumnWidth('modified', Number.NaN), 9);
assert.equal(fileListColumnWidth('type', '12'), 6.5);
assert.deepEqual(
    normalizeFileListPreferences({
        details: [],
        widths: { name: -8, size: Infinity },
        sortColumn: '__proto__',
        sortDirection: 'other',
    }),
    { ...defaults, details: [], widths: { ...defaults.widths, name: 12 } },
);
const local = new Map<string, string>();
const storage = {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => {
        local.set(key, value);
    },
};
const changed = {
    ...defaults,
    widths: { ...defaults.widths, name: 32 },
    details: ['owner'] as FileDetailColumn[],
    sortColumn: 'size' as const,
    sortDirection: 'desc' as const,
};
assert.equal(saveFileListPreferences('host-a/pane-a', changed, storage), true);
assert.deepEqual(loadFileListPreferences('host-a/pane-a', storage), changed);
assert.deepEqual(loadFileListPreferences('host-a/pane-b', storage), defaults);
assert.deepEqual(loadFileListPreferences('host-b/pane-a', storage), defaults);
for (let index = 0; index < FILE_LIST_LAYOUT_LIMIT; index++) {
    saveFileListPreferences(`scope-${index}`, defaults, storage);
}
assert.equal(
    JSON.parse(local.get(FILE_LIST_LAYOUT_STORAGE_KEY)!).entries.length,
    FILE_LIST_LAYOUT_LIMIT,
);
assert.deepEqual(
    loadFileListPreferences('host-a/pane-a', storage),
    defaults,
    'old layout cache entries are evicted instead of growing indefinitely',
);
local.set(FILE_LIST_LAYOUT_STORAGE_KEY, '{broken');
assert.deepEqual(loadFileListPreferences('scope-1', storage), defaults);
local.set(FILE_LIST_LAYOUT_STORAGE_KEY, JSON.stringify({ version: 2, entries: [] }));
assert.deepEqual(loadFileListPreferences('scope-1', storage), defaults);
const deniedStorage = {
    getItem: () => {
        throw new Error('denied');
    },
    setItem: () => {
        throw new Error('full');
    },
};
assert.deepEqual(loadFileListPreferences('scope', deniedStorage), defaults);
assert.equal(saveFileListPreferences('scope', changed, deniedStorage), false);
assert.equal(fileListTracks(fileListColumns(['type']), changed.widths), '32rem 9rem 6.5rem 5rem');
assert.equal(fileListWidth(fileListColumns(['type']), changed.widths), '52.5rem');
console.log(
    'Files layout validation, workspace isolation, bounded storage and failure fallback checks passed.',
);
