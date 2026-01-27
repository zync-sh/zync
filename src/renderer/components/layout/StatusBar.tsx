import { Wifi, WifiOff } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore'; // Updated Import

export function StatusBar() {
  const activeConnectionId = useAppStore(state => state.activeConnectionId);
  const connections = useAppStore(state => state.connections);
  const activeConnection = connections.find((c) => c.id === activeConnectionId);

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
      </div>

      <div className="flex items-center gap-4">
        {/* Placeholders for file count / selection */}
        <span>Ready</span>
      </div>
    </div>
  );
}
