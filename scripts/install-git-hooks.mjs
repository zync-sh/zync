import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const START_MARKER = '# >>> zync managed pre-commit >>>';
const END_MARKER = '# <<< zync managed pre-commit <<<';
// Local hooks survive branch switches that may omit the project runner.
const MANAGED_BLOCK = `${START_MARKER}\nif [ -f scripts/pre-commit.mjs ]; then\n    node scripts/pre-commit.mjs || exit $?\nfi\n${END_MARKER}\n`;

/** Remove one complete managed block while rejecting ambiguous or damaged markers. */
function withoutManagedBlock(source) {
    const starts = source.split(START_MARKER).length - 1;
    const ends = source.split(END_MARKER).length - 1;
    if (!starts && !ends) {
        return source;
    }

    const block =
        /^# >>> zync managed pre-commit >>>\r?\n[\s\S]*?^# <<< zync managed pre-commit <<<(?:\r?\n|$)/m;
    if (starts !== 1 || ends !== 1 || !block.test(source)) {
        throw new Error('Cannot update pre-commit: malformed or duplicate Zync managed markers.');
    }

    return source.replace(block, '');
}

/** Install the project check without replacing existing local hooks or hook configuration. */
export function installGitHooks(projectRoot) {
    if (process.env.CI && process.env.CI !== 'false' && process.env.CI !== '0') {
        return { installed: false, reason: 'CI environment; local Git hooks are not installed.' };
    }

    const root = path.resolve(projectRoot);
    const repository = spawnSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (repository.status !== 0 || path.resolve(repository.stdout.trim()) !== root) {
        return {
            installed: false,
            reason: 'Project folder is not a Git checkout root; hooks are not installed.',
        };
    }

    const configured = spawnSync('git', ['config', '--get', 'core.hooksPath'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (configured.status === 0) {
        return {
            installed: false,
            reason: `Custom core.hooksPath is configured (${configured.stdout.trim() || '<empty>'}); add the project pre-commit check there manually.`,
        };
    }
    if (configured.status !== 1) {
        throw new Error(`Cannot inspect Git hook configuration: ${configured.stderr.trim()}`);
    }

    const configuredHook = execFileSync('git', ['rev-parse', '--git-path', 'hooks/pre-commit'], {
        cwd: root,
        encoding: 'utf8',
    }).trim();
    const hookPath = path.resolve(root, configuredHook);
    const previous = existsSync(hookPath) ? readFileSync(hookPath, 'utf8') : '#!/bin/sh\n';
    const unowned = withoutManagedBlock(previous);
    const shebang = /^#![^\r\n]*(?:\r?\n|$)/.exec(unowned);
    if (
        !shebang ||
        !/^#![ \t]*(?:\/[^\s]*\/)?(?:env[ \t]+(?:-S[ \t]+)?)?(?:sh|bash|dash|ksh|zsh)(?:[ \t]+[^\r\n]*)?(?:\r?\n|$)/.test(
            shebang[0],
        )
    ) {
        throw new Error('Cannot update pre-commit: existing hook is not a supported shell script.');
    }

    const firstLine = shebang[0].replace(/\r?\n$/, '');
    const next = `${firstLine}\n${MANAGED_BLOCK}${unowned.slice(shebang[0].length)}`;
    if (next === previous) {
        chmodSync(hookPath, statSync(hookPath).mode | 0o111);
        return { installed: true, changed: false, hookPath };
    }

    mkdirSync(path.dirname(hookPath), { recursive: true });
    const mode = existsSync(hookPath) ? statSync(hookPath).mode | 0o111 : 0o755;
    const temporary = `${hookPath}.zync-${randomUUID()}.tmp`;
    try {
        writeFileSync(temporary, next, { encoding: 'utf8', mode, flag: 'wx' });
        renameSync(temporary, hookPath);
        chmodSync(hookPath, mode);
    } finally {
        if (existsSync(temporary)) {
            unlinkSync(temporary);
        }
    }

    return { installed: true, changed: true, hookPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const result = installGitHooks(fileURLToPath(new URL('../', import.meta.url)));
        console.log(
            result.installed
                ? 'Project pre-commit hook installed; existing hooks preserved.'
                : result.reason,
        );
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
