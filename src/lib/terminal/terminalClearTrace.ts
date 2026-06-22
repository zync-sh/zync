import type { Terminal as XTerm } from '@xterm/xterm';

export type TerminalClearTraceReason =
  | 'spawn_clear_buffer'
  | 'spawn_no_clear_buffer'
  | 'context_menu_clear'
  | 'term_dispose'
  | 'term_open_new'
  | 'term_open_reattach'
  | 'suspend_pty'
  | 'reset_pty_reconnect'
  | 'destroy_instance'
  | 'clear_renderer_session'
  | 'activate_canvas_renderer'
  | 'refresh_terminal_screen'
  | 'restore_terminal_display'
  | 'webgl_context_loss'
  | 'dispose_webgl_addon'
  | 'dispose_canvas_addon'
  | 'lazy_spawn'
  | 'mount_spawn'
  | 'enter_restart'
  | 'reconnect_wakeup'
  | 'pty_exit_panel_suspend'
  | 'pty_exit_session_end'
  | 'visibility_state'
  | 'visibility_renderer_refit'
  | 'clear_terminals_store'
  | 'close_terminal_store';

export interface TerminalClearTraceDetails extends Record<string, unknown> {
  sessionId?: string;
  connectionId?: string;
  source?: string;
}

function captureStack(maxFrames = 6): string | undefined {
  return new Error().stack?.split('\n').slice(2, 2 + maxFrames).join('\n');
}

export function getTerminalBufferSnapshot(term?: XTerm | null): {
  bufferLines: number | null;
  rows: number | null;
  cols: number | null;
  hasElement: boolean;
  elementConnected: boolean;
} {
  if (!term) {
    return {
      bufferLines: null,
      rows: null,
      cols: null,
      hasElement: false,
      elementConnected: false,
    };
  }

  return {
    bufferLines: term.buffer?.active?.length ?? null,
    rows: term.rows ?? null,
    cols: term.cols ?? null,
    hasElement: Boolean(term.element),
    elementConnected: Boolean(term.element?.isConnected),
  };
}

/** Logs every path that can clear scrollback or make the terminal appear blank. */
export function traceTerminalScreenMutation(
  reason: TerminalClearTraceReason,
  details: TerminalClearTraceDetails = {},
  term?: XTerm | null,
): void {
  const snapshot = getTerminalBufferSnapshot(term);
  console.log('[terminal-clear-trace]', {
    reason,
    at: new Date().toISOString(),
    ...snapshot,
    ...details,
    stack: captureStack(),
  });
}

export function traceTerminalBufferClear(
  reason: TerminalClearTraceReason,
  term: XTerm,
  details: TerminalClearTraceDetails = {},
): void {
  const before = getTerminalBufferSnapshot(term);
  traceTerminalScreenMutation(reason, { ...details, phase: 'before', ...before }, term);
  term.clear();
  term.reset();
  const after = getTerminalBufferSnapshot(term);
  traceTerminalScreenMutation(reason, { ...details, phase: 'after', ...after }, term);
}