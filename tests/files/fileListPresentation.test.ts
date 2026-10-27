import assert from 'node:assert/strict';

import {
    type FileDetailColumn,
    fileListColumns,
    fileListTracks,
    fileNameParts,
    fileOptionId,
} from '../../src/components/file-manager/fileListPresentation';

assert.deepEqual(fileListColumns([]), ['name', 'size', 'modified']);
const details = Object.freeze(['owner', 'type', 'type', 'name', 'unknown']);
// Exercise stale or unknown persisted values at the runtime preference boundary.
assert.deepEqual(fileListColumns(details as readonly FileDetailColumn[]), [
    'name',
    'size',
    'modified',
    'type',
    'owner',
]);
assert.deepEqual(details, ['owner', 'type', 'type', 'name', 'unknown']);
assert.equal(
    fileListTracks(fileListColumns([])),
    'minmax(0, min(var(--files-name-limit, 25rem), calc(100% - 14rem))) 5rem 9rem',
);
assert.equal(
    fileListTracks(fileListColumns(['type', 'owner'])),
    'minmax(0, min(var(--files-name-limit, 25rem), calc(100% - 28.5rem))) 5rem 9rem 6.5rem 8rem',
);
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
