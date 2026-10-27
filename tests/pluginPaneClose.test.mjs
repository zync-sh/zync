import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import ts from 'typescript';

import {
    dropPlugin,
    isKeepableRemainder,
    ownerForLayout,
    singleFeaturePane,
    singlePane,
    singlePluginPane,
    splitPane,
    visibleTermIds,
} from '../.tmp-agent-tests/src/lib/paneLayout/index.js';

// Run the production action without starting PTYs or session-save timers.
const source = readFileSync('src/store/terminalSlice.ts', 'utf8');
const tree = ts.createSourceFile('terminalSlice.ts', source, ts.ScriptTarget.Latest, true);
let initializer;
function findAction(node) {
    if (
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        node.name.text === 'closePluginPanes'
    ) {
        initializer = node.initializer;
        return;
    }
    ts.forEachChild(node, findAction);
}
findAction(tree);
const start = initializer?.getStart(tree) ?? -1;
const end = initializer?.end ?? -1;
assert.ok(start >= 0 && end > start);
const action = `const closePluginPanes = ${source.slice(start, end)};`;
const { outputText } = ts.transpileModule(`${action}\nglobalThis.close = closePluginPanes;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
});

function close(groups, activeOwner, terminals = []) {
    let state = {
        paneLayouts: { connection: groups },
        activePaneGroupOwner: { connection: activeOwner },
        terminals: { connection: terminals },
    };
    const context = {
        dropPlugin,
        isKeepableRemainder,
        ownerForLayout,
        visibleTermIds,
        get: () => state,
        set: (update) => {
            state = { ...state, ...update(state) };
        },
        scheduleSaveSession: () => {},
        // Presentation cleanup is covered by workspaceContentLifecycle's full-slice harness.
        connectionContents: () => new Map(),
        forgetClosedContent: () => {},
        writeConnectionGroups: (layouts, connectionId, next) => ({
            ...layouts,
            [connectionId]: next,
        }),
    };
    runInNewContext(outputText, context);
    context.close('connection', 'plugin');
    return state;
}

const existing = singleFeaturePane('files', 'existing-files');
const plugin = singlePluginPane('plugin', 'plugin-pane', 'publisher-pane');
const mixed = splitPane(plugin, 'plugin-pane', 'horizontal', {
    kind: 'feature',
    featureId: 'dashboard',
}).layout;
for (const entries of [
    [
        ['workspace', existing],
        ['publisher-pane', mixed],
    ],
    [
        ['publisher-pane', mixed],
        ['workspace', existing],
    ],
]) {
    const result = close(Object.fromEntries(entries), 'publisher-pane');
    const remaining = result.paneLayouts.connection;
    assert.equal(
        Object.keys(remaining).length,
        2,
        'Preserve both canvases regardless of iteration order',
    );
    assert.equal(remaining.workspace, existing, 'Do not overwrite the existing owner');
    assert.equal(remaining['publisher-pane'].root.content.featureId, 'dashboard');
    assert.equal(
        result.activePaneGroupOwner.connection,
        'publisher-pane',
        'Selection uses the final fallback key',
    );
    assert.equal(
        close(Object.fromEntries(entries), 'workspace').activePaneGroupOwner.connection,
        'workspace',
    );
}

const identified = splitPane(plugin, 'plugin-pane', 'horizontal', {
    kind: 'feature',
    featureId: 'files',
    instanceId: 'surviving-files',
}).layout;
const promoted = close({ 'publisher-pane': identified }, 'publisher-pane');
assert.ok(promoted.paneLayouts.connection['surviving-files'], 'Free owners still promote normally');
assert.equal(promoted.activePaneGroupOwner.connection, 'surviving-files');

const shell = singlePane('shell', 'shell-pane');
const shellAndPlugin = splitPane(shell, 'shell-pane', 'horizontal', plugin.root.content).layout;
const released = close({ shell: shellAndPlugin }, 'shell', [{ id: 'shell', tabVisible: false }]);
assert.equal(Object.keys(released.paneLayouts.connection).length, 0);
assert.equal(
    released.terminals.connection[0].tabVisible,
    true,
    'Released shells return to the tab inventory',
);
assert.equal(released.activePaneGroupOwner.connection, null);
console.log('Plugin close collision, active selection and shell-release tests passed.');
