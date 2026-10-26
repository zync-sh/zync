import { ReactNode, lazy, Suspense, useState, useEffect, useLayoutEffect, memo, useCallback, useRef, useMemo } from 'react';
import { Sidebar } from './Sidebar';
import { WorkspaceNavigationFrame } from './navigation/WorkspaceNavigationFrame';
import { sidebarPresentation, setSidebarVisibility } from '../../features/workspace/application/sidebarPresentation';
import { HostWorkspaceFrame } from './navigation/HostWorkspaceFrame';
import { useRetainedItems } from './useRetainedItems';
import { retainedItemsInMountOrder } from './retainedItems';
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
import { usePluginPaneNavigation } from './usePluginPaneNavigation';
import { useFeaturePaneNavigation } from './useFeaturePaneNavigation';
import { WorkspaceContextActions } from '../workspace/WorkspaceContextActions';
import {
    TabDockOverlay,
    type DockTabPointerHandlers,
} from './tabDock';
import { collectLeaves, isFeatureContent, isPluginContent, isSplitFeatureId, isSplitLayout, layoutForPlugin, layoutForFeatureInstance, paneContentKey } from '../../lib/paneLayout';
import { featureTabsFromPaneGroups, stablePluginPanelInventory } from './featureTabInventory';
import type { ShellEntry } from '../../lib/shells/types';
import type { FeatureId, WorkspaceFeatureTab } from './featureMeta';
import { deriveWorkspaceContentInventory, findWorkspaceContentPane } from '../../features/workspace/domain/contentInventory';
import { hiddenWorkspaceContent, selectedWorkspaceContentId, visibleContentFallback } from '../../features/workspace/domain/visibleContent';
import { selectExistingWorkspaceContent } from '../../features/workspace/application/selectExistingContent';
import { workspaceCanvases } from '../../features/workspace/domain/canvases';
import { paneTabReleaseSource, planPaneTabInsertion } from '../../features/workspace/domain/paneTabRelease';
import { listenWorkspacePresentationActions } from '../../features/shortcuts/workspacePresentation';
import { GLOBAL_SNIPPETS_CONNECTION_ID, LOCAL_TERMINAL_CONNECTION_ID } from '../../features/connections/application/tabService';
import { listen } from '@tauri-apps/api/event';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { ShieldAlert, Loader2 } from 'lucide-react';
import { ConnectStagePanel, PanelLoader, useConnectionStageOverlay } from '../loaders';
import { SurveyPromptModal } from '../survey/SurveyPromptModal';
import { SurveyReminderButton } from '../survey/SurveyReminderButton';
import { FeedbackInbox } from '../../features/feedbackInbox/FeedbackInbox';
import {
    normalizeSurveySettings,
    initializeSurveyIdentity,
    resolveSurveyExperience,
    type SurveyPromptKind,
} from '../../features/survey';
import { getDebugSurveyPromptKind, isDebugSurveyPromptEnabled } from '../../lib/debugFlags';
import ReleaseNotesTab from '../tabs/ReleaseNotesTab';

import { SnippetSidebar } from '../snippets/SnippetSidebar';
import { SetupWizard } from '../onboarding/SetupWizard';
import { useFileSystemEvents } from '../../hooks/useFileSystemEvents';
import { AiSidebar } from '../ai/AiSidebar';
import { ModalRoot } from '../ui/ModalRoot';
import { LayoutMotionScope } from '../ui/LayoutMotion';
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
import { useElementColorStyle } from '../../features/appearance/presentation/useElementColorStyle';
import { useCustomThemeStyle } from '../../features/appearance/presentation/useCustomThemeStyle';
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
const GlobalSecurityAuditsPanel = lazy(() => import('../../features/security/ui/GlobalSecurityAuditsPanel').then(module => ({ default: module.GlobalSecurityAuditsPanel })));
const PublicUrlsPanel = lazy(() => import('../share/PublicUrlsPanel').then(module => ({ default: module.PublicUrlsPanel })));
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
const newFeatureInstanceId = () => `feature-${crypto.randomUUID()}`;
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
    'security',
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
    const { panels: pluginPanels, plugins: installedPlugins } = usePlugins();
    const workspacePluginPanels = useMemo(
        () => stablePluginPanelInventory(pluginPanels, installedPlugins),
        [pluginPanels, installedPlugins],
    );

    // Terminal Store Selectors - Optimized
    const createTerminal = useAppStore(state => state.createTerminal);
    const closeTerminalGroup = useAppStore(state => state.closeTerminalGroup);
    const setActiveTerminal = useAppStore(state => state.setActiveTerminal);

    // Feature Pinning
    const toggleConnectionFeature = useAppStore(state => state.toggleConnectionFeature);
    const localPinnedFeatures = useAppStore(state => state.settings.localTerm?.pinnedFeatures);

    // Selection is local chrome state; the canonical pane tree owns open instances.
    const [activeFeatureTabId, setActiveFeatureTabId] = useState<string | null>(null);
    const paneGroups = useAppStore(state => (
        tab.connectionId ? state.paneLayouts[tab.connectionId] : undefined
    ));
    const featureTabs = useMemo(() => featureTabsFromPaneGroups(paneGroups), [paneGroups]);
    const terminalInventory = useAppStore(state => tab.connectionId ? state.terminals[tab.connectionId] : undefined);
    const presentationScope = useAppStore(state => tab.connectionId ? state.contentPresentation[tab.connectionId] : undefined);
    const selectedOwner = useAppStore(state => tab.connectionId ? state.activePaneGroupOwner[tab.connectionId] : null);
    const selectedTerminal = useAppStore(state => tab.connectionId ? state.activeTerminalIds[tab.connectionId] : null);
    const hiddenIds = useMemo(() => tab.connectionId
        ? hiddenWorkspaceContent(useAppStore.getState(), tab.connectionId) : new Set<string>(),
    [paneGroups, presentationScope, tab.connectionId, terminalInventory]);
    const selectContent = useCallback((id: string) => Boolean(tab.connectionId && selectExistingWorkspaceContent(
        useAppStore.getState(), tab.connectionId, id, setActiveFeatureTabId, view => setTabView(tab.id, view),
    )), [setTabView, tab.connectionId, tab.id]);
    const selectedContentId = useCallback(() => tab.connectionId ? selectedWorkspaceContentId(
        useAppStore.getState(), tab.connectionId,
        isSplitFeatureId(tab.view) ? activeFeatureTabId ?? undefined : undefined,
        isPluginTabView(tab.view) ? tab.view.slice('plugin:'.length) : undefined,
        isSplitFeatureId(tab.view) ? tab.view : undefined,
    ) : null, [activeFeatureTabId, tab.connectionId, tab.view]);
    const setContentHidden = useCallback((id: string, hidden: boolean) => {
        if (!tab.connectionId) return false;
        const selected = selectedContentId();
        if (!useAppStore.getState().setContentHidden(tab.connectionId, id, hidden)) return false;
        if (selected === id && hidden) {
            const fallback = visibleContentFallback(useAppStore.getState(), tab.connectionId, selected);
            if (fallback) selectContent(fallback.id);
        }
        return true;
    }, [selectContent, selectedContentId, tab.connectionId]);
    const revealAllContent = useCallback(() => {
        if (!tab.connectionId) return false;
        const selected = selectedContentId();
        if (!useAppStore.getState().revealAllContent(tab.connectionId)) return false;
        const fallback = visibleContentFallback(useAppStore.getState(), tab.connectionId, selected);
        if (fallback) selectContent(fallback.id);
        return true;
    }, [selectContent, selectedContentId, tab.connectionId]);
    const [contentsOpenRequest, setContentsOpenRequest] = useState(0);
    useEffect(() => {
        if (!isActive || tab.type !== 'connection' || !tab.connectionId) return;
        return listenWorkspacePresentationActions(useAppStore.getState,
            target => target.tabId === tab.id && target.connectionId === tab.connectionId && target.action !== 'customize-tab',
            target => {
                if (target.action === 'contents') setContentsOpenRequest(value => value + 1);
                else if (target.action === 'reveal-all' && !revealAllContent()) useAppStore.getState().showToast('error', 'Hidden panes could not be shown.');
            });
    }, [isActive, revealAllContent, tab.connectionId, tab.id, tab.type]);
    // Restores/guarded closes may leave the selected identity hidden or missing.
    // Repair selection only; all-hidden retains the canonical owner for recovery.
    useEffect(() => {
        if (!isActive || !tab.connectionId) return;
        const selected = selectedContentId();
        if (!selected || !hiddenIds.has(selected)) return;
        const fallback = visibleContentFallback(useAppStore.getState(), tab.connectionId, selected);
        if (fallback) selectContent(fallback.id);
    }, [hiddenIds, isActive, selectedContentId, selectedOwner, selectedTerminal, selectContent, tab.connectionId]);
    /** Heavy panels stay mounted after first visit; CSS hide avoids remount + reconcile cost. */


    // Snippet quick access overlay state
    const [isSnippetSidebarOpen, setIsSnippetSidebarOpen] = useState(false);

    const dockSurfaceRef = useRef<HTMLDivElement>(null);
    const dockInSplit = useAppStore((state) => state.dockInSplit);
    const showToast = useAppStore((state) => state.showToast);

    // Effect hooks must be unconditional
    // Ensure pinned feature kinds and restored split instances have inventory tabs.
    const pinnedFeatures = tab.connectionId === LOCAL_TERMINAL_CONNECTION_ID ? (localPinnedFeatures || EMPTY_ARRAY) : (connection?.pinnedFeatures || EMPTY_ARRAY);
    const leaveMissingPluginView = useCallback(() => setTabView(tab.id, 'terminal'), [setTabView, tab.id]);
    usePluginPaneNavigation({ connectionId: tab.connectionId, view: tab.view, pinnedFeatures, isActive,
        groups: paneGroups, getState: useAppStore.getState, onMissingView: leaveMissingPluginView });

    useFeaturePaneNavigation({ connectionId: tab.connectionId, view: tab.view, pinnedFeatures,
        isActive, groups: paneGroups, activeInstanceId: activeFeatureTabId,
        getState: useAppStore.getState, createInstanceId: newFeatureInstanceId,
        onSelectInstance: setActiveFeatureTabId, onMissingView: leaveMissingPluginView });

    useEffect(() => {
        if (tab.view === 'files') {
            window.dispatchEvent(new CustomEvent('zync:files-panel-show'));
        }
    }, [tab.view]);

    // Listen for keyboard shortcut events to open features
    const handleOpenFeature = useCallback((feature: string) => {
        if (isSplitFeatureId(feature)) {
            const created = newWorkspaceFeatureTab(feature);
            if (tab.connectionId && !useAppStore.getState().ensureFeaturePane(tab.connectionId, feature, created.instanceId)) return;
            if (feature === 'files' && tab.connectionId) {
                const current = featureTabs.find(item => item.id === activeFeatureTabId && item.featureId === 'files');
                useAppStore.getState().copyFilesListing(
                    tab.connectionId,
                    current?.instanceId,
                    created.instanceId,
                );
            }
            setActiveFeatureTabId(created.id);
            if (tab.connectionId) {
                const store = useAppStore.getState();
                store.activatePaneGroup(tab.connectionId, created.instanceId);
            }
            setTabView(tab.id, feature);
            return;
        }
        if (isPluginTabView(feature) && tab.connectionId && !useAppStore.getState().ensurePluginPane(tab.connectionId, feature.slice('plugin:'.length))) return;
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

    // Tab activation only changes visibility; retained content must not replay entry motion.
    // -- Conditional Returns for special tab types (Must be after ALL hooks) --

    if (tab.type === 'port-forwarding') {
        return (
            <div className={cn(
                "absolute inset-0 z-10 bg-app-bg",
                !isActive && "hidden"
            )}>
                <Suspense fallback={<TabLoading />}>
                    <GlobalTunnelList />
                </Suspense>
            </div>
        );
    }

    if (tab.type === 'security-audits') {
        return <div className={cn('absolute inset-0 z-10 bg-app-bg', !isActive && 'hidden')}>
            <Suspense fallback={<TabLoading />}><GlobalSecurityAuditsPanel active={isActive} /></Suspense>
        </div>;
    }

    if (tab.type === 'public-urls') {
        return (
            <div className={cn(
                "absolute inset-0 z-10 bg-app-bg",
                !isActive && "hidden"
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
                !isActive && "hidden"
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
                !isActive && "hidden"
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
                !isActive && "hidden"
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
                !isActive && "hidden"
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
            const pluginExists = workspacePluginPanels.some((panel) => panel.id === pluginId);
            if (!pluginExists) {
                console.warn('[MainLayout] Ignoring plugin tab view without registered panel:', view);
                return;
            }
            if (tab.connectionId) {
                const store = useAppStore.getState();
                if (!store.ensurePluginPane(tab.connectionId, pluginId)) return;
                const groups = useAppStore.getState().paneLayouts[tab.connectionId];
                const layout = layoutForPlugin(groups, pluginId, store.activePaneGroupOwner[tab.connectionId]);
                const owner = Object.entries(groups ?? {}).find(([, candidate]) => candidate === layout)?.[0];
                const pane = layout && collectLeaves(layout.root).find(leaf => isPluginContent(leaf.content) && leaf.content.pluginId === pluginId);
                if (owner && pane) {
                    selectContent(paneContentKey(pane.content, pane.id));
                    return;
                }
            }
        }

        const isShellTabSwitch = view === 'terminal' && Boolean(termId);
        if (isShellTabSwitch && termId && tab.connectionId) {
            const contentId = paneContentKey({ kind: 'term', termId }, termId);
            if (useAppStore.getState().workspaceDocking[tab.connectionId]?.placements[contentId]) {
                selectContent(contentId);
                return;
            }
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
    }, [activeFeatureTabId, featureTabs, workspacePluginPanels, selectContent, setTabView, tab.id, tab.connectionId, setActiveTerminal]);

    const handlePluginTabSelect = useCallback((contentId: string) => {
        if (!tab.connectionId) return;
        const store = useAppStore.getState();
        const current = findWorkspaceContentPane(store.paneLayouts[tab.connectionId], contentId);
        if (!current || !isPluginContent(current.pane.content)) return;
        selectContent(contentId);
    }, [selectContent, tab.connectionId]);

    const handlePluginTabClose = useCallback((contentId: string) => {
        if (!tab.connectionId) return;
        const store = useAppStore.getState();
        const current = findWorkspaceContentPane(store.paneLayouts[tab.connectionId], contentId);
        if (!current || !isPluginContent(current.pane.content)) return;
        const panelId = current.pane.content.pluginId;
        const wasActive = tab.view === `plugin:${panelId}`
            && store.activePaneGroupOwner[tab.connectionId] === current.owner;
        const closed = isSplitLayout(current.layout)
            ? store.closePaneInSplit(tab.connectionId, current.pane.id)
            : store.closePaneGroup(tab.connectionId, current.owner);
        if (!closed) return;
        const remaining = deriveWorkspaceContentInventory([], useAppStore.getState().paneLayouts[tab.connectionId]);
        const siblings = remaining.filter(item => isPluginContent(item.content) && item.content.pluginId === panelId);
        const feature = `plugin:${panelId}`;
        if (siblings.length === 0) {
            if (pinnedFeatures.includes(feature)) toggleConnectionFeature(tab.connectionId, feature);
        }
        if (wasActive) {
            const fallback = siblings[0] ?? remaining.find(item => isPluginContent(item.content));
            if (fallback) handlePluginTabSelect(fallback.id);
            else setTabView(tab.id, 'terminal');
        }
    }, [handlePluginTabSelect, pinnedFeatures, setTabView, tab.connectionId, tab.id, tab.view, toggleConnectionFeature]);

    const handleFeatureTabSelect = useCallback((featureTabId: string, featureId: FeatureId) => {
        if (!tab.connectionId) return;
        const item = deriveWorkspaceContentInventory([], useAppStore.getState().paneLayouts[tab.connectionId])
            .find(item => isFeatureContent(item.content) && item.content.featureId === featureId
                && item.content.instanceId === featureTabId);
        if (item) selectContent(item.id);
    }, [selectContent, tab.connectionId]);

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
                        if (!store.closePaneInSplit(tab.connectionId, pane.id)) return;
                    } else {
                        if (!store.closePaneGroup(tab.connectionId, owner)) return;
                    }
                }
            }
        }
        const closingIndex = featureTabs.findIndex(item => item.id === featureTabId);
        const next = featureTabs.filter(item => item.id !== featureTabId);
        if (tab.view === featureId && activeFeatureTabId === featureTabId) {
            const fallback = next[Math.min(closingIndex, next.length - 1)]
                ?? [...next].reverse().find(item => item.featureId === featureId);
            if (fallback) {
                handleFeatureTabSelect(fallback.id, fallback.featureId);
            } else {
                setActiveFeatureTabId(null);
                setTabView(tab.id, 'terminal');
            }
        }
    }, [activeFeatureTabId, featureTabs, handleFeatureTabSelect, setTabView, tab.connectionId, tab.id, tab.view]);

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
        if (!store.closePaneGroup(tab.connectionId, owner)) return;
        const groupsAfterClose = useAppStore.getState().paneLayouts[tab.connectionId];
        const remainingPluginItems = deriveWorkspaceContentInventory([], groupsAfterClose).filter(item => isPluginContent(item.content));
        const remainingPluginIds = new Set(remainingPluginItems.flatMap(item => isPluginContent(item.content) ? [item.content.pluginId] : []));
        for (const panelId of closedPlugins) {
            const view = `plugin:${panelId}`;
            if (!remainingPluginIds.has(panelId) && pinnedFeatures.includes(view)) toggleConnectionFeature(tab.connectionId, view);
        }

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
        const fallbackPlugin = remainingPluginItems[0];
        if (fallbackPlugin) {
            handlePluginTabSelect(fallbackPlugin.id);
            return;
        }
        setTabView(tab.id, 'terminal');
    }, [featureTabs, handlePluginTabSelect, pinnedFeatures, setTabView, tab.connectionId, tab.id, toggleConnectionFeature]);

    const handleFeaturePaneOpened = useCallback((_feature: string) => {
    }, []);


    const dockPointer = useMemo<DockTabPointerHandlers>(() => ({
        contextId: tab.id,
        isEnabled: () => useAppStore.getState().activeTabId === tab.id,
        getSurface: () => dockSurfaceRef.current,
        getTabStrip: () => tab.connectionId ? document.querySelector<HTMLElement>(
            `[data-workspace-tab-strip][data-workspace-scope="${CSS.escape(tab.connectionId)}"] [data-tab-drag-strip]`,
        ) : null,
        getPaneTabSource: payload => {
            const store = useAppStore.getState();
            if (!tab.connectionId || store.activeTabId !== tab.id || store.tabs.find(item => item.id === tab.id)?.connectionId !== tab.connectionId
                || !store.sessionLoaded || store.isRestoring || store.sessionPersistenceBlocked) return null;
            const source = paneTabReleaseSource(workspaceCanvases(store.terminals[tab.connectionId] ?? [], store.paneLayouts[tab.connectionId]),
                payload, store.contentPresentation[tab.connectionId]);
            return source && (source.memberIds.length > 1 || store.workspaceDocking[tab.connectionId]?.placements[source.contentId]) ? source : null;
        },
        canDropPaneTab: insertion => {
            if (!tab.connectionId) return false;
            const store = useAppStore.getState();
            return planPaneTabInsertion(store.terminals[tab.connectionId] ?? [], store.paneLayouts[tab.connectionId],
                store.contentPresentation[tab.connectionId], insertion) !== null;
        },
        onPaneTabDrop: insertion => {
            const store = useAppStore.getState();
            if (!tab.connectionId || store.activeTabId !== tab.id || store.tabs.find(item => item.id === tab.id)?.connectionId !== tab.connectionId) return false;
            if (!store.releasePaneFromSplit(tab.connectionId, { contentId: insertion.source.contentId }, insertion)) {
                showToast('info', 'This pane cannot return to that tab position now. Its layout has been kept unchanged.');
                return false;
            }
            selectContent(insertion.source.contentId);
            return true;
        },
        // Dragging never changes the visible destination canvas.
        onDragStart: () => {},
        onDragEnd: (payload, target) => {
            if (!target || !tab.connectionId || useAppStore.getState().activeTabId !== tab.id) return;
            if (target.kind === 'region') {
                const store = useAppStore.getState();
                const contentId = store.dropWorkspaceContent(tab.connectionId, payload, target.region);
                if (!contentId) {
                    showToast('info', 'This pane cannot move there now. Check its availability and the four-pane limit.');
                    return;
                }
                if (useAppStore.getState().focusWorkspaceContent(tab.connectionId, contentId) && target.region === 'workspace') {
                    setTabView(tab.id, 'terminal');
                }
                return;
            }
            const { edge, paneId, contentId } = target;
            if (!edge || !paneId || !tab.connectionId) return;
            const result = dockInSplit(tab.connectionId, payload, edge, contentId ? { contentId } : paneId);
            if (result === 'refused-cap') {
                showToast('info', 'There is no room for another pane. Move a docked pane back to the workspace or close a pane first.');
                return;
            }
            if ((result === 'opened' || result === 'moved' || result === 'focused')
                && !useAppStore.getState().workspaceDockFocus[tab.connectionId]) {
                setTabView(tab.id, 'terminal');
            }
        },
        onDragCancel: () => {},
    }), [dockInSplit, selectContent, setTabView, showToast, tab.connectionId, tab.id]);

    const handleTogglePin = useCallback((feature: string) => {
        if (tab.connectionId) {
            toggleConnectionFeature(tab.connectionId, feature);
        }
    }, [tab.connectionId, toggleConnectionFeature]);

    const handleTerminalClose = useCallback((termId: string) => {
        if (tab.connectionId) {
            closeTerminalGroup(tab.connectionId, termId);
        }
    }, [tab.connectionId, closeTerminalGroup]);

    const handleNewTerminal = useCallback((shell?: ShellEntry) => {
        if (!tab.connectionId) return;
        let created: string | null;
        if (shell) {
            created = createTerminal(tab.connectionId, { shellOverride: shell.id, title: shell.label });
        } else if (
            tab.connectionId === LOCAL_TERMINAL_CONNECTION_ID
            && window.electronUtils?.platform === 'win32'
        ) {
            // Windows only: stamp settings default so tab icons do not track later Default Shell changes.
            const raw = useAppStore.getState().settings.localTerm?.windowsShell;
            const shellId = resolveLocalWindowsShellId(raw);
            created = createTerminal(tab.connectionId, { shellOverride: shellId });
        } else {
            created = createTerminal(tab.connectionId);
        }
        if (!created) return;
        setTabView(tab.id, 'terminal');
    }, [tab.connectionId, createTerminal, tab.id, setTabView]);

    // Ensure we start with at least 'terminal' available conceptually, 
    // though combined bar renders terminals from store.

    // Each tab content is rendered but hidden if not active
    return (
        <WorkspaceContextActions connectionId={tab.connectionId ?? ''} tabId={tab.id} active={isActive} openRequest={contentsOpenRequest}
            onSetHidden={setContentHidden} onSelectContent={selectContent} onRevealAll={revealAllContent}>
        <div className={cn(
            "absolute inset-0 flex flex-col",
            forceOpaqueShell || !(tab.view === 'terminal' && terminalTransparencyEnabled)
                ? "bg-app-bg"
                : "bg-transparent",
            !isActive && "hidden"
        )}>
            {showWorkspace && (
                <HostWorkspaceFrame active={isActive} navigation={tab.connectionId !== GLOBAL_SNIPPETS_CONNECTION_ID ? (
                        <WorkspaceTabBar
                            connectionId={tab.connectionId}
                            tabId={tab.id}
                            activeView={tab.view}
                            featureTabs={featureTabs}
                            activeFeatureTabId={activeFeatureTabId}
                            pinnedFeatures={pinnedFeatures}
                            pluginPanels={workspacePluginPanels}
                            onTabSelect={handleTabSelect}
                            onPluginTabSelect={handlePluginTabSelect}
                            onPluginTabClose={handlePluginTabClose}
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
                    ) : null}>

                    {/* Content Area */}
                    <div ref={dockSurfaceRef} className="flex-1 overflow-hidden relative flex flex-col">
                        <Suspense fallback={<TabLoading />}>

                            {/* 
                                Terminal View
                                Pass hideTabs={true} to disable its internal tab bar
                            */}
                            <div
                                className={cn(
                                    "flex-1 min-h-0 min-w-0 relative",
                                    terminalTransparencyEnabled && !forceOpaqueShell ? "bg-transparent" : "bg-app-bg"
                                )}
                            >
                                <TerminalManager
                                    connectionId={tab.connectionId}
                                    isWorkspaceActive={isActive}
                                    isTerminalView
                                    pluginPanelId={isPluginTabView(tab.view) ? tab.view.slice('plugin:'.length) : undefined}
                                    featureView={isSplitFeatureId(tab.view) ? tab.view : undefined}
                                    hiddenContentIds={hiddenIds}
                                    hiddenContentFallback={<div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
                                        <p className="text-sm text-app-muted">All panes in this view are hidden. Your sessions are still open.</p>
                                        <Button variant="secondary" onClick={revealAllContent}>Show all panes</Button>
                                    </div>}
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
                </HostWorkspaceFrame>
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
        </WorkspaceContextActions>
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
    const workspaceTabIds = useMemo(
        () => tabs.map(tab => tab.id),
        [tabs],
    );
    const retainedWorkspaceTabs = useRetainedItems(workspaceTabIds, activeWorkspaceTab?.id ?? null);
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
    const globalSidebarSection = useAppStore(state => state.globalSidebarSection);
    const sidebarCollapsed = sidebarPresentation(settings.workspaceNavigation, globalSidebarSection, settings.sidebarCollapsed).collapsed;
    const updateSettings = useAppStore(state => state.updateSettings);
    const updateSurveySettings = useAppStore(state => state.updateSurveySettings);
    const setSidebarCollapsedLocal = useAppStore(state => state.setSidebarCollapsedLocal);
    const [surveyContext, setSurveyContext] = useState<{ kind: SurveyPromptKind; version: string } | null>(null);
    const [isSurveyPromptOpen, setIsSurveyPromptOpen] = useState(false);
    const [isSurveyReminderVisible, setIsSurveyReminderVisible] = useState(false);
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
        // Restore the saved workspace before opening/version-stamping transient tabs.
        if (isLoadingSettings || !sessionLoaded || versionChecked.current) return;
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
    }, [isLoadingSettings, sessionLoaded, openReleaseNotesTab, updateSettings]);

    // Profile survey: prompt once, then keep an app-level reminder until submission.
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

                const identifiedSurvey = initializeSurveyIdentity(
                    survey,
                    currentVersion,
                    previousSeenVersion,
                    new Date().toISOString(),
                );
                if (
                    identifiedSurvey.firstObservedVersion !== survey.firstObservedVersion
                    || identifiedSurvey.firstObservedAt !== survey.firstObservedAt
                    || identifiedSurvey.existingInstallAtFirstObservation
                        !== survey.existingInstallAtFirstObservation
                ) {
                    void updateSurveySettings({
                        firstObservedVersion: identifiedSurvey.firstObservedVersion,
                        firstObservedAt: identifiedSurvey.firstObservedAt,
                        existingInstallAtFirstObservation:
                            identifiedSurvey.existingInstallAtFirstObservation,
                    }).catch((err) => {
                        console.error('Failed to persist survey installation identity', err);
                    });
                }

                const debugKind = isDebugSurveyPromptEnabled()
                    ? (getDebugSurveyPromptKind() ?? 'install')
                    : null;
                const experience = debugKind
                    ? {
                        kind: debugKind,
                        version: currentVersion,
                        shouldPrompt: true,
                        showReminder: false,
                    }
                    : resolveSurveyExperience(identifiedSurvey, currentVersion, previousSeenVersion);
                if (!experience) return;

                const context = { kind: experience.kind, version: experience.version };
                setSurveyContext(context);
                setIsSurveyReminderVisible(experience.showReminder);

                if (!experience.shouldPrompt) return;

                if (!debugKind) {
                    void updateSurveySettings({
                        installCompleted: context.kind === 'install'
                            ? false
                            : identifiedSurvey.installCompleted,
                        lifecycleState: 'pending',
                        promptKind: context.kind,
                        promptVersion: context.version,
                    }).catch((err) => {
                        console.error('Failed to persist pending survey state', err);
                    });
                }

                if (context.kind === 'release' && !debugKind) {
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

                setIsSurveyPromptOpen(true);
            } catch (err) {
                console.error('Failed to resolve survey prompt', err);
            }
        };

        void maybeShowSurvey();
    }, [isLoadingSettings, sessionLoaded, updateSurveySettings]);

    const persistSurveyResult = useCallback(async (
        submitted: boolean,
        prefs?: {
            lastRole?: string;
            lastWorkContext?: string;
            lastDiscoverySource?: string;
            lastPrimaryUse?: string;
            lastImprovementPriority?: string;
        },
    ) => {
        const context = surveyContext;
        if (!context) return;

        const currentSurvey = normalizeSurveySettings(useAppStore.getState().settings.survey);
        const prefPatch = submitted
            ? {
                lastRole: prefs?.lastRole ?? '',
                lastWorkContext: prefs?.lastWorkContext ?? '',
                lastDiscoverySource: prefs?.lastDiscoverySource ?? '',
                lastPrimaryUse: prefs?.lastPrimaryUse ?? '',
                lastImprovementPriority: prefs?.lastImprovementPriority ?? '',
            }
            : {};
        await updateSurveySettings({
            installCompleted: context.kind === 'install'
                ? submitted
                : currentSurvey.installCompleted,
            lifecycleState: submitted ? 'completed' : 'dismissed',
            promptKind: context.kind,
            promptVersion: context.version,
            releaseSeenVersion: context.version,
            ...prefPatch,
        });
    }, [surveyContext, updateSurveySettings]);

    const handleSurveySubmitted = useCallback(async (prefs: {
        lastRole?: string;
        lastWorkContext?: string;
        lastDiscoverySource?: string;
        lastPrimaryUse?: string;
        lastImprovementPriority?: string;
    }) => {
        await persistSurveyResult(true, prefs);
        setIsSurveyReminderVisible(false);
    }, [persistSurveyResult]);

    const handleSurveyDismissed = useCallback(() => {
        setIsSurveyPromptOpen(false);
        setIsSurveyReminderVisible(true);
        void persistSurveyResult(false).catch((err) => {
            console.error('Failed to persist dismissed survey state', err);
        });
    }, [persistSurveyResult]);

    const handleSurveyFinished = useCallback(() => {
        setIsSurveyPromptOpen(false);
        setSurveyContext(null);
    }, []);

    // Theme Application Effect
    const theme = useAppStore(state => state.settings.theme);
    const accentColor = useAppStore(state => state.settings.accentColor);
    const customTheme = useAppStore(state => state.settings.customTheme);
    useCustomThemeStyle(theme, customTheme);
    const elementColors = useAppStore(state => state.settings.elementColors);
    useElementColorStyle(elementColors, refreshAllCachedTerminalThemes);
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
        document.body.classList.remove('light', 'dark', 'custom', 'dracula', 'monokai', 'midnight', 'warm', 'light-warm');

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

    }, [theme, customTheme, accentColor, globalFontFamily, globalFontSize, isLoadingSettings, persistBootThemeColors]);

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

            <LayoutMotionScope><WorkspaceNavigationFrame>
                {/* Sidebar Overlay for Mobile */}
                {
                    isSmallScreen && !sidebarCollapsed && (
                        <div
                            className="absolute inset-0 bg-black/50 backdrop-blur-sm z-[45] animate-in fade-in duration-300"
                            onClick={() => {
                                setSidebarVisibility(useAppStore.getState, true);
                            }}
                        />
                    )
                }

                <Sidebar className={isSmallScreen ? "fixed" : ""} />

                <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
                    {/* Main Content Area */}
                    <div className="flex-1 overflow-hidden relative flex flex-col">
                        {tabs.length > 0 && !showWelcomeScreen && activeWorkspaceTab ? (
                            <>
                                {retainedItemsInMountOrder(tabs, retainedWorkspaceTabs).map((tab: Tab) => (
                                    <TabContent
                                        key={tab.id}
                                        tab={tab}
                                        isActive={tab.id === activeWorkspaceTab.id}
                                    />
                                ))}
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
            </WorkspaceNavigationFrame></LayoutMotionScope>

            {/* Bottom Unified Status Bar (Full Width) */}
            <StatusBar />

            <SurveyReminderButton
                visible={isSurveyReminderVisible && !isSurveyPromptOpen}
                onClick={() => {
                    setIsSurveyReminderVisible(false);
                    setIsSurveyPromptOpen(true);
                }}
            />

            <FeedbackInbox />

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
                open={isSurveyPromptOpen && Boolean(surveyContext)}
                kind={surveyContext?.kind ?? 'install'}
                appVersion={surveyContext?.version ?? ''}
                prefill={normalizeSurveySettings(settings.survey)}
                onSubmitted={handleSurveySubmitted}
                onDismissed={handleSurveyDismissed}
                onFinished={handleSurveyFinished}
            />
        </div >
    );
}

