import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { useAppStore } from '../../store/useAppStore';
import { CheckCircle2, AlertCircle, Loader2, FolderOpen } from 'lucide-react';
import { cn } from '../../lib/utils';
import { OSIcon } from '../icons/OSIcon';
import { importSshConfigIpc, internalizeImportedConnectionsIpc } from '../../features/connections/infrastructure/connectionIpc';
import { applyImportPlan, buildImportPlanRows, type ImportResolution } from '../../features/connections/domain';

interface ImportSshModalProps {
    isOpen: boolean;
    onClose: () => void;
    onImport: (configs: any[]) => void;
    onImportReport?: (report: {
        selected: number;
        created: number;
        updated: number;
        skipped: number;
        renamed: Array<{ id: string; from: string; to: string }>;
    }) => void;
}

const RESOLUTION_OPTIONS: Array<{ value: ImportResolution; label: string }> = [
    { value: 'new', label: 'Import as New' },
    { value: 'update', label: 'Update Existing' },
    { value: 'skip', label: 'Skip' },
];

const createDefaultDecisionMap = (
    existingConnections: any[],
    importedConfigs: any[],
): Record<string, ImportResolution> => {
    const rows = buildImportPlanRows(existingConnections, importedConfigs);
    const defaults: Record<string, ImportResolution> = {};
    for (const row of rows) {
        defaults[row.imported.id] = row.recommended;
    }
    return defaults;
};

export function ImportSshModal({ isOpen, onClose, onImport, onImportReport }: ImportSshModalProps) {
    const existingConnections = useAppStore(state => state.connections);
    const [configs, setConfigs] = useState<any[]>([]);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [decisions, setDecisions] = useState<Record<string, ImportResolution>>({});
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (isOpen) {
            loadConfigs();
        } else {
            setConfigs([]);
            setSelectedIds(new Set());
            setDecisions({});
            setError(null);
        }
    }, [isOpen]);

    const loadConfigs = async () => {
        setIsLoading(true);
        setError(null);
        try {
            const result = await importSshConfigIpc();
            if (Array.isArray(result)) {
                setConfigs(result);
                // Select all by default
                setSelectedIds(new Set(result.map(c => c.id)));
                setDecisions(createDefaultDecisionMap(existingConnections, result));
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

    const rows = useMemo(
        () => buildImportPlanRows(existingConnections, configs),
        [configs, existingConnections]
    );

    const selectedRows = rows.filter((row) => selectedIds.has(row.imported.id));

    const planSummary = useMemo(
        () => applyImportPlan(existingConnections, selectedRows, decisions),
        [decisions, existingConnections, selectedRows]
    );

    const updateDecision = (id: string, next: ImportResolution) => {
        setDecisions((prev) => ({ ...prev, [id]: next }));
    };

    const handleImport = async () => {
        setIsLoading(true);
        try {
            const selected = planSummary.toImport.map((item) => item.connection);

            // Internalize keys (copy to app data)
            const internalizeResult = await internalizeImportedConnectionsIpc(selected);

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
            onImportReport?.({
                selected: selectedIds.size,
                created: planSummary.created,
                updated: planSummary.updated,
                skipped: planSummary.skipped,
                renamed: planSummary.renamed,
            });

            onClose();
        } catch (error) {
            console.error('Failed to internalize keys:', error);
            // Fallback to importing with original paths if internalization fails completely
            const selected = configs.filter(c => selectedIds.has(c.id));
            onImport(selected);
            onImportReport?.({
                selected: selectedIds.size,
                created: planSummary.created,
                updated: planSummary.updated,
                skipped: planSummary.skipped,
                renamed: planSummary.renamed,
            });
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
                        Choose per-item strategy for duplicates (new/update/skip).
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
                            <div className="px-2 pb-2 text-[11px] text-app-muted/80">
                                Plan: {planSummary.created} new · {planSummary.updated} update · {planSummary.skipped} skip
                            </div>

                            <div className="space-y-1">
                                {rows.map((row) => {
                                    const config = row.imported;
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
                                                <div className="flex items-center justify-between gap-2">
                                                    <h4 className={cn("text-sm font-medium truncate", isSelected ? "text-app-text" : "text-app-muted group-hover:text-app-text")}>
                                                        {config.name || config.host}
                                                    </h4>
                                                    <div className="flex items-center gap-2">
                                                        {row.matchedByName && (
                                                            <span className="text-[10px] bg-amber-500/15 px-1.5 py-0.5 rounded border border-amber-500/30 text-amber-300">
                                                                Name conflict
                                                            </span>
                                                        )}
                                                        <span className="text-[10px] bg-app-surface px-1.5 py-0.5 rounded border border-app-border text-app-muted">
                                                            {config.host}
                                                        </span>
                                                    </div>
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
                                                {row.matchedByName && (
                                                    <p className="mt-1 text-[11px] text-amber-300/90">
                                                        Existing: {row.matchedByName.name || row.matchedByName.host}
                                                    </p>
                                                )}
                                            </div>
                                            <div className="shrink-0">
                                                <select
                                                    value={decisions[config.id] || row.recommended}
                                                    onChange={(event) => {
                                                        const next = RESOLUTION_OPTIONS.find((opt) => opt.value === event.target.value)?.value;
                                                        if (next) updateDecision(config.id, next);
                                                    }}
                                                    onClick={(event) => event.stopPropagation()}
                                                    className="h-8 rounded-md border border-app-border bg-app-bg px-2 text-xs text-app-text"
                                                >
                                                    {RESOLUTION_OPTIONS.map((option) => (
                                                        <option key={option.value} value={option.value}>{option.label}</option>
                                                    ))}
                                                </select>
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
                        disabled={selectedIds.size === 0 || isLoading || planSummary.toImport.length === 0}
                        onClick={handleImport}
                    >
                        Import {planSummary.toImport.length > 0 ? `(${planSummary.toImport.length})` : ''}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}

import { registerModal } from '../../lib/modalRegistry';
registerModal('importSsh', ImportSshModal);
