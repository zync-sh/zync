import { memo } from 'react';
import { Terminal } from 'lucide-react';
import { Button } from '../ui/Button';
import type { Connection } from '../../store/useAppStore';

export interface TerminalDisconnectedViewProps {
  connection: Connection | null | undefined;
  isPendingRestore: boolean;
  activeConnectionId: string;
  onReconnect: () => void;
}

export const TerminalDisconnectedView = memo(function TerminalDisconnectedView({
  connection,
  isPendingRestore,
  activeConnectionId,
  onReconnect,
}: TerminalDisconnectedViewProps) {
  const isConnecting = connection?.status === 'connecting';
  const hasError = connection?.status === 'error';

  return (
    <div key="disconnected" className="flex flex-col h-full items-center justify-center p-8 text-app-muted gap-4 bg-app-bg z-10 relative">
      {isConnecting ? (
        <>
          <div className="animate-spin rounded-full h-5 w-5 border-2 border-app-accent border-t-transparent" />
          <span>Connecting to terminal...</span>
        </>
      ) : (
        <div className="h-full flex flex-col items-center justify-center text-app-muted gap-4">
          <div className="h-12 w-12 rounded-full bg-app-surface border border-app-border flex items-center justify-center text-app-muted/50">
            <Terminal size={24} />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium text-app-text mb-1">
              {hasError ? 'Connection Error' : 'Disconnected'}
            </p>
            <p className="text-xs text-app-muted mb-4 opacity-70">
              {hasError
                ? 'Failed to establish connection. Please check credentials and try again.'
                : isPendingRestore
                  ? 'Terminal restored from last session. Reconnect to resume.'
                  : 'The connection to this terminal was closed.'}
            </p>
            <Button onClick={() => activeConnectionId && onReconnect()}>
              {hasError ? 'Retry Connection' : 'Reconnect'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
});