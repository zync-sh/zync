/**
 * getCursorPixelPosition — converts xterm cursor cell coordinates to pixel
 * coordinates relative to the terminal container.
 *
 * Uses the private `_renderService.dimensions` API guarded by try/catch.
 * Falls back to { left: 0, top: 0 } if the API is unavailable (e.g. after an
 * xterm major version bump that renames internal APIs).
 */

import type { Terminal } from '@xterm/xterm';

export interface CursorPixelPosition {
  left: number;
  top: number;
}

export function getCursorPixelPosition(term: Terminal): CursorPixelPosition {
  try {
    const core = (term as any)._core;
    const dims = core?._renderService?.dimensions;

    // xterm.js 5.x exposes cell size under dimensions.css.cell.{width,height}
    const cellW: number | undefined = dims?.css?.cell?.width;
    const cellH: number | undefined = dims?.css?.cell?.height;

    if (!cellW || !cellH) {
      return { left: 0, top: 0 };
    }

    const buf = term.buffer.active;
    // cursorX/cursorY are viewport-relative cell coordinates in xterm.
    // Multiplying by css cell dimensions maps cells to pixels in the terminal container.
    return {
      left: buf.cursorX * cellW,
      top:  buf.cursorY * cellH,
    };
  } catch {
    return { left: 0, top: 0 };
  }
}
