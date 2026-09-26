import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { FolderOpen, Plug, Terminal as TerminalIcon, X, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import {
    findNode,
    introStartSizes,
    isFeatureContent,
    isPaneLeaf,
    isPaneSplit,
    isPluginContent,
    isSplitLayout,
    isTermContent,
    markSplitIntro,
    normalizeSizes,
    paneDockPayload,
    prefersSplitIntroMotion,
    takeSplitIntro,
    SPLIT_INTRO_MS,
    SPLIT_SETTLE_MS,
    type PaneLayout,
    type PaneNode,
    type SplitDirection,
    type SplitFeatureId,
    type SplitIntro,
} from '../../lib/paneLayout';
import type { TerminalTab } from '../../store/terminalSlice';
import { beginPaneSplitIntro, endPaneSplitIntro, type PaneTransientHold } from '../../lib/terminal';
import { FEATURE_META } from '../layout/featureMeta';
import { useAppStore } from '../../store/useAppStore';
import { TerminalComponent } from './Terminal';
import { PaneDivider } from './PaneDivider';
import { FeaturePaneBody } from './FeaturePaneBody';
import { useDockTabPointer, type DockTabPointerHandlers } from '../layout/tabDock';
import { usePlugins } from '../../context/PluginContext';
import { PluginIcon } from '../icons/PluginIcon';

const EMPTY_TERMINAL_TABS: TerminalTab[] = [];

type InternalEdges = {
    top?: boolean;
    right?: boolean;
    bottom?: boolean;
    left?: boolean;
};

function SplitBranch({
    grow,
    intro,
    incoming,
    dragging,
    settle,
    children,
}: {
    grow: number;
    intro: boolean;
    incoming: boolean;
    dragging: boolean;
    settle: boolean;
    children: ReactNode;
}) {
    return (
        <div
            className={cn(
                'pane-split-branch relative',
                intro && 'is-intro',
                dragging && 'is-dragging',
                settle && !intro && !dragging && 'is-settle',
            )}
            style={{ flexGrow: grow, flexShrink: 1, flexBasis: 0 }}
        >
            {children}
            {intro && incoming && <div aria-hidden className="pane-split-intro-veil" />}
        </div>
    );
}

function layoutHasSplitNode(connectionId: string, splitId: string): boolean {
    const groups = useAppStore.getState().paneLayouts[connectionId];
    if (!groups) return false;
    for (const layout of Object.values(groups)) {
        if (findNode(layout.root, splitId)) return true;
    }
    return false;
}

function SplitFrame({
    connectionId,
    splitId,
    direction,
    sizes,
    first,
    second,
    onDrag,
    onDragEnd,
    onEqualize,
}: {
    connectionId: string;
    splitId: string;
    direction: SplitDirection;
    sizes: [number, number];
    first: ReactNode;
    second: ReactNode;
    onDrag: (ratio: number) => void;
    onDragEnd: () => void;
    onEqualize: () => void;
}) {
    const [intro, setIntro] = useState<SplitIntro | null>(null);
    const [grow, setGrow] = useState<[number, number]>(sizes);
    const [dragRatio, setDragRatio] = useState<number | null>(null);
    const [settle, setSettle] = useState(false);
    const sizesRef = useRef(sizes);
    const dragRatioRef = useRef<number | null>(null);
    const dragRafRef = useRef(0);
    const cancelIntroRef = useRef<(() => void) | null>(null);
    const introHoldRef = useRef<PaneTransientHold | null>(null);

    useLayoutEffect(() => {
        sizesRef.current = sizes;
    });

    useLayoutEffect(() => {
        const taken = takeSplitIntro(splitId);
        if (!taken) return undefined;

        let finished = false;
        setIntro(taken);
        setGrow(introStartSizes(taken.incomingIndex));
        introHoldRef.current = beginPaneSplitIntro();

        const finish = (announce: boolean) => {
            if (finished) return;
            finished = true;
            cancelIntroRef.current = null;
            setGrow([sizesRef.current[0], sizesRef.current[1]]);
            setIntro(null);
            const settled = endPaneSplitIntro(introHoldRef.current);
            introHoldRef.current = null;
            if (announce && settled) {
                window.dispatchEvent(new Event('zync:pane-resize-end'));
            }
        };

        const target: [number, number] = [sizesRef.current[0], sizesRef.current[1]];
        let innerRaf = 0;
        const outerRaf = requestAnimationFrame(() => {
            innerRaf = requestAnimationFrame(() => setGrow(target));
        });
        const done = window.setTimeout(() => finish(true), SPLIT_INTRO_MS);
        cancelIntroRef.current = () => {
            cancelAnimationFrame(outerRaf);
            cancelAnimationFrame(innerRaf);
            window.clearTimeout(done);
            finish(false);
        };

        return () => {
            cancelAnimationFrame(outerRaf);
            cancelAnimationFrame(innerRaf);
            window.clearTimeout(done);
            cancelIntroRef.current = null;
            if (!finished) {
                endPaneSplitIntro(introHoldRef.current);
                introHoldRef.current = null;
                if (layoutHasSplitNode(connectionId, splitId)) {
                    markSplitIntro(splitId, taken.incomingIndex);
                }
            }
        };
    }, [connectionId, splitId]);

    const stopIntro = useCallback(() => {
        cancelIntroRef.current?.();
    }, []);

    const flushDragRatio = useCallback((ratio: number) => {
        const next = normalizeSizes([ratio, 1 - ratio])[0];
        dragRatioRef.current = next;
        if (dragRafRef.current) return;
        dragRafRef.current = window.requestAnimationFrame(() => {
            dragRafRef.current = 0;
            if (dragRatioRef.current != null) {
                setDragRatio(dragRatioRef.current);
            }
        });
    }, []);

    const commitDrag = useCallback(() => {
        if (dragRafRef.current) {
            window.cancelAnimationFrame(dragRafRef.current);
            dragRafRef.current = 0;
        }
        const ratio = dragRatioRef.current;
        dragRatioRef.current = null;
        setDragRatio(null);
        if (ratio != null) {
            onDrag(ratio);
        }
        onDragEnd();
    }, [onDrag, onDragEnd]);

    const commitKeyResize = useCallback(() => {
        if (dragRafRef.current) {
            window.cancelAnimationFrame(dragRafRef.current);
            dragRafRef.current = 0;
        }
        const ratio = dragRatioRef.current;
        dragRatioRef.current = null;
        setDragRatio(null);
        if (prefersSplitIntroMotion()) setSettle(true);
        if (ratio != null) {
            onDrag(ratio);
        }
        onDragEnd();
    }, [onDrag, onDragEnd]);

    useEffect(() => () => {
        if (dragRafRef.current) {
            window.cancelAnimationFrame(dragRafRef.current);
            dragRafRef.current = 0;
        }
    }, []);

    useEffect(() => {
        if (!settle) return undefined;
        const timer = window.setTimeout(() => setSettle(false), SPLIT_SETTLE_MS);
        return () => window.clearTimeout(timer);
    }, [settle]);

    const liveGrow: [number, number] = dragRatio != null
        ? [dragRatio, 1 - dragRatio]
        : intro
            ? grow
            : sizes;
    const stacked = direction === 'vertical';
    const dragging = dragRatio != null;

    return (
        <div
            data-pane-split=""
            className={cn('relative flex h-full w-full min-h-0 min-w-0', stacked ? 'flex-col' : 'flex-row')}
        >
            <SplitBranch
                grow={liveGrow[0]}
                intro={Boolean(intro)}
                incoming={intro?.incomingIndex === 0}
                dragging={dragging}
                settle={settle}
            >
                {first}
            </SplitBranch>
            <SplitBranch
                grow={liveGrow[1]}
                intro={Boolean(intro)}
                incoming={intro?.incomingIndex === 1}
                dragging={dragging}
                settle={settle}
            >
                {second}
            </SplitBranch>
            <PaneDivider
                direction={direction}
                firstRatio={liveGrow[0] / ((liveGrow[0] + liveGrow[1]) || 1)}
                onDragStart={stopIntro}
                onDrag={(ratio) => {
                    stopIntro();
                    flushDragRatio(ratio);
                }}
                onDragEnd={commitDrag}
                onKeyCommit={commitKeyResize}
                onEqualize={() => {
                    stopIntro();
                    dragRatioRef.current = null;
                    setDragRatio(null);
                    if (prefersSplitIntroMotion()) setSettle(true);
                    onEqualize();
                }}
            />
        </div>
    );
}

function FocusEdges({ edges }: { edges: InternalEdges }) {
    const line = 'pointer-events-none absolute z-10 bg-app-accent/60';
    return (
        <>
            {edges.top && <div aria-hidden className={cn(line, 'inset-x-0 top-0 h-px')} />}
            {edges.right && <div aria-hidden className={cn(line, 'inset-y-0 right-0 w-px')} />}
            {edges.bottom && <div aria-hidden className={cn(line, 'inset-x-0 bottom-0 h-px')} />}
            {edges.left && <div aria-hidden className={cn(line, 'inset-y-0 left-0 w-px')} />}
        </>
    );
}

function PaneHeader({
    label,
    Icon,
    icon,
    focused,
    onPointerDown,
    onClose,
}: {
    label: string;
    Icon: LucideIcon;
    icon?: ReactNode;
    focused: boolean;
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
    onClose: () => void;
}) {
    return (
        <div
            className="h-7 shrink-0 flex items-center gap-1.5 px-2 border-b border-app-border/60 bg-app-panel cursor-grab active:cursor-grabbing select-none"
            onPointerDown={onPointerDown}
        >
            {icon ?? <Icon size={12} className={cn(focused ? 'text-app-accent' : 'text-app-muted')} />}
            <span className="flex-1 truncate text-[11px] font-medium text-app-text">{label}</span>
            <button
                type="button"
                onPointerDown={(event) => {
                    event.stopPropagation();
                }}
                onClick={(event) => {
                    event.stopPropagation();
                    onClose();
                }}
                className="h-5 w-5 inline-flex items-center justify-center rounded text-app-muted hover:bg-app-bg hover:text-red-400"
                aria-label={`Close ${label} pane`}
                title={`Close ${label}`}
            >
                <X size={12} />
            </button>
        </div>
    );
}

function FeaturePaneLeaf({
    connectionId,
    paneId,
    featureId,
    pluginId,
    pluginLabel,
    instanceId,
    focused,
    showFocus,
    showHeader,
    panelVisible,
    edges,
    onFocus,
    onClose,
    onHeaderPointerDown,
}: {
    connectionId: string;
    paneId: string;
    featureId?: SplitFeatureId;
    pluginId?: string;
    pluginLabel?: string;
    instanceId?: string;
    focused: boolean;
    showFocus: boolean;
    showHeader: boolean;
    panelVisible: boolean;
    edges: InternalEdges;
    onFocus: () => void;
    onClose: () => void;
    onHeaderPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
}) {
    const meta = featureId ? FEATURE_META[featureId] : undefined;
    const Icon = meta?.icon ?? (pluginId ? Plug : FolderOpen);
    const label = meta?.label ?? pluginLabel ?? pluginId ?? featureId ?? 'Panel';

    return (
        <div
            data-pane-id={paneId}
            data-files-instance-id={featureId === 'files' ? instanceId : undefined}
            className="relative h-full w-full min-h-0 min-w-0 overflow-hidden flex flex-col bg-app-bg"
            onMouseDown={onFocus}
            onWheelCapture={() => {
                if (!focused) onFocus();
            }}
        >
            {showHeader && (
                <PaneHeader
                    label={label}
                    Icon={Icon}
                    icon={pluginId ? <PluginIcon panelId={pluginId} size={14} /> : undefined}
                    focused={focused}
                    onPointerDown={onHeaderPointerDown}
                    onClose={onClose}
                />
            )}
            <div className="relative flex-1 min-h-0 min-w-0">
                <FeaturePaneBody
                    connectionId={connectionId}
                    featureId={featureId}
                    pluginId={pluginId}
                    instanceId={instanceId}
                    visible={focused && panelVisible}
                />
            </div>
            {showFocus && <FocusEdges edges={edges} />}
        </div>
    );
}

export function PaneLayoutView({
    connectionId,
    layout,
    workspaceActive,
    panelVisible,
    dockPointer,
}: {
    connectionId: string;
    layout: PaneLayout;
    workspaceActive: boolean;
    panelVisible: boolean;
    dockPointer?: DockTabPointerHandlers;
}) {
    const focusPane = useAppStore(state => state.focusPane);
    const resizePanes = useAppStore(state => state.resizePanes);
    const closePaneInSplit = useAppStore(state => state.closePaneInSplit);
    const terminalTabs = useAppStore(state => state.terminals[connectionId] || EMPTY_TERMINAL_TABS);
    const { panels: pluginPanels } = usePlugins();
    const { begin: beginDockPointer } = useDockTabPointer(dockPointer);
    const terminalTitles = useMemo(
        () => new Map(terminalTabs.map(tab => [tab.id, tab.title] as const)),
        [terminalTabs],
    );
    const pluginTitles = useMemo(
        () => new Map(pluginPanels.map(panel => [panel.id, panel.title] as const)),
        [pluginPanels],
    );

    const onDrag = useCallback((splitId: string, firstRatio: number) => {
        resizePanes(connectionId, splitId, [firstRatio, 1 - firstRatio], false);
    }, [connectionId, resizePanes]);

    const onDragEnd = useCallback((splitId: string) => {
        const groups = useAppStore.getState().paneLayouts[connectionId];
        const current = Object.values(groups ?? {}).find((group) => findNode(group.root, splitId));
        const node = current ? findNode(current.root, splitId) : null;
        if (node && isPaneSplit(node)) {
            resizePanes(connectionId, splitId, node.sizes, true);
        }
    }, [connectionId, resizePanes]);

    const onEqualize = useCallback((splitId: string) => {
        resizePanes(connectionId, splitId, [0.5, 0.5], true);
        window.dispatchEvent(new Event('zync:pane-resize-end'));
    }, [connectionId, resizePanes]);

    const split = isSplitLayout(layout);
    const renderNode = (node: PaneNode, edges: InternalEdges = {}): ReactNode => {
        if (isPaneLeaf(node)) {
            const focused = layout.activePaneId === node.id;
            const showFocus = focused && workspaceActive && panelVisible;
            if (isFeatureContent(node.content) || isPluginContent(node.content)) {
                const content = node.content;
                const featureId = isFeatureContent(content) ? content.featureId : undefined;
                const contentInstanceId = isFeatureContent(content) || isPluginContent(content)
                    ? content.instanceId
                    : undefined;
                const pluginId = isPluginContent(content) ? content.pluginId : undefined;
                const dockPayload = paneDockPayload(node);
                return (
                    <FeaturePaneLeaf
                        key={node.id}
                        connectionId={connectionId}
                        paneId={node.id}
                        featureId={featureId}
                        instanceId={contentInstanceId}
                        pluginId={pluginId}
                        pluginLabel={pluginId ? pluginTitles.get(pluginId) : undefined}
                        focused={focused}
                        showFocus={showFocus}
                        showHeader={split}
                        panelVisible={panelVisible}
                        edges={edges}
                        onFocus={() => focusPane(connectionId, node.id)}
                        onClose={() => closePaneInSplit(connectionId, node.id)}
                        onHeaderPointerDown={(event) => beginDockPointer(event, dockPayload)}
                    />
                );
            }
            if (!isTermContent(node.content)) return null;
            const termId = node.content.termId;
            return (
                <div
                    key={node.id}
                    data-pane-id={node.id}
                    className="relative h-full w-full min-h-0 min-w-0 overflow-hidden flex flex-col bg-app-bg"
                    onMouseDown={(event) => {
                        focusPane(connectionId, node.id);
                        if (!(event.target instanceof Element) || !event.target.closest('.xterm')) {
                            const helper = event.currentTarget.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
                            helper?.focus();
                        }
                    }}
                    onWheelCapture={() => {
                        if (!focused) focusPane(connectionId, node.id);
                    }}
                >
                    {split && (
                        <PaneHeader
                            label={terminalTitles.get(termId) ?? 'Shell'}
                            Icon={TerminalIcon}
                            focused={focused}
                            onPointerDown={(event) => beginDockPointer(event, paneDockPayload(node))}
                            onClose={() => closePaneInSplit(connectionId, node.id)}
                        />
                    )}
                    <div className="flex-1 min-h-0 min-w-0">
                        <TerminalComponent
                            connectionId={connectionId}
                            termId={termId}
                            isWorkspaceActive={workspaceActive}
                            isTerminalView
                            isActiveTab
                            isFocused={focused}
                            isVisible={panelVisible}
                        />
                    </div>
                    {showFocus && <FocusEdges edges={edges} />}
                </div>
            );
        }

        const stacked = node.direction === 'vertical';
        return (
            <SplitFrame
                key={node.id}
                connectionId={connectionId}
                splitId={node.id}
                direction={node.direction}
                sizes={node.sizes}
                first={renderNode(
                    node.children[0],
                    stacked ? { ...edges, bottom: true } : { ...edges, right: true },
                )}
                second={renderNode(
                    node.children[1],
                    stacked ? { ...edges, top: true } : { ...edges, left: true },
                )}
                onDrag={(ratio) => onDrag(node.id, ratio)}
                onDragEnd={() => onDragEnd(node.id)}
                onEqualize={() => onEqualize(node.id)}
            />
        );
    };

    return <div className="absolute inset-0">{renderNode(layout.root)}</div>;
}
