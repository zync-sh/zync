import { spawnSync } from 'node:child_process';

const tests = [
  'tests/agentRunStore.partialize.test.mjs',
  'tests/aiSidebarResize.test.mjs',
  'tests/codeMirrorHelpers.test.mjs',
  'tests/connectionDomain.test.mjs',
  'tests/connectionOpQueue.test.mjs',
  'tests/connectionFormTransforms.test.mjs',
  'tests/connectionLifecycleService.test.mjs',
  'tests/connectionService.test.mjs',
  'tests/connectionTabService.test.mjs',
  'tests/ghostSuggestionsHelpers.test.mjs',
  'tests/providerCatalog.test.mjs',
  'tests/quickConnectParsing.test.mjs',
  'tests/quickConnectSubcomponents.test.mjs',
  'tests/redactContext.test.mjs',
  'tests/requestContext.test.mjs',
  'tests/sessionPersistence.test.mjs',
  'tests/terminalRendererPolicy.test.mjs',
  'tests/terminalWebglCapability.test.mjs',
  'tests/terminalRendererSession.test.mjs',
  'tests/terminalRendererController.test.mjs',
  'tests/terminalRendererDiagnostics.test.mjs',
  'tests/terminalInputPipeline.test.mjs',
  'tests/terminalInputQueue.test.mjs',
  'tests/terminalPtyLifecycle.test.mjs',
  'tests/terminalSpawnErrors.test.mjs',
  'tests/terminalReconnectFlow.test.mjs',
  'tests/terminalSpawnContext.test.mjs',
  'tests/terminalLazyPty.test.mjs',
  'tests/terminalConnectionWakeup.test.mjs',
  'tests/terminalLifecycleIntegration.test.mjs',
  'tests/terminalResizeSync.test.mjs',
  'tests/terminalReconnectReset.test.mjs',
  'tests/sidebarSubmit.test.mjs',
  'tests/tunnelAutoStartService.test.mjs',
  'tests/syncPassphrase.test.mjs',
  'tests/updateNotificationAutoUpdateFlow.test.mjs',
];

for (const file of tests) {
  const result = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
