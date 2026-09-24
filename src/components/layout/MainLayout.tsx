import { ReactNode, lazy, Suspense, useState, useEffect, useLayoutEffect, memo, useCallback, useRef, useMemo } from 'react';
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
import { WorkspaceTabBar } from './WorkspaceTabBar';
import {
    overlayPluginPaneId,
    parseOverlayFeatureId,
    parseOverlayPluginId,
    TabDockOverlay,
    type DockTabPointerHandlers,
} from './tabDock';
import { collectLeaves, isFeatureContent, isPluginContent, isSplitFeatureId, isSplitLayout, layoutForCanvas, layoutForFeatureInstance, layoutHasPlugin } from '../../lib/paneLayout';
import { featureTabsFromPaneGroups, initialFeatureTabsForView, mergeFeatureTabs, preferredFeatureTabId } from './featureTabInventory';
import type { ShellEntry } from '../../lib/shells/types';
import type { FeatureId, WorkspaceFeatureTab } from './featureMeta';
import { GLOBAL_SNIPPETS_CONNECTION_ID, LOCAL_TERMINAL_CONNECTION_ID } from '../../features/connections/application/tabService';
import { listen } from '@tauri-apps/api/event';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { ShieldAlert, Loader2 } from 'lucide-react';
import { ConnectStagePanel, PanelLoader, useConnectionStageOverlay } from '../loaders';
import { SurveyPromptModal } from '../survey/SurveyPromptModal';
import {
    normalizeSurveySettings,
    resolveSurveyPromptKind,
    type SurveyPromptKind,
} from '../../features/survey';
import { getDebugSurveyPromptKind, isDebugSurveyPromptEnabled } from '../../lib/debugFlags';
import ReleaseNotesTab from '../tabs/ReleaseNotesTab';

import { SnippetSidebar } from '../snippets/SnippetSidebar';
import { SetupWizard } from '../onboarding/SetupWizard';
import { useFileSystemEvents } from '../../hooks/useFileSystemEvents';
import { AiSidebar } from '../ai/AiSidebar';
import { ModalRoot } from '../ui/ModalRoot';
import {
    cancelAllIdlePtySuspends,
    cancelIdlePtySuspend,
    resolveIdleHostPtySuspendDelayMs,
    scheduleIdlePtySuspend,
    shouldIdleSuspendConnection,
    resolveShellExitConnectionId,
    terminalService,
} from '../../lib/terminal';
import { resolveLocalWindowsShellId } from '../../lib/terminal/spawnContext';
import { refreshAllCachedTerminalThemes } from '../terminal/terminalTheme';
import { registerTunnelTransportLostListener } from '../../features/tunnels/application/tunnelTransportLost';


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
const TerminalManager = lazy(() => import('../terminal/TerminalManager').then(module => ({ default: module.TerminalManager })));
const GlobalTunnelList = lazy(() => import('../tunnel/GlobalTunnelList').then(module => ({ default: module.GlobalTunnelList })));
const PublicUrlsPanel = lazy(() => import('../share/PublicUrlsPanel').then(module => ({ default: module.PublicUrlsPanel })));
const PluginPanel = lazy(() => import('../plugins/PluginPanel').then(module => ({ default: module.PluginPanel })));
const SettingsJsonEditorPanel = lazy(() =>
    import('../settings/SettingsJsonEditorPanel').then(module => ({ default: module.SettingsJsonEditorPanel }))
);
import { VaultWorkspaceLoading } from '../vault/VaultWorkspaceLoading';

const VaultWorkspacePanel = lazy(() =>
    import('../vault/VaultWorkspacePanel').then(module => ({ default: module.default }))
);

function newWorkspaceFeatureTab(featureId: FeatureId, id = `feature-${crypto.randomUUID()}`): WorkspaceFeatureTab {
    return { id, featureId, instanceId: id };
}
const SyncBackupWorkspacePanel = lazy(() =>
    import('../sync/SyncBackupWorkspacePanel').then(module => ({ default: module.default }))
);

const TabLoading = () => <PanelLoader />;

/**
 * Fallback splash only if boot splash is gone early.
 * Keep in sync with index.html #boot-splash: plated themed mark + ring dash loader.
 * Bare/flat monochrome is for title-bar chrome only — not splash.
 */
const SplashScreen = () => (
    <div className="zync-splash absolute inset-0 z-[99999] flex items-center justify-center bg-app-bg overflow-hidden">
        <div className="zync-splash-inner relative flex flex-col items-center gap-[18px]">
            <div className="zync-splash-mark-wrap relative grid place-items-center w-[120px] h-[120px]">
                {/* No glow blob — solid plate is the surface (matches boot splash) */}
                <div className="zync-splash-tile relative w-[120px] h-[120px]">
                    <svg
                        className="zync-splash-icon relative z-[1]"
                        width={120}
                        height={120}
                        viewBox="0 0 512 512"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                        aria-hidden
                    >
                        {/* Solid themed plate (panel + accent), not transparent soft fill */}
                        <rect width="512" height="512" rx="112" className="zync-splash-plate" />
                        <rect
                            className="zync-splash-ring-track stroke-app-accent"
                            x="9"
                            y="9"
                            width="494"
                            height="494"
                            rx="103"
                            fill="none"
                            strokeWidth="18"
                        />
                        <rect
                            className="zync-splash-ring-spin stroke-app-accent"
                            x="9"
                            y="9"
                            width="494"
                            height="494"
                            rx="103"
                            fill="none"
                            strokeWidth="18"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                        <g transform="translate(256 248) scale(0.92) translate(-256 -256)">
                            <path
                                d="M128 170.667L213.333 256L128 341.333"
                                className="stroke-app-accent"
                                strokeWidth="64"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            />
                            <path
                                d="M256 341.333H384"
                                className="stroke-app-text"
                                strokeWidth="64"
                                strokeLinecap="round"
                            />
                        </g>
                    </svg>
                </div>
            </div>
            <div className="zync-splash-meta flex flex-col items-center">
                <div className="zync-splash-title">Zync</div>
            </div>
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
    const cancelConnect = useAppStore(state => state.cancelConnect);
    const terminalTransparencyEnabled = useAppStore(
        state => state.settings.enableVibrancy && (state.settings.windowOpacity ?? 1) < 1
    );

    // Connection Selectors - Optimized
    const connection = useAppStore(useShallow(state => state.connections.find(c => c.id === tab.connectionId)));

    // Plugin panels
    const { panels: pluginPanels } = usePlugins();
    const workspacePluginPanels = useMemo(
        () => pluginPanels.map(p => ({ id: p.id, title: p.title })),
        [pluginPanels],
    );

    // Terminal Store Selectors - Optimized
    const createTerminal = useAppStore(state => state.createTerminal);
    const closeTerminalGroup = useAppStore(state => state.closeTerminalGroup);
    const setActiveTerminal = useAppStore(state => state.setActiveTerminal);
    const canvasSplit = useAppStore((state) => {
        if (!tab.connectionId) return false;
        const layout = layoutForCanvas(
            state.paneLayouts[tab.connectionId],
            state.activeTerminalIds[tab.connectionId],
            state.activePaneGroupOwner[tab.connectionId],
        );
        return isSplitLayout(layout);
    });

    // Feature Pinning
    const toggleConnectionFeature = useAppStore(state => state.toggleConnectionFeature);
    const localPinnedFeatures = useAppStore(state => state.settings.localTerm?.pinnedFeatures);

    // Local state for open feature tabs.
    // The screen unmounts on host switch, so seed from panes that stayed in the store.
    const [openFeatures, setOpenFeatures] = useState<string[]>([]);
    const [featureTabSeed] = useState(() => {
        const connectionId = tab.connectionId;
        const state = useAppStore.getState();
        return initialFeatureTabsForView(
            tab.view,
            connectionId ? state.paneLayouts[connectionId] : undefined,
            connectionId ? state.activePaneGroupOwner[connectionId] : null,
            newWorkspaceFeatureTab,
        );
    });
    const [featureTabs, setFeatureTabs] = useState<WorkspaceFeatureTab[]>(() => featureTabSeed.tabs);
    const [activeFeatureTabId, setActiveFeatureTabId] = useState<string | null>(() => featureTabSeed.activeId);
    const paneGroups = useAppStore(state => (
        tab.connectionId ? state.paneLayouts[tab.connectionId] : undefined
    ));
    /** Heavy panels stay mounted after first visit; CSS hide avoids remount + reconcile cost. */


    // Snippet quick access overlay state
    const [isSnippetSidebarOpen, setIsSnippetSidebarOpen] = useState(false);

    const dockSurfaceRef = useRef<HTMLDivElement>(null);
    const viewBeforeDockRef = useRef<string | null>(null);
    const dockInSplit = useAppStore((state) => state.dockInSplit);
    const showToast = useAppStore((state) => state.showToast);

    // Effect hooks must be unconditional
    // Ensure pinned feature kinds and restored split instances have inventory tabs.
    const pinnedFeatures = tab.connectionId === LOCAL_TERMINAL_CONNECTION_ID ? (localPinnedFeatures || EMPTY_ARRAY) : (connection?.pinnedFeatures || EMPTY_ARRAY);

    useEffect(() => {
        if (isSplitFeatureId(tab.view)) {
            const active = featureTabs.find(item => item.id === activeFeatureTabId && item.featureId === tab.view)
                ?? featureTabs.find(item => item.featureId === tab.view);
            if (active) {
                if (activeFeatureTabId !== active.id) setActiveFeatureTabId(active.id);
                return;
            }
            const fromPanes = featureTabsFromPaneGroups(paneGroups);
            const forView = fromPanes.filter(item => item.featureId === tab.view);
            if (forView.length > 0) {
                setFeatureTabs(prev => mergeFeatureTabs(prev, fromPanes));
                const owner = tab.connectionId
                    ? useAppStore.getState().activePaneGroupOwner[tab.connectionId]
                    : null;
                const nextActiveId = preferredFeatureTabId(forView, tab.view, paneGroups, owner);
                if (activeFeatureTabId !== nextActiveId) setActiveFeatureTabId(nextActiveId);
                return;
            }
            const created = newWorkspaceFeatureTab(tab.view);
            setFeatureTabs(prev => [...prev, created]);
            setActiveFeatureTabId(created.id);
            return;
        }
        if (tab.view?.startsWith('plugin:') && !pinnedFeatures.includes(tab.view)) {
            setOpenFeatures(prev => {
                if (!prev.includes(tab.view)) {
                    return [...prev, tab.view];
                }
                return prev;
            });
        }
    }, [activeFeatureTabId, featureTabs, paneGroups, pinnedFeatures, tab.connectionId, tab.view]);

    useEffect(() => {
        const pinnedTabs = pinnedFeatures
            .filter(isSplitFeatureId)
            .map(featureId => newWorkspaceFeatureTab(featureId, `pinned:${featureId}`));
        setFeatureTabs(prev => {
            const existing = new Set(prev.map(item => item.id));
            const additions = pinnedTabs.filter(item => !existing.has(item.id));
            return additions.length > 0 ? [...prev, ...additions] : prev;
        });
    }, [pinnedFeatures]);

    useEffect(() => {
        const grouped = featureTabsFromPaneGroups(paneGroups);
        if (grouped.length === 0) return;
        setFeatureTabs(prev => mergeFeatureTabs(prev, grouped));
    }, [paneGroups]);

    useEffect(() => {
        if (!tab.connectionId) return;
        for (const featureTab of featureTabs) {
            if (!isSplitFeatureId(featureTab.featureId) || !featureTab.instanceId) continue;
            useAppStore.getState().ensureFeaturePane(
                tab.connectionId,
                featureTab.featureId,
                featureTab.instanceId,
            );
        }
    }, [featureTabs, tab.connectionId]);

    useEffect(() => {
        if (tab.view === 'files') {
            window.dispatchEvent(new CustomEvent('zync:files-panel-show'));
        }
    }, [tab.view]);

    // Listen for keyboard shortcut events to open features
    const handleOpenFeature = useCallback((feature: string) => {
        if (isSplitFeatureId(feature)) {
            const created = newWorkspaceFeatureTab(feature);
            if (feature === 'files' && tab.connectionId) {
                const current = featureTabs.find(item => item.id === activeFeatureTabId && item.featureId === 'files');
                useAppStore.getState().copyFilesListing(
                    tab.connectionId,
                    current?.instanceId,
                    created.instanceId,
                );
            }
            setFeatureTabs(prev => [...prev, created]);
            setActiveFeatureTabId(created.id);
            if (tab.connectionId) {
                const store = useAppStore.getState();
                store.ensureFeaturePane(tab.connectionId, feature, created.instanceId);
                store.activatePaneGroup(tab.connectionId, created.instanceId);
            }
            setTabView(tab.id, feature);
            return;
        }
        setOpenFeatures(prev => {
            if (!prev.includes(feature) && !pinnedFeatures.includes(feature)) {
                return [...prev, feature];
            }
            return prev;
        });
        setTabView(tab.id, feature as Tab['view']);
    }, [activeFeatureTabId, featureTabs, pinnedFeatures, setTabView, tab.connectionId, tab.id]);

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

    if (tab.type === 'public-urls') {
        return (
            <div className={cn(
                "absolute inset-0 z-10 bg-app-bg",
                !isActive && "hidden",
                isActive && "animate-in fade-in zoom-in-95 duration-200"
            )}>
                <Suspense fallback={<TabLoading />}>
                    <PublicUrlsPanel />
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

    if (tab.type === 'vault') {
        return (
            <div className={cn(
                "absolute inset-0 z-10 bg-app-bg",
                !isActive && "hidden",
                isActive && "animate-in fade-in slide-in-from-bottom-2 duration-200"
            )}>
                <Suspense fallback={<VaultWorkspaceLoading />}>
                    <VaultWorkspacePanel profileId={tab.vaultProfileId} />
                </Suspense>
            </div>
        );
    }

    if (tab.type === 'sync') {
        return (
            <div className={cn(
                "absolute inset-0 z-10 bg-app-bg",
                !isActive && "hidden",
                isActive && "animate-in fade-in slide-in-from-bottom-2 duration-200"
            )}>
                <Suspense fallback={<TabLoading />}>
                    <SyncBackupWorkspacePanel />
                </Suspense>
            </div>
        );
    }

    if (!tab.connectionId) {
        return null;
    }

    const isConnecting = connection?.status === 'connecting';
    const isError = connection?.status === 'error';
    const { stage, visible: stageVisible, showWorkspace } = useConnectionStageOverlay(
        Boolean(isConnecting),
        Boolean(isError),
    );
    const forceOpaqueShell = isConnecting || isError || Boolean(stage);

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

        const isShellTabSwitch = view === 'terminal' && Boolean(termId);
        if (isShellTabSwitch && termId && tab.connectionId) {
            const currentView = useAppStore.getState().tabs.find(t => t.id === tab.id)?.view;
            if (currentView !== 'terminal') {
                setTabView(tab.id, 'terminal');
            }
            setActiveTerminal(tab.connectionId, termId);
            return;
        }
        if (isSplitFeatureId(view)) {
            const selected = featureTabs.find(item => item.id === activeFeatureTabId && item.featureId === view)
                ?? featureTabs.find(item => item.featureId === view);
            if (selected) setActiveFeatureTabId(selected.id);
        }
        setTabView(tab.id, view);
        if (view === 'terminal' && termId && tab.connectionId) {
            setActiveTerminal(tab.connectionId, termId);
        }
    }, [activeFeatureTabId, featureTabs, pluginPanels, setTabView, tab.id, tab.connectionId, setActiveTerminal]);

    const handleFeatureClose = useCallback((feature: string) => {
        setOpenFeatures(prev => prev.filter(f => f !== feature));
        // If we closed the active view, switch back to terminal
        if (tab.view === feature) {
            setTabView(tab.id, 'terminal');
        }
    }, [setOpenFeatures, tab.view, tab.id, setTabView]);

    const handleFeatureTabSelect = useCallback((featureTabId: string, featureId: FeatureId) => {
        setActiveFeatureTabId(featureTabId);
        const featureTab = featureTabs.find(item => item.id === featureTabId);
        if (tab.connectionId && isSplitFeatureId(featureId) && featureTab?.instanceId) {
            const store = useAppStore.getState();
            store.ensureFeaturePane(tab.connectionId, featureId, featureTab.instanceId);
            const groups = store.paneLayouts[tab.connectionId];
            const layout = layoutForFeatureInstance(groups, featureTab.instanceId);
            if (layout) {
                const owner = Object.entries(groups ?? {}).find((entry) => entry[1] === layout)?.[0];
                if (owner) store.activatePaneGroup(tab.connectionId, owner);
            }
        }
        setTabView(tab.id, featureId);
    }, [featureTabs, setTabView, tab.connectionId, tab.id]);

    const handleFeatureTabClose = useCallback((featureTabId: string, featureId: FeatureId) => {
        const closing = featureTabs.find(item => item.id === featureTabId);
        if (tab.connectionId && closing?.instanceId) {
            const store = useAppStore.getState();
            const groups = store.paneLayouts[tab.connectionId];
            const layout = layoutForFeatureInstance(groups, closing.instanceId);
            if (layout) {
                const owner = Object.entries(groups ?? {}).find(([, candidate]) => candidate === layout)?.[0];
                const pane = collectLeaves(layout.root).find(leaf => (
                    isFeatureContent(leaf.content)
                    && leaf.content.instanceId === closing.instanceId
                ));
                if (owner && pane) {
                    if (isSplitLayout(layout)) {
                        store.closePaneInSplit(tab.connectionId, pane.id);
                    } else {
                        store.closePaneGroup(tab.connectionId, owner);
                    }
                }
            }
        }
        const closingIndex = featureTabs.findIndex(item => item.id === featureTabId);
        const next = featureTabs.filter(item => item.id !== featureTabId);
        setFeatureTabs(next);
        if (activeFeatureTabId === featureTabId) {
            const fallback = next[Math.min(closingIndex, next.length - 1)]
                ?? [...next].reverse().find(item => item.featureId === featureId);
            if (fallback) {
                handleFeatureTabSelect(fallback.id, fallback.featureId);
            } else {
                setActiveFeatureTabId(null);
                setTabView(tab.id, 'terminal');
            }
        }
    }, [activeFeatureTabId, featureTabs, handleFeatureTabSelect, setTabView, tab.connectionId, tab.id]);

    const handlePaneGroupClose = useCallback((owner: string) => {
        if (!tab.connectionId) return;
        const store = useAppStore.getState();
        const layout = store.paneLayouts[tab.connectionId]?.[owner];
        if (!layout) return;

        const leaves = collectLeaves(layout.root);
        const closedFeatureInstances = new Set(leaves.flatMap(leaf => (
            isFeatureContent(leaf.content) && leaf.content.instanceId
                ? [leaf.content.instanceId]
                : []
        )));
        const closedLegacyFeatures = new Set(leaves.flatMap(leaf => (
            isFeatureContent(leaf.content) && !leaf.content.instanceId
                ? [leaf.content.featureId]
                : []
        )));
        const closedPlugins = new Set(leaves.flatMap(leaf => (
            isPluginContent(leaf.content) ? [leaf.content.pluginId] : []
        )));
        const firstClosedFeatureIndex = featureTabs.findIndex(item => (
            closedFeatureInstances.has(item.instanceId)
            || closedLegacyFeatures.has(item.featureId)
        ));
        const remainingFeatureTabs = featureTabs.filter(item => (
            !closedFeatureInstances.has(item.instanceId)
            && !closedLegacyFeatures.has(item.featureId)
        ));
        const remainingPlugins = openFeatures.filter(featureId => (
            !featureId.startsWith('plugin:')
            || !closedPlugins.has(featureId.slice('plugin:'.length))
        ));

        setFeatureTabs(remainingFeatureTabs);
        setOpenFeatures(remainingPlugins);
        store.closePaneGroup(tab.connectionId, owner);
        const groupsAfterClose = useAppStore.getState().paneLayouts[tab.connectionId];

        const fallbackFeatureIndex = firstClosedFeatureIndex < 0
            ? remainingFeatureTabs.length - 1
            : Math.min(firstClosedFeatureIndex, remainingFeatureTabs.length - 1);
        const fallbackFeature = remainingFeatureTabs[Math.max(0, fallbackFeatureIndex)];
        if (fallbackFeature) {
            setActiveFeatureTabId(fallbackFeature.id);
            const fallbackLayout = layoutForFeatureInstance(
                groupsAfterClose,
                fallbackFeature.instanceId,
            );
            if (fallbackLayout && isSplitLayout(fallbackLayout)) {
                const fallbackOwner = Object.entries(groupsAfterClose ?? {})
                    .find(([, candidate]) => candidate === fallbackLayout)?.[0];
                if (fallbackOwner) store.activatePaneGroup(tab.connectionId, fallbackOwner);
                setTabView(tab.id, 'terminal');
                return;
            }
            setTabView(tab.id, fallbackFeature.featureId);
            return;
        }
        setActiveFeatureTabId(null);
        const fallbackPlugin = remainingPlugins.find(featureId => featureId.startsWith('plugin:'));
        if (fallbackPlugin) {
            const pluginId = fallbackPlugin.slice('plugin:'.length);
            const fallbackGroup = Object.entries(groupsAfterClose ?? {})
                .find(([, candidate]) => isSplitLayout(candidate) && layoutHasPlugin(candidate, pluginId));
            if (fallbackGroup) {
                store.activatePaneGroup(tab.connectionId, fallbackGroup[0]);
                setTabView(tab.id, 'terminal');
                return;
            }
        }
        setTabView(tab.id, (fallbackPlugin ?? 'terminal') as Tab['view']);
    }, [featureTabs, openFeatures, setTabView, tab.connectionId, tab.id]);

    const handleFeaturePaneOpened = useCallback((_feature: string) => {
    }, []);

    const restoreViewBeforeDock = useCallback(() => {
        const previous = viewBeforeDockRef.current;
        viewBeforeDockRef.current = null;
        if (previous && previous !== 'terminal') {
            setTabView(tab.id, previous as Tab['view']);
        }
    }, [setTabView, tab.id]);

    const dockPointer = useMemo<DockTabPointerHandlers>(() => ({
        getSurface: () => dockSurfaceRef.current,
        onDragStart: (payload) => {
            if (canvasSplit) {
                viewBeforeDockRef.current = null;
                if (tab.view !== 'terminal') setTabView(tab.id, 'terminal');
                return;
            }
            if (tab.view !== 'terminal') {
                viewBeforeDockRef.current = tab.view;
                if (payload.kind === 'term') return;
                if (payload.kind === 'feature' && tab.view === payload.featureId) return;
                if (payload.kind === 'plugin' && tab.view === `plugin:${payload.pluginId}`) return;
                setTabView(tab.id, 'terminal');
            } else {
                viewBeforeDockRef.current = null;
            }
        },
        onDragEnd: (payload, edge, paneId) => {
            if (!edge || !tab.connectionId) {
                restoreViewBeforeDock();
                return;
            }
            const overlayFeature = parseOverlayFeatureId(paneId);
            const overlayPlugin = parseOverlayPluginId(paneId);
            const overlayFeatureTab = overlayFeature
                ? featureTabs.find(item => item.id === activeFeatureTabId && item.featureId === overlayFeature)
                : undefined;
            const overlayTargetContent = overlayFeature
                ? { kind: 'feature' as const, featureId: overlayFeature, instanceId: overlayFeatureTab?.instanceId }
                : overlayPlugin
                    ? { kind: 'plugin' as const, pluginId: overlayPlugin }
                    : undefined;
            const result = dockInSplit(tab.connectionId, payload, edge, paneId, undefined, overlayTargetContent);
            if (result === 'refused-cap') {
                showToast('info', 'This tab already has 4 panes.');
                restoreViewBeforeDock();
                return;
            }
            if (result === 'self' || result === 'no-target') {
                restoreViewBeforeDock();
                return;
            }
            viewBeforeDockRef.current = null;
            if (payload.kind === 'feature' || payload.kind === 'plugin' || overlayTargetContent) {
                setTabView(tab.id, 'terminal');
            }
        },
        onDragCancel: () => {
            restoreViewBeforeDock();
        },
    }), [activeFeatureTabId, canvasSplit, dockInSplit, featureTabs, restoreViewBeforeDock, setTabView, showToast, tab.connectionId, tab.id, tab.view]);

    const handleTogglePin = useCallback((feature: string) => {
        if (tab.connectionId) {
            toggleConnectionFeature(tab.connectionId, feature);
            if (!isSplitFeatureId(feature)) {
                if (pinnedFeatures.includes(feature)) {
                    if (!openFeatures.includes(feature)) setOpenFeatures(prev => [...prev, feature]);
                } else {
                    setOpenFeatures(prev => prev.filter(f => f !== feature));
                }
            }
        }
    }, [tab.connectionId, toggleConnectionFeature, pinnedFeatures, openFeatures, setOpenFeatures]);

    const handleTerminalClose = useCallback((termId: string) => {
        if (tab.connectionId) {
            closeTerminalGroup(tab.connectionId, termId);
        }
    }, [tab.connectionId, closeTerminalGroup]);

    const handleNewTerminal = useCallback((shell?: ShellEntry) => {
        if (!tab.connectionId) return;
        if (shell) {
            createTerminal(tab.connectionId, { shellOverride: shell.id, title: shell.label });
        } else if (
            tab.connectionId === LOCAL_TERMINAL_CONNECTION_ID
            && window.electronUtils?.platform === 'win32'
        ) {
            // Windows only: stamp settings default so tab icons do not track later Default Shell changes.
            const raw = useAppStore.getState().settings.localTerm?.windowsShell;
            const shellId = resolveLocalWindowsShellId(raw);
            createTerminal(tab.connectionId, { shellOverride: shellId });
        } else {
            createTerminal(tab.connectionId);
        }
        setTabView(tab.id, 'terminal');
    }, [tab.connectionId, createTerminal, tab.id, setTabView]);

    // Ensure we start with at least 'terminal' available conceptually, 
    // though combined bar renders terminals from store.

    // Each tab content is rendered but hidden if not active
    return (
        <div className={cn(
            "absolute inset-0 flex flex-col transition-all",
            forceOpaqueShell || !(tab.view === 'terminal' && terminalTransparencyEnabled)
                ? "bg-app-bg"
                : "bg-transparent",
            !isActive && "hidden",
            isActive && !forceOpaqueShell && "animate-in fade-in duration-150 ease-out fill-mode-forwards"
        )}>
            {showWorkspace && (
                <>
                    {/* Unified Tab Bar — not shown for the standalone global snippets tab */}
                    {tab.connectionId !== GLOBAL_SNIPPETS_CONNECTION_ID && (
                        <WorkspaceTabBar
                            connectionId={tab.connectionId}
                            tabId={tab.id}
                            activeView={tab.view}
                            openFeatures={openFeatures}
                            featureTabs={featureTabs}
                            activeFeatureTabId={activeFeatureTabId}
                            pinnedFeatures={pinnedFeatures}
                            pluginPanels={workspacePluginPanels}
                            onTabSelect={handleTabSelect}
                            onFeatureClose={handleFeatureClose}
                            onFeatureTabSelect={handleFeatureTabSelect}
                            onFeatureTabClose={handleFeatureTabClose}
                            onTerminalClose={handleTerminalClose}
                            onNewTerminal={handleNewTerminal}
                            onOpenFeature={handleOpenFeature}
                            onFeaturePaneOpened={handleFeaturePaneOpened}
                            onPaneGroupClose={handlePaneGroupClose}
                            onTogglePin={handleTogglePin}
                            sessionToolsOpen={isSnippetSidebarOpen}
                            onToggleSessionTools={() => setIsSnippetSidebarOpen((open) => !open)}
                            dockPointer={dockPointer}
                        />
                    )}

                    {/* Content Area */}
                    <div ref={dockSurfaceRef} className="flex-1 overflow-hidden relative flex flex-col">
                        <Suspense fallback={<TabLoading />}>
                            {/* Plugin Panels */}
                            {pluginPanels.map(panel => {
                                const viewId = `plugin:${panel.id}`;
                                if (tab.view !== viewId) return null;
                                // Race condition check: obtain latest ID from store to ensure we haven't switched tabs
                                if (tab.connectionId !== useAppStore.getState().activeConnectionId) return null;
                                return (
                                    <div
                                        key={panel.id}
                                        data-pane-id={overlayPluginPaneId(panel.id)}
                                        className="absolute inset-0 z-10 bg-app-bg"
                                    >
                                        <PluginPanel
                                            html={panel.html}
                                            panelId={panel.id}
                                            pluginId={panel.pluginId}
                                            connectionId={tab.connectionId || null}
                                        />
                                    </div>
                                );
                            })}

                            {/* 
                                Terminal View
                                Pass hideTabs={true} to disable its internal tab bar
                            */}
                            <div
                                className={cn(
                                    "absolute inset-0 z-20",
                                    tab.view.startsWith('plugin:') && "hidden",
                                    terminalTransparencyEnabled && !forceOpaqueShell ? "bg-transparent" : "bg-app-bg"
                                )}
                            >
                                <TerminalManager
                                    connectionId={tab.connectionId}
                                    isWorkspaceActive={isActive}
                                    isTerminalView
                                    hideTabs={true}
                                    dockPointer={dockPointer}
                                    featureInstanceId={
                                        isSplitFeatureId(tab.view)
                                            ? (featureTabs.find(item => item.id === activeFeatureTabId)?.instanceId)
                                            : undefined
                                    }
                                />
                            </div>

                            <SnippetSidebar
                                connectionId={tab.connectionId}
                                tabId={tab.id}
                                isOpen={isSnippetSidebarOpen}
                                onClose={() => setIsSnippetSidebarOpen(false)}
                                restoreTerminalFocus={tab.view === 'terminal'}
                            />

                            <TabDockOverlay />

                        </Suspense>
                    </div>
                </>
            )}
            {stage && (
                <div
                    className={cn(
                        'absolute inset-0 z-40 flex flex-col bg-app-bg transition-opacity duration-200 ease-out',
                        stageVisible ? 'opacity-100' : 'opacity-0 pointer-events-none',
                    )}
                >
                    <ConnectStagePanel
                        status={stage}
                        name={connection?.name ?? tab.title}
                        host={connection?.host}
                        icon={connection?.icon}
                        lastError={connection?.lastError}
                        onCancel={() => {
                            if (connection) void cancelConnect(connection.id);
                        }}
                        onRetry={() => {
                            if (connection) void connect(connection.id);
                        }}
                    />
                </div>
            )}
        </div>
    );
});

export function MainLayout({ children }: { children: ReactNode }) {
    useFileSystemEvents(); // Enable global FS event listeners

    const tabs = useAppStore(state => state.tabs);
    const activeTabId = useAppStore(state => state.activeTabId);
    const activeWorkspaceTab = useMemo(
        () => (activeTabId !== null ? tabs.find((t: Tab) => t.id === activeTabId) : undefined),
        [tabs, activeTabId],
    );
    /** Sync stays mounted after first open so restore/upload spinners and in-flight IPC survive tab switches. */
    const stickySyncTabs = useMemo(
        () => tabs.filter((tab: Tab) => tab.type === 'sync'),
        [tabs],
    );
    const suspendIdleHostPtys = useAppStore(
        state => state.settings.terminal.suspendIdleHostPtys ?? false,
    );
    const idleHostPtySuspendMinutes = useAppStore(
        state => state.settings.terminal.idleHostPtySuspendMinutes ?? 2,
    );
    const prevWorkspaceConnectionIdRef = useRef<string | null>(null);

    useEffect(() => {
        const delayMs = resolveIdleHostPtySuspendDelayMs(
            suspendIdleHostPtys,
            idleHostPtySuspendMinutes,
        );
        const nextConnectionId = activeWorkspaceTab?.connectionId ?? null;
        const prevConnectionId = prevWorkspaceConnectionIdRef.current;

        if (delayMs === null) {
            cancelAllIdlePtySuspends();
        } else {
            if (
                prevConnectionId
                && prevConnectionId !== nextConnectionId
                && shouldIdleSuspendConnection(prevConnectionId)
            ) {
                const prevTabs = useAppStore.getState().terminals[prevConnectionId];
                scheduleIdlePtySuspend(prevConnectionId, prevTabs, { delayMs });
            }

            if (nextConnectionId) {
                cancelIdlePtySuspend(nextConnectionId);
            }
        }

        prevWorkspaceConnectionIdRef.current = nextConnectionId;
    }, [
        activeWorkspaceTab?.connectionId,
        suspendIdleHostPtys,
        idleHostPtySuspendMinutes,
    ]);

    useEffect(() => () => cancelAllIdlePtySuspends(), []);

    useEffect(() => {
        terminalService.setCloseTabHandler((connectionId, termId) => {
            const store = useAppStore.getState();
            const resolved = resolveShellExitConnectionId(termId, connectionId || undefined, store.terminals);
            if (resolved) {
                store.closePaneOnShellExit(resolved, termId);
            }
        });
        return () => terminalService.setCloseTabHandler(null);
    }, []);

    useEffect(() => registerTunnelTransportLostListener(), []);

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
    const updateSurveySettings = useAppStore(state => state.updateSurveySettings);
    const setSidebarCollapsedLocal = useAppStore(state => state.setSidebarCollapsedLocal);
    const [surveyPrompt, setSurveyPrompt] = useState<{ kind: SurveyPromptKind; version: string } | null>(null);
    const surveyChecked = useRef(false);
    /** Pre-update lastSeenVersion captured before release-notes boot rewrites it. */
    const surveyPreviousVersionRef = useRef<string | null>(null);

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

    // Auto-collapse sidebar on tablet/mobile if it was open (session only — do not persist).
    const initialCollapseRef = useRef(false);
    useEffect(() => {
        if (!initialCollapseRef.current && !isLoadingSettings && isTablet && !sidebarCollapsed) {
            setSidebarCollapsedLocal(true);
            initialCollapseRef.current = true;
        }
    }, [isTablet, setSidebarCollapsedLocal, isLoadingSettings, sidebarCollapsed]);

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

        // Capture synchronously before any await / lastSeenVersion rewrite so survey
        // can tell "upgraded from older build" vs "brand-new install".
        surveyPreviousVersionRef.current = useAppStore.getState().settings.lastSeenVersion || '';

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

    // Profile survey: one-shot only (new install, or first upgrade into a survey-enabled build).
    useEffect(() => {
        if (isLoadingSettings || !sessionLoaded || surveyChecked.current) return;
        surveyChecked.current = true;

        const state = useAppStore.getState();
        const survey = normalizeSurveySettings(state.settings.survey);
        const previousSeenVersion =
            surveyPreviousVersionRef.current
            ?? (state.settings.lastSeenVersion || '');

        const maybeShowSurvey = async () => {
            try {
                const currentVersion = await window.ipcRenderer?.invoke('app:getVersion');
                if (!currentVersion || typeof currentVersion !== 'string') return;

                const debugKind = isDebugSurveyPromptEnabled()
                    ? (getDebugSurveyPromptKind() ?? 'install')
                    : null;
                const kind = debugKind ?? resolveSurveyPromptKind(survey, currentVersion, previousSeenVersion);
                if (!kind) return;

                if (kind === 'release' && !debugKind) {
                    // Prefer showing after What's New is closed (max ~8s).
                    const started = Date.now();
                    await new Promise<void>((resolve) => {
                        const tick = () => {
                            const activeId = useAppStore.getState().activeTabId;
                            const active = useAppStore.getState().tabs.find((tab) => tab.id === activeId);
                            const notesOpen = active?.type === 'release-notes';
                            if (!notesOpen || Date.now() - started > 8000) {
                                resolve();
                                return;
                            }
                            window.setTimeout(tick, 350);
                        };
                        window.setTimeout(tick, 600);
                    });
                } else {
                    await new Promise((resolve) => window.setTimeout(resolve, 900));
                }

                setSurveyPrompt({ kind, version: currentVersion });
            } catch (err) {
                console.error('Failed to resolve survey prompt', err);
            }
        };

        void maybeShowSurvey();
    }, [isLoadingSettings, sessionLoaded]);

    const handleSurveyCompleted = useCallback(async (
        result: 'submitted' | 'skipped',
        prefs?: { lastRole?: string; lastWorkContext?: string; lastDiscoverySource?: string },
    ) => {
        const prompt = surveyPrompt;
        setSurveyPrompt(null);
        if (!prompt) return;
        try {
            const prefPatch = result === 'submitted'
                ? {
                    lastRole: prefs?.lastRole ?? '',
                    lastWorkContext: prefs?.lastWorkContext ?? '',
                    lastDiscoverySource: prefs?.lastDiscoverySource ?? '',
                }
                : {};
            // Always mark installCompleted so later releases never re-prompt.
            await updateSurveySettings({
                installCompleted: true,
                releaseSeenVersion: prompt.version,
                ...prefPatch,
            });
        } catch (err) {
            console.error(`Failed to persist survey ${result} state`, err);
        }
    }, [surveyPrompt, updateSurveySettings]);

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

    useLayoutEffect(() => {
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

        // Apply custom accent override, or clear inline overrides so theme CSS wins.
        if (accentColor) {
            document.body.style.setProperty('--color-app-accent', accentColor);
            document.documentElement.style.setProperty('--color-app-accent', accentColor);
            localStorage.setItem('zync-accent-color', accentColor);
        } else {
            document.body.style.removeProperty('--color-app-accent');
            document.documentElement.style.removeProperty('--color-app-accent');
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

        refreshAllCachedTerminalThemes();

        window.requestAnimationFrame(() => {
            persistBootThemeColors();
            refreshAllCachedTerminalThemes();
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

    useEffect(() => {
        const refreshAfterRegistry = () => {
            refreshAllCachedTerminalThemes();
        };
        window.addEventListener('zync:theme-registry-ready', refreshAfterRegistry);
        return () => window.removeEventListener('zync:theme-registry-ready', refreshAfterRegistry);
    }, []);

    const hideBootSplash = useCallback(() => {
        try {
            if (typeof window.__zyncHideBootSplash === 'function') {
                // Owns fade + delayed remove — do not hard-remove here or exit animation is skipped.
                window.__zyncHideBootSplash();
                return;
            }
        } catch (e) {
            console.warn('Error in __zyncHideBootSplash:', e);
        }
        document.getElementById('boot-splash')?.remove();
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
                !isMaximized && "rounded-xl border border-app-border/90 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),inset_0_0_0_1px_rgba(0,0,0,0.35)]",
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
                        {tabs.length > 0 && !showWelcomeScreen && activeWorkspaceTab ? (
                            <>
                                {stickySyncTabs.map((tab: Tab) => (
                                    <TabContent
                                        key={tab.id}
                                        tab={tab}
                                        isActive={tab.id === activeWorkspaceTab.id}
                                    />
                                ))}
                                {activeWorkspaceTab.type !== 'sync' && (
                                    <TabContent
                                        key={activeWorkspaceTab.id}
                                        tab={activeWorkspaceTab}
                                        isActive
                                    />
                                )}
                            </>
                        ) : (
                            <div className="flex-1 bg-app-bg">{children}</div>
                        )}
                    </div>
                </div>

                {/* AI Assistant Right Sidebar */}
                <AiSidebar
                    connectionId={
                        showWelcomeScreen || !activeWorkspaceTab
                            ? null
                            : activeWorkspaceTab.connectionId ?? null
                    }
                    onRunCommand={handleAiRunCommand}
                />
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

            <SurveyPromptModal
                open={Boolean(surveyPrompt)}
                kind={surveyPrompt?.kind ?? 'install'}
                appVersion={surveyPrompt?.version ?? ''}
                prefill={normalizeSurveySettings(settings.survey)}
                onCompleted={(result, prefs) => { void handleSurveyCompleted(result, prefs); }}
            />
        </div >
    );
}

