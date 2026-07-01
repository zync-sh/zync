import type { FontWeight, ITerminalOptions, ITheme } from '@xterm/xterm';
import { isLightTheme } from '../../components/terminal/terminalTheme.js';

export interface TerminalXtermSettings {
  fontSize: number;
  fontFamily: string;
  fontWeight?: FontWeight;
  fontWeightBold?: FontWeight;
  cursorStyle: 'block' | 'underline' | 'bar';
  lineHeight: number;
}

export interface BuildXtermOptionsParams {
  settings: TerminalXtermSettings;
  theme: ITheme;
  /** Local ConPTY on Windows — enables xterm resize/scrollback heuristics for ConPTY. */
  windowsLocalPty?: boolean;
}

/** Default xterm scrollback rows (xterm default is 1000). */
export const TERMINAL_SCROLLBACK_ROWS = 5000;

/**
 * Build ITerminalOptions for new xterm instances.
 *
 * - reflowCursorLine stays false — shells handle cursor-line reflow; historical
 *   scrollback must not reflow (docs/TERMINAL.md §13).
 * - windowsPty only for local Windows ConPTY, not remote SSH viewed on Windows.
 * - Synchronized output (DECSET 2026) is negotiated at runtime by xterm 6; no
 *   init option required.
 */
export function buildXtermOptions({
  settings,
  theme,
  windowsLocalPty = false,
}: BuildXtermOptionsParams): ITerminalOptions {
  return {
    cursorBlink: true,
    fontSize: settings.fontSize,
    fontFamily: settings.fontFamily,
    fontWeight: settings.fontWeight ?? 'normal',
    fontWeightBold: settings.fontWeightBold ?? 'bold',
    cursorStyle: settings.cursorStyle,
    lineHeight: settings.lineHeight,
    allowTransparency: true,
    allowProposedApi: true,
    minimumContrastRatio: isLightTheme() ? 4.5 : 1,
    theme,
    reflowCursorLine: false,
    scrollback: TERMINAL_SCROLLBACK_ROWS,
    ...(windowsLocalPty ? { windowsPty: { backend: 'conpty' } } : {}),
  };
}

export function shouldUseWindowsLocalPtyOptions(terminalKey: string): boolean {
  if (terminalKey !== 'local') {
    return false;
  }
  if (typeof window === 'undefined') {
    return false;
  }
  return window.electronUtils?.platform === 'win32';
}