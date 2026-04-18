import { useEffect, useRef, useState, memo } from "react";
import { Command } from "cmdk";
import {
    Settings,
    Terminal,
    Search,
    RefreshCw,
    Plus,
    Code,
    Network,
    FolderPlus
} from "lucide-react";
import { useAppStore, Connection } from "../../store/useAppStore";
import { useShallow } from 'zustand/react/shallow';
import { usePlugins } from "../../context/PluginContext";
import { clsx } from "clsx";
import { OSIcon } from "../icons/OSIcon";

interface QuickPickItem {
    id: string;
    label: string;
    description?: string;
    detail?: string;
    kind?: 'item' | 'separator' | 'group';
}

interface QuickPickDetail {
    items: QuickPickItem[];
    options: {
        placeHolder?: string;
        requestId: string;
        pluginId: string;
    };
    requestId: string;
    pluginId: string;
}

/** Global command/search palette with command mode and plugin quick-pick support. */
export function CommandPalette() {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [commandMode, setCommandMode] = useState(false); // true if triggered by Shift+P or ">"

    // Quick Pick State
    const [quickPickMode, setQuickPickMode] = useState(false);
    const [quickPickItems, setQuickPickItems] = useState<QuickPickItem[]>([]);
    const [quickPickOptions, setQuickPickOptions] = useState<{ placeHolder?: string, requestId: string, pluginId: string } | null>(null);

    const openRef = useRef(open);
    const quickPickModeRef = useRef(quickPickMode);

    useEffect(() => { openRef.current = open; }, [open]);
    useEffect(() => { quickPickModeRef.current = quickPickMode; }, [quickPickMode]);

    // Optimize selectors with shallow comparison
    const { connections, setAddConnectionModalOpen, openTab, openSettings } = useAppStore(
        useShallow(state => ({
            connections: state.connections,
            setAddConnectionModalOpen: state.setAddConnectionModalOpen,
            openTab: state.openTab,
            openSettings: state.openSettings
        }))
    );

    // Plugins
    const { commands: pluginCommands, executeCommand, plugins } = usePlugins();
    const platform = typeof navigator !== 'undefined'
        ? ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.userAgent)
        : '';
    const isMac = /mac/i.test(platform);
    const modKey = isMac ? 'Cmd' : 'Ctrl';

    const openAddConnectionModal = () => setAddConnectionModalOpen(true);

    // Listen for global toggle event
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key.toLowerCase() === 'p' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                setOpen(true);

                if (e.shiftKey) {
                    // Ctrl+Shift+P -> Command Mode
                    setCommandMode(true);
                    setSearch(">"); // Start with >
                    setQuickPickMode(false); // Reset QP
                } else {
                    // Ctrl+P -> File/History Mode
                    setCommandMode(false);
                    setSearch("");
                    setQuickPickMode(false); // Reset QP
                }
            } else if (e.key === 'Escape' && openRef.current) {
                setOpen(false);
                if (quickPickModeRef.current) {
                    // If cancelling QP, maybe we should just close it?
                    // Or notify cancellation? For MVP, just close.
                    setQuickPickMode(false);
                }
            }
        };

        const handleQuickPick = (e: CustomEvent<QuickPickDetail>) => {
            const { items, options, requestId, pluginId } = e.detail;
            setQuickPickItems(items);
            setQuickPickOptions({ ...options, requestId, pluginId });
            setQuickPickMode(true);
            setOpen(true);
            setSearch(""); // Clear search for picking
        };

        const handleOpenCommandPalette = (e: Event) => {
            const event = e as CustomEvent<{ commandMode?: boolean }>;
            setOpen(true);
            if (event.detail?.commandMode) {
                setCommandMode(true);
                setSearch('>');
                setQuickPickMode(false);
                return;
            }
            setCommandMode(false);
            setSearch('');
            setQuickPickMode(false);
        };

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('zync:quick-pick', handleQuickPick as EventListener);
        window.addEventListener('zync:open-command-palette', handleOpenCommandPalette);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('zync:quick-pick', handleQuickPick as EventListener);
            window.removeEventListener('zync:open-command-palette', handleOpenCommandPalette);
        };
    }, []);

    // Detect ">" in input
    const handleSearchChange = (value: string) => {
        setSearch(value);
        if (value.startsWith(">")) {
            setCommandMode(true);
        } else {
            setCommandMode(false);
        }
    };

    const runCommand = (command: () => void) => {
        setOpen(false);
        // Defer execution to allow UI to close smoothly first
        requestAnimationFrame(() => {
            command();
        });
    };

    const handleQuickPickSelect = (item: QuickPickItem) => {
        setOpen(false);
        setQuickPickMode(false);
        if (quickPickOptions) {
            // Handle internal system Quick Picks
            if (quickPickOptions.pluginId === 'system') {
                if (quickPickOptions.requestId === 'icon-theme-select') {
                    useAppStore.getState().updateSettings({ iconTheme: item.id });
                }
                return;
            }

            window.dispatchEvent(new CustomEvent('zync:quick-pick-select', {
                detail: {
                    requestId: quickPickOptions.requestId,
                    pluginId: quickPickOptions.pluginId,
                    selectedItem: item
                }
            }));
        }
    };

    if (!open) return null;

    // Filter items based on mode
    // If commandMode is TRUE: Show Plugins, Actions, Tools
    // If commandMode is FALSE: Show Connections (History)

    return (
        <div className="absolute inset-0 z-[10000] flex items-start justify-center pt-[20vh] px-4 pointer-events-auto">
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
                onClick={() => setOpen(false)}
            />

            <div className="relative w-full max-w-2xl transform transition-all">
                <Command
                    className={clsx(
                        "flex flex-col w-full max-h-[60vh] overflow-hidden rounded-xl border shadow-2xl animate-in fade-in zoom-in-95 duration-200",
                        "bg-app-panel/95 backdrop-blur-lg border-app-border text-app-text"
                    )}
                    loop
                    filter={(value, search) => {
                        const q = search.startsWith('>') ? search.substring(1).trim() : search;
                        if (!q) return 1;
                        return value.toLowerCase().includes(q.toLowerCase()) ? 1 : 0;
                    }}
                >
                    <div className="flex items-center border-b border-app-border px-3" cmdk-input-wrapper="">
                        <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
                        <Command.Input
                            autoFocus
                            value={search}
                            onValueChange={handleSearchChange}
                            placeholder="Type a command or search..."
                            className={clsx(
                                "flex h-10 w-full rounded-md bg-transparent py-2 text-sm outline-none placeholder:text-app-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
                            )}
                        />
                    </div>

                    <Command.List className="overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-track-transparent scrollbar-thumb-app-border/50 p-1.5 results-container">
                        <Command.Empty className="py-6 text-center text-sm text-app-muted">
                            No results found.
                        </Command.Empty>

                        {/* QUICK PICK MODE */}
                        {quickPickMode && (
                            <Command.Group heading={quickPickOptions?.placeHolder || "Select an option"} className="text-[10px] font-semibold text-app-muted uppercase tracking-wider mb-1 px-2">
                                {quickPickItems.map((item: QuickPickItem, idx) => {
                                    if (item.kind === 'separator') {
                                        return <div key={item.id ?? idx} className="h-px bg-app-border/30 my-1.5 mx-2" />;
                                    }
                                    return (
                                        <Command.Item
                                            key={item.id ?? idx}
                                            value={item.label}
                                            onSelect={() => handleQuickPickSelect(item)}
                                            className="relative flex cursor-pointer select-none items-center rounded-lg px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-app-accent/20 data-[selected=true]:text-app-accent text-app-text transition-colors group mb-0.5"
                                        >
                                            <div className="flex flex-col">
                                                <span>{item.label}</span>
                                            </div>
                                        </Command.Item>
                                    );
                                })}
                            </Command.Group>
                        )}

                        {/* COMMAND MODE ITEMS (Plugins, Actions, Tools) */}
                        {commandMode && !quickPickMode && (
                            <>
                                {/* Plugin Commands */}
                                <Command.Group heading="Plugins" className="text-[10px] font-semibold text-app-muted uppercase tracking-wider mb-1 px-2">
                                    <Command.Item
                                        value="Preferences: Icon Theme"
                                        onSelect={() => {
                                            const themes = [
                                                { label: 'VSCode Icons (Default)', id: 'vscode-icons' },
                                                { label: 'Lucide Minimalist', id: 'lucide' },
                                                ...plugins
                                                    .filter(p => p.manifest.type === 'icon-theme')
                                                    .map(p => ({ label: p.manifest.name, id: p.manifest.id }))
                                            ];

                                            setQuickPickItems(themes);
                                            setQuickPickOptions({ 
                                                placeHolder: 'Select Icon Theme', 
                                                requestId: 'icon-theme-select',
                                                pluginId: 'system' 
                                            });
                                            setQuickPickMode(true);
                                            setSearch("");
                                        }}
                                        className="relative flex cursor-pointer select-none items-center rounded-lg px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-app-accent/20 data-[selected=true]:text-app-accent text-app-text transition-colors group mb-0.5"
                                    >
                                        <Code className="mr-2 h-4 w-4 opacity-70" />
                                        <span>Preferences: Icon Theme</span>
                                        <span className="ml-auto text-[10px] opacity-50 font-mono">system</span>
                                    </Command.Item>

                                    {pluginCommands.map(cmd => (
                                        <Command.Item
                                            key={cmd.id}
                                            value={cmd.title}
                                            onSelect={() => runCommand(() => executeCommand(cmd.id))}
                                            className="relative flex cursor-pointer select-none items-center rounded-lg px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-app-accent/20 data-[selected=true]:text-app-accent text-app-text transition-colors group mb-0.5"
                                        >
                                            <Code className="mr-2 h-4 w-4 opacity-70" />
                                            <span>{cmd.title}</span>
                                            <span className="ml-auto text-[10px] opacity-50 font-mono">{cmd.pluginId.split('.').pop()}</span>
                                        </Command.Item>
                                    ))}
                                </Command.Group>

                                <Command.Group heading="Actions" className="text-[10px] font-semibold text-app-muted uppercase tracking-wider mb-1 px-2 mt-2">
                                    <Command.Item
                                        value="New Connection"
                                        onSelect={() => runCommand(openAddConnectionModal)}
                                        className="relative flex cursor-pointer select-none items-center rounded-lg px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-app-accent/20 data-[selected=true]:text-app-accent text-app-text transition-colors group mb-0.5"
                                    >
                                        <Plus className="mr-2 h-4 w-4 opacity-70" />
                                        <span>New Connection</span>
                                        <span className="ml-auto text-[10px] opacity-50">{`${modKey}+N`}</span>
                                    </Command.Item>

                                    <Command.Item
                                        value="Open Local Terminal"
                                        onSelect={() => runCommand(() => openTab('local'))}
                                        className="relative flex cursor-pointer select-none items-center rounded-lg px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-app-accent/20 data-[selected=true]:text-app-accent text-app-text transition-colors group mb-0.5"
                                    >
                                        <Terminal className="mr-2 h-4 w-4 opacity-70" />
                                        <span>Open Local Terminal</span>
                                    </Command.Item>

                                    <Command.Item
                                        value="Settings"
                                        onSelect={() => runCommand(openSettings)}
                                        className="relative flex cursor-pointer select-none items-center rounded-lg px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-app-accent/20 data-[selected=true]:text-app-accent text-app-text transition-colors group mb-0.5"
                                    >
                                        <Settings className="mr-2 h-4 w-4 opacity-70" />
                                        <span>Settings</span>
                                        <span className="ml-auto text-[10px] opacity-50">{`${modKey}+,`}</span>
                                    </Command.Item>


                                    <Command.Item
                                        value="Reload Window"
                                        onSelect={() => runCommand(() => window.location.reload())}
                                        className="relative flex cursor-pointer select-none items-center rounded-lg px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-app-accent/20 data-[selected=true]:text-app-accent text-app-text transition-colors group mb-0.5"
                                    >
                                        <RefreshCw className="mr-2 h-4 w-4 opacity-70" />
                                        <span>Reload Window</span>
                                    </Command.Item>
                                </Command.Group>

                                <Command.Group heading="Tools" className="text-[10px] font-semibold text-app-muted uppercase tracking-wider mb-1 px-2 mt-2">
                                    <Command.Item
                                        value="Port Forwarding"
                                        onSelect={() => runCommand(() => useAppStore.getState().openPortForwardingTab())}
                                        className="relative flex cursor-pointer select-none items-center rounded-lg px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-app-accent/20 data-[selected=true]:text-app-accent text-app-text transition-colors group mb-0.5"
                                    >
                                        <Network className="mr-2 h-4 w-4 opacity-70" />
                                        <span>Port Forwarding</span>
                                    </Command.Item>

                                    <Command.Item
                                        value="Global Snippets"
                                        onSelect={() => runCommand(() => useAppStore.getState().openSnippetsTab())}
                                        className="relative flex cursor-pointer select-none items-center rounded-lg px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-app-accent/20 data-[selected=true]:text-app-accent text-app-text transition-colors group mb-0.5"
                                    >
                                        <Code className="mr-2 h-4 w-4 opacity-70" />
                                        <span>Global Snippets</span>
                                    </Command.Item>

                                    <Command.Item
                                        value="New Forward"
                                        onSelect={() => runCommand(() => window.dispatchEvent(new Event('ssh-ui:open-new-tunnel')))}
                                        className="relative flex cursor-pointer select-none items-center rounded-lg px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-app-accent/20 data-[selected=true]:text-app-accent text-app-text transition-colors group mb-0.5"
                                    >
                                        <Plus className="mr-2 h-4 w-4 opacity-70" />
                                        <span>New Forward</span>
                                    </Command.Item>

                                    <Command.Item
                                        value="New Folder"
                                        onSelect={() => runCommand(() => window.dispatchEvent(new Event('ssh-ui:open-folder-modal')))}
                                        className="relative flex cursor-pointer select-none items-center rounded-lg px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-app-accent/20 data-[selected=true]:text-app-accent text-app-text transition-colors group mb-0.5"
                                    >
                                        <FolderPlus className="mr-2 h-4 w-4 opacity-70" />
                                        <span>New Folder</span>
                                    </Command.Item>
                                </Command.Group>
                            </>
                        )}

                        {/* FILE MODE */}
                        {!commandMode && !quickPickMode && (
                            <Command.Group heading="Connections" className="text-[10px] font-semibold text-app-muted uppercase tracking-wider mb-1 px-2 mt-2">
                                {connections.map((conn: Connection) => (
                                    <ConnectionItem
                                        key={conn.id}
                                        conn={conn}
                                        onSelect={() => runCommand(() => openTab(conn.id))}
                                    />
                                ))}
                            </Command.Group>
                        )}
                    </Command.List>

                    <div className="border-t border-app-border px-3 py-1.5 flex items-center justify-between text-[10px] text-app-muted">
                        <div className="flex gap-2">
                            <span><strong>↑↓</strong> to navigate</span>
                            <span><strong>↵</strong> to select</span>
                        </div>
                        <div className="flex gap-2 opacity-50">
                            {commandMode ? (
                                <span>Type to search commands</span>
                            ) : (
                                <span>Type <strong>{'>'}</strong> for commands</span>
                            )}
                        </div>
                    </div>
                </Command>
            </div>
        </div>
    );
}


/** Connection result row for file/history mode inside the command palette. */
const ConnectionItem = memo(function ConnectionItem({ conn, onSelect }: { conn: Connection; onSelect: () => void }) {
    return (
        <Command.Item
            value={`${conn.name} ${conn.username} ${conn.host}`} // Explicit search value
            onSelect={onSelect}
            className="relative flex cursor-pointer select-none items-center rounded-lg px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-app-accent/20 data-[selected=true]:text-app-accent text-app-text transition-colors group mb-0.5"
        >
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-app-surface border border-app-border mr-2 group-data-[selected=true]:border-app-accent/50 group-data-[selected=true]:bg-app-accent/10">
                <OSIcon icon={conn.icon || 'Server'} className="w-3.5 h-3.5" />
            </div>
            <div className="flex flex-col">
                <span className="font-medium">{conn.name || conn.host}</span>
                <span className="text-[10px] text-app-muted/70">{conn.username}@{conn.host}</span>
            </div>
            {conn.status === 'connected' && (
                <span className="ml-auto text-[10px] bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded animate-pulse">Connected</span>
            )}
        </Command.Item>
    );
});
