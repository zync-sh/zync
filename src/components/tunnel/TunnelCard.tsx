import type { ReactNode } from 'react';
import {
    ArrowLeft,
    ArrowRight,
    Copy,
    ExternalLink,
    MoreHorizontal,
    Play,
    Square,
    Trash2,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { OSIcon } from '../icons/OSIcon';
import { isDynamicTunnel, socks5Url } from '../../features/tunnels/domain/tunnelTypes';
import {
    formatTunnelFlow,
    TUNNEL_TYPE_META,
    tunnelCopyAddress,
} from '../../features/tunnels/presentation/tunnelDisplay';
import type { TunnelType } from '../../features/tunnels/domain/tunnelTypes';

export interface TunnelConfig {
    id: string;
    connectionId: string;
    name: string;
    type: TunnelType;
    localPort: number;
    remoteHost: string;
    remotePort: number;
    bindToAny?: boolean;
    bindAddress?: string;
    status: 'active' | 'error' | 'stopped';
    autoStart?: boolean;
    group?: string;
    error?: string;
    originalPort?: number;
}

interface TunnelCardProps {
    tunnel: TunnelConfig;
    connectionIcon?: string;
    hostLabel?: string;
    viewMode?: 'grid' | 'list';
    onToggle: (tunnel: TunnelConfig) => void;
    onEdit: (tunnel: TunnelConfig) => void;
    onDelete: (id: string) => void;
    onOpenBrowser: (port: number) => void;
    onCopy: (text: string) => void;
}

const TYPE_BADGE_STYLE: Record<TunnelType, string> = {
    local: 'border-sky-400/20 bg-sky-400/10 text-sky-400',
    remote: 'border-amber-400/20 bg-amber-400/10 text-amber-400',
    dynamic: 'border-violet-400/20 bg-violet-400/10 text-violet-400',
};

function TypeMetaBadge({ type }: { type: TunnelType }) {
    const meta = TUNNEL_TYPE_META[type];
    return (
        <span
            className={cn(
                'rounded-full border px-2 py-0.5 text-[9px] font-semibold',
                TYPE_BADGE_STYLE[type],
            )}
        >
            {meta.label}
            <span className="ml-1 font-mono opacity-80">{meta.flag}</span>
        </span>
    );
}

function PortChip({ children, active }: { children: ReactNode; active?: boolean }) {
    return (
        <span
            className={cn(
                'inline-flex min-w-[2.25rem] items-center justify-center rounded-md px-2 py-1 font-mono text-[11px] tabular-nums ring-1 ring-inset',
                active
                    ? 'bg-app-success/10 text-app-text ring-app-success/25'
                    : 'bg-app-bg/60 text-app-text/90 ring-app-border/35',
            )}
        >
            {children}
        </span>
    );
}

function FlowConnector({ inbound }: { inbound: boolean }) {
    const Arrow = inbound ? ArrowLeft : ArrowRight;
    return (
        <span className="flex shrink-0 items-center gap-0.5 px-0.5 text-app-muted/35">
            <span className="h-px w-2.5 bg-current" />
            <Arrow size={10} strokeWidth={2} />
            <span className="h-px w-2.5 bg-current" />
        </span>
    );
}

function HostEndpoint({
    host,
    port,
    tagged,
}: {
    host: string;
    port: number | null;
    tagged: boolean;
}) {
    if (port === null) {
        return (
            <span className="rounded-md bg-app-bg/60 px-2 py-1 text-[10px] font-medium text-app-muted ring-1 ring-inset ring-app-border/35">
                {host}
            </span>
        );
    }

    if (tagged) {
        return (
            <span className="inline-flex max-w-[11rem] items-center gap-1 rounded-md bg-app-bg/60 py-1 pl-2 pr-1.5 ring-1 ring-inset ring-app-border/35">
                <span className="truncate text-[10px] font-medium text-app-muted">{host}</span>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-app-text/85">:{port}</span>
            </span>
        );
    }

    return (
        <PortChip>
            {host}:{port}
        </PortChip>
    );
}

function FlowLine({
    tunnel,
    hostLabel,
    active,
    spread,
    className,
}: {
    tunnel: TunnelConfig;
    hostLabel?: string;
    active?: boolean;
    spread?: boolean;
    className?: string;
}) {
    const flow = formatTunnelFlow(tunnel, hostLabel);

    return (
        <div
            className={cn(
                'flex min-w-0 items-center gap-1.5',
                spread && 'w-full justify-between gap-2',
                className,
            )}
        >
            <PortChip active={active}>{flow.source}</PortChip>
            <FlowConnector inbound={flow.inbound} />
            <HostEndpoint host={flow.targetHost} port={flow.targetPort} tagged={flow.targetTagged} />
        </div>
    );
}

function StatusToggle({
    isActive,
    onClick,
    compact,
}: {
    isActive: boolean;
    onClick: () => void;
    compact?: boolean;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-lg border font-medium transition-all duration-200',
                compact ? 'h-7 px-2.5 text-[10px]' : 'h-8 gap-2 px-3 text-[11px]',
                isActive
                    ? 'border-app-success/30 bg-app-success/15 text-app-success hover:bg-app-success/20'
                    : 'border-app-border/45 bg-app-surface/50 text-app-muted hover:border-app-border hover:bg-app-surface hover:text-app-text',
            )}
        >
            <span
                className={cn(
                    'flex items-center justify-center rounded-full',
                    compact ? 'h-3.5 w-3.5' : 'h-4 w-4',
                    isActive ? 'bg-app-success/20 text-app-success' : 'bg-app-border/40 text-app-muted',
                )}
            >
                {isActive ? (
                    <Square size={compact ? 7 : 8} className="fill-current" />
                ) : (
                    <Play size={compact ? 7 : 8} className="ml-px fill-current" />
                )}
            </span>
            {isActive ? 'Running' : 'Start'}
        </button>
    );
}

function TunnelMetaBadges({ tunnel }: { tunnel: TunnelConfig }) {
    const isDynamic = isDynamicTunnel(tunnel.type);

    if (tunnel.status === 'error' && tunnel.error) {
        return (
            <>
                <TypeMetaBadge type={tunnel.type} />
                <span
                    className="rounded-full border border-red-400/20 bg-red-400/10 px-2 py-0.5 text-[9px] font-semibold text-red-400"
                    title={tunnel.error}
                >
                    Error
                </span>
            </>
        );
    }

    return (
        <>
            <TypeMetaBadge type={tunnel.type} />
            {tunnel.bindToAny && (
                <span className="rounded-full border border-orange-400/20 bg-orange-400/10 px-2 py-0.5 text-[9px] font-semibold text-orange-400">
                    Public
                </span>
            )}
            {isDynamic && (
                <span className="rounded-full border border-violet-400/20 bg-violet-400/10 px-2 py-0.5 text-[9px] font-semibold text-violet-400">
                    SOCKS
                </span>
            )}
            {tunnel.autoStart && (
                <span className="rounded-full border border-blue-400/20 bg-blue-400/10 px-2 py-0.5 text-[9px] font-semibold text-blue-400">
                    Auto
                </span>
            )}
        </>
    );
}

function CardActionsBar({ children }: { children: ReactNode }) {
    return (
        <div className="flex shrink-0 rounded-md bg-app-panel/90 shadow-sm ring-1 ring-app-border/30 backdrop-blur-sm">
            {children}
        </div>
    );
}

function CardActions({
    tunnel,
    isActive,
    isDynamic,
    onCopy,
    onOpenBrowser,
    onEdit,
    onDelete,
}: {
    tunnel: TunnelConfig;
    isActive: boolean;
    isDynamic: boolean;
    onCopy: () => void;
    onOpenBrowser: (port: number) => void;
    onEdit: () => void;
    onDelete: () => void;
}) {
    return (
        <div className="flex items-center gap-0.5">
            {(tunnel.type === 'local' || isDynamic) && (
                <button
                    type="button"
                    onClick={onCopy}
                    className="rounded-md p-1.5 text-app-muted transition-colors hover:bg-app-surface hover:text-app-text"
                    title={isDynamic ? 'Copy SOCKS URL' : 'Copy local address'}
                >
                    <Copy size={13} />
                </button>
            )}
            {tunnel.type === 'local' && isActive && (
                <button
                    type="button"
                    onClick={() => onOpenBrowser(tunnel.localPort)}
                    className="rounded-md p-1.5 text-app-muted transition-colors hover:bg-app-surface hover:text-app-text"
                    title="Open in browser"
                >
                    <ExternalLink size={13} />
                </button>
            )}
            <button
                type="button"
                onClick={onEdit}
                className="rounded-md p-1.5 text-app-muted transition-colors hover:bg-app-surface hover:text-app-text"
                title="Edit"
            >
                <MoreHorizontal size={13} />
            </button>
            <button
                type="button"
                onClick={onDelete}
                className="rounded-md p-1.5 text-app-muted transition-colors hover:bg-red-500/10 hover:text-red-400"
                title="Delete"
            >
                <Trash2 size={13} />
            </button>
        </div>
    );
}

export function TunnelCard({
    tunnel,
    connectionIcon,
    hostLabel,
    viewMode = 'list',
    onToggle,
    onEdit,
    onDelete,
    onOpenBrowser,
    onCopy,
}: TunnelCardProps) {
    const isActive = tunnel.status === 'active';
    const isDynamic = isDynamicTunnel(tunnel.type);
    const socksUrl = socks5Url(tunnel.bindAddress, tunnel.localPort);
    const copyText = tunnelCopyAddress(tunnel, socksUrl);
    const displayHost = hostLabel?.trim();
    const flow = formatTunnelFlow(tunnel, hostLabel);
    const showHostSubtitle = !!displayHost && !flow.targetTagged;

    const copyFlow = () => onCopy(copyText);

    const shellClass = cn(
        'group relative overflow-hidden rounded-xl border transition-all duration-200',
        isActive
            ? 'border-app-success/25 bg-app-panel/80 shadow-[0_0_0_1px_rgba(16,185,129,0.08)]'
            : 'border-app-border/40 bg-app-panel/40 hover:border-app-border/70 hover:bg-app-panel/55',
    );

    const statusRail = (
        <div
            className={cn(
                'absolute inset-y-2 left-0 w-0.5 rounded-r-full transition-colors',
                isActive ? 'bg-app-success' : 'bg-transparent group-hover:bg-app-border/60',
            )}
        />
    );

    if (viewMode === 'list') {
        return (
            <div className={cn(shellClass, 'flex w-full items-center gap-3 py-2.5 pl-3 pr-3')}>
                {statusRail}

                <div
                    className={cn(
                        'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset',
                        isActive
                            ? 'bg-app-success/10 text-app-success ring-app-success/20'
                            : 'bg-app-surface/60 text-app-muted ring-app-border/30',
                    )}
                >
                    <OSIcon icon={connectionIcon || 'Server'} className="h-4 w-4" />
                </div>

                <div className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold tracking-tight text-app-text">
                        {tunnel.name}
                    </span>
                    {showHostSubtitle && (
                        <p className="mt-0.5 truncate text-[11px] text-app-muted/80">{displayHost}</p>
                    )}
                    <button
                        type="button"
                        onClick={copyFlow}
                        className="mt-1.5 sm:hidden"
                        title="Copy local address"
                    >
                        <FlowLine tunnel={tunnel} hostLabel={hostLabel} active={isActive} />
                    </button>
                </div>

                <button
                    type="button"
                    onClick={copyFlow}
                    className="hidden min-w-0 shrink-0 rounded-lg px-1 py-0.5 transition-colors hover:bg-app-surface/50 sm:block"
                    title="Copy local address"
                >
                    <FlowLine tunnel={tunnel} hostLabel={hostLabel} active={isActive} />
                </button>

                <div className="hidden items-center gap-1 lg:flex">
                    <TunnelMetaBadges tunnel={tunnel} />
                </div>

                <StatusToggle isActive={isActive} onClick={() => onToggle(tunnel)} />

                <CardActionsBar>
                    <CardActions
                        tunnel={tunnel}
                        isActive={isActive}
                        isDynamic={isDynamic}
                        onCopy={copyFlow}
                        onOpenBrowser={onOpenBrowser}
                        onEdit={() => onEdit(tunnel)}
                        onDelete={() => onDelete(tunnel.id)}
                    />
                </CardActionsBar>
            </div>
        );
    }

    return (
        <div className={cn(shellClass, 'flex flex-col gap-2 p-2.5 pl-3')}>
            {statusRail}

            <div className="flex items-start gap-2">
                <div
                    className={cn(
                        'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset',
                        isActive
                            ? 'bg-app-success/10 text-app-success ring-app-success/20'
                            : 'bg-app-surface/60 text-app-muted ring-app-border/30',
                    )}
                >
                    <OSIcon icon={connectionIcon || 'Server'} className="h-3.5 w-3.5" />
                </div>

                <div className="min-w-0 flex-1 pr-14">
                    <span className="block truncate text-[13px] font-semibold leading-tight tracking-tight text-app-text">
                        {tunnel.name}
                    </span>
                    {showHostSubtitle && (
                        <p className="mt-0.5 truncate text-[10px] text-app-muted/75">{displayHost}</p>
                    )}
                </div>
            </div>

            <div className="absolute right-2 top-2">
                <CardActionsBar>
                    <CardActions
                        tunnel={tunnel}
                        isActive={isActive}
                        isDynamic={isDynamic}
                        onCopy={copyFlow}
                        onOpenBrowser={onOpenBrowser}
                        onEdit={() => onEdit(tunnel)}
                        onDelete={() => onDelete(tunnel.id)}
                    />
                </CardActionsBar>
            </div>

            <button
                type="button"
                onClick={copyFlow}
                className="w-full rounded-lg bg-app-bg/50 px-2.5 py-1.5 ring-1 ring-inset ring-app-border/25 transition-colors hover:bg-app-bg/70"
                title="Copy local address"
            >
                <FlowLine
                    tunnel={tunnel}
                    hostLabel={hostLabel}
                    active={isActive}
                    spread
                />
            </button>

            <div className="flex items-center justify-between gap-2">
                <div className="flex min-h-[1.25rem] flex-wrap items-center gap-1">
                    <TunnelMetaBadges tunnel={tunnel} />
                </div>
                <StatusToggle compact isActive={isActive} onClick={() => onToggle(tunnel)} />
            </div>
        </div>
    );
}