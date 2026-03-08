
import { useEffect, useRef } from 'react';
import { TerminalComponent } from '../Terminal';
import { useAppStore } from '../../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { Terminal as TerminalIcon, Plus, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { AiCommandBar } from './AiCommandBar';
import { once, type UnlistenFn } from '@tauri-apps/api/event';

// TerminalTab interface is now in store/terminalSlice
// export interface TerminalTab ... removed

export function TerminalManager({ connectionId, isVisible, hideTabs = false }: { connectionId?: string; isVisible?: boolean, hideTabs?: boolean }) {
    const globalActiveId = useAppStore(state => state.activeConnectionId);
    const activeConnectionId = connectionId || globalActiveId;

    // Zustand Store Hooks - Optimized
    const tabs = useAppStore(useShallow(state => activeConnectionId ? (state.terminals[activeConnectionId] || []) : []));
    const activeTabId = useAppStore(state => activeConnectionId ? (state.activeTerminalIds[activeConnectionId] || null) : null);

    // Actions (stable)
    const createTerminal = useAppStore(state => state.createTerminal);
    const ensureTerminal = useAppStore(state => state.ensureTerminal);
    const closeTerminal = useAppStore(state => state.closeTerminal);
    const setActiveTerminal = useAppStore(state => state.setActiveTerminal);
    const openAiCommandBar = useAppStore(state => state.openAiCommandBar);
    const terminalTransparencyEnabled = useAppStore(
        state => state.settings.enableVibrancy && (state.settings.windowOpacity ?? 1) < 1
    );
    const terminalContentRef = useRef<HTMLDivElement>(null);
    const pendingReadyRef = useRef<Record<string, { timeoutId: any; unlistenFn?: UnlistenFn; sent?: boolean }>>({});
    const activeTabIdRef = useRef(activeTabId);

    // Update ref when activeTabId changes
    useEffect(() => {
        activeTabIdRef.current = activeTabId;
    }, [activeTabId]);


    // Derived State - Removed (now selected directly)
    // Initialize/Reset when connection changes
    useEffect(() => {
        if (activeConnectionId) {
            ensureTerminal(activeConnectionId);
        }
    }, [activeConnectionId]);

    const handleNewTab = () => {
        if (activeConnectionId) {
            createTerminal(activeConnectionId);
        }
    };


    // Event Listener for external commands (Snippets)
    useEffect(() => {
        const handleRunCommand = (e: any) => {
            const { connectionId: targetConnId, command } = e.detail;
            if (targetConnId === activeConnectionId && activeTabIdRef.current) {
                window.ipcRenderer.send('terminal:write', { termId: activeTabIdRef.current, data: command });
            }
        };

        const handleTriggerNewTab = (e: any) => {
            const { connectionId: targetConnId, command } = e.detail;
            if (targetConnId === activeConnectionId && activeConnectionId) {
                // `createTerminal` takes only `connectionId` and returns the newly created `termId`.
                const newId = createTerminal(activeConnectionId);

                // If a command was passed (e.g., from a plugin like PM2 logs), execute it in the new tab after it's ready
                if (command) {
                    const pendingObj: { timeoutId: any; unlistenFn?: UnlistenFn; sent?: boolean } = {
                        sent: false,
                        timeoutId: setTimeout(() => {
                            const obj = pendingReadyRef.current[newId];
                            if (!obj || obj.sent) return;

                            obj.sent = true;
                            obj.unlistenFn?.(); // Clean up listener on timeout
                            delete pendingReadyRef.current[newId];

                            console.warn(`[TerminalManager] terminal-ready-${newId} timed out, sending command anyway`);
                            window.ipcRenderer.send('terminal:write', { termId: newId, data: command });
                        }, 5000)
                    };
                    pendingReadyRef.current[newId] = pendingObj;

                    once(`terminal-ready-${newId}`, () => {
                        const obj = pendingReadyRef.current[newId];
                        if (obj && !obj.sent) {
                            obj.sent = true;
                            clearTimeout(obj.timeoutId);
                            delete pendingReadyRef.current[newId];
                            window.ipcRenderer.send('terminal:write', { termId: newId, data: command });
                        }
                    }).then(unlisten => {
                        const obj = pendingReadyRef.current[newId];
                        if (obj) {
                            obj.unlistenFn = unlisten;
                        } else {
                            // Already timed out or handled
                            unlisten();
                        }
                    }).catch(err => {
                        console.error(`[TerminalManager] Failed to listen for terminal-ready-${newId}:`, err);
                    });

                    // Automatically switch the global Zync view to 'terminal' so the user sees the logs
                    const activeGlobalTabId = useAppStore.getState().activeTabId;
                    if (activeGlobalTabId) {
                        useAppStore.getState().setTabView(activeGlobalTabId, 'terminal');
                    }
                }
            }
        };

        const handleTriggerCloseTab = (e: any) => {
            const { connectionId: targetConnId } = e.detail;
            if (targetConnId === activeConnectionId && activeTabId) {
                closeTerminal(activeConnectionId!, activeTabId as string);
            }
        };

        const handlePluginTerminalSend = (e: any) => {
            const { connectionId: targetConnId, text } = (e as CustomEvent).detail;
            // If the plugin didn't provide a connectionId, or it matches ours, and we have an active terminal
            if ((!targetConnId || targetConnId === activeConnectionId) && activeTabIdRef.current) {
                window.ipcRenderer.send('terminal:write', { termId: activeTabIdRef.current, data: text });
            }
        };

        const handleAiCommandBar = () => openAiCommandBar();

        window.addEventListener('ssh-ui:run-command', handleRunCommand);
        window.addEventListener('ssh-ui:new-terminal-tab', handleTriggerNewTab);
        window.addEventListener('ssh-ui:close-terminal-tab', handleTriggerCloseTab);
        window.addEventListener('zync:terminal:send', handlePluginTerminalSend);
        window.addEventListener('zync:ai-command-bar', handleAiCommandBar);

        return () => {
            window.removeEventListener('ssh-ui:run-command', handleRunCommand);
            window.removeEventListener('ssh-ui:new-terminal-tab', handleTriggerNewTab);
            window.removeEventListener('ssh-ui:close-terminal-tab', handleTriggerCloseTab);
            window.removeEventListener('zync:terminal:send', handlePluginTerminalSend);
            window.removeEventListener('zync:ai-command-bar', handleAiCommandBar);

            // Clear any pending timeouts and reset pendingReadyRef
            Object.values(pendingReadyRef.current).forEach(obj => {
                if (obj) {
                    if (typeof obj.unlistenFn === 'function') {
                        obj.unlistenFn();
                    }
                    if (obj.timeoutId) {
                        clearTimeout(obj.timeoutId);
                    }
                }
            });
            pendingReadyRef.current = {};

            // Cleanup only if connection changed or unmounting
            // We don't want to clear this when just switching tabs within same connection
        };
    }, [activeConnectionId, openAiCommandBar]); // Remove activeTabId to prevent reset on tab switch


    const handleCloseTab = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (activeConnectionId) {
            closeTerminal(activeConnectionId, id);
        }
    };


    if (!activeConnectionId) {
        return (
            <div className={cn("h-full flex items-center justify-center text-app-muted", terminalTransparencyEnabled ? "bg-transparent" : "bg-app-bg")}>
                <p>Select a connection to view terminals</p>
            </div>
        );
    }

    return (
        <div className={cn("flex flex-col h-full", terminalTransparencyEnabled ? "bg-transparent" : "bg-app-bg")}>
            {/* Tab Bar for Terminals - Conditionally Hidden */}
            {!hideTabs && (
                <div className="flex items-center w-full bg-app-panel border-b border-app-border px-1 h-8 shrink-0 overflow-x-auto scrollbar-hide gap-1">
                    <div className="flex-1 flex overflow-x-auto scrollbar-hide h-full items-center gap-1">
                        {tabs.map(tab => (
                            <div
                                key={tab.id}
                                onClick={() => activeConnectionId && setActiveTerminal(activeConnectionId, tab.id)}

                                className={cn(
                                    "flex items-center gap-1.5 px-2 py-0.5 h-6 text-[11px] font-medium rounded-sm transition-all cursor-pointer min-w-[80px] max-w-[160px] group select-none shrink-0 border",
                                    activeTabId === tab.id
                                        ? "bg-app-surface border-app-border/50 text-app-text shadow-sm"
                                        : "bg-transparent border-transparent text-app-muted hover:bg-app-surface/50 hover:text-app-text"
                                )}
                            >
                                <TerminalIcon size={11} className={cn(activeTabId === tab.id ? "text-app-accent" : "text-app-muted group-hover:text-app-text opacity-70 group-hover:opacity-100")} />
                                <span className="truncate flex-1">{tab.title}</span>
                                <button
                                    onClick={(e) => handleCloseTab(tab.id, e)}
                                    className="opacity-0 group-hover:opacity-100 hover:bg-app-bg p-0.5 rounded text-app-muted hover:text-red-400 transition-all"
                                >
                                    <X size={10} />
                                </button>
                            </div>
                        ))}
                    </div>

                    <button
                        onClick={handleNewTab}
                        className="h-6 w-6 flex items-center justify-center rounded text-app-muted hover:text-white hover:bg-app-surface transition-colors"
                        title="New Terminal Tab"
                    >
                        <Plus size={14} />
                    </button>
                </div>
            )}

            {/* Terminal Content Area */}
            <div ref={terminalContentRef} className={cn("flex-1 overflow-hidden relative", terminalTransparencyEnabled ? "bg-transparent" : "bg-app-bg")}>
                <AiCommandBar connectionId={activeConnectionId} activeTermId={activeTabId} constraintRef={terminalContentRef} />
                {tabs.length === 0 ? (
                    <div className={cn("h-full flex flex-col items-center justify-center text-app-muted", terminalTransparencyEnabled ? "bg-transparent" : "bg-app-bg")}>
                        <TerminalIcon size={48} className="mb-4 opacity-20" />
                        <p>No active terminals</p>
                        <button onClick={handleNewTab} className="mt-4 text-app-accent hover:underline">Open New Terminal</button>
                    </div>
                ) : (
                    tabs.map(tab => (
                        <div
                            key={tab.id}
                            className={cn("absolute inset-0", activeTabId === tab.id ? "z-10" : "z-0 invisible")}
                        >
                            {/* We keep the component mounted but use CSS visibility to hide it.
                                This perserves the XTerm state/buffer but stops it from rendering.
                            */}
                            <div className={cn("h-full w-full", activeTabId !== tab.id && "hidden")}>
                                <TerminalComponent
                                    connectionId={activeConnectionId}
                                    termId={tab.id}
                                    // Pass isVisible only if parent said so, AND this internal tab is active
                                    isVisible={(isVisible !== false) && activeTabId === tab.id}
                                />
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
