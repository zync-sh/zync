import { useState, useEffect } from 'react';
import { Wifi, WifiOff } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { cn } from '../../lib/utils';
import { StatusBarTransferIndicator } from '../file-manager/StatusBarTransferIndicator';

export function StatusBar() {
  const activeConnectionId = useAppStore(state => state.activeConnectionId);
  const connections = useAppStore(state => state.connections);
  const activeConnection = connections.find((c) => c.id === activeConnectionId);

  // Plugin status bar slots: { [id]: text }
  const [pluginSlots, setPluginSlots] = useState<Record<string, string>>({});

  useEffect(() => {
    const handler = (e: any) => {
      const { id, text } = e.detail;
      setPluginSlots(prev => ({ ...prev, [id]: text }));
    };
    window.addEventListener('zync:statusbar:set', handler);
    return () => window.removeEventListener('zync:statusbar:set', handler);
  }, []);

  const pluginTexts = Object.values(pluginSlots).filter(Boolean);

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
        {/* Plugin Status Bar Slots */}
        {pluginTexts.map((text, i) => (
          <span key={i} className="text-app-muted font-mono">{text}</span>
        ))}
      </div>

      <div className="flex items-center gap-4">
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
