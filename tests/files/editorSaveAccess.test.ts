import {
    editorSaveBlocked,
    editorSaveErrorMessage,
    editorSavePolicy,
    isEditorWriteDenied,
} from '../../src/features/files/domain/editorSaveAccess';
import type { FilePermissionMetadata } from '../../src/features/files/domain/filePermissions';

function equal(actual: unknown, expected: unknown, label: string): void {
    if (actual !== expected) {
        throw new Error(`${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
    }
}
const metadata = (
    mode: number | null,
    model: FilePermissionMetadata['binding']['model'] = 'posix',
    kind: FilePermissionMetadata['snapshot']['kind'] = 'File',
) =>
    ({
        binding: { model },
        snapshot: { mode, kind },
        readOnly: null,
    }) as FilePermissionMetadata;

for (const mode of [0o400, 0o440, 0o444, 0o000, 0o104400]) {
    const policy = editorSavePolicy(metadata(mode));
    equal(
        editorSaveBlocked(policy),
        true,
        `no write bits (${mode.toString(8)}) defaults to read-only`,
    );
    equal(policy.overridable, true, 'mode hints allow explicit privileged-account opt-in');
}
for (const mode of [0o200, 0o020, 0o002, 0o640, 0o644, 0o777]) {
    const policy = editorSavePolicy(metadata(mode));
    equal(policy.state, 'unknown', 'a write bit is not effective account authority');
    equal(editorSaveBlocked(policy), false, 'unknown effective access remains attemptable');
}
equal(editorSavePolicy(metadata(null)).state, 'unknown', 'missing mode is not zero');
equal(
    editorSavePolicy({ ...metadata(0o400), writeAccess: true }).state,
    'unknown',
    'a current positive local kernel check takes precedence over a no-write-bit hint without promising a future save',
);
equal(
    editorSavePolicy(metadata(0o400, 'unknown')).state,
    'unknown',
    'unknown filesystem model does not get synthetic POSIX policy',
);
equal(
    editorSavePolicy(metadata(0o400, 'posix', 'Symlink')).state,
    'unknown',
    'link mode does not prove target access',
);
const windows = { ...metadata(null, 'windows'), readOnly: true };
equal(
    editorSaveBlocked(editorSavePolicy(windows)),
    true,
    'Windows read-only attribute disables saving',
);
equal(
    editorSavePolicy(windows).overridable,
    false,
    'Windows attribute needs a fresh check after changing it',
);
equal(
    editorSavePolicy({ ...windows, readOnly: false }).state,
    'unknown',
    'writable attribute does not prove ACL access',
);
const deniedByNative = editorSavePolicy({ ...windows, readOnly: false, writeAccess: false });
equal(
    editorSaveBlocked(deniedByNative),
    true,
    'native ACL denial disables saving independently of the readonly attribute',
);
equal(deniedByNative.overridable, false, 'native ACL denial is not an overridable mode hint');
equal(
    editorSavePolicy({ ...windows, readOnly: false, writeAccess: true }).state,
    'unknown',
    'a positive native check is not a future write guarantee',
);
equal(
    editorSaveBlocked({ state: 'checking', reason: '', overridable: false }),
    true,
    'pending metadata cannot be saved through',
);
equal(editorSaveBlocked(undefined), false, 'other editor consumers retain ordinary saving');

for (const error of [
    'Permission denied',
    'Failed to open /tmp/file: Permission denied: Permission denied',
    new Error('EACCES: open /tmp/file'),
    { message: 'Read-only file system (os error 30)' },
    'Failed to write: Access is denied.',
    'Failed to write /tmp/file: Operation not permitted (os error 1)',
    'Failed to write file: Access is denied. (os error 5)',
]) {
    equal(isEditorWriteDenied(error), true, 'definite filesystem denial is recognized');
}
for (const error of [
    'session closed',
    'Storage full',
    'Failed to open "/home/permission denied.txt": session closed',
    'Cannot open /EACCES/file',
    "Failed to write content to '/tmp/foo: Permission denied.txt': No space left on device (os error 28)",
]) {
    equal(
        isEditorWriteDenied(error),
        false,
        'other failures and filenames do not permanently disable saving',
    );
}
equal(
    editorSaveErrorMessage('native string rejection'),
    'native string rejection',
    'native string failures keep their detail',
);
equal(
    editorSaveErrorMessage({ message: 'native object rejection' }),
    'native object rejection',
    'structured native failures keep their detail',
);
equal(
    editorSaveErrorMessage(null),
    'Unknown filesystem error',
    'invalid failure values have a safe fallback',
);
console.log(
    '  ok editor read-only policy, unknown authority, attributes and save-error classification',
);
