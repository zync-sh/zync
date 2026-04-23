import React, { useState, useRef, useEffect } from 'react';
import { Terminal, Plus, Network, Bookmark, Search, Command, Laptop, FolderPlus, Copy, Pencil, Trash2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { useAppStore } from '../../store/useAppStore';
import { AddTunnelModal } from '../modals/AddTunnelModal';
import { DashboardClock } from './welcome/DashboardClock';
import { QuickConnectBar } from './welcome/QuickConnectBar';
import { ConnectionCard } from './welcome/ConnectionCard';
import { ContextMenu } from '../ui/ContextMenu';
import type { ContextMenuItem } from '../ui/ContextMenu';
import type { Connection } from '../../store/connectionSlice';

// ── Animation ─────────────────────────────────────────────────────────────────

const stagger = {
    hidden:  { opacity: 0 },
    visible: { opacity: 1, transition: { staggerChildren: 0.05 } },
};

const item = {
    hidden:  { opacity: 0, y: 6 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.2 } },
};

// ── Local sub-components ──────────────────────────────────────────────────────

interface ActionButtonProps {
    label: string;
    icon: React.ReactNode;
    iconColor: string;
    onClick: () => void;
}

/** Small reusable action button used in the welcome quick-actions row. */
function ActionButton({ label, icon, iconColor, onClick }: ActionButtonProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl border border-app-border/40 bg-app-surface/30 hover:bg-app-surface/60 hover:border-app-border/70 transition-all text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/40"
        >
            <span className={`shrink-0 ${iconColor}`}>{icon}</span>
            <span className="text-xs font-medium text-app-text/80">{label}</span>
        </button>
    );
}

/** Standardized uppercase section heading used by connection lists. */
function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
    return (
        <h2
            id={id}
            className="text-[10px] font-semibold uppercase tracking-widest text-app-muted/60 mb-1 px-3"
        >
            {children}
        </h2>
    );
}


/** Empty state shown when there are no saved connections. */
function EmptyState({ onAdd }: { onAdd: () => void }) {
    return (
        <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-12 h-12 bg-app-surface/40 rounded-2xl flex items-center justify-center mb-4 border border-app-border/30">
                <Terminal size={18} className="text-app-muted/40" aria-hidden="true" />
            </div>
            <p className="text-sm font-medium text-app-text/60 mb-1">No connections yet</p>
            <p className="text-xs text-app-muted/40 mb-5 max-w-xs leading-relaxed">
                Quick-connect above or add a saved connection to get started.
            </p>
            <button
                type="button"
                onClick={onAdd}
                className="px-4 py-2 bg-app-accent text-white rounded-xl text-xs font-medium hover:brightness-110 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/50"
            >
                Add Connection
            </button>
        </div>
    );
}

// ── WelcomeScreen ─────────────────────────────────────────────────────────────

/** Main launch/home surface for quick connect, actions, and saved connection access. */
export function WelcomeScreen() {
    const connections               = useAppStore(s => s.connections);
    const openTab                   = useAppStore(s => s.openTab);
    const setAddConnectionModalOpen = useAppStore(s => s.setAddConnectionModalOpen);
    const addConnection             = useAppStore(s => s.addConnection);
    const toggleFavorite            = useAppStore(s => s.toggleFavorite);
    const deleteConnection          = useAppStore(s => s.deleteConnection);
    const openConnectionModal       = useAppStore(s => s.openConnectionModal);
    const openPortForwardingTab     = useAppStore(s => s.openPortForwardingTab);
    const showToast                 = useAppStore(s => s.showToast);
    const showConfirmDialog         = useAppStore(s => s.showConfirmDialog);

    const [isAddTunnelModalOpen, setIsAddTunnelModalOpen] = useState(false);
    const [isNewMenuOpen, setIsNewMenuOpen] = useState(false);
    const [newMenuFocusIndex, setNewMenuFocusIndex] = useState(-1);
    const [filterTerm, setFilterTerm] = useState('');
    const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; conn: Connection } | null>(null);
    const newMenuRef = useRef<HTMLDivElement>(null);
    const newMenuToggleRef = useRef<HTMLButtonElement>(null);
    const newMenuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);

    const platform = typeof navigator !== 'undefined'
        ? ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.userAgent)
        : '';
    const isMac = /mac/i.test(platform);
    const cmdKey = isMac ? '⌘⇧P' : 'Ctrl+⇧P';

    function handleCommandPalette() {
        window.dispatchEvent(new CustomEvent('zync:open-command-palette', {
            detail: { commandMode: true },
        }));
    }

    useEffect(() => {
        if (!isNewMenuOpen) return;
        function onPointerDown(e: PointerEvent) {
            if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) {
                setIsNewMenuOpen(false);
            }
        }
        document.addEventListener('pointerdown', onPointerDown);
        return () => document.removeEventListener('pointerdown', onPointerDown);
    }, [isNewMenuOpen]);

    useEffect(() => {
        if (!isNewMenuOpen) {
            newMenuItemRefs.current = [];
            setNewMenuFocusIndex(-1);
            return;
        }
        setNewMenuFocusIndex(0);
        requestAnimationFrame(() => newMenuItemRefs.current[0]?.focus());
    }, [isNewMenuOpen]);

    function closeNewMenu() {
        setIsNewMenuOpen(false);
        newMenuItemRefs.current = [];
        setNewMenuFocusIndex(-1);
        requestAnimationFrame(() => newMenuToggleRef.current?.focus());
    }

    function getNewMenuItemCount() {
        return newMenuItemRefs.current.filter(Boolean).length;
    }

    function focusNewMenuItem(index: number) {
        const count = getNewMenuItemCount();
        if (count === 0) return;
        const next = ((index % count) + count) % count;
        setNewMenuFocusIndex(next);
        newMenuItemRefs.current[next]?.focus();
    }

    function handleNewMenuToggleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
        if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsNewMenuOpen(true);
            setNewMenuFocusIndex(0);
            requestAnimationFrame(() => newMenuItemRefs.current[0]?.focus());
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            setIsNewMenuOpen(true);
            requestAnimationFrame(() => {
                const count = getNewMenuItemCount();
                if (count === 0) return;
                const lastIndex = count - 1;
                setNewMenuFocusIndex(lastIndex);
                newMenuItemRefs.current[lastIndex]?.focus();
            });
        }
    }

    function handleNewMenuKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
        if (!isNewMenuOpen) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            closeNewMenu();
            return;
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            focusNewMenuItem(newMenuFocusIndex + 1);
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            focusNewMenuItem(newMenuFocusIndex - 1);
            return;
        }
        if (e.key === 'Home') {
            e.preventDefault();
            focusNewMenuItem(0);
            return;
        }
        if (e.key === 'End') {
            e.preventDefault();
            const count = getNewMenuItemCount();
            focusNewMenuItem(count - 1);
            return;
        }
        if ((e.key === 'Enter' || e.key === ' ') && newMenuFocusIndex >= 0) {
            e.preventDefault();
            newMenuItemRefs.current[newMenuFocusIndex]?.click();
        }
    }

    const filterFn = (c: (typeof connections)[number]) => {
        if (!filterTerm.trim()) return true;
        const t = filterTerm.toLowerCase();
        return (
            (c.name || '').toLowerCase().includes(t) ||
            c.host.toLowerCase().includes(t) ||
            c.username.toLowerCase().includes(t)
        );
    };

    function connSort(a: (typeof connections)[number], b: (typeof connections)[number]) {
        const aConn = a.status === 'connected' ? 1 : 0;
        const bConn = b.status === 'connected' ? 1 : 0;
        if (bConn !== aConn) return bConn - aConn;
        return (b.lastConnected ?? 0) - (a.lastConnected ?? 0);
    }

    const favorites = connections
        .filter(c => c.isFavorite && filterFn(c))
        .sort(connSort);

    const isFiltering = filterTerm.trim().length > 0;

    const recents = connections
        .filter(c => !c.isFavorite && filterFn(c) && (isFiltering || Boolean(c.lastConnected)))
        .sort(connSort);

    const favConnectedCount    = favorites.filter(c => c.status === 'connected').length;
    const recentConnectedCount = recents.filter(c => c.status === 'connected').length;

    function handleCardContextMenu(e: React.MouseEvent, conn: Connection) {
        e.preventDefault();
        e.stopPropagation();
        setCtxMenu({ x: e.clientX, y: e.clientY, conn });
    }

    function buildContextMenuItems(conn: Connection): ContextMenuItem[] {
        return [
            {
                label: 'Connect',
                icon: <Terminal size={13} />,
                action: () => openTab(conn.id),
            },
            {
                label: 'Copy host',
                icon: <Copy size={13} />,
                action: () => {
                    navigator.clipboard
                        .writeText(conn.host)
                        .then(() => showToast('success', `Copied "${conn.host}"`))
                        .catch((error) => {
                            console.error('[WelcomeScreen] Failed to copy host', error);
                            showToast('error', 'Failed to copy host to clipboard');
                        });
                },
            },
            { separator: true },
            {
                label: 'Edit',
                icon: <Pencil size={13} />,
                action: () => openConnectionModal(conn.id),
            },
            { separator: true },
            {
                label: 'Delete',
                icon: <Trash2 size={13} />,
                variant: 'danger',
                action: async () => {
                    const confirmed = await showConfirmDialog({
                        title: 'Delete connection?',
                        message: `This will remove "${conn.name || `${conn.username}@${conn.host}`}" from saved connections.`,
                        confirmText: 'Delete',
                        cancelText: 'Cancel',
                        variant: 'danger',
                    });
                    if (!confirmed) return;
                    deleteConnection(conn.id);
                    showToast('success', 'Connection deleted');
                },
            },
        ];
    }

    function handleConnect(
        host: string,
        username: string,
        port: number,
        password?: string,
        privateKeyPath?: string,
        save = true,
    ) {
        const id = save ? crypto.randomUUID() : `temp-${crypto.randomUUID()}`;
        addConnection(
            { id, name: `${username}@${host}`, host, username, port, password, privateKeyPath, status: 'disconnected', createdAt: Date.now() },
            !save,
        );
        openTab(id);
    }

    return (
        <motion.main
            aria-label="Zync dashboard"
            initial="hidden"
            animate="visible"
            variants={stagger}
            className="w-full h-full flex flex-col overflow-hidden relative isolate"
        >
            {/* Subtle radial dot grid */}
            <div
                aria-hidden="true"
                className="absolute inset-0 -z-10 bg-app-bg bg-[radial-gradient(var(--color-app-border)_1px,transparent_1px)] bg-size-[18px_18px] mask-[radial-gradient(ellipse_70%_60%_at_50%_50%,black_30%,transparent_100%)] opacity-40"
            />

            {/* Scrollable centered column */}
            <div
                className="flex-1 overflow-y-auto"
                style={{
                    maskImage: 'linear-gradient(to bottom, transparent, black 1.5rem, black calc(100% - 1.5rem), transparent)',
                    WebkitMaskImage: 'linear-gradient(to bottom, transparent, black 1.5rem, black calc(100% - 1.5rem), transparent)',
                }}
            >
                <div className="min-h-full flex flex-col justify-center">
                <div className="max-w-2xl lg:max-w-3xl mx-auto w-full px-4 sm:px-6 py-8">

                    {/* Clock */}
                    <motion.div variants={item} className="mb-5 relative">
                        {/* Accent glow behind hero */}
                        <div
                            aria-hidden="true"
                            className="absolute -top-6 -left-8 w-72 h-40 bg-app-accent/[0.07] rounded-full blur-3xl pointer-events-none"
                        />
                        <DashboardClock />
                    </motion.div>

                    {/* Quick connect */}
                    <motion.div variants={item} className="mb-3">
                        <QuickConnectBar
                            connections={connections}
                            onConnect={handleConnect}
                            onSelectExisting={openTab}
                        />
                    </motion.div>

                    {/* Quick actions */}
                    <motion.div
                        variants={item}
                        className="flex flex-wrap gap-2 mb-5"
                        role="group"
                        aria-label="Quick actions"
                    >
                        <ActionButton
                            label="Local Terminal"
                            icon={<Terminal size={14} />}
                            iconColor="text-app-accent"
                            onClick={() => openTab('local')}
                        />

                        {/* New — dropdown */}
                        <div className="relative" ref={newMenuRef}>
                            <button
                                ref={newMenuToggleRef}
                                id="welcome-new-menu-toggle"
                                type="button"
                                aria-label="New…"
                                aria-expanded={isNewMenuOpen}
                                aria-haspopup="menu"
                                onClick={() => setIsNewMenuOpen(v => !v)}
                                onKeyDown={handleNewMenuToggleKeyDown}
                                className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl border border-app-border/40 bg-app-surface/30 hover:bg-app-surface/60 hover:border-app-border/70 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/40"
                            >
                                <Plus size={14} className="text-green-500 shrink-0" />
                                <span className="text-xs font-medium text-app-text/80">New</span>
                            </button>

                            {isNewMenuOpen && (
                                <div
                                    role="menu"
                                    aria-labelledby="welcome-new-menu-toggle"
                                    onKeyDown={handleNewMenuKeyDown}
                                    className="absolute top-full left-0 mt-1.5 w-44 bg-app-panel border border-app-border rounded-xl shadow-xl z-50 overflow-hidden py-1 animate-in fade-in zoom-in-95 duration-100"
                                >
                                    <button
                                        ref={el => { newMenuItemRefs.current[0] = el; }}
                                        role="menuitem"
                                        type="button"
                                        tabIndex={newMenuFocusIndex === 0 ? 0 : -1}
                                        onFocus={() => setNewMenuFocusIndex(0)}
                                        onClick={() => { setAddConnectionModalOpen(true); closeNewMenu(); }}
                                        className="w-full text-left px-3 py-2 text-xs font-medium text-app-text hover:bg-app-surface flex items-center gap-2.5 transition-colors"
                                    >
                                        <Laptop size={13} className="text-app-muted shrink-0" />
                                        New Host
                                    </button>
                                    <button
                                        ref={el => { newMenuItemRefs.current[1] = el; }}
                                        role="menuitem"
                                        type="button"
                                        tabIndex={newMenuFocusIndex === 1 ? 0 : -1}
                                        onFocus={() => setNewMenuFocusIndex(1)}
                                        onClick={() => { window.dispatchEvent(new Event('ssh-ui:open-folder-modal')); closeNewMenu(); }}
                                        className="w-full text-left px-3 py-2 text-xs font-medium text-app-text hover:bg-app-surface flex items-center gap-2.5 transition-colors"
                                    >
                                        <FolderPlus size={13} className="text-app-muted shrink-0" />
                                        New Folder
                                    </button>
                                    <div className="h-px bg-app-border/40 my-1 mx-2" aria-hidden="true" />
                                    <button
                                        ref={el => { newMenuItemRefs.current[2] = el; }}
                                        role="menuitem"
                                        type="button"
                                        tabIndex={newMenuFocusIndex === 2 ? 0 : -1}
                                        onFocus={() => setNewMenuFocusIndex(2)}
                                        onClick={() => { setIsAddTunnelModalOpen(true); closeNewMenu(); }}
                                        className="w-full text-left px-3 py-2 text-xs font-medium text-app-text hover:bg-app-surface flex items-center gap-2.5 transition-colors"
                                    >
                                        <Network size={13} className="text-app-muted shrink-0" />
                                        New Tunnel
                                    </button>
                                </div>
                            )}
                        </div>

                        <ActionButton
                            label="Port Forwarding"
                            icon={<Network size={14} />}
                            iconColor="text-blue-400"
                            onClick={() => openPortForwardingTab()}
                        />

                        {/* Command Palette */}
                        <button
                            type="button"
                            onClick={handleCommandPalette}
                            aria-label="Open command palette"
                            className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl border border-app-border/40 bg-app-surface/30 hover:bg-app-surface/60 hover:border-app-border/70 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/40"
                        >
                            <Command size={14} className="text-app-muted shrink-0" />
                            <span className="text-xs font-medium text-app-text/80">Palette</span>
                            <kbd className="ml-1 px-1.5 py-0.5 bg-app-bg/60 border border-app-border/50 rounded text-[10px] font-mono text-app-muted/70 leading-none">
                                {cmdKey}
                            </kbd>
                        </button>
                    </motion.div>

                    <AddTunnelModal
                        isOpen={isAddTunnelModalOpen}
                        onClose={() => setIsAddTunnelModalOpen(false)}
                    />

                    {/* Filter bar — only shown when there are connections */}
                    {connections.length > 0 && (
                        <motion.div variants={item} className="mb-3">
                            <div className="relative flex items-center">
                                <Search
                                    size={12}
                                    className="absolute left-1 text-app-muted/30 pointer-events-none"
                                    aria-hidden="true"
                                />
                                <input
                                    type="search"
                                    value={filterTerm}
                                    onChange={(e) => setFilterTerm(e.target.value)}
                                    placeholder="Search"
                                    aria-label="Filter connections"
                                    className="w-full bg-transparent border-b border-app-border/50 focus:border-app-accent/60 pl-6 pr-3 py-1.5 text-xs text-app-text placeholder:text-app-muted/50 outline-none transition-colors"
                                />
                            </div>
                        </motion.div>
                    )}

                    {/* Connections */}
                    {connections.length === 0 ? (
                        <motion.div variants={item}>
                            <EmptyState onAdd={() => setAddConnectionModalOpen(true)} />
                        </motion.div>
                    ) : (
                        <motion.div
                            variants={item}
                            className="flex flex-col sm:flex-row sm:items-start gap-4"
                        >
                            {/* Favorites column */}
                            {favorites.length > 0 && (
                                <section
                                    aria-labelledby="fav-heading"
                                    className="sm:flex-1 min-w-0 flex flex-col max-h-[32vh] sm:max-h-[40vh] overflow-y-auto [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-app-border/30 hover:[&::-webkit-scrollbar-thumb]:bg-app-border/50 [&::-webkit-scrollbar-thumb]:rounded-full"
                                >
                                    <SectionHeading id="fav-heading">
                                        <span className="inline-flex items-center gap-1.5">
                                            <Bookmark
                                                size={10}
                                                className="fill-yellow-500/60 text-yellow-500/60"
                                                aria-hidden="true"
                                            />
                                            Favorites
                                            <span className="font-mono normal-case tracking-normal text-app-muted/40">
                                                {favorites.length}
                                                {favConnectedCount > 0 && (
                                                    <span className="text-green-500/70"> · {favConnectedCount} live</span>
                                                )}
                                            </span>
                                        </span>
                                    </SectionHeading>
                                    <div role="list">
                                        {favorites.map(conn => (
                                            <div key={conn.id} role="listitem">
                                                <ConnectionCard
                                                    conn={conn}
                                                    onOpen={openTab}
                                                    onToggleFavorite={toggleFavorite}
                                                    onContextMenu={handleCardContextMenu}
                                                />
                                            </div>
                                        ))}
                                    </div>
                                </section>
                            )}

                            {/* Divider: horizontal on narrow, vertical on sm+ */}
                            {favorites.length > 0 && recents.length > 0 && (
                                <div aria-hidden="true" className="h-px w-full sm:h-auto sm:w-px sm:self-stretch bg-app-border/30 sm:mx-1 shrink-0" />
                            )}

                            {/* Recent column */}
                            {recents.length > 0 && (
                                <section
                                    aria-labelledby="recent-heading"
                                    className="sm:flex-1 min-w-0 flex flex-col max-h-[32vh] sm:max-h-[40vh] overflow-y-auto [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-app-border/30 hover:[&::-webkit-scrollbar-thumb]:bg-app-border/50 [&::-webkit-scrollbar-thumb]:rounded-full"
                                >
                                    <SectionHeading id="recent-heading">
                                        <span className="inline-flex items-center gap-1.5">
                                            {isFiltering ? 'Matches' : 'Recent'}
                                            <span className="font-mono normal-case tracking-normal text-app-muted/40">
                                                {recents.length}
                                                {recentConnectedCount > 0 && (
                                                    <span className="text-green-500/70"> · {recentConnectedCount} live</span>
                                                )}
                                            </span>
                                        </span>
                                    </SectionHeading>
                                    <div role="list">
                                        {recents.map(conn => (
                                            <div key={conn.id} role="listitem">
                                                <ConnectionCard
                                                    conn={conn}
                                                    onOpen={openTab}
                                                    onToggleFavorite={toggleFavorite}
                                                    onContextMenu={handleCardContextMenu}
                                                />
                                            </div>
                                        ))}
                                    </div>
                                </section>
                            )}
                        </motion.div>
                    )}

                </div>
                </div>
            </div>

            {/* Right-click context menu */}
            {ctxMenu && (
                <ContextMenu
                    x={ctxMenu.x}
                    y={ctxMenu.y}
                    items={buildContextMenuItems(ctxMenu.conn)}
                    onClose={() => setCtxMenu(null)}
                />
            )}
        </motion.main>
    );
}
