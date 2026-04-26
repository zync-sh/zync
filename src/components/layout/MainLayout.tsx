import { ReactNode, lazy, Suspense, useState, useEffect, memo, useCallback, useRef } from 'react';
import { Sidebar } from './Sidebar';
import { useAppStore, Tab } from '../../store/useAppStore';
import type { CoreTabView } from '../../features/connections/domain/types';
import { usePlugins } from '../../context/PluginContext';
import { useShallow } from 'zustand/react/shallow';
import { cn } from '../../lib/utils';
import { StatusBar } from './StatusBar';
import { TabBar } from './TabBar';
import { ShortcutManager } from '../managers/ShortcutManager';
import { CommandPalette } from './CommandPalette';
import { CombinedTabBar } from './CombinedTabBar';
import { useAvailableShells } from '../../hooks/useAvailableShells';
import type { ShellEntry } from '../../lib/shells/types';
import { GLOBAL_SNIPPETS_CONNECTION_ID, LOCAL_TERMINAL_CONNECTION_ID } from '../../features/connections/application/tabService';
import { listen } from '@tauri-apps/api/event';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { ShieldAlert, Loader2 } from 'lucide-react';
import ReleaseNotesTab from '../tabs/ReleaseNotesTab';
import { SnippetSidebar } from '../snippets/SnippetSidebar';
import { SetupWizard } from '../onboarding/SetupWizard';
import { useFileSystemEvents } from '../../hooks/useFileSystemEvents';
import { AiSidebar } from '../ai/AiSidebar';
import { ModalRoot } from '../ui/ModalRoot';

// Side-effect imports — these register each modal into the registry at startup.
// Add new modals here. Plugins register their own modals in their entry point.
import '../../components/modals/AddConnectionModal';
import '../../components/modals/AddTunnelModal';
import '../../components/modals/ImportSSHCommandModal';

declare global {
    interface Window {
        __zyncHideBootSplash?: () => void;
        ipcRenderer: {
            send(channel: string, ...args: any[]): void;
            on(channel: string, listener: (event: any, ...args: any[]) => void): () => void;
            off(channel: string, listener: (event: any, ...args: any[]) => void): void;
            invoke(channel: string, ...args: any[]): Promise<any>;
        };
    }
}

// Lazy Load Heavy Components
const FileManager = lazy(() => import('../FileManager').then(module => ({ default: module.FileManager })));
const Dashboard = lazy(() => import('../dashboard/Dashboard').then(module => ({ default: module.Dashboard })));
const TunnelManager = lazy(() => import('../tunnel/TunnelManager').then(module => ({ default: module.TunnelManager })));
const SnippetsManager = lazy(() => import('../snippets/SnippetsManager').then(module => ({ default: module.SnippetsManager })));
const TerminalManager = lazy(() => import('../terminal/TerminalManager').then(module => ({ default: module.TerminalManager })));
const GlobalTunnelList = lazy(() => import('../tunnel/GlobalTunnelList').then(module => ({ default: module.GlobalTunnelList })));
const PluginPanel = lazy(() => import('../plugins/PluginPanel').then(module => ({ default: module.PluginPanel })));
const SettingsJsonEditorPanel = lazy(() =>
    import('../settings/SettingsJsonEditorPanel').then(module => ({ default: module.SettingsJsonEditorPanel }))
);

// Loading Component
const TabLoading = () => (
    <div className="absolute inset-0 flex items-center justify-center bg-app-bg">
        <div className="w-6 h-6 border-2 border-app-accent/30 border-t-app-accent rounded-full animate-spin" />
    </div>
);

const SplashScreen = () => (
    <div className="absolute inset-0 z-[99999] flex items-center justify-center bg-app-bg transition-colors duration-300">
        <div className="flex flex-col items-center gap-3">
            <svg width="112" height="112" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg" className="animate-pulse">
                <rect width="512" height="512" rx="128" className="fill-app-accent/10" />
                <path d="M128 170.667L213.333 256L128 341.333" strokeWidth="64" strokeLinecap="round" strokeLinejoin="round" className="stroke-app-accent" />
                <path d="M256 341.333H384" strokeWidth="64" strokeLinecap="round" strokeLinejoin="round" className="stroke-app-text" />
            </svg>
            <div className="text-xs font-bold tracking-[0.18em] uppercase text-app-muted">Zync</div>
        </div>
    </div>
);

const CORE_TAB_VIEWS = [
    'dashboard',
    'files',
    'port-forwarding',
    'snippets',
    'terminal',
] as const satisfies readonly CoreTabView[];

function isCoreTabView(view: string): view is CoreTabView {
    return (CORE_TAB_VIEWS as readonly string[]).includes(view);
}

/**
 * Connection tabs support plugin-backed views using a `plugin:<id>` token.
 * These are represented by the `plugin:${string}` portion of `Tab['view']`.
 */
function isPluginTabView(view: string): view is `plugin:${string}` {
    return view.startsWith('plugin:');
}


/**
 * Transparency is now handled by the .bg-transparent class on the layout div.
 */

function ConfirmCloseModal({ isOpen, onClose, onConfirm, isShuttingDown, connectionCount }: {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    isShuttingDown: boolean;
    connectionCount: number;
}) {
    return (
        <Modal
            isOpen={isOpen}
            onClose={isShuttingDown ? () => { } : onClose}
            title="Active Connections Detected"
            width="max-w-md"
        >
            <div className="space-y-4">
                <div className="flex items-center gap-3 p-3 rounded-lg bg-orange-500/10 border border-orange-500/20 text-orange-400">
                    <ShieldAlert className="shrink-0" size={20} />
                    <p className="text-sm font-medium">
                        You have {connectionCount} active connection{connectionCount > 1 ? 's' : ''}. Closing the app will disconnect all sessions.
                    </p>
                </div>

                <p className="text-sm text-app-muted leading-relaxed">
                    Are you sure you want to exit? Your active terminals and tunnels will be closed gracefully.
                </p>

                <div className="flex justify-end gap-3 pt-2">
                    <Button
                        variant="ghost"
                        onClick={onClose}
                        disabled={isShuttingDown}
                        className="hover:bg-app-surface"
                    >
                        Cancel
                    </Button>
                    <Button
                        variant="danger"
                        onClick={onConfirm}
                        disabled={isShuttingDown}
                        className="min-w-[100px] bg-red-500 text-white hover:bg-red-600 border-none transition-colors"
                    >
                        {isShuttingDown ? (
                            <div className="flex items-center gap-2">
                                <Loader2 size={14} className="animate-spin" />
                                <span>Closing...</span>
                            </div>
                        ) : "Exit App"}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
const EMPTY_ARRAY: string[] = [];

const TabContent = memo(function TabContent({ tab, isActive }: {
    tab: Tab;
    isActive: boolean;
}) {
    const setTabView = useAppStore(state => state.setTabView);
    const connect = useAppStore(state => state.connect);
    const terminalTransparencyEnabled = useAppStore(
        state => state.settings.enableVibrancy && (state.settings.windowOpacity ?? 1) < 1
    );

    // Connection Selectors - Optimized
    const connection = useAppStore(useShallow(state => state.connections.find(c => c.id === tab.connectionId)));

    // Plugin panels
    const { panels: pluginPanels } = usePlugins();

    // Terminal Store Selectors - Optimized
    const activeTermId = useAppStore(state => tab.connectionId ? (state.activeTerminalIds[tab.connectionId] || null) : null);
    const createTerminal = useAppStore(state => state.createTerminal);
    const closeTerminal = useAppStore(state => state.closeTerminal);
    const setActiveTerminal = useAppStore(state => state.setActiveTerminal);

    const hostIsWindows = tab.connectionId === LOCAL_TERMINAL_CONNECTION_ID && window.electronUtils?.platform === 'win32';
    const { shells: availableShells, isLoading: shellsLoading, error: shellsError, refetch: refetchShells } = useAvailableShells({ isWindows: hostIsWindows, connectionId: tab.connectionId });
    const defaultWindowsShell = useAppStore(state => state.settings.localTerm?.windowsShell);

    // Feature Pinning
    const toggleConnectionFeature = useAppStore(state => state.toggleConnectionFeature);
    const localPinnedFeatures = useAppStore(state => state.settings.localTerm?.pinnedFeatures);

    // Local state for open feature tabs
    const [openFeatures, setOpenFeatures] = useState<string[]>([]);

    // Snippet quick access overlay state
    const [isSnippetSidebarOpen, setIsSnippetSidebarOpen] = useState(false);

    // Effect hooks must be unconditional
    // Ensure active view is always in openFeatures
    const pinnedFeatures = tab.connectionId === LOCAL_TERMINAL_CONNECTION_ID ? (localPinnedFeatures || EMPTY_ARRAY) : (connection?.pinnedFeatures || EMPTY_ARRAY);

    useEffect(() => {
        if (tab.view && tab.view !== 'terminal' && !pinnedFeatures.includes(tab.view)) {
            setOpenFeatures(prev => {
                if (!prev.includes(tab.view)) {
                    return [...prev, tab.view];
                }
                return prev;
            });
        }
    }, [tab.view, pinnedFeatures]);

    // Listen for keyboard shortcut events to open features
    const handleOpenFeature = useCallback((feature: string) => {
        setOpenFeatures(prev => {
            if (!prev.includes(feature) && !pinnedFeatures.includes(feature)) {
                return [...prev, feature];
            }
            return prev;
        });
        setTabView(tab.id, feature as Tab['view']);
    }, [pinnedFeatures, setTabView, tab.id]);

    useEffect(() => {
        const handleFeatureEvent = (e: Event) => {
            const customEvent = e as CustomEvent;
            if (customEvent.detail.tabId === tab.id) {
                handleOpenFeature(customEvent.detail.feature);
            }
        };

        window.addEventListener('ssh-ui:open-feature', handleFeatureEvent);
        return () => window.removeEventListener('ssh-ui:open-feature', handleFeatureEvent);
    }, [tab.id, handleOpenFeature]);

    // Snippet sidebar toggle
    useEffect(() => {
        const handler = (e: Event) => {
            const ev = e as CustomEvent;
            if (ev.detail?.tabId === tab.id) {
                setIsSnippetSidebarOpen(prev => !prev);
            }
        };
        window.addEventListener('ssh-ui:toggle-snippet-sidebar', handler);
        return () => window.removeEventListener('ssh-ui:toggle-snippet-sidebar', handler);
    }, [tab.id]);

    // -- Conditional Returns for special tab types (Must be after ALL hooks) --

    if (tab.type === 'port-forwarding') {
        return (
            <div className={cn(
                "absolute inset-0 z-10 bg-app-bg",
                !isActive && "hidden",
                isActive && "animate-in fade-in zoom-in-95 duration-200"
            )}>
                <Suspense fallback={<TabLoading />}>
                    <GlobalTunnelList />
                </Suspense>
            </div>
        );
    }

    if (tab.type === 'release-notes') {
        return (
            <div className={cn(
                "absolute inset-0 z-10 bg-app-bg",
                !isActive && "hidden",
                isActive && "animate-in fade-in slide-in-from-bottom-2 duration-200"
            )}>
                <ReleaseNotesTab />
            </div>
        );
    }

    if (tab.type === 'settings') {
        // Workspace-tab surface for native settings.json editing.
        return (
            <div className={cn(
                "absolute inset-0 z-10 bg-app-bg",
                !isActive && "hidden",
                isActive && "animate-in fade-in slide-in-from-bottom-2 duration-200"
            )}>
                <Suspense fallback={<TabLoading />}>
                    <SettingsJsonEditorPanel />
                </Suspense>
            </div>
        );
    }

    if (!tab.connectionId) {
        return null;
    }

    const isConnecting = connection?.status === 'connecting';
    const isError = connection?.status === 'error';

    /**
     * Handles selection from the combined tab bar.
     *
     * Notes:
     * - Core views are type-safe (`Tab['view']`).
     * - Plugin panels use dynamic `plugin:*` view ids, so we keep a guarded
     *   cast only after runtime validation.
     */
    const handleTabSelect = useCallback((view: string, termId?: string) => {
        const isCoreView = isCoreTabView(view);
        const isPluginView = isPluginTabView(view);

        if (!isCoreView && !isPluginView) {
            console.warn('[MainLayout] Ignoring unknown tab view:', view);
            return;
        }

        if (isPluginView) {
            const pluginId = view.slice('plugin:'.length);
            const pluginExists = pluginPanels.some((panel) => panel.id === pluginId);
            if (!pluginExists) {
                console.warn('[MainLayout] Ignoring plugin tab view without registered panel:', view);
                return;
            }
        }

        setTabView(tab.id, view);
        if (view === 'terminal' && termId && tab.connectionId) {
            setActiveTerminal(tab.connectionId, termId);
        }
    }, [pluginPanels, setTabView, tab.id, tab.connectionId, setActiveTerminal]);

    const handleFeatureClose = useCallback((feature: string) => {
        setOpenFeatures(prev => prev.filter(f => f !== feature));
        // If we closed the active view, switch back to terminal
        if (tab.view === feature) {
            setTabView(tab.id, 'terminal');
        }
    }, [setOpenFeatures, tab.view, tab.id, setTabView]);

    const handleTogglePin = useCallback((feature: string) => {
        if (tab.connectionId) {
            toggleConnectionFeature(tab.connectionId, feature);
            // If we are unpinning, ensure it stays open in local state
            if (pinnedFeatures.includes(feature)) {
                if (!openFeatures.includes(feature)) {
                    setOpenFeatures(prev => [...prev, feature]);
                }
            } else {
                // Pinning: remove from openFeatures since it's now in pinnedFeatures
                setOpenFeatures(prev => prev.filter(f => f !== feature));
            }
        }
    }, [tab.connectionId, toggleConnectionFeature, pinnedFeatures, openFeatures, setOpenFeatures]);

    const handleTerminalClose = useCallback((termId: string) => {
        if (tab.connectionId) {
            closeTerminal(tab.connectionId, termId);
        }
    }, [tab.connectionId, closeTerminal]);

    const handleNewTerminal = useCallback((shell?: ShellEntry) => {
        if (tab.connectionId) {
            createTerminal(
                tab.connectionId,
                shell ? { shellOverride: shell.id, title: shell.label } : undefined,
            );
            setTabView(tab.id, 'terminal');
        }
    }, [tab.connectionId, createTerminal, tab.id, setTabView]);

    // Ensure we start with at least 'terminal' available conceptually, 
    // though combined bar renders terminals from store.

    // Each tab content is rendered but hidden if not active
    return (
        <div className={cn(
            "absolute inset-0 flex flex-col transition-all",
            tab.view === 'terminal' && terminalTransparencyEnabled && !isConnecting && !isError ? "bg-transparent" : "bg-app-bg",
            !isActive && "hidden",
            isActive && "animate-in fade-in slide-in-from-bottom-2 duration-300 ease-out fill-mode-forwards"
        )}>
            {isConnecting ? (
                <div className="flex-1 flex flex-col items-center justify-center space-y-4">
                    <div className="w-8 h-8 border-4 border-[var(--color-app-accent)]/30 border-t-[var(--color-app-accent)] rounded-full animate-spin"></div>
                    <div className="text-[var(--color-app-muted)] animate-pulse">Connecting to server...</div>
                </div>
            ) : isError ? (
                <div className="flex-1 flex flex-col items-center justify-center space-y-4">
                    <div className="text-[var(--color-app-danger)] text-4xl mb-4">&#9888;</div>
                    <div className="text-xl font-medium text-[var(--color-app-text)]">Connection Failed</div>
                    <div className="text-[var(--color-app-muted)] text-sm max-w-md text-center">
                        Could not establish a connection to <span className="font-mono text-[var(--color-app-text)]">{connection?.host}</span>.
                    </div>
                    <button
                        onClick={() => connection && connect(connection.id)}
                        className="px-4 py-2 bg-[var(--color-app-accent)] text-white rounded-lg hover:brightness-110 transition-all font-medium text-sm mt-4"
                    >
                        Retry Connection
                    </button>
                </div>
            ) : (
                <>
                    {/* Unified Tab Bar — not shown for the standalone global snippets tab */}
                    {tab.connectionId !== GLOBAL_SNIPPETS_CONNECTION_ID && (
                        <CombinedTabBar
                            connectionId={tab.connectionId}
                            activeView={tab.view}
                            activeTerminalId={activeTermId}
                            openFeatures={openFeatures}
                            pinnedFeatures={pinnedFeatures}
                            pluginPanels={pluginPanels.map(p => ({ id: p.id, title: p.title }))}
                            availableShells={availableShells}
                            shellsLoading={shellsLoading}
                            shellsError={shellsError}
                            onRefetchShells={refetchShells}
                                        defaultShellId={tab.connectionId === LOCAL_TERMINAL_CONNECTION_ID ? defaultWindowsShell : undefined}
                            onTabSelect={handleTabSelect}
                            onFeatureClose={handleFeatureClose}
                            onTerminalClose={handleTerminalClose}
                            onNewTerminal={handleNewTerminal}
                            onOpenFeature={handleOpenFeature}
                            onTogglePin={handleTogglePin}
                        />
                    )}

                    {/* Content Area */}
                    <div className="flex-1 overflow-hidden relative flex flex-col">
                        <Suspense fallback={<TabLoading />}>
                            <div className={cn("absolute inset-0 z-10 bg-app-bg", tab.view === 'files' ? "block" : "hidden")}>
                                <FileManager connectionId={tab.connectionId} isVisible={isActive && tab.view === 'files'} />
                            </div>
                            <div className={cn("absolute inset-0 z-10 bg-app-bg", tab.view === 'dashboard' ? "block" : "hidden")}>
                                <Dashboard connectionId={tab.connectionId} isVisible={isActive && tab.view === 'dashboard'} />
                            </div>
                            {/* Tunnels & Snippets */}
                            {tab.view === 'port-forwarding' && (
                                <div className="absolute inset-0 z-10 bg-app-bg">
                                    <TunnelManager connectionId={tab.connectionId} />
                                </div>
                            )}
                            {tab.view === 'snippets' && (
                                <div className="absolute inset-0 z-10 bg-app-bg">
                                    <SnippetsManager connectionId={tab.connectionId} />
                                </div>
                            )}

                            {/* Plugin Panels */}
                            {pluginPanels.map(panel => {
                                const viewId = `plugin:${panel.id}`;
                                if (tab.view !== viewId) return null;
                                // Race condition check: obtain latest ID from store to ensure we haven't switched tabs
                                if (tab.connectionId !== useAppStore.getState().activeConnectionId) return null;
                                return (
                                    <PluginPanel
                                        key={panel.id}
                                        html={panel.html}
                                        panelId={panel.id}
                                        pluginId={panel.pluginId}
                                        connectionId={tab.connectionId || null}
                                    />
                                );
                            })}

                            {/* 
                                Terminal View
                                Pass hideTabs={true} to disable its internal tab bar
                            */}
                            <div
                                className={cn(
                                    "absolute inset-0 z-10",
                                    tab.view === 'terminal' ? "block" : "hidden",
                                    terminalTransparencyEnabled ? "bg-transparent" : "bg-app-bg"
                                )}
                            >
                                <TerminalManager
                                    connectionId={tab.connectionId}
                                    isVisible={isActive && tab.view === 'terminal'}
                                    hideTabs={true}
                                />
                                {/* Snippet overlay sidebar — slides in from right over terminal */}
                                <SnippetSidebar
                                    connectionId={tab.connectionId}
                                    isOpen={isSnippetSidebarOpen}
                                    onClose={() => setIsSnippetSidebarOpen(false)}
                                />
                            </div>

                        </Suspense>
                    </div>
                </>
            )}
        </div>
    );
});

export function MainLayout({ children }: { children: ReactNode }) {
    useFileSystemEvents(); // Enable global FS event listeners

    const tabs = useAppStore(state => state.tabs);
    const activeTabId = useAppStore(state => state.activeTabId);
    const activeTerminalIds = useAppStore(state => state.activeTerminalIds);
    const showWelcomeScreen = useAppStore(state => state.showWelcomeScreen);
    const isLoadingSettings = useAppStore(state => state.isLoadingSettings);
    const sessionLoaded = useAppStore(state => state.sessionLoaded);
    const loadSnippets = useAppStore(state => state.loadSnippets);

    // Pre-load snippets once on app startup so the picker/sidebar always have data
    useEffect(() => {
        loadSnippets();
    }, [loadSnippets]);
    const [showWizard, setShowWizard] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [windowWidth, setWindowWidth] = useState(window.innerWidth);
    const [isMaximized, setIsMaximized] = useState(false);

    const isSmallScreen = windowWidth < 640;
    const isTablet = windowWidth < 1024;

    const settings = useAppStore(state => state.settings);
    const sidebarCollapsed = settings.sidebarCollapsed;
    const updateSettings = useAppStore(state => state.updateSettings);

    // Shutdown Management
    const [isShutdownModalOpen, setIsShutdownModalOpen] = useState(false);
    const [isShuttingDown, setIsShuttingDown] = useState(false);
    const connections = useAppStore(state => state.connections);
    const disconnect = useAppStore(state => state.disconnect);
    const activeConnections = connections.filter(c => c.status === 'connected' && c.id !== LOCAL_TERMINAL_CONNECTION_ID);

    const handleShutdown = useCallback(async () => {
        setIsShuttingDown(true);
        try {
            // Disconnect all active connections
            const disconnectPromises = activeConnections.map(c => disconnect(c.id));
            await Promise.all(disconnectPromises);

            // Brief delay to ensure state updates reach backend
            await new Promise(resolve => setTimeout(resolve, 500));

            window.ipcRenderer?.invoke('app_exit');
        } catch (error) {
            console.error('Graceful shutdown failed:', error);
            window.ipcRenderer?.invoke('app_exit');
        }
    }, [activeConnections, disconnect]);

    useEffect(() => {
        const setupShutdownListener = async () => {
            const unlisten = await listen('app:request-close', () => {
                // Check latest state
                const currentConnections = useAppStore.getState().connections.filter(c => c.status === 'connected' && c.id !== LOCAL_TERMINAL_CONNECTION_ID);
                if (currentConnections.length > 0) {
                    setIsShutdownModalOpen(true);
                } else {
                    window.ipcRenderer?.invoke('app_exit');
                }
            });
            return unlisten;
        };

        const shutdownCleanup = setupShutdownListener();
        return () => {
            shutdownCleanup.then(unlisten => unlisten());
        };
    }, []);

    useEffect(() => {
        const handleResize = () => {
            setWindowWidth(window.innerWidth);
            window.ipcRenderer?.invoke('window:is-maximized').then((max: boolean) => {
                setIsMaximized(max);
            });
        };
        handleResize(); // Initial check
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    // Auto-collapse sidebar on tablet/mobile if it was open
    const initialCollapseRef = useRef(false);
    useEffect(() => {
        if (!initialCollapseRef.current && !isLoadingSettings && isTablet && !sidebarCollapsed) {
            updateSettings({ sidebarCollapsed: true });
            initialCollapseRef.current = true;
        }
    }, [isTablet, updateSettings, isLoadingSettings, sidebarCollapsed]); // only run once when threshold crossed

    useEffect(() => {
        checkConfig();
    }, []);

    // Ctrl+I is handled centrally by ShortcutManager.
    // This effect is intentionally empty but preserved to keep hook count stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => {}, []);

    // Version Tracking for Release Notes
    const openReleaseNotesTab = useAppStore(state => state.openReleaseNotesTab);
    const versionChecked = useRef(false);

    useEffect(() => {
        // Only run once after settings have loaded
        if (isLoadingSettings || versionChecked.current) return;
        versionChecked.current = true;

        const checkVersionAndShowNotes = async () => {
            try {
                const currentVersion = await window.ipcRenderer?.invoke('app:getVersion');
                if (!currentVersion) return;
                const storedVersion = useAppStore.getState().settings.lastSeenVersion;

                // Signal 1: 'zync-just-updated' flag is written by UpdateNotification
                //           just before the Tauri updater restarts the app.
                //           This is the reliable signal for auto-updates.
                const justUpdated = localStorage.getItem('zync-just-updated') === 'true';

                // Signal 2: version mismatch - catches manual installs / fresh installs
                //           where lastSeenVersion is '' or an older value.
                const versionMismatch = storedVersion !== currentVersion;

                // Always consume the flag unconditionally - prevents stale flag from
                // opening the tab on every subsequent launch if the app previously crashed.
                if (justUpdated) {
                    localStorage.removeItem('zync-just-updated');
                }

                if (versionMismatch) {
                    openReleaseNotesTab();
                }

                // Always keep lastSeenVersion in sync
                if (versionMismatch) {
                    updateSettings({ lastSeenVersion: currentVersion });
                }
            } catch (err) {
                console.error('Failed to resolve version for release notes tracking', err);
            }
        };

        checkVersionAndShowNotes();
    }, [isLoadingSettings, openReleaseNotesTab, updateSettings]);

    // Theme Application Effect
    const theme = useAppStore(state => state.settings.theme);
    const accentColor = useAppStore(state => state.settings.accentColor);
    const globalFontFamily = useAppStore(state => state.settings.globalFontFamily);
    const globalFontSize = useAppStore(state => state.settings.globalFontSize);
    const terminalTransparencyEnabled = useAppStore(
        state => state.settings.enableVibrancy && (state.settings.windowOpacity ?? 1) < 1
    );

    const persistBootThemeColors = useCallback(() => {
        try {
            const style = getComputedStyle(document.body);
            const bg = style.getPropertyValue('--color-app-bg').trim();
            const panel = style.getPropertyValue('--color-app-panel').trim();
            const text = style.getPropertyValue('--color-app-text').trim();
            const accent = style.getPropertyValue('--color-app-accent').trim();

            if (!bg || !panel || !text || !accent) return;

            const accentSoft = `color-mix(in srgb, ${accent} 14%, transparent)`;
            localStorage.setItem('zync-theme-colors', JSON.stringify({ bg, panel, text, accent, accentSoft }));
        } catch (error) {
            console.warn('Failed to persist boot theme colors', error);
        }
    }, []);

    useEffect(() => {
        if (isLoadingSettings) return;

        // Persist for splash screen
        localStorage.setItem('zync-theme', theme);

        // Remove old theme classes (Legacy support)
        document.body.classList.remove('light', 'dark', 'dracula', 'monokai', 'midnight', 'warm', 'light-warm');

        if (theme === 'system') {
            const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
            document.body.classList.add(systemTheme);
            document.body.setAttribute('data-theme', systemTheme);
        } else {
            document.body.classList.add(theme); // Keep class for backward compatibility
            document.body.setAttribute('data-theme', theme); // Set attribute for new plugin system
        }

        // Apply Custom Accent
        if (accentColor) {
            document.body.style.setProperty('--color-app-accent', accentColor);
            localStorage.setItem('zync-accent-color', accentColor);
        } else {
            document.body.style.removeProperty('--color-app-accent');
            localStorage.removeItem('zync-accent-color');
        }

        if (globalFontFamily?.trim()) {
            const normalizedFont = globalFontFamily.trim();
            document.documentElement.style.setProperty('--font-sans', normalizedFont);
            document.body.style.setProperty('--font-sans', normalizedFont);
        } else {
            document.documentElement.style.removeProperty('--font-sans');
            document.body.style.removeProperty('--font-sans');
        }

        if (Number.isFinite(globalFontSize) && globalFontSize >= 10 && globalFontSize <= 24) {
            document.documentElement.style.fontSize = `${globalFontSize}px`;
        } else {
            document.documentElement.style.removeProperty('font-size');
        }

        window.requestAnimationFrame(() => {
            persistBootThemeColors();
        });
        const persistTimer = window.setTimeout(() => {
            persistBootThemeColors();
        }, 120);

        // This is a bit tricky. The theme sets --color-app-bg. We want that color but with alpha.
        // We can't easily modify the variable itself without knowing its value.
        // However, we can set the root div's background to be the theme color with forced opacity if we use color-mix (modern browsers)
        // or we rely on the user to pick a theme and we apply opacity to the main container.

        return () => {
            window.clearTimeout(persistTimer);
        };

    }, [theme, accentColor, globalFontFamily, globalFontSize, isLoadingSettings, persistBootThemeColors]);


    const hideBootSplash = useCallback(() => {
        try {
            if (typeof window.__zyncHideBootSplash === 'function') {
                window.__zyncHideBootSplash();
                return;
            }
        } catch (e) {
            console.warn('Error in __zyncHideBootSplash:', e);
        } finally {
            document.getElementById('boot-splash')?.remove();
        }
    }, []);

    const handleAiRunCommand = useCallback((connectionId: string, command: string) => {
        const normalizedCommand = command.endsWith('\r') ? command : `${command}\r`;
        window.dispatchEvent(new CustomEvent('ssh-ui:run-command', {
            detail: { connectionId, command: normalizedCommand },
        }));

        const currentTabId = useAppStore.getState().activeTabId;
        if (currentTabId) {
            useAppStore.getState().setTabView(currentTabId, 'terminal');
        }
    }, []);

    useEffect(() => {
        if (isLoading || isLoadingSettings || !sessionLoaded) return;
        hideBootSplash();
    }, [isLoading, isLoadingSettings, sessionLoaded, hideBootSplash]);

    const checkConfig = async () => {
        try {
            // On Windows, skip wizard entirely (backend auto-configures, and in browser dev mode we don't need wizard)
            const isWindows = navigator.userAgent.includes('Windows');
            if (isWindows) {
                setIsLoading(false);
                return;
            }

            // Mac/Linux: Check config and show wizard if needed
            const config = await window.ipcRenderer?.invoke('config:get');
            if (!config) return;
            if (!config.isConfigured) {
                setShowWizard(true);
            }
        } catch (error) {
            console.error('Failed to load config:', error);
        } finally {
            setIsLoading(false);
        }
    };

    if (isLoading || isLoadingSettings || !sessionLoaded) {
        return document.getElementById('boot-splash') ? null : <SplashScreen />;
    }

    return (
        <div
            className={cn(
                "relative flex flex-col h-screen text-app-text font-sans selection:bg-app-accent/30 overflow-hidden transition-all duration-300",
                !isMaximized && "rounded-xl border border-app-border/20",
                terminalTransparencyEnabled ? "bg-transparent" : "bg-app-bg"
            )}
        >
            {showWizard && <SetupWizard onComplete={() => setShowWizard(false)} />}
            <CommandPalette />
            <ShortcutManager />
            <ModalRoot />

            {/* Top Unified Header (TabBar) */}
            <TabBar />

            <div className="flex-1 flex overflow-hidden relative">
                {/* Sidebar Overlay for Mobile */}
                {
                    isSmallScreen && !sidebarCollapsed && (
                        <div
                            className="absolute inset-0 bg-black/50 backdrop-blur-sm z-[45] animate-in fade-in duration-300"
                            onClick={() => updateSettings({ sidebarCollapsed: true })}
                        />
                    )
                }

                <Sidebar className={isSmallScreen ? "fixed" : ""} />

                <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
                    {/* Main Content Area */}
                    <div className="flex-1 overflow-hidden relative flex flex-col">
                        {tabs.length > 0 && !showWelcomeScreen && activeTabId !== null ? (
                            tabs.map((tab: Tab) => (
                                <TabContent
                                    key={tab.id}
                                    tab={tab}
                                    isActive={tab.id === activeTabId}
                                />
                            ))
                        ) : (
                            <div className="flex-1 bg-app-bg">{children}</div>
                        )}
                    </div>
                </div>

                {/* AI Assistant Right Sidebar */}
                {(() => {
                    const activeTab = tabs.find(t => t.id === activeTabId);
                    const connId = activeTab?.connectionId ?? null;
                    const activeTermId = connId ? (activeTerminalIds[connId] || null) : null;
                    return (
                        <AiSidebar
                            connectionId={connId}
                            activeTermId={activeTermId}
                            onRunCommand={handleAiRunCommand}
                        />
                    );
                })()}
            </div>

            {/* Bottom Unified Status Bar (Full Width) */}
            <StatusBar />

            <ConfirmCloseModal
                isOpen={isShutdownModalOpen}
                onClose={() => setIsShutdownModalOpen(false)}
                onConfirm={handleShutdown}
                isShuttingDown={isShuttingDown}
                connectionCount={activeConnections.length}
            />
            {/* Portal Root for Modals/Overlays to ensure they stay within rounded corners */}
            <div id="modal-portal-root" className="absolute inset-0 pointer-events-none z-[9999]" />
        </div >
    );
}

