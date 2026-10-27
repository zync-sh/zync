import assert from 'node:assert/strict';

import {
    clientRectsIntersect,
    gridNamesInMarquee,
    listNamesInMarquee,
    mergeMarqueeSelection,
    namesBetween,
    normalizeClientRect,
} from '../../src/components/file-manager/fileMarquee';

function runTest(name: string, fn: () => void) {
    try {
        fn();
        console.log(`  ok ${name}`);
    } catch (error) {
        console.error(`  fail ${name}`);
        throw error;
    }
}

runTest('normalizeClientRect orders any drag direction', () => {
    const rect = normalizeClientRect(10, 20, 4, 8);
    assert.deepEqual(rect, { left: 4, top: 8, width: 6, height: 12 });
});

runTest('clientRectsIntersect detects overlap', () => {
    assert.equal(
        clientRectsIntersect(
            { left: 0, top: 0, width: 10, height: 10 },
            { left: 8, top: 8, width: 10, height: 10 },
        ),
        true,
    );
    assert.equal(
        clientRectsIntersect(
            { left: 0, top: 0, width: 10, height: 10 },
            { left: 11, top: 0, width: 10, height: 10 },
        ),
        false,
    );
});

runTest('namesBetween is inclusive and order-independent', () => {
    const files = [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }];
    assert.deepEqual(namesBetween(files, 'b', 'd'), ['b', 'c', 'd']);
    assert.deepEqual(namesBetween(files, 'd', 'b'), ['b', 'c', 'd']);
});

runTest('mergeMarqueeSelection unions ctrl-drag with the snapshot', () => {
    assert.deepEqual(mergeMarqueeSelection(['a'], ['b', 'c']), ['a', 'b', 'c']);
    assert.deepEqual(mergeMarqueeSelection([], ['a']), ['a']);
});

runTest('listNamesInMarquee uses row geometry', () => {
    const files = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    const names = listNamesInMarquee(files, 40, 100, 0, 200, 0, {
        left: 0,
        top: 130,
        width: 20,
        height: 50,
    });
    assert.deepEqual(names, ['a', 'b']);
});

runTest('listNamesInMarquee ignores a band that misses the list horizontally', () => {
    const files = [{ name: 'a' }, { name: 'b' }];
    const names = listNamesInMarquee(files, 40, 0, 0, 100, 0, {
        left: 140,
        top: 0,
        width: 20,
        height: 80,
    });
    assert.deepEqual(names, []);
});

runTest('gridNamesInMarquee uses cell geometry', () => {
    const files = [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }];
    const names = gridNamesInMarquee(files, 2, 50, 40, 0, 0, 0, {
        left: 55,
        top: 5,
        width: 10,
        height: 10,
    });
    assert.deepEqual(names, ['b']);
});

console.log('fileMarquee tests passed.');
