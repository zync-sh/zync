import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Terminal } from '@xterm/xterm';
import { getCursorPixelPosition } from '../../lib/ghostSuggestions/cursorPosition';

interface Props {
  term: Terminal;
  items: string[];
  selectedIndex: number;
  anchorLine?: string;
  maxVisible?: number;
}

export function GhostSuggestionListOverlay({
  term,
  items,
  selectedIndex,
  anchorLine = '',
  maxVisible = 8,
}: Props) {
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const [panelEl, setPanelEl] = useState<HTMLDivElement | null>(null);

  // Hook must run unconditionally — early return comes after all hooks.
  useLayoutEffect(() => {
    if (!items.length) return;
    let frameId = 0;

    const tick = () => {
      const cursor = getCursorPixelPosition(term);
      const terminalRect = term.element?.getBoundingClientRect();
      const fontPx = Number(term.options.fontSize ?? 14);
      const linePx = fontPx * Number(term.options.lineHeight ?? 1.2);
      const viewportPad = 8;

      if (terminalRect) {
        const anchorLeft = terminalRect.left + cursor.left;
        const anchorTop = terminalRect.top + cursor.top;
        const belowTop = anchorTop + linePx + 2;
        const panelHeight = panelEl?.getBoundingClientRect().height ?? 0;
        const aboveTop = Math.max(viewportPad, anchorTop - panelHeight - 4);
        const canRenderBelow =
          panelHeight === 0 || belowTop + panelHeight <= window.innerHeight - viewportPad;

        const newLeft = anchorLeft;
        const newTop = canRenderBelow ? belowTop : aboveTop;
        // Only update state when position actually changes to avoid needless re-renders.
        setPos((prev) =>
          prev.left === newLeft && prev.top === newTop ? prev : { left: newLeft, top: newTop },
        );
      }

      frameId = window.requestAnimationFrame(tick);
    };

    tick();
    return () => window.cancelAnimationFrame(frameId);
  }, [term, panelEl, items.length]);

  if (!items.length) return null;

  // xterm does not expose public cell width API in 5.x; this uses internal dimensions.
  const cellWidth = ((term as any)?._core?._renderService?.dimensions?.css?.cell?.width as number | undefined) ?? 0;
  const alignedLeft = Math.max(0, pos.left - (anchorLine.length * cellWidth));
  const clampedIndex = Math.max(0, Math.min(selectedIndex, items.length - 1));
  const start = Math.max(
    0,
    Math.min(clampedIndex - Math.floor(maxVisible / 2), items.length - maxVisible),
  );
  const visible = items.slice(start, start + maxVisible);
  const selectedVisibleIndex = clampedIndex - start;

  const fontFamily = term.options.fontFamily ?? 'monospace';
  const fontSize = `${term.options.fontSize ?? 14}px`;
  const lineHeight = String(term.options.lineHeight ?? 1.2);

  const panel = (
    <div
      ref={setPanelEl}
      aria-hidden="true"
      style={{
        position: 'fixed',
        left: alignedLeft,
        top: pos.top,
        pointerEvents: 'none',
        userSelect: 'none',
        fontFamily,
        fontSize,
        lineHeight,
        zIndex: 99990,
        minWidth: 220,
        maxWidth: 520,
        background: 'color-mix(in srgb, var(--color-app-bg) 94%, transparent)',
        border: '1px solid color-mix(in srgb, var(--color-app-border) 50%, transparent)',
        borderRadius: 'var(--radius, 8px)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
        overflow: 'hidden',
      }}
    >
      {visible.map((item, idx) => {
        const selected = idx === selectedVisibleIndex;
        return (
          <div
            key={`${start + idx}:${item}`}
            style={{
              padding: '2px 8px',
              whiteSpace: 'pre',
              color: selected
                ? 'var(--color-app-text)'
                : 'color-mix(in srgb, var(--color-app-text) 78%, transparent)',
              background: selected
                ? 'color-mix(in srgb, var(--color-app-accent) 35%, transparent)'
                : 'transparent',
            }}
          >
            {anchorLine}{item}
          </div>
        );
      })}
    </div>
  );

  return createPortal(panel, document.body);
}
