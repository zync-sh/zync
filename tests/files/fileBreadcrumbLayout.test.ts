import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    type FileBreadcrumbWidth,
    fileBreadcrumbLayout,
    fileBreadcrumbWidth,
} from '../../src/components/file-manager/fileBreadcrumbLayout';

const widthModes: readonly FileBreadcrumbWidth[] = ['narrow', 'compact', 'medium', 'wide'];

test('breadcrumb width buckets are bounded and fail safely for unmeasured widths', () => {
    for (const width of [NaN, Infinity, -1, 0, 299]) {
        assert.equal(fileBreadcrumbWidth(width), 'narrow');
    }
    assert.equal(fileBreadcrumbWidth(300), 'compact');
    assert.equal(fileBreadcrumbWidth(479), 'compact');
    assert.equal(fileBreadcrumbWidth(480), 'medium');
    assert.equal(fileBreadcrumbWidth(719), 'medium');
    assert.equal(fileBreadcrumbWidth(720), 'wide');
});

test('short paths never manufacture overflow or duplicate their current location', () => {
    for (const mode of widthModes) {
        assert.deepEqual(fileBreadcrumbLayout(0, mode), { visible: [], hidden: [] });
        assert.deepEqual(fileBreadcrumbLayout(1, mode), { visible: [0], hidden: [] });
    }
    assert.deepEqual(fileBreadcrumbLayout(2, 'compact'), { visible: [0, 1], hidden: [] });
    for (const count of [-1, 1.5, NaN, Infinity]) {
        assert.deepEqual(fileBreadcrumbLayout(count, 'wide'), { visible: [], hidden: [] });
    }
});

test('folding preserves every ancestor once, in order, and always retains the leaf', () => {
    for (const mode of widthModes) {
        for (let count = 2; count < 80; count++) {
            const { visible, hidden } = fileBreadcrumbLayout(count, mode);
            assert.equal(visible.at(-1), count - 1);
            assert.deepEqual(
                [...visible].sort((a, b) => a - b),
                visible,
            );
            assert.deepEqual(
                [...hidden].sort((a, b) => a - b),
                hidden,
            );
            assert.deepEqual(
                [...visible, ...hidden].sort((a, b) => a - b),
                Array.from({ length: count }, (_, index) => index),
            );
            assert.ok(visible.length <= 4);
            assert.equal(visible.includes(0), mode !== 'narrow');
        }
    }
    assert.deepEqual(fileBreadcrumbLayout(8, 'wide'), {
        visible: [0, 5, 6, 7],
        hidden: [1, 2, 3, 4],
    });
    assert.deepEqual(fileBreadcrumbLayout(8, 'medium'), {
        visible: [0, 6, 7],
        hidden: [1, 2, 3, 4, 5],
    });
    assert.deepEqual(fileBreadcrumbLayout(8, 'compact'), {
        visible: [0, 7],
        hidden: [1, 2, 3, 4, 5, 6],
    });
});
