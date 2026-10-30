import type { FontWeight, Terminal as XTerm } from '@xterm/xterm';
import { type RefObject, useEffect, useMemo } from 'react';

import { terminalCache } from '../../lib/terminal/terminalCache.js';
import { applyTerminalTypography } from '../../lib/terminal/terminalTypography.js';
import type { Connection } from '../../store/useAppStore';
import type { TerminalFontWeightSetting } from '../settings/constants/defaults';
import {
    applyXtermTheme,
    buildTerminalHostStyle,
    resolveTerminalTransparency,
    resolveXtermTheme,
    type TerminalTransparencySettings,
} from './terminalTheme.js';

export interface TerminalSettingsSlice {
    fontSize: number;
    fontFamily: string;
    fontWeight?: TerminalFontWeightSetting;
    fontWeightBold?: FontWeight;
    cursorStyle: 'block' | 'underline' | 'bar';
    lineHeight: number;
}

export interface UseTerminalThemeOptions {
    containerRef: RefObject<HTMLDivElement | null>;
    termRef: RefObject<XTerm | null>;
    settings: TerminalTransparencySettings & {
        theme: string;
        accentColor?: string | null;
        terminal: TerminalSettingsSlice;
    };
    connection: Connection | null | undefined;
    sessionId: string;
    isConnected: boolean;
}

/** Keeps this mounted terminal's presentation current, including while its tab is hidden. */
export function useTerminalTheme({
    containerRef,
    termRef,
    settings,
    connection,
    sessionId,
    isConnected,
}: UseTerminalThemeOptions) {
    const terminalTransparency = useMemo(
        () => resolveTerminalTransparency(settings),
        [settings.enableVibrancy, settings.windowOpacity],
    );

    const terminalHostStyle = useMemo(
        () => buildTerminalHostStyle(terminalTransparency),
        [terminalTransparency],
    );

    /** Resolves the initial palette without changing terminal ownership or typography. */
    const resolveInitialTheme = () =>
        resolveXtermTheme(containerRef.current, connection?.theme, terminalTransparency);

    const typography = useMemo(
        () => ({
            fontSize: settings.terminal.fontSize,
            fontFamily: settings.terminal.fontFamily,
            fontWeight: settings.terminal.fontWeight,
            fontWeightBold: settings.terminal.fontWeightBold,
            cursorStyle: settings.terminal.cursorStyle,
            lineHeight: settings.terminal.lineHeight,
        }),
        [settings.terminal],
    );

    useEffect(() => {
        // Lifecycle binds the retained cache entry after this hook's mount effects run.
        const term = termRef.current ?? terminalCache.get(sessionId)?.term;
        if (term) {
            applyTerminalTypography(sessionId, term, typography);
        }
    }, [sessionId, typography, isConnected, termRef]);

    useEffect(() => {
        /** Renderer events update only this live terminal, never every cached shell. */
        const handleRendererChanged = (event: Event) => {
            const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
            if (detail?.sessionId && detail.sessionId !== sessionId) {
                return;
            }
            const term = termRef.current ?? terminalCache.get(sessionId)?.term;
            if (term) {
                applyTerminalTypography(sessionId, term, typography);
            }
        };

        window.addEventListener('zync:terminal-renderer-changed', handleRendererChanged);
        return () =>
            window.removeEventListener('zync:terminal-renderer-changed', handleRendererChanged);
    }, [sessionId, typography, isConnected, termRef]);

    useEffect(() => {
        if (!isConnected || !termRef.current) {
            return;
        }

        applyXtermTheme(
            termRef.current,
            containerRef.current,
            connection?.theme,
            terminalTransparency,
        );
    }, [
        sessionId,
        isConnected,
        settings.theme,
        settings.accentColor,
        settings.enableVibrancy,
        settings.windowOpacity,
        connection?.theme,
        terminalTransparency,
        containerRef,
        termRef,
    ]);

    return {
        terminalTransparency,
        terminalHostStyle,
        resolveInitialTheme,
    };
}
