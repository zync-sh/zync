/**
 * InputTracker — intercepts term.onData() bytes, maintains a local line buffer,
 * and handles ghost suggestion acceptance/dismissal.
 *
 * One instance lives per terminal session, stored in terminalCache.ghostTracker
 * so it survives component remounts alongside the XTerm instance.
 */

import { classifyInputEscape } from './escapeInput.js';
import { ghostInputByteLength, MAX_GHOST_COMMAND_BYTES } from './inputBudget.js';

export interface InputTrackerOptions {
    onLineChange: (line: string) => void;
    onAccept: (suffix: string, lineAfterAccept: string) => void;
    onDismiss: () => void;
    onHistoryCommit: (command: string) => void;
}

// Raw byte sequences sent by xterm.js for common keys
const BACKSPACE = '\x7f';
const CTRL_U = '\x15'; // clear line (most shells)
const CTRL_C = '\x03';
const CTRL_D = '\x04';
const ENTER = '\r';
const TAB = '\t';
const ARROW_RIGHT = '\x1b[C';
const ALT_F = '\x1bf'; // ESC + f
const ALT_RIGHT_1 = '\x1b[1;3C'; // common Alt+Right
const ALT_RIGHT_2 = '\x1b[1;9C'; // some terminals send Meta mask 8
const CTRL_RIGHT = '\x1b[1;5C'; // common Ctrl+Right

/** Select the next accepted word, preserving adjacent whitespace. */
function takeWordPortion(suffix: string): string {
    if (!suffix) {
        return '';
    }
    let i = 0;
    const chars = [...suffix];

    // Consume leading whitespace first.
    while (i < chars.length && /\s/.test(chars[i])) {
        i++;
    }
    // Consume the next token.
    while (i < chars.length && !/\s/.test(chars[i])) {
        i++;
    }
    // Consume the following whitespace run.
    while (i < chars.length && /\s/.test(chars[i])) {
        i++;
    }

    return chars.slice(0, i).join('');
}

/** Select one accepted path component, including its separator. */
function takePathComponentPortion(suffix: string): string {
    if (!suffix) {
        return '';
    }
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
    private lineBuffer = '';
    private lineBytes = 0;
    private activeSuffix = '';
    private desynced = false;
    private secretInputMode = false;
    private secretInputSubmitted = false;
    private opts: InputTrackerOptions;

    /** Start with no inferred input or shell context assumptions. */
    constructor(opts: InputTrackerOptions) {
        this.opts = opts;
    }

    /** Replace runtime callbacks when this cached tracker is rebound. */
    updateOptions(opts: InputTrackerOptions): void {
        this.opts = opts;
    }

    /** Discard inferred input without clearing a known secret prompt. Resume only
     * after a shell reset key is fed while the surrounding context is safe. */
    suspend(): void {
        if (this.desynced && !this.lineBuffer && !this.activeSuffix) {
            return;
        }
        this.lineBuffer = '';
        this.lineBytes = 0;
        this.activeSuffix = '';
        this.desynced = true;
        this.opts.onDismiss();
    }

    /** Preserve bounded text but stop inference after shell-owned editing. */
    private dismissAndDesync(): void {
        this.activeSuffix = '';
        this.desynced = true;
        this.opts.onDismiss();
    }

    /** Shell is waiting for hidden input (sudo/SSH password, passphrase). */
    enterSecretInputMode(): void {
        this.secretInputMode = true;
        this.secretInputSubmitted = false;
        this.lineBuffer = '';
        this.lineBytes = 0;
        this.activeSuffix = '';
        this.desynced = true;
        this.opts.onDismiss();
    }

    /** A fresh shell prompt (or explicit cancellation) ends hidden input. */
    exitSecretInputMode(): void {
        if (!this.secretInputMode) {
            return;
        }
        this.secretInputMode = false;
        this.secretInputSubmitted = false;
        this.lineBuffer = '';
        this.lineBytes = 0;
        this.activeSuffix = '';
        this.desynced = false;
        this.opts.onDismiss();
    }

    /** Expose the stronger hidden-input gate to delayed requests and overlays. */
    isSecretInputMode(): boolean {
        return this.secretInputMode;
    }

    /** A confirmed current OSC 7 can recover a custom prompt after submission,
     * but a subsequent password prompt must first disarm this recovery. */
    recoverSecretInputAfterSubmit(): boolean {
        if (!this.secretInputMode || !this.secretInputSubmitted) {
            return false;
        }
        this.exitSecretInputMode();
        return true;
    }

    /**
     * Feed raw bytes from term.onData() into the tracker.
     * Returns { consumed: true } when the caller should NOT forward data to the PTY
     * (i.e. an accept key consumed part/all of the active suggestion).
     */
    feed(data: string): { consumed: boolean } {
        // Enter can submit one of several password prompts (sudo retry, passwd,
        // nested authentication). Stay guarded until fresh shell-prompt evidence;
        // typing, pasting, editing and Tab must never reach inference callbacks.
        if (this.secretInputMode) {
            if (data === CTRL_C || data === CTRL_D) {
                this.exitSecretInputMode();
            } else {
                if (data === ENTER) {
                    this.secretInputSubmitted = true;
                }
                this.lineBuffer = '';
                this.activeSuffix = '';
                this.desynced = true;
                this.opts.onDismiss();
            }
            return { consumed: false };
        }

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
                    if (!this.appendTrackedText(portion)) {
                        return { consumed: false };
                    }
                    this.activeSuffix = this.activeSuffix.slice(portion.length);
                    this.opts.onAccept(portion, this.lineBuffer);
                    return { consumed: true };
                }
            }
        }

        // ── Enter: commit command to history, reset buffer ─────────────────────────
        if (data === ENTER) {
            if (!this.desynced) {
                const cmd = this.lineBuffer.trim();
                if (cmd) {
                    this.opts.onHistoryCommit(cmd);
                }
            }
            this.lineBuffer = '';
            this.lineBytes = 0;
            this.activeSuffix = '';
            this.desynced = false;
            this.opts.onDismiss();
            return { consumed: false };
        }

        // ── Backspace ──────────────────────────────────────────────────────────────
        if (data === BACKSPACE) {
            const chars = [...this.lineBuffer];
            const removed = chars.pop() ?? '';
            this.lineBuffer = chars.join('');
            this.lineBytes -= ghostInputByteLength(removed) ?? 0;
            this.activeSuffix = '';
            this.opts.onDismiss();
            if (this.lineBuffer) {
                this.opts.onLineChange(this.lineBuffer);
            }
            return { consumed: false };
        }

        // ── ctrl-u: shell "kill whole line" ───────────────────────────────────────
        if (data === CTRL_U) {
            this.lineBuffer = '';
            this.lineBytes = 0;
            this.activeSuffix = '';
            this.desynced = false;
            this.opts.onDismiss();
            return { consumed: false };
        }

        // ── ctrl-c / ctrl-d: shell resets the line ────────────────────────────────
        if (data === CTRL_C || data === CTRL_D) {
            this.lineBuffer = '';
            this.lineBytes = 0;
            this.activeSuffix = '';
            this.desynced = false;
            this.secretInputMode = false;
            this.opts.onDismiss();
            return { consumed: false };
        }

        // Discard raw oversized events before escape parsing or character-array allocation.
        // Remain desynced until a reset key, so a later paste tail is never history.
        if (this.desynced) {
            return { consumed: false };
        }
        if (ghostInputByteLength(data) === null) {
            this.suspend();
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
        const printable = [...data]
            .filter((ch) => {
                const code = ch.charCodeAt(0);
                return code >= 0x20 && code !== 0x7f;
            })
            .join('');

        if (printable) {
            // Pasting clears the suffix since the buffer jumped ahead
            if (printable.length > 1) {
                this.activeSuffix = '';
                this.opts.onDismiss();
            }
            if (!this.appendTrackedText(printable)) {
                return { consumed: false };
            }
            this.opts.onLineChange(this.lineBuffer);
        }

        return { consumed: false };
    }

    /** Retain only a completion whose complete inferred command fits the shared budget. */
    setSuggestion(suffix: string): void {
        this.activeSuffix =
            this.secretInputMode || this.desynced || this.bytesAfterAppend(suffix) === null
                ? ''
                : suffix;
    }

    /** Drop the current suffix without changing tracked input. */
    clearSuggestion(): void {
        this.activeSuffix = '';
    }

    /** Context changes dismiss visible text without discarding the user's line. */
    dismissSuggestion(): void {
        this.activeSuffix = '';
        this.opts.onDismiss();
    }

    /** Return only the currently admitted, bounded suffix. */
    getSuggestion(): string {
        return this.activeSuffix;
    }

    /** Return the bounded inferred line, never the terminal's complete editing buffer. */
    getLineBuffer(): string {
        return this.lineBuffer;
    }

    /** Indicate that inference must wait for an explicit shell-line reset. */
    isDesynced(): boolean {
        return this.desynced;
    }

    /**
     * Programmatic buffer append used for accepted completions.
     * Intentionally does NOT call onLineChange; use feed() to trigger callbacks.
     */
    appendToLineBuffer(text: string): void {
        if (!text || this.desynced || this.secretInputMode) {
            return;
        }
        this.appendTrackedText(text);
    }

    /** Account incrementally, including surrogate pairs split across consecutive input events. */
    private bytesAfterAppend(text: string): number | null {
        const last = this.lineBuffer.charCodeAt(this.lineBuffer.length - 1);
        const first = text.charCodeAt(0);
        const paired = last >= 0xd800 && last <= 0xdbff && first >= 0xdc00 && first <= 0xdfff;
        const adjustment = paired ? 2 : 0;
        const added = ghostInputByteLength(
            text,
            MAX_GHOST_COMMAND_BYTES - this.lineBytes + adjustment,
        );
        return added === null ? null : this.lineBytes + added - adjustment;
    }

    /** Drop oversized inferred state without consuming or changing the terminal's original input. */
    private appendTrackedText(text: string): boolean {
        const bytes = this.bytesAfterAppend(text);
        if (bytes === null) {
            this.suspend();
            return false;
        }
        this.lineBytes = bytes;
        this.lineBuffer += text;
        return true;
    }

    /** Call when the PTY session restarts so stale buffer state is cleared. */
    reset(): void {
        this.lineBuffer = '';
        this.lineBytes = 0;
        this.activeSuffix = '';
        this.desynced = false;
        this.secretInputMode = false;
        this.secretInputSubmitted = false;
    }

    /** Release cached inferred text and reset all tracking gates. */
    destroy(): void {
        this.reset();
    }
}
