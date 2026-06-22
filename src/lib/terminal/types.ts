/**
 * Terminal renderer kinds supported by Zync.
 * Extend this union when adding new xterm renderer addons (e.g. explicit canvas).
 */
export type TerminalRendererKind = 'webgl' | 'canvas';

export interface TerminalRendererState {
  /** Active renderer after the last successful apply. */
  kind: TerminalRendererKind;
  /** Last renderer target requested by policy/settings. */
  desiredKind: TerminalRendererKind;
  webglAddon?: { dispose: () => void };
  canvasAddon?: { dispose: () => void };
  loadPromise: Promise<TerminalRendererKind> | null;
  /**
   * Set only after WebGL context loss — skip GPU for remainder of session.
   * Init/probe failures do NOT set this; those remain retryable via settings sync.
   */
  webglContextLossBlocked: boolean;
  contextLossCount: number;
  initFailureCount: number;
  lastError?: string;
  /** Tracks font/ligature config baked into the current WebGL atlas. */
  webglLigaturesStamp?: string;
}

export function createInitialRendererState(): TerminalRendererState {
  return {
    kind: 'canvas',
    desiredKind: 'canvas',
    loadPromise: null,
    webglContextLossBlocked: false,
    contextLossCount: 0,
    initFailureCount: 0,
  };
}