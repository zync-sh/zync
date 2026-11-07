import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const patchDirectory = 'src-tauri/licenses/novnc';
const patches = [
    'pause-framebuffer.patch',
    'discard-resized-framebuffer.patch',
    'desktop-size-and-zoom.patch',
];

for (const name of patches) {
    const patch = `${patchDirectory}/${name}`;
    // The reverse check makes reinstalls idempotent. Changed upstream hunks fail installation.
    const alreadyApplied = spawnSync('git', ['apply', '--reverse', '--check', patch], { cwd });
    if (alreadyApplied.status !== 0) {
        execFileSync('git', ['apply', patch], { cwd, stdio: 'inherit' });
    }
}
