import assert from 'node:assert/strict';

import {
    EDITOR_READ_LIMIT_MESSAGE,
    exceedsEditorReadLimit,
    isEditorReadLimitError,
    MAX_EDITOR_FILE_BYTES,
} from '../../src/components/file-manager/editorReadPolicy';

assert.equal(exceedsEditorReadLimit(MAX_EDITOR_FILE_BYTES - 1), false);
assert.equal(exceedsEditorReadLimit(MAX_EDITOR_FILE_BYTES), false);
assert.equal(exceedsEditorReadLimit(MAX_EDITOR_FILE_BYTES + 1), true);
assert.equal(exceedsEditorReadLimit(0), false); // Unknown SFTP size still gets a bounded backend read.
assert.equal(isEditorReadLimitError('FILE_TOO_LARGE: file grew after listing'), true);
assert.equal(isEditorReadLimitError('DISCONNECTED: server unavailable'), false);
assert.match(EDITOR_READ_LIMIT_MESSAGE, /not loaded/i);
console.log('editor read policy tests passed.');
