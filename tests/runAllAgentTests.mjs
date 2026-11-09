import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readTestBuild } from '../scripts/agent-test-build.mjs';

export { readTestBuild };

const JS_RUNTIME_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.node']);

function hasJsRuntimeExtension(specifier) {
    return JS_RUNTIME_EXTENSIONS.has(path.extname(specifier));
}

// Node ESM requires exact extensions. Normalize the relative imports emitted from
// production files that still use bundler-style extensionless module specifiers.
function normalizeEmittedImports(directory) {
    if (!fs.existsSync(directory)) {
        return;
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            normalizeEmittedImports(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            const source = fs.readFileSync(fullPath, 'utf8');
            const normalized = source.replace(
                /((?:from\s+|import\s*\(\s*)['"])(\.\.?\/[^'"]+)(['"])/g,
                (match, prefix, specifier, suffix) => {
                    if (hasJsRuntimeExtension(specifier)) {
                        return match;
                    }
                    if (specifier.endsWith('/useConnectionDisplayLabels')) {
                        return match;
                    }
                    const resolved = path.resolve(path.dirname(fullPath), specifier);
                    if (fs.existsSync(`${resolved}.js`)) {
                        return `${prefix}${specifier}.js${suffix}`;
                    }
                    if (fs.existsSync(path.join(resolved, 'index.js'))) {
                        return `${prefix}${specifier}/index.js${suffix}`;
                    }
                    return match;
                },
            );
            if (normalized !== source) {
                fs.writeFileSync(fullPath, normalized, 'utf8');
            }
        }
    }
}

export const browserSuites = {
    ai: 'tests/ai/conversationPerformance.browser.test.ts',
    files: 'tests/files/filesProduction.browser.test.ts',
    vnc: 'tests/vnc/vncViewer.browser.test.ts',
};
export const tests = [
    'tests/editor/performance.test.ts',
    'tests/ai/conversationPage.test.ts',
    'tests/files/fileDropLifecycle.test.ts',
    'tests/plugins/workerRequests.test.ts',
    'tests/vault/refresh.test.ts',
    'tests/vault/credentialReferences.test.ts',
    'tests/connections/hostInventoryAccount.test.ts',
    'tests/dashboard/dashboardMetrics.test.ts',
    'tests/dashboard/dashboardDetails.test.ts',
    'tests/dashboard/dashboardMetadata.test.ts',
    'tests/securityAssessment.test.ts',
    'tests/securityPanelRetry.test.mjs',
    'tests/tunnels/userTunnelActions.test.ts',
    'tests/tunnelConnectionLifecycle.test.ts',
    'tests/featureConnectionWorkspace.test.mjs',
    'tests/vaultSshCertificate.test.ts',
    'tests/connectionOptions.test.ts',
    'tests/networkInterface.test.ts',
    'tests/terminalLifecycleOwnership.test.mjs',
    'tests/reconnectPaneFocus.test.mjs',
    'tests/changedFunctionDocs.test.mjs',
    'tests/tooling/testLanguagePolicy.test.ts',
    'tests/tooling/agentTestRunner.test.ts',
    'tests/tooling/gitHooks.test.ts',
    'tests/terminalOutputFlow.test.mjs',
    'tests/terminalRendererLifecycle.test.mjs',
    'tests/ghost/ghostCwdSafety.test.ts',
    'tests/ghost/ghostInputBudget.test.ts',
    'tests/ghostPromptSafety.test.mjs',
    'tests/files/folderSizes.test.ts',
    'tests/files/filePermissions.test.ts',
    'tests/files/editorSaveAccess.test.ts',
    'tests/files/fileDestinationReservations.test.ts',
    'tests/files/fileActivationFocus.test.ts',
    'tests/files/transferState.test.ts',
    'tests/files/transferOperations.test.ts',
    'tests/files/fileSystemRefresh.test.ts',
    'tests/layoutMotion.test.mjs',
    'tests/files/filePanelLayout.test.ts',
    'tests/files/fileViewportAnchor.test.ts',
    'tests/uiControls.test.mjs',
    'tests/files/fileBreadcrumbLayout.test.ts',
    'tests/files/fileSelectionSummary.test.ts',
    'tests/files/fileFolderOptions.test.ts',
    'tests/files/filePathCompletion.test.ts',
    'tests/uiSurfaces.test.mjs',
    'tests/uiLayoutPrimitives.test.mjs',
    'tests/sidebarControls.test.mjs',
    'tests/uiSwitch.test.mjs',
    'tests/settingsNavigation.test.mjs',
    'tests/settingsOrganization.test.mjs',
    'tests/appearanceTypographyControls.test.mjs',
    'tests/elementColors.test.mjs',
    'tests/themeDocument.test.mjs',
    'tests/appearance/themeSelection.test.ts',
    'tests/themeReviewFixes.test.mjs',
    'tests/themeFiles.test.mjs',
    'tests/themeKeyReference.test.mjs',
    'tests/chromeActions.test.mjs',
    'tests/workspace/chromeActionRendering.test.ts',
    'tests/elementColorPresentation.test.mjs',
    'tests/elementColorPreview.test.mjs',
    'tests/elementColorEditor.test.mjs',
    'tests/colorPicker.test.mjs',
    'tests/settingsControlIntegration.test.mjs',
    'tests/terminalIdlePtyPolicy.test.mjs',
    'tests/workspace/workspacePresentation.test.ts',
    'tests/workspaceRegistrations.test.mjs',
    'tests/workspaceArchitecture.test.mjs',
    'tests/contentPresentation.test.mjs',
    'tests/combinedTabPresentation.test.mjs',
    'tests/workspace/workspaceContentLifecycle.test.ts',
    'tests/workspaceContents.test.mjs',
    'tests/featurePaneNavigation.test.mjs',
    'tests/workspaceVisibility.test.mjs',
    'tests/workspaceVisibilityComposition.test.mjs',
    'tests/workspaceCommands.test.mjs',
    'tests/workspaceNavigation.test.mjs',
    'tests/customizationSettingsStorage.test.mjs',
    'tests/workspaceDocking.test.mjs',
    'tests/workspaceDockingProjection.test.mjs',
    'tests/workspaceSplitControls.test.mjs',
    'tests/workspaceDockingActions.test.mjs',
    'tests/workspaceRegionResize.test.mjs',
    'tests/workspaceRegionDropPointer.test.mjs',
    'tests/tabDrag.test.mjs',
    'tests/workspaceShortcutActions.test.mjs',
    'tests/workspace/mainTabPresentation.test.ts',
    'tests/paneHeader.test.mjs',
    'tests/displayAliasDialog.test.mjs',
    'tests/workspaceTabList.test.mjs',
    'tests/workspaceTabAppearance.test.mjs',
    'tests/sessionRestore.test.mjs',
    'tests/workspaceStartup.test.mjs',
    'tests/pluginPaneClose.test.mjs',
    'tests/paneSurfaces.test.mjs',
    'tests/paneRegions.test.mjs',
    'tests/pluginFallbacks.test.mjs',
    'tests/pluginPaneFocus.test.mjs',
    'tests/paneDropClick.test.mjs',
    'tests/ai/agentRunStore.test.ts',
    'tests/ai/agentStreamRuntime.test.ts',
    'tests/aiSidebarResize.test.mjs',
    'tests/codeMirrorHelpers.test.mjs',
    'tests/cspStyleNonce.test.mjs',
    'tests/terminalDocument.test.mjs',
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
    'tests/editorPluginSaveState.test.mjs',
    'tests/editorStatusReport.test.mjs',
    'tests/plainDocumentState.test.mjs',
    'tests/paneCloseBlockers.test.mjs',
    'tests/workspace/paneCloseEditorGuard.test.ts',
    'tests/files/editorReadPolicy.test.ts',
    'tests/files/fileManagerDisconnectedSave.test.ts',
    'tests/files/fileManagerEditorIdentity.test.ts',
    'tests/plugins/pluginPanelSshConfirmation.test.ts',
    'tests/pluginCommandBridge.test.mjs',
    'tests/pluginShortcuts.test.mjs',
    'tests/pluginManifestTypes.test.mjs',
    'tests/pluginIconPath.test.mjs',
    'tests/plugins/pluginPaneRetention.test.ts',
    'tests/pluginDeveloperMode.test.mjs',
    'tests/pluginManagementController.test.mjs',
    'tests/pluginBrokerBoundary.test.mjs',
    'tests/pluginSshCommand.test.mjs',
    'tests/pluginTerminalFoundation.test.mjs',
    'tests/pluginTerminalIntegration.test.mjs',
    'tests/pluginPermissionDiff.test.mjs',
    'tests/pluginPaneMessages.test.mjs',
    'tests/pluginPaneBindingQueue.test.mjs',
    'tests/pluginMessageRateLimiter.test.mjs',
    'tests/pluginMessageEnvelope.test.mjs',
    'tests/pluginReloadQueue.test.mjs',
    'tests/plugins/pluginRecoveryStartup.test.ts',
    'tests/pluginOptionalPermission.test.mjs',
    'tests/shellDiscoveryGate.test.mjs',
    'tests/pluginRuntimeSupervisor.test.mjs',
    'tests/pluginAutoRollback.test.mjs',
    'tests/pluginSigningTool.test.mjs',
    'tests/pluginRegistrySigningTool.test.mjs',
    'tests/pluginMarketplaceReleases.test.mjs',
    'tests/pluginRegistryReleaseCheck.test.mjs',
    'tests/pluginSdkValidator.test.mjs',
    'tests/uiConfirmQueue.test.mjs',
    'tests/keyPassphraseRuntime.test.mjs',
    'tests/connectionService.test.mjs',
    'tests/connectionTabService.test.mjs',
    'tests/ghostSuggestionsHelpers.test.mjs',
    'tests/terminalOutputStream.test.mjs',
    'tests/fileDropToTerminal.test.mjs',
    'tests/files/fileGridLayout.test.ts',
    'tests/files/fileListPresentation.test.ts',
    'tests/files/fileMarquee.test.ts',
    'tests/files/filePathNav.test.ts',
    'tests/files/filePathAbsolute.test.ts',
    'tests/files/fileVolumes.test.ts',
    'tests/themedIconSrc.test.mjs',
    'tests/materialIconTheme.test.mjs',
    'tests/iconThemeRegistry.test.mjs',
    'tests/files/fileSearchFilter.test.ts',
    'tests/files/fileSystemBrowsingContracts.test.ts',
    'tests/errorBoundary.test.mjs',
    'tests/releaseNotesMarkdown.test.mjs',
    'tests/tooling/tauriAssetScope.test.ts',
    'tests/providerCatalog.test.mjs',
    'tests/quickConnectParsing.test.mjs',
    'tests/quickConnectSubcomponents.test.mjs',
    'tests/redactContext.test.mjs',
    'tests/requestContext.test.mjs',
    'tests/sessionPersistence.test.mjs',
    'tests/usageQueue.test.mjs',
    'tests/usageFlush.test.mjs',
    'tests/usageSession.test.mjs',
    'tests/featureTabInventory.test.mjs',
    'tests/paneLayout.test.mjs',
    'tests/paneLayoutVisibility.test.mjs',
    'tests/workspace/dockInSplit.self.test.ts',
    'tests/workspace/workspaceOpenItems.test.ts',
    'tests/workspace/transportPanePlacement.test.ts',
    'tests/vnc/vncProfiles.test.ts',
    'tests/serial/serialSession.test.ts',
    'tests/serial/serialProfiles.test.ts',
    'tests/openHerePaths.test.mjs',
    'tests/appAddItems.test.mjs',
    'tests/shellExit.test.mjs',
    'tests/shortcuts.test.mjs',
    'tests/shortcutRouting.test.mjs',
    'tests/shortcutBindings.test.mjs',
    'tests/shortcutUpgradeCompatibility.test.mjs',
    'tests/terminalInteraction.test.mjs',
    'tests/terminalMouse.test.mjs',
    'tests/terminalShellContext.test.mjs',
    'tests/terminalImage.test.mjs',
    'tests/terminalRendererPolicy.test.mjs',
    'tests/terminalWebglCapability.test.mjs',
    'tests/terminalRendererSession.test.mjs',
    'tests/terminalRendererController.test.mjs',
    'tests/terminalRendererDiagnostics.test.mjs',
    'tests/terminal/terminalRendererSetup.test.ts',
    'tests/terminal/terminalInputPipeline.test.ts',
    'tests/terminalInputQueue.test.mjs',
    'tests/terminalPtyLifecycle.test.mjs',
    'tests/terminalPtyKeyTranslations.test.mjs',
    'tests/terminalSpawnErrors.test.mjs',
    'tests/terminalReconnectFlow.test.mjs',
    'tests/terminalSpawnContext.test.mjs',
    'tests/terminalLazyPty.test.mjs',
    'tests/terminalIdlePty.test.mjs',
    'tests/terminalIdleHostSuspend.test.mjs',
    'tests/terminalActivity.test.mjs',
    'tests/terminalLifecycleListeners.test.mjs',
    'tests/terminalIdleSuspendNotice.test.mjs',
    'tests/terminalXtermOptions.test.mjs',
    'tests/terminalTabClose.test.mjs',
    'tests/terminalScrollbackPreserve.test.mjs',
    'tests/terminalConnectionWakeup.test.mjs',
    'tests/terminal/terminalLifecycleIntegration.test.ts',
    'tests/terminalOutputPayload.test.mjs',
    'tests/terminalPanelRestore.test.mjs',
    'tests/terminal/terminalResizeSync.test.ts',
    'tests/terminalFit.test.mjs',
    'tests/terminalReconnectReset.test.mjs',
    'tests/sidebarSubmit.test.mjs',
    'tests/statusBarLatency.test.mjs',
    'tests/surveyEligibility.test.mjs',
    'tests/feedbackInboxProtocol.test.mjs',
    'tests/visibleReplyReceipts.test.mjs',
    'tests/tunnelAutoStartService.test.mjs',
    'tests/tunnelReconnectService.test.mjs',
    'tests/tunnelIpcArguments.test.mjs',
    'tests/syncPassphrase.test.mjs',
    'tests/connectionsRestore.test.mjs',
    'tests/vaultUnlockPrompt.test.mjs',
    'tests/updateNotificationAutoUpdateFlow.test.mjs',
    'tests/updaterFlow.test.mjs',
];

/** Compile once before executing source-registered suites, including direct CLI invocation. */
export function runAgentTests(arguments_ = process.argv.slice(2), spawn = spawnSync) {
    const [feature, ...testArguments] = arguments_;
    const browserRun = Object.hasOwn(browserSuites, feature) && testArguments[0] === '--browser';
    if (
        (feature && !['ai', 'files', 'ghost', 'terminal'].includes(feature) && !browserRun) ||
        (testArguments.length > 0 && !browserRun)
    ) {
        console.error(
            'Usage: node tests/runAllAgentTests.mjs [ai [--browser] | files [--browser [browser flags]] | ghost | terminal | vnc --browser]',
        );
        return 1;
    }
    const build = readTestBuild();
    const require = createRequire(import.meta.url);
    const compilation = spawn(
        process.execPath,
        [require.resolve('typescript/bin/tsc'), '-p', build.configFile],
        { stdio: 'inherit' },
    );
    if (compilation.status !== 0) {
        return compilation.status ?? 1;
    }
    normalizeEmittedImports(build.outputDirectory);
    const selectedTests = browserRun
        ? [browserSuites[feature]]
        : feature === 'ai'
          ? tests.filter((file) => file.startsWith('tests/ai/'))
          : feature === 'files'
            ? tests.filter((file) => file.startsWith('tests/files/'))
            : feature === 'ghost'
              ? tests.filter(
                    (file) =>
                        file.startsWith('tests/ghost/') ||
                        file === 'tests/ghostSuggestionsHelpers.test.mjs' ||
                        file === 'tests/ghostPromptSafety.test.mjs' ||
                        file === 'tests/terminalShellContext.test.mjs',
                )
              : feature === 'terminal'
                ? tests.filter(
                      (file) =>
                          file.startsWith('tests/terminal') || file.startsWith('tests/serial/'),
                  )
                : tests;
    for (const source of selectedTests) {
        const file = build.resolveTestFile(source);
        const legacyTerminal = source.startsWith('tests/terminal') && /\.[cm]?js$/.test(source);
        const args = legacyTerminal
            ? [
                  '--input-type=module',
                  '--eval',
                  `globalThis.window={ipcRenderer:{invoke:async()=>undefined,send:()=>{},on:()=>()=>{}},dispatchEvent:()=>true};globalThis.document={body:{getAttribute:()=> 'dark'}};await import(${JSON.stringify(pathToFileURL(file).href)})`,
              ]
            : [file, ...(browserRun ? testArguments.slice(1) : [])];
        const result = spawn(process.execPath, args, { stdio: 'inherit' });
        if (result.status !== 0) {
            return result.status ?? 1;
        }
    }
    return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        process.exitCode = runAgentTests();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
