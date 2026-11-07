import { Pin, Unplug, X } from 'lucide-react';
import {
    type CSSProperties,
    forwardRef,
    type HTMLAttributes,
    type KeyboardEvent,
    type MouseEvent,
    type PointerEvent,
    type ReactNode,
    useCallback,
    useEffect,
    useId,
    useRef,
    useState,
} from 'react';

import type { Tab } from '../../features/connections/domain/types';
import { isMainTabPinned } from '../../features/workspace/domain/mainTabPresentation';
import { resolveDisplayTitle } from '../../features/workspace/domain/presentation';
import { cn } from '../../lib/utils';
import { PublicUrlsLabel } from '../share/PublicUrlsLabel';
import { ContextMenu } from '../ui/ContextMenu';
import { IconButton } from '../ui/IconButton';
import type { ContentMenuItems } from '../workspace/WorkspaceContextActions';
import { useWorkspaceTabDrag } from './tabDrag/useWorkspaceTabDrag';
import { requestWorkspaceTabCloseFromMenu } from './useWorkspaceTabCloseFocus';
import {
    resolveWorkspaceTabAppearance,
    WorkspaceTabAccent,
    WorkspaceTabDragPreview,
    WorkspaceTabIcon,
} from './WorkspaceTabDecoration';
import { workspaceTabContextMenu } from './workspaceTabContextMenu';

interface WorkspaceTabListProps
    extends Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'onSelect'> {
    tabs: readonly Tab[];
    activeTabId: string | null;
    contentMenuItems?: ContentMenuItems;
    onActivate: (id: string) => void;
    onClose: (id: string, event?: MouseEvent) => void;
    onDisconnect: (connectionId: string, event?: MouseEvent) => void;
    onRename: (id: string) => void;
    onAppearance?: (id: string) => void;
    onSetPinned?: (id: string, pinned: boolean) => boolean;
    onMove?: (id: string, direction: -1 | 1) => boolean | void;
    onActionError?: () => void;
    closeButtonMode?: unknown;
    canDisconnect: (tab: Tab) => boolean;
    renderIcon: (tab: Tab) => ReactNode;
    onReorder?: (sourceId: string, targetId: string) => boolean | void;
    canDrag?: () => boolean;
}

interface TabMenuAnchor {
    tabId: string;
    x: number;
    y: number;
    keyboard: boolean;
    opener: HTMLElement;
}

const TAB_ACTION_CLASSES =
    'h-6 w-6 rounded hover:bg-app-text/5 transition-[color,background-color,opacity] duration-100 motion-reduce:transition-none';
const REVEAL_ACTION_CLASSES =
    'pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto';

interface WorkspaceTabItemProps
    extends Pick<
        WorkspaceTabListProps,
        'onActivate' | 'onClose' | 'onDisconnect' | 'closeButtonMode'
    > {
    tab: Tab;
    active: boolean;
    tabStop: boolean;
    disconnectable: boolean;
    icon: ReactNode;
    onFocus: () => void;
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>, id: string) => void;
    onDragPointer: (event: PointerEvent<HTMLDivElement>, id: string) => void;
    consumeDragClick: () => boolean;
    onMenu: (anchor: TabMenuAnchor) => void;
    keyboardReorder: boolean;
}

function WorkspaceTabItem({
    tab,
    active,
    tabStop,
    disconnectable,
    icon,
    onFocus,
    onKeyDown,
    onActivate,
    onClose,
    onDisconnect,
    onMenu,
    closeButtonMode,
    keyboardReorder,
    onDragPointer,
    consumeDragClick,
}: WorkspaceTabItemProps) {
    const nodeRef = useRef<HTMLDivElement | null>(null);
    const tabRef = useRef<HTMLDivElement | null>(null);
    const displayTitle = resolveDisplayTitle(tab.title, tab.displayAlias);
    const defaultTitle = tab.type === 'public-urls' ? 'Public URLs (Beta)' : tab.title;
    const pinned = isMainTabPinned(tab);
    const appearance = resolveWorkspaceTabAppearance(tab.presentation, active, closeButtonMode);
    const showDisconnect = active && disconnectable && Boolean(tab.connectionId);
    const actionCount = Number(appearance.showClose) + Number(showDisconnect);
    const minimumWidth =
        actionCount > 1
            ? pinned
                ? 'min-w-[124px]'
                : 'min-w-[104px]'
            : pinned
              ? 'min-w-[100px]'
              : 'min-w-[80px]';
    // Match 24px buttons, a 2px gap and 4px inset against the trigger's 10/32px
    // right padding, with 2px clearance. Mask label pixels only; never resize the trigger.
    const labelOcclusion = Math.max(
        0,
        actionCount * 24 +
            (actionCount > 1 ? 2 : 0) +
            4 -
            (appearance.persistentClose ? 32 : 10) +
            2,
    );
    const labelStyle = {
        '--zync-tab-label-mask':
            labelOcclusion === 0
                ? 'none'
                : `linear-gradient(to right, #000 calc(100% - ${labelOcclusion + 8}px), transparent calc(100% - ${labelOcclusion}px))`,
    } as CSSProperties;
    const openMenu = (x: number, y: number, keyboard: boolean) => {
        const opener = tabRef.current;
        if (!opener) {
            return;
        }
        opener.focus({ preventScroll: true });
        onMenu({ tabId: tab.id, x, y, keyboard, opener });
    };
    const pinStatusId = useId();
    useEffect(() => {
        if (active) {
            nodeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
    }, [active]);

    return (
        <div
            ref={nodeRef}
            role="presentation"
            data-workspace-tab-item={tab.id}
            data-tab-drag-source
            data-tab-drag-item
            data-tab-drag-pinned={pinned}
            className="relative shrink-0 drag-none"
            onPointerDown={(event) => onDragPointer(event, tab.id)}
            onClickCapture={(event) => {
                if (consumeDragClick()) {
                    event.preventDefault();
                    event.stopPropagation();
                }
            }}
            onFocus={onFocus}
            onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openMenu(event.clientX, event.clientY, false);
            }}
        >
            <div
                data-tab-drag-visual
                data-zync-color="mainTab"
                data-zync-selected={active}
                className={cn(
                    'group relative flex h-7 max-w-[168px] shrink-0 items-center rounded-md border text-[11px] cursor-pointer select-none drag-none transition-[background-color,border-color,color,box-shadow] duration-150 before:pointer-events-none before:absolute before:-left-[4px] before:h-4 before:w-px before:bg-app-border/55',
                    minimumWidth,
                    active
                        ? 'bg-app-surface/90 text-app-text border-app-border/80 shadow-[0_1px_2px_rgba(0,0,0,0.28)] font-medium before:hidden'
                        : 'text-app-muted border-transparent hover:bg-app-surface/45 hover:text-app-text',
                )}
            >
                <div
                    ref={tabRef}
                    role="tab"
                    aria-selected={active}
                    aria-keyshortcuts={
                        keyboardReorder ? 'Alt+Shift+ArrowLeft Alt+Shift+ArrowRight' : undefined
                    }
                    aria-label={
                        tab.type === 'public-urls' ? `${displayTitle} (Beta)` : displayTitle
                    }
                    aria-describedby={pinned ? pinStatusId : undefined}
                    tabIndex={tabStop ? 0 : -1}
                    data-workspace-tab={tab.id}
                    onKeyDown={(event) => onKeyDown(event, tab.id)}
                    onClick={() => onActivate(tab.id)}
                    title={
                        displayTitle === tab.title
                            ? defaultTitle
                            : `${displayTitle} — ${defaultTitle}`
                    }
                    className={cn(
                        'flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-app-accent/60',
                        appearance.persistentClose && 'pr-8',
                    )}
                >
                    {appearance.icon !== 'none' && (
                        <span
                            aria-hidden="true"
                            className={cn(
                                'flex shrink-0 items-center transition-opacity duration-150',
                                active ? 'opacity-100' : 'opacity-65 group-hover:opacity-90',
                            )}
                        >
                            <WorkspaceTabIcon
                                icon={appearance.icon}
                                fallback={icon}
                            />
                        </span>
                    )}
                    {pinned && (
                        <>
                            <Pin
                                size={11}
                                aria-hidden="true"
                                className="shrink-0 text-app-muted"
                            />
                            <span
                                id={pinStatusId}
                                className="sr-only"
                            >
                                Pinned tab
                            </span>
                        </>
                    )}
                    <div
                        data-workspace-tab-label
                        style={labelStyle}
                        className="min-w-0 max-w-[132px] flex-1 px-0.5 group-hover:[mask-image:var(--zync-tab-label-mask)] group-focus-within:[mask-image:var(--zync-tab-label-mask)]"
                    >
                        {tab.type === 'public-urls' ? (
                            <PublicUrlsLabel className="truncate text-[11px] font-semibold">
                                {displayTitle}
                            </PublicUrlsLabel>
                        ) : (
                            <span className="block truncate">{displayTitle}</span>
                        )}
                    </div>
                </div>
                <WorkspaceTabAccent accent={appearance.accent} />
                {(appearance.showClose || showDisconnect) && (
                    <div
                        data-workspace-tab-actions
                        className={cn(
                            'pointer-events-none absolute inset-y-0 right-1 my-auto isolate flex h-6 items-center gap-0.5 rounded pl-2 transition-opacity duration-100 motion-reduce:transition-none',
                            appearance.persistentClose
                                ? 'opacity-100'
                                : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
                        )}
                    >
                        <span
                            aria-hidden="true"
                            data-workspace-tab-action-fade
                            className={cn(
                                'pointer-events-none absolute inset-y-0 right-0 -z-10 rounded bg-linear-to-r from-transparent via-app-surface/30 to-app-surface/60',
                                appearance.persistentClose
                                    ? 'w-8 group-hover:w-full group-focus-within:w-full'
                                    : 'w-full',
                            )}
                        />
                        {showDisconnect && (
                            <IconButton
                                label={`Disconnect ${displayTitle}`}
                                title="Disconnect"
                                icon={
                                    <Unplug
                                        size={13}
                                        strokeWidth={2}
                                    />
                                }
                                tabIndex={tabStop ? 0 : -1}
                                className={cn(
                                    TAB_ACTION_CLASSES,
                                    REVEAL_ACTION_CLASSES,
                                    'hover:text-control-danger',
                                    appearance.persistentClose &&
                                        'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
                                )}
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onDisconnect(tab.connectionId!, event);
                                }}
                            />
                        )}
                        {appearance.showClose && (
                            <IconButton
                                label={`Close ${displayTitle}`}
                                title="Close tab"
                                icon={
                                    <X
                                        size={13}
                                        strokeWidth={2}
                                    />
                                }
                                tabIndex={tabStop ? 0 : -1}
                                className={cn(
                                    TAB_ACTION_CLASSES,
                                    appearance.persistentClose
                                        ? 'pointer-events-auto'
                                        : REVEAL_ACTION_CLASSES,
                                )}
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    event.currentTarget.focus();
                                    onClose(tab.id, event);
                                }}
                            />
                        )}
                    </div>
                )}
            </div>
            <div
                hidden
                aria-hidden="true"
            >
                <WorkspaceTabDragPreview
                    tab={tab}
                    active={active}
                    icon={icon}
                />
            </div>
        </div>
    );
}

/** Main-tab chrome only. Arrows move focus; activation and lifecycle stay with the owner. */
export const WorkspaceTabList = forwardRef<HTMLDivElement, WorkspaceTabListProps>(
    (
        {
            tabs,
            activeTabId,
            contentMenuItems,
            onActivate,
            onClose,
            onDisconnect,
            onRename,
            onAppearance,
            onSetPinned,
            onMove,
            onActionError,
            closeButtonMode,
            canDisconnect,
            renderIcon,
            onReorder,
            canDrag,
            className,
            ...props
        },
        forwardedRef,
    ) => {
        const listRef = useRef<HTMLDivElement | null>(null);
        const [menu, setMenu] = useState<TabMenuAnchor | null>(null);
        const menuTab = tabs.find((tab) => tab.id === menu?.tabId);
        useEffect(() => {
            if (menu && !menuTab) {
                setMenu(null);
            }
        }, [menu, menuTab]);
        const closeMenu = () => {
            const active = document.activeElement;
            if (
                menu?.opener.isConnected &&
                (active === document.body ||
                    (active instanceof Element &&
                        active.closest('.context-menu-container, [data-submenu-owner]')))
            ) {
                menu.opener.focus({ preventScroll: true });
            }
            setMenu(null);
        };
        const fromMenu = (action: (id: string) => void) => {
            if (!menu || !menuTab || !menu.opener.isConnected) {
                return;
            }
            menu.opener.focus({ preventScroll: true });
            action(menu.tabId);
        };
        const drag = useWorkspaceTabDrag({
            tabs,
            activeTabId,
            getStrip: () => listRef.current,
            onReorder,
            canDrag,
        });
        const selectedId = tabs.some((tab) => tab.id === activeTabId)
            ? activeTabId
            : (tabs[0]?.id ?? null);
        const [focusedId, setFocusedId] = useState(selectedId);
        const tabStopId = tabs.some((tab) => tab.id === focusedId) ? focusedId : selectedId;
        const setListNode = useCallback(
            (node: HTMLDivElement | null) => {
                listRef.current = node;
                if (typeof forwardedRef === 'function') {
                    forwardedRef(node);
                } else if (forwardedRef) {
                    forwardedRef.current = node;
                }
            },
            [forwardedRef],
        );
        useEffect(() => {
            if (!listRef.current?.contains(document.activeElement)) {
                setFocusedId(selectedId);
            }
        }, [selectedId]);

        const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>, id: string) => {
            // The tab trigger owns these keys; sibling actions keep their native button behavior.
            if (
                event.target !== event.currentTarget ||
                event.defaultPrevented ||
                event.nativeEvent.isComposing ||
                event.ctrlKey ||
                event.metaKey
            ) {
                return;
            }
            if (
                event.altKey &&
                event.shiftKey &&
                (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
            ) {
                event.preventDefault();
                event.stopPropagation();
                const direction = event.key === 'ArrowLeft' ? -1 : 1;
                const index = tabs.findIndex((tab) => tab.id === id);
                const neighbor = index >= 0 ? tabs[index + direction] : undefined;
                if (
                    !onMove ||
                    !neighbor ||
                    isMainTabPinned(tabs[index]) !== isMainTabPinned(neighbor)
                ) {
                    return;
                }
                try {
                    if (onMove(id, direction) !== false) {
                        return;
                    }
                } catch {
                    /* Keep reporting with the feature owner. */
                }
                onActionError?.();
                return;
            }
            if (event.altKey) {
                return;
            }
            if (event.key === 'F2') {
                event.preventDefault();
                event.stopPropagation();
                onRename(id);
                return;
            }
            if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
                event.preventDefault();
                event.stopPropagation();
                const bounds = event.currentTarget.getBoundingClientRect();
                setMenu({
                    tabId: id,
                    x: bounds.left,
                    y: bounds.bottom,
                    keyboard: true,
                    opener: event.currentTarget,
                });
                return;
            }
            if (event.shiftKey) {
                return;
            }
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                onActivate(id);
                return;
            }
            const index = tabs.findIndex((tab) => tab.id === id);
            if (index < 0 || tabs.length === 0) {
                return;
            }
            const next =
                event.key === 'Home'
                    ? tabs[0]
                    : event.key === 'End'
                      ? tabs[tabs.length - 1]
                      : event.key === 'ArrowRight'
                        ? tabs[(index + 1) % tabs.length]
                        : event.key === 'ArrowLeft'
                          ? tabs[(index - 1 + tabs.length) % tabs.length]
                          : undefined;
            if (!next) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            [...(listRef.current?.querySelectorAll<HTMLElement>('[data-workspace-tab]') ?? [])]
                .find((node) => node.dataset.workspaceTab === next.id)
                ?.focus();
        };

        return (
            <>
                <div
                    {...props}
                    ref={setListNode}
                    role="tablist"
                    aria-label="Open workspaces"
                    aria-orientation="horizontal"
                    data-tab-drag-strip
                    className={className}
                    onBlur={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget)) {
                            setFocusedId(selectedId);
                        }
                        props.onBlur?.(event);
                    }}
                >
                    {tabs.map((tab) => (
                        <WorkspaceTabItem
                            key={tab.id}
                            tab={tab}
                            active={activeTabId === tab.id}
                            tabStop={tabStopId === tab.id}
                            disconnectable={canDisconnect(tab)}
                            icon={renderIcon(tab)}
                            onFocus={() => setFocusedId(tab.id)}
                            onKeyDown={handleKeyDown}
                            onActivate={onActivate}
                            onClose={onClose}
                            onDisconnect={onDisconnect}
                            onMenu={setMenu}
                            closeButtonMode={closeButtonMode}
                            keyboardReorder={Boolean(onMove)}
                            onDragPointer={drag.begin}
                            consumeDragClick={drag.consumeClickIfDragged}
                        />
                    ))}
                </div>
                {menu && menuTab && (
                    <ContextMenu
                        x={menu.x}
                        y={menu.y}
                        autoFocus={menu.keyboard}
                        ariaLabel="Workspace tab actions"
                        onClose={closeMenu}
                        items={workspaceTabContextMenu(menuTab, {
                            rename: () => fromMenu(onRename),
                            appearance: onAppearance ? () => fromMenu(onAppearance) : undefined,
                            pin: onSetPinned
                                ? (pinned) => onSetPinned(menu.tabId, pinned)
                                : undefined,
                            contentItems: contentMenuItems?.get(menu.tabId),
                            close: () => {
                                if (
                                    !requestWorkspaceTabCloseFromMenu(
                                        menu.tabId,
                                        listRef.current,
                                        () => setMenu(null),
                                        onClose,
                                    )
                                ) {
                                    onActionError?.();
                                }
                            },
                            disconnect:
                                canDisconnect(menuTab) && menuTab.connectionId
                                    ? () => fromMenu(() => onDisconnect(menuTab.connectionId!))
                                    : undefined,
                            onError: onActionError,
                        })}
                    />
                )}
            </>
        );
    },
);
WorkspaceTabList.displayName = 'WorkspaceTabList';
