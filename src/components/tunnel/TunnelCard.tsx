import { ExternalLink, Trash2, ArrowRight, Copy, Square, Play } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { OSIcon } from '../icons/OSIcon';

export interface TunnelConfig {
    id: string;
    connectionId: string;
    name: string;
    type: 'local' | 'remote';
    localPort: number;
    remoteHost: string;
    remotePort: number;
    bindToAny?: boolean;
    status: 'active' | 'error' | 'stopped';
    autoStart?: boolean;
    group?: string;
    error?: string;
    originalPort?: number;
}

interface TunnelCardProps {
    tunnel: TunnelConfig;
    connectionIcon?: string;
    connectionName?: string;
    viewMode?: 'grid' | 'list';
    onToggle: (tunnel: TunnelConfig) => void;
    onEdit: (tunnel: TunnelConfig) => void;
    onDelete: (id: string) => void;
    onOpenBrowser: (port: number) => void;
    onCopy: (text: string) => void;
}

export function TunnelCard({
    tunnel,
    connectionIcon,
    connectionName,
    viewMode = 'grid',
    onToggle,
    onEdit,
    onDelete,
    onOpenBrowser,
    onCopy
}: TunnelCardProps) {
    const isActive = tunnel.status === 'active';

    if (viewMode === 'list') {
        return (
            <div
                className={cn(
                    "group grid grid-cols-[auto_1.5fr_1fr_auto_auto] items-center gap-4 px-3 py-2.5 rounded-lg border transition-all duration-200 hover:bg-app-panel",
                    isActive ? "border-app-accent/20 bg-app-accent/[0.02]" : "border-app-border/40 bg-app-panel/30 hover:border-app-border/60"
                )}
            >
                {/* Status Indicator */}
                <div className="flex items-center justify-center">
                    <div className={cn(
                        "w-2 h-2 rounded-full",
                        isActive ? "bg-app-success shadow-[0_0_6px_rgba(var(--color-app-success),0.4)]" : "bg-app-muted/30"
                    )} />
                </div>

                {/* Identity */}
                <div className="flex flex-col min-w-0">
                    <span className="font-bold text-xs text-app-text truncate">{tunnel.name}</span>
                    <div className="flex items-center gap-1.5 mt-0.5">
                        <OSIcon icon={connectionIcon || 'Server'} className="w-3 h-3 opacity-50" />
                        <span className="text-[10px] text-app-muted truncate">{connectionName || 'Unknown'}</span>
                    </div>
                </div>

                {/* Port Flow */}
                <div className="flex items-center gap-2 text-[11px] font-mono text-app-muted/80">
                    <span className={cn("font-semibold", tunnel.type === 'local' ? "text-app-accent" : "text-app-text")}>
                        {tunnel.type === 'local' ? tunnel.localPort : tunnel.remotePort}
                    </span>
                    <ArrowRight size={12} className="text-app-muted/30" />
                    <span className={cn("truncate max-w-[180px]", tunnel.type === 'remote' ? "text-app-accent" : "text-app-text")}>
                        {tunnel.type === 'local' ? (tunnel.remoteHost === '127.0.0.1' ? 'localhost' : tunnel.remoteHost) : 'localhost'}
                        <span className="opacity-50">:{tunnel.type === 'local' ? tunnel.remotePort : tunnel.localPort}</span>
                    </span>
                </div>

                {/* Badges */}
                <div className="flex items-center gap-2 justify-end">
                    {tunnel.bindToAny && (
                        <span className="text-[9px] font-bold text-orange-400 bg-orange-400/10 px-1.5 py-0.5 rounded border border-orange-400/20 whitespace-nowrap">
                            PUBLIC
                        </span>
                    )}
                    {tunnel.autoStart && (
                        <span className="text-[9px] font-bold text-blue-400 bg-blue-400/10 px-1.5 py-0.5 rounded border border-blue-400/20 whitespace-nowrap">
                            AUTO
                        </span>
                    )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity justify-end">
                    {tunnel.type === 'local' && (
                        <>
                            <button
                                onClick={() => onCopy(`localhost:${tunnel.localPort}`)}
                                className="p-1.5 rounded hover:bg-app-surface text-app-muted hover:text-blue-400 transition-colors"
                                title="Copy Local Address"
                            >
                                <Copy size={13} />
                            </button>
                            <button
                                onClick={() => onOpenBrowser(tunnel.localPort)}
                                className="p-1.5 rounded hover:bg-app-surface text-app-muted hover:text-blue-400 transition-colors"
                                title="Open Browser"
                            >
                                <ExternalLink size={13} />
                            </button>
                        </>
                    )}
                    <button
                        onClick={() => onEdit(tunnel)}
                        className="p-1.5 rounded hover:bg-app-surface text-app-muted hover:text-app-text transition-colors"
                        title="Settings"
                    >
                        <div className="flex gap-0.5">
                            <div className="w-0.5 h-0.5 rounded-full bg-current" />
                            <div className="w-0.5 h-0.5 rounded-full bg-current" />
                            <div className="w-0.5 h-0.5 rounded-full bg-current" />
                        </div>
                    </button>
                    <button
                        onClick={() => onDelete(tunnel.id)}
                        className="p-1.5 rounded hover:bg-red-500/10 text-app-muted hover:text-red-500 transition-colors"
                        title="Delete"
                    >
                        <Trash2 size={13} />
                    </button>
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onToggle(tunnel)}
                        className={cn(
                            "h-7 w-7 p-0 shrink-0 rounded-full transition-all duration-300 ml-2",
                            isActive
                                ? "bg-app-success/10 text-app-success hover:bg-app-success/20"
                                : "bg-app-surface hover:bg-app-accent hover:text-white text-app-muted"
                        )}
                    >
                        {isActive ? <Square size={10} className="fill-current" /> : <Play size={10} className="fill-current ml-0.5" />}
                    </Button>
                </div>
            </div>
        );
    }

    // Grid View (Premium Glass Card)
    return (
        <div
            className={cn(
                "group relative flex flex-col p-2 rounded-xl border transition-all duration-300 overflow-hidden",
                isActive
                    ? "bg-gradient-to-br from-app-panel to-app-accent/5 border-app-accent/30 shadow-[0_4px_20px_-4px_rgba(var(--color-app-success),0.1)] backdrop-blur-md"
                    : "bg-gradient-to-br from-app-panel/80 to-app-panel/40 border-app-border hover:border-app-accent/40 shadow-sm hover:shadow-md backdrop-blur-sm"
            )}
        >
            {/* Header: Identity */}
            <div className="relative flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                    <div className={cn(
                        "flex items-center justify-center w-8 h-8 rounded-lg shadow-inner transition-colors duration-300",
                        isActive ? "bg-app-success/10 text-app-success ring-1 ring-app-success/20" : "bg-app-surface text-app-muted ring-1 ring-app-border/30"
                    )}>
                        <OSIcon icon={connectionIcon || 'Server'} className={cn("w-4 h-4", isActive ? "drop-shadow-[0_0_3px_rgba(var(--color-app-success),0.5)]" : "")} />
                    </div>
                    <div className="flex flex-col">
                        <span className="font-bold text-[11px] text-app-text tracking-tight leading-tight">{tunnel.name}</span>
                        <span className="text-[8px] text-app-muted font-medium tracking-wide uppercase leading-tight">{connectionName || 'Unknown Host'}</span>
                    </div>
                </div>

                {/* Top Right Actions (Hover) */}
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                    {tunnel.status === 'active' && tunnel.type === 'local' && (
                        <button
                            onClick={() => onOpenBrowser(tunnel.localPort)}
                            className="p-1.5 rounded-lg hover:bg-app-surface text-app-accent hover:text-white transition-colors"
                            title="Open Browser"
                        >
                            <ExternalLink size={13} />
                        </button>
                    )}
                    <button
                        onClick={() => onEdit(tunnel)}
                        className="p-1.5 rounded-lg hover:bg-app-surface text-app-muted hover:text-app-text transition-colors"
                        title="Settings"
                    >
                        <div className="flex gap-0.5">
                            <div className="w-0.5 h-0.5 rounded-full bg-current" />
                            <div className="w-0.5 h-0.5 rounded-full bg-current" />
                            <div className="w-0.5 h-0.5 rounded-full bg-current" />
                        </div>
                    </button>
                    <button
                        onClick={() => onDelete(tunnel.id)}
                        className="p-1.5 rounded-lg hover:bg-red-500/10 text-app-muted hover:text-red-500 transition-colors"
                        title="Delete"
                    >
                        <Trash2 size={13} />
                    </button>
                </div>
            </div>

            {/* Body: Port Flow */}
            <div className="relative flex flex-col gap-1 mb-2">
                <div className="flex items-center justify-between bg-app-surface/30 rounded-lg p-1 border border-app-border/10">
                    <span className={cn(
                        "font-mono text-[11px] font-bold",
                        tunnel.type === 'local' ? "text-app-accent" : "text-app-text/70"
                    )}>
                        {tunnel.type === 'local' ? tunnel.localPort : tunnel.remotePort}
                    </span>

                    <div className="flex items-center text-app-border/40 px-1">
                        <div className="h-[1px] w-2 bg-current" />
                        <ArrowRight size={10} className="text-current -ml-1" />
                        <div className="h-[1px] w-2 bg-current -ml-1" />
                    </div>

                    <div className="flex flex-col items-end min-w-0 text-right">
                        <span className={cn(
                            "font-mono text-[11px] font-bold truncate max-w-[100px]",
                            tunnel.type === 'remote' ? "text-app-accent" : "text-app-text/70"
                        )}>
                            {tunnel.type === 'local' ? (tunnel.remoteHost === '127.0.0.1' ? 'localhost' : tunnel.remoteHost) : 'localhost'}
                        </span>
                        <span className="font-mono text-[9px] text-app-muted/50 leading-none">
                            :{tunnel.type === 'local' ? tunnel.remotePort : tunnel.localPort}
                        </span>
                    </div>
                </div>
            </div>

            {/* Footer: Controls */}
            <div className="relative flex items-center justify-between mt-auto pt-1.5 border-t border-app-border/10">
                <div className="flex items-center gap-1">
                    {tunnel.status === 'error' && tunnel.error ? (
                        <div className="group/error relative">
                            <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-red-400/10 text-red-400 border border-red-400/20 cursor-help">
                                <div className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
                                <span className="text-[10px] font-bold uppercase">Error</span>
                            </div>
                            <div className="absolute bottom-full left-0 mb-2 w-48 p-2 bg-app-popover border border-red-500/20 rounded-lg shadow-xl opacity-0 group-hover/error:opacity-100 transition-opacity pointer-events-none z-10 text-[10px] text-red-200">
                                {tunnel.error}
                            </div>
                        </div>
                    ) : (
                        <>
                            {tunnel.bindToAny && (
                                <span className="text-[9px] font-bold text-orange-400 bg-orange-400/10 px-2 py-1 rounded-md border border-orange-400/20">
                                    PUBLIC
                                </span>
                            )}
                            {tunnel.autoStart && (
                                <span className="text-[9px] font-bold text-blue-400 bg-blue-400/10 px-2 py-1 rounded-md border border-blue-400/20">
                                    AUTO
                                </span>
                            )}
                        </>
                    )}
                </div>

                <div className="flex items-center gap-1.5">
                    {tunnel.type === 'local' && (
                        <button
                            onClick={() => onCopy(`localhost:${tunnel.localPort}`)}
                            className="p-1 rounded-md hover:bg-app-surface text-app-muted hover:text-white transition-colors"
                            title="Copy Address"
                        >
                            <Copy size={11} />
                        </button>
                    )}

                    <button
                        onClick={() => onToggle(tunnel)}
                        className={cn(
                            "relative h-6 px-2 rounded-full flex items-center gap-1 transition-all duration-300 font-medium text-[9px] uppercase tracking-wide border",
                            isActive
                                ? "bg-app-success/90 text-app-bg border-transparent hover:bg-app-success hover:shadow-[0_0_10px_rgba(var(--color-app-success),0.4)]"
                                : "bg-app-surface text-app-text border-app-border/30 hover:border-app-accent/50 hover:bg-app-surface/80"
                        )}
                    >
                        {isActive ? (
                            <>
                                <span>On</span>
                                <div className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                            </>
                        ) : (
                            <>
                                <div className="w-1.5 h-1.5 rounded-full bg-app-muted" />
                                <span>Off</span>
                            </>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}
