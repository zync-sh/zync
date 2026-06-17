import { spawnSync } from 'node:child_process';

const tests = [
  'tests/terminalRendererPolicy.test.mjs',
  'tests/terminalWebglCapability.test.mjs',
  'tests/terminalRendererSession.test.mjs',
  'tests/terminalRendererController.test.mjs',
  'tests/terminalRendererDiagnostics.test.mjs',
  'tests/terminalInputPipeline.test.mjs',
  'tests/terminalInputQueue.test.mjs',
  'tests/terminalPtyLifecycle.test.mjs',
  'tests/terminalSpawnContext.test.mjs',
  'tests/terminalLazyPty.test.mjs',
  'tests/terminalResizeSync.test.mjs',
  'tests/terminalReconnectReset.test.mjs',
  'tests/terminalConnectionWakeup.test.mjs',
  'tests/terminalLifecycleIntegration.test.mjs',
];

for (const file of tests) {
  console.log(`[terminal-renderer] Running ${file}`);
  const result = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`[terminal-renderer] ${file} failed`);
    process.exit(result.status ?? 1);
  }
}

console.log('[terminal-renderer] All tests passed.');
