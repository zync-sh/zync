import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const biome = require.resolve('@biomejs/biome/bin/biome');
const execute = promisify(execFile);

/** Execute local Biome without command-string interpolation or Windows task-tree cleanup. */
async function formatStagedFiles(files, cwd) {
    try {
        await execute(
            process.execPath,
            [biome, 'check', '--write', '--no-errors-on-unmatched', ...files],
            { cwd },
        );
    } catch (error) {
        const diagnostics = [error.stdout, error.stderr]
            .filter((output) => typeof output === 'string' && output.trim())
            .join('\n');
        console.error(diagnostics || error.message);
        throw error;
    }
}

// lint-staged owns backup, partial-staging isolation and restaging. A function task
// avoids its Windows taskkill error path after a formatter exits unsuccessfully.
/** Bind tasks to one repository without changing process-wide working directory. */
export function createStagedTasks(cwd = process.cwd()) {
    return {
        '*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}': {
            title: 'Format and organize staged code',
            task: (files) => formatStagedFiles(files, cwd),
        },
    };
}

export default createStagedTasks();
