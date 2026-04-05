import { useCallback, useEffect } from 'react';

import type { LineModel } from '../core/lineModel.js';
import { getLineStartOffset, getOffsetPosition } from '../core/lineModel.js';
import { realLineToVisibleRow, type ProjectionModel } from '../core/projection.js';
import type { LightEditorDiagnostic } from '../diagnostics/types.js';
import type { LightEditorFoldRange } from '../folding/types.js';
import { LIGHT_EDITOR_LINE_HEIGHT, LIGHT_EDITOR_VERTICAL_PADDING } from '../highlight.js';
import { findMatches, type SearchOptions } from '../search.js';

interface UseLightEditorNavigationParams {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  lineModel: LineModel;
  displayLineModel: LineModel;
  lineCount: number;
  projection: ProjectionModel;
  hasCollapsedFolds: boolean;
  foldRanges: LightEditorFoldRange[];
  collapsedLines: Set<number>;
  expandFoldsForLine: (foldRanges: LightEditorFoldRange[], line: number) => void;
  syncCursorState: (value: string, model: LineModel, offset: number) => void;
  targetLine: string;
  closeUtility: () => void;
  resetGoToLine: () => void;
  content: string;
  searchFindText: string;
  searchOptions: SearchOptions;
  utilityMode: 'find' | 'goto' | null;
}

function isInsideCollapsedFold(
  foldRanges: LightEditorFoldRange[],
  collapsedLines: Set<number>,
  line: number,
) {
  return foldRanges.some(
    (range) => collapsedLines.has(range.startLine) && line >= range.startLine && line <= range.endLine,
  );
}

export function useLightEditorNavigation({
  textareaRef,
  lineModel,
  displayLineModel,
  lineCount,
  projection,
  hasCollapsedFolds,
  foldRanges,
  collapsedLines,
  expandFoldsForLine,
  syncCursorState,
  targetLine,
  closeUtility,
  resetGoToLine,
  content,
  searchFindText,
  searchOptions,
  utilityMode,
}: UseLightEditorNavigationParams) {
  const jumpToLine = useCallback((targetLineNumber: number, column = 1) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const visualLine = hasCollapsedFolds
      ? (realLineToVisibleRow(projection, targetLineNumber) ?? targetLineNumber - 1) + 1
      : targetLineNumber;
    const offset = getLineStartOffset(
      hasCollapsedFolds ? displayLineModel : lineModel,
      visualLine,
    ) + Math.max(0, column - 1);

    textarea.focus();
    textarea.setSelectionRange(offset, offset);
    textarea.scrollTop = Math.max(
      0,
      LIGHT_EDITOR_VERTICAL_PADDING + (visualLine - 1) * LIGHT_EDITOR_LINE_HEIGHT - LIGHT_EDITOR_LINE_HEIGHT * 2,
    );
    syncCursorState(textarea.value, hasCollapsedFolds ? displayLineModel : lineModel, offset);
  }, [displayLineModel, hasCollapsedFolds, lineModel, projection, syncCursorState, textareaRef]);

  const jumpToExpandedLine = useCallback((targetLineNumber: number, column = 1) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const offset = getLineStartOffset(lineModel, targetLineNumber) + Math.max(0, column - 1);
    textarea.focus();
    textarea.setSelectionRange(offset, offset);
    textarea.scrollTop = Math.max(
      0,
      LIGHT_EDITOR_VERTICAL_PADDING + (targetLineNumber - 1) * LIGHT_EDITOR_LINE_HEIGHT - LIGHT_EDITOR_LINE_HEIGHT * 2,
    );
    syncCursorState(textarea.value, lineModel, offset);
  }, [lineModel, syncCursorState, textareaRef]);

  const handleGoToLine = useCallback(() => {
    const requested = Number.parseInt(targetLine, 10);
    if (!Number.isFinite(requested)) return;

    const safeLine = Math.max(1, Math.min(requested, lineCount));

    if (isInsideCollapsedFold(foldRanges, collapsedLines, safeLine)) {
      expandFoldsForLine(foldRanges, safeLine);
      requestAnimationFrame(() => jumpToExpandedLine(safeLine));
    } else {
      jumpToLine(safeLine);
    }

    closeUtility();
    resetGoToLine();
  }, [
    closeUtility,
    collapsedLines,
    expandFoldsForLine,
    foldRanges,
    jumpToExpandedLine,
    jumpToLine,
    lineCount,
    resetGoToLine,
    targetLine,
  ]);

  const handleJumpToDiagnostic = useCallback((diagnostic: LightEditorDiagnostic) => {
    if (isInsideCollapsedFold(foldRanges, collapsedLines, diagnostic.line)) {
      expandFoldsForLine(foldRanges, diagnostic.line);
      requestAnimationFrame(() => jumpToExpandedLine(diagnostic.line, diagnostic.column));
      return;
    }

    jumpToLine(diagnostic.line, diagnostic.column);
  }, [collapsedLines, expandFoldsForLine, foldRanges, jumpToExpandedLine, jumpToLine]);

  useEffect(() => {
    if (!hasCollapsedFolds || utilityMode !== 'find' || !searchFindText.trim()) {
      return;
    }

    const matches = findMatches(content, searchFindText, searchOptions);
    const foldedMatchLines = new Set<number>();

    for (const match of matches) {
      const line = getOffsetPosition(lineModel, match.start).line;
      if (isInsideCollapsedFold(foldRanges, collapsedLines, line)) {
        foldedMatchLines.add(line);
      }
    }

    for (const line of foldedMatchLines) {
      expandFoldsForLine(foldRanges, line);
    }
  }, [
    collapsedLines,
    content,
    expandFoldsForLine,
    foldRanges,
    hasCollapsedFolds,
    lineModel,
    searchFindText,
    searchOptions,
    utilityMode,
  ]);

  return {
    jumpToLine,
    jumpToExpandedLine,
    handleGoToLine,
    handleJumpToDiagnostic,
  };
}
