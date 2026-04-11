import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import type { Connection } from '../../store/useAppStore';
import type { ConnectionExchangeExportFormat } from '../../features/connections/infrastructure/connectionTransfer';
import { Search } from 'lucide-react';

interface ExportConnectionsModalProps {
    isOpen: boolean;
    title: string;
    scopeLabel: string;
    scopeKey: string;
    defaultFileBaseName: string;
    connections: Connection[];
    onClose: () => void;
    onExport: (
        format: ConnectionExchangeExportFormat,
        connectionIds: string[],
        fileBaseName: string,
        includeSecrets: boolean,
    ) => Promise<void>;
}

const FORMAT_OPTIONS: Array<{ value: ConnectionExchangeExportFormat; label: string }> = [
    { value: 'ssh_config', label: 'SSH Config' },
    { value: 'json', label: 'JSON' },
    { value: 'csv', label: 'CSV' },
    { value: 'zync', label: 'Zync Format' },
];

export function ExportConnectionsModal({
    isOpen,
    title,
    scopeLabel,
    scopeKey,
    defaultFileBaseName,
    connections,
    onClose,
    onExport,
}: ExportConnectionsModalProps) {
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [format, setFormat] = useState<ConnectionExchangeExportFormat>('zync');
    const [isExporting, setIsExporting] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [fileBaseName, setFileBaseName] = useState(defaultFileBaseName);
    const [includeSecrets, setIncludeSecrets] = useState(false);

    useEffect(() => {
        if (!isOpen) return;
        setSelectedIds(new Set(connections.map((connection) => connection.id)));
        setFormat('zync');
        setIsExporting(false);
        setSearchTerm('');
        setFileBaseName(defaultFileBaseName);
        setIncludeSecrets(false);
    }, [defaultFileBaseName, isOpen, scopeKey]);

    const sortedConnections = useMemo(
        () => [...connections].sort((a, b) => (a.name || a.host).localeCompare(b.name || b.host)),
        [connections]
    );
    const filteredConnections = useMemo(() => {
        const normalized = searchTerm.trim().toLowerCase();
        if (!normalized) return sortedConnections;
        return sortedConnections.filter((connection) => (
            (connection.name || '').toLowerCase().includes(normalized)
            || (connection.host || '').toLowerCase().includes(normalized)
            || (connection.username || '').toLowerCase().includes(normalized)
        ));
    }, [searchTerm, sortedConnections]);
    const selectedCount = selectedIds.size;
    const visibleSelectedCount = filteredConnections.filter((connection) => selectedIds.has(connection.id)).length;
    const allVisibleSelected = filteredConnections.length > 0 && visibleSelectedCount === filteredConnections.length;

    const toggleId = (id: string) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const toggleAll = () => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (allVisibleSelected) {
                filteredConnections.forEach((connection) => next.delete(connection.id));
            } else {
                filteredConnections.forEach((connection) => next.add(connection.id));
            }
            return next;
        });
    };

    const handleExport = async () => {
        if (selectedCount === 0) return;
        setIsExporting(true);
        try {
            await onExport(format, Array.from(selectedIds), fileBaseName.trim() || defaultFileBaseName, includeSecrets);
            onClose();
        } finally {
            setIsExporting(false);
        }
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={title}
            subtitle="Choose hosts and export format."
            className="w-full max-w-2xl"
            contentClassName="p-0 overflow-hidden"
            headerClassName="p-3"
            titleClassName="text-sm"
        >
            <div className="flex h-[520px] flex-col">
                <div className="border-b border-app-border px-4 py-2.5">
                    <div className="flex items-center justify-between gap-3">
                        <p className="text-xs text-app-muted truncate">{scopeLabel} · Selected {selectedCount} of {sortedConnections.length}</p>
                        <button
                            type="button"
                            onClick={toggleAll}
                            className="text-xs text-app-accent hover:underline"
                        >
                            {allVisibleSelected ? 'Deselect visible' : 'Select visible'}
                        </button>
                    </div>
                    <div className="mt-2 grid grid-cols-1 gap-2.5 sm:grid-cols-[minmax(0,1fr)_220px]">
                        <div className="relative">
                            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-app-muted/70" />
                            <input
                                value={searchTerm}
                                onChange={(event) => setSearchTerm(event.target.value)}
                                placeholder="Search host, name, user"
                                className="h-8 w-full rounded-md border border-app-border bg-app-bg pl-7 pr-2 text-xs text-app-text outline-none focus:border-app-accent/60"
                            />
                        </div>
                        <Select
                            value={format}
                            onChange={(value) => setFormat(value as ConnectionExchangeExportFormat)}
                            options={FORMAT_OPTIONS}
                            showSearch={false}
                            showCheck={false}
                            triggerClassName="h-8 rounded-md border border-app-border bg-app-bg px-2 text-xs shadow-none"
                        />
                    </div>
                    <div className="mt-2">
                        <input
                            value={fileBaseName}
                            onChange={(event) => setFileBaseName(event.target.value)}
                            placeholder="File name"
                            className="h-8 w-full rounded-md border border-app-border bg-app-bg px-2 text-xs text-app-text outline-none focus:border-app-accent/60"
                        />
                    </div>
                    <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2">
                        <p className="text-[11px] font-medium text-amber-300">
                            Exported files can contain credentials. Keep them secure.
                        </p>
                        <label className="mt-1.5 flex items-center gap-2 text-[11px] text-amber-200">
                            <input
                                type="checkbox"
                                checked={includeSecrets}
                                onChange={(event) => setIncludeSecrets(event.target.checked)}
                                className="h-3.5 w-3.5 accent-[var(--color-app-accent)]"
                            />
                            Include secrets (passwords/privateKeyPath)
                        </label>
                    </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
                    {filteredConnections.length === 0 ? (
                        <div className="py-8 text-center text-xs text-app-muted">No hosts available in this scope.</div>
                    ) : (
                        <div className="space-y-1.5">
                            {filteredConnections.map((connection) => {
                                const checked = selectedIds.has(connection.id);
                                return (
                                    <label
                                        key={connection.id}
                                        className="flex cursor-pointer items-start gap-2 rounded-md border border-app-border/50 bg-app-surface/20 px-2.5 py-2 hover:bg-app-surface/30"
                                    >
                                        <input
                                            type="checkbox"
                                            checked={checked}
                                            onChange={() => toggleId(connection.id)}
                                            className="mt-0.5 h-3.5 w-3.5 accent-[var(--color-app-accent)]"
                                        />
                                        <div className="min-w-0">
                                            <p className="truncate text-sm font-medium text-app-text">{connection.name || connection.host}</p>
                                            <p className="truncate text-xs text-app-muted">{connection.username}@{connection.host}:{connection.port}</p>
                                        </div>
                                    </label>
                                );
                            })}
                        </div>
                    )}
                </div>

                <div className="border-t border-app-border bg-app-bg/90 px-4 py-2.5">
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={onClose} disabled={isExporting}>
                            Cancel
                        </Button>
                        <Button size="sm" onClick={handleExport} disabled={selectedCount === 0 || isExporting}>
                            {isExporting ? 'Exporting...' : `Export (${selectedCount})`}
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
