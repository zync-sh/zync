import type { Terminal } from '@xterm/xterm';
import {
  activateCanvasRenderer,
  disposeCanvasAddonInternal,
  disposeWebglAddonInternal,
} from './rendererLifecycle.js';
import { isTerminalDomMeasurable } from './terminalFit.js';
import {
  resolveDesiredTerminalRenderer,
  type TerminalRendererPreferences,
} from './rendererPolicy.js';
import { getTerminalRendererState } from './rendererSession.js';
import type { TerminalRendererKind, TerminalRendererState } from './types.js';
import { isWebgl2Available } from './webglCapability.js';

let webglAddonImport: Promise<typeof import('@xterm/addon-webgl')> | null = null;

function notifyTerminalRendererChanged(sessionId: string): void {
  if (typeof window === 'undefined') return;
  const state = getTerminalRendererState(sessionId);
  window.dispatchEvent(new CustomEvent('zync:terminal-renderer-changed', {
    detail: { sessionId, kind: state.kind, desiredKind: state.desiredKind },
  }));
}

export interface SyncTerminalRendererOptions extends TerminalRendererPreferences {
  onRefit?: () => void;
}

async function loadWebglRenderer(
  sessionId: string,
  term: Terminal,
  state: TerminalRendererState,
  onRefit?: () => void,
): Promise<TerminalRendererKind> {
  if (state.webglAddon) {
    state.kind = 'webgl';
    return 'webgl';
  }

  if (!isWebgl2Available()) {
    state.initFailureCount += 1;
    state.lastError = 'webgl2_unavailable';
    state.kind = 'canvas';
    return 'canvas';
  }

  try {
    if (!webglAddonImport) {
      webglAddonImport = import('@xterm/addon-webgl');
    }
    const { WebglAddon } = await webglAddonImport;
    const addon = new WebglAddon();

    addon.onContextLoss(() => {
      console.warn('[terminal] WebGL context lost — falling back to canvas for this session');
      state.contextLossCount += 1;
      state.webglContextLossBlocked = true;
      state.lastError = 'webgl_context_lost';
      state.kind = 'canvas';
      disposeWebglAddonInternal(state, term, { contextAlreadyLost: true });

      // Panel hidden (Files/Dashboard) uses display:none — canvas recovery here can
      // wipe scrollback. Defer until the terminal host has measurable layout.
      if (!isTerminalDomMeasurable(term)) {
        notifyTerminalRendererChanged(sessionId);
        return;
      }

      void (async () => {
        await activateCanvasRenderer(term, state);
        onRefit?.();
        notifyTerminalRendererChanged(sessionId);
      })();
    });

    term.loadAddon(addon);
    state.webglAddon = addon;
    state.kind = 'webgl';
    state.lastError = undefined;
    return 'webgl';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[terminal] WebGL renderer unavailable, using canvas', error);
    state.initFailureCount += 1;
    state.lastError = message;
    state.kind = 'canvas';
    return 'canvas';
  }
}

/**
 * Applies the renderer implied by user settings and session constraints.
 * Idempotent: no-op when the active renderer already matches the target.
 */
export async function syncTerminalRenderer(
  sessionId: string,
  term: Terminal,
  options: SyncTerminalRendererOptions,
): Promise<TerminalRendererKind> {
  const rendererState = getTerminalRendererState(sessionId);
  const desired = resolveDesiredTerminalRenderer({
    gpuAcceleration: options.gpuAcceleration,
    webglContextLossBlocked: rendererState.webglContextLossBlocked,
  });

  rendererState.desiredKind = desired;

  if (desired === 'canvas') {
    if (rendererState.kind === 'canvas' && !rendererState.webglAddon) {
      notifyTerminalRendererChanged(sessionId);
      return 'canvas';
    }

    if (rendererState.loadPromise) {
      // Do not return stale loadPromise if desiredKind changed while the previous transition was in-flight.
      if (rendererState.kind === rendererState.desiredKind) {
        return rendererState.loadPromise;
      }
      // fall through to start transition for the new desiredKind
    }

    const transitionPromise: Promise<TerminalRendererKind> = (async (): Promise<TerminalRendererKind> => {
      try {
        await activateCanvasRenderer(term, rendererState);
        options.onRefit?.();
        notifyTerminalRendererChanged(sessionId);
        return 'canvas';
      } catch (error) {
        console.warn('[terminal] Canvas transition failed', error);
        return 'canvas';
      } finally {
        rendererState.loadPromise = null;
      }
    })();
    rendererState.loadPromise = transitionPromise;
    return transitionPromise;
  }

  disposeCanvasAddonInternal(rendererState, term);

  if (rendererState.kind === 'webgl' && rendererState.webglAddon) {
    notifyTerminalRendererChanged(sessionId);
    return 'webgl';
  }

  if (rendererState.loadPromise) {
    // Do not return stale loadPromise if desiredKind changed while the previous transition was in-flight.
    if (rendererState.kind === rendererState.desiredKind) {
      return rendererState.loadPromise;
    }
    // fall through to start transition for the new desiredKind
  }

  rendererState.loadPromise = (async () => {
    try {
      const kind = await loadWebglRenderer(sessionId, term, rendererState, options.onRefit);
      notifyTerminalRendererChanged(sessionId);
      if (kind === 'webgl') {
        options.onRefit?.();
      }
      return kind;
    } catch (error) {
      console.warn('[terminal] WebGL transition failed', error);
      return 'canvas';
    } finally {
      rendererState.loadPromise = null;
    }
  })();

  return rendererState.loadPromise;
}

/**
 * Disposes and reloads the WebGL addon so ligature font-feature-settings apply to the
 * texture atlas. No-op when GPU is blocked or WebGL is unavailable.
 */
export function reactivateTerminalWebgl(
  sessionId: string,
  term: Terminal,
  options: Pick<SyncTerminalRendererOptions, 'onRefit'> = {},
): Promise<TerminalRendererKind> {
  const rendererState = getTerminalRendererState(sessionId);
  if (rendererState.webglContextLossBlocked) {
    notifyTerminalRendererChanged(sessionId);
    return Promise.resolve('canvas');
  }

  if (rendererState.loadPromise) {
    return rendererState.loadPromise;
  }

  rendererState.loadPromise = (async (): Promise<TerminalRendererKind> => {
    try {
      disposeCanvasAddonInternal(rendererState, term);
      disposeWebglAddonInternal(rendererState, term);

      if (!isWebgl2Available()) {
        rendererState.initFailureCount += 1;
        rendererState.lastError = 'webgl2_unavailable';
        notifyTerminalRendererChanged(sessionId);
        return 'canvas';
      }

      const kind = await loadWebglRenderer(sessionId, term, rendererState, options.onRefit);
      notifyTerminalRendererChanged(sessionId);
      if (kind === 'webgl') {
        options.onRefit?.();
      }
      return kind;
    } finally {
      rendererState.loadPromise = null;
    }
  })();

  return rendererState.loadPromise;
}