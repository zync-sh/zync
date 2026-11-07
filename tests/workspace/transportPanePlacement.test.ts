import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWorkspaceOpenItems } from '../../src/components/layout/workspaceOpen/buildWorkspaceOpenItems';
import {
    builtinWorkspaceViewLabel,
    canOpenFeatureInWorkspace,
} from '../../src/features/workspace/domain/registrations';

test('new Serial sessions use saved connections while legacy local panes remain available', () => {
    const featureIds = (workspaceScope: 'local' | 'remote') =>
        buildWorkspaceOpenItems({ canOpenFeature: true, shells: [], workspaceScope }).flatMap(
            (item) => (item.kind === 'feature' ? [item.featureId] : []),
        );
    assert.ok(!featureIds('local').includes('serial'));
    assert.equal(canOpenFeatureInWorkspace('serial', 'local'), true);
    assert.ok(!featureIds('local').includes('vnc'));
    assert.ok(featureIds('remote').includes('vnc'));
    assert.ok(!featureIds('remote').includes('serial'));
    assert.ok(featureIds('local').includes('files') && featureIds('remote').includes('files'));
    assert.equal(builtinWorkspaceViewLabel('serial'), 'Serial Terminal');
    assert.equal(builtinWorkspaceViewLabel('vnc'), 'VNC Viewer');
});
