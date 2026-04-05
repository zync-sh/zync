import { ArrowDown, ArrowUp, Replace, Search, X } from 'lucide-react';

import { Button } from '../ui/Button.js';

interface LightFindReplaceBarProps {
  findText: string;
  replaceText: string;
  showReplace: boolean;
  matchLabel: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  onFindTextChange: (value: string) => void;
  onReplaceTextChange: (value: string) => void;
  onToggleCaseSensitive: () => void;
  onToggleWholeWord: () => void;
  onToggleRegex: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onToggleReplace: () => void;
  onReplaceOne: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
  onFindKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onReplaceKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  findInputRef: React.RefObject<HTMLInputElement | null>;
  replaceInputRef: React.RefObject<HTMLInputElement | null>;
}

export function LightFindReplaceBar({
  findText,
  replaceText,
  showReplace,
  matchLabel,
  caseSensitive,
  wholeWord,
  useRegex,
  onFindTextChange,
  onReplaceTextChange,
  onToggleCaseSensitive,
  onToggleWholeWord,
  onToggleRegex,
  onPrevious,
  onNext,
  onToggleReplace,
  onReplaceOne,
  onReplaceAll,
  onClose,
  onFindKeyDown,
  onReplaceKeyDown,
  findInputRef,
  replaceInputRef,
}: LightFindReplaceBarProps) {
  return (
    <div className="light-editor-widget">
      <div className="flex flex-col">
        <div className="light-editor-widget-row">
          <Search size={14} className="text-app-muted" />
          <input
            ref={findInputRef}
            value={findText}
            onChange={(event) => onFindTextChange(event.target.value)}
            onKeyDown={onFindKeyDown}
            placeholder="Find"
            className="light-editor-widget-input max-w-[12rem]"
          />
          <span className="light-editor-widget-pill">{matchLabel}</span>
          <button type="button" onClick={onPrevious} className="light-editor-widget-icon-button" aria-label="Previous match">
            <ArrowUp size={14} />
          </button>
          <button type="button" onClick={onNext} className="light-editor-widget-icon-button" aria-label="Next match">
            <ArrowDown size={14} />
          </button>
          <button
            type="button"
            onClick={onToggleCaseSensitive}
            className="light-editor-widget-icon-button light-editor-widget-toggle text-[11px] font-semibold"
            data-active={caseSensitive}
            aria-label="Match case"
            aria-pressed={caseSensitive}
            title="Match case"
          >
            Aa
          </button>
          <button
            type="button"
            onClick={onToggleWholeWord}
            className="light-editor-widget-icon-button light-editor-widget-toggle text-[11px] font-semibold"
            data-active={wholeWord}
            aria-label="Match whole word"
            aria-pressed={wholeWord}
            title="Match whole word"
          >
            ab
          </button>
          <button
            type="button"
            onClick={onToggleRegex}
            className="light-editor-widget-icon-button light-editor-widget-toggle text-[11px] font-semibold"
            data-active={useRegex}
            aria-label="Use regular expression"
            aria-pressed={useRegex}
            title="Use regular expression"
          >
            .*
          </button>
          <button
            type="button"
            onClick={onToggleReplace}
            className="light-editor-widget-icon-button"
            data-active={showReplace}
            aria-label="Toggle replace"
          >
            <Replace size={14} />
          </button>
          <button type="button" onClick={onClose} className="light-editor-widget-icon-button ml-auto" aria-label="Close find/replace">
            <X size={14} />
          </button>
        </div>

        {showReplace && (
          <div className="light-editor-widget-row">
            <span className="light-editor-widget-label w-4 shrink-0" aria-hidden />
            <input
              ref={replaceInputRef}
              value={replaceText}
              onChange={(event) => onReplaceTextChange(event.target.value)}
              onKeyDown={onReplaceKeyDown}
              placeholder="Replace"
              className="light-editor-widget-input"
            />
            <Button size="sm" variant="secondary" onClick={onReplaceOne} className="text-[11px]">
              Replace
            </Button>
            <Button size="sm" variant="secondary" onClick={onReplaceAll} className="text-[11px]">
              All
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
