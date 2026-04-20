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
 * Positioned absolutely inside the terminal container div (which already has
 * `position: relative` via the `terminal-container` class). Font values are
 * read from the public `term.options` API so they always match the live xterm
 * settings without relying on CSS variables that don't exist for the terminal.
 */
export function GhostSuggestionOverlay({ term, suggestion }: Props) {
  const [pos, setPos] = useState({ left: 0, top: 0 });

  useEffect(() => {
    if (!suggestion) return;

    let frameId = 0;
    let prevLeft = 0;
    let prevTop = 0;
    let stableFrames = 0;
    const STOP_AFTER = 5; // stop the burst after 5 consecutive unchanged frames

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

    // Restart a short RAF burst on any terminal input or resize event so the
    // overlay tracks cursor movement without looping forever while idle.
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
  const fontSize   = `${term.options.fontSize   ?? 14}px`;
  const lineHeight = term.options.lineHeight ?? 1.2;

  return (
    <div
      aria-hidden="true"
      style={{
        position:    'absolute',
        left:        pos.left,
        top:         pos.top,
        pointerEvents: 'none',
        userSelect:  'none',
        fontFamily,
        fontSize,
        lineHeight,
        color:       'color-mix(in srgb, var(--color-app-muted, #94a3b8) 60%, transparent)',
        whiteSpace:  'pre',
        zIndex:      10,
      }}
    >
      {suggestion}
    </div>
  );
}
