import {
    Copy,
    ExternalLink,
    LayoutGrid,
    List,
    MoreHorizontal,
    Pencil,
    Search,
    Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { userTunnelActions } from '../../features/tunnels/application/userTunnelStoreActions';
import {
    isDynamicTunnel,
    socks5Url,
    type TunnelType,
} from '../../features/tunnels/domain/tunnelTypes';
import {
    formatTunnelFlow,
    TUNNEL_TYPE_META,
    tunnelCopyAddress,
} from '../../features/tunnels/presentation/tunnelDisplay';
import { cn } from '../../lib/utils';
import { TopbarDropdown } from '../ui/TopbarDropdown';
import type { TunnelConfig } from './TunnelCard';

export type TunnelStatusFilter = 'all' | 'running' | 'stopped' | 'error';
export type TunnelTypeFilter = 'all' | 'local' | 'remote' | 'dynamic';

/** Match saved forward details and optional host labels against a normalized search query. */
export function tunnelMatchesQuery(tunnel: TunnelConfig, query: string, extra?: string[]): boolean {
    const q = query.trim().toLowerCase();
    if (!q) {
        return true;
    }
    const hay = [
        tunnel.name,
        tunnel.localPort != null ? String(tunnel.localPort) : '',
        tunnel.remotePort != null ? String(tunnel.remotePort) : '',
        tunnel.remoteHost,
        tunnel.group,
        ...(extra ?? []),
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    return hay.includes(q);
}

/** Match the forward's runtime status to the selected list filter. */
export function tunnelMatchesStatus(tunnel: TunnelConfig, filter: TunnelStatusFilter): boolean {
    if (filter === 'all') {
        return true;
    }
    if (filter === 'running') {
        return tunnel.status === 'active';
    }
    if (filter === 'error') {
        return tunnel.status === 'error';
    }
    return tunnel.status !== 'active' && tunnel.status !== 'error';
}

/** Match the forward type to the selected list filter. */
export function tunnelMatchesType(tunnel: TunnelConfig, filter: TunnelTypeFilter): boolean {
    if (filter === 'all') {
        return true;
    }
    return tunnel.type === filter;
}

const TYPE_RING: Record<TunnelType, string> = {
    local: 'border border-sky-400/15',
    remote: 'border border-amber-400/15',
    dynamic: 'border border-violet-400/15',
};
const ACTIVE_TUNNEL_RING = 'border border-app-success/50 bg-app-success/5 hover:bg-app-success/10';

const TYPE_LABEL: Record<TunnelType, string> = {
    local: 'text-sky-400',
    remote: 'text-amber-400',
    dynamic: 'text-violet-400',
};

/** Show the forward type and its equivalent SSH command flag. */
function TypeMetaLabel({ type }: { type: TunnelType }) {
    const meta = TUNNEL_TYPE_META[type];
    return (
        <span
            className={cn(
                'shrink-0 text-[10px] font-medium uppercase tracking-wide',
                TYPE_LABEL[type],
            )}
        >
            {meta.label}
            <span className="ml-1 font-mono opacity-70">{meta.flag}</span>
        </span>
    );
}

/** Show the current runtime status and expose any error in the tooltip. */
function StatusDot({ status, error }: { status: TunnelConfig['status']; error?: string }) {
    const color =
        status === 'active'
            ? 'bg-app-success'
            : status === 'error'
              ? 'bg-red-400'
              : 'bg-app-muted/40';
    return (
        <span
            className={cn('inline-block h-1.5 w-1.5 shrink-0 rounded-full', color)}
            title={
                status === 'error' ? error || 'Error' : status === 'active' ? 'Running' : 'Stopped'
            }
        />
    );
}

type TunnelItemHandlers = {
    onToggle: (tunnel: TunnelConfig) => void;
    onEdit: (tunnel: TunnelConfig) => void;
    onDelete: (id: string) => void;
    onOpenBrowser: (port: number) => void;
    onCopy: (text: string) => void;
};

function tunnelFlowLabel(tunnel: TunnelConfig, hostLabel?: string) {
    const flow = formatTunnelFlow(tunnel, hostLabel);
    return flow.targetPort == null
        ? `${flow.source} → ${flow.targetHost}`
        : `${flow.source} → ${flow.targetHost}:${flow.targetPort}`;
}

/** Show the forward's current action and prevent repeated starts while it is pending. */
function TunnelQuickActions({
    tunnel,
    isActive,
    isStarting,
    copyText,
    onToggle,
    onCopy,
    onOpenBrowser,
}: {
    tunnel: TunnelConfig;
    isActive: boolean;
    isStarting: boolean;
    copyText: string;
    onToggle: (tunnel: TunnelConfig) => void;
    onCopy: (text: string) => void;
    onOpenBrowser: (port: number) => void;
}) {
    return (
        <div className="flex shrink-0 items-center gap-0.5">
            <button
                type="button"
                disabled={isStarting}
                onClick={() => onToggle(tunnel)}
                className={cn(
                    'h-6 min-w-16 shrink-0 rounded-md px-2 text-[10px] font-medium transition-colors',
                    isStarting
                        ? 'cursor-wait text-app-muted'
                        : isActive
                          ? 'text-app-success hover:bg-app-success/10'
                          : tunnel.status === 'error'
                            ? 'text-red-400 hover:bg-red-400/10'
                            : 'text-app-muted hover:bg-app-surface hover:text-app-text',
                )}
            >
                {isStarting ? 'Starting…' : isActive ? 'Stop' : 'Start'}
            </button>
            <button
                type="button"
                onClick={() => onCopy(copyText)}
                className="rounded-md p-1 text-app-muted hover:bg-app-surface hover:text-app-text"
                title="Copy address"
            >
                <Copy size={13} />
            </button>
            {tunnel.type === 'local' ? (
                <button
                    type="button"
                    onClick={() => onOpenBrowser(tunnel.localPort)}
                    disabled={!isActive}
                    className="rounded-md p-1 text-app-muted hover:bg-app-surface hover:text-app-text disabled:pointer-events-none disabled:opacity-30"
                    title={isActive ? 'Open in browser' : 'Start the forward to open'}
                >
                    <ExternalLink size={13} />
                </button>
            ) : (
                <span className="inline-block w-6" />
            )}
        </div>
    );
}

/** Keep editing, deletion, and SOCKS copy actions available in either view. */
function TunnelOverflowMenu({
    tunnel,
    socksUrl,
    onCopy,
    onEdit,
    onDelete,
}: {
    tunnel: TunnelConfig;
    socksUrl: string;
    onCopy: (text: string) => void;
    onEdit: (tunnel: TunnelConfig) => void;
    onDelete: (id: string) => void;
}) {
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);
    const isDynamic = isDynamicTunnel(tunnel.type);

    useEffect(() => {
        if (!menuOpen) {
            return;
        }
        const onDown = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [menuOpen]);

    return (
        <div
            className="relative shrink-0"
            ref={menuRef}
        >
            <button
                type="button"
                onClick={() => setMenuOpen((open) => !open)}
                className={cn(
                    'rounded-md p-1 text-app-muted transition-opacity hover:bg-app-surface hover:text-app-text',
                    menuOpen
                        ? 'opacity-100'
                        : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                )}
                title="More"
            >
                <MoreHorizontal size={14} />
            </button>
            {menuOpen && (
                <TopbarDropdown
                    align="right"
                    widthClass="w-40"
                    className="mt-1"
                >
                    {isDynamic && (
                        <button
                            type="button"
                            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-app-surface"
                            onClick={() => {
                                setMenuOpen(false);
                                onCopy(socksUrl);
                            }}
                        >
                            <Copy size={12} /> Copy SOCKS URL
                        </button>
                    )}
                    <button
                        type="button"
                        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-app-surface"
                        onClick={() => {
                            setMenuOpen(false);
                            onEdit(tunnel);
                        }}
                    >
                        <Pencil size={12} /> Edit
                    </button>
                    <button
                        type="button"
                        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-red-400 hover:bg-red-500/10"
                        onClick={() => {
                            setMenuOpen(false);
                            onDelete(tunnel.id);
                        }}
                    >
                        <Trash2 size={12} /> Delete
                    </button>
                </TopbarDropdown>
            )}
        </div>
    );
}

/** Observe the pending start for this forward across both Port Forwarding views. */
function useTunnelStarting({ id, connectionId, status }: TunnelConfig): boolean {
    const getSnapshot = useCallback(
        () => status !== 'active' && userTunnelActions.isStarting({ id, connectionId }),
        [id, connectionId, status],
    );
    return useSyncExternalStore(userTunnelActions.subscribeStarts, getSnapshot);
}

/** Render a saved forward and its start progress in the list. */
export function TunnelRow({
    tunnel,
    hostLabel,
    showHost,
    showGroup = true,
    onToggle,
    onEdit,
    onDelete,
    onOpenBrowser,
    onCopy,
}: {
    tunnel: TunnelConfig;
    hostLabel?: string;
    showHost?: boolean;
    showGroup?: boolean;
} & TunnelItemHandlers) {
    const isActive = tunnel.status === 'active';
    const isStarting = useTunnelStarting(tunnel);
    const socksUrl = socks5Url(tunnel.bindAddress, tunnel.localPort);
    const copyText = tunnelCopyAddress(tunnel, socksUrl);
    const flowLabel = tunnelFlowLabel(tunnel, hostLabel);

    return (
        <div
            aria-busy={isStarting || undefined}
            className={cn(
                'group grid items-center gap-x-3 rounded-lg px-2.5 py-1.5 text-[12px] hover:bg-app-surface/40',
                isActive ? ACTIVE_TUNNEL_RING : TYPE_RING[tunnel.type],
                isStarting && 'tunnel-connecting-border',
                showHost
                    ? 'grid-cols-[auto_minmax(0,1.4fr)_auto_minmax(0,1.6fr)_minmax(0,1fr)_auto_auto]'
                    : 'grid-cols-[auto_minmax(0,1.6fr)_auto_minmax(0,1.8fr)_auto_auto]',
            )}
        >
            <StatusDot
                status={tunnel.status}
                error={tunnel.error}
            />

            <div className="min-w-0">
                <span
                    className="block truncate font-medium text-app-text"
                    title={tunnel.name}
                >
                    {tunnel.name}
                </span>
                {showGroup && tunnel.group ? (
                    <span
                        className="block truncate text-[10px] text-app-muted/50"
                        title={tunnel.group}
                    >
                        {tunnel.group}
                    </span>
                ) : null}
            </div>

            <span className="hidden sm:inline">
                <TypeMetaLabel type={tunnel.type} />
            </span>

            <button
                type="button"
                onClick={() => onCopy(copyText)}
                className="min-w-0 truncate text-left font-mono text-[11px] tabular-nums text-app-muted hover:text-app-text"
                title={tunnel.status === 'error' ? tunnel.error || 'Copy address' : 'Copy address'}
            >
                {flowLabel}
            </button>

            {showHost && (
                <span
                    className="hidden min-w-0 truncate text-app-muted md:block"
                    title={hostLabel}
                >
                    {hostLabel || 'Unknown host'}
                </span>
            )}

            <TunnelQuickActions
                tunnel={tunnel}
                isActive={isActive}
                isStarting={isStarting}
                copyText={copyText}
                onToggle={onToggle}
                onCopy={onCopy}
                onOpenBrowser={onOpenBrowser}
            />

            <TunnelOverflowMenu
                tunnel={tunnel}
                socksUrl={socksUrl}
                onCopy={onCopy}
                onEdit={onEdit}
                onDelete={onDelete}
            />
        </div>
    );
}

/** Render a saved forward and its start progress in the grid. */
export function TunnelGridCard({
    tunnel,
    hostLabel,
    showGroup = true,
    onToggle,
    onEdit,
    onDelete,
    onOpenBrowser,
    onCopy,
}: {
    tunnel: TunnelConfig;
    hostLabel?: string;
    showGroup?: boolean;
} & TunnelItemHandlers) {
    const isActive = tunnel.status === 'active';
    const isStarting = useTunnelStarting(tunnel);
    const socksUrl = socks5Url(tunnel.bindAddress, tunnel.localPort);
    const copyText = tunnelCopyAddress(tunnel, socksUrl);
    const flowLabel = tunnelFlowLabel(tunnel, hostLabel);

    return (
        <div
            aria-busy={isStarting || undefined}
            className={cn(
                'group flex flex-col gap-2 rounded-xl px-3 py-2.5 text-[12px] transition-colors hover:bg-app-surface/40',
                isActive ? ACTIVE_TUNNEL_RING : TYPE_RING[tunnel.type],
                isStarting && 'tunnel-connecting-border',
            )}
        >
            <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    <StatusDot
                        status={tunnel.status}
                        error={tunnel.error}
                    />
                    <div className="min-w-0">
                        <span
                            className="block truncate font-medium text-app-text"
                            title={tunnel.name}
                        >
                            {tunnel.name}
                        </span>
                        {showGroup && tunnel.group ? (
                            <span
                                className="block truncate text-[10px] text-app-muted/50"
                                title={tunnel.group}
                            >
                                {tunnel.group}
                            </span>
                        ) : null}
                    </div>
                </div>
                <TunnelOverflowMenu
                    tunnel={tunnel}
                    socksUrl={socksUrl}
                    onCopy={onCopy}
                    onEdit={onEdit}
                    onDelete={onDelete}
                />
            </div>

            <TypeMetaLabel type={tunnel.type} />

            <button
                type="button"
                onClick={() => onCopy(copyText)}
                className="min-w-0 truncate text-left font-mono text-[11px] tabular-nums text-app-muted hover:text-app-text"
                title={tunnel.status === 'error' ? tunnel.error || 'Copy address' : 'Copy address'}
            >
                {flowLabel}
            </button>

            <TunnelQuickActions
                tunnel={tunnel}
                isActive={isActive}
                isStarting={isStarting}
                copyText={copyText}
                onToggle={onToggle}
                onCopy={onCopy}
                onOpenBrowser={onOpenBrowser}
            />
        </div>
    );
}

const TUNNEL_VIEW_STORAGE_KEY = 'zync-port-forwarding-view';

export function useTunnelViewMode() {
    const [viewMode, setViewModeState] = useState<'grid' | 'list'>(() => {
        try {
            return localStorage.getItem(TUNNEL_VIEW_STORAGE_KEY) === 'grid' ? 'grid' : 'list';
        } catch {
            return 'list';
        }
    });

    const setViewMode = (mode: 'grid' | 'list') => {
        setViewModeState(mode);
        try {
            localStorage.setItem(TUNNEL_VIEW_STORAGE_KEY, mode);
        } catch {
            /* ignore quota / private mode */
        }
    };

    return [viewMode, setViewMode] as const;
}

export function TunnelViewToggle({
    viewMode,
    onChange,
}: {
    viewMode: 'grid' | 'list';
    onChange: (mode: 'grid' | 'list') => void;
}) {
    return (
        <div className="flex rounded-lg border border-app-border/40 bg-app-surface/50 p-0.5">
            <button
                type="button"
                onClick={() => onChange('list')}
                className={cn(
                    'rounded p-1.5 transition-all',
                    viewMode === 'list'
                        ? 'bg-app-accent text-white shadow-sm'
                        : 'text-app-muted hover:bg-app-highlight/30 hover:text-app-text',
                )}
                title="List view"
            >
                <List size={14} />
            </button>
            <button
                type="button"
                onClick={() => onChange('grid')}
                className={cn(
                    'rounded p-1.5 transition-all',
                    viewMode === 'grid'
                        ? 'bg-app-accent text-white shadow-sm'
                        : 'text-app-muted hover:bg-app-highlight/30 hover:text-app-text',
                )}
                title="Grid view"
            >
                <LayoutGrid size={14} />
            </button>
        </div>
    );
}

export function TunnelFilterChip({
    active,
    onClick,
    children,
}: {
    active: boolean;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                'h-6 shrink-0 rounded-md px-2 text-[10px] font-medium transition-colors',
                active
                    ? 'bg-app-surface text-app-text ring-1 ring-app-border/50'
                    : 'text-app-muted hover:bg-app-surface/50 hover:text-app-text',
            )}
        >
            {children}
        </button>
    );
}

export function TunnelTableHeader({ showHost }: { showHost?: boolean }) {
    return (
        <div
            className={cn(
                'grid items-center gap-x-3 px-2.5 pb-1 text-[10px] font-medium uppercase tracking-wide text-app-muted/50',
                showHost
                    ? 'grid-cols-[auto_minmax(0,1.4fr)_auto_minmax(0,1.6fr)_minmax(0,1fr)_auto_auto]'
                    : 'grid-cols-[auto_minmax(0,1.6fr)_auto_minmax(0,1.8fr)_auto_auto]',
            )}
        >
            <span className="w-1.5" />
            <span>Name</span>
            <span className="hidden sm:inline">Type</span>
            <span>Forward</span>
            {showHost && <span className="hidden md:inline">Host</span>}
            <span />
            <span />
        </div>
    );
}

/** Render the controlled search field shared by forwarding views. */
export function TunnelSearchInput({
    query,
    onQueryChange,
    placeholder = 'Search name, port, or host...',
}: {
    query: string;
    onQueryChange: (query: string) => void;
    placeholder?: string;
}) {
    return (
        <div className="relative min-w-[12rem] flex-1">
            <Search
                size={12}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-app-muted/40"
            />
            <input
                type="text"
                value={query}
                onChange={(e) => onQueryChange(e.target.value)}
                placeholder={placeholder}
                className="h-7 w-full rounded-lg border border-app-border/30 bg-app-surface/30 py-1 pl-7 pr-3 text-[11px] placeholder:text-app-muted/30 focus:outline-none focus:ring-1 focus:ring-app-accent/40"
            />
        </div>
    );
}

function countLabel(n: number | undefined) {
    return n && n > 0 ? ` ${n}` : '';
}

/** Render the search field and status and type filters for saved forwards. */
export function TunnelFilterToolbar({
    query,
    onQueryChange,
    status,
    onStatusChange,
    type,
    onTypeChange,
    counts,
    placeholder,
}: {
    query?: string;
    onQueryChange?: (query: string) => void;
    status: TunnelStatusFilter;
    onStatusChange: (status: TunnelStatusFilter) => void;
    type: TunnelTypeFilter;
    onTypeChange: (type: TunnelTypeFilter) => void;
    counts?: {
        running: number;
        stopped: number;
        error: number;
        local: number;
        remote: number;
        dynamic: number;
    };
    placeholder?: string;
}) {
    return (
        <div className="flex flex-wrap items-center gap-3 px-1 pb-3">
            {onQueryChange && (
                <TunnelSearchInput
                    query={query ?? ''}
                    onQueryChange={onQueryChange}
                    placeholder={placeholder}
                />
            )}
            <div className="flex items-center gap-0.5 rounded-lg bg-app-surface/40 p-0.5">
                <TunnelFilterChip
                    active={status === 'all'}
                    onClick={() => onStatusChange('all')}
                >
                    All
                </TunnelFilterChip>
                <TunnelFilterChip
                    active={status === 'running'}
                    onClick={() => onStatusChange('running')}
                >
                    Running{countLabel(counts?.running)}
                </TunnelFilterChip>
                <TunnelFilterChip
                    active={status === 'stopped'}
                    onClick={() => onStatusChange('stopped')}
                >
                    Stopped{countLabel(counts?.stopped)}
                </TunnelFilterChip>
                {(status === 'error' || (counts?.error ?? 0) > 0) && (
                    <TunnelFilterChip
                        active={status === 'error'}
                        onClick={() => onStatusChange('error')}
                    >
                        Error{countLabel(counts?.error)}
                    </TunnelFilterChip>
                )}
            </div>
            <div className="flex items-center gap-0.5 rounded-lg bg-app-surface/40 p-0.5">
                <TunnelFilterChip
                    active={type === 'all'}
                    onClick={() => onTypeChange('all')}
                >
                    All
                </TunnelFilterChip>
                <TunnelFilterChip
                    active={type === 'local'}
                    onClick={() => onTypeChange('local')}
                >
                    <span className="text-sky-400">Local</span>
                </TunnelFilterChip>
                <TunnelFilterChip
                    active={type === 'remote'}
                    onClick={() => onTypeChange('remote')}
                >
                    <span className="text-amber-400">Remote</span>
                </TunnelFilterChip>
                <TunnelFilterChip
                    active={type === 'dynamic'}
                    onClick={() => onTypeChange('dynamic')}
                >
                    <span className="text-violet-400">SOCKS</span>
                </TunnelFilterChip>
            </div>
        </div>
    );
}

/** Count forwards by runtime status for the filter badges. */
export function countTunnelFilters(tunnels: TunnelConfig[]) {
    return {
        running: tunnels.filter((t) => t.status === 'active').length,
        stopped: tunnels.filter((t) => t.status !== 'active' && t.status !== 'error').length,
        error: tunnels.filter((t) => t.status === 'error').length,
        local: tunnels.filter((t) => t.type === 'local').length,
        remote: tunnels.filter((t) => t.type === 'remote').length,
        dynamic: tunnels.filter((t) => t.type === 'dynamic').length,
    };
}
