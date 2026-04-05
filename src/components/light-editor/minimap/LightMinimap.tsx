import { useMemo } from 'react';

import type { LineModel } from '../core/lineModel.js';
import type { LightEditorDiagnostic } from '../diagnostics/types.js';
import { renderHighlightedHtml } from '../highlight.js';
import { useLightEditorMinimap } from './useLightEditorMinimap.js';

interface SearchHighlightLike {
  key: string;
  top: number;
  active: boolean;
}

interface LightMinimapProps {
  lineModel: LineModel;
  prismLanguage: string | null;
  lineCount: number;
  viewportHeight: number;
  scrollTop: number;
  diagnostics: LightEditorDiagnostic[];
  searchHighlights: SearchHighlightLike[];
  onJump: (ratio: number) => void;
}

const MINIMAP_HEIGHT = 280;
export const LIGHT_EDITOR_MINIMAP_WIDTH = 88;
const MINIMAP_SYNTAX_MAX_PREVIEWS = 120;
const MINIMAP_SYNTAX_MAX_CONTENT_CHARS = 50_000;

export function LightMinimap({
  lineModel,
  prismLanguage,
  lineCount,
  viewportHeight,
  scrollTop,
  diagnostics,
  searchHighlights,
  onJump,
}: LightMinimapProps) {
  const state = useLightEditorMinimap({
    lineModel,
    lineCount,
    viewportHeight,
    scrollTop,
    diagnostics,
    searchHighlights,
    minimapHeight: MINIMAP_HEIGHT,
  });

  const highlightedPreviews = useMemo(
    () => state.linePreviews.map((line) => ({
      ...line,
      html: state.linePreviews.length > MINIMAP_SYNTAX_MAX_PREVIEWS || lineModel.content.length > MINIMAP_SYNTAX_MAX_CONTENT_CHARS
        ? line.text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
        : renderHighlightedHtml(line.text, prismLanguage),
    })),
    [lineModel.content.length, prismLanguage, state.linePreviews],
  );

  return (
    <div className="pointer-events-none absolute inset-y-3 right-3 z-[12] hidden md:flex">
      <div
        className="pointer-events-auto relative overflow-hidden rounded-md border border-app-border/40 bg-app-bg/85 shadow-lg backdrop-blur-sm"
        style={{ height: MINIMAP_HEIGHT, width: LIGHT_EDITOR_MINIMAP_WIDTH }}
        onMouseDown={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
          onJump(ratio);
        }}
      >
        <div
          className="absolute inset-0 opacity-20"
          style={{ width: LIGHT_EDITOR_MINIMAP_WIDTH, background: 'linear-gradient(to bottom, transparent 0%, rgba(255,255,255,0.04) 100%)' }}
        />

        {highlightedPreviews
          .filter((line) => line.text.includes('...'))
          .map((line) => (
            <div
              key={`fold-${line.key}`}
              className="absolute left-1 right-1 rounded-sm border border-app-accent/15 bg-app-accent/8"
              style={{
                top: line.top - 0.5,
                height: 5,
                pointerEvents: 'none',
              }}
            />
          ))}

        <div
          className="editor-minimap light-editor-highlight absolute inset-0 overflow-hidden select-none px-1.5 py-1"
          aria-hidden
          style={{
            fontSize: 3,
            lineHeight: '4px',
            letterSpacing: '-0.1px',
            color: 'var(--editor-text, var(--color-app-text))',
            opacity: 0.82,
            fontWeight: 600,
            pointerEvents: 'none',
          }}
        >
          {highlightedPreviews.map((line) => (
            <div
              key={line.key}
              className="absolute left-1.5 right-1 overflow-hidden whitespace-nowrap"
              style={{
                top: line.top,
                height: 4,
                opacity: line.opacity,
              }}
              dangerouslySetInnerHTML={{ __html: line.html || '&nbsp;' }}
            />
          ))}
        </div>

        {state.diagnosticMarkers
          .filter((marker) => marker.severity === 'error')
          .map((marker) => (
          <div
            key={marker.key}
            className="absolute left-0 right-0 h-[2px]"
            style={{
              top: marker.top,
              background: marker.severity === 'error'
                ? 'var(--color-app-danger)'
                : 'var(--color-app-warning)',
            }}
          />
        ))}

        {state.searchMarkers.map((marker) => (
          <div
            key={marker.key}
            className="absolute right-0 w-1 rounded-sm shadow-sm"
            style={{
              top: marker.top,
              height: 6,
              background: marker.active
                ? 'var(--editor-accent, var(--color-app-accent))'
                : 'color-mix(in srgb, var(--editor-accent, var(--color-app-accent)) 45%, transparent)',
            }}
          />
        ))}

        <div
          className="absolute left-0 right-0 rounded-sm border border-app-accent/35 bg-app-accent/12 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.02)]"
          style={{
            top: state.viewportTop,
            height: state.viewportHeight,
          }}
        />
      </div>
    </div>
  );
}
