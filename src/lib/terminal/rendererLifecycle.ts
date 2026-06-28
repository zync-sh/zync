import type { Terminal } from '@xterm/xterm';
import type { TerminalRendererState } from './types.js';

function isWebglDisposeBenignError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('_isDisposed')
    || message.includes("Cannot read properties of undefined (reading '_isDisposed')");
}

export interface DisposeWebglAddonOptions {
  /** GL context already gone — skip addon.dispose() to avoid _isDisposed throws. */
  contextAlreadyLost?: boolean;
}

export function disposeWebglAddonInternal(
  state: TerminalRendererState,
  term?: Terminal,
  options?: DisposeWebglAddonOptions,
): void {
  const addon = state.webglAddon;
  if (!addon) return;

  state.webglAddon = undefined;
  state.kind = 'dom';
  state.webglLigaturesStamp = undefined;

  if (options?.contextAlreadyLost) {
    return;
  }

  let disposeFailed = false;
  try {
    addon.dispose();
  } catch (err) {
    if (isWebglDisposeBenignError(err)) {
      return;
    }
    disposeFailed = true;
    console.warn('[terminal] addon dispose failed', err);
  }

  if (disposeFailed && term) {
    void activateDomRenderer(term, state);
  }
}

export function refreshTerminalScreen(term: Terminal): void {
  try {
    const bufferLength = term.buffer?.active?.length ?? 0;
    const lastRow = Math.max(0, Math.max(term.rows - 1, bufferLength - 1));
    term.refresh(0, lastRow);
  } catch {
    // Ignore refresh failures during renderer transitions.
  }
}

/**
 * Switches away from WebGL to xterm's built-in DOM renderer and redraws the buffer.
 */
export async function activateDomRenderer(
  term: Terminal,
  state: TerminalRendererState,
): Promise<void> {
  disposeWebglAddonInternal(state, term);
  state.kind = 'dom';

  refreshTerminalScreen(term);
  if (typeof requestAnimationFrame !== 'undefined') {
    requestAnimationFrame(() => {
      refreshTerminalScreen(term);
    });
  }
}

export function ensureDomRenderer(state: TerminalRendererState, term?: Terminal): void {
  disposeWebglAddonInternal(state, term);
  state.kind = 'dom';
}

/** @deprecated Use activateDomRenderer */
export const activateCanvasRenderer = activateDomRenderer;

/** @deprecated Use ensureDomRenderer */
export const ensureCanvasRenderer = ensureDomRenderer;

export function disposeTerminalRenderer(
  state: TerminalRendererState | undefined,
  term?: Terminal,
): void {
  if (!state) return;
  if (state.loadPromise) {
    void state.loadPromise.finally(() => {
      disposeWebglAddonInternal(state, term);
    });
    state.loadPromise = null;
  } else {
    disposeWebglAddonInternal(state, term);
  }
}