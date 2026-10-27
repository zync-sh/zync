import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    completeFileFolderPath,
    FILE_PATH_SUGGESTION_LIMIT,
    filePathCompletionQuery,
    filePathSuggestionMatches,
} from '../../src/components/file-manager/filePathCompletion';

test('POSIX completion finds one native parent without trimming names or interpreting dot segments', () => {
    const base = '/home/deploy/project';
    assert.deepEqual(filePathCompletionQuery(`${base}/co`, base), {
        parent: base,
        prefix: 'co',
        separator: '/',
    });
    assert.deepEqual(filePathCompletionQuery(`${base}/`, base), {
        parent: base,
        prefix: '',
        separator: '/',
    });
    assert.deepEqual(filePathCompletionQuery('/', base), {
        parent: '/',
        prefix: '',
        separator: '/',
    });
    assert.deepEqual(filePathCompletionQuery('src/release  ', base), {
        parent: `${base}/src`,
        prefix: 'release  ',
        separator: '/',
    });
    assert.deepEqual(filePathCompletionQuery('../config/', base), {
        parent: `${base}/../config`,
        prefix: '',
        separator: '/',
    });
    assert.deepEqual(filePathCompletionQuery('~/pr', base, '/home/deploy'), {
        parent: '/home/deploy',
        prefix: 'pr',
        separator: '/',
    });
    assert.deepEqual(filePathCompletionQuery('~', base, '/home/deploy'), {
        parent: '/home/deploy',
        prefix: '',
        separator: '/',
    });
    assert.equal(filePathCompletionQuery('~/pr', base), null);
    assert.equal(filePathCompletionQuery('', base), null);
    assert.equal(filePathCompletionQuery('src', ''), null);
    assert.equal(filePathCompletionQuery('src', '~'), null);
    assert.deepEqual(filePathCompletionQuery('folder\\name', base), {
        parent: base,
        prefix: 'folder\\name',
        separator: '/',
    });
});

test('Windows completion supports drive and complete UNC roots without network discovery', () => {
    const base = 'C:\\Users\\me';
    assert.deepEqual(filePathCompletionQuery('C:/Users/re', base), {
        parent: 'C:\\Users',
        prefix: 're',
        separator: '\\',
    });
    assert.deepEqual(filePathCompletionQuery('next/', 'C:/Users/me'), {
        parent: 'C:\\Users\\me\\next',
        prefix: '',
        separator: '\\',
    });
    assert.deepEqual(filePathCompletionQuery('C:\\', base), {
        parent: 'C:\\',
        prefix: '',
        separator: '\\',
    });
    assert.deepEqual(filePathCompletionQuery('..\\folder\\', base), {
        parent: 'C:\\Users\\me\\..\\folder',
        prefix: '',
        separator: '\\',
    });
    assert.deepEqual(filePathCompletionQuery('~\\Docs', base, base), {
        parent: base,
        prefix: 'Docs',
        separator: '\\',
    });
    assert.deepEqual(filePathCompletionQuery('\\\\server\\share\\', base), {
        parent: '\\\\server\\share\\',
        prefix: '',
        separator: '\\',
    });
    for (const value of ['C:', 'C:relative', '\\\\server', '\\\\server\\share', '\\rooted']) {
        assert.equal(filePathCompletionQuery(value, base), null);
    }
    assert.equal(filePathCompletionQuery('C:\\Users', '/srv'), null);
});

test('matching is literal and case-sensitive on POSIX, insensitive on Windows, and bounded without losing the total', () => {
    const folders = Object.freeze(
        ['src', 'SRC', 'src  ', '.ssh'].map((name) =>
            Object.freeze({ name, path: `/base/${name}` }),
        ),
    );
    assert.deepEqual(
        filePathSuggestionMatches(folders, {
            parent: '/base',
            prefix: 'sr',
            separator: '/',
        }).options.map((folder) => folder.name),
        ['src', 'src  '],
    );
    assert.equal(
        filePathSuggestionMatches(folders, { parent: 'C:\\', prefix: 'sr', separator: '\\' }).total,
        3,
    );
    assert.equal(
        filePathSuggestionMatches(folders, { parent: '/base', prefix: 'missing', separator: '/' })
            .total,
        0,
    );
    const many = Array.from({ length: 1000 }, (_, index) => ({
        name: `folder-${index}`,
        path: `/base/folder-${index}`,
    }));
    const matches = filePathSuggestionMatches(many, {
        parent: '/base',
        prefix: 'folder-',
        separator: '/',
    });
    assert.equal(matches.options.length, FILE_PATH_SUGGESTION_LIMIT);
    assert.equal(matches.total, 1000);
    assert.equal(completeFileFolderPath('/base/release  ', '/'), '/base/release  /');
    assert.equal(completeFileFolderPath('C:\\', '\\'), 'C:\\');
});
