import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { loadSource } from './helpers/loadSource.mjs';
import { runConnectionFocusChecks, runFilePaneActivationChecks, runReconnectPaneFocusChecks } from '../.tmp-agent-tests/tests/reconnectPaneFocus.test.js';

runReconnectPaneFocusChecks(loadSource);
runConnectionFocusChecks(loadSource);

// Execute the production focus-owner setup and automatic activation effects without
// mounting unrelated file transfer, editor, permissions and clipboard machinery.
const source = ts.createSourceFile('FileManager.tsx', readFileSync(new URL('../src/components/FileManager.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let component;
function visit(node) {
    if (ts.isFunctionExpression(node) && node.name?.text === 'FileManager') component = node;
    ts.forEachChild(node, visit);
}
visit(source);
assert.ok(component, 'FileManager production component is present');
const setup = component.body.statements.filter(statement => (
    ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name)
        && ['isFilesFocusOwner', 'filesFocusOwnerRef'].includes(declaration.name.text))
) || (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
    && statement.expression.left.getText(source) === 'filesFocusOwnerRef.current'));
const effects = component.body.statements.filter(statement => ts.isExpressionStatement(statement)
    && ts.isCallExpression(statement.expression) && statement.expression.expression.getText(source) === 'useEffect'
    && (statement.getText(source).includes('zync:files-panel-show') || statement.getText(source).includes("surface !== 'pane'")));
assert.equal(setup.length, 3, 'Select the current production focus-owner state');
assert.equal(effects.length, 2, 'Select both production automatic activation effects');
const code = `exports.render = ({ isFilesSurfaceActive, focused, surface, focusOnActivation, containerRef }) => {
${[...setup, ...effects].map(statement => statement.getText(source)).join('\n')}
};`;
runFilePaneActivationChecks((react, globals) => {
    const exports = {};
    runInNewContext(code, { exports, ...react, ...globals });
    return exports.render;
});
console.log('Reconnect pane focus tests passed.');
