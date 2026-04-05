import { Keyboard, X } from 'lucide-react';

import { Button } from '../ui/Button';
import { KeyboardKey } from '../ui/KeyboardKey.js';
import type { LightEditorCommand } from './commands.js';

interface LightEditorHeaderProps {
  filename: string;
  commands?: readonly LightEditorCommand[];
  onOpenShortcuts?: () => void;
  onClose: () => void;
}

export function LightEditorHeader({
  filename,
  commands = [],
  onOpenShortcuts,
  onClose,
}: LightEditorHeaderProps) {
  const saveShortcut = commands.find((command) => command.id === 'save')?.shortcut ?? 'Ctrl/Cmd+S';
  const gotoShortcut = commands.find((command) => command.id === 'goto')?.shortcut ?? 'Ctrl/Cmd+G';

  return (
    <div className="flex h-7 items-center justify-between gap-2 border-b border-app-border/30 bg-app-panel/72 px-2.5 backdrop-blur-sm">
      <div className="min-w-0 flex items-center gap-1 overflow-hidden">
        <h2 title={filename} className="truncate text-[11px] font-semibold text-app-text">{filename}</h2>
        <span className="mx-1 h-3 w-px shrink-0 bg-app-border/50" />
        <div className="flex items-center gap-1">
          <KeyboardKey>{saveShortcut}</KeyboardKey>
          <KeyboardKey>{gotoShortcut}</KeyboardKey>
        </div>
      </div>
      <div className="flex items-center gap-0.5">
        {onOpenShortcuts && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onOpenShortcuts}
            className="h-[22px] w-[22px] text-app-muted hover:text-app-text"
            title="Shortcuts"
          >
            <Keyboard size={11} />
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={onClose}
          size="icon"
          className="h-[22px] w-[22px] text-app-muted hover:text-app-text"
          title="Close editor"
        >
          <X size={11} />
        </Button>
      </div>
    </div>
  );
}
