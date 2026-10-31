import assert from 'node:assert/strict';
import fs from 'node:fs';

import { isCurrentEditorRead } from '../../src/components/file-manager/editorReadIdentity';

assert.equal(isCurrentEditorRead('server-a', 'server-a', 2, 2), true);
assert.equal(
    isCurrentEditorRead('server-a', 'server-b', 2, 2),
    false,
    'a read for another connection must be discarded',
);
assert.equal(
    isCurrentEditorRead('server-a', 'server-a', 2, 3),
    false,
    'an earlier read must not replace a newer open, including after A→B→A switching',
);

const manager = fs.readFileSync('src/components/FileManager.tsx', 'utf8');
assert.match(
    manager,
    /const sourceConnectionId = activeConnectionId;[\s\S]*?connectionId: sourceConnectionId,[\s\S]*?isCurrentEditorRead\(\s*sourceConnectionId,\s*editorConnectionRef\.current,\s*requestId,\s*editorReadRequestRef\.current,?\s*\)/,
    'read results must be checked against the captured connection and latest request',
);
assert.match(
    manager,
    /const target = \{ connectionId: sourceConnectionId, path: fullPath \};/,
    'the opened editor must retain the original connection and path',
);
assert.match(
    manager,
    /connectionId: target\.connectionId,[\s\S]*?path: target\.path/,
    'saves must use the captured target',
);
assert.match(
    manager,
    /editorTargetRef\.current === target[\s\S]*?setEditorContent\(content\)/,
    'a late save must not replace a newer editor document',
);

console.log('File Manager editor identity test passed.');
