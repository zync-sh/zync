import { spawnSync } from 'node:child_process';

// Share emitted-import normalization, browser bootstrap and suite registration.
const result = spawnSync(process.execPath, ['tests/runAllAgentTests.mjs', 'terminal'], {
    stdio: 'inherit',
});
process.exit(result.status ?? 1);
