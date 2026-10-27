import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const javascriptFile = /\.(?:[cm]?js|jsx)$/i;
const testFile = /(?:\.(?:test|spec)|\/(?:test|spec)|^(?:test|spec))\.(?:[cm]?js|jsx)$/i;
const registrationTailNames = new Set(['test', 'it', 'describe', 'suite']);
const caseNames = new Set([...registrationTailNames, 'run', 'runTest']);
const assertionNames = new Set(['assert', 'expect', 'equal', 'sameValues', 'check']);

/** Compare syntax rather than text so formatting, comments and quote changes stay allowed. */
function syntaxKey(node) {
    if (ts.isParenthesizedExpression(node)) {
        return syntaxKey(node.expression);
    }
    if (
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
    ) {
        return [node.kind, node.name.text, syntaxKey(node.initializer)];
    }

    const children = [];
    ts.forEachChild(node, (child) => {
        children.push(syntaxKey(child));
    });
    return [node.kind, typeof node.text === 'string' ? node.text : null, ...children];
}

/** Resolve chained calls such as test.only(), t.test() and expect(value).toEqual(). */
function callNames(expression) {
    if (ts.isParenthesizedExpression(expression)) {
        return callNames(expression.expression);
    }
    if (ts.isIdentifier(expression)) {
        return [expression.text];
    }
    if (ts.isPropertyAccessExpression(expression)) {
        const receiver = callNames(expression.expression);
        return receiver.length ? [...receiver, expression.name.text] : [];
    }
    if (ts.isCallExpression(expression)) {
        return callNames(expression.expression);
    }
    return [];
}

/** Collect common case registrations and assertions, including imported aliases. */
function testLogic(source, file) {
    const tree = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.JS,
    );
    const cases = new Set(caseNames);
    const assertions = new Set(assertionNames);
    for (const statement of tree.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
            continue;
        }
        const clause = statement.importClause;
        if (clause?.name && /^(?:node:)?test$/.test(statement.moduleSpecifier.text)) {
            cases.add(clause.name.text);
        }
        if (
            clause?.name &&
            /^(?:node:)?assert(?:\/strict)?$/.test(statement.moduleSpecifier.text)
        ) {
            assertions.add(clause.name.text);
        }
        if (
            clause?.namedBindings &&
            ts.isNamespaceImport(clause.namedBindings) &&
            /^(?:node:)?assert(?:\/strict)?$/.test(statement.moduleSpecifier.text)
        ) {
            assertions.add(clause.namedBindings.name.text);
        }
        if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
            continue;
        }
        for (const imported of clause.namedBindings.elements) {
            const name = (imported.propertyName ?? imported.name).text;
            if (caseNames.has(name)) {
                cases.add(imported.name.text);
            }
            if (
                assertionNames.has(name) ||
                /^(?:node:)?assert(?:\/strict)?$/.test(statement.moduleSpecifier.text)
            ) {
                assertions.add(imported.name.text);
            }
        }
    }

    const registrations = new Map();
    const checks = new Map();
    const add = (map, key) => {
        const encoded = JSON.stringify(key);
        map.set(encoded, (map.get(encoded) ?? 0) + 1);
    };
    function visit(node) {
        if (ts.isCallExpression(node)) {
            const names = callNames(node.expression);
            const tail = ts.isPropertyAccessExpression(node.expression)
                ? node.expression.name.text
                : names.at(-1);
            const registrationTail = registrationTailNames.has(tail);
            const hasRegistrationBody = node.arguments
                .slice(1)
                .some(
                    (argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument),
                );
            if (
                cases.has(names[0]) ||
                (registrationTail && (names[0] === 't' || hasRegistrationBody))
            ) {
                const argumentsWithoutBodies = node.arguments.filter(
                    (argument) =>
                        !ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument),
                );
                add(registrations, [
                    syntaxKey(node.expression),
                    argumentsWithoutBodies.map(syntaxKey),
                ]);
            } else if (assertions.has(names[0])) {
                add(checks, syntaxKey(node));
            }
        } else if (ts.isThrowStatement(node)) {
            add(checks, syntaxKey(node));
        }
        ts.forEachChild(node, visit);
    }
    visit(tree);
    return { tree, registrations, checks };
}

/** Accept only a two-statement launcher targeting its same-name checked TypeScript source. */
function typedLauncher(file, tree) {
    if (!file.endsWith('.mjs') || tree.statements.length !== 2) {
        return null;
    }
    const [declaration, statement] = tree.statements;
    if (
        !ts.isImportDeclaration(declaration) ||
        !ts.isStringLiteral(declaration.moduleSpecifier) ||
        !declaration.moduleSpecifier.text.startsWith('.') ||
        path.posix.normalize(
            path.posix.join(path.posix.dirname(file), declaration.moduleSpecifier.text),
        ) !== 'tests/helpers/runTypedTest.mjs'
    ) {
        return null;
    }
    const bindings = declaration.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings) || bindings.elements.length !== 1) {
        return null;
    }
    const runner = bindings.elements[0];
    if ((runner.propertyName ?? runner.name).text !== 'runTypedTest') {
        return null;
    }
    if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression)) {
        return null;
    }
    const call = statement.expression.expression;
    if (
        !ts.isCallExpression(call) ||
        !ts.isIdentifier(call.expression) ||
        call.expression.text !== runner.name.text ||
        call.arguments.length !== 1
    ) {
        return null;
    }
    const url = call.arguments[0];
    if (
        !ts.isNewExpression(url) ||
        !ts.isIdentifier(url.expression) ||
        url.expression.text !== 'URL' ||
        url.arguments?.length !== 2 ||
        !ts.isStringLiteral(url.arguments[0])
    ) {
        return null;
    }
    const base = url.arguments[1];
    if (
        !ts.isPropertyAccessExpression(base) ||
        base.name.text !== 'url' ||
        !ts.isMetaProperty(base.expression) ||
        base.expression.keywordToken !== ts.SyntaxKind.ImportKeyword
    ) {
        return null;
    }
    if (!url.arguments[0].text.startsWith('./')) {
        return null;
    }
    const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), url.arguments[0].text),
    );
    return target === file.replace(/\.mjs$/, '.ts') || target === file.replace(/\.mjs$/, '.tsx')
        ? target
        : null;
}

/** Return policy errors for one snapshot; this detects common syntax, not arbitrary test semantics. */
export function testLanguageViolations(file, source, baseline, hasFile) {
    file = file.replaceAll('\\', '/');
    if (!javascriptFile.test(file)) {
        return [];
    }
    const current = testLogic(source, file);
    const previous = testLogic(baseline ?? '', file);
    const inTests = /(?:^|\/)(?:test|tests|__tests__)\//.test(file);
    if (
        !testFile.test(file) &&
        !(
            inTests &&
            (current.registrations.size ||
                current.checks.size ||
                previous.registrations.size ||
                previous.checks.size)
        )
    ) {
        return [];
    }

    const launcher = typedLauncher(file, current.tree);
    if (launcher) {
        return hasFile(launcher)
            ? []
            : [
                  `${JSON.stringify(file)}: its TypeScript launcher target ${JSON.stringify(launcher)} must exist in the selected Git snapshot.`,
              ];
    }
    if (baseline === null) {
        return [
            `${JSON.stringify(file)}: write new test logic in .ts/.tsx; .mjs is reserved for a thin runTypedTest launcher.`,
        ];
    }

    const addedCases = [...current.registrations].some(
        ([key, count]) => count > (previous.registrations.get(key) ?? 0),
    );
    const addedChecks = [...current.checks].some(
        ([key, count]) => count > (previous.checks.get(key) ?? 0),
    );
    return addedCases || addedChecks
        ? [
              `${JSON.stringify(file)}: new or changed JavaScript test cases/assertions must move to .ts/.tsx; legacy harness maintenance may remain.`,
          ]
        : [];
}

/** Read one Git snapshot without consulting unstaged working files. */
function snapshotSource(cwd, revision, file) {
    try {
        return execFileSync('git', ['show', `${revision}:${file}`], {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
    } catch {
        return null;
    }
}

/** Check staged sources by default, or committed changes since BASE's common ancestor with HEAD. */
function checkSnapshot(cwd, base) {
    const git = (args) =>
        execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    let baseline = 'HEAD';
    if (base) {
        const verifiedBase = git([
            'rev-parse',
            '--verify',
            '--end-of-options',
            `${base}^{commit}`,
        ]).trim();
        baseline = git(['merge-base', verifiedBase, 'HEAD']).trim();
    }
    const selected = base ? 'HEAD' : '';
    const names = git([
        'diff',
        ...(base ? [baseline, 'HEAD'] : ['--cached']),
        '--name-only',
        '-z',
        '--no-renames',
        '--diff-filter=ACMR',
        '--',
    ])
        .split('\0')
        .filter((file) => javascriptFile.test(file));
    const errors = names.flatMap((file) =>
        testLanguageViolations(
            file,
            snapshotSource(cwd, selected, file) ?? '',
            snapshotSource(cwd, baseline, file),
            (typed) => snapshotSource(cwd, selected, typed) !== null,
        ),
    );
    return { errors };
}

/** Enforce the test-language policy against the index before any formatter changes it. */
export function checkStagedTestLanguage(cwd = process.cwd()) {
    return checkSnapshot(cwd);
}

/** CLI entry point with an explicit committed comparison mode for CI. */
export function checkTestLanguage(args = process.argv.slice(2), cwd = process.cwd()) {
    if (args.length && (args.length !== 2 || args[0] !== '--base' || !args[1])) {
        throw new Error('Usage: node scripts/check-test-language.mjs [--base REF]');
    }
    const result = args.length ? checkSnapshot(cwd, args[1]) : checkStagedTestLanguage(cwd);
    for (const error of result.errors) {
        console.error(error);
    }
    if (!result.errors.length) {
        console.log('Test language check passed (new test logic uses TypeScript).');
    }
    return result.errors.length === 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        if (!checkTestLanguage()) {
            process.exitCode = 1;
        }
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
