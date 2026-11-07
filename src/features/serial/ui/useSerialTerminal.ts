import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';

import {
    buildTerminalHostStyle,
    resolveTerminalTransparency,
    resolveXtermTheme,
} from '../../../components/terminal/terminalTheme';
import { buildXtermOptions } from '../../../lib/terminal/xtermOptions';
import { useAppStore } from '../../../store/useAppStore';

/** Owns only display, sizing, and keyboard bytes. The serial pane owns the port. */
export function useSerialTerminal(
    onData: (text: string) => void,
    onBinary: (bytes: string) => void,
) {
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const inputTargetRef = useRef<HTMLTextAreaElement | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const inputRef = useRef({ onData, onBinary });
    const settings = useAppStore(
        useShallow((state) => ({
            terminal: state.settings.terminal,
            theme: state.settings.theme,
            customTheme: state.settings.customTheme,
            accentColor: state.settings.accentColor,
            elementColors: state.settings.elementColors,
            enableVibrancy: state.settings.enableVibrancy,
            windowOpacity: state.settings.windowOpacity,
        })),
    );

    useLayoutEffect(() => {
        inputRef.current = { onData, onBinary };
    }, [onData, onBinary]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) {
            return;
        }
        const terminal = new Terminal();
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        terminal.open(container);
        terminalRef.current = terminal;
        inputTargetRef.current = terminal.textarea ?? null;
        fitRef.current = fit;
        const text = terminal.onData((data) => inputRef.current.onData(data));
        const binary = terminal.onBinary((data) => inputRef.current.onBinary(data));
        let frame = 0;
        const observer = new ResizeObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                if (container.clientWidth && container.clientHeight) {
                    fit.fit();
                }
            });
        });
        observer.observe(container);
        return () => {
            observer.disconnect();
            cancelAnimationFrame(frame);
            text.dispose();
            binary.dispose();
            terminalRef.current = null;
            inputTargetRef.current = null;
            fitRef.current = null;
            terminal.dispose();
        };
    }, []);

    useEffect(() => {
        let frame = 0;
        /** Measure after the app's theme and typography have reached the DOM. */
        const refresh = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                const terminal = terminalRef.current;
                const container = containerRef.current;
                if (!terminal || !container) {
                    return;
                }
                terminal.options = buildXtermOptions({
                    settings: settings.terminal,
                    theme: resolveXtermTheme(
                        container,
                        undefined,
                        resolveTerminalTransparency(settings),
                    ),
                });
                if (container.clientWidth && container.clientHeight) {
                    fitRef.current?.fit();
                }
            });
        };
        refresh();
        window.addEventListener('zync:theme-registry-ready', refresh);
        return () => {
            cancelAnimationFrame(frame);
            window.removeEventListener('zync:theme-registry-ready', refresh);
        };
    }, [settings]);

    return {
        containerRef,
        terminalRef,
        inputTargetRef,
        style: buildTerminalHostStyle(resolveTerminalTransparency(settings)),
    };
}
