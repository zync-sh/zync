import { Terminal as TerminalIcon } from 'lucide-react';
import { useState } from 'react';
import { TerminalComponent } from '../Terminal';

export function TerminalPanel({ connectionId, termId }: { connectionId?: string; termId?: string }) {
  const [] = useState(false);

  return (
    <div className="flex flex-col h-full w-full">
      <div className="flex items-center justify-between px-4 py-1.5 border-b border-gray-800 bg-gray-900/50 select-none">
        <div className="flex items-center gap-2 text-xs font-medium text-gray-400">
          <TerminalIcon className="h-3 w-3" />
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
