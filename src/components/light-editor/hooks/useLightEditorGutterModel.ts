import { useMemo } from 'react';

import type { LightEditorFoldRange } from '../folding/types.js';
import type { ProjectionModel, VisibleRow } from '../core/projection.js';

interface UseLightEditorGutterModelParams {
  lineCount: number;
  projection: ProjectionModel;
  foldByLine: Map<number, LightEditorFoldRange>;
  diagnosticsByLine: Map<number, Array<{ severity: 'warning' | 'error' }>>;
  visibleStartLine: number;
  visibleEndLine: number;
}

export function useLightEditorGutterModel({
  lineCount,
  projection,
  foldByLine,
  diagnosticsByLine,
  visibleStartLine,
  visibleEndLine,
}: UseLightEditorGutterModelParams) {
  const gutterDigitCount = Math.max(String(lineCount).length, 2);
  const gutterNumberColumnWidth = gutterDigitCount * 8 + 8;

  const gutterRows = useMemo(() => projection.rows
    .slice(visibleStartLine, visibleEndLine)
    .map((row) => {
      const lineNumber = row.realLine;
      return {
        row,
        lineNumber,
        diagnostic: diagnosticsByLine.get(lineNumber),
        isFoldable: row.kind === 'fold' || foldByLine.has(lineNumber),
      };
    }), [diagnosticsByLine, foldByLine, projection.rows, visibleEndLine, visibleStartLine]);

  return {
    gutterNumberColumnWidth,
    gutterRows,
  };
}

export type LightEditorGutterRow = {
  row: VisibleRow;
  lineNumber: number;
  diagnostic?: Array<{ severity: 'warning' | 'error' }>;
  isFoldable: boolean;
};
