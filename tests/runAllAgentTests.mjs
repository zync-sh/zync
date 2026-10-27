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

const [feature, ...testArguments] = process.argv.slice(2);
const browserRun = feature === 'files' && testArguments[0] === '--browser';
if ((feature && feature !== 'files') || (testArguments.length > 0 && !browserRun)) {
    console.error('Usage: node tests/runAllAgentTests.mjs [files [--browser [browser flags]]]');
    process.exit(1);
}

normalizeEmittedImports(path.resolve('.tmp-agent-tests'));

const tests = [
    '.tmp-agent-tests/tests/securityAssessment.test.js',
    'tests/securityPanelRetry.test.mjs',
    '.tmp-agent-tests/tests/userTunnelActions.test.js',
    '.tmp-agent-tests/tests/tunnelConnectionLifecycle.test.js',
    'tests/featureConnectionWorkspace.test.mjs',
    '.tmp-agent-tests/tests/vaultSshCertificate.test.js',
    '.tmp-agent-tests/tests/connectionOptions.test.js',
    '.tmp-agent-tests/tests/networkInterface.test.js',
    'tests/terminalLifecycleOwnership.test.mjs',
    'tests/reconnectPaneFocus.test.mjs',
    'tests/changedFunctionDocs.test.mjs',
    '.tmp-agent-tests/tests/tooling/testLanguagePolicy.test.js',
    '.tmp-agent-tests/tests/tooling/gitHooks.test.js',
    'tests/terminalOutputFlow.test.mjs',
    'tests/terminalRendererLifecycle.test.mjs',
    'tests/ghostCwdSafety.test.mjs',
    'tests/ghostPromptSafety.test.mjs',
    '.tmp-agent-tests/tests/files/folderSizes.test.js',
    '.tmp-agent-tests/tests/files/filePermissions.test.js',
    '.tmp-agent-tests/tests/files/editorSaveAccess.test.js',
    '.tmp-agent-tests/tests/files/fileDestinationReservations.test.js',
    '.tmp-agent-tests/tests/files/fileActivationFocus.test.js',
    '.tmp-agent-tests/tests/files/transferState.test.js',
    '.tmp-agent-tests/tests/files/transferOperations.test.js',
    '.tmp-agent-tests/tests/files/fileSystemRefresh.test.js',
    'tests/layoutMotion.test.mjs',
    '.tmp-agent-tests/tests/files/filePanelLayout.test.js',
    '.tmp-agent-tests/tests/files/fileViewportAnchor.test.js',
    'tests/uiControls.test.mjs',
    '.tmp-agent-tests/tests/files/fileBreadcrumbLayout.test.js',
    '.tmp-agent-tests/tests/files/fileSelectionSummary.test.js',
    '.tmp-agent-tests/tests/files/fileFolderOptions.test.js',
    '.tmp-agent-tests/tests/files/filePathCompletion.test.js',
    'tests/uiSurfaces.test.mjs',
    'tests/uiLayoutPrimitives.test.mjs',
    'tests/sidebarControls.test.mjs',
    'tests/uiSwitch.test.mjs',
    'tests/settingsNavigation.test.mjs',
    'tests/settingsOrganization.test.mjs',
    'tests/appearanceTypographyControls.test.mjs',
    'tests/elementColors.test.mjs',
    'tests/themeDocument.test.mjs',
    'tests/themeReviewFixes.test.mjs',
    'tests/themeFiles.test.mjs',
    'tests/themeKeyReference.test.mjs',
    'tests/chromeActions.test.mjs',
    'tests/chromeActionRendering.test.mjs',
    'tests/elementColorPresentation.test.mjs',
    'tests/elementColorPreview.test.mjs',
    'tests/elementColorEditor.test.mjs',
    'tests/colorPicker.test.mjs',
    'tests/settingsControlIntegration.test.mjs',
    'tests/terminalIdlePtyPolicy.test.mjs',
    'tests/workspacePresentation.test.mjs',
    'tests/workspaceRegistrations.test.mjs',
    'tests/workspaceArchitecture.test.mjs',
    'tests/contentPresentation.test.mjs',
    'tests/combinedTabPresentation.test.mjs',
    '.tmp-agent-tests/tests/workspace/workspaceContentLifecycle.test.js',
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
    'tests/mainTabPresentation.test.mjs',
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
    'tests/agentRunStore.partialize.test.mjs',
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
    'tests/paneCloseEditorGuard.test.mjs',
    '.tmp-agent-tests/tests/files/editorReadPolicy.test.js',
    '.tmp-agent-tests/tests/files/fileManagerDisconnectedSave.test.js',
    '.tmp-agent-tests/tests/files/fileManagerEditorIdentity.test.js',
    'tests/pluginPanelSshConfirmation.test.mjs',
    'tests/pluginCommandBridge.test.mjs',
    'tests/pluginShortcuts.test.mjs',
    'tests/pluginManifestTypes.test.mjs',
    'tests/pluginIconPath.test.mjs',
    'tests/pluginPaneRetention.test.mjs',
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
    'tests/pluginRecoveryStartup.test.mjs',
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
    '.tmp-agent-tests/tests/files/fileGridLayout.test.js',
    '.tmp-agent-tests/tests/files/fileListPresentation.test.js',
    '.tmp-agent-tests/tests/files/fileMarquee.test.js',
    '.tmp-agent-tests/tests/files/filePathNav.test.js',
    '.tmp-agent-tests/tests/files/filePathAbsolute.test.js',
    '.tmp-agent-tests/tests/files/fileVolumes.test.js',
    'tests/themedIconSrc.test.mjs',
    'tests/materialIconTheme.test.mjs',
    'tests/iconThemeRegistry.test.mjs',
    '.tmp-agent-tests/tests/files/fileSearchFilter.test.js',
    '.tmp-agent-tests/tests/files/fileSystemBrowsingContracts.test.js',
    'tests/errorBoundary.test.mjs',
    'tests/releaseNotesMarkdown.test.mjs',
    'tests/tauriAssetScope.test.mjs',
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
    '.tmp-agent-tests/tests/workspace/dockInSplit.self.test.js',
    'tests/workspaceOpenItems.test.mjs',
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

const selectedTests = browserRun
    ? ['.tmp-agent-tests/tests/files/filesProduction.browser.test.js']
    : feature === 'files'
      ? tests.filter((file) => file.startsWith('.tmp-agent-tests/tests/files/'))
      : tests;

for (const file of selectedTests) {
    const args = file.startsWith('tests/terminal')
        ? [
              '--input-type=module',
              '--eval',
              `globalThis.window={ipcRenderer:{invoke:async()=>undefined,send:()=>{},on:()=>()=>{}},dispatchEvent:()=>true};await import(${JSON.stringify(pathToFileURL(path.resolve(file)).href)})`,
          ]
        : [file, ...(browserRun ? testArguments.slice(1) : [])];
    const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}
