import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

interface PolicyModule {
    checkStagedTestLanguage(cwd: string): { errors: string[] };
    testLanguageViolations(
        file: string,
        source: string,
        baseline: string | null,
        hasFile: (file: string) => boolean,
    ): string[];
}

const policyPath = path.resolve('scripts/check-test-language.mjs');
const policy = (await import(pathToFileURL(policyPath).href)) as PolicyModule;
const check = (
    file: string,
    source: string,
    baseline: string | null = null,
    files: string[] = [],
) => policy.testLanguageViolations(file, source, baseline, (target) => files.includes(target));
let checks = 0;

function accepts(
    file: string,
    source: string,
    baseline: string | null = null,
    files: string[] = [],
): void {
    assert.deepEqual(check(file, source, baseline, files), []);
    checks++;
}

function rejects(
    file: string,
    source: string,
    baseline: string | null = null,
    files: string[] = [],
): void {
    assert.ok(
        check(file, source, baseline, files).length > 0,
        `${file} must require TypeScript test logic`,
    );
    checks++;
}

for (const extension of ['js', 'jsx', 'mjs', 'cjs']) {
    rejects(`tests/newCase.test.${extension}`, "test('works', () => assert.equal(1, 1));");
}
accepts('tests/newCase.test.ts', "test('works', () => assert.equal(1, 1));");
accepts('tests/newCase.test.tsx', "test('works', () => render(<Example />));");
accepts('scripts/build.mjs', 'assert.equal(result.status, 0);');
accepts('scripts/check-test-language.mjs', "if (!valid) throw new Error('Usage');");
accepts('tests/helpers/runner.mjs', "const test = 'not a test() call'; // assert(false)");
rejects('tests/helpers/assertFixture.mjs', 'assert.equal(result, expected);');
rejects('tests/helpers/customFixture.mjs', "if (!valid) throw new Error('Invalid result');");
rejects('src/example.spec.js', "test('works', () => {});");

const legacy = "import { test } from 'node:test';\ntest('old', () => assert.equal(1, 1));";
accepts('tests/legacy.test.mjs', legacy, legacy);
accepts(
    'tests/legacy.test.mjs',
    legacy.replace('assert.equal(1, 1)', 'assert.equal(1, 1)'),
    legacy,
);
accepts(
    'tests/legacy.test.mjs',
    `${legacy}\nconst fixture = { dependency: { cleanup() {} } };`,
    legacy,
);
accepts(
    'tests/legacy.test.mjs',
    'import {test} from "node:test"; // comment\ntest("old",()=>{assert.equal(1,1)});',
    legacy,
);
rejects('tests/legacy.test.mjs', `${legacy}\ntest('new', () => {});`, legacy);
rejects(
    'tests/legacy.test.mjs',
    legacy.replace('assert.equal(1, 1)', 'assert.equal(1, 1); assert.ok(ready)'),
    legacy,
);
rejects(
    'tests/legacy.test.mjs',
    legacy.replace('assert.equal(1, 1)', 'assert.equal(actual, expected)'),
    legacy,
);
rejects('tests/legacy.test.mjs', `${legacy}\ntest('old', () => assert.equal(1, 1));`, legacy);
accepts('tests/legacy.test.mjs', '', legacy);
accepts(
    'tests/legacy.test.mjs',
    `${legacy}\nconst prose = "test('new', () => assert(false))";`,
    legacy,
);
accepts('tests/legacy.test.mjs', `${legacy}\n// test('new', () => assert(false));`, legacy);
accepts(
    'tests/legacy.test.mjs',
    'assert.deepEqual(result, { expected: 1 });',
    'assert.deepEqual(result, { "expected": 1 });',
);

rejects(
    'tests/helpers/fixtures.mjs',
    "import { test as scenario } from 'node:test'; scenario('new', () => {});",
    '',
);
rejects(
    'tests/helpers/fixtures.mjs',
    "import { equal as eq } from 'node:assert/strict'; eq(1, 1);",
    '',
);
rejects(
    'tests/helpers/fixtures.mjs',
    "import * as verify from 'node:assert/strict'; verify.equal(1, 1);",
    '',
);
rejects(
    'tests/helpers/fixtures.mjs',
    "import scenario from 'node:test'; scenario.only('new', () => {});",
    '',
);
rejects(
    'tests/helpers/fixtures.mjs',
    "test.each([1, 2])('new', value => expect(value).toBeTruthy());",
    '',
);

for (const method of ['run', 'runTest', 'check']) {
    accepts(
        'tests/legacy.test.mjs',
        `${legacy}\nworker.${method}('new harness command', () => {});`,
        `${legacy}\nworker.${method}('old harness command', () => {});`,
    );
}
for (const expression of [
    '/ready/.test(value)',
    '(/ready/).test(value)',
    'pattern.test(value)',
    "new RegExp('ready').test(value)",
]) {
    accepts('tests/legacy.test.mjs', `const matched = ${expression};`, 'const matched = false;');
}
accepts(
    'tests/legacy.test.mjs',
    'const matched = /ready/.test(value);',
    'const matched = /pending/.test(value);',
);
accepts('tests/helpers/regex.mjs', 'const matched = /ready/.test(value);');
accepts('tests/legacy.test.mjs', 'pattern.test(() => value);', '');
rejects('tests/legacy.test.mjs', "api.test('new', () => {});", '');
rejects('tests/legacy.test.mjs', "api.describe('new', function () {});", '');
rejects('tests/legacy.test.mjs', "t.test('new', existingBody);", '');
rejects(
    'tests/legacy.test.mjs',
    "import { test as scenario } from 'node:test'; scenario('new', existingBody);",
    '',
);
for (const registration of ['run', 'runTest', 't.test', 'test.only', 'describe', 'suite']) {
    rejects('tests/legacy.test.mjs', `${legacy}\n${registration}('new', () => {});`, legacy);
}
for (const name of ['run', 'runTest']) {
    rejects(
        'tests/helpers/fixtures.mjs',
        `import { ${name} as scenario } from './cases.mjs'; scenario('new', () => {});`,
        '',
    );
}

const launcher =
    "import { runTypedTest } from './helpers/runTypedTest.mjs';\nawait runTypedTest(new URL('./typed.test.ts', import.meta.url));";
accepts('tests/typed.test.mjs', launcher, null, ['tests/typed.test.ts']);
accepts('tests/typed.test.mjs', launcher, legacy, ['tests/typed.test.ts']);
rejects('tests/typed.test.mjs', launcher, null);
rejects('tests/typed.test.mjs', `${launcher}\nassert.ok(true);`, null, ['tests/typed.test.ts']);
rejects('tests/typed.test.mjs', launcher.replace('./typed.test.ts', './another.test.ts'), null, [
    'tests/another.test.ts',
]);
rejects(
    'tests/typed.test.mjs',
    launcher.replace('./helpers/runTypedTest.mjs', './untrustedRunner.mjs'),
    null,
    ['tests/typed.test.ts'],
);
rejects('tests/typed.test.mjs', launcher.replace('./typed.test.ts', '/typed.test.ts'), null, [
    'tests/typed.test.ts',
]);
accepts('tests/typed.test.mjs', launcher.replace('./typed.test.ts', './typed.test.tsx'), null, [
    'tests/typed.test.tsx',
]);
accepts(
    'tests/sub folder/λ.test.mjs',
    launcher.replace('./helpers/', '../helpers/').replace('./typed.test.ts', './λ.test.ts'),
    null,
    ['tests/sub folder/λ.test.ts'],
);
rejects('tests\\legacy.test.mjs', `${legacy}\ntest('new', () => {});`, legacy);

interface GitFixture {
    root: string;
    git(...args: string[]): string;
    write(file: string, content: string): void;
    env: NodeJS.ProcessEnv;
}

/** Isolate Git writes and identity from the caller's repository, index and hook environment. */
function gitFixture(run: (fixture: GitFixture) => void): void {
    const temporaryRoot = path.resolve('.tmp-agent-tests/test-language-fixtures');
    mkdirSync(temporaryRoot, { recursive: true });
    const root = mkdtempSync(path.join(temporaryRoot, 'zync-test-language-'));
    const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
    );
    const git = (...args: string[]) =>
        execFileSync('git', args, {
            cwd: root,
            env,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trimEnd();
    const write = (file: string, content: string) => {
        const destination = path.join(root, file);
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, content);
    };

    try {
        git('init', '--quiet');
        run({ root, git, write, env });
    } finally {
        if (
            path.dirname(root) !== temporaryRoot ||
            !path.basename(root).startsWith('zync-test-language-')
        ) {
            throw new Error('Refusing cleanup outside the owned Git fixture');
        }

        rmSync(root, { recursive: true, force: true });
    }
}

/** Create a synthetic committed snapshot without running repository hooks. */
function commitSnapshot(git: GitFixture['git'], message: string, parent?: string): string {
    return git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@invalid',
        'commit-tree',
        git('write-tree'),
        ...(parent ? ['-p', parent] : []),
        '-m',
        message,
    );
}

gitFixture(({ root, git, write }) => {
    const javascript = 'tests/λ staged.test.mjs';
    const typescript = 'tests/λ staged.test.ts';
    const stagedLauncher = launcher.replaceAll('typed.test.ts', 'λ staged.test.ts');
    write(javascript, stagedLauncher);
    write(typescript, 'assert.equal(1, 1);\n');
    git('add', '--', javascript);
    assert.ok(
        policy.checkStagedTestLanguage(root).errors.length > 0,
        'A working-only TS sibling cannot authorize a staged launcher',
    );
    git('add', '--', typescript);
    const tree = git('write-tree');

    write(javascript, "assert.equal('working-only JS', false);");
    assert.deepEqual(
        policy.checkStagedTestLanguage(root).errors,
        [],
        'Read staged code rather than an unrelated working edit',
    );
    assert.equal(git('write-tree'), tree, 'A passing check cannot change the index');
    checks++;

    git('add', '--', javascript);
    write(javascript, stagedLauncher);
    const invalidTree = git('write-tree');
    assert.ok(
        policy.checkStagedTestLanguage(root).errors.length > 0,
        'An unstaged valid launcher cannot hide staged JS test logic',
    );
    assert.equal(git('write-tree'), invalidTree, 'A failing check cannot change the index');
    checks++;
});

gitFixture(({ root, git, write, env }) => {
    const file = 'tests/legacy.test.mjs';
    write(file, legacy);
    git('add', '--', file);
    const base = git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@invalid',
        'commit-tree',
        git('write-tree'),
        '-m',
        'Synthetic baseline',
    );
    git('update-ref', 'HEAD', base);
    write(file, `${legacy}\ntest('new', () => {});`);
    git('add', '--', file);
    const head = git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@invalid',
        'commit-tree',
        git('write-tree'),
        '-p',
        base,
        '-m',
        'Synthetic changed snapshot',
    );
    git('update-ref', 'HEAD', head);
    write(file, legacy);

    let failed = false;
    try {
        execFileSync(process.execPath, [policyPath, '--base', base], {
            cwd: root,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch {
        failed = true;
    }
    assert.ok(
        failed,
        'CI must read the committed range even when working files remove its new JS case',
    );
    assert.deepEqual(
        policy.checkStagedTestLanguage(root).errors,
        [],
        'An unchanged index has no staged cases to check',
    );
    checks++;
});

const sharedNewCase = `${legacy}\ntest('same new case on both branches', () => {});`;
for (const scenario of [
    {
        label: 'Base-only assertion changes cannot reject feature-branch harness maintenance',
        baseSource: legacy.replace('assert.equal(1, 1)', 'assert.equal(2, 2)'),
        headSource: `${legacy}\nconst harness = { cleanup() {} };`,
        status: 0,
    },
    {
        label: 'A feature-branch case cannot hide behind the same addition on the base branch',
        baseSource: sharedNewCase,
        headSource: sharedNewCase,
        status: 1,
    },
]) {
    gitFixture(({ root, git, write, env }) => {
        const file = 'tests/legacy.test.mjs';
        write(file, legacy);
        git('add', '--', file);
        const ancestor = commitSnapshot(git, 'Common ancestor');
        write(file, scenario.baseSource);
        git('add', '--', file);
        const base = commitSnapshot(git, 'Diverged comparison branch', ancestor);
        git('update-ref', 'refs/heads/comparison-base', base);
        write(file, scenario.headSource);
        git('add', '--', file);
        const head = commitSnapshot(git, 'Diverged feature branch', ancestor);
        git('update-ref', 'HEAD', head);

        assert.equal(git('merge-base', base, 'HEAD'), ancestor);
        const result = spawnSync(
            process.execPath,
            [policyPath, '--base', 'refs/heads/comparison-base'],
            { cwd: root, env, encoding: 'utf8' },
        );
        assert.equal(result.error, undefined);
        assert.equal(result.status, scenario.status, `${scenario.label}\n${result.stderr}`);
        checks++;
    });
}

gitFixture(({ root, git, write, env }) => {
    const file = 'tests/legacy.test.mjs';
    write(file, legacy);
    git('add', '--', file);
    const head = commitSnapshot(git, 'Current history');
    git('update-ref', 'HEAD', head);
    const unrelated = commitSnapshot(git, 'Unrelated history');
    git('update-ref', 'refs/heads/unrelated', unrelated);

    for (const base of ['refs/heads/missing', 'refs/heads/unrelated']) {
        const result = spawnSync(process.execPath, [policyPath, '--base', base], {
            cwd: root,
            env,
            encoding: 'utf8',
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1, 'An unusable explicit base must fail the policy check');
        checks++;
    }
});

console.log(`Test language policy checks passed (${checks}).`);
