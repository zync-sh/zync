import { useEffect, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import { getCursorPixelPosition } from '../../lib/ghostSuggestions/cursorPosition';

interface Props {
  term: Terminal;
  suggestion: string; // suffix only — caller passes '' to hide
}

/**
 * Renders a faded ghost-text completion at the xterm cursor position.
 *
 * Positioned absolutely inside the overlay parent (sibling of `.terminal-container`).
 * Cell height from xterm measurement keeps the suffix on the same row as the cursor.
 */
export function GhostSuggestionOverlay({ term, suggestion }: Props) {
  const [pos, setPos] = useState({
    left: 0,
    top: 0,
    cellHeight: 0,
    cellWidth: 0,
  });

  useEffect(() => {
    if (!suggestion) return;

    let frameId = 0;
    let prevLeft = 0;
    let prevTop = 0;
    let stableFrames = 0;
    const STOP_AFTER = 5;

    const tick = () => {
      const next = getCursorPixelPosition(term);
      if (next.left !== prevLeft || next.top !== prevTop) {
        prevLeft = next.left;
        prevTop = next.top;
        stableFrames = 0;
        setPos(next);
      } else {
        stableFrames++;
      }
      if (stableFrames < STOP_AFTER) {
        frameId = window.requestAnimationFrame(tick);
      }
    };

    const startBurst = () => {
      stableFrames = 0;
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(tick);
    };

    startBurst();
    const dataDisposable = term.onData(startBurst);
    const resizeDisposable = term.onResize(startBurst);

    return () => {
      window.cancelAnimationFrame(frameId);
      dataDisposable.dispose();
      resizeDisposable.dispose();
    };
  }, [term, suggestion]);

  if (!suggestion) return null;

  const fontFamily = term.options.fontFamily ?? 'monospace';
  const fontSize = Number(term.options.fontSize ?? 14);
  const fontWeight = term.options.fontWeight ?? 'normal';
  const cellHeight = pos.cellHeight > 0
    ? pos.cellHeight
    : fontSize * Number(term.options.lineHeight ?? 1.2);

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        left: pos.left,
        top: pos.top,
        height: cellHeight,
        lineHeight: `${cellHeight}px`,
        pointerEvents: 'none',
        userSelect: 'none',
        fontFamily,
        fontSize: `${fontSize}px`,
        fontWeight,
        color: 'color-mix(in srgb, var(--color-app-muted, #94a3b8) 60%, transparent)',
        whiteSpace: 'pre',
        zIndex: 10,
      }}
    >
      {suggestion}
    </div>
  );
}