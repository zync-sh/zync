import { AlertTriangle, ArrowRight, CheckCircle, Loader2, X, XCircle } from 'lucide-react';
import { RefObject, useCallback, useEffect, useRef, useState } from 'react';

import {
    fileTransferFailureMessage,
    isFileTransferNotStarted,
    transferErrorMessage,
} from '../../features/files/application/executeFileTransfer';
import { dismissTransferReceipt } from '../../features/files/application/transferEventProjection';
import { formatBytes } from '../../lib/utils';
import { isActiveTransferStatus, isExpiringTransferReceipt } from '../../store/transferSlice';
import { Connection, Transfer, useAppStore } from '../../store/useAppStore';
import { ConfirmModal } from '../ui/ConfirmModal';
import { ZPortal } from '../ui/ZPortal';
import { TransferRecoveryDetails } from './TransferRecoveryDetails';
import { isBenignTransferCancelError } from './transferCancellation';
import { transferRecoveryCopy } from './transferRecoveryCopy';

interface TransferPanelProps {
    onClose: () => void;
    indicatorRef: RefObject<HTMLButtonElement | null>;
}

/** Presents transfer outcomes and bytes without inventing totals for streamed archives. */
export function TransferPanel({ onClose, indicatorRef }: TransferPanelProps) {
    const transfers = useAppStore((state) => state.transfers);
    const requestTransferCancellation = useAppStore((state) => state.requestTransferCancellation);
    const connections = useAppStore((state) => state.connections);
    const confirmDelete = useAppStore((state) => state.settings.fileManager.confirmDelete);

    const panelRef = useRef<HTMLDivElement>(null);
    const [cancellingIds, setCancellingIds] = useState<Set<string>>(new Set());
    const [cleanupConfirmation, setCleanupConfirmation] = useState<{
        transfer: Transfer;
        onConfirm: () => void;
    }>();

    const dismiss = useCallback(async (id: string) => {
        try {
            await dismissTransferReceipt(
                id,
                (command, args) => window.ipcRenderer.invoke(command, args),
                useAppStore.getState,
            );
        } catch {
            useAppStore
                .getState()
                .setLastAction('Could not dismiss the saved transfer receipt', 'error');
        }
    }, []);

    // Only clean success receipts expire; unresolved recovery stays discoverable.
    const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

    useEffect(() => {
        const expiringIds = new Set(
            transfers.filter(isExpiringTransferReceipt).map((transfer) => transfer.id),
        );
        timersRef.current.forEach((timer, id) => {
            if (!expiringIds.has(id)) {
                clearTimeout(timer);
                timersRef.current.delete(id);
            }
        });

        transfers.forEach((transfer: Transfer) => {
            if (isExpiringTransferReceipt(transfer) && !timersRef.current.has(transfer.id)) {
                const timer = setTimeout(() => {
                    const latest = useAppStore
                        .getState()
                        .transfers.find((item) => item.id === transfer.id);
                    if (latest && isExpiringTransferReceipt(latest)) {
                        void dismiss(transfer.id);
                    }
                    // Retain the timer key on failure: do not retry on every progress render.
                }, 5000);
                timersRef.current.set(transfer.id, timer);
            }
        });
    }, [transfers, dismiss]);

    useEffect(() => {
        return () => {
            timersRef.current.forEach((timer) => clearTimeout(timer));
            timersRef.current.clear();
        };
    }, []);

    // Click-outside dismiss
    useEffect(() => {
        if (cleanupConfirmation) {
            return;
        }
        /** Dismisses only pointer events outside both the panel and its trigger. */
        const handler = (e: MouseEvent) => {
            const target = e.target as Node;
            const insidePanel = panelRef.current?.contains(target);
            const insideIndicator = indicatorRef.current?.contains(target);
            if (!insidePanel && !insideIndicator) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [onClose, indicatorRef, cleanupConfirmation]);

    // Escape key dismiss
    useEffect(() => {
        if (cleanupConfirmation) {
            return;
        }
        /** Leaves handled Escape presses with their owning nested control. */
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !e.defaultPrevented) {
                onClose();
            }
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [onClose, cleanupConfirmation]);

    const activeTransfers = transfers.filter((t: Transfer) => isActiveTransferStatus(t.status));

    const recentTransfers = transfers.filter((t: Transfer) => !isActiveTransferStatus(t.status));

    /** Resolves presentation labels without changing the captured transfer endpoints. */
    const getConnectionName = (id: string) => {
        if (id === 'local') {
            return 'Local';
        }
        return connections.find((c: Connection) => c.id === id)?.name || 'Unknown';
    };

    /** Preserves archive descriptions and extracts ordinary transfer leaf names. */
    const getDisplayName = (transfer: Transfer) => {
        // Archive transfers: sourcePath is like "3 items → archive.tar.gz" — show as-is
        if (transfer.label) {
            return transfer.sourcePath;
        }
        // Regular transfers: extract filename from path
        return transfer.sourcePath.split('/').pop() || transfer.sourcePath;
    };

    const totalItems = activeTransfers.length + recentTransfers.length;

    // Fixed positioning anchored to the indicator button (escapes overflow-hidden parents)
    const rect = indicatorRef.current?.getBoundingClientRect();
    const panelStyle = rect
        ? {
              bottom: window.innerHeight - rect.top + 6,
              right: window.innerWidth - rect.right,
          }
        : { bottom: 30, right: 16 };

    return (
        <ZPortal>
            <div
                className="fixed inset-0 z-40 bg-transparent"
                onClick={onClose}
            />
            <div
                ref={panelRef}
                className="absolute z-50 w-80 max-w-[calc(100vw-2rem)] bg-app-panel/95 backdrop-blur-xl border border-app-border rounded-xl shadow-2xl animate-in slide-in-from-top-4 fade-in duration-200"
                style={panelStyle}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-3 py-2 border-b border-app-border">
                    <span className="text-[11px] font-semibold text-app-text">
                        Transfers{totalItems > 0 ? ` (${totalItems})` : ''}
                    </span>
                    <button
                        onClick={onClose}
                        className="text-app-muted hover:text-app-text transition-colors"
                        aria-label="Close"
                        type="button"
                    >
                        <X size={12} />
                    </button>
                </div>

                {/* Content */}
                <div className="max-h-72 overflow-y-auto">
                    {totalItems === 0 ? (
                        <div className="text-[11px] text-app-muted text-center py-4">
                            No recent transfers
                        </div>
                    ) : (
                        <div className="divide-y divide-app-border">
                            {/* Active Transfers */}
                            {activeTransfers.map((transfer: Transfer) => (
                                <div
                                    key={transfer.id}
                                    className="px-3 py-2.5"
                                >
                                    <div className="flex items-start justify-between mb-1.5">
                                        <div className="flex-1 min-w-0">
                                            <div className="text-[11px] font-medium text-app-text truncate">
                                                {getDisplayName(transfer)}
                                            </div>
                                            <div className="flex items-center text-[10px] text-app-muted gap-1 mt-0.5">
                                                <span className="truncate">
                                                    {getConnectionName(transfer.sourceConnectionId)}
                                                </span>
                                                <ArrowRight size={10} />
                                                <span className="truncate">
                                                    {getConnectionName(
                                                        transfer.destinationConnectionId,
                                                    )}
                                                </span>
                                            </div>
                                        </div>
                                        <button
                                            onClick={async () => {
                                                if (
                                                    transfer.status === 'cancelling' ||
                                                    cancellingIds.has(transfer.id)
                                                ) {
                                                    return;
                                                }
                                                setCancellingIds((prev) =>
                                                    new Set(prev).add(transfer.id),
                                                );
                                                try {
                                                    await window.ipcRenderer.invoke(
                                                        'sftp:cancelTransfer',
                                                        {
                                                            transferId: transfer.id,
                                                        },
                                                    );
                                                    requestTransferCancellation(transfer.id);
                                                } catch (err: unknown) {
                                                    const latest = useAppStore
                                                        .getState()
                                                        .transfers.find(
                                                            (item) => item.id === transfer.id,
                                                        );
                                                    if (
                                                        !latest ||
                                                        !isActiveTransferStatus(latest.status)
                                                    ) {
                                                        return;
                                                    }
                                                    const msg = `Failed to cancel transfer: ${transferErrorMessage(err)}`;
                                                    useAppStore
                                                        .getState()
                                                        .setLastAction(
                                                            msg,
                                                            isBenignTransferCancelError(err)
                                                                ? 'info'
                                                                : 'error',
                                                        );
                                                } finally {
                                                    setCancellingIds((prev) => {
                                                        const newSet = new Set(prev);
                                                        newSet.delete(transfer.id);
                                                        return newSet;
                                                    });
                                                }
                                            }}
                                            title={
                                                transfer.status === 'cancelling'
                                                    ? 'Waiting for cancellation confirmation'
                                                    : 'Cancel Transfer'
                                            }
                                            disabled={
                                                transfer.status === 'cancelling' ||
                                                cancellingIds.has(transfer.id)
                                            }
                                            className="px-1.5 py-0.5 rounded text-rose-500 hover:bg-rose-500/10 transition-colors ml-2 flex items-center text-[9px] font-bold uppercase tracking-wide disabled:opacity-50 disabled:cursor-not-allowed"
                                            type="button"
                                        >
                                            {transfer.status === 'cancelling'
                                                ? 'Cancelling…'
                                                : 'Cancel'}
                                        </button>
                                    </div>

                                    {transfer.status === 'transferring' &&
                                        (() => {
                                            const pct = transfer.progress.percentage;
                                            const unknownTotal = transfer.progress.total <= 0;
                                            const barPct = transfer.label
                                                ? Math.min(99, Math.sqrt(pct) * 10)
                                                : Math.min(100, pct);
                                            return (
                                                <>
                                                    <div className="w-full bg-app-border rounded-full h-1 mb-1.5 overflow-hidden">
                                                        <div
                                                            className={
                                                                unknownTotal
                                                                    ? 'bg-app-accent h-1 w-full animate-progress-indeterminate origin-left-right'
                                                                    : 'bg-app-accent h-1 transition-all duration-300'
                                                            }
                                                            style={
                                                                unknownTotal
                                                                    ? undefined
                                                                    : { width: `${barPct}%` }
                                                            }
                                                        />
                                                    </div>
                                                    <div className="flex justify-between text-app-muted">
                                                        {transfer.label || unknownTotal ? (
                                                            <span className="font-mono tabular-nums text-[9px] flex items-center gap-1">
                                                                <Loader2
                                                                    size={8}
                                                                    className="animate-spin shrink-0"
                                                                />
                                                                <span>
                                                                    {transfer.progress.transferred >
                                                                    0
                                                                        ? `${formatBytes(transfer.progress.transferred)} received`
                                                                        : `${transfer.label || 'Receiving'}...`}
                                                                </span>
                                                                {transfer.progress.transferred >
                                                                    0 &&
                                                                    transfer.speed > 0 && (
                                                                        <span className="text-app-text/60">
                                                                            (
                                                                            {formatBytes(
                                                                                transfer.speed,
                                                                            )}
                                                                            /s)
                                                                        </span>
                                                                    )}
                                                            </span>
                                                        ) : (
                                                            <span className="font-mono tabular-nums text-[9px]">
                                                                {formatBytes(
                                                                    transfer.progress.transferred,
                                                                )}{' '}
                                                                /{' '}
                                                                {formatBytes(
                                                                    transfer.progress.total,
                                                                )}
                                                                <span className="text-app-text/60 ml-1.5">
                                                                    (
                                                                    {formatBytes(
                                                                        transfer.speed || 0,
                                                                    )}
                                                                    /s)
                                                                </span>
                                                            </span>
                                                        )}
                                                        {!transfer.label && !unknownTotal && (
                                                            <span className="font-mono tabular-nums text-[9px]">
                                                                {transfer.progress.percentage.toFixed(
                                                                    1,
                                                                )}
                                                                %
                                                            </span>
                                                        )}
                                                    </div>
                                                </>
                                            );
                                        })()}

                                    {transfer.status === 'pending' && (
                                        <div className="space-y-1">
                                            <div className="flex items-center text-[10px] text-app-muted gap-1.5">
                                                <Loader2
                                                    size={10}
                                                    className="animate-spin"
                                                />
                                                <span>
                                                    {transfer.label
                                                        ? `${transfer.label}...`
                                                        : 'Starting...'}
                                                </span>
                                            </div>
                                            <div className="w-full bg-app-border rounded-full h-1 overflow-hidden">
                                                <div className="h-full bg-app-accent/50 w-full animate-progress-indeterminate origin-left-right"></div>
                                            </div>
                                        </div>
                                    )}

                                    {transfer.status === 'cancelling' && (
                                        <div
                                            className="flex items-center text-[10px] text-app-muted gap-1.5"
                                            role="status"
                                        >
                                            <Loader2
                                                size={10}
                                                className="animate-spin"
                                            />
                                            <span>Waiting for transfer to stop…</span>
                                        </div>
                                    )}
                                </div>
                            ))}

                            {/* Recent Completed/Failed */}
                            {recentTransfers.map((transfer: Transfer) => {
                                const recovery = transferRecoveryCopy(transfer);
                                return (
                                    <div
                                        key={transfer.id}
                                        className="px-3 py-2 flex items-center justify-between"
                                    >
                                        <div className="flex items-center gap-2 flex-1 min-w-0">
                                            {transfer.recoveryWarning ? (
                                                <AlertTriangle
                                                    size={13}
                                                    className="text-app-warning shrink-0"
                                                />
                                            ) : transfer.status === 'completed' ? (
                                                <CheckCircle
                                                    size={13}
                                                    className="text-app-success shrink-0"
                                                />
                                            ) : transfer.status === 'cancelled' ? (
                                                <XCircle
                                                    size={13}
                                                    className="text-app-muted shrink-0"
                                                />
                                            ) : (
                                                <XCircle
                                                    size={13}
                                                    className="text-app-danger shrink-0"
                                                />
                                            )}
                                            <div className="flex-1 min-w-0">
                                                <div className="text-[11px] text-app-text truncate">
                                                    {getDisplayName(transfer)}
                                                </div>
                                                <div className="text-[10px] text-app-muted break-words">
                                                    {transfer.status === 'completed'
                                                        ? transfer.recoveryWarning
                                                            ? 'Transfer complete; cleanup needs attention'
                                                            : transfer.recoveryBackupPath
                                                              ? 'Transfer complete; cleanup pending'
                                                              : transfer.combine
                                                                ? 'Folders combined'
                                                                : 'Transfer complete'
                                                        : transfer.status === 'cancelled'
                                                          ? transfer.nativeRecovery
                                                              ? 'Copy cancelled'
                                                              : 'Cancelled'
                                                          : fileTransferFailureMessage(
                                                                transfer.error,
                                                            )}
                                                </div>
                                                {(transfer.status !== 'completed' ||
                                                    transfer.recoveryBackupPath ||
                                                    transfer.recoveryWarning) && (
                                                    <div className="mt-1 space-y-1 text-[10px] text-app-muted">
                                                        {!isFileTransferNotStarted(
                                                            transfer.error,
                                                        ) &&
                                                            recovery.detail && (
                                                                <p>{recovery.detail}</p>
                                                            )}
                                                        {transfer.stageCleaned && (
                                                            <p>No temporary copy remains.</p>
                                                        )}
                                                        {recovery.warning && (
                                                            <p className="text-app-warning break-words">
                                                                {recovery.warning}
                                                            </p>
                                                        )}
                                                        <p className="break-all select-text">
                                                            Destination: {transfer.destinationPath}
                                                        </p>
                                                        {transfer.recoveryDestinationPath &&
                                                            transfer.recoveryDestinationPath !==
                                                                transfer.destinationPath && (
                                                                <p className="break-all select-text">
                                                                    Current item:{' '}
                                                                    {
                                                                        transfer.recoveryDestinationPath
                                                                    }
                                                                </p>
                                                            )}
                                                        {transfer.recoveryStagePath && (
                                                            <p className="break-all select-text">
                                                                Temporary copy:{' '}
                                                                {transfer.recoveryStagePath}
                                                            </p>
                                                        )}
                                                        {transfer.recoveryBackupPath && (
                                                            <p className="break-all select-text">
                                                                {transfer.nativeRecovery
                                                                    ? 'Possible original backup'
                                                                    : 'Original recovery backup'}
                                                                : {transfer.recoveryBackupPath}
                                                            </p>
                                                        )}
                                                        {transfer.nativeRecovery &&
                                                            (transfer.recoveryStagePath ||
                                                                transfer.recoveryBackupPath ||
                                                                transfer.recoveryWarning) &&
                                                            (!transfer.combine?.currentDone ||
                                                                transfer.recoveryStagePath ||
                                                                transfer.recoveryBackupPath) && (
                                                                <TransferRecoveryDetails
                                                                    transfer={transfer}
                                                                    onRequestCleanup={(
                                                                        transfer,
                                                                        onConfirm,
                                                                    ) => {
                                                                        if (confirmDelete) {
                                                                            setCleanupConfirmation({
                                                                                transfer,
                                                                                onConfirm,
                                                                            });
                                                                        } else {
                                                                            onConfirm();
                                                                        }
                                                                    }}
                                                                />
                                                            )}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => void dismiss(transfer.id)}
                                            className="text-app-muted hover:text-app-text transition-colors ml-2 shrink-0"
                                            aria-label="Remove"
                                            title="Clear from history (does not delete files)"
                                            type="button"
                                        >
                                            <X size={12} />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
            <ConfirmModal
                isOpen={Boolean(cleanupConfirmation)}
                onClose={() => setCleanupConfirmation(undefined)}
                onConfirm={() => {
                    const confirm = cleanupConfirmation?.onConfirm;
                    setCleanupConfirmation(undefined);
                    confirm?.();
                }}
                title="Delete Confirmation"
                message={
                    <>
                        Delete this temporary copy? The destination will not be changed. This action
                        cannot be undone.
                        <span className="mt-2 block break-all select-text">
                            {cleanupConfirmation?.transfer.recoveryStagePath}
                        </span>
                    </>
                }
                confirmLabel="Delete"
                variant="danger"
            />
        </ZPortal>
    );
}
