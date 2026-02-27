import { ArrowRight, CheckCircle, Loader2, X, XCircle } from 'lucide-react';
import { useEffect, useRef, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore, Transfer, Connection } from '../../store/useAppStore';

interface TransferPanelProps {
  onClose: () => void;
  indicatorRef: RefObject<HTMLButtonElement | null>;
}

export function TransferPanel({ onClose, indicatorRef }: TransferPanelProps) {
  const transfers = useAppStore(state => state.transfers);
  const removeTransfer = useAppStore(state => state.removeTransfer);
  const cancelTransfer = useAppStore(state => state.cancelTransfer);
  const connections = useAppStore(state => state.connections);

  const panelRef = useRef<HTMLDivElement>(null);

  // Auto-remove timers for completed/failed/cancelled transfers
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    transfers.forEach((transfer: Transfer) => {
      if (
        (transfer.status === 'completed' || transfer.status === 'failed' || transfer.status === 'cancelled') &&
        !timersRef.current.has(transfer.id)
      ) {
        const timer = setTimeout(() => {
          removeTransfer(transfer.id);
          timersRef.current.delete(transfer.id);
        }, 5000);
        timersRef.current.set(transfer.id, timer);
      }
    });

    const activeIds = new Set(transfers.map((t: Transfer) => t.id));
    timersRef.current.forEach((timer, id) => {
      if (!activeIds.has(id)) {
        clearTimeout(timer);
        timersRef.current.delete(id);
      }
    });
  }, [transfers, removeTransfer]);

  // Click-outside dismiss
  useEffect(() => {
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
  }, [onClose, indicatorRef]);

  // Escape key dismiss
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const activeTransfers = transfers.filter(
    (t: Transfer) => t.status !== 'completed' && t.status !== 'failed' && t.status !== 'cancelled',
  );

  const recentTransfers = transfers
    .filter((t: Transfer) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled')
    .slice(-3);

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / k ** i).toFixed(2)} ${sizes[i]}`;
  };

  const getConnectionName = (id: string) => {
    if (id === 'local') return 'Local';
    return connections.find((c: Connection) => c.id === id)?.name || 'Unknown';
  };

  const getDisplayName = (transfer: Transfer) => {
    // Archive transfers: sourcePath is like "3 items → archive.tar.gz" — show as-is
    if (transfer.label) return transfer.sourcePath;
    // Regular transfers: extract filename from path
    return transfer.sourcePath.split('/').pop() || transfer.sourcePath;
  };

  const totalItems = activeTransfers.length + recentTransfers.length;

  // Fixed positioning anchored to the indicator button (escapes overflow-hidden parents)
  const rect = indicatorRef.current?.getBoundingClientRect();
  const panelStyle = rect ? {
    bottom: window.innerHeight - rect.top + 6,
    right: window.innerWidth - rect.right,
  } : { bottom: 30, right: 16 };

  return createPortal(
    <div
      ref={panelRef}
      className="fixed w-80 bg-app-panel border border-app-border rounded-lg shadow-xl z-50 animate-in fade-in slide-in-from-bottom-1 duration-150 overflow-hidden"
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
        >
          <X size={12} />
        </button>
      </div>

      {/* Content */}
      <div className="max-h-72 overflow-y-auto">
        {totalItems === 0 ? (
          <div className="text-[11px] text-app-muted text-center py-4">No recent transfers</div>
        ) : (
          <div className="divide-y divide-app-border">
            {/* Active Transfers */}
            {activeTransfers.map((transfer: Transfer) => (
              <div key={transfer.id} className="px-3 py-2.5">
                <div className="flex items-start justify-between mb-1.5">
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-medium text-app-text truncate">{getDisplayName(transfer)}</div>
                    <div className="flex items-center text-[10px] text-app-muted gap-1 mt-0.5">
                      <span className="truncate">{getConnectionName(transfer.sourceConnectionId)}</span>
                      <ArrowRight size={10} />
                      <span className="truncate">{getConnectionName(transfer.destinationConnectionId)}</span>
                    </div>
                  </div>
                  <button
                    onClick={async () => {
                      try {
                        await window.ipcRenderer.invoke('sftp:cancelTransfer', {
                          transferId: transfer.id,
                        });
                        cancelTransfer(transfer.id);
                      } catch (_err) {
                        removeTransfer(transfer.id);
                      }
                    }}
                    title="Cancel Transfer"
                    className="px-1.5 py-0.5 rounded text-rose-500 hover:bg-rose-500/10 transition-colors ml-2 flex items-center text-[9px] font-bold uppercase tracking-wide"
                  >
                    Cancel
                  </button>
                </div>

                {transfer.status === 'transferring' && (() => {
                  const pct = transfer.progress.percentage;
                  const barPct = transfer.label
                    ? Math.min(99, Math.sqrt(pct) * 10)
                    : Math.min(100, pct);
                  return <>
                    <div className="w-full bg-app-border rounded-full h-1 mb-1.5 overflow-hidden">
                      <div
                        className="bg-app-accent h-1 transition-all duration-300"
                        style={{ width: `${barPct}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-app-muted">
                      {transfer.label ? (
                        <span className="font-mono tabular-nums text-[9px] flex items-center gap-1">
                          <Loader2 size={8} className="animate-spin shrink-0" />
                          <span>
                            {transfer.progress.transferred > 0
                              ? `${formatBytes(transfer.progress.transferred)} received`
                              : `${transfer.label}...`}
                          </span>
                          {transfer.progress.transferred > 0 && transfer.speed > 0 && (
                            <span className="text-app-text/60">({formatBytes(transfer.speed)}/s)</span>
                          )}
                        </span>
                      ) : (
                        <span className="font-mono tabular-nums text-[9px]">
                          {formatBytes(transfer.progress.transferred)} / {formatBytes(transfer.progress.total)}
                          <span className="text-app-text/60 ml-1.5">
                            ({formatBytes(transfer.speed || 0)}/s)
                          </span>
                        </span>
                      )}
                      {!transfer.label && (
                        <span className="font-mono tabular-nums text-[9px]">{transfer.progress.percentage.toFixed(1)}%</span>
                      )}
                    </div>
                  </>;
                })()}

                {transfer.status === 'pending' && (
                  <div className="space-y-1">
                    <div className="flex items-center text-[10px] text-app-muted gap-1.5">
                      <Loader2 size={10} className="animate-spin" />
                      <span>{transfer.label ? `${transfer.label}...` : 'Starting...'}</span>
                    </div>
                    <div className="w-full bg-app-border rounded-full h-1 overflow-hidden">
                      <div className="h-full bg-app-accent/50 w-full animate-progress-indeterminate origin-left-right"></div>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* Recent Completed/Failed */}
            {recentTransfers.map((transfer: Transfer) => (
              <div key={transfer.id} className="px-3 py-2 flex items-center justify-between">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  {transfer.status === 'completed' ? (
                    <CheckCircle size={13} className="text-app-success shrink-0" />
                  ) : transfer.status === 'cancelled' ? (
                    <XCircle size={13} className="text-app-muted shrink-0" />
                  ) : (
                    <XCircle size={13} className="text-app-danger shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] text-app-text truncate">{getDisplayName(transfer)}</div>
                    <div className="text-[10px] text-app-muted">
                      {transfer.status === 'completed'
                        ? 'Transfer complete'
                        : transfer.status === 'cancelled'
                          ? 'Cancelled'
                          : transfer.error}
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => removeTransfer(transfer.id)}
                  className="text-app-muted hover:text-app-text transition-colors ml-2 shrink-0"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
