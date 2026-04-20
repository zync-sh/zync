import { useState, useEffect, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { ZPortal } from '../ui/ZPortal';
import { useAppStore } from '../../store/useAppStore'; // Updated Import
import { usePlugins } from '../../context/PluginContext';

import { X, Type, Monitor, FileText, Keyboard, Info, RefreshCw, FolderOpen, Settings as SettingsIcon, Package, Code, Sparkles } from 'lucide-react';
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
import { IconResolver } from './common/IconResolver';
import { TabButton } from './common/TabButton';
import { TiltLogo } from './common/TiltLogo';
import { useSettingsPaths } from './hooks/useSettingsPaths';
import { useSettingsUpdateFlow } from './hooks/useSettingsUpdateFlow';
import { useSettingsPlugins } from './hooks/useSettingsPlugins';
import { useAboutStats } from './hooks/useAboutStats';
import { PluginTabContentSwitch } from './tabs/plugins/PluginTabContentSwitch';
import { PluginsInstalledTab } from './tabs/plugins/PluginsInstalledTab';
import { PluginsMarketplaceTab } from './tabs/plugins/PluginsMarketplaceTab';
import { PluginsDeveloperTab, type LocalInstallAction } from './tabs/plugins/PluginsDeveloperTab';


interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

type Tab = 'general' | 'terminal' | 'appearance' | 'fileManager' | 'shortcuts' | 'plugins' | 'ai' | 'about';
const BUILTIN_ICON_THEME_COUNT = 2; // VSCode Icons + Lucide

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
    const settings = useAppStore(state => state.settings);
    const updateSettings = useAppStore(state => state.updateSettings);
    const updateAiSettings = useAppStore(state => state.updateAiSettings);
    const updateTerminalSettings = useAppStore(state => state.updateTerminalSettings);
    const updateFileManagerSettings = useAppStore(state => state.updateFileManagerSettings);
    const updateLocalTermSettings = useAppStore(state => state.updateLocalTermSettings);
    const updateKeybindings = useAppStore(state => state.updateKeybindings);
    const updateGhostSuggestionsSettings = useAppStore(state => state.updateGhostSuggestionsSettings);
    const openSettingsJsonTab = useAppStore(state => state.openSettingsJsonTab);

    // Use the store action so merges happen against current state, not the render snapshot.
    const setGhostSuggestionsField = (patch: Partial<typeof settings.ghostSuggestions>) => {
        updateGhostSuggestionsSettings(patch);
    };

    const setGhostProviderField = (patch: Partial<typeof settings.ghostSuggestions.providers>) => {
        // The reducer merges patch into current.providers, so a partial patch is safe.
        updateGhostSuggestionsSettings({ providers: patch as typeof settings.ghostSuggestions.providers });
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
    const [pluginTab, setPluginTab] = useState<'installed' | 'marketplace' | 'developer'>('installed');
    const [isTransitioning, setIsTransitioning] = useState(false);
    const [wslDistros, setWslDistros] = useState<string[]>([]);

    // Global Update State
    const updateStatus = useAppStore(state => state.updateStatus);
    const updateInfo = useAppStore(state => state.updateInfo);
    const setUpdateStatus = useAppStore(state => state.setUpdateStatus);
    const setUpdateInfo = useAppStore(state => state.setUpdateInfo);
    const openReleaseNotesTab = useAppStore(state => state.openReleaseNotesTab);

    const [apiKeyDraft, setApiKeyDraft] = useState('');
    const [apiKeySaved, setApiKeySaved] = useState(false);
    const [apiKeyError, setApiKeyError] = useState<string | null>(null);
    const [terminalFontDraft, setTerminalFontDraft] = useState('');
    const [globalFontDraft, setGlobalFontDraft] = useState('');
    const saveApiKey = async (provider: string, key: string) => {
        if (provider === 'ollama') return;
        
        try {
            setApiKeyError(null);
            await invoke('save_secret', { key: provider, value: key });
            setApiKeySaved(true);
            setTimeout(() => setApiKeySaved(false), 2000);
        } catch (err: unknown) {
            console.error('Failed to save API key:', err);
            const message = err instanceof Error ? err.message : String(err);
            setApiKeyError(message);
            setApiKeySaved(false);
        }
    };

    const { executeCommand, editorProviders } = usePlugins();
    const showConfirmDialog = useAppStore(state => state.showConfirmDialog);
    const showToast = useAppStore(state => state.showToast);
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
        canAutoUpdate,
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
        isLoadingRegistry,
        activeMenu,
        setActiveMenu,
        processingId,
        needsRestart,
        setNeedsRestart,
        localPluginInstallMode,
        handleInstallLocalPlugin,
        handleTogglePlugin,
        handleUninstallPlugin,
        handleUpdatePlugin,
    } = useSettingsPlugins({
        isOpen,
        activeTab,
        showToast,
        showConfirmDialog,
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
            hint: 'Archive should include plugin.json at package root.',
            icon: Package,
        },
        {
            mode: 'folder' as const,
            label: 'Install from folder',
            title: 'Load unpacked plugin directory',
            description: 'Use this during active editor-provider or theme development without zipping every build.',
            hint: 'Folder should contain plugin.json and dist/assets if used.',
            icon: FolderOpen,
        },
    ];

    // Sync apiKeyDraft when provider changes or tab opens
    const currentProvider = settings.ai?.provider || 'ollama';
    useEffect(() => {
        if (activeTab !== 'ai') return;
        if (currentProvider === 'ollama') {
            setApiKeyDraft('');
            setApiKeySaved(false);
            return;
        }

        invoke<string | null>('get_secret', { key: currentProvider })
            .then(key => {
                setApiKeyDraft(key || '');
                setApiKeySaved(false);
            })
            .catch(err => console.error('Failed to load secret:', err));
    }, [currentProvider, activeTab]);

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

    // Keyboard Navigation
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

            // Escape to close
            if (e.key === 'Escape') {
                onClose();
                return;
            }

            // Arrow keys for tab navigation
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault();
                const tabs: Tab[] = ['general', 'terminal', 'appearance', 'fileManager', 'shortcuts', 'plugins', 'ai', 'about'];
                const currentIndex = tabs.indexOf(activeTab);
                let nextIndex: number;

                if (e.key === 'ArrowRight') {
                    nextIndex = (currentIndex + 1) % tabs.length;
                } else {
                    nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
                }

                handleTabChange(tabs[nextIndex]);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, activeTab, onClose]);

    // Smooth Tab Transition Handler
    const handleTabChange = (newTab: Tab) => {
        if (newTab === activeTab) return;
        setIsTransitioning(true);
        setTimeout(() => {
            setActiveTab(newTab);
            setIsTransitioning(false);
        }, 150);
    };

    const renderPluginInstalled = () => (
        <PluginsInstalledTab
            plugins={plugins}
            registry={registry}
            isLoadingPlugins={isLoadingPlugins}
            processingId={processingId}
            activeMenu={activeMenu}
            setActiveMenu={setActiveMenu}
            executeCommand={executeCommand}
            onClose={onClose}
            onTogglePlugin={handleTogglePlugin}
            onUpdatePlugin={handleUpdatePlugin}
            onUninstallPlugin={handleUninstallPlugin}
            iconThemeCount={BUILTIN_ICON_THEME_COUNT + plugins.filter((plugin) => plugin.manifest.type === 'icon-theme').length}
            iconRenderer={IconResolver}
        />
    );

    const renderPluginMarketplace = () => (
        <PluginsMarketplaceTab
            isLoadingRegistry={isLoadingRegistry}
            onInstallSuccess={() => setNeedsRestart(true)}
        />
    );

    const renderPluginDeveloper = () => (
        <PluginsDeveloperTab
            localInstallActions={localInstallActions}
            localPluginInstallMode={localPluginInstallMode}
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
            showToast('info', 'Connections cleared.');
        }
    };

    if (!isOpen) return null;

    return (
        <ZPortal className="absolute inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="relative w-[860px] h-[620px] max-w-[95vw] max-h-[90vh] bg-[var(--color-app-bg)] rounded-xl border border-[var(--color-app-border)] shadow-2xl flex overflow-hidden animate-in zoom-in-95 duration-200 ring-1 ring-white/5">

                {/* Sidebar */}
                <div className="w-[180px] flex flex-col border-r border-[var(--color-app-border)]/40 bg-[var(--color-app-surface)]/20 p-2 space-y-0.5">
                    <div className="px-3 py-4 mb-1">
                        <span className="text-xs font-bold text-[var(--color-app-muted)] uppercase tracking-wider opacity-70">Settings</span>
                    </div>

                    <TabButton active={activeTab === 'general'} onClick={() => handleTabChange('general')} icon={<SettingsIcon size={15} />} label="General" />
                    <TabButton active={activeTab === 'terminal'} onClick={() => handleTabChange('terminal')} icon={<Type size={15} />} label="Terminal" />
                    <TabButton active={activeTab === 'appearance'} onClick={() => handleTabChange('appearance')} icon={<Monitor size={15} />} label="Appearance" />
                    <TabButton active={activeTab === 'fileManager'} onClick={() => handleTabChange('fileManager')} icon={<FileText size={15} />} label="File Manager" />
                    <TabButton active={activeTab === 'shortcuts'} onClick={() => handleTabChange('shortcuts')} icon={<Keyboard size={15} />} label="Shortcuts" />
                    <TabButton active={activeTab === 'plugins'} onClick={() => handleTabChange('plugins')} icon={<Package size={15} />} label="Plugins" />
                    <TabButton active={activeTab === 'ai'} onClick={() => handleTabChange('ai')} icon={<Sparkles size={15} />} label="AI" />
                    <TabButton
                        active={false}
                        onClick={() => {
                            openSettingsJsonTab();
                            onClose();
                        }}
                        icon={<Code size={15} />}
                        label="settings.json"
                    />

                    <div className="mt-auto pt-2 border-t border-[var(--color-app-border)]/30">
                        <TabButton
                            active={activeTab === 'about'}
                            onClick={() => handleTabChange('about')}
                            icon={<Info size={15} />}
                            label="About"
                            badge={updateStatus === 'available' || updateStatus === 'downloading' || updateStatus === 'ready'}
                        />
                    </div>
                </div>

                {/* Content Area */}
                <div className="flex-1 flex flex-col min-w-0 bg-[var(--color-app-bg)]">
                    {/* Header */}
                    <div className="h-12 flex items-center justify-between px-4 border-b border-[var(--color-app-border)]/30 shrink-0">
                        <h2 className="font-medium text-[var(--color-app-text)] text-sm tracking-tight">
                            {activeTab === 'fileManager'
                                ? 'File Manager'
                                : activeTab === 'ai'
                                    ? 'AI Assistant'
                                : activeTab.charAt(0).toUpperCase() + activeTab.slice(1)}
                        </h2>
                        <button onClick={onClose} className="p-1.5 rounded-md text-[var(--color-app-muted)] hover:text-[var(--color-app-text)] hover:bg-[var(--color-app-surface)] transition-colors">
                            <X size={16} />
                        </button>
                    </div>

                    {/* Scrollable Content */}
                    <div className={`flex-1 overflow-y-auto p-4 lg:p-5 space-y-6 transition-opacity duration-150 ${isTransitioning ? 'opacity-0' : 'opacity-100'}`}>

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
                                onUpdateSettings={updateSettings}
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
                                terminalFontDraft={terminalFontDraft}
                                setTerminalFontDraft={setTerminalFontDraft}
                                wslDistros={wslDistros}
                                isWindows={isWindows}
                                updateTerminalSettings={updateTerminalSettings}
                                updateLocalTermSettings={updateLocalTermSettings}
                                setGhostSuggestionsField={setGhostSuggestionsField}
                                setGhostProviderField={setGhostProviderField}
                            />
                        )}

                        {activeTab === 'appearance' && (
                            <AppearanceTab
                                settings={settings}
                                plugins={plugins}
                                globalFontDraft={globalFontDraft}
                                setGlobalFontDraft={setGlobalFontDraft}
                                updateSettings={updateSettings}
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
                                apiKeySaved={apiKeySaved}
                                apiKeyError={apiKeyError}
                                setApiKeyDraft={setApiKeyDraft}
                                setApiKeyError={setApiKeyError}
                                updateAiSettings={updateAiSettings}
                                saveApiKey={saveApiKey}
                            />
                        )}

                        {activeTab === 'about' && (
                            <AboutTab
                                appVersion={appVersion}
                                platformLabel={platformLabel}
                                updateStatus={updateStatus}
                                updateInfo={updateInfo}
                                canAutoUpdate={canAutoUpdate}
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
                {/* Restart Confirmation Overlay */}
                {showRestartConfirm && (
                    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
                        <div className="bg-[var(--color-app-bg)] rounded-xl border border-[var(--color-app-border)] shadow-2xl p-6 w-[320px] animate-in zoom-in-95 text-center">
                            <div className="w-12 h-12 rounded-full bg-[var(--color-app-accent)]/10 text-[var(--color-app-accent)] flex items-center justify-center mx-auto mb-4">
                                <RefreshCw size={24} />
                            </div>
                            <h3 className="text-lg font-bold text-[var(--color-app-text)] mb-2">Ready to Restart?</h3>
                            <p className="text-xs text-[var(--color-app-muted)] mb-6 leading-relaxed">
                                Zync will restart to install the update. Any active SSH sessions will be disconnected.
                            </p>
                            <div className="flex gap-3">
                                <button
                                    onClick={() => setShowRestartConfirm(false)}
                                    className="flex-1 py-2 rounded-lg bg-[var(--color-app-surface)] text-[var(--color-app-text)] text-sm font-medium hover:bg-[var(--color-app-border)] transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleConfirmRestart}
                                    className="flex-1 py-2 rounded-lg bg-[var(--color-app-accent)] text-white text-sm font-medium hover:opacity-90 transition-opacity shadow-lg shadow-[var(--color-app-accent)]/20"
                                >
                                    Restart
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div >
            <ToastContainer />
        </ZPortal>
    );
}
