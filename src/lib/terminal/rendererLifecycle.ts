import type { Terminal } from '@xterm/xterm';
import type { TerminalRendererState } from './types.js';
import { traceTerminalScreenMutation } from './terminalClearTrace.js';

let canvasAddonImport: Promise<typeof import('@xterm/addon-canvas')> | null = null;

function disposeAddonSafely(addon: { dispose: () => void } | undefined): void {
  if (!addon) {
    return;
  }

  try {
    addon.dispose();
  } catch (err) {
    console.warn('[terminal] addon dispose failed', err);
  }
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

  traceTerminalScreenMutation('dispose_webgl_addon', {
    source: 'disposeWebglAddonInternal',
    contextAlreadyLost: options?.contextAlreadyLost ?? false,
  }, term);

  state.webglAddon = undefined;
  state.kind = 'canvas';
  state.webglLigaturesStamp = undefined;

  if (options?.contextAlreadyLost) {
    return;
  }

  let disposeFailed = false;
  try {
    addon.dispose();
  } catch (err) {
    disposeFailed = true;
    console.warn('[terminal] addon dispose failed', err);
  }

  if (disposeFailed && term) {
    void activateCanvasRenderer(term, state);
  }
}

export function disposeCanvasAddonInternal(
  state: TerminalRendererState,
  term?: Terminal,
): void {
  const addon = state.canvasAddon;
  if (!addon) return;

  traceTerminalScreenMutation('dispose_canvas_addon', {
    source: 'disposeCanvasAddonInternal',
  }, term);

  state.canvasAddon = undefined;
  disposeAddonSafely(addon);
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

async function loadCanvasRenderer(term: Terminal, state: TerminalRendererState): Promise<void> {
  if (state.canvasAddon) return;

  if (!canvasAddonImport) {
    canvasAddonImport = import('@xterm/addon-canvas');
  }
  const { CanvasAddon } = await canvasAddonImport;
  const addon = new CanvasAddon();
  term.loadAddon(addon);
  state.canvasAddon = addon;
}

/**
 * Switches away from WebGL to an explicit canvas renderer and redraws the buffer.
 * Required after WebGL dispose — the default DOM renderer can leave the screen blank.
 */
export async function activateCanvasRenderer(
  term: Terminal,
  state: TerminalRendererState,
): Promise<void> {
  traceTerminalScreenMutation('activate_canvas_renderer', {
    source: 'activateCanvasRenderer',
    hadWebgl: Boolean(state.webglAddon),
  }, term);

  const hadWebgl = Boolean(state.webglAddon);
  disposeWebglAddonInternal(state, term);
  state.desiredKind = 'canvas';
  state.kind = 'canvas';

  if (hadWebgl) {
    disposeCanvasAddonInternal(state, term);
    try {
      await loadCanvasRenderer(term, state);
    } catch (error) {
      console.warn('[terminal] Canvas renderer unavailable after WebGL dispose', error);
    }
  }

  refreshTerminalScreen(term);
  if (typeof requestAnimationFrame !== 'undefined') {
    requestAnimationFrame(() => {
      refreshTerminalScreen(term);
    });
  }
}

export function ensureCanvasRenderer(state: TerminalRendererState, term?: Terminal): void {
  disposeWebglAddonInternal(state, term);
  state.desiredKind = 'canvas';
  state.kind = 'canvas';
}

export function disposeTerminalRenderer(
  state: TerminalRendererState | undefined,
  term?: Terminal,
): void {
  if (!state) return;
  if (state.loadPromise) {
    void state.loadPromise.finally(() => {
      disposeWebglAddonInternal(state, term);
      disposeCanvasAddonInternal(state, term);
    });
    state.loadPromise = null;
  } else {
    disposeWebglAddonInternal(state, term);
    disposeCanvasAddonInternal(state, term);
  }
}