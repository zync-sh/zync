import { useMemo, useRef } from 'react';

import { cn } from '../../lib/utils';
import type { LineModel } from './core/lineModel.js';
import { getLineText } from './core/lineModel.js';
import { getProjectionRows, type ProjectionModel } from './core/projection.js';
import {
  createHighlightCacheKey,
  getLineSlice,
  LIGHT_EDITOR_HIGHLIGHT_CACHE_LIMIT,
  LIGHT_EDITOR_LINE_HEIGHT,
  LIGHT_EDITOR_VERTICAL_PADDING,
  renderHighlightedHtml,
} from './highlight';
import type { LightEditorDiagnostic } from './diagnostics/types.js';
import { getActiveLineOverlay } from './layout';

interface SearchHighlight {
  key: string;
  top: number;
  left: number;
  width: number;
  active: boolean;
}

interface BracketHighlight {
  key: string;
  line: number;
  column: number;
}

interface OccurrenceHighlight {
  key: string;
  line: number;
  startColumn: number;
  endColumn: number;
}

interface LightSyntaxOverlayProps {
  highlightRef: React.RefObject<HTMLPreElement | null>;
  lineModel: LineModel;
  projection?: ProjectionModel | null;
  prismLanguage: string | null;
  searchHighlights: SearchHighlight[];
  diagnostics: LightEditorDiagnostic[];
  bracketHighlights: BracketHighlight[];
  occurrenceHighlights: OccurrenceHighlight[];
  charWidth: number;
  contentPaddingRight?: number;
  scrollTop: number;
  startLine: number;
  endLine: number;
  lineCount: number;
  cursorLine: number;
}

interface HighlightCache {
  entries: Map<string, string>;
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function LightSyntaxOverlay({
  highlightRef,
  lineModel,
  projection = null,
  prismLanguage,
  searchHighlights,
  diagnostics,
  bracketHighlights,
  occurrenceHighlights,
  charWidth,
  contentPaddingRight = 16,
  scrollTop,
  startLine,
  endLine,
  lineCount,
  cursorLine,
}: LightSyntaxOverlayProps) {
  const cacheRef = useRef<HighlightCache>({ entries: new Map() });

  const { html, topPadding, bottomPadding } = useMemo(() => {
    const visibleRows = projection
      ? getProjectionRows(projection, startLine, endLine)
      : null;
    const visibleContent = visibleRows
      ? visibleRows.map((row) => (row.kind === 'fold' ? row.label : getLineText(lineModel, row.realLine))).join('\n')
      : getLineSlice(lineModel, startLine, endLine).visibleContent;
    const cacheKey = createHighlightCacheKey(prismLanguage, startLine, endLine, visibleContent);

    let highlighted = cacheRef.current.entries.get(cacheKey);
    if (!highlighted) {
      highlighted = visibleRows
        ? visibleRows
          .map((row) => (row.kind === 'fold'
            ? `<span class="light-editor-fold-placeholder">${escapeHtml(row.label)}</span>`
            : renderHighlightedHtml(getLineText(lineModel, row.realLine), prismLanguage)))
          .join('\n')
        : renderHighlightedHtml(visibleContent, prismLanguage);
      cacheRef.current.entries.set(cacheKey, highlighted);
      if (cacheRef.current.entries.size > LIGHT_EDITOR_HIGHLIGHT_CACHE_LIMIT) {
        const oldestKey = cacheRef.current.entries.keys().next().value;
        if (oldestKey) {
          cacheRef.current.entries.delete(oldestKey);
        }
      }
    }

    return {
      html: highlighted,
      topPadding: LIGHT_EDITOR_VERTICAL_PADDING + startLine * LIGHT_EDITOR_LINE_HEIGHT,
      bottomPadding: LIGHT_EDITOR_VERTICAL_PADDING + Math.max(0, (lineCount - endLine) * LIGHT_EDITOR_LINE_HEIGHT),
    };
  }, [endLine, lineCount, lineModel, prismLanguage, projection, startLine]);

  const activeLine = getActiveLineOverlay(cursorLine, startLine, endLine, scrollTop);

  return (
    <>
      {activeLine.visible && (
        <div
          className="pointer-events-none absolute left-0 right-0 z-0 border-y"
          style={{
            top: activeLine.top,
            height: activeLine.height,
            borderColor: 'color-mix(in srgb, var(--editor-text, var(--color-app-text)) 5%, transparent)',
            background: 'var(--editor-active-line, color-mix(in srgb, var(--color-app-text) 3.5%, var(--color-app-bg)))',
          }}
        />
      )}
      {searchHighlights.map((highlight) => (
        <div
          key={highlight.key}
          className={cn('pointer-events-none absolute rounded-sm')}
          style={{
            top: highlight.top,
            left: highlight.left,
            width: highlight.width,
            height: LIGHT_EDITOR_LINE_HEIGHT,
            zIndex: 1,
            background: highlight.active
              ? 'var(--editor-search-match-active, color-mix(in srgb, var(--color-app-accent) 16%, transparent))'
              : 'var(--editor-search-match, color-mix(in srgb, var(--color-app-accent) 10%, transparent))',
            boxShadow: highlight.active
              ? 'inset 0 0 0 1px var(--editor-accent-soft, color-mix(in srgb, var(--color-app-accent) 14%, transparent))'
              : undefined,
          }}
        />
      ))}
      {diagnostics.map((diagnostic) => (
        <div
          key={diagnostic.id}
          className="pointer-events-none absolute right-4 z-[2] h-[2px]"
          style={{
            top: LIGHT_EDITOR_VERTICAL_PADDING + (diagnostic.line - 1) * LIGHT_EDITOR_LINE_HEIGHT + LIGHT_EDITOR_LINE_HEIGHT - 4 - scrollTop,
            left: 16 + (diagnostic.column - 1) * charWidth,
            width: 48,
            background: diagnostic.severity === 'error'
              ? 'var(--color-app-danger)'
              : 'var(--color-app-warning)',
          }}
        />
      ))}
      {bracketHighlights.map((highlight) => (
        <div
          key={highlight.key}
          className="pointer-events-none absolute rounded-sm"
          style={{
            top: LIGHT_EDITOR_VERTICAL_PADDING + (highlight.line - 1) * LIGHT_EDITOR_LINE_HEIGHT - scrollTop,
            left: 16 + (highlight.column - 1) * charWidth,
            width: Math.max(8, charWidth),
            height: LIGHT_EDITOR_LINE_HEIGHT,
            zIndex: 2,
            background: 'color-mix(in srgb, var(--editor-accent, var(--color-app-accent)) 14%, transparent)',
            boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--editor-accent, var(--color-app-accent)) 30%, transparent)',
          }}
        />
      ))}
      {occurrenceHighlights.map((highlight) => (
        <div
          key={highlight.key}
          className="pointer-events-none absolute rounded-sm"
          style={{
            top: LIGHT_EDITOR_VERTICAL_PADDING + (highlight.line - 1) * LIGHT_EDITOR_LINE_HEIGHT - scrollTop,
            left: 16 + (highlight.startColumn - 1) * charWidth,
            width: Math.max(charWidth, (highlight.endColumn - highlight.startColumn) * charWidth),
            height: LIGHT_EDITOR_LINE_HEIGHT,
            zIndex: 1,
            background: 'color-mix(in srgb, var(--editor-text, var(--color-app-text)) 7%, transparent)',
            boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--editor-text, var(--color-app-text)) 8%, transparent)',
          }}
        />
      ))}
      <pre
        ref={highlightRef}
        aria-hidden
        className="light-editor-highlight pointer-events-none absolute inset-0 m-0 overflow-hidden py-0 font-mono text-[13px] leading-6 text-app-text"
        style={{ tabSize: 2, whiteSpace: 'pre', zIndex: 0, margin: 0, paddingLeft: 16, paddingRight: contentPaddingRight }}
      >
        <div style={{ height: topPadding, pointerEvents: 'none' }} />
        <code
          dangerouslySetInnerHTML={{ __html: html + '\n' }}
          style={{
            display: 'block',
            margin: 0,
            whiteSpace: 'pre',
            color: 'var(--editor-text, var(--color-app-text))',
          }}
        />
        <div style={{ height: bottomPadding, pointerEvents: 'none' }} />
      </pre>
    </>
  );
}
