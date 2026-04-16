import { spawnSync } from 'node:child_process';

const tests = [
  'tests/agentRunStore.partialize.test.mjs',
  'tests/aiSidebarResize.test.mjs',
  'tests/codeMirrorHelpers.test.mjs',
  'tests/connectionDomain.test.mjs',
  'tests/connectionFormTransforms.test.mjs',
  'tests/connectionLifecycleService.test.mjs',
  'tests/connectionService.test.mjs',
  'tests/connectionTabService.test.mjs',
  'tests/ghostSuggestionsHelpers.test.mjs',
  'tests/providerCatalog.test.mjs',
  'tests/redactContext.test.mjs',
  'tests/requestContext.test.mjs',
  'tests/sessionPersistence.test.mjs',
  'tests/sidebarSubmit.test.mjs',
  'tests/tunnelAutoStartService.test.mjs',
];

for (const file of tests) {
  const result = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
