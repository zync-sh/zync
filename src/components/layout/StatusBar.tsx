import { CircleAlert, Wifi, WifiOff } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { cn } from '../../lib/utils';
import { StatusBarTransferIndicator } from '../file-manager/StatusBarTransferIndicator';

export function StatusBar() {
  const activeConnectionId = useAppStore(state => state.activeConnectionId);
  const connections = useAppStore(state => state.connections);
  const activeConnection = connections.find((c) => c.id === activeConnectionId);
  const editorDiagnosticsCount = useAppStore(state => state.editorDiagnosticsCount);
  const editorDiagnosticsSeverity = useAppStore(state => state.editorDiagnosticsSeverity);
  const editorDiagnosticsVisible = useAppStore(state => state.editorDiagnosticsVisible);
  const setEditorDiagnosticsVisible = useAppStore(state => state.setEditorDiagnosticsVisible);



  return (
    <div className="h-6 bg-app-panel border-t border-app-border flex items-center px-3 text-[10px] select-none text-app-text/80 justify-between shrink-0">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5 hover:text-white transition-colors cursor-pointer">
          {activeConnection ? (
            <>
              <Wifi size={10} className="text-app-success" />
              <span className="font-medium">Connected to {activeConnection.name}</span>
            </>
          ) : (
            <>
              <WifiOff size={10} className="text-app-muted" />
              <span className="text-app-muted">No Connection</span>
            </>
          )}
        </div>

        {/* Plugin Status Bar Slots (Temporarily disabled per UX request) */}
      </div>

      <div className="flex items-center gap-4">
        {/* High-performance container for Editor cursor status (no React re-renders) */}
        <span id="global-editor-status" className="text-app-muted font-mono text-[10px] tracking-wide" />
        {editorDiagnosticsCount > 0 && (
          <button
            type="button"
            onClick={() => setEditorDiagnosticsVisible(!editorDiagnosticsVisible)}
            className="inline-flex items-center gap-1 rounded-sm px-1 py-0.5 hover:bg-app-surface/60"
            title={`${editorDiagnosticsVisible ? 'Hide' : 'Show'} diagnostics (${editorDiagnosticsCount})`}
          >
            <CircleAlert
              size={12}
              className={cn(
                editorDiagnosticsSeverity === 'error' ? 'text-app-danger' : 'text-app-warning',
                editorDiagnosticsVisible && 'opacity-100',
                !editorDiagnosticsVisible && 'opacity-85',
              )}
            />
            <span className="font-mono text-[10px] text-app-muted">{editorDiagnosticsCount}</span>
          </button>
        )}
        
        <StatusBarTransferIndicator />
        {/* Active Action Feedback */}
        <StatusMessage />
        <span>Ready</span>
      </div>
    </div>
  );
}

function StatusMessage() {
  const lastAction = useAppStore(state => state.lastAction);

  if (!lastAction) return null;

  return (
    <span className={cn(
      "font-medium transition-all animate-in fade-in slide-in-from-bottom-1 duration-300",
      lastAction.type === 'success' ? "text-app-success" :
        lastAction.type === 'error' ? "text-app-danger" : "text-app-text"
    )}>
      {lastAction.message}
    </span>
  );
}
