import { useState, useEffect } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
// import { useAppStore, Connection } from '../../store/useAppStore';
import { CheckCircle2, AlertCircle, Loader2, FolderOpen } from 'lucide-react';
import { cn } from '../../lib/utils';
import { OSIcon } from '../icons/OSIcon';

interface ImportSshModalProps {
    isOpen: boolean;
    onClose: () => void;
    onImport: (configs: any[]) => void;
}

export function ImportSshModal({ isOpen, onClose, onImport }: ImportSshModalProps) {
    const [configs, setConfigs] = useState<any[]>([]);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (isOpen) {
            loadConfigs();
        } else {
            setConfigs([]);
            setSelectedIds(new Set());
            setError(null);
        }
    }, [isOpen]);

    const loadConfigs = async () => {
        setIsLoading(true);
        setError(null);
        try {
            const result = await window.ipcRenderer.invoke('ssh:importConfig');
            if (Array.isArray(result)) {
                setConfigs(result);
                // Select all by default
                setSelectedIds(new Set(result.map(c => c.id)));
            } else {
                setConfigs([]);
            }
        } catch (err: any) {
            console.error('Failed to import SSH config', err);
            setError(err.message || 'Failed to read SSH config file');
        } finally {
            setIsLoading(false);
        }
    };

    const toggleSelection = (id: string) => {
        const newSet = new Set(selectedIds);
        if (newSet.has(id)) {
            newSet.delete(id);
        } else {
            newSet.add(id);
        }
        setSelectedIds(newSet);
    };

    const toggleAll = () => {
        if (selectedIds.size === configs.length) {
            setSelectedIds(new Set());
        } else {
            setSelectedIds(new Set(configs.map(c => c.id)));
        }
    };

    const handleImport = async () => {
        setIsLoading(true);
        try {
            const selected = configs.filter(c => selectedIds.has(c.id));

            // Internalize keys (copy to app data)
            const internalizeResult = await window.ipcRenderer.invoke('ssh:internalize-connections', selected);

            // Check how many were internalized
            let internalizedCount = 0;
            if (Array.isArray(internalizeResult)) {
                // We can compare paths or just assume the backend did its job.
                // The result contains the updated connection objects with new paths where successful.
                internalizedCount = internalizeResult.filter((c, i) =>
                    c.privateKeyPath && c.privateKeyPath !== selected[i].privateKeyPath
                ).length;
                console.log(`[Import] Internalized keys for ${internalizedCount} connections.`);

                onImport(internalizeResult);
            } else {
                // Fallback if result weird
                onImport(selected);
            }

            onClose();
        } catch (error) {
            console.error('Failed to internalize keys:', error);
            // Fallback to importing with original paths if internalization fails completely
            const selected = configs.filter(c => selectedIds.has(c.id));
            onImport(selected);
            onClose();
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title="Import SSH Connections"
            className="w-full max-w-lg"
        >
            <div className="flex flex-col h-[500px]">
                {/* Header Info */}
                <div className="px-6 py-4 border-b border-app-border bg-app-surface/30">
                    <p className="text-sm text-app-muted">
                        Select the connections you want to import from your local SSH config file.
                        Duplicates will be skipped automatically.
                    </p>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-4 space-y-2">
                    {isLoading ? (
                        <div className="flex flex-col items-center justify-center h-full text-app-muted gap-3">
                            <Loader2 className="w-8 h-8 animate-spin text-app-accent" />
                            <p>Scanning SSH config...</p>
                        </div>
                    ) : error ? (
                        <div className="flex flex-col items-center justify-center h-full text-red-500 gap-3 p-4 text-center">
                            <AlertCircle className="w-8 h-8" />
                            <p>{error}</p>
                            <Button variant="secondary" size="sm" onClick={loadConfigs}>Retry</Button>
                        </div>
                    ) : configs.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-app-muted gap-3">
                            <FolderOpen className="w-10 h-10 opacity-50" />
                            <p>No SSH configurations found.</p>
                            <p className="text-xs opacity-70">Check ~/.ssh/config</p>
                        </div>
                    ) : (
                        <>
                            <div className="flex items-center justify-between px-2 pb-2">
                                <span className="text-xs font-medium text-app-muted uppercase tracking-wider">
                                    Found {configs.length} Connections
                                </span>
                                <button
                                    onClick={toggleAll}
                                    className="text-xs text-app-accent hover:underline font-medium"
                                >
                                    {selectedIds.size === configs.length ? 'Deselect All' : 'Select All'}
                                </button>
                            </div>

                            <div className="space-y-1">
                                {configs.map((config) => {
                                    const isSelected = selectedIds.has(config.id);
                                    return (
                                        <div
                                            key={config.id}
                                            onClick={() => toggleSelection(config.id)}
                                            className={cn(
                                                "flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all group",
                                                isSelected
                                                    ? "bg-app-accent/5 border-app-accent/30"
                                                    : "bg-app-surface/50 border-app-border hover:bg-app-surface hover:border-app-border/80"
                                            )}
                                        >
                                            <div
                                                className={cn(
                                                    "w-5 h-5 rounded border flex items-center justify-center transition-colors shrink-0",
                                                    isSelected
                                                        ? "bg-app-accent border-app-accent text-white"
                                                        : "bg-app-bg border-app-border text-transparent group-hover:border-app-muted"
                                                )}
                                            >
                                                <CheckCircle2 size={14} className={cn("transition-transform", isSelected ? "scale-100" : "scale-0")} />
                                            </div>

                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center justify-between">
                                                    <h4 className={cn("text-sm font-medium truncate", isSelected ? "text-app-text" : "text-app-muted group-hover:text-app-text")}>
                                                        {config.name || config.host}
                                                    </h4>
                                                    <span className="text-[10px] bg-app-surface px-1.5 py-0.5 rounded border border-app-border text-app-muted">
                                                        {config.host}
                                                    </span>
                                                </div>
                                                <div className="text-xs text-app-muted/70 flex items-center gap-2 mt-0.5">
                                                    <span className="flex items-center gap-1">
                                                        <OSIcon icon="Terminal" className="w-3 h-3 opacity-70" />
                                                        {config.username}
                                                    </span>
                                                    {config.port !== 22 && (
                                                        <span className="flex items-center gap-1">
                                                            <span>:</span>{config.port}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </>
                    )}
                </div>

                {/* Footer */}
                <div className="px-6 py-4 border-t border-app-border bg-app-bg/50 backdrop-blur-sm flex justify-end gap-3 shrink-0">
                    <Button variant="ghost" onClick={onClose}>Cancel</Button>
                    <Button
                        disabled={selectedIds.size === 0 || isLoading}
                        onClick={handleImport}
                    >
                        Import {selectedIds.size > 0 ? `(${selectedIds.size})` : ''}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}

import { registerModal } from '../../lib/modalRegistry';
registerModal('importSsh', ImportSshModal);
