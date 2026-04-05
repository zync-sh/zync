import { useMemo } from 'react';

import { createLineModel } from '../core/lineModel.js';
import { useLightEditorFoldState } from '../folding/useLightEditorFoldState.js';
import { useLightEditorFolding } from '../folding/useLightEditorFolding.js';

export function useLightEditorFoldingController(content: string, languageId: string) {
  const lineModel = useMemo(() => createLineModel(content), [content]);
  const foldRanges = useLightEditorFolding(lineModel, languageId);
  const foldState = useLightEditorFoldState();

  const foldByLine = useMemo(
    () => new Map(foldRanges.map((range) => [range.startLine, range])),
    [foldRanges],
  );

  return {
    lineModel,
    foldRanges,
    foldByLine,
    ...foldState,
  };
}
