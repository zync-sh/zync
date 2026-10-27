import {
    type FileAccessEvidence,
    type FilePermissionMetadata,
    fileActionAvailability,
    fileActionBlocked,
    filePermissionFailure,
    modeEditAvailability,
    ordinaryMode,
    parseOrdinaryMode,
    permissionMasks,
    unixModeString,
} from '../../src/features/files/domain/filePermissions';

function equal(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
    }
}

const nativeEvidence: FilePermissionMetadata['snapshot'] = {
    kind: 'File',
    size: '18446744073709551615',
    modified: '1792291234567890100',
    mode: null,
};
for (const message of [
    'SFTP read_dir failed: Permission denied: Permission denied',
    'EACCES: scandir /tmp/private',
    'Failed to read directory: Access is denied. (os error 5)',
]) {
    equal(filePermissionFailure(message), 'denied', 'actual native directory denial is classified');
}
equal(
    filePermissionFailure('read-only file system'),
    'readOnly',
    'read-only filesystem does not deny reading',
);
for (const message of [
    'session closed',
    'Sample permission denied',
    'Cannot read /tmp/Permission denied: Connection reset',
    'Cannot read /tmp/EACCES: No such file',
]) {
    equal(
        filePermissionFailure(message),
        null,
        'non-denials and denial phrases in paths stay unknown',
    );
}
equal(
    JSON.parse(JSON.stringify(nativeEvidence)),
    nativeEvidence,
    'permission evidence survives the native/JS/native wire without integer rounding',
);

for (const value of ['', '64', '0644', '888', ' 644', '644 ', '6a4', '-01', '0x4']) {
    equal(parseOrdinaryMode(value), null, `reject invalid ordinary mode ${JSON.stringify(value)}`);
}
for (let mode = 0; mode <= 0o777; mode++) {
    equal(parseOrdinaryMode(ordinaryMode(mode)), mode, 'ordinary mode round trip');
    const base = 0o2644;
    const { setBits, clearBits } = permissionMasks(base, ordinaryMode(mode));
    equal(setBits & clearBits, 0, 'masks are disjoint');
    equal((setBits | clearBits) & ~0o777, 0, 'masks never edit special bits');
    equal((base | setBits) & ~clearBits, 0o2000 | mode, 'special bits survive intended changes');
}
equal(unixModeString('000'), '---------', 'real zero mode');
equal(unixModeString('4755'), 'rwsr-xr-x', 'setuid with execute');
equal(unixModeString('2644'), 'rw-r-Sr--', 'setgid without execute');
equal(unixModeString('1777'), 'rwxrwxrwt', 'sticky with traverse');
equal(unixModeString('1700'), 'rwx-----T', 'sticky without traverse');
equal(unixModeString(''), '—', 'unknown is not zero');
equal(
    modeEditAvailability({ editUnavailable: null } as FilePermissionMetadata).state,
    'unknown',
    'mode bits never prove account authority',
);
equal(
    modeEditAvailability({
        editUnavailable: null,
        systemEditor: true,
    } as FilePermissionMetadata).reason.includes('Windows Properties'),
    true,
    'Windows editing is explicitly an OS-owned handoff, not Unix chmod',
);
equal(
    modeEditAvailability({
        editUnavailable: 'Windows ACL editing unavailable',
    } as FilePermissionMetadata),
    { state: 'unsupported', reason: 'Windows ACL editing unavailable' },
    'unsupported is not an account denial',
);
console.log(
    '  ok permission mode validation, all 512 ordinary modes, special bits and advisory support',
);

const access: FileAccessEvidence = {
    directory: '/folder',
    target: '/folder/file',
    directoryAccess: { createFile: false, createFolder: null },
    targetAccess: { read: true, write: false, rename: null, delete: true },
};
equal(
    fileActionBlocked(fileActionAvailability(access, 'write')),
    true,
    'native write denial blocks saving',
);
equal(
    fileActionBlocked(fileActionAvailability(access, 'delete')),
    false,
    'write denial does not block deletion',
);
equal(
    fileActionBlocked(fileActionAvailability(access, 'read')),
    false,
    'readable files remain readable',
);
equal(
    fileActionBlocked(fileActionAvailability(access, 'rename')),
    false,
    'unknown rename rights remain attemptable',
);
equal(
    fileActionBlocked(fileActionAvailability(access, 'createFile')),
    true,
    'create file has independent rights',
);
equal(
    fileActionBlocked(fileActionAvailability(access, 'receive')),
    false,
    'mixed batch is not denied by one creation right',
);
equal(
    fileActionBlocked(
        fileActionAvailability(
            { ...access, directoryAccess: { createFile: false, createFolder: false } },
            'receive',
        ),
    ),
    true,
    'both denied creation rights block receiving',
);
for (const action of [
    'read',
    'write',
    'rename',
    'delete',
    'createFile',
    'createFolder',
    'receive',
] as const) {
    equal(
        fileActionBlocked(fileActionAvailability(null, action)),
        false,
        'no native evidence never invents a denial',
    );
}
console.log('  ok shared per-operation access projection, unknown and mixed-batch semantics');
