import assert from 'node:assert/strict';

import {
    type FileVolume,
    fileVolumeDisplayLabel,
    fileVolumesSectionTitle,
    matchingVolumePath,
} from '../../src/components/file-manager/fileVolumes';

function runTest(name: string, fn: () => void) {
    try {
        fn();
        console.log(`  ok ${name}`);
    } catch (error) {
        console.error(`  fail ${name}`);
        throw error;
    }
}

runTest('fileVolumesSectionTitle is platform-native', () => {
    assert.equal(fileVolumesSectionTitle('Win32'), 'This PC');
    assert.equal(fileVolumesSectionTitle('win32'), 'This PC');
    assert.equal(fileVolumesSectionTitle('MacIntel'), 'Volumes');
    assert.equal(fileVolumesSectionTitle('darwin'), 'Volumes');
    assert.equal(fileVolumesSectionTitle('Linux x86_64'), 'Other Locations');
});

runTest('fileVolumeDisplayLabel prefers label plus Windows letter', () => {
    assert.equal(
        fileVolumeDisplayLabel({
            id: 'C:\\',
            path: 'C:\\',
            label: 'Windows',
            letter: 'C:',
            kind: 'fixed',
        }),
        'Windows (C:)',
    );
    assert.equal(
        fileVolumeDisplayLabel({
            id: 'D:\\',
            path: 'D:\\',
            label: '',
            letter: 'D:',
            kind: 'fixed',
        }),
        'Local Disk (D:)',
    );
    assert.equal(
        fileVolumeDisplayLabel({ id: '/', path: '/', label: 'Filesystem', kind: 'fixed' }),
        'Filesystem',
    );
});

runTest('matchingVolumePath uses the longest prefix', () => {
    const volumes: FileVolume[] = [
        { id: 'C:\\', path: 'C:\\', label: 'Windows', letter: 'C:', kind: 'fixed' },
        { id: 'D:\\', path: 'D:\\', label: 'Data', letter: 'D:', kind: 'fixed' },
    ];
    assert.equal(matchingVolumePath('D:\\Projects\\zync', volumes), 'D:\\');
    assert.equal(matchingVolumePath('C:\\Users', volumes), 'C:\\');
    const unix: FileVolume[] = [
        { id: '/', path: '/', label: 'Filesystem', kind: 'fixed' },
        { id: '/media/usb', path: '/media/usb', label: 'USB', kind: 'removable' },
    ];
    assert.equal(matchingVolumePath('/media/usb/docs', unix), '/media/usb');
    assert.equal(matchingVolumePath('/home', unix), '/');
    assert.equal(matchingVolumePath('/tmp', []), null);
});

runTest('matchingVolumePath does not highlight C: while inside Home', () => {
    const volumes: FileVolume[] = [
        { id: 'C:\\', path: 'C:\\', label: 'Windows', letter: 'C:', kind: 'fixed' },
        { id: 'D:\\', path: 'D:\\', label: 'Data', letter: 'D:', kind: 'fixed' },
    ];
    assert.equal(
        matchingVolumePath('C:\\Users\\gajen\\Desktop', volumes, 'C:\\Users\\gajen'),
        null,
    );
    assert.equal(matchingVolumePath('C:\\Windows', volumes, 'C:\\Users\\gajen'), 'C:\\');
    const linux: FileVolume[] = [
        { id: '/', path: '/', label: 'Filesystem', kind: 'fixed' },
        { id: '/home', path: '/home', label: 'home', kind: 'fixed' },
    ];
    assert.equal(matchingVolumePath('/home/gajen/src', linux, '/home/gajen'), null);
    assert.equal(matchingVolumePath('/home', linux, '/home/gajen'), '/home');
});

runTest('matchingVolumePath is case-insensitive on Windows and case-sensitive on POSIX', () => {
    const volumes: FileVolume[] = [
        { id: 'C:\\', path: 'C:\\', label: 'Windows', letter: 'C:', kind: 'fixed' },
    ];
    assert.equal(matchingVolumePath('c:\\Windows', volumes, 'C:\\Users\\gajen'), 'C:\\');
    assert.equal(
        matchingVolumePath('C:\\USERS\\gajen\\Desktop', volumes, 'c:\\Users\\gajen'),
        null,
    );
    const posix: FileVolume[] = [{ id: '/Home', path: '/Home', label: 'Home', kind: 'fixed' }];
    assert.equal(matchingVolumePath('/home', posix), null);
    assert.equal(matchingVolumePath('/Home/docs', posix), '/Home');
});

console.log('fileVolumes tests passed.');
