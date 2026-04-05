import { cn } from '../../lib/utils.js';
import {
  type LightEditorCompletionItem,
  type LightEditorDefinitionEntry,
  type LightEditorHoverEntry,
} from './contextEngine.js';
import { getCompletionPanelTopOffset } from './layout.js';

interface LightCompletionPanelProps {
  currentWord: string;
  completionItems: LightEditorCompletionItem[];
  selectedCompletionIndex: number;
  hoverInfo: LightEditorHoverEntry | null;
  definitionInfo: LightEditorDefinitionEntry | null;
  utilityMode: 'find' | 'goto' | null;
  showReplace: boolean;
  onSelectIndex: (index: number) => void;
  onApplyCompletion: (item: LightEditorCompletionItem) => void;
}

export function LightCompletionPanel({
  currentWord,
  completionItems,
  selectedCompletionIndex,
  hoverInfo,
  definitionInfo,
  utilityMode,
  showReplace,
  onSelectIndex,
  onApplyCompletion,
}: LightCompletionPanelProps) {
  if (completionItems.length === 0 && !hoverInfo && !definitionInfo) {
    return null;
  }

  return (
    <div
      className="editor-completion-widget absolute right-4 z-20 w-80 rounded-xl border border-app-border/50 bg-app-panel/97 p-3 shadow-xl backdrop-blur-sm"
      style={{ top: getCompletionPanelTopOffset(utilityMode, showReplace) }}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-widest text-app-muted/60">
          Context Engine
        </span>
        {currentWord && (
          <span className="rounded-full bg-app-surface/70 px-2 py-0.5 text-[10px] text-app-text">
            {currentWord}
          </span>
        )}
      </div>

      {hoverInfo?.contents?.[0]?.value && (
        <div className="mb-3 space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-app-muted/50">Hover</p>
          <p className="text-[11px] leading-relaxed text-app-text/80 whitespace-pre-wrap">
            {hoverInfo.contents[0].value}
          </p>
        </div>
      )}

      {definitionInfo && (
        <div className="mb-3 space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-app-muted/50">Definition</p>
          {definitionInfo.signature && (
            <code className="block rounded bg-app-surface/70 px-2 py-1 text-[11px] text-app-accent">
              {definitionInfo.signature}
            </code>
          )}
          {definitionInfo.description && (
            <p className="text-[11px] leading-relaxed text-app-text/80">
              {definitionInfo.description}
            </p>
          )}
        </div>
      )}

      {completionItems.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-app-muted/50">Suggestions</p>
          <div className="max-h-56 overflow-y-auto space-y-1">
            {completionItems.map((item, index) => (
              <button
                key={index}
                type="button"
                onMouseEnter={() => onSelectIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onApplyCompletion(item)}
                className={cn(
                  'w-full rounded-lg border border-l-2 px-2.5 py-1.5 text-left transition-colors',
                  selectedCompletionIndex === index
                    ? 'border-app-accent/40 bg-app-surface/80'
                    : 'border-transparent bg-app-surface/40 hover:border-app-accent/30 hover:bg-app-surface/70',
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-[11px] font-medium text-app-text">{item.label}</div>
                    {item.detail && (
                      <div className="truncate text-[10px] text-app-muted">{item.detail}</div>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
