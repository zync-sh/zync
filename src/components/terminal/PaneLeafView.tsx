import { FolderOpen, Plug, Terminal as TerminalIcon } from 'lucide-react';
import { type PointerEvent, useEffect, useMemo, useState } from 'react';

import { registrationForContent } from '../../features/workspace/application/viewRegistrationAdapters';
import type { DockedPaneRegion } from '../../features/workspace/domain/docking';
import { resolveDisplayTitle } from '../../features/workspace/domain/presentation';
import { canOpenFeatureInWorkspace } from '../../features/workspace/domain/registrations';
import {
    isFeatureContent,
    isPluginContent,
    isTermContent,
    type PaneLayout,
    type PaneLeaf,
    paneDockPayload,
    type SplitFeatureId,
} from '../../lib/paneLayout';
import { paneContentKey } from '../../lib/paneLayout/contentIdentity';
import { LOCAL_TERMINAL_CONNECTION_ID } from '../../lib/terminal/connectionIds';
import { cn } from '../../lib/utils';
import type { TerminalTab } from '../../store/terminalSlice';
import { useAppStore } from '../../store/useAppStore';
import { PluginIcon } from '../icons/PluginIcon';
import { FEATURE_META } from '../layout/featureMeta';
import { type DockTabPointerHandlers, useDockTabPointer } from '../layout/tabDock';
import { DisplayAliasDialog } from '../workspace/DisplayAliasDialog';
import { PaneHeader } from '../workspace/PaneHeader';
import type { InternalEdges } from '../workspace/paneSurfaces';
import { useWorkspaceContextActions } from '../workspace/workspaceActionsContext';
import { FeaturePaneBody } from './FeaturePaneBody';
import { TerminalComponent } from './Terminal';

const EMPTY_TERMINAL_TABS: TerminalTab[] = [];

function FocusEdges({ edges }: { edges: InternalEdges }) {
    const line = 'pointer-events-none absolute z-10 bg-app-accent/60';
    return (
        <>
            {edges.top && (
                <div
                    aria-hidden
                    className={cn(line, 'inset-x-0 top-0 h-px')}
                />
            )}
            {edges.right && (
                <div
                    aria-hidden
                    className={cn(line, 'inset-y-0 right-0 w-px')}
                />
            )}
            {edges.bottom && (
                <div
                    aria-hidden
                    className={cn(line, 'inset-x-0 bottom-0 h-px')}
                />
            )}
            {edges.left && (
                <div
                    aria-hidden
                    className={cn(line, 'inset-y-0 left-0 w-px')}
                />
            )}
        </>
    );
}

/** Keep workspace chrome reachable when a restored pane is outside its supported scope. */
function FeaturePaneLeaf({
    connectionId,
    paneId,
    contentKey,
    featureId,
    pluginId,
    defaultTitle,
    displayAlias,
    instanceId,
    focused,
    showFocus,
    showHeader,
    panelVisible,
    edges,
    onFocus,
    onClose,
    onRename,
    maximized,
    onToggleMaximize,
    onHeaderPointerDown,
    dockRegion,
}: {
    connectionId: string;
    paneId: string;
    contentKey: string;
    featureId?: SplitFeatureId;
    pluginId?: string;
    defaultTitle: string;
    displayAlias?: string;
    instanceId?: string;
    focused: boolean;
    showFocus: boolean;
    showHeader: boolean;
    panelVisible: boolean;
    edges: InternalEdges;
    onFocus: () => void;
    onClose: () => void;
    onRename: () => void;
    maximized?: boolean;
    onToggleMaximize?: () => void;
    onHeaderPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
    dockRegion?: DockedPaneRegion;
}) {
    const meta = featureId ? FEATURE_META[featureId] : undefined;
    const workspaceActions = useWorkspaceContextActions();
    const Icon = meta?.icon ?? (pluginId ? Plug : FolderOpen);
    const label = resolveDisplayTitle(defaultTitle, displayAlias);
    const scope = connectionId === LOCAL_TERMINAL_CONNECTION_ID ? 'local' : 'remote';
    const available = !featureId || canOpenFeatureInWorkspace(featureId, scope);

    return (
        <div
            data-pane-id={paneId}
            data-pane-content-id={contentKey}
            data-zync-color="panel"
            data-files-instance-id={featureId === 'files' ? instanceId : undefined}
            className="relative h-full w-full min-h-0 min-w-0 overflow-hidden flex flex-col bg-app-bg"
            onMouseDown={onFocus}
            onFocusCapture={onFocus}
            onWheelCapture={() => {
                if (!focused) {
                    onFocus();
                }
            }}
        >
            {showHeader && (
                <PaneHeader
                    label={label}
                    defaultTitle={defaultTitle}
                    icon={
                        pluginId ? (
                            <PluginIcon
                                panelId={pluginId}
                                size={14}
                            />
                        ) : (
                            <Icon
                                size={12}
                                className={cn(focused ? 'text-app-accent' : 'text-app-muted')}
                            />
                        )
                    }
                    onPointerDown={onHeaderPointerDown}
                    onRename={onRename}
                    onOpenContextMenu={(event) => workspaceActions?.open(event, [contentKey])}
                    onClose={onClose}
                    maximized={maximized}
                    onToggleMaximize={onToggleMaximize}
                    dockRegion={dockRegion}
                    dockFocused={showFocus}
                    onReturnToTabs={
                        workspaceActions?.returnToTabs
                            ? () => workspaceActions.returnToTabs?.(contentKey)
                            : undefined
                    }
                    returnToTabsDisabled={!workspaceActions?.canReturnToTabs?.(contentKey)}
                />
            )}
            <div className="relative flex-1 min-h-0 min-w-0">
                {available ? (
                    <FeaturePaneBody
                        connectionId={connectionId}
                        contentKey={contentKey}
                        featureId={featureId}
                        pluginId={pluginId}
                        instanceId={instanceId}
                        visible={panelVisible}
                        focused={showFocus}
                    />
                ) : (
                    <p
                        role="status"
                        className="p-4 text-sm text-app-muted"
                    >
                        {defaultTitle} is unavailable in this workspace.
                    </p>
                )}
            </div>
            {showFocus && <FocusEdges edges={edges} />}
        </div>
    );
}

export function PaneLeafView({
    connectionId,
    node,
    layout,
    focusedPaneId = layout.activePaneId,
    focused: allocatedFocus,
    onFocusContent,
    split,
    edges,
    workspaceActive,
    panelVisible,
    dockPointer,
    maximized,
    onToggleMaximize,
    dockRegion,
}: {
    connectionId: string;
    node: PaneLeaf;
    layout: PaneLayout;
    /** Visible focus from allocation; layout retains canonical membership/capacity. */
    focusedPaneId?: string;
    /** Optional single focus owner for connection-wide docking allocations. */
    focused?: boolean;
    /** Exact content-key focus supplied by connection-wide allocation. */
    onFocusContent?: () => void;
    split: boolean;
    edges: InternalEdges;
    workspaceActive: boolean;
    panelVisible: boolean;
    dockPointer?: DockTabPointerHandlers;
    maximized?: boolean;
    onToggleMaximize?: () => void;
    dockRegion?: DockedPaneRegion;
}) {
    const focusPane = useAppStore((state) => state.focusPane);
    const workspaceActions = useWorkspaceContextActions();
    const closePaneInSplit = useAppStore((state) => state.closePaneInSplit);
    const terminalTabs = useAppStore(
        (state) => state.terminals[connectionId] || EMPTY_TERMINAL_TABS,
    );
    const registry = useAppStore((state) => state.workspaceViewRegistry);
    const contentKey = paneContentKey(node.content, node.id);
    const displayAlias = useAppStore(
        (state) => state.contentPresentation[connectionId]?.items[contentKey]?.displayAlias,
    );
    const setContentDisplayAlias = useAppStore((state) => state.setContentDisplayAlias);
    const [renaming, setRenaming] = useState(false);
    useEffect(() => {
        if (!panelVisible) {
            setRenaming(false);
        }
    }, [panelVisible]);
    const { begin: beginDockPointer } = useDockTabPointer(dockPointer);
    const terminalTitles = useMemo(
        () => new Map(terminalTabs.map((tab) => [tab.id, tab.title])),
        [terminalTabs],
    );

    const focused = allocatedFocus ?? focusedPaneId === node.id;
    const requestFocus = onFocusContent ?? (() => focusPane(connectionId, node.id));
    const showFocus = focused && workspaceActive && panelVisible;
    const defaultTitle = isTermContent(node.content)
        ? (terminalTitles.get(node.content.termId) ?? 'Shell')
        : (registrationForContent(registry, node.content)?.label ?? 'Unavailable panel');
    const aliasDialog = (
        <DisplayAliasDialog
            key={contentKey}
            isOpen={renaming && panelVisible}
            title="Rename pane"
            defaultTitle={defaultTitle}
            displayAlias={displayAlias}
            onSave={(alias) => {
                if (!setContentDisplayAlias(connectionId, contentKey, alias)) {
                    throw new Error('Content is no longer available');
                }
            }}
            onClose={() => setRenaming(false)}
        />
    );
    if (isFeatureContent(node.content) || isPluginContent(node.content)) {
        const content = node.content;
        const featureId = isFeatureContent(content) ? content.featureId : undefined;
        const contentInstanceId =
            isFeatureContent(content) || isPluginContent(content) ? content.instanceId : undefined;
        const pluginId = isPluginContent(content) ? content.pluginId : undefined;
        const dockPayload = paneDockPayload(node);
        return (
            <>
                <FeaturePaneLeaf
                    connectionId={connectionId}
                    paneId={node.id}
                    contentKey={contentKey}
                    featureId={featureId}
                    instanceId={contentInstanceId}
                    pluginId={pluginId}
                    defaultTitle={defaultTitle}
                    displayAlias={displayAlias}
                    focused={focused}
                    showFocus={showFocus}
                    showHeader={split || !!dockRegion}
                    dockRegion={dockRegion}
                    panelVisible={panelVisible}
                    edges={edges}
                    onFocus={requestFocus}
                    onClose={() => closePaneInSplit(connectionId, { contentId: contentKey })}
                    onRename={() => setRenaming(true)}
                    maximized={maximized}
                    onToggleMaximize={onToggleMaximize}
                    onHeaderPointerDown={(event) => beginDockPointer(event, dockPayload)}
                />
                {aliasDialog}
            </>
        );
    }
    if (!isTermContent(node.content)) {
        return null;
    }
    const termId = node.content.termId;
    return (
        <>
            <div
                data-pane-id={node.id}
                data-pane-content-id={contentKey}
                className={cn(
                    'relative h-full w-full min-h-0 min-w-0 overflow-hidden flex flex-col',
                    split && 'bg-app-bg',
                )}
                onMouseDown={(event) => {
                    requestFocus();
                    if (
                        !(event.target instanceof Element) ||
                        !event.target.closest(
                            '.xterm, button, input, select, textarea, a[href], [tabindex]',
                        )
                    ) {
                        const helper =
                            event.currentTarget.querySelector<HTMLTextAreaElement>(
                                '.xterm-helper-textarea',
                            );
                        helper?.focus();
                    }
                }}
                onFocusCapture={requestFocus}
                onWheelCapture={() => {
                    if (!focused) {
                        requestFocus();
                    }
                }}
            >
                {(split || dockRegion) && (
                    <PaneHeader
                        label={resolveDisplayTitle(defaultTitle, displayAlias)}
                        defaultTitle={defaultTitle}
                        icon={
                            <TerminalIcon
                                size={12}
                                className={cn(focused ? 'text-app-accent' : 'text-app-muted')}
                            />
                        }
                        onPointerDown={(event) => beginDockPointer(event, paneDockPayload(node))}
                        onRename={() => setRenaming(true)}
                        onOpenContextMenu={(event) => workspaceActions?.open(event, [contentKey])}
                        onClose={() => closePaneInSplit(connectionId, { contentId: contentKey })}
                        maximized={maximized}
                        onToggleMaximize={onToggleMaximize}
                        dockRegion={dockRegion}
                        dockFocused={showFocus}
                        onReturnToTabs={
                            workspaceActions?.returnToTabs
                                ? () => workspaceActions.returnToTabs?.(contentKey)
                                : undefined
                        }
                        returnToTabsDisabled={!workspaceActions?.canReturnToTabs?.(contentKey)}
                    />
                )}
                <div className="flex-1 min-h-0 min-w-0">
                    <TerminalComponent
                        connectionId={connectionId}
                        termId={termId}
                        isWorkspaceActive={workspaceActive}
                        isTerminalView
                        isActiveTab={panelVisible}
                        isFocused={focused}
                        isVisible={panelVisible}
                    />
                </div>
                {showFocus && <FocusEdges edges={edges} />}
            </div>
            {aliasDialog}
        </>
    );
}
