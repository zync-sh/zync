import type { FontWeight, ITerminalOptions, Terminal } from '@xterm/xterm';

import type { TerminalFontWeightSetting } from '../../components/settings/constants/defaults.js';
import { refreshTerminalScreen } from './rendererLifecycle.js';
import { getTerminalRendererState, hasTerminalRendererSession } from './rendererSession.js';
import { terminalCache } from './terminalCache.js';
import type { TerminalRendererKind, TerminalRendererState } from './types.js';
import type { TerminalXtermSettings } from './xtermOptions.js';

/** Detects the desktop platform without requiring browser globals in native/unit callers. */
function isWindowsPlatform(): boolean {
    if (typeof window === 'undefined') {
        return false;
    }
    if (window.electronUtils?.platform === 'win32') {
        return true;
    }
    return typeof navigator !== 'undefined' && /win/i.test(navigator.platform);
}

/**
 * WebGL draws glyphs to a canvas atlas (grayscale AA). DOM uses native ClearType on Windows,
 * so GPU text often looks sharper/thinner. Add a pixel of letter-spacing on Win32 WebGL only.
 */
export function resolveTerminalLetterSpacing(rendererKind: TerminalRendererKind): number {
    if (rendererKind === 'webgl' && isWindowsPlatform()) {
        return 1;
    }
    return 0;
}

type AppliedTypography = {
    paintToken: object;
    state: TerminalRendererState;
    kind: TerminalRendererKind;
    addon: TerminalRendererState['webglAddon'];
    frame?: number;
};
const appliedRenderers = new WeakMap<Terminal, AppliedTypography>();

/** Picks a bold weight one step above the regular terminal weight (capped at 900). */
export function resolveTerminalFontWeightBold(
    fontWeight: TerminalFontWeightSetting | 'normal' | undefined,
): FontWeight {
    if (typeof fontWeight === 'number' && fontWeight >= 100 && fontWeight <= 900) {
        return Math.min(900, fontWeight + 100) as FontWeight;
    }
    // `'normal'` / unknown → classic bold step
    return 'bold';
}

/** Normalizes regular and bold weights before comparing or applying effective xterm options. */
function resolveTypographyWeights(settings: TerminalXtermSettings): {
    fontWeight: FontWeight;
    fontWeightBold: FontWeight;
} {
    const nextWeight: FontWeight = settings.fontWeight ?? 'normal';
    // Normalize before xterm so regular + bold stay on the same weight ladder.
    const resolvedRegularWeight: TerminalFontWeightSetting | 'normal' =
        typeof nextWeight === 'number' && nextWeight >= 100 && nextWeight <= 900
            ? nextWeight === 400
                ? 'normal'
                : (nextWeight as TerminalFontWeightSetting)
            : nextWeight === 'bold'
              ? 700
              : 'normal';
    const fontWeightBold =
        settings.fontWeightBold ?? resolveTerminalFontWeightBold(resolvedRegularWeight);

    return { fontWeight: resolvedRegularWeight, fontWeightBold };
}

/** Identifies the effective font/layout options already installed on one renderer. */
export function buildWebglTypographyStamp(term: Terminal, sessionId: string): string {
    const rendererKind = getTerminalRendererState(sessionId).kind;
    return [
        term.options.fontFamily ?? '',
        term.options.fontSize ?? '',
        term.options.fontWeight ?? '',
        term.options.fontWeightBold ?? '',
        term.options.lineHeight ?? '',
        term.options.letterSpacing ?? 0,
        rendererKind,
    ].join('|');
}

/** Stamp from pending settings — used before term.options are applied. */
export function buildWebglTypographyStampFromSettings(
    settings: TerminalXtermSettings,
    sessionId: string,
): string {
    const rendererKind = getTerminalRendererState(sessionId).kind;
    const { fontWeight, fontWeightBold } = resolveTypographyWeights(settings);
    return [
        settings.fontFamily ?? '',
        settings.fontSize ?? '',
        fontWeight,
        fontWeightBold,
        settings.lineHeight ?? '',
        resolveTerminalLetterSpacing(rendererKind),
        rendererKind,
    ].join('|');
}

/** Clears the captured live renderer without recreating a session during deferred work. */
function clearWebglTextureAtlas(state: TerminalRendererState): void {
    state.webglAddon?.clearTextureAtlas?.();
}

/** Avoids xterm option setters when the effective value has not changed. */
function updateTerminalOption<K extends keyof ITerminalOptions>(
    options: ITerminalOptions,
    key: K,
    value: ITerminalOptions[K],
): boolean {
    if (options[key] === value) {
        return false;
    }
    options[key] = value;
    return true;
}

/** Resolves the live owner at paint time so a paused frame cannot retain a closed shell. */
function scheduleTypographyPaint(sessionId: string, owner: AppliedTypography): number {
    const paintToken = owner.paintToken;
    const hadCachedOwner = terminalCache.has(sessionId);
    return requestAnimationFrame(() => {
        if (!hasTerminalRendererSession(sessionId)) {
            return;
        }
        const state = getTerminalRendererState(sessionId);
        const cached = terminalCache.get(sessionId);
        const term = cached?.term ?? state.terminal;
        const owner = term && appliedRenderers.get(term);
        if (!term || !owner || owner.paintToken !== paintToken) {
            return;
        }
        owner.frame = undefined;
        if (
            owner.state !== state ||
            state.disposed ||
            (state.terminal && state.terminal !== term) ||
            (hadCachedOwner && !cached) ||
            state.kind !== owner.kind ||
            state.webglAddon !== owner.addon
        ) {
            return;
        }
        clearWebglTextureAtlas(state);
        refreshTerminalScreen(term);
    });
}

/** Applies changed typography to one live owner; cursor-only edits do not rebuild its atlas. */
export function applyTerminalTypography(
    sessionId: string,
    term: Terminal,
    settings: TerminalXtermSettings,
): void {
    const { fontWeight: nextWeight, fontWeightBold: nextWeightBold } =
        resolveTypographyWeights(settings);

    const rendererState = getTerminalRendererState(sessionId);
    const cached = terminalCache.get(sessionId);
    if (
        rendererState.disposed ||
        (rendererState.terminal && rendererState.terminal !== term) ||
        (cached && cached.term !== term)
    ) {
        return;
    }
    const rendererKind = rendererState.kind;
    const previous = appliedRenderers.get(term);
    const rendererChanged =
        !previous ||
        previous.state !== rendererState ||
        previous.kind !== rendererKind ||
        previous.addon !== rendererState.webglAddon;
    const nextTypography = {
        fontSize: settings.fontSize,
        fontFamily: settings.fontFamily,
        fontWeight: nextWeight,
        fontWeightBold: nextWeightBold,
        lineHeight: settings.lineHeight,
        letterSpacing: resolveTerminalLetterSpacing(rendererKind),
    };
    let typographyChanged = false;
    for (const key of Object.keys(nextTypography) as (keyof typeof nextTypography)[]) {
        typographyChanged =
            updateTerminalOption(term.options, key, nextTypography[key]) || typographyChanged;
    }
    updateTerminalOption(term.options, 'cursorStyle', settings.cursorStyle);
    if (!typographyChanged && !rendererChanged) {
        return;
    }

    if (previous?.frame !== undefined && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(previous.frame);
    }
    const owner: AppliedTypography = {
        paintToken: {},
        state: rendererState,
        kind: rendererKind,
        addon: rendererState.webglAddon,
    };
    appliedRenderers.set(term, owner);

    rendererState.webglTypographyStamp = buildWebglTypographyStamp(term, sessionId);

    clearWebglTextureAtlas(rendererState);
    refreshTerminalScreen(term);

    if (typeof requestAnimationFrame !== 'undefined') {
        owner.frame = scheduleTypographyPaint(sessionId, owner);
    }
}

/** Refreshes typography on every cached terminal (active + background tabs). */
export function refreshAllCachedTerminalTypography(settings: TerminalXtermSettings): void {
    for (const [sessionId, cached] of terminalCache.entries()) {
        applyTerminalTypography(sessionId, cached.term, settings);
    }
}
