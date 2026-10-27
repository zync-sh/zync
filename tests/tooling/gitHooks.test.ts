import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

interface InstallationResult {
    installed: boolean;
    changed?: boolean;
    hookPath?: string;
    reason?: string;
}

interface HookInstaller {
    installGitHooks(projectRoot: string): InstallationResult;
}

const projectRoot = process.cwd();
const fixtureBase = path.join(projectRoot, '.tmp-agent-tests', 'git-hook-fixtures');
const execute = promisify(execFile);
const installer = (await import(
    pathToFileURL(path.join(projectRoot, 'scripts/install-git-hooks.mjs')).href
)) as HookInstaller;

/** Run Git with isolated fixture settings and no shell interpolation. */
function git(root: string, ...args: string[]): string {
    return execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

/** Write fixture files without touching the application's working tree. */
function write(root: string, relative: string, source: string): void {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, source, 'utf8');
}

/** Commit fixture baselines without invoking local hooks or signing helpers. */
function commitFixture(root: string): void {
    git(
        root,
        '-c',
        'core.hooksPath=.no-fixture-hooks',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Hook Fixture',
        '-c',
        'user.email=hook-fixture@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'Fixture baseline',
    );
}

/** Allocate disposable Git repositories; commits exist only inside these fixtures. */
function fixture(t: TestContext, initialize = true): string {
    mkdirSync(fixtureBase, { recursive: true });
    const root = mkdtempSync(path.join(fixtureBase, 'repo with spaces-é-'));
    t.after(() => {
        const relative = path.relative(fixtureBase, path.resolve(root));
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        rmSync(root, { recursive: true, force: true });
    });

    if (initialize) {
        git(root, 'init', '--quiet');
        git(root, 'config', 'core.autocrlf', 'false');
        git(root, 'config', 'core.safecrlf', 'false');
        git(root, 'config', 'core.quotepath', 'false');
        write(root, 'biome.json', readFileSync(path.join(projectRoot, 'biome.json'), 'utf8'));
        write(root, 'README.md', '# Disposable hook fixture\n');
        git(root, 'add', '--', 'README.md');
        commitFixture(root);
    }

    return root;
}

/** Local installation remains testable when the test runner itself is executing in CI. */
function install(root: string): InstallationResult {
    const previous = process.env.CI;
    delete process.env.CI;
    try {
        return installer.installGitHooks(root);
    } finally {
        if (previous === undefined) {
            delete process.env.CI;
        } else {
            process.env.CI = previous;
        }
    }
}

/** Exercise the real pre-commit runner against an isolated index. */
async function preCommit(root: string): Promise<boolean> {
    const moduleUrl = pathToFileURL(path.join(projectRoot, 'scripts/pre-commit.mjs')).href;
    const script = `
        const { runPreCommit } = await import(process.argv[1]);
        const result = await runPreCommit({ cwd: process.cwd() });
        console.log('HOOK_RESULT:' + result);
    `;
    const { stdout } = await execute(
        process.execPath,
        ['--input-type=module', '--eval', script, moduleUrl],
        {
            cwd: root,
            encoding: 'utf8',
            timeout: 30_000,
            killSignal: 'SIGKILL',
            maxBuffer: 2 * 1024 * 1024,
        },
    );
    const result = /^HOOK_RESULT:(true|false)$/m.exec(stdout);
    assert.ok(result, 'The actual pre-commit API must report its boolean result');
    return result[1] === 'true';
}

/** Recognize the restricted Windows host's shell-start denial, not hook failures. */
function restrictedGitShell(error: unknown): boolean {
    return (
        process.platform === 'win32' &&
        typeof error === 'object' &&
        error !== null &&
        'stderr' in error &&
        typeof error.stderr === 'string' &&
        error.stderr.includes('NtCreateDirectoryObject') &&
        error.stderr.includes('0xC0000022')
    );
}

test('hook installation preserves the existing check, other hooks and repeated installation', (t) => {
    const root = fixture(t);
    const original =
        '#!/bin/sh\n# Existing graph check — preserved\nif command -v code-review-graph >/dev/null 2>&1; then\n    code-review-graph detect-changes --brief || true\nfi\n';
    write(root, '.git/hooks/pre-commit', original);
    write(root, '.git/hooks/post-commit', '#!/bin/sh\nprintf post-commit\n');

    const first = install(root);
    assert.equal(first.installed, true);
    assert.equal(first.changed, true);
    const installed = readFileSync(first.hookPath!, 'utf8');
    assert.ok(installed.startsWith('#!/bin/sh\n# >>> zync managed pre-commit >>>\n'));
    assert.ok(
        installed.indexOf('node scripts/pre-commit.mjs || exit $?') <
            installed.indexOf('code-review-graph'),
    );
    assert.ok(installed.endsWith(original.slice('#!/bin/sh\n'.length)));
    assert.equal(
        readFileSync(path.join(root, '.git/hooks/post-commit'), 'utf8'),
        '#!/bin/sh\nprintf post-commit\n',
    );

    const second = install(root);
    assert.equal(second.installed, true);
    assert.equal(second.changed, false);
    assert.equal(readFileSync(first.hookPath!, 'utf8'), installed);
    assert.equal(installed.split('node scripts/pre-commit.mjs').length - 1, 1);
    if (process.platform !== 'win32') {
        assert.notEqual(statSync(first.hookPath!).mode & 0o111, 0);
    }
});

test('a fresh hook uses LF and supports repository paths containing spaces and Unicode', (t) => {
    const root = fixture(t);
    const result = install(root);
    assert.equal(result.installed, true);
    assert.ok(result.hookPath!.startsWith(root));
    const source = readFileSync(result.hookPath!, 'utf8');
    assert.ok(source.startsWith('#!/bin/sh\n'));
    assert.equal(source.includes('\r'), false);
    assert.equal(
        git(root, 'config', '--local', '--get-regexp', '^core\\.').includes('core.hookspath'),
        false,
    );
});

test('supported shell shebangs retain interpreter options and normalize the first line to LF', (t) => {
    for (const shell of ['sh', 'bash', 'dash', 'ksh', 'zsh']) {
        for (const header of [
            `#!/bin/${shell} -eu\n`,
            `#!/usr/bin/env ${shell} -eu\n`,
            `#!/usr/bin/env -S ${shell} -eu\r\n`,
        ]) {
            const root = fixture(t);
            const body = 'printf existing-check\r\n';
            write(root, '.git/hooks/pre-commit', header + body);

            const first = install(root);
            assert.equal(first.installed, true, header);
            const source = readFileSync(first.hookPath!, 'utf8');
            assert.ok(source.startsWith(header.replace(/\r?\n$/, '\n')), header);
            assert.ok(
                source.endsWith(body),
                'Existing hook commands retain their original line endings',
            );
            assert.equal(install(root).changed, false, 'Option-bearing hooks remain idempotent');
        }
    }
});

test('shell options do not admit unsupported interpreters or a bare carriage-return shebang', (t) => {
    for (const header of [
        '#!/usr/bin/env python3 -u\n',
        '#!/usr/bin/env -S python3 -u\n',
        '#!/bin/bashish -eu\n',
        '#!/usr/bin/env -S bashish -eu\n',
        '#!/usr/bin/env -S\n',
        '#!/bin/sh -eu\r',
    ]) {
        const root = fixture(t);
        const original = `${header}printf existing-check\n`;
        write(root, '.git/hooks/pre-commit', original);
        assert.throws(() => install(root), /not a supported shell script/, header);
        assert.equal(readFileSync(path.join(root, '.git/hooks/pre-commit'), 'utf8'), original);
    }
});

test('the installed guard skips a missing runner and preserves its exact failure status when present', (t) => {
    const root = fixture(t);
    write(
        root,
        'scripts/existing-check.mjs',
        "import { appendFileSync } from 'node:fs';\nappendFileSync('hook-order.txt', 'existing\\n');\n",
    );
    write(root, '.git/hooks/pre-commit', '#!/bin/sh\nnode scripts/existing-check.mjs\n');
    const result = install(root);
    assert.equal(result.installed, true);
    assert.match(
        readFileSync(result.hookPath!, 'utf8'),
        /if \[ -f scripts\/pre-commit\.mjs \]; then\n    node scripts\/pre-commit\.mjs \|\| exit \$\?\nfi/,
    );

    try {
        git(root, 'hook', 'run', 'pre-commit');
    } catch (error) {
        if (restrictedGitShell(error)) {
            t.skip('Windows sandbox prevents Git for Windows from starting its hook shell.');
            return;
        }
        throw error;
    }
    const trace = path.join(root, 'hook-order.txt');
    assert.equal(readFileSync(trace, 'utf8'), 'existing\n');
    unlinkSync(trace);

    const managed =
        "import { appendFileSync } from 'node:fs';\nappendFileSync('hook-order.txt', 'managed\\n');\n";
    write(root, 'scripts/pre-commit.mjs', `${managed}process.exitCode = 7;\n`);
    assert.throws(
        () => git(root, 'hook', 'run', 'pre-commit'),
        (error: unknown) =>
            typeof error === 'object' && error !== null && 'status' in error && error.status === 7,
    );
    assert.equal(
        readFileSync(trace, 'utf8'),
        'managed\n',
        'A failed project check stops existing checks',
    );
    unlinkSync(trace);

    write(root, 'scripts/pre-commit.mjs', managed);
    git(root, 'hook', 'run', 'pre-commit');
    assert.equal(readFileSync(trace, 'utf8'), 'managed\nexisting\n');
});

test('custom hooksPath is respected without rewriting its hook or configuration', (t) => {
    const root = fixture(t);
    const original = '#!/bin/sh\nprintf custom-check\n';
    write(root, 'custom hooks/pre-commit', original);
    git(root, 'config', 'core.hooksPath', 'custom hooks');

    const result = install(root);
    assert.equal(result.installed, false);
    assert.match(result.reason!, /custom core\.hooksPath/i);
    assert.equal(git(root, 'config', '--get', 'core.hooksPath').trim(), 'custom hooks');
    assert.equal(readFileSync(path.join(root, 'custom hooks/pre-commit'), 'utf8'), original);
    assert.equal(existsSync(path.join(root, '.git/hooks/pre-commit')), false);
});

test('CI and source archives skip installation without editing an ancestor repository', (t) => {
    const root = fixture(t);
    const previous = process.env.CI;
    process.env.CI = 'true';
    try {
        assert.equal(installer.installGitHooks(root).installed, false);
        assert.equal(existsSync(path.join(root, '.git/hooks/pre-commit')), false);
    } finally {
        if (previous === undefined) {
            delete process.env.CI;
        } else {
            process.env.CI = previous;
        }
    }

    const archive = fixture(t, false);
    const result = install(archive);
    assert.equal(result.installed, false);
    assert.match(result.reason!, /not a Git checkout root/);
    assert.equal(existsSync(path.join(archive, '.git')), false);
});

test('damaged or duplicate managed markers fail without overwriting the existing hook', (t) => {
    for (const body of [
        '# >>> zync managed pre-commit >>>\nprintf incomplete\n',
        '# <<< zync managed pre-commit <<<\n',
        '# >>> zync managed pre-commit >>>\n# <<< zync managed pre-commit <<<\n# >>> zync managed pre-commit >>>\n# <<< zync managed pre-commit <<<\n',
    ]) {
        const root = fixture(t);
        const original = `#!/bin/sh\n${body}`;
        write(root, '.git/hooks/pre-commit', original);
        assert.throws(() => install(root), /malformed or duplicate/);
        assert.equal(readFileSync(path.join(root, '.git/hooks/pre-commit'), 'utf8'), original);
    }
});

test('an intact older managed block updates in place without duplicating its invocation', (t) => {
    const root = fixture(t);
    write(
        root,
        '.git/hooks/pre-commit',
        '#!/bin/sh\n# >>> zync managed pre-commit >>>\nnode obsolete-runner.mjs\n# <<< zync managed pre-commit <<<\nprintf existing-check\n',
    );
    const result = install(root);
    const source = readFileSync(result.hookPath!, 'utf8');
    assert.equal(source.includes('obsolete-runner'), false);
    assert.equal(source.split('node scripts/pre-commit.mjs').length - 1, 1);
    assert.ok(source.endsWith('printf existing-check\n'));
});

test('non-shell hooks fail closed instead of receiving incompatible shell syntax', (t) => {
    const root = fixture(t);
    const original = '#!/usr/bin/env python3\nprint("Existing hook")\n';
    write(root, '.git/hooks/pre-commit', original);
    assert.throws(() => install(root), /not a supported shell script/);
    assert.equal(readFileSync(path.join(root, '.git/hooks/pre-commit'), 'utf8'), original);
});

test('linked worktrees resolve their real Git hook directory without assuming a .git folder', (t) => {
    const root = fixture(t);
    const linked = path.join(root, 'linked worktree-é');
    git(root, 'worktree', 'add', '--detach', '--quiet', linked, 'HEAD');
    assert.equal(statSync(path.join(linked, '.git')).isFile(), true);
    const result = install(linked);
    assert.equal(result.installed, true);
    assert.equal(path.resolve(result.hookPath!), path.join(root, '.git/hooks/pre-commit'));
});

test('installer CLI resolves its own package root when launched from a different directory', (t) => {
    const root = fixture(t);
    write(
        root,
        'scripts/install-git-hooks.mjs',
        readFileSync(path.join(projectRoot, 'scripts/install-git-hooks.mjs'), 'utf8'),
    );
    const result = execFileSync(
        process.execPath,
        [path.join(root, 'scripts/install-git-hooks.mjs')],
        {
            cwd: projectRoot,
            encoding: 'utf8',
            timeout: 10_000,
            env: { ...process.env, CI: 'false' },
        },
    );
    assert.match(result, /pre-commit hook installed/);
    assert.match(
        readFileSync(path.join(root, '.git/hooks/pre-commit'), 'utf8'),
        /node scripts\/pre-commit\.mjs/,
    );
});

test('pre-commit formats only staged code and preserves an untouched unstaged file', async (t) => {
    const root = fixture(t);
    write(root, 'staged-é file.ts', 'export const value={first:1,second:"two"};\n');
    const unstaged = 'export const untouched={value:"leave this unchanged"};\n';
    write(root, 'unstaged.ts', unstaged);
    git(root, 'add', '--', 'staged-é file.ts');

    assert.equal(await preCommit(root), true);
    const staged = git(root, 'show', ':staged-é file.ts');
    assert.match(staged, /export const value = \{ first: 1, second: 'two' \};/);
    assert.equal(readFileSync(path.join(root, 'unstaged.ts'), 'utf8'), unstaged);
    assert.equal(git(root, 'diff', '--cached', '--name-only').trim(), 'staged-é file.ts');
});

test('pre-commit keeps partially staged edits outside the committed version', async (t) => {
    const root = fixture(t);
    write(root, 'partial.ts', 'export const staged={value:"staged"};\n');
    git(root, 'add', '--', 'partial.ts');
    write(
        root,
        'partial.ts',
        'export const staged={value:"staged"};\n\n// This edit must remain unstaged.\nexport const future = 2;\n',
    );

    assert.equal(await preCommit(root), true);
    const staged = git(root, 'show', ':partial.ts');
    assert.match(staged, /export const staged = \{ value: 'staged' \};/);
    assert.equal(staged.includes('future'), false);
    assert.match(readFileSync(path.join(root, 'partial.ts'), 'utf8'), /export const future = 2;/);
    assert.match(git(root, 'diff', '--', 'partial.ts'), /This edit must remain unstaged/);
});

test('syntax failure restores staged and unstaged content instead of leaving partial formatting', async (t) => {
    const root = fixture(t);
    write(root, 'good.ts', 'export const value={name:"original"};\n');
    write(root, 'broken.ts', 'export const broken = ;\n');
    git(root, 'add', '--', 'good.ts', 'broken.ts');
    write(
        root,
        'good.ts',
        'export const value={name:"original"};\n// preserve this unstaged edit\n',
    );
    const indexBefore = git(root, 'diff', '--cached', '--binary');
    const worktreeBefore = readFileSync(path.join(root, 'good.ts'), 'utf8');

    assert.equal(await preCommit(root), false);
    assert.equal(git(root, 'diff', '--cached', '--binary'), indexBefore);
    assert.equal(readFileSync(path.join(root, 'good.ts'), 'utf8'), worktreeBefore);
    assert.equal(readFileSync(path.join(root, 'broken.ts'), 'utf8'), 'export const broken = ;\n');
});

test('missing braces block the hook without applying unsafe control-flow fixes', async (t) => {
    const root = fixture(t);
    const source = 'export function choose(value: boolean) { if (value) return 1; return 0; }\n';
    write(root, 'braces.ts', source);
    git(root, 'add', '--', 'braces.ts');
    const indexBefore = git(root, 'show', ':braces.ts');

    assert.equal(await preCommit(root), false);
    assert.equal(git(root, 'show', ':braces.ts'), indexBefore);
    assert.equal(readFileSync(path.join(root, 'braces.ts'), 'utf8'), source);
});

test('import organization sorts named imports while preserving bare import execution order', async (t) => {
    const root = fixture(t);
    write(
        root,
        'imports.ts',
        'import "./setup-z";\nimport "./setup-a";\nimport { zed, alpha } from "some-package";\nexport { zed, alpha };\n',
    );
    git(root, 'add', '--', 'imports.ts');

    assert.equal(await preCommit(root), true);
    const source = git(root, 'show', ':imports.ts');
    assert.ok(source.indexOf("import './setup-z';") < source.indexOf("import './setup-a';"));
    assert.match(source, /import \{ alpha, zed \} from 'some-package';/);
});

test('generated and vendored staged code is left untouched', async (t) => {
    const root = fixture(t);
    const source = 'export const generated={leave:"unchanged"};\n';
    for (const file of ['src/generated/example.ts', 'vendor/example.js']) {
        write(root, file, source);
        git(root, 'add', '--', file);
    }

    assert.equal(await preCommit(root), true);
    for (const file of ['src/generated/example.ts', 'vendor/example.js']) {
        assert.equal(git(root, 'show', `:${file}`), source);
        assert.equal(readFileSync(path.join(root, file), 'utf8'), source);
    }
});

test('new JavaScript test logic is rejected while a TypeScript test is accepted', async (t) => {
    const rejected = fixture(t);
    write(
        rejected,
        'tests/new.test.mjs',
        "import { test } from 'node:test';\ntest('new JS test', () => {});\n",
    );
    git(rejected, 'add', '--', 'tests/new.test.mjs');
    assert.equal(await preCommit(rejected), false);

    const accepted = fixture(t);
    write(
        accepted,
        'tests/new.test.ts',
        "import { test } from 'node:test';\ntest('new typed test', () => {});\n",
    );
    git(accepted, 'add', '--', 'tests/new.test.ts');
    assert.equal(await preCommit(accepted), true);
});

test('legacy JavaScript harness maintenance remains allowed while new cases and assertions are rejected', async (t) => {
    const baseline =
        "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('legacy', () => { assert.equal(1, 1); });\n";
    for (const change of ['maintenance', 'case', 'assertion']) {
        const root = fixture(t);
        write(root, 'tests/legacy.test.mjs', baseline);
        git(root, 'add', '--', 'tests/legacy.test.mjs');
        commitFixture(root);
        const changed =
            change === 'maintenance'
                ? `// Existing harness dependency maintenance.\nconst setup = true;\n${baseline}`
                : change === 'case'
                  ? `${baseline}test('new regression', () => {});\n`
                  : baseline.replace(
                        'assert.equal(1, 1);',
                        'assert.equal(1, 1); assert.equal(2, 2);',
                    );
        write(root, 'tests/legacy.test.mjs', changed);
        git(root, 'add', '--', 'tests/legacy.test.mjs');
        assert.equal(await preCommit(root), change === 'maintenance', change);
    }
});

test('a thin JavaScript launcher requires its same-name staged TypeScript test source', async (t) => {
    for (const withTarget of [false, true]) {
        const root = fixture(t);
        write(
            root,
            'tests/launcher.test.mjs',
            "import { runTypedTest } from './helpers/runTypedTest.mjs';\nawait runTypedTest(new URL('./launcher.test.ts', import.meta.url));\n",
        );
        git(root, 'add', '--', 'tests/launcher.test.mjs');
        if (withTarget) {
            write(root, 'tests/launcher.test.ts', 'export const typed = true;\n');
            git(root, 'add', '--', 'tests/launcher.test.ts');
        }
        assert.equal(await preCommit(root), withTarget);
    }
});

test('test-language enforcement reads the index instead of rejecting unstaged JavaScript edits', async (t) => {
    const root = fixture(t);
    const baseline = "import { test } from 'node:test';\ntest('existing', () => {});\n";
    write(root, 'tests/legacy.test.mjs', baseline);
    git(root, 'add', '--', 'tests/legacy.test.mjs');
    commitFixture(root);
    const staged = `// Existing harness maintenance.\n${baseline}`;
    write(root, 'tests/legacy.test.mjs', staged);
    git(root, 'add', '--', 'tests/legacy.test.mjs');
    write(
        root,
        'tests/legacy.test.mjs',
        `${staged}\n// Future work stays outside this commit.\ntest('future unstaged case', () => {});\n`,
    );

    assert.equal(await preCommit(root), true);
    assert.equal(
        git(root, 'show', ':tests/legacy.test.mjs').includes('future unstaged case'),
        false,
    );
    assert.match(
        readFileSync(path.join(root, 'tests/legacy.test.mjs'), 'utf8'),
        /future unstaged case/,
    );
});

test('actual pre-commit CLI formats staged code and exits unsuccessfully for missing braces', async (t) => {
    const root = fixture(t);
    write(root, 'cli.ts', 'export const value={name:"CLI"};\n');
    git(root, 'add', '--', 'cli.ts');
    const cli = path.join(projectRoot, 'scripts/pre-commit.mjs');
    await execute(process.execPath, [cli], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    assert.match(git(root, 'show', ':cli.ts'), /export const value = \{ name: 'CLI' \};/);

    write(
        root,
        'bad-cli.ts',
        'export function value(ready: boolean) { if (ready) return 1; return 0; }\n',
    );
    git(root, 'add', '--', 'bad-cli.ts');
    await assert.rejects(
        execute(process.execPath, [cli], { cwd: root, encoding: 'utf8', timeout: 30_000 }),
        (error: unknown) =>
            typeof error === 'object' && error !== null && 'code' in error && error.code === 1,
    );
});

test('the installed Git hook formats first, preserves the previous check and blocks it on failure', (t) => {
    const root = fixture(t);
    const moduleUrl = pathToFileURL(path.join(projectRoot, 'scripts/pre-commit.mjs')).href;
    write(
        root,
        'scripts/pre-commit.mjs',
        `const { runPreCommit } = await import(${JSON.stringify(moduleUrl)});\nprocess.exitCode = (await runPreCommit()) ? 0 : 1;\n`,
    );
    write(
        root,
        'scripts/existing-check.mjs',
        "import { writeFileSync } from 'node:fs';\nwriteFileSync('existing-check-ran.txt', 'Previous hook ran');\n",
    );
    write(root, '.git/hooks/pre-commit', '#!/bin/sh\nnode scripts/existing-check.mjs\n');
    assert.equal(install(root).installed, true);
    write(root, 'hook.ts', 'export const value={name:"hook"};\n');
    git(root, 'add', '--', 'hook.ts');

    try {
        git(root, 'hook', 'run', 'pre-commit');
    } catch (error) {
        if (restrictedGitShell(error)) {
            t.skip('Windows sandbox prevents Git for Windows from starting its hook shell.');
            return;
        }
        throw error;
    }
    assert.match(git(root, 'show', ':hook.ts'), /export const value = \{ name: 'hook' \};/);
    assert.equal(
        readFileSync(path.join(root, 'existing-check-ran.txt'), 'utf8'),
        'Previous hook ran',
    );

    unlinkSync(path.join(root, 'existing-check-ran.txt'));
    const invalid = 'export function value(ready: boolean) { if (ready) return 1; return 0; }\n';
    write(root, 'hook.ts', invalid);
    git(root, 'add', '--', 'hook.ts');
    let failed = false;
    try {
        git(root, 'hook', 'run', 'pre-commit');
    } catch (error) {
        if (restrictedGitShell(error)) {
            t.skip('Windows sandbox prevents Git for Windows from starting its hook shell.');
            return;
        }
        failed = true;
        assert.ok(
            typeof error === 'object' &&
                error !== null &&
                'stderr' in error &&
                typeof error.stderr === 'string',
        );
        assert.match(error.stderr, /useBlockStatements/);
    }
    assert.equal(failed, true, 'Missing braces must fail the installed hook');
    assert.equal(existsSync(path.join(root, 'existing-check-ran.txt')), false);
    assert.equal(git(root, 'show', ':hook.ts'), invalid);
});
