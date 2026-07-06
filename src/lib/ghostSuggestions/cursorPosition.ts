/**
 * getCursorPixelPosition — converts xterm cursor cell coordinates to pixel
 * coordinates relative to the ghost overlay parent.
 *
 * Uses xterm's char-measure element (subpixel getBoundingClientRect) with a
 * viewport fallback so ghost overlays stay aligned under WebGL and DOM renderers.
 */

import type { Terminal } from '@xterm/xterm';

export interface CursorPixelPosition {
  left: number;
  top: number;
  cellWidth: number;
  cellHeight: number;
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

function getOverlayRoot(term: Terminal): HTMLElement | null {
  const container = term.element?.closest('.terminal-container');
  return container?.parentElement instanceof HTMLElement ? container.parentElement : null;
}

function rootRelativeCursorPosition(
  screen: HTMLElement,
  root: HTMLElement,
  cursorLeft: number,
  cursorTop: number,
  dims: TerminalCellDimensions,
): CursorPixelPosition {
  const screenRect = screen.getBoundingClientRect();
  const rootRect = root.getBoundingClientRect();
  return {
    left: screenRect.left - rootRect.left + cursorLeft,
    top: screenRect.top - rootRect.top + cursorTop,
    cellWidth: dims.width,
    cellHeight: dims.height,
  };
}

export function getCursorPixelPosition(term: Terminal): CursorPixelPosition {
  try {
    const dims = getTerminalCellDimensions(term);
    if (!dims) {
      return { left: 0, top: 0, cellWidth: 0, cellHeight: 0 };
    }

    const buf = term.buffer.active;
    const cursorLeft = buf.cursorX * dims.width;
    const cursorTop = buf.cursorY * dims.height;

    const screen = term.element?.querySelector('.xterm-screen');
    if (!(screen instanceof HTMLElement)) {
      return { left: 0, top: 0, cellWidth: dims.width, cellHeight: dims.height };
    }

    const overlayRoot = getOverlayRoot(term);
    if (overlayRoot) {
      return rootRelativeCursorPosition(screen, overlayRoot, cursorLeft, cursorTop, dims);
    }

    const container = term.element?.closest('.terminal-container');
    if (container?.parentElement instanceof HTMLElement) {
      return rootRelativeCursorPosition(
        screen,
        container.parentElement,
        cursorLeft,
        cursorTop,
        dims,
      );
    }

    if (term.element instanceof HTMLElement) {
      return rootRelativeCursorPosition(screen, term.element, cursorLeft, cursorTop, dims);
    }

    return { left: 0, top: 0, cellWidth: dims.width, cellHeight: dims.height };
  } catch {
    return { left: 0, top: 0, cellWidth: 0, cellHeight: 0 };
  }
}