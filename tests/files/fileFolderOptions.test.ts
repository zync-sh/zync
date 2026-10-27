import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fileFolderOptions } from '../../src/components/file-manager/fileFolderOptions';
import type { FileEntry } from '../../src/components/file-manager/types';

const entry = (name: string, type: FileEntry['type'] = 'd'): Readonly<FileEntry> =>
    Object.freeze({
        name,
        type,
        path: 'not-used-for-navigation',
        size: 0,
        lastModified: 0,
        permissions: '',
        owner: '',
        group: '',
    });

test('folder options apply the hidden policy, exclude files/links/dot entries and use natural ordering', () => {
    const entries = Object.freeze([
        entry('folder10'),
        entry('folder2'),
        entry('.private'),
        entry('.'),
        entry('..'),
        entry('file.txt', '-'),
        entry('link', 'l'),
    ]);
    assert.deepEqual(fileFolderOptions(entries, '/srv', false), [
        { name: 'folder2', path: '/srv/folder2' },
        { name: 'folder10', path: '/srv/folder10' },
    ]);
    assert.equal(
        fileFolderOptions(entries, '/srv', true).some((folder) => folder.name === '.private'),
        true,
    );
    assert.equal(entries.length, 7);
});

test('folder options retain native roots, separators and literal spaces rather than trusting entry paths', () => {
    for (const [parent, expected] of [
        ['/', '/release candidate  '],
        ['C:\\', 'C:\\release candidate  '],
        ['C:\\Users\\me', 'C:\\Users\\me\\release candidate  '],
        ['\\\\server\\share\\', '\\\\server\\share\\release candidate  '],
    ]) {
        assert.deepEqual(fileFolderOptions([entry('release candidate  ')], parent, false), [
            { name: 'release candidate  ', path: expected },
        ]);
    }
    assert.deepEqual(fileFolderOptions([], '/empty', false), []);
});
