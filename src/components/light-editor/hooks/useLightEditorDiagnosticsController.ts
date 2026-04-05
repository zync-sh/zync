import { useDeferredValue, useEffect, useMemo } from 'react';

import { useAppStore } from '../../../store/useAppStore.js';
import { createLineModel } from '../core/lineModel.js';
import { realLineToVisibleRow, type ProjectionModel } from '../core/projection.js';
import { useLightEditorDiagnostics } from '../diagnostics/useLightEditorDiagnostics.js';

interface UseLightEditorDiagnosticsControllerParams {
  content: string;
  languageId: string;
  projection: ProjectionModel;
  hasCollapsedFolds: boolean;
}

export function useLightEditorDiagnosticsController({
  content,
  languageId,
  projection,
  hasCollapsedFolds,
}: UseLightEditorDiagnosticsControllerParams) {
  const setEditorDiagnosticsSummary = useAppStore((state) => state.setEditorDiagnosticsSummary);
  const clearEditorDiagnosticsSummary = useAppStore((state) => state.clearEditorDiagnosticsSummary);

  const deferredContent = useDeferredValue(content);
  const analysisLineModel = useMemo(() => createLineModel(deferredContent), [deferredContent]);
  const diagnostics = useLightEditorDiagnostics(analysisLineModel, languageId);

  const displayDiagnostics = useMemo(
    () => (hasCollapsedFolds
      ? diagnostics.map((diagnostic) => ({
        ...diagnostic,
        line: (realLineToVisibleRow(projection, diagnostic.line) ?? (diagnostic.line - 1)) + 1,
      }))
      : diagnostics),
    [diagnostics, hasCollapsedFolds, projection],
  );

  const diagnosticsByLine = useMemo(() => {
    const next = new Map<number, typeof diagnostics>();
    for (const diagnostic of diagnostics) {
      const current = next.get(diagnostic.line);
      if (current) {
        current.push(diagnostic);
      } else {
        next.set(diagnostic.line, [diagnostic]);
      }
    }
    return next;
  }, [diagnostics]);

  const diagnosticsSeverity = useMemo<'warning' | 'error' | null>(() => {
    if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return 'error';
    if (diagnostics.length > 0) return 'warning';
    return null;
  }, [diagnostics]);

  useEffect(() => {
    setEditorDiagnosticsSummary(diagnostics.length, diagnosticsSeverity);
    return () => {
      clearEditorDiagnosticsSummary();
    };
  }, [clearEditorDiagnosticsSummary, diagnostics.length, diagnosticsSeverity, setEditorDiagnosticsSummary]);

  return {
    analysisLineModel,
    diagnostics,
    displayDiagnostics,
    diagnosticsByLine,
    diagnosticsSeverity,
  };
}
