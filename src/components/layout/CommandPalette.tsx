import { useEffect, useRef, useState, memo } from "react";
import { Command } from "cmdk";
import {
    Settings,
    FileJson,
    Terminal,
    Search,
    RefreshCw,
    Plus,
    Code,
    Network,
    FolderPlus,

    Shield,
    Link2
} from "lucide-react";
import { PublicUrlsLabel } from "../share/PublicUrlsLabel";
import { useAppStore, Connection } from "../../store/useAppStore";
import { useShallow } from 'zustand/react/shallow';
import { usePlugins } from "../../context/PluginContext";
import { clsx } from "clsx";
import { OSIcon } from "../icons/OSIcon";
import { GoogleMarkIcon } from "../icons/providerIcons";
import { useConnectionDisplayLabels } from "../../features/connections/presentation/useConnectionDisplayLabels";
import { getBuiltinThemeChoices } from '../../features/plugins/pluginCommandBridge';

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
    requester?: unknown;
}

/** Global command/search palette with command mode and plugin quick-pick support. */
export function CommandPalette() {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [commandMode, setCommandMode] = useState(false); // true if triggered by Shift+P or ">"

    // Quick Pick State
    const [quickPickMode, setQuickPickMode] = useState(false);
    const [quickPickItems, setQuickPickItems] = useState<QuickPickItem[]>([]);
    const [quickPickOptions, setQuickPickOptions] = useState<{ placeHolder?: string, requestId: string, pluginId: string, requester?: unknown } | null>(null);

    const openRef = useRef(open);
    const quickPickModeRef = useRef(quickPickMode);
    const quickPickOptionsRef = useRef(quickPickOptions);

    useEffect(() => { openRef.current = open; }, [open]);
    useEffect(() => { quickPickModeRef.current = quickPickMode; }, [quickPickMode]);
    useEffect(() => { quickPickOptionsRef.current = quickPickOptions; }, [quickPickOptions]);

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

    const cancelActiveQuickPick = () => {
        if (quickPickModeRef.current) {
            setQuickPickMode(false);
            quickPickModeRef.current = false;
            const currentOptions = quickPickOptionsRef.current;
            setQuickPickOptions(null);
            quickPickOptionsRef.current = null;
            if (currentOptions && currentOptions.pluginId !== 'system') {
                window.dispatchEvent(new CustomEvent('zync:quick-pick-select', {
                    detail: {
                        requestId: currentOptions.requestId,
                        pluginId: currentOptions.pluginId,
                        selectedItem: null,
                        requester: currentOptions.requester,
                    }
                }));
            }
        }
    };

    // Listen for global toggle event
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key.toLowerCase() === 'p' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                cancelActiveQuickPick();
                setOpen(true);
                openRef.current = true;

                if (e.shiftKey) {
                    // Ctrl+Shift+P -> Command Mode
                    setCommandMode(true);
                    setSearch(">"); // Start with >
                } else {
                    // Ctrl+P -> File/History Mode
                    setCommandMode(false);
                    setSearch("");
                }
            } else if (e.key === 'Escape' && openRef.current) {
                setOpen(false);
                openRef.current = false;
                cancelActiveQuickPick();
            }
        };

        const handleQuickPick = (e: CustomEvent<QuickPickDetail>) => {
            cancelActiveQuickPick();
            const { items, options, requestId, pluginId, requester } = e.detail;
            const nextOptions = { ...options, requestId, pluginId, requester };
            setQuickPickItems(items);
            setQuickPickOptions(nextOptions);
            quickPickOptionsRef.current = nextOptions;
            setQuickPickMode(true);
            quickPickModeRef.current = true;
            setOpen(true);
            openRef.current = true;
            setSearch(""); // Clear search for picking
        };

        const handleOpenCommandPalette = (e: Event) => {
            const event = e as CustomEvent<{ commandMode?: boolean }>;
            cancelActiveQuickPick();
            setOpen(true);
            openRef.current = true;
            if (event.detail?.commandMode) {
                setCommandMode(true);
                setSearch('>');
                return;
            }
            setCommandMode(false);
            setSearch('');
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
        openRef.current = false;
        // Defer execution to allow UI to close smoothly first
        requestAnimationFrame(() => {
            command();
        });
    };

    const handleQuickPickSelect = (item: QuickPickItem) => {
        setOpen(false);
        openRef.current = false;
        setQuickPickMode(false);
        quickPickModeRef.current = false;
        const currentOptions = quickPickOptionsRef.current;
        setQuickPickOptions(null);
        quickPickOptionsRef.current = null;
        if (currentOptions) {
            // Handle internal system Quick Picks
            if (currentOptions.pluginId === 'system') {
                if (currentOptions.requestId === 'icon-theme-select') {
                    useAppStore.getState().updateSettings({ iconTheme: item.id });
                } else if (currentOptions.requestId === 'color-theme-select') {
                    useAppStore.getState().updateSettings({ theme: item.id });
                }
                return;
            }

            window.dispatchEvent(new CustomEvent('zync:quick-pick-select', {
                detail: {
                    requestId: currentOptions.requestId,
                    pluginId: currentOptions.pluginId,
                    selectedItem: item,
                    requester: currentOptions.requester,
                }
            }));
        }
    };

    const handleClose = () => {
        setOpen(false);
        openRef.current = false;
        cancelActiveQuickPick();
    };

    if (!open) return null;

    // Filter items based on mode
    // If commandMode is TRUE: Show Plugins, Actions, Tools
    // If commandMode is FALSE: Show Connections (History)

    return (
        <div className="absolute inset-0 z-[10000] flex items-start justify-center pt-[20vh] px-4 pointer-events-auto">
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-black/60 transition-opacity"
                onClick={handleClose}
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
                                            cancelActiveQuickPick();
                                            const themes = [
                                                { label: 'VSCode Icons (Default)', id: 'vscode-icons' },
                                                { label: 'Lucide Minimalist', id: 'lucide' },
                                                ...plugins
                                                    .filter(p => p.manifest.type === 'icon-theme')
                                                    .map(p => ({ label: p.manifest.name, id: p.manifest.id }))
                                            ];

                                            const nextOptions = { 
                                                placeHolder: 'Select Icon Theme', 
                                                requestId: 'icon-theme-select',
                                                pluginId: 'system' 
                                            };
                                            setQuickPickItems(themes);
                                            setQuickPickOptions(nextOptions);
                                            quickPickOptionsRef.current = nextOptions;
                                            setQuickPickMode(true);
                                            quickPickModeRef.current = true;
                                            setSearch("");
                                        }}
                                        className="relative flex cursor-pointer select-none items-center rounded-lg px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-app-accent/20 data-[selected=true]:text-app-accent text-app-text transition-colors group mb-0.5"
                                    >
                                        <Code className="mr-2 h-4 w-4 opacity-70" />
                                        <span>Preferences: Icon Theme</span>
                                        <span className="ml-auto text-[10px] opacity-50 font-mono">system</span>
                                    </Command.Item>

                                    <Command.Item
                                        value="Preferences: Color Theme"
                                        onSelect={() => {
                                            // Stay in the palette; host theme selection must not depend on a plugin Worker.
                                            window.dispatchEvent(new CustomEvent('zync:quick-pick', {
                                                detail: {
                                                    items: getBuiltinThemeChoices(plugins.filter(plugin => plugin.enabled)),
                                                    options: { placeHolder: 'Select Color Theme' },
                                                    requestId: 'color-theme-select',
                                                    pluginId: 'system',
                                                },
                                            }));
                                        }}
                                        className="relative flex cursor-pointer select-none items-center rounded-lg px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-app-accent/20 data-[selected=true]:text-app-accent text-app-text transition-colors group mb-0.5"
                                    >
                                        <Settings className="mr-2 h-4 w-4 opacity-70" />
                                        <span>Preferences: Color Theme</span>
                                        <span className="ml-auto text-[10px] opacity-50 font-mono">system</span>
                                    </Command.Item>

                                    {pluginCommands.filter(cmd => cmd.id !== 'workbench.action.selectTheme').map(cmd => (
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
                                        value="Open settings.json"
                                        onSelect={() => runCommand(() => useAppStore.getState().openSettingsJsonTab())}
                                        className="relative flex cursor-pointer select-none items-center rounded-lg px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-app-accent/20 data-[selected=true]:text-app-accent text-app-text transition-colors group mb-0.5"
                                    >
                                        <FileJson className="mr-2 h-4 w-4 opacity-70" />
                                        <span>Open settings.json</span>
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
                                        value="Public URLs share internet https beta"
                                        onSelect={() => runCommand(() => useAppStore.getState().openPublicUrlsTab())}
                                        className="relative flex cursor-pointer select-none items-center rounded-lg px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-app-accent/20 data-[selected=true]:text-app-accent text-app-text transition-colors group mb-0.5"
                                    >
                                        <Link2 className="mr-2 h-4 w-4 opacity-70" />
                                        <PublicUrlsLabel className="text-sm font-medium" />
                                    </Command.Item>

                                    <Command.Item
                                        value="Local Vault"
                                        onSelect={() => runCommand(() => useAppStore.getState().openVaultTab('local'))}
                                        className="relative flex cursor-pointer select-none items-center rounded-lg px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-app-accent/20 data-[selected=true]:text-app-accent text-app-text transition-colors group mb-0.5"
                                    >
                                        <Shield className="mr-2 h-4 w-4 opacity-70" />
                                        <span>Local Vault</span>
                                    </Command.Item>

                                    <Command.Item
                                        value="Sync & Backup vault google drive"
                                        onSelect={() => runCommand(() => useAppStore.getState().openSyncBackupTab())}
                                        className="relative flex cursor-pointer select-none items-center rounded-lg px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-app-accent/20 data-[selected=true]:text-app-accent text-app-text transition-colors group mb-0.5"
                                    >
                                        <GoogleMarkIcon size={16} variant="mono" className="mr-2 opacity-70" />
                                        <span>Sync & Backup</span>
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
    const { primary, secondary, searchText } = useConnectionDisplayLabels(conn);

    return (
        <Command.Item
            value={searchText}
            onSelect={onSelect}
            className="relative flex cursor-pointer select-none items-center rounded-lg px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-app-accent/20 data-[selected=true]:text-app-accent text-app-text transition-colors group mb-0.5"
        >
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-app-surface border border-app-border mr-2 group-data-[selected=true]:border-app-accent/50 group-data-[selected=true]:bg-app-accent/10">
                <OSIcon icon={conn.icon || 'Server'} className="w-3.5 h-3.5" />
            </div>
            <div className="flex flex-col">
                <span className="font-medium">{primary}</span>
                <span className="text-[10px] text-app-muted/70">{secondary}</span>
            </div>
            {conn.status === 'connected' && (
                <span className="ml-auto text-[10px] bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded animate-pulse">Connected</span>
            )}
        </Command.Item>
    );
});
