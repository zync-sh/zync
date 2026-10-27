import assert from 'node:assert/strict';

import {
    filePathCrumbs,
    filePathDisplayCrumbs,
    filePathRoot,
    filePathSeparator,
    inferHomePath,
    isFilePathDriveRoot,
    isFilePathUnder,
    parentFilePath,
} from '../../src/components/file-manager/filePathNav';

function runTest(name: string, fn: () => void) {
    try {
        fn();
        console.log(`  ok ${name}`);
    } catch (error) {
        console.error(`  fail ${name}`);
        throw error;
    }
}

runTest('posix crumbs start at root without a leading gap', () => {
    assert.deepEqual(filePathCrumbs('/home/admin/.config'), [
        { label: '/', path: '/' },
        { label: 'home', path: '/home' },
        { label: 'admin', path: '/home/admin' },
        { label: '.config', path: '/home/admin/.config' },
    ]);
});

runTest('windows crumbs keep the drive root', () => {
    assert.deepEqual(filePathCrumbs('C:\\Users\\gajen'), [
        { label: 'C:', path: 'C:\\' },
        { label: 'Users', path: 'C:\\Users' },
        { label: 'gajen', path: 'C:\\Users\\gajen' },
    ]);
});

runTest('parentFilePath stops at posix and drive roots', () => {
    assert.equal(parentFilePath('/home/admin'), '/home');
    assert.equal(parentFilePath('/home'), '/');
    assert.equal(parentFilePath('/'), null);
    assert.equal(parentFilePath('C:\\Users\\gajen'), 'C:\\Users');
    assert.equal(parentFilePath('C:\\Users'), 'C:\\');
    assert.equal(parentFilePath('C:\\'), null);
    assert.equal(filePathRoot('/a/b'), '/');
    assert.equal(filePathRoot('D:\\foo'), 'D:\\');
    assert.equal(filePathRoot('\\\\server\\share\\dir'), '\\\\server\\share\\');
    assert.equal(parentFilePath('\\\\server\\share\\dir'), '\\\\server\\share\\');
    assert.equal(parentFilePath('\\\\server\\share'), null);
    assert.equal(parentFilePath('\\\\server\\share\\'), null);
});

runTest('display crumbs collapse home', () => {
    assert.deepEqual(filePathDisplayCrumbs('/home/admin/.config', { homePath: '/home/admin' }), [
        { label: 'Home', path: '/home/admin', kind: 'home' },
        { label: '.config', path: '/home/admin/.config', kind: 'folder' },
    ]);
});

runTest('display crumbs use OS name outside home', () => {
    assert.deepEqual(
        filePathDisplayCrumbs('/etc/ssh', { homePath: '/home/admin', osName: 'Ubuntu' }),
        [
            { label: 'Ubuntu', path: '/', kind: 'os' },
            { label: 'etc', path: '/etc', kind: 'folder' },
            { label: 'ssh', path: '/etc/ssh', kind: 'folder' },
        ],
    );
});

runTest('posix names may contain a backslash', () => {
    assert.equal(filePathSeparator('/tmp/a\\b'), '/');
    assert.deepEqual(filePathCrumbs('/tmp/a\\b'), [
        { label: '/', path: '/' },
        { label: 'tmp', path: '/tmp' },
        { label: 'a\\b', path: '/tmp/a\\b' },
    ]);
});

runTest('inferHomePath uses Users folder on Windows', () => {
    assert.equal(inferHomePath('', 'C:\\Users\\gajen\\Documents'), 'C:\\Users\\gajen');
    assert.equal(inferHomePath('/home/admin', '/etc'), '/home/admin');
    assert.equal(inferHomePath('/', '/etc'), '');
    assert.equal(inferHomePath('', '/etc'), '');
    assert.equal(isFilePathDriveRoot('C:\\'), true);
    assert.equal(isFilePathDriveRoot('C:\\Users\\gajen'), false);
    assert.equal(isFilePathDriveRoot('\\\\server\\share\\'), true);
    assert.equal(isFilePathDriveRoot('\\\\server\\share\\docs'), false);
    assert.equal(isFilePathDriveRoot('\\\\wsl.localhost\\Ubuntu\\'), true);
    assert.equal(isFilePathDriveRoot('\\\\wsl.localhost\\Ubuntu\\home'), false);
    assert.equal(inferHomePath('C:\\', 'C:\\'), '');
    assert.equal(inferHomePath('', 'C:\\'), '');
});

runTest('isFilePathUnder matches home prefix', () => {
    assert.equal(isFilePathUnder('/home/admin/.config', '/home/admin'), true);
    assert.equal(isFilePathUnder('/home', '/home/admin'), false);
});

console.log('filePathNav tests passed.');
