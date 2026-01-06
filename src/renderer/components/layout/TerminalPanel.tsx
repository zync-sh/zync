import { Terminal as TerminalIcon } from 'lucide-react';

import { TerminalComponent } from '../Terminal';
import { useSettings } from '../../context/SettingsContext';
import { cn } from '../../lib/utils';

export function TerminalPanel({ connectionId, termId }: { connectionId?: string; termId?: string }) {
  const { settings } = useSettings();
  const compactMode = settings.compactMode;

  return (
    <div className="flex flex-col h-full w-full">
      <div className={cn(
        "flex items-center justify-between border-b border-gray-800 bg-gray-900/50 select-none transition-all",
        compactMode ? "px-2 py-0.5 min-h-[24px]" : "px-4 py-1.5"
      )}>
        <div className={cn(
          "flex items-center gap-2 font-medium text-gray-400 transition-all",
          compactMode ? "text-[10px]" : "text-xs"
        )}>
          <TerminalIcon className={cn("transition-all", compactMode ? "h-3 w-3" : "h-3.5 w-3.5")} />
          <span>TERMINAL</span>
        </div>
        <div className="flex gap-1">{/* Actions */}</div>
      </div>
      <div className="flex-1 overflow-hidden relative bg-app-bg">
        <TerminalComponent connectionId={connectionId} termId={termId} />
      </div>
    </div>
  );
}
