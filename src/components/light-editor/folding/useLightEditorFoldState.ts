import { useCallback, useState } from 'react';

import type { LightEditorFoldRange } from './types.js';

export function useLightEditorFoldState() {
  const [collapsedLines, setCollapsedLines] = useState<Set<number>>(new Set());

  const toggleFold = useCallback((startLine: number) => {
    setCollapsedLines((current) => {
      const next = new Set(current);
      if (next.has(startLine)) next.delete(startLine);
      else next.add(startLine);
      return next;
    });
  }, []);

  const expandAllFolds = useCallback(() => {
    setCollapsedLines(new Set());
  }, []);

  const collapseAllFolds = useCallback((foldRanges: LightEditorFoldRange[]) => {
    setCollapsedLines(new Set(foldRanges.map((range) => range.startLine)));
  }, []);

  const collapseFoldKind = useCallback((foldRanges: LightEditorFoldRange[], kind: string) => {
    setCollapsedLines((current) => {
      const next = new Set(current);
      for (const range of foldRanges) {
        if (range.kind === kind) next.add(range.startLine);
      }
      return next;
    });
  }, []);

  const expandFoldStarts = useCallback((startLines: number[]) => {
    if (startLines.length === 0) return;

    setCollapsedLines((current) => {
      let changed = false;
      const next = new Set(current);
      for (const startLine of startLines) {
        if (next.delete(startLine)) {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, []);

  const expandFoldsForLine = useCallback((foldRanges: LightEditorFoldRange[], line: number) => {
    const startLines = foldRanges
      .filter((range) => line >= range.startLine && line <= range.endLine)
      .map((range) => range.startLine);
    expandFoldStarts(startLines);
  }, [expandFoldStarts]);

  return {
    collapsedLines,
    toggleFold,
    expandAllFolds,
    collapseAllFolds,
    collapseFoldKind,
    expandFoldStarts,
    expandFoldsForLine,
  };
}
