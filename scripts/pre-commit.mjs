import { fileURLToPath } from 'node:url';

import lintStaged from 'lint-staged';

import { createStagedTasks } from '../lint-staged.config.mjs';
import { checkStagedTestLanguage } from './check-test-language.mjs';

/** Validate staged tests before formatting so a policy failure leaves Git state intact. */
export async function runPreCommit({ cwd = process.cwd() } = {}) {
    const { errors } = checkStagedTestLanguage(cwd);
    if (errors.length > 0) {
        console.error(errors.join('\n'));
        return false;
    }

    return lintStaged({
        cwd,
        config: createStagedTasks(cwd),
        // Keep lint-staged's backup, error rollback and partial-staging protection enabled.
        stash: true,
        hidePartiallyStaged: true,
    });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    try {
        process.exitCode = (await runPreCommit()) ? 0 : 1;
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
