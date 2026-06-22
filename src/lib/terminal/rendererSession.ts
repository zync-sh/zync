import type { Terminal } from '@xterm/xterm';
import { disposeTerminalRenderer, ensureCanvasRenderer } from './rendererLifecycle.js';
import { traceTerminalScreenMutation } from './terminalClearTrace.js';
import { createInitialRendererState, type TerminalRendererState } from './types.js';

const rendererSessions = new Map<string, TerminalRendererState>();

export function getTerminalRendererState(sessionId: string): TerminalRendererState {
  let state = rendererSessions.get(sessionId);
  if (!state) {
    state = createInitialRendererState();
    rendererSessions.set(sessionId, state);
  }
  return state;
}

export function hasTerminalRendererSession(sessionId: string): boolean {
  return rendererSessions.has(sessionId);
}

export function ensureCanvasRendererForSession(sessionId: string): void {
  ensureCanvasRenderer(getTerminalRendererState(sessionId));
}

export function clearTerminalRendererSession(sessionId: string, term?: Terminal): void {
  const state = rendererSessions.get(sessionId);
  if (!state) return;

  traceTerminalScreenMutation('clear_renderer_session', {
    sessionId,
    source: 'clearTerminalRendererSession',
  }, term);

  disposeTerminalRenderer(state, term);
  rendererSessions.delete(sessionId);
}