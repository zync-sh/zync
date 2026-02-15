import { ArrowRight, CheckCircle, Loader2, X, XCircle } from 'lucide-react';
import { useEffect } from 'react';
import { useAppStore, Transfer, Connection } from '../../store/useAppStore';

export function TransferManager() {
  const transfers = useAppStore(state => state.transfers);
  const removeTransfer = useAppStore(state => state.removeTransfer);
  // const updateTransferProgress = useAppStore(state => state.updateTransferProgress); // Removed
  const cancelTransfer = useAppStore(state => state.cancelTransfer);

  const connections = useAppStore(state => state.connections);

  // Listen for progress events - REMOVED (Handled by useTransferEvents hook globally)
  // useEffect(() => { ... }, []);

  // Auto-remove completed/failed/cancelled transfers after 5 seconds


  // Auto-remove completed/failed/cancelled transfers after 5 seconds
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];

    transfers.forEach((transfer: Transfer) => {
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

  const getFileName = (path: string) => {
    return path.split('/').pop() || path;
  };

  if (activeTransfers.length === 0 && recentTransfers.length === 0) {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 w-96 space-y-2 z-50">
      {/* Active Transfers */}
      {activeTransfers.map((transfer: Transfer) => (
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
                  removeTransfer(transfer.id);
                }
              }}
              title="Cancel Transfer"
              className="px-2 py-1 rounded-md text-rose-500 hover:bg-rose-500/10 transition-colors ml-2 flex items-center border border-rose-500/20 hover:border-rose-500/40"
            >
              <span className="text-[10px] font-bold mr-1 uppercase tracking-wide">Cancel</span>
              <X size={12} />
            </button>
          </div>

          {
            transfer.status === 'transferring' && (
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
                  <span className="font-mono tabular-nums text-[10px]">
                    {formatBytes(transfer.progress.transferred)} / {formatBytes(transfer.progress.total)}
                    <span className="text-app-text/60 ml-2">
                      ({formatBytes(transfer.speed || 0)}/s)
                    </span>
                  </span>
                  <span className="font-mono tabular-nums">{transfer.progress.percentage.toFixed(1)}%</span>
                </div>
              </>
            )
          }

          {
            transfer.status === 'pending' && (
              <div className="space-y-1">
                <div className="flex items-center text-xs text-app-muted gap-2">
                  <Loader2 size={12} className="animate-spin" />
                  <span>Starting...</span>
                </div>
                <div className="w-full bg-app-border rounded-full h-1 overflow-hidden">
                  <div className="h-full bg-app-accent/50 w-full animate-progress-indeterminate origin-left-right"></div>
                </div>
              </div>
            )
          }
        </div>
      ))
      }

      {/* Recent Completed/Failed */}
      {
        recentTransfers.map((transfer: Transfer) => (
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
        ))
      }
    </div >
  );
}
