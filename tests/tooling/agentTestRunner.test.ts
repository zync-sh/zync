import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

interface TestBuild {
    outputDirectory: string;
    resolveTestFile(source: string): string;
}

interface TestRunner {
    tests: string[];
    browserSuites: Record<string, string>;
    readTestBuild(configFile?: string): TestBuild;
    runAgentTests(
        arguments_: string[],
        spawn: (executable: string, arguments_: string[], options: unknown) => { status: number },
    ): number;
}

const runner = (await import(
    pathToFileURL(path.resolve('tests/runAllAgentTests.mjs')).href
)) as TestRunner;

test('registered suites name source files and resolve every typed source through the compiler', () => {
    const build = runner.readTestBuild();
    assert.ok(runner.tests.includes('tests/appearance/themeSelection.test.ts'));
    for (const source of [...runner.tests, ...Object.values(runner.browserSuites)]) {
        assert.match(source, /^tests\//);
        assert.ok(fs.existsSync(source), source);
        const executable = build.resolveTestFile(source);
        if (/\.(?:[cm]?ts|tsx)$/.test(source)) {
            const relative = path.relative(build.outputDirectory, executable);
            assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), source);
            assert.match(executable, /\.(?:[cm]?js|jsx)$/);
        } else {
            assert.equal(executable, path.resolve(source));
        }
    }
});

test('resolution follows a different configured output directory and rejects excluded sources', () => {
    const parent = path.resolve('.tmp-agent-tests/runner-policy-tests');
    fs.mkdirSync(parent, { recursive: true });
    const directory = fs.mkdtempSync(path.join(parent, 'compile-'));
    try {
        const input = path.join(directory, 'sources', 'example.test.ts');
        fs.mkdirSync(path.dirname(input));
        fs.writeFileSync(input, 'export const answer: number = 7;\n');
        const configFile = path.join(directory, 'tsconfig.json');
        fs.writeFileSync(
            configFile,
            JSON.stringify({
                compilerOptions: {
                    rootDir: 'sources',
                    outDir: 'generated-output',
                    target: 'ES2022',
                    module: 'ESNext',
                    skipLibCheck: true,
                    types: [],
                },
                include: ['sources/**/*.ts'],
            }),
        );
        const build = runner.readTestBuild(configFile);
        const expected = path.join(directory, 'generated-output', 'example.test.js');
        assert.equal(path.resolve(build.resolveTestFile(input)), expected);
        assert.equal(fs.existsSync(expected), false);
        const require = createRequire(import.meta.url);
        const result = spawnSync(
            process.execPath,
            [require.resolve('typescript/bin/tsc'), '-p', configFile],
            { encoding: 'utf8' },
        );
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(fs.readFileSync(expected, 'utf8'), /export const answer = 7/);
        assert.throws(
            () => build.resolveTestFile(path.join(directory, 'excluded.test.ts')),
            /not included by the compiler/,
        );
    } finally {
        assert.equal(path.dirname(directory), parent);
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('a compiler failure stops the runner before any suite can execute', () => {
    let executions = 0;
    const status = runner.runAgentTests(['ai'], (executable, arguments_) => {
        executions++;
        assert.equal(executable, process.execPath);
        assert.ok(arguments_[0].replaceAll('\\', '/').endsWith('/typescript/bin/tsc'));
        assert.equal(arguments_[1], '-p');
        assert.equal(path.basename(arguments_[2]), 'tsconfig.agent-tests.json');
        return { status: 23 };
    });
    assert.equal(status, 23);
    assert.equal(executions, 1);
});

test('legacy terminal suites receive a preload and an entry point as separate arguments', () => {
    const suite = path.resolve('tests/terminalLifecycleOwnership.test.mjs');
    let argumentsForSuite: string[] | undefined;
    const status = runner.runAgentTests(['terminal'], (executable, arguments_) => {
        assert.equal(executable, process.execPath);
        if (arguments_.includes(suite)) {
            argumentsForSuite = arguments_;
        }
        return { status: 0 };
    });
    assert.equal(status, 0);
    const preload = runner
        .readTestBuild()
        .resolveTestFile('tests/terminal/helpers/legacyTerminalEnvironment.ts');
    assert.deepEqual(argumentsForSuite, ['--import', pathToFileURL(preload).href, '--', suite]);
});
