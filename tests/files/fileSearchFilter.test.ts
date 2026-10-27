import assert from 'node:assert/strict';

import {
    fileMatchesQuery,
    fileMatchesSearchType,
} from '../../src/components/file-manager/fileSearchFilter';
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

const file = (name: string, type: FileEntry['type'] = '-'): FileEntry => ({
    name,
    type,
    size: 1,
    lastModified: 0,
    permissions: '644',
    path: `/${name}`,
    owner: '',
    group: '',
});

runTest('type filter folders', () => {
    assert.equal(fileMatchesSearchType(file('bin', 'd'), 'folders'), true);
    assert.equal(fileMatchesSearchType(file('a.png'), 'folders'), false);
    assert.equal(fileMatchesSearchType(file('a.png'), 'images'), true);
    assert.equal(fileMatchesSearchType(file('notes.txt'), 'text'), true);
});

runTest('query matches name case-insensitively', () => {
    assert.equal(fileMatchesQuery(file('README.md'), 'read'), true);
    assert.equal(fileMatchesQuery(file('README.md'), 'zzz'), false);
});

console.log('fileSearchFilter tests passed.');
