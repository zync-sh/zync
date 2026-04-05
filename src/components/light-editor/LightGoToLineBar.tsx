import { Hash, X } from 'lucide-react';

import { Button } from '../ui/Button.js';

interface LightGoToLineBarProps {
  targetLine: string;
  lineCount: number;
  onTargetLineChange: (value: string) => void;
  onGo: () => void;
  onClose: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

export function LightGoToLineBar({
  targetLine,
  lineCount,
  onTargetLineChange,
  onGo,
  onClose,
  onKeyDown,
  inputRef,
}: LightGoToLineBarProps) {
  return (
    <div className="light-editor-widget min-w-[20rem]">
      <div className="light-editor-widget-row">
        <Hash size={14} className="text-app-muted" />
        <span className="light-editor-widget-label">Go to line</span>
        <input
          ref={inputRef}
          value={targetLine}
          onChange={(event) => onTargetLineChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`1-${lineCount}`}
          className="light-editor-widget-input max-w-[7rem] flex-none"
        />
        <Button size="sm" variant="secondary" onClick={onGo} className="text-[11px]">
          Go
        </Button>
        <button
          type="button"
          onClick={onClose}
          className="light-editor-widget-icon-button ml-auto"
          aria-label="Close go to line"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
