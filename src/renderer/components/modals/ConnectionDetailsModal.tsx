import { Monitor, Calendar, Key, Shield, Server, Box, Code } from 'lucide-react';
import { OSIcon } from '../icons/OSIcon';
import { Connection } from '../../store/useAppStore'; // Updated Import
import { Modal } from '../ui/Modal';
import { cn } from '../../lib/utils';

interface ConnectionDetailsModalProps {
    connection: Connection | null;
    isOpen: boolean;
    onClose: () => void;
}

export function ConnectionDetailsModal({ connection, isOpen, onClose }: ConnectionDetailsModalProps) {
    if (!connection) return null;

    // const IconMap: any = { Server, Database, Monitor, Cloud, Box, HardDrive, Globe, Code, Terminal };
    // const Icon = IconMap[connection.icon || 'Server'] || Server;
    const isConnected = connection.status === 'connected';

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Connection Details">
            <div className="space-y-6">

                {/* Header Information */}
                <div className="flex items-start gap-4 p-4 rounded-xl bg-app-surface/50 border border-app-border/50">
                    <div className={cn(
                        "h-16 w-16 rounded-2xl flex items-center justify-center shrink-0 border-2",
                        isConnected
                            ? "bg-app-accent/10 border-app-accent/50 text-app-accent"
                            : "bg-app-bg border-app-border text-app-muted"
                    )}>
                        <OSIcon icon={connection.icon || 'Server'} className="w-8 h-8" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h3 className="text-lg font-bold text-app-text truncate">{connection.name || connection.host}</h3>
                        <div className="flex items-center gap-2 mt-1">
                            <span className={cn(
                                "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border",
                                isConnected
                                    ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20"
                                    : "bg-app-muted/10 text-app-muted border-app-border"
                            )}>
                                <span className={cn("h-1.5 w-1.5 rounded-full", isConnected ? "bg-emerald-500" : "bg-app-muted")} />
                                {isConnected ? 'Connected' : 'Disconnected'}
                            </span>
                            <span className="text-xs text-app-muted/80 font-mono">{connection.id.substring(0, 8)}</span>
                        </div>
                    </div>
                </div>

                {/* Properties Grid */}
                <div className="grid grid-cols-2 gap-4">
                    <DetailItem label="Host" value={connection.host} icon={<Server size={14} />} copyable />
                    <DetailItem label="Port" value={String(connection.port || 22)} icon={<Monitor size={14} />} />
                    <DetailItem label="Username" value={connection.username} icon={<Shield size={14} />} />
                    <DetailItem label="Folder" value={connection.folder || 'Ungrouped'} icon={<Box size={14} />} />

                    <DetailItem
                        label="Authentication"
                        value={connection.privateKeyPath ? 'Private Key' : 'Password'}
                        icon={<Key size={14} />}
                    />
                    <DetailItem
                        label="Last Connected"
                        value={connection.lastConnected ? new Date(connection.lastConnected).toLocaleDateString() : 'Never'}
                        icon={<Calendar size={14} />}
                    />
                </div>

                {/* Additional Technical Info */}
                <div className="space-y-3 pt-2">
                    <h4 className="text-xs font-semibold text-app-muted uppercase tracking-wider">Configuration</h4>
                    <div className="bg-app-bg rounded-lg border border-app-border p-3 space-y-2 text-sm text-app-muted/80 font-mono break-all">
                        {connection.privateKeyPath && (
                            <div className="flex gap-2">
                                <span className="opacity-50 select-none">KEY:</span>
                                <span className="text-app-text/70">{connection.privateKeyPath}</span>
                            </div>
                        )}
                        {connection.theme && (
                            <div className="flex gap-2">
                                <span className="opacity-50 select-none">THEME:</span>
                                <span className="text-app-text/70 capitalize">{connection.theme}</span>
                            </div>
                        )}
                        <div className="flex gap-2">
                            <span className="opacity-50 select-none">CREATED:</span>
                            <span className="text-app-text/70">{new Date(connection.createdAt || Date.now()).toLocaleString()}</span>
                        </div>
                        {connection.tags && connection.tags.length > 0 && (
                            <div className="flex gap-2 pt-1 border-t border-app-border/50 mt-2">
                                <span className="opacity-50 select-none pt-0.5">TAGS:</span>
                                <div className="flex flex-wrap gap-1.5">
                                    {connection.tags.map((tag: string) => (
                                        <span key={tag} className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-app-surface border border-app-border text-app-text/80">
                                            {tag}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </Modal>
    );
}

function DetailItem({ label, value, icon, copyable }: { label: string, value: string, icon: React.ReactNode, copyable?: boolean }) {
    return (
        <div className="p-3 rounded-lg bg-app-surface/30 border border-app-border/30 hover:border-app-border/60 transition-colors group">
            <div className="flex items-center gap-2 text-xs text-app-muted mb-1">
                {icon}
                <span>{label}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
                <div className="font-medium text-app-text/90 text-sm truncate" title={value}>
                    {value}
                </div>
                {copyable && (
                    <button
                        onClick={() => navigator.clipboard.writeText(value)}
                        className="opacity-0 group-hover:opacity-100 p-1 hover:bg-app-surface rounded text-app-muted hover:text-app-accent transition-all"
                        title="Copy"
                    >
                        <Code size={12} />
                    </button>
                )}
            </div>
        </div>
    );
}
