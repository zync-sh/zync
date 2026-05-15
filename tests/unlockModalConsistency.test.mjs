import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const files = [
  path.join(root, 'src/components/vault/VaultUnlockModal.tsx'),
  path.join(root, 'src/components/settings/tabs/vault/SyncCollectionUnlockModal.tsx'),
];

const failures = [];

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}:`, error.message);
    failures.push({ name, error });
  }
}

for (const file of files) {
  if (!fs.existsSync(file)) {
    runTest(`${file} exists`, () => {
      assert.fail(`Missing file: ${file}`);
    });
    continue;
  }
  const src = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hasImportNamed = (importedName, expectedModule) => sourceFile.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement)) return false;
    if (expectedModule) {
      const source = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : '';
      if (source !== expectedModule) return false;
    }
    if (!statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) {
      return false;
    }
    return statement.importClause.namedBindings.elements.some((element) =>
      element.name.text === importedName || element.propertyName?.text === importedName
    );
  });
  const hasJsxElementNamed = (jsxName) => {
    const resolveTagName = (tag) => {
      if (ts.isIdentifier(tag)) return tag.text;
      if (ts.isPropertyAccessExpression(tag)) {
        const left = resolveTagName(tag.expression);
        return left ? `${left}.${tag.name.text}` : '';
      }
      if (ts.isJsxNamespacedName(tag)) {
        return `${tag.namespace.text}:${tag.name.text}`;
      }
      return '';
    };
    let found = false;
    const visit = (node) => {
      if (found) return;
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        const tagName = resolveTagName(node.tagName);
        if (tagName === jsxName) {
          found = true;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
  };
  const short = file.replace(root + path.sep, '');
  const expectedUnlockModalShellModule = short === 'src\\components\\vault\\VaultUnlockModal.tsx'
    ? './UnlockModalShell'
    : '../../../vault/UnlockModalShell';
  runTest(`${short} imports UnlockModalShell`, () => {
    assert.ok(
      hasImportNamed('UnlockModalShell', expectedUnlockModalShellModule),
      'UnlockModalShell import missing',
    );
  });
  runTest(`${short} uses UnlockModalShell`, () => {
    assert.ok(hasJsxElementNamed('UnlockModalShell'), 'UnlockModalShell usage missing');
  });
  runTest(`${short} uses shared SecretField`, () => {
    assert.ok(hasJsxElementNamed('SecretField'), 'SecretField usage missing');
  });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) failed.`);
  process.exit(1);
}

console.log('Unlock modal consistency tests passed.');
