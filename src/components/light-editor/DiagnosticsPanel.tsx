import type { LightEditorDiagnostic } from './diagnostics/types.js';

interface DiagnosticsPanelProps {
  diagnostics: LightEditorDiagnostic[];
  visible: boolean;
  onJumpToDiagnostic: (diagnostic: LightEditorDiagnostic) => void;
}

export function DiagnosticsPanel({
  diagnostics,
  visible,
  onJumpToDiagnostic,
}: DiagnosticsPanelProps) {
  if (diagnostics.length === 0 || !visible) return null;

  const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
  const warningCount = diagnostics.length - errorCount;

  return (
    <div className="absolute bottom-3 right-3 z-20 w-[19rem] rounded-lg border border-app-border/50 bg-app-panel/95 p-2 shadow-xl backdrop-blur-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-widest text-app-muted/60">
          Diagnostics
        </span>
        <div className="flex items-center gap-1.5">
          {errorCount > 0 && (
            <span className="rounded-full bg-app-danger/15 px-1.5 py-0.5 text-[10px] font-medium text-app-danger">
              {errorCount} error{errorCount > 1 ? 's' : ''}
            </span>
          )}
          {warningCount > 0 && (
            <span className="rounded-full bg-app-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-app-warning">
              {warningCount} warning{warningCount > 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>
      <div className="max-h-36 space-y-1 overflow-y-auto">
        {diagnostics.map((diagnostic) => (
          <button
            key={diagnostic.id}
            type="button"
            onClick={() => onJumpToDiagnostic(diagnostic)}
            className="w-full rounded-md border border-app-border/40 bg-app-surface/30 px-2 py-1.5 text-left hover:border-app-accent/30 hover:bg-app-surface/50"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className="mt-[3px] inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                      background: diagnostic.severity === 'error'
                        ? 'var(--color-app-danger)'
                        : 'var(--color-app-warning)',
                    }}
                  />
                  <span className="truncate text-[11px] font-medium text-app-text">{diagnostic.message}</span>
                </div>
                <div className="mt-1 pl-[0.875rem] text-[10px] text-app-muted">
                  Ln {diagnostic.line}, Col {diagnostic.column}
                </div>
              </div>
              <span className="shrink-0 rounded bg-app-surface/70 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-app-muted">
                {diagnostic.severity}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
