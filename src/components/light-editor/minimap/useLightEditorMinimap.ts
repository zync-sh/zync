import { useMemo } from 'react';

import type { LineModel } from '../core/lineModel.js';
import { getLineText } from '../core/lineModel.js';
import type { LightEditorDiagnostic } from '../diagnostics/types.js';

interface SearchHighlightLike {
  key: string;
  top: number;
  active: boolean;
}

export interface LightEditorMinimapState {
  contentHeight: number;
  viewportTop: number;
  viewportHeight: number;
  linePreviews: Array<{ key: string; top: number; text: string; opacity: number }>;
  diagnosticMarkers: Array<{ key: string; top: number; severity: LightEditorDiagnostic['severity'] }>;
  searchMarkers: Array<{ key: string; top: number; active: boolean }>;
}

interface UseLightEditorMinimapParams {
  lineModel: LineModel;
  lineCount: number;
  viewportHeight: number;
  scrollTop: number;
  diagnostics: LightEditorDiagnostic[];
  searchHighlights: SearchHighlightLike[];
  minimapHeight: number;
}

export function getLightEditorMinimapState({
  lineModel,
  lineCount,
  viewportHeight,
  scrollTop,
  diagnostics,
  searchHighlights,
  minimapHeight,
}: UseLightEditorMinimapParams): LightEditorMinimapState {
  const safeLineCount = Math.max(1, lineCount);
  const previewLineHeight = 4;
  const contentHeight = Math.min(minimapHeight, safeLineCount * previewLineHeight);
  const lineRatio = contentHeight / safeLineCount;
  const contentPixelHeight = safeLineCount * 24;
  const maxPreviewLines = Math.max(1, Math.floor(contentHeight / previewLineHeight));
  const bucketSize = Math.max(1, Math.ceil(safeLineCount / maxPreviewLines));
  const viewportTop = contentPixelHeight <= 0 ? 0 : (scrollTop / contentPixelHeight) * contentHeight;
  const viewportBoxHeight = contentPixelHeight <= 0 ? contentHeight : Math.max(12, (viewportHeight / contentPixelHeight) * contentHeight);

  const linePreviews: LightEditorMinimapState['linePreviews'] = [];
  for (let sourceIndex = 0; sourceIndex < safeLineCount; sourceIndex += bucketSize) {
    const line = getLineText(lineModel, sourceIndex + 1);
    const trimmedLength = line.trim().length;
    const opacity = trimmedLength === 0 ? 0.08 : Math.min(0.75, 0.16 + trimmedLength / 120);
    linePreviews.push({
      key: `line-${sourceIndex}`,
      top: Math.max(0, sourceIndex * lineRatio),
      text: line.slice(0, 120),
      opacity,
    });
  }

  return {
    contentHeight,
    viewportTop,
    viewportHeight: Math.min(minimapHeight, viewportBoxHeight),
    linePreviews,
    diagnosticMarkers: diagnostics.map((diagnostic) => ({
      key: diagnostic.id,
      top: Math.max(0, (diagnostic.line - 1) * lineRatio),
      severity: diagnostic.severity,
    })),
    searchMarkers: searchHighlights.map((highlight) => ({
      key: highlight.key,
      top: Math.max(0, (highlight.top / Math.max(contentPixelHeight, 1)) * contentHeight),
      active: highlight.active,
    })),
  };
}

export function useLightEditorMinimap(params: UseLightEditorMinimapParams) {
  const {
    lineModel,
    lineCount,
    viewportHeight,
    scrollTop,
    diagnostics,
    searchHighlights,
    minimapHeight,
  } = params;

  return useMemo(() => getLightEditorMinimapState({
    lineModel,
    lineCount,
    viewportHeight,
    scrollTop,
    diagnostics,
    searchHighlights,
    minimapHeight,
  }), [diagnostics, lineCount, lineModel, minimapHeight, scrollTop, searchHighlights, viewportHeight]);
}
