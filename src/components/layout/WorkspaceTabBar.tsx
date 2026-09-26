import { memo } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { useAvailableShells } from '../../hooks/useAvailableShells';
import { LOCAL_TERMINAL_CONNECTION_ID } from '../../features/connections/application/tabService';
import { CombinedTabBar } from './CombinedTabBar';
import { overlayPaneId, overlayPluginPaneId, type DockTabPointerHandlers } from './tabDock';
import type { ShellEntry } from '../../lib/shells/types';
import type { FeatureId, WorkspaceFeatureTab } from './featureMeta';
import {
    canSplit,
    findNode,
    isFeatureContent,
    isPaneLeaf,
    isPluginContent,
    isSplitFeatureId,
    isSplitLayout,
    layoutForCanvas,
    splitFromDockEdge,
    type DockEdge,
    type SplitFeatureId,
} from '../../lib/paneLayout';

export interface WorkspaceTabBarProps {
    connectionId: string;
    tabId: string;
    activeView: string;
    openFeatures: string[];
    featureTabs: WorkspaceFeatureTab[];
    activeFeatureTabId: string | null;
    pinnedFeatures: string[];
    pluginPanels: { id: string; title: string }[];
    onTabSelect: (view: string, termId?: string) => void;
    onFeatureClose: (feature: string) => void;
    onFeatureTabSelect: (tabId: string, featureId: FeatureId) => void;
    onFeatureTabClose: (tabId: string, featureId: FeatureId) => void;
    onTerminalClose: (termId: string) => void;
    onNewTerminal: (shell?: ShellEntry) => void;
    onOpenFeature?: (feature: string) => void;
    onFeaturePaneOpened?: (feature: SplitFeatureId) => void;
    onPaneGroupClose: (owner: string) => void;
    onTogglePin: (feature: string) => void;
    sessionToolsOpen?: boolean;
    onToggleSessionTools?: () => void;
    dockPointer?: DockTabPointerHandlers;
}

/**
 * Isolates shell-tab and shell-picker store subscriptions so TabContent
 * does not re-render on every activeTerminalId or shellsLoading change.
 */
export const WorkspaceTabBar = memo(function WorkspaceTabBar({
    connectionId,
    tabId,
    activeView,
    openFeatures,
    featureTabs,
    activeFeatureTabId,
    pinnedFeatures,
    pluginPanels,
    onTabSelect,
    onFeatureClose,
    onFeatureTabSelect,
    onFeatureTabClose,
    onTerminalClose,
    onNewTerminal,
    onOpenFeature,
    onFeaturePaneOpened,
    onPaneGroupClose,
    onTogglePin,
    sessionToolsOpen,
    onToggleSessionTools,
    dockPointer,
}: WorkspaceTabBarProps) {
    const activeTerminalId = useAppStore(
        state => state.activeTerminalIds[connectionId] ?? null,
    );
    const isSplit = useAppStore((state) => {
        const activeId = state.activeTerminalIds[connectionId];
        const owner = state.activePaneGroupOwner[connectionId];
        return isSplitLayout(layoutForCanvas(state.paneLayouts[connectionId], activeId, owner));
    });
    const canSplitPanes = useAppStore((state) => {
        const activeId = state.activeTerminalIds[connectionId];
        const owner = state.activePaneGroupOwner[connectionId];
        return canSplit(layoutForCanvas(state.paneLayouts[connectionId], activeId, owner) ?? null);
    });
    const splitPanes = useAppStore(state => state.splitPanes);
    const activatePaneGroup = useAppStore(state => state.activatePaneGroup);
    const closePaneInSplit = useAppStore(state => state.closePaneInSplit);
    const openFeatureInSplit = useAppStore(state => state.openFeatureInSplit);
    const dockInSplit = useAppStore(state => state.dockInSplit);
    const createTerminal = useAppStore(state => state.createTerminal);
    const setTabView = useAppStore(state => state.setTabView);
    const showToast = useAppStore(state => state.showToast);

    const reportDockResult = (result: string) => {
        if (result === 'refused-cap') {
            showToast('info', 'This tab already has 4 panes.');
        }
    };

    const handleOpenSplitFeature = (featureId: SplitFeatureId, edge: DockEdge = 'right') => {
        const activeFeatureTab = featureTabs.find(item => (
            item.id === activeFeatureTabId && item.featureId === featureId
        ));
        if (activeView === featureId && activeFeatureTab) {
            const result = dockInSplit(
                connectionId,
                { kind: 'feature', featureId, instanceId: activeFeatureTab.instanceId },
                edge,
                overlayPaneId(featureId),
                undefined,
                { kind: 'feature', featureId, instanceId: activeFeatureTab.instanceId },
            );
            reportDockResult(result);
            if (result === 'refused-cap' || result === 'no-target') return;
            onFeaturePaneOpened?.(featureId);
            setTabView(tabId, 'terminal');
            return;
        }
        const result = openFeatureInSplit(connectionId, featureId, edge);
        if (result !== 'refused-cap' && result !== 'no-target') {
            onFeaturePaneOpened?.(featureId);
        }
        reportDockResult(result);
        if (result !== 'refused-cap' && result !== 'no-target') {
            setTabView(tabId, 'terminal');
        }
    };

    const handleDockTerm = (termId: string, edge: DockEdge) => {
        const result = dockInSplit(connectionId, { kind: 'term', termId }, edge);
        reportDockResult(result);
        if (result !== 'refused-cap' && result !== 'no-target') {
            setTabView(tabId, 'terminal');
        }
    };

    const handleOpenSplitPlugin = (pluginId: string, edge: DockEdge = 'right') => {
        const result = dockInSplit(
            connectionId,
            { kind: 'plugin', pluginId },
            edge,
            overlayPluginPaneId(pluginId),
            undefined,
            { kind: 'plugin', pluginId },
        );
        reportDockResult(result);
        if (result === 'refused-cap' || result === 'no-target') return;
        setTabView(tabId, 'terminal');
    };

    const handleSplitNewShell = (edge: DockEdge, shell?: ShellEntry) => {
        if (activeView !== 'terminal') {
            setTabView(tabId, 'terminal');
        }
        if (!canSplitPanes) {
            reportDockResult('refused-cap');
            return;
        }
        if (!shell) {
            const { direction, insert } = splitFromDockEdge(edge);
            splitPanes(connectionId, direction, insert);
            return;
        }
        const canvasTermId = activeTerminalId;
        const termId = createTerminal(connectionId, { shellOverride: shell.id, title: shell.label });
        reportDockResult(dockInSplit(connectionId, { kind: 'term', termId }, edge, null, canvasTermId));
    };

    const handleUnsplit = (paneId?: string, owner?: string) => {
        const state = useAppStore.getState();
        const groups = state.paneLayouts[connectionId];
        const layout = (owner ? groups?.[owner] : undefined)
            ?? layoutForCanvas(
                groups,
                state.activeTerminalIds[connectionId],
                state.activePaneGroupOwner[connectionId],
            );
        const focused = layout ? findNode(layout.root, paneId ?? layout.activePaneId) : null;
        if (!focused || !isPaneLeaf(focused)) return;
        const released = focused.content;

        closePaneInSplit(connectionId, focused.id);

        if (isFeatureContent(released)) {
            onFeaturePaneOpened?.(released.featureId);
            const featureTab = featureTabs.find(item => (
                item.featureId === released.featureId
                && item.instanceId === released.instanceId
            ));
            if (featureTab) {
                onFeatureTabSelect(featureTab.id, featureTab.featureId);
            } else {
                onTabSelect(released.featureId);
            }
        } else if (isPluginContent(released)) {
            onTabSelect(`plugin:${released.pluginId}`);
        } else {
            onTabSelect('terminal', released.termId);
        }
    };
    const hostIsWindows = connectionId === LOCAL_TERMINAL_CONNECTION_ID
        && window.electronUtils?.platform === 'win32';
    const remoteReady = useAppStore(state => state.connections.some(
        connection => connection.id === connectionId && connection.status === 'connected',
    ));
    const {
        shells: availableShells,
        isLoading: shellsLoading,
        error: shellsError,
        refetch: refetchShells,
    } = useAvailableShells({ isWindows: hostIsWindows, connectionId, remoteReady });

    return (
        <CombinedTabBar
            connectionId={connectionId}
            tabId={tabId}
            activeView={activeView}
            activeTerminalId={activeTerminalId}
            openFeatures={openFeatures}
            featureTabs={featureTabs}
            activeFeatureTabId={activeFeatureTabId}
            pinnedFeatures={pinnedFeatures}
            pluginPanels={pluginPanels}
            availableShells={availableShells}
            shellsLoading={shellsLoading}
            shellsError={shellsError}
            onRefetchShells={refetchShells}
            onTabSelect={onTabSelect}
            onFeatureClose={onFeatureClose}
            onFeatureTabSelect={onFeatureTabSelect}
            onFeatureTabClose={onFeatureTabClose}
            onTerminalClose={onTerminalClose}
            onNewTerminal={onNewTerminal}
            onOpenFeature={onOpenFeature}
            onTogglePin={onTogglePin}
            sessionToolsOpen={sessionToolsOpen}
            onToggleSessionTools={onToggleSessionTools}
            isSplit={isSplit}
            canSplit={canSplitPanes}
            onSplit={(direction) => {
                if (isSplitFeatureId(activeView)) {
                    const instanceId = featureTabs.find(item => item.id === activeFeatureTabId)?.instanceId;
                    reportDockResult(
                        useAppStore.getState().splitFeaturePane(connectionId, activeView, direction, instanceId),
                    );
                    return;
                }
                if (activeView.startsWith('plugin:')) {
                    handleOpenSplitPlugin(
                        activeView.slice('plugin:'.length),
                        direction === 'horizontal' ? 'right' : 'bottom',
                    );
                    return;
                }
                splitPanes(connectionId, direction);
            }}
            onUnsplit={() => handleUnsplit()}
            onSplitSelect={(owner) => {
                activatePaneGroup(connectionId, owner);
                setTabView(tabId, 'terminal');
            }}
            onSplitClose={(owner) => onPaneGroupClose(owner)}
            onSplitUnsplit={(owner, paneId) => handleUnsplit(paneId, owner)}
            onOpenSplitFeature={handleOpenSplitFeature}
            onOpenSplitPlugin={handleOpenSplitPlugin}
            onDockTerm={handleDockTerm}
            onSplitNewShell={handleSplitNewShell}
            dockPointer={dockPointer}
        />
    );
});
