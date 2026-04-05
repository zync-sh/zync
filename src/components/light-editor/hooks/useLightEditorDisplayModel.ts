import { useMemo } from 'react';

import type { LightEditorFoldRange } from '../folding/types.js';
import type { LineModel } from '../core/lineModel.js';
import { createLineModel } from '../core/lineModel.js';
import { projectionToText, visibleRowToRealLine } from '../core/projection.js';
import { useLightEditorProjection } from '../folding/useLightEditorProjection.js';

interface UseLightEditorDisplayModelParams {
  content: string;
  lineModel: LineModel;
  foldRanges: LightEditorFoldRange[];
  collapsedLines: Set<number>;
  cursorLine: number;
}

export function useLightEditorDisplayModel({
  content,
  lineModel,
  foldRanges,
  collapsedLines,
  cursorLine,
}: UseLightEditorDisplayModelParams) {
  const lineCount = lineModel.lineCount;
  const projection = useLightEditorProjection(lineModel, foldRanges, collapsedLines);
  const hasCollapsedFolds = collapsedLines.size > 0;

  const displayContent = useMemo(
    () => (hasCollapsedFolds ? projectionToText(projection, lineModel) : content),
    [content, hasCollapsedFolds, lineModel, projection],
  );

  const displayLineModel = useMemo(() => createLineModel(displayContent), [displayContent]);
  const displayLineCount = displayLineModel.lineCount;

  const currentRealLine = useMemo(
    () => (hasCollapsedFolds
      ? (visibleRowToRealLine(projection, Math.max(0, cursorLine - 1)) ?? cursorLine)
      : cursorLine),
    [cursorLine, hasCollapsedFolds, projection],
  );

  return {
    lineModel,
    lineCount,
    projection,
    hasCollapsedFolds,
    displayContent,
    displayLineModel,
    displayLineCount,
    currentRealLine,
  };
}
