import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const JS_RUNTIME_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.node']);

function hasJsRuntimeExtension(specifier) {
  return JS_RUNTIME_EXTENSIONS.has(path.extname(specifier));
}

// Node ESM requires exact extensions. Normalize the relative imports emitted from
// production files that still use bundler-style extensionless module specifiers.
function normalizeEmittedImports(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) normalizeEmittedImports(fullPath);
    else if (entry.isFile() && entry.name.endsWith('.js')) {
      const source = fs.readFileSync(fullPath, 'utf8');
      const normalized = source.replace(
        /((?:from\s+|import\s*\(\s*)['"])(\.\.?\/[^'"]+)(['"])/g,
        (match, prefix, specifier, suffix) => {
          if (hasJsRuntimeExtension(specifier)) return match;
          if (specifier.endsWith('/useConnectionDisplayLabels')) return match;
          const resolved = path.resolve(path.dirname(fullPath), specifier);
          if (fs.existsSync(`${resolved}.js`)) return `${prefix}${specifier}.js${suffix}`;
          if (fs.existsSync(path.join(resolved, 'index.js'))) return `${prefix}${specifier}/index.js${suffix}`;
          return match;
        },
      );
      if (normalized !== source) fs.writeFileSync(fullPath, normalized, 'utf8');
    }
  }
}

normalizeEmittedImports(path.resolve('.tmp-agent-tests'));

const tests = [
  'tests/agentRunStore.partialize.test.mjs',
  'tests/aiSidebarResize.test.mjs',
  'tests/codeMirrorHelpers.test.mjs',
  'tests/connectionDomain.test.mjs',
  'tests/connectionDisplay.test.mjs',
  'tests/notificationHistory.test.mjs',
  'tests/connectionOpQueue.test.mjs',
  'tests/connectCancelState.test.mjs',
  'tests/connectionFormTransforms.test.mjs',
  'tests/connectionLifecycleService.test.mjs',
  'tests/keyPassphrasePrompt.test.mjs',
  'tests/hostKeyVerification.test.mjs',
  'tests/editorPluginFrameIsolation.test.mjs',
  'tests/pluginPanelSshConfirmation.test.mjs',
  'tests/pluginCommandBridge.test.mjs',
  'tests/uiConfirmQueue.test.mjs',
  'tests/keyPassphraseRuntime.test.mjs',
  'tests/connectionService.test.mjs',
  'tests/connectionTabService.test.mjs',
  'tests/ghostSuggestionsHelpers.test.mjs',
  'tests/terminalOutputStream.test.mjs',
  'tests/fileDropToTerminal.test.mjs',
  'tests/fileGridLayout.test.mjs',
  'tests/fileMarquee.test.mjs',
  'tests/filePathNav.test.mjs',
  'tests/fileVolumes.test.mjs',
  'tests/themedIconSrc.test.mjs',
  'tests/fileSearchFilter.test.mjs',
  'tests/errorBoundary.test.mjs',
  'tests/releaseNotesMarkdown.test.mjs',
  'tests/providerCatalog.test.mjs',
  'tests/quickConnectParsing.test.mjs',
  'tests/quickConnectSubcomponents.test.mjs',
  'tests/redactContext.test.mjs',
  'tests/requestContext.test.mjs',
  'tests/sessionPersistence.test.mjs',
  'tests/usageQueue.test.mjs',
  'tests/usageSession.test.mjs',
  'tests/featureTabInventory.test.mjs',
  'tests/paneLayout.test.mjs',
  'tests/dockInSplit.self.test.mjs',
  'tests/workspaceOpenItems.test.mjs',
  'tests/openHerePaths.test.mjs',
  'tests/appAddItems.test.mjs',
  'tests/shellExit.test.mjs',
  'tests/shortcuts.test.mjs',
  'tests/terminalImage.test.mjs',
  'tests/terminalRendererPolicy.test.mjs',
  'tests/terminalWebglCapability.test.mjs',
  'tests/terminalRendererSession.test.mjs',
  'tests/terminalRendererController.test.mjs',
  'tests/terminalRendererDiagnostics.test.mjs',
  'tests/terminalInputPipeline.test.mjs',
  'tests/terminalInputQueue.test.mjs',
  'tests/terminalPtyLifecycle.test.mjs',
  'tests/terminalPtyKeyTranslations.test.mjs',
  'tests/terminalSpawnErrors.test.mjs',
  'tests/terminalReconnectFlow.test.mjs',
  'tests/terminalSpawnContext.test.mjs',
  'tests/terminalLazyPty.test.mjs',
  'tests/terminalConnectionWakeup.test.mjs',
  'tests/terminalLifecycleIntegration.test.mjs',
  'tests/terminalOutputPayload.test.mjs',
  'tests/terminalPanelRestore.test.mjs',
  'tests/terminalResizeSync.test.mjs',
  'tests/terminalFit.test.mjs',
  'tests/terminalReconnectReset.test.mjs',
  'tests/sidebarSubmit.test.mjs',
  'tests/statusBarLatency.test.mjs',
  'tests/surveyEligibility.test.mjs',
  'tests/tunnelAutoStartService.test.mjs',
  'tests/tunnelReconnectService.test.mjs',
  'tests/syncPassphrase.test.mjs',
  'tests/connectionsRestore.test.mjs',
  'tests/vaultUnlockPrompt.test.mjs',
  'tests/updateNotificationAutoUpdateFlow.test.mjs',
  'tests/updaterFlow.test.mjs',
];

for (const file of tests) {
  const args = file.startsWith('tests/terminal')
    ? [
        '--input-type=module',
        '--eval',
        `globalThis.window={ipcRenderer:{invoke:async()=>undefined,send:()=>{},on:()=>()=>{}},dispatchEvent:()=>true};await import(${JSON.stringify(pathToFileURL(path.resolve(file)).href)})`,
      ]
    : [file];
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
