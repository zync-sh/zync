import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal as XTerm } from '@xterm/xterm';
import { refreshTerminalScreen } from './rendererLifecycle.js';
import { isTerminalDomMeasurable, safeFitTerminal } from './terminalFit.js';

/**
 * Refit and redraw xterm after the terminal panel was overlaid (Files/Dashboard).
 * Call only for the visible active shell tab — hidden tabs must restore when selected.
 */
export function restoreTerminalDisplay(
  term: XTerm | null | undefined,
  fitAddon: FitAddon | null | undefined,
): void {
  if (!term || !isTerminalDomMeasurable(term)) {
    return;
  }

  safeFitTerminal(fitAddon, term);
  refreshTerminalScreen(term);

  if (typeof requestAnimationFrame !== 'undefined') {
    requestAnimationFrame(() => {
      refreshTerminalScreen(term);
    });
  }
}