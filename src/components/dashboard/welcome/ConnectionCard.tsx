import type { MouseEvent } from 'react';
import { Bookmark, FileKey, Lock } from 'lucide-react';
import { OSIcon } from '../../icons/OSIcon';
import { cn } from '../../../lib/utils';
import type { Connection } from '../../../store/connectionSlice';

/** Formats a timestamp into a compact relative label used in the welcome list. */
export function getRelativeTime(ts: number): string {
    if (!ts) return '';
    const diff = Date.now() - ts;
    if (diff < 0) return 'just now';
    const m = Math.floor(diff / 60_000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m`;
    const h = Math.floor(diff / 3_600_000);
    if (h < 24) return `${h}h`;
    const d = Math.floor(diff / 86_400_000);
    if (d < 7) return `${d}d`;
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

interface ConnectionCardProps {
    conn: Connection;
    onOpen: (id: string) => void;
    onToggleFavorite: (id: string) => void;
    onContextMenu?: (e: MouseEvent, conn: Connection) => void;
}

/** Compact, accessible card for opening and managing a saved connection. */
export function ConnectionCard({ conn, onOpen, onToggleFavorite, onContextMenu }: ConnectionCardProps) {
    const isConnected = conn.status === 'connected';
    const isFav       = Boolean(conn.isFavorite);
    const displayName = conn.name || conn.host;
    const hasKey      = Boolean(conn.privateKeyPath);
    const hasPass     = Boolean(conn.password) && !hasKey;

    // Build a descriptive label so screen readers convey status, auth, and port
    const cardLabel = [
        `Open ${displayName}`,
        isConnected    ? 'connected'          : null,
        hasKey         ? 'key authentication' : null,
        hasPass        ? 'password authentication' : null,
        conn.port !== 22 ? `port ${conn.port}` : null,
    ].filter(Boolean).join(', ');

    return (
        <div
            className="group relative flex items-center gap-1"
        >
            {/* Favorite left accent bar */}
            {isFav && (
                <div
                    aria-hidden="true"
                    className="absolute left-0 top-2 bottom-2 w-0.5 bg-yellow-500/50 rounded-full"
                />
            )}

            <button
                type="button"
                aria-label={cardLabel}
                className="flex flex-1 min-w-0 items-center gap-2.5 px-3 py-2.5 rounded-xl text-left transition-all hover:bg-app-surface/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/40"
                onClick={() => onOpen(conn.id)}
                onContextMenu={(e) => {
                    if (!onContextMenu) return;
                    e.preventDefault();
                    onContextMenu(e, conn);
                }}
            >
                {/* Icon with connected pulse overlay */}
                <div className="relative shrink-0">
                    <div
                        className={cn(
                            'w-7 h-7 rounded-lg flex items-center justify-center transition-colors',
                            isConnected
                                ? 'bg-green-500/15 text-green-400'
                                : isFav
                                    ? 'bg-yellow-500/10 text-yellow-500/60'
                                    : 'bg-app-surface/80 text-app-muted/50'
                        )}
                    >
                        <OSIcon icon={conn.icon || 'Server'} className="w-3.5 h-3.5" />
                    </div>

                    {/* Status pulse dot */}
                    {isConnected && (
                        <span className="absolute -bottom-0.5 -right-0.5 flex h-2 w-2" aria-hidden="true">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-40" />
                            <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500 border border-app-bg" />
                        </span>
                    )}
                </div>

                {/* Name + host */}
                <div className="flex-1 min-w-0">
                    <span className={cn(
                        'block text-xs font-medium truncate leading-tight',
                        isFav ? 'text-app-text' : 'text-app-text/75'
                    )}>
                        {displayName}
                    </span>
                    <span className="block text-[10px] text-app-muted/55 font-mono truncate">
                        {conn.username}@{conn.host}
                    </span>
                </div>

                {/* Auth + port badges */}
                <div className="flex items-center gap-1 shrink-0" aria-hidden="true">
                    {hasKey && <FileKey size={10} className="text-app-muted/40" />}
                    {hasPass && <Lock size={10} className="text-app-muted/40" />}
                    {conn.port !== 22 && (
                        <span className="text-[9px] text-app-muted/40 font-mono">:{conn.port}</span>
                    )}
                </div>

                {/* Last connected */}
                {conn.lastConnected ? (
                    <span className="text-[10px] text-app-muted/50 font-mono shrink-0 tabular-nums min-w-6 whitespace-nowrap text-right">
                        {getRelativeTime(conn.lastConnected)}
                    </span>
                ) : null}
            </button>

            {/* Favorite toggle */}
            <button
                type="button"
                aria-label={isFav ? `Remove ${displayName} from favorites` : `Add ${displayName} to favorites`}
                onClick={(e) => { e.stopPropagation(); onToggleFavorite(conn.id); }}
                onKeyDown={(e) => e.stopPropagation()}
                className={cn(
                    'p-1.5 rounded-lg shrink-0 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/40',
                    isFav
                        ? 'text-yellow-500/60 hover:text-yellow-500'
                        : 'text-transparent group-hover:text-app-muted/35 hover:text-app-muted/60'
                )}
            >
                <Bookmark size={11} className={isFav ? 'fill-yellow-500/60' : ''} />
            </button>
        </div>
    );
}
