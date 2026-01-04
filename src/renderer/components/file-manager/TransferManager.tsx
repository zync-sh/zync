import { ArrowRight, CheckCircle, Loader2, X, XCircle } from 'lucide-react';
import { useEffect } from 'react';
import { useConnections } from '../../context/ConnectionContext';
import { useTransfers } from '../../context/TransferContext';

export function TransferManager() {
  const { transfers, removeTransfer, updateTransferProgress, cancelTransfer } = useTransfers();
  const { connections } = useConnections();

  // Listen for progress events
  useEffect(() => {
    const handler = (
      _: any,
      data: {
        transferred: number;
        total: number;
        percentage: number;
        transferId?: string;
      },
    ) => {
      // Use transferId if provided, otherwise fall back to finding first pending transfer
      const transferId = data.transferId;
      if (transferId) {
        updateTransferProgress(transferId, {
          transferred: data.transferred,
          total: data.total,
          percentage: data.percentage,
        });
      } else {
        // Fallback: find first pending/transferring transfer
        const transfer = transfers.find((t) => t.status === 'pending' || t.status === 'transferring');
        if (transfer) {
          updateTransferProgress(transfer.id, {
            transferred: data.transferred,
            total: data.total,
            percentage: data.percentage,
          });
        }
      }
    };

    window.ipcRenderer.on('transfer:progress', handler);
    return () => window.ipcRenderer.off('transfer:progress', handler);
  }, [transfers, updateTransferProgress]);

  // Auto-remove completed/failed/cancelled transfers after 5 seconds
  useEffect(() => {
    const timers: NodeJS.Timeout[] = [];

    transfers.forEach((transfer) => {
      if (transfer.status === 'completed' || transfer.status === 'failed' || transfer.status === 'cancelled') {
        const timer = setTimeout(() => {
          removeTransfer(transfer.id);
        }, 5000);
        timers.push(timer);
      }
    });

    return () => timers.forEach(clearTimeout);
  }, [transfers, removeTransfer]);

  const activeTransfers = transfers.filter(
    (t) => t.status !== 'completed' && t.status !== 'failed' && t.status !== 'cancelled',
  );

  const recentTransfers = transfers
    .filter((t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled')
    .slice(-3);

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / k ** i).toFixed(2)} ${sizes[i]}`;
  };

  const getConnectionName = (id: string) => {
    return connections.find((c) => c.id === id)?.name || 'Unknown';
  };

  const getFileName = (path: string) => {
    return path.split('/').pop() || path;
  };

  if (activeTransfers.length === 0 && recentTransfers.length === 0) {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 w-96 space-y-2 z-50">
      {/* Active Transfers */}
      {activeTransfers.map((transfer) => (
        <div
          key={transfer.id}
          className="bg-app-panel border border-app-border rounded-lg shadow-xl p-4 backdrop-blur-sm"
        >
          <div className="flex items-start justify-between mb-2">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-app-text truncate mb-1">{getFileName(transfer.sourcePath)}</div>
              <div className="flex items-center text-xs text-app-muted gap-1">
                <span className="truncate">{getConnectionName(transfer.sourceConnectionId)}</span>
                <ArrowRight size={12} />
                <span className="truncate">{getConnectionName(transfer.destinationConnectionId)}</span>
              </div>
            </div>
            <button
              onClick={async () => {
                // Cancel on backend
                try {
                  await window.ipcRenderer.invoke('sftp:cancelTransfer', {
                    transferId: transfer.id,
                  });
                  cancelTransfer(transfer.id);
                } catch (_err) {
                  // If backend cancel fails, just remove from UI
                  removeTransfer(transfer.id);
                }
              }}
              className="text-app-muted hover:text-app-text transition-colors ml-2"
            >
              <X size={16} />
            </button>
          </div>

          {transfer.status === 'transferring' && (
            <>
              <div className="w-full bg-app-border rounded-full h-1.5 mb-2 overflow-hidden">
                <div
                  className="bg-app-accent h-1.5 transition-all duration-300"
                  style={{
                    width: `${Math.min(100, transfer.progress.percentage)}%`,
                  }}
                />
              </div>
              <div className="flex justify-between text-xs text-app-muted">
                <span>
                  {formatBytes(transfer.progress.transferred)} / {formatBytes(transfer.progress.total)}
                </span>
                <span>{transfer.progress.percentage.toFixed(1)}%</span>
              </div>
            </>
          )}

          {transfer.status === 'pending' && (
            <div className="flex items-center text-xs text-app-muted gap-2">
              <Loader2 size={14} className="animate-spin" />
              <span>Starting transfer...</span>
            </div>
          )}
        </div>
      ))}

      {/* Recent Completed/Failed */}
      {recentTransfers.map((transfer) => (
        <div
          key={transfer.id}
          className="bg-app-panel border border-app-border rounded-lg shadow-xl p-3 backdrop-blur-sm opacity-90"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              {transfer.status === 'completed' ? (
                <CheckCircle size={16} className="text-app-success shrink-0" />
              ) : transfer.status === 'cancelled' ? (
                <XCircle size={16} className="text-app-muted shrink-0" />
              ) : (
                <XCircle size={16} className="text-app-danger shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="text-xs text-app-text truncate">{getFileName(transfer.sourcePath)}</div>
                <div className="text-xs text-app-muted">
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
              <X size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
