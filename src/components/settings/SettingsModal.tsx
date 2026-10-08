import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useState, useEffect, useId, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { motion, useDragControls, useMotionValue } from 'framer-motion';
import { ZPortal } from '../ui/ZPortal';
import { IconButton } from '../ui/IconButton';
import { PanelHeader } from '../ui/PanelHeader';
import { useAppStore } from '../../store/useAppStore'; // Updated Import
import { usePlugins } from '../../context/PluginContext';

import { X, RefreshCw, FolderOpen, Package, GripHorizontal } from 'lucide-react';
import { ToastContainer } from '../ui/Toast';

import { buildEditorProviderOptions, CODEMIRROR_EDITOR_ID, formatEditorCapabilities } from '../editor/providers';
import { TerminalTab } from './tabs/TerminalTab';
import { AppearanceTab } from './tabs/AppearanceTab';
import { GeneralTab } from './tabs/GeneralTab';
import { FileManagerTab } from './tabs/FileManagerTab';
import { AiTab } from './tabs/AiTab';
import { ShortcutsTab } from './tabs/ShortcutsTab';
import { PluginsTab } from './tabs/PluginsTab';
import { AboutTab } from './tabs/AboutTab';
import { StatusBarTab } from './tabs/StatusBarTab';
import { FeedbackTab } from './tabs/FeedbackTab';
import { IconResolver } from './common/IconResolver';
import { SettingsNavigation, settingsPanelId, settingsTabId, type SettingsSection as Tab } from './SettingsNavigation';
import { TiltLogo } from './common/TiltLogo';
import { useSettingsPaths } from './hooks/useSettingsPaths';
import { useSettingsUpdateFlow } from './hooks/useSettingsUpdateFlow';
import { useSettingsPlugins } from './hooks/useSettingsPlugins';
import { useAboutStats } from './hooks/useAboutStats';
import { PluginTabContentSwitch } from './tabs/plugins/PluginTabContentSwitch';
import { PluginsInstalledTab } from './tabs/plugins/PluginsInstalledTab';
import { PluginsMarketplaceTab } from './tabs/plugins/PluginsMarketplaceTab';
import { PluginPermissionReview, PluginsDeveloperTab, type LocalInstallAction } from './tabs/plugins/PluginsDeveloperTab';
import { useVaultStore } from '../../vault/useVaultStore';


interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

const BUILTIN_ICON_THEME_COUNT = 2; // VSCode Icons + Lucide
const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'textarea:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    '[tabindex]',
].map(selector => `${selector}:not([tabindex="-1"])`).join(',');
const DRAG_BLOCK_SELECTOR = 'button, a, input, textarea, select, [role="button"], [data-no-modal-drag="true"]';

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
    const titleId = useId();
    const restartConfirmTitleId = useId();
    const dialogRef = useRef<HTMLDivElement>(null);
    const settingsContentRef = useRef<HTMLDivElement>(null);
    const restartConfirmRef = useRef<HTMLDivElement>(null);
    const restartCancelRef = useRef<HTMLButtonElement>(null);
    const restartConfirmOpenerRef = useRef<HTMLElement | null>(null);
    const dragConstraintsRef = useRef<HTMLDivElement>(null);
    const dragControls = useDragControls();
    const x = useMotionValue(0);
    const y = useMotionValue(0);
    const requestVaultUnlock = useVaultStore(state => state.requestUnlock);
    const settings = useAppStore(state => state.settings);
    const settingsFocusTab = useAppStore(state => state.settingsFocusTab);
    const clearSettingsFocusTab = useAppStore(state => state.clearSettingsFocusTab);
    const updateSettings = useAppStore(state => state.updateSettings);
    const updateAiSettings = useAppStore(state => state.updateAiSettings);
    const updateTerminalSettings = useAppStore(state => state.updateTerminalSettings);
    const updateFileManagerSettings = useAppStore(state => state.updateFileManagerSettings);
    const updateStatusBarSettings = useAppStore(state => state.updateStatusBarSettings);
    const updateLocalTermSettings = useAppStore(state => state.updateLocalTermSettings);
    const updateKeybindings = useAppStore(state => state.updateKeybindings);
    const updateGhostSuggestionsSettings = useAppStore(state => state.updateGhostSuggestionsSettings);
    const openSettingsJsonTab = useAppStore(state => state.openSettingsJsonTab);
    const showToast = useAppStore(state => state.showToast);

    const toastSettingsError = (label: string, error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        showToast('error', `Failed to save ${label}: ${message}`);
    };

    const safeUpdateSettings = async (updates: Parameters<typeof updateSettings>[0]) => {
        try {
            await updateSettings(updates);
        } catch (error) {
            // Toast only — do not rethrow (GeneralTab handlers have no .catch).
            toastSettingsError('settings', error);
        }
    };

    const safeUpdateTerminalSettings = async (updates: Parameters<typeof updateTerminalSettings>[0]) => {
        try {
            await updateTerminalSettings(updates);
        } catch (error) {
            toastSettingsError('terminal settings', error);
        }
    };

    const safeUpdateLocalTermSettings = async (updates: Parameters<typeof updateLocalTermSettings>[0]) => {
        try {
            await updateLocalTermSettings(updates);
        } catch (error) {
            toastSettingsError('local shell settings', error);
        }
    };


    // Use the store action so merges happen against current state, not the render snapshot.
    const setGhostSuggestionsField = (patch: Partial<typeof settings.ghostSuggestions>) => {
        updateGhostSuggestionsSettings(patch).catch((error: unknown) => {
            toastSettingsError('ghost suggestion settings', error);
        });
    };

    const setGhostProviderField = (patch: Partial<typeof settings.ghostSuggestions.providers>) => {
        // The reducer merges patch into current.providers, so a partial patch is safe.
        updateGhostSuggestionsSettings({ providers: patch as typeof settings.ghostSuggestions.providers }).catch(
            (error: unknown) => {
                toastSettingsError('ghost suggestion settings', error);
            },
        );
    };

    const handlePickDefaultDownloadPath = async () => {
        try {
            const selected = await open({
                multiple: false,
                directory: true,
                defaultPath: settings.fileManager.defaultDownloadPath || undefined,
            });
            if (!selected) return;
            const folder = Array.isArray(selected) ? selected[0] : selected;
            if (!folder) return;
            await updateFileManagerSettings({ defaultDownloadPath: folder });
            showToast('success', 'Default download folder updated');
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            showToast('error', `Failed to select folder: ${message}`);
        }
    };

    const [activeTab, setActiveTab] = useState<Tab>('terminal');
    const [appearanceView, setAppearanceView] = useState<'app' | 'terminal'>('app');
    const [pluginTab, setPluginTab] = useState<'installed' | 'marketplace' | 'developer'>('installed');
    const [isTransitioning, setIsTransitioning] = useState(false);
    const [wslDistros, setWslDistros] = useState<string[]>([]);

    // Deep-link from chat / command palette: open Settings already focused on a tab.
    useEffect(() => {
        if (!isOpen || !settingsFocusTab) return;
        setActiveTab(settingsFocusTab);
        clearSettingsFocusTab();
    }, [isOpen, settingsFocusTab, clearSettingsFocusTab]);

    useEffect(() => {
        if (!isOpen) return;
        x.set(0);
        y.set(0);

        const previouslyFocused = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        const frame = window.requestAnimationFrame(() => {
            const dialog = dialogRef.current;
            const firstFocusable = dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
            (firstFocusable ?? dialog)?.focus();
        });

        return () => {
            window.cancelAnimationFrame(frame);
            previouslyFocused?.focus();
        };
    }, [isOpen, x, y]);

    // Global Update State
    const updateStatus = useAppStore(state => state.updateStatus);
    const updateInfo = useAppStore(state => state.updateInfo);
    const setUpdateStatus = useAppStore(state => state.setUpdateStatus);
    const setUpdateInfo = useAppStore(state => state.setUpdateInfo);
    const openReleaseNotesTab = useAppStore(state => state.openReleaseNotesTab);

    const [apiKeyDraft, setApiKeyDraft] = useState('');
    const [apiKeyPersistedValue, setApiKeyPersistedValue] = useState('');
    const [apiKeySaved, setApiKeySaved] = useState(false);
    const [apiKeyError, setApiKeyError] = useState<string | null>(null);
    const [terminalFontDraft, setTerminalFontDraft] = useState('');
    const [globalFontDraft, setGlobalFontDraft] = useState('');
    const saveApiKey = async (provider: string, key: string) => {
        if (provider === 'ollama') return;
        
        try {
            setApiKeyError(null);
            if (!(await requestVaultUnlock())) {
                throw new Error('Vault must be unlocked to save API keys.');
            }
            await invoke('save_secret', { key: provider, value: key });
            setApiKeyPersistedValue(key.trim());
            setApiKeySaved(true);
            setTimeout(() => setApiKeySaved(false), 2000);
        } catch (err: unknown) {
            console.error('Failed to save API key:', err);
            const message = err instanceof Error ? err.message : String(err);
            setApiKeyError(message);
            setApiKeySaved(false);
        }
    };

    const {
        executeCommand,
        editorProviders,
        reloadPlugins,
        retryPluginRuntime,
        runtimeHealth,
    } = usePlugins();
    const showConfirmDialog = useAppStore(state => state.showConfirmDialog);
    const isWindows = window.navigator.userAgent.indexOf('Windows') !== -1;

    const {
        currentDataPath,
        isDefaultDataPath,
        currentLogPath,
        isDefaultLogPath,
        autoUpdateCheck,
        handleChangeLocation,
        handleResetLocation,
        handleChangeLogLocation,
        handleResetLogLocation,
        handleToggleAutoUpdate,
    } = useSettingsPaths({ isOpen });

    const {
        appVersion,
        showRestartConfirm,
        setShowRestartConfirm,
        platformLabel,
        downloadProgress,
        handleUpdateAction,
        handleConfirmRestart,
    } = useSettingsUpdateFlow({
        isOpen,
        isWindows,
        updateStatus,
        updateInfo,
        setUpdateStatus,
        setUpdateInfo,
        showToast,
    });

    const {
        plugins,
        isLoadingPlugins,
        registry,
        selectedRegistry,
        betaPluginIds,
        handleSetPluginBeta,
        isLoadingRegistry,
        activeMenu,
        setActiveMenu,
        processingId,
        needsRestart,
        localPluginInstallMode,
        pluginDeveloperMode,
        isUpdatingDeveloperMode,
        pendingPluginInspection,
        isApprovingLocalPlugin,
        handleInstallLocalPlugin,
        handleSetPluginDeveloperMode,
        handleApproveLocalPlugin,
        handleCancelLocalPluginReview,
        handleTogglePlugin,
        handleUninstallPlugin,
        handleUpdatePlugin,
        handleInspectMarketplacePlugin,
        handleSetOptionalPluginPermissions,
        handleClearPluginData,
        handleRollbackPlugin,
    } = useSettingsPlugins({
        isOpen,
        activeTab,
        showToast,
        showConfirmDialog,
        reloadPluginRuntime: reloadPlugins,
    });

    const { contributors, stars } = useAboutStats({ isOpen, activeTab });

    const editorProviderOptions = useMemo(() => buildEditorProviderOptions(editorProviders), [editorProviders]);
    const activeEditorProvider = useMemo(() => {
        const selectedId = settings.editor?.defaultProvider;
        return editorProviders.find((provider) => provider.manifest.id === selectedId) ?? null;
    }, [editorProviders, settings.editor?.defaultProvider]);
    const activeEditorCapabilitySummary = useMemo(
        () => formatEditorCapabilities(activeEditorProvider?.manifest.editor?.supports, 5),
        [activeEditorProvider?.manifest.editor?.supports]
    );

    const localInstallActions: LocalInstallAction[] = [
        {
            mode: 'zip' as const,
            label: 'Install ZIP package',
            title: 'Load packaged plugin build',
            description: 'Pick a local .zip to validate marketplace-ready packages before release.',
            hint: 'Archive should include manifest.json at package root.',
            icon: Package,
        },
        {
            mode: 'folder' as const,
            label: 'Install from folder',
            title: 'Load unpacked plugin directory',
            description: 'Use this during active editor-provider or theme development without zipping every build.',
            hint: 'Folder should contain manifest.json and dist/assets if used.',
            icon: FolderOpen,
        },
    ];

    // Sync apiKeyDraft when provider changes or tab opens
    const currentProvider = settings.ai?.provider || 'ollama';
    useEffect(() => {
        if (activeTab !== 'ai') return;
        if (currentProvider === 'ollama') {
            setApiKeyDraft('');
            setApiKeyPersistedValue('');
            setApiKeySaved(false);
            return;
        }

        void (async () => {
            if (!(await requestVaultUnlock())) return;
            const key = await invoke<string | null>('get_secret', { key: currentProvider });
            const loadedKey = key || '';
            setApiKeyDraft(loadedKey);
            setApiKeyPersistedValue(loadedKey.trim());
            setApiKeySaved(false);
        })().catch(err => console.error('Failed to load secret:', err));
    }, [currentProvider, activeTab, requestVaultUnlock]);

    useEffect(() => {
        setTerminalFontDraft(settings.terminal.fontFamily || '');
    }, [settings.terminal.fontFamily]);

    useEffect(() => {
        setGlobalFontDraft(settings.globalFontFamily || '');
    }, [settings.globalFontFamily]);

    // 3D Tilt State Removed - Moved to TiltLogo component

    useEffect(() => {
        if (isOpen && isWindows) {
            window.ipcRenderer.invoke('shell:getWslDistros').then((distros: string[]) => {
                setWslDistros(distros);
            }).catch(err => console.error('Failed to fetch WSL distros', err));
        }
    }, [isOpen, isWindows]);

    // Note: Update listeners moved to UpdateNotification.tsx (Global Store)

    // Modal dismissal only; section navigation is scoped to SettingsNavigation.
    useEffect(() => {
        if (!isOpen) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            const isEditableTarget = !!target && (
                target.tagName === 'INPUT' ||
                target.tagName === 'TEXTAREA' ||
                target.tagName === 'SELECT' ||
                target.isContentEditable
            );
            if (isEditableTarget) {
                return;
            }

            // Escape: dismiss restart confirm first; otherwise close Settings.
            if (e.key === 'Escape') {
                if (pendingPluginInspection) {
                    void handleCancelLocalPluginReview();
                    return;
                }
                if (showRestartConfirm) {
                    setShowRestartConfirm(false);
                    return;
                }
                onClose();
                return;
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [
        isOpen,
        onClose,
        showRestartConfirm,
        setShowRestartConfirm,
        pendingPluginInspection,
        handleCancelLocalPluginReview,
    ]);

    // Smooth Tab Transition Handler
    const handleTabChange = (newTab: Tab) => {
        if (newTab === activeTab) return;
        setIsTransitioning(true);
        setTimeout(() => {
            setActiveTab(newTab);
            setIsTransitioning(false);
        }, 150);
    };

    const openAppearance = (view: 'app' | 'terminal') => {
        setAppearanceView(view);
        if (activeTab !== 'appearance') {
            handleTabChange('appearance');
        }
    };

    const renderPluginInstalled = () => (
        <PluginsInstalledTab
            plugins={plugins}
            runtimeHealth={runtimeHealth}
            registry={selectedRegistry}
            isLoadingPlugins={isLoadingPlugins}
            processingId={processingId}
            activeMenu={activeMenu}
            setActiveMenu={setActiveMenu}
            executeCommand={executeCommand}
            onClose={onClose}
            onTogglePlugin={handleTogglePlugin}
            onUpdatePlugin={handleUpdatePlugin}
            onUninstallPlugin={handleUninstallPlugin}
            onRetryPluginRuntime={retryPluginRuntime}
            onSaveOptionalPermissions={handleSetOptionalPluginPermissions}
            onClearPluginData={handleClearPluginData}
            onRollbackPlugin={handleRollbackPlugin}
            iconThemeCount={BUILTIN_ICON_THEME_COUNT + plugins.filter((plugin) => plugin.manifest.type === 'icon-theme').length}
            iconRenderer={IconResolver}
        />
    );

    const renderPluginMarketplace = () => (
        <PluginsMarketplaceTab
            isLoadingRegistry={isLoadingRegistry}
            registry={registry}
            selectedRegistry={selectedRegistry}
            betaPluginIds={betaPluginIds}
            onSetPluginBeta={handleSetPluginBeta}
            onInspectPlugin={handleInspectMarketplacePlugin}
        />
    );

    const renderPluginDeveloper = () => (
        <PluginsDeveloperTab
            localInstallActions={localInstallActions}
            localPluginInstallMode={localPluginInstallMode}
            developerMode={pluginDeveloperMode}
            isUpdatingDeveloperMode={isUpdatingDeveloperMode}
            onSetDeveloperMode={handleSetPluginDeveloperMode}
            onInstallLocalPlugin={handleInstallLocalPlugin}
        />
    );


    const handleClearConnections = async () => {
        const confirmed = await showConfirmDialog({
            title: "Clear Connections",
            message: "Are you sure you want to clear all connections? This cannot be undone.",
            confirmText: "Clear ALL",
            variant: "danger"
        });

        if (confirmed) {
            useAppStore.getState().clearConnections();
            showToast(
                'info',
                'Local connections cleared. Provider host list was also cleared for this session — refresh under All Hosts to load Google hosts again.',
            );
        }
    };
    const handleDragHandlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
        if (event.button !== 0) return;
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (target?.closest(DRAG_BLOCK_SELECTOR)) return;
        dragControls.start(event.nativeEvent);
    };
    useEffect(() => {
        if (!showRestartConfirm) return;

        const opener = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        restartConfirmOpenerRef.current = opener;

        const frame = window.requestAnimationFrame(() => {
            restartCancelRef.current?.focus();
        });

        return () => {
            window.cancelAnimationFrame(frame);
            const restoreTarget = restartConfirmOpenerRef.current;
            restartConfirmOpenerRef.current = null;
            if (restoreTarget && document.contains(restoreTarget)) {
                restoreTarget.focus();
            }
        };
    }, [showRestartConfirm]);

    const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (showRestartConfirm) {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setShowRestartConfirm(false);
                return;
            }
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault();
                event.stopPropagation();
                return;
            }
        }

        if (event.key !== 'Tab') return;

        const root = showRestartConfirm
            ? restartConfirmRef.current
            : dialogRef.current;
        if (!root) return;

        const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
            .filter((element) => element.offsetParent !== null);

        if (focusable.length === 0) {
            event.preventDefault();
            root.focus();
            return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;

        if (event.shiftKey && active === first) {
            event.preventDefault();
            last.focus();
            return;
        }

        if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
        }
    };

    if (!isOpen) return null;

    return (
        <ZPortal className="absolute inset-0 z-[9999] bg-black/40 animate-in fade-in duration-200">
            <div ref={dragConstraintsRef} className="absolute inset-0 flex items-center justify-center p-4">
                <motion.div
                    ref={dialogRef}
                    drag
                    dragControls={dragControls}
                    dragListener={false}
                    dragConstraints={dragConstraintsRef}
                    dragElastic={0}
                    dragMomentum={false}
                    style={{ x, y }}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={titleId}
                    tabIndex={-1}
                    onKeyDown={handleDialogKeyDown}
                    className="relative w-[860px] h-[620px] max-w-[95vw] max-h-[90vh] bg-[var(--color-app-bg)] rounded-xl border border-[var(--color-app-border)] shadow-2xl flex overflow-hidden animate-in zoom-in-95 duration-200 ring-1 ring-white/5"
                >
                <div
                    ref={settingsContentRef}
                    className="flex flex-1 min-w-0 min-h-0 overflow-hidden"
                    inert={showRestartConfirm || undefined}
                >

                {/* Sidebar */}
                <SettingsNavigation idPrefix={titleId} activeTab={activeTab} onTabChange={handleTabChange}
                    onOpenJson={() => { openSettingsJsonTab(); onClose(); }}
                    aboutBadge={updateStatus === 'available' || updateStatus === 'downloading' || updateStatus === 'ready'}
                    aboutBadgeLabel={updateStatus === 'available' ? 'Update available'
                        : updateStatus === 'downloading' ? 'Update downloading'
                            : updateStatus === 'ready' ? 'Update ready to install' : 'New notifications'} />

                {/* Content Area */}
                <div className="flex-1 flex flex-col min-w-0 bg-[var(--color-app-bg)]">
                    {/* Header */}
                    <PanelHeader
                        className="border-app-border/30 cursor-move active:cursor-grabbing select-none"
                        onPointerDown={handleDragHandlePointerDown}
                        titleId={titleId}
                        title={activeTab === 'fileManager'
                                ? 'File Manager'
                                : activeTab === 'statusBar'
                                    ? 'Status Bar'
                                : activeTab === 'ai'
                                    ? 'AI Assistant'
                                : activeTab === 'feedback'
                                    ? 'Feedback'
                                : activeTab.charAt(0).toUpperCase() + activeTab.slice(1)}
                        actions={<>
                            <GripHorizontal aria-hidden="true" className="mr-2 h-4 w-4 shrink-0 text-app-muted/45" />
                            <IconButton label="Close settings" icon={<X size={16} />} onClick={onClose} />
                        </>}
                    />

                    {/* Scrollable Content */}
                    <div role="tabpanel" id={settingsPanelId(titleId)} aria-labelledby={settingsTabId(titleId, activeTab)}
                        className={`flex-1 overflow-y-auto p-4 lg:p-5 space-y-6 transition-opacity duration-150 ${isTransitioning ? 'opacity-0' : 'opacity-100'}`}>

                        {activeTab === 'general' && (
                            <GeneralTab
                                settings={settings}
                                defaultEditorProvider={CODEMIRROR_EDITOR_ID}
                                autoUpdateCheck={autoUpdateCheck}
                                isWindows={isWindows}
                                isDefaultDataPath={isDefaultDataPath}
                                currentDataPath={currentDataPath}
                                isDefaultLogPath={isDefaultLogPath}
                                isDefaultDataPathForLogs={isDefaultDataPath}
                                currentLogPath={currentLogPath}
                                activeEditorCapabilitySummary={activeEditorCapabilitySummary}
                                activeEditorProvider={activeEditorProvider}
                                editorProviderOptions={editorProviderOptions}
                                onToggleAutoUpdate={handleToggleAutoUpdate}
                                onUpdateSettings={safeUpdateSettings}
                                onChangeLocation={handleChangeLocation}
                                onResetLocation={handleResetLocation}
                                onChangeLogLocation={handleChangeLogLocation}
                                onResetLogLocation={handleResetLogLocation}
                                onClearConnections={handleClearConnections}
                            />
                        )}

                        {activeTab === 'terminal' && (
                            <TerminalTab
                                settings={settings}
                                wslDistros={wslDistros}
                                isWindows={isWindows}
                                onOpenAppearanceTerminal={() => { openAppearance('terminal'); }}
                                onOpenAppearanceApp={() => { openAppearance('app'); }}
                                updateTerminalSettings={safeUpdateTerminalSettings}
                                updateLocalTermSettings={safeUpdateLocalTermSettings}
                                setGhostSuggestionsField={setGhostSuggestionsField}
                                setGhostProviderField={setGhostProviderField}
                            />
                        )}

                        {activeTab === 'statusBar' && (
                            <StatusBarTab
                                settings={settings}
                                updateStatusBarSettings={updateStatusBarSettings}
                            />
                        )}

                        {activeTab === 'appearance' && (
                            <AppearanceTab
                                settings={settings}
                                plugins={plugins}
                                globalFontDraft={globalFontDraft}
                                setGlobalFontDraft={setGlobalFontDraft}
                                terminalFontDraft={terminalFontDraft}
                                setTerminalFontDraft={setTerminalFontDraft}
                                isWindows={isWindows}
                                activeView={appearanceView}
                                onActiveViewChange={setAppearanceView}
                                updateSettings={safeUpdateSettings}
                                updateTerminalSettings={safeUpdateTerminalSettings}
                            />
                        )}

                        {activeTab === 'fileManager' && (
                            <FileManagerTab
                                settings={settings}
                                updateFileManagerSettings={updateFileManagerSettings}
                                onPickDefaultDownloadPath={handlePickDefaultDownloadPath}
                            />
                        )}

                        {activeTab === 'plugins' && (
                            <PluginsTab
                                pluginTab={pluginTab}
                                setPluginTab={setPluginTab}
                                needsRestart={needsRestart}
                                onRestartNow={() => window.location.reload()}
                                content={
                                    <PluginTabContentSwitch
                                        pluginTab={pluginTab}
                                        renderInstalled={renderPluginInstalled}
                                        renderMarketplace={renderPluginMarketplace}
                                        renderDeveloper={renderPluginDeveloper}
                                    />
                                }
                            />
                        )}

                        {activeTab === 'shortcuts' && (
                            <ShortcutsTab
                                settings={settings}
                                updateKeybindings={updateKeybindings}
                            />
                        )}



                        {activeTab === 'ai' && (
                            <AiTab
                                settings={settings}
                                apiKeyDraft={apiKeyDraft}
                                apiKeyPersistedValue={apiKeyPersistedValue}
                                apiKeySaved={apiKeySaved}
                                apiKeyError={apiKeyError}
                                setApiKeyDraft={setApiKeyDraft}
                                setApiKeyError={setApiKeyError}
                                updateAiSettings={updateAiSettings}
                                saveApiKey={saveApiKey}
                            />
                        )}

                        {activeTab === 'feedback' && (
                            <FeedbackTab />
                        )}

                        {activeTab === 'about' && (
                            <AboutTab
                                appVersion={appVersion}
                                platformLabel={platformLabel}
                                updateStatus={updateStatus}
                                updateInfo={updateInfo}
                                downloadProgress={downloadProgress}
                                stars={stars}
                                contributors={contributors}
                                onUpdateAction={handleUpdateAction}
                                onOpenReleaseNotes={() => {
                                    openReleaseNotesTab();
                                    onClose();
                                }}
                                openExternal={(url) => window.ipcRenderer.invoke('shell:open', url)}
                                hero={<TiltLogo />}
                            />
                        )}
                    </div>
                </div>
                </div>
                {/* Restart Confirmation Overlay */}
                {showRestartConfirm && (
                    <div
                        ref={restartConfirmRef}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby={restartConfirmTitleId}
                        tabIndex={-1}
                        className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 animate-in fade-in duration-200"
                    >
                        <div className="bg-[var(--color-app-bg)] rounded-xl border border-[var(--color-app-border)] shadow-2xl p-6 w-[320px] animate-in zoom-in-95 text-center">
                            <div className="w-12 h-12 rounded-full bg-[var(--color-app-accent)]/10 text-[var(--color-app-accent)] flex items-center justify-center mx-auto mb-4">
                                <RefreshCw size={24} />
                            </div>
                            <h3 id={restartConfirmTitleId} className="text-lg font-bold text-[var(--color-app-text)] mb-2">Ready to Restart?</h3>
                            <p className="text-xs text-[var(--color-app-muted)] mb-6 leading-relaxed">
                                Zync will restart to install the update. Any active SSH sessions will be disconnected.
                            </p>
                            <div className="flex gap-3">
                                <button
                                    ref={restartCancelRef}
                                    type="button"
                                    onClick={() => setShowRestartConfirm(false)}
                                    className="flex-1 py-2 rounded-lg bg-[var(--color-app-surface)] text-[var(--color-app-text)] text-sm font-medium hover:bg-[var(--color-app-border)] transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    onClick={handleConfirmRestart}
                                    className="flex-1 py-2 rounded-lg bg-[var(--color-app-accent)] text-white text-sm font-medium hover:opacity-90 transition-opacity shadow-lg shadow-[var(--color-app-accent)]/20"
                                >
                                    Restart
                                </button>
                            </div>
                        </div>
                    </div>
                )}
                {pendingPluginInspection && (
                    <PluginPermissionReview
                        key={pendingPluginInspection.inspectionId}
                        inspection={pendingPluginInspection}
                        isApproving={isApprovingLocalPlugin}
                        onApprove={handleApproveLocalPlugin}
                        onCancel={handleCancelLocalPluginReview}
                    />
                )}
                </motion.div>
            </div>
            <ToastContainer />
        </ZPortal>
    );
}
