/**
 * getCursorPixelPosition — converts xterm cursor cell coordinates to pixel
 * coordinates relative to the terminal container.
 *
 * Uses xterm's char-measure element (subpixel getBoundingClientRect) with a
 * viewport fallback so ghost overlays stay aligned under WebGL and DOM renderers.
 */

import type { Terminal } from '@xterm/xterm';

export interface CursorPixelPosition {
  left: number;
  top: number;
}

export interface TerminalCellDimensions {
  width: number;
  height: number;
}

function measureCellFromDom(term: Terminal): TerminalCellDimensions | null {
  const measure = term.element?.querySelector('.xterm-char-measure-element');
  if (!measure || !(measure instanceof HTMLElement)) {
    return null;
  }

  const sampleLength = Math.max(1, measure.textContent?.length ?? 1);
  const rect = measure.getBoundingClientRect();
  const width = rect.width / sampleLength;
  const height = rect.height;
  if (width <= 0 || height <= 0) {
    return null;
  }

  return { width, height };
}

function estimateCellFromViewport(term: Terminal): TerminalCellDimensions | null {
  const cols = term.cols;
  const rows = term.rows;
  if (cols <= 0 || rows <= 0) {
    return null;
  }

  const screen = term.element?.querySelector('.xterm-screen');
  const screenRect = screen instanceof HTMLElement ? screen.getBoundingClientRect() : null;
  const hostRect = term.element?.getBoundingClientRect();
  const width = screenRect?.width ?? hostRect?.width ?? 0;
  const height = screenRect?.height ?? hostRect?.height ?? 0;
  if (width <= 0 || height <= 0) {
    return null;
  }

  return {
    width: width / cols,
    height: height / rows,
  };
}

export function getTerminalCellDimensions(term: Terminal): TerminalCellDimensions | null {
  return measureCellFromDom(term) ?? estimateCellFromViewport(term);
}

export function getCursorPixelPosition(term: Terminal): CursorPixelPosition {
  try {
    const dims = getTerminalCellDimensions(term);
    if (!dims) {
      return { left: 0, top: 0 };
    }

    const buf = term.buffer.active;
    return {
      left: buf.cursorX * dims.width,
      top: buf.cursorY * dims.height,
    };
  } catch {
    return { left: 0, top: 0 };
  }
}