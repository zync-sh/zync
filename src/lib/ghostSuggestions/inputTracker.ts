/**
 * InputTracker — intercepts term.onData() bytes, maintains a local line buffer,
 * and handles ghost suggestion acceptance/dismissal.
 *
 * One instance lives per terminal session, stored in terminalCache.ghostTracker
 * so it survives component remounts alongside the XTerm instance.
 */

import { classifyInputEscape } from './escapeInput.js';

export interface InputTrackerOptions {
  onLineChange: (line: string) => void;
  onAccept: (suffix: string, lineAfterAccept: string) => void;
  onDismiss: () => void;
  onHistoryCommit: (command: string) => void;
}

// Raw byte sequences sent by xterm.js for common keys
const BACKSPACE   = '\x7f';
const CTRL_U      = '\x15'; // clear line (most shells)
const CTRL_C      = '\x03';
const CTRL_D      = '\x04';
const ENTER       = '\r';
const TAB         = '\t';
const ARROW_RIGHT = '\x1b[C';
const ALT_F       = '\x1bf';       // ESC + f
const ALT_RIGHT_1 = '\x1b[1;3C';   // common Alt+Right
const ALT_RIGHT_2 = '\x1b[1;9C';   // some terminals send Meta mask 8
const CTRL_RIGHT  = '\x1b[1;5C';   // common Ctrl+Right

function takeWordPortion(suffix: string): string {
  if (!suffix) return '';
  let i = 0;
  const chars = [...suffix];

  // Consume leading whitespace first.
  while (i < chars.length && /\s/.test(chars[i])) i++;
  // Consume the next token.
  while (i < chars.length && !/\s/.test(chars[i])) i++;
  // Consume the following whitespace run.
  while (i < chars.length && /\s/.test(chars[i])) i++;

  return chars.slice(0, i).join('');
}

function takePathComponentPortion(suffix: string): string {
  if (!suffix) return '';
  const chars = [...suffix];
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    i += 1;
    if (ch === '/' || ch === '\\') {
      break;
    }
  }
  return chars.slice(0, i).join('');
}

export class InputTracker {
  private lineBuffer     = '';
  private activeSuffix   = '';
  private desynced       = false;
  private secretInputMode = false;
  private opts: InputTrackerOptions;

  constructor(opts: InputTrackerOptions) {
    this.opts = opts;
  }

  updateOptions(opts: InputTrackerOptions): void {
    this.opts = opts;
  }

  private dismissAndDesync(): void {
    this.activeSuffix = '';
    this.desynced = true;
    this.opts.onDismiss();
  }

  /** Shell is waiting for hidden input (sudo/SSH password, passphrase). */
  enterSecretInputMode(): void {
    this.secretInputMode = true;
    this.lineBuffer = '';
    this.activeSuffix = '';
    this.desynced = true;
    this.opts.onDismiss();
  }

  exitSecretInputMode(): void {
    this.secretInputMode = false;
    this.lineBuffer = '';
    this.activeSuffix = '';
    this.desynced = false;
    this.opts.onDismiss();
  }

  isSecretInputMode(): boolean {
    return this.secretInputMode;
  }

  /**
   * Feed raw bytes from term.onData() into the tracker.
   * Returns { consumed: true } when the caller should NOT forward data to the PTY
   * (i.e. an accept key consumed part/all of the active suggestion).
   */
  feed(data: string): { consumed: boolean } {
    // Tab always goes to the shell (fish/zsh completion). Dismiss ghost and desync.
    if (data === TAB) {
      this.dismissAndDesync();
      return { consumed: false };
    }

    // ── Accept suggestion (Right arrow only for full accept; Tab is shell-owned) ─
    if (this.activeSuffix) {
      const acceptFull = data === ARROW_RIGHT;
      const acceptWord = data === ALT_F || data === ALT_RIGHT_1 || data === ALT_RIGHT_2;
      const acceptPath = data === CTRL_RIGHT;

      if (acceptFull || acceptWord || acceptPath) {
        const portion = acceptFull
          ? this.activeSuffix
          : acceptWord
            ? takeWordPortion(this.activeSuffix)
            : takePathComponentPortion(this.activeSuffix);

        if (portion) {
          this.lineBuffer += portion;
          this.activeSuffix = this.activeSuffix.slice(portion.length);
          this.opts.onAccept(portion, this.lineBuffer);
          return { consumed: true };
        }
      }
    }

    // ── Enter: commit command to history, reset buffer ─────────────────────────
    if (data === ENTER) {
      if (this.secretInputMode) {
        this.secretInputMode = false;
        this.lineBuffer = '';
        this.activeSuffix = '';
        this.desynced = false;
        this.opts.onDismiss();
        return { consumed: false };
      }
      if (!this.desynced) {
        const cmd = this.lineBuffer.trim();
        if (cmd) this.opts.onHistoryCommit(cmd);
      }
      this.lineBuffer  = '';
      this.activeSuffix = '';
      this.desynced = false;
      this.opts.onDismiss();
      return { consumed: false };
    }

    // ── Backspace ──────────────────────────────────────────────────────────────
    if (data === BACKSPACE) {
      const chars = [...this.lineBuffer];
      chars.pop();
      this.lineBuffer = chars.join('');
      this.activeSuffix = '';
      this.opts.onDismiss();
      if (this.lineBuffer) this.opts.onLineChange(this.lineBuffer);
      return { consumed: false };
    }

    // ── ctrl-u: shell "kill whole line" ───────────────────────────────────────
    if (data === CTRL_U) {
      this.lineBuffer   = '';
      this.activeSuffix = '';
      this.desynced = false;
      this.opts.onDismiss();
      return { consumed: false };
    }

    // ── ctrl-c / ctrl-d: shell resets the line ────────────────────────────────
    if (data === CTRL_C || data === CTRL_D) {
      this.lineBuffer   = '';
      this.activeSuffix = '';
      this.desynced = false;
      this.secretInputMode = false;
      this.opts.onDismiss();
      return { consumed: false };
    }

    // ── Escape sequences and history edits (P2) ───────────────────────────────
    // Cursor/history keys desync without wiping the buffer; unknown escapes
    // also desync conservatively until Enter/Ctrl+C/Ctrl+U resets the line.
    const escapeClass = classifyInputEscape(data);
    if (escapeClass !== null) {
      this.dismissAndDesync();
      return { consumed: false };
    }

    // ── Printable characters (including multi-char paste) ─────────────────────
    // Filter to printable range only — anything below 0x20 (space) or equal to
    // 0x7f is a control byte and should not enter the line buffer.
    const printable = [...data].filter(ch => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    }).join('');

    if (printable) {
      // Hidden password/passphrase entry — never fetch ghost or commit history.
      if (this.secretInputMode) {
        this.activeSuffix = '';
        this.opts.onDismiss();
        return { consumed: false };
      }

      // After unknown cursor/history edits we cannot trust the full line buffer.
      // Keep history commit behavior, but suppress ghost requests to avoid
      // inaccurate suggestions until shell line is reset (Enter/Ctrl+C/Ctrl+U).
      if (this.desynced) {
        this.activeSuffix = '';
        this.opts.onDismiss();
        return { consumed: false };
      }

      // Pasting clears the suffix since the buffer jumped ahead
      if (printable.length > 1) {
        this.activeSuffix = '';
        this.opts.onDismiss();
      }
      this.lineBuffer += printable;
      this.opts.onLineChange(this.lineBuffer);
    }

    return { consumed: false };
  }

  setSuggestion(suffix: string): void {
    this.activeSuffix = suffix;
  }

  clearSuggestion(): void {
    this.activeSuffix = '';
  }

  getLineBuffer(): string {
    return this.lineBuffer;
  }

  isDesynced(): boolean {
    return this.desynced;
  }

  /**
   * Programmatic buffer append used for accepted completions.
   * Intentionally does NOT call onLineChange; use feed() to trigger callbacks.
   */
  appendToLineBuffer(text: string): void {
    if (!text) return;
    this.lineBuffer += text;
  }

  /** Call when the PTY session restarts so stale buffer state is cleared. */
  reset(): void {
    this.lineBuffer   = '';
    this.activeSuffix = '';
    this.desynced = false;
    this.secretInputMode = false;
  }

  destroy(): void {
    this.reset();
  }
}
