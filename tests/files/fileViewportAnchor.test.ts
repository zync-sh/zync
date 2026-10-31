import assert from 'node:assert/strict';

import {
    captureFileViewportAnchor as capture,
    fileViewportAnchorTop as restore,
} from '../../src/components/file-manager/fileViewportAnchor';

const files = Array.from({ length: 1000 }, (_, i) => ({ name: `file-${i}` }));
const anchor = capture(files, 10, 118, 18 * 118 + 23);
assert.ok(anchor);
assert.equal(anchor.name, 'file-180');
assert.equal(anchor.offset, 23);
assert.equal(restore(anchor, files, 12, 118), 15 * 118 + 23);
assert.equal(restore(anchor, files, 9, 118), 20 * 118 + 23);
assert.equal(
    restore(anchor, files, 10, 118),
    18 * 118 + 23,
    'reversal preserves identity without rounding drift',
);
assert.equal(
    restore(anchor, files.slice(10), 10, 118),
    17 * 118 + 23,
    'identity survives preceding deletions',
);
assert.equal(restore(anchor, [], 10, 118), null);
assert.equal(capture([], 10, 118, 0), null);
assert.equal(capture(files, 0, 118, 0), null);
assert.equal(capture(files, 1, 0, 0), null);
assert.equal(restore(null, files, 10, 118), null);
const topAnchor = capture(files, 10, 118, -3);
assert.ok(topAnchor);
assert.equal(topAnchor.offset, 0);
assert.equal(restore({ name: 'file-0', offset: 200 }, files, 10, 118), 117);
assert.equal(
    restore({ name: 'file-20', offset: -8 }, files, 10, 118),
    228,
    'visible next row may start below the top edge',
);
console.log('File viewport anchor tests passed (identity, offset, reversal, removal, boundaries).');
