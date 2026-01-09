import { useEffect, useState } from "react";
import { Command } from "cmdk";
import {
    Settings,
    Terminal,
    Search,
    RefreshCw,
    Plus
} from "lucide-react";
import { useConnections } from "../../context/ConnectionContext";
import { useSettings } from "../../context/SettingsContext";
import { clsx } from "clsx";
import { OSIcon } from "../icons/OSIcon";

// You can move this to a separate CSS file or use Tailwind directly in the components
// cmdk styling is usually headless, so we need to style it.
// I'll add a style block or use Tailwind classes deep in the structure.

export function CommandPalette() {
    const [open, setOpen] = useState(false);
    const { connections, openTab, openAddConnectionModal } = useConnections();
    const { openSettings } = useSettings();

    // Listen for global toggle event
    useEffect(() => {
        const handleToggle = () => setOpen((o) => !o);
        window.addEventListener('ssh-ui:toggle-command-palette', handleToggle);

        const handleEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && open) setOpen(false);
        };
        if (open) window.addEventListener('keydown', handleEsc, { capture: true });

        return () => {
            window.removeEventListener('ssh-ui:toggle-command-palette', handleToggle);
            window.removeEventListener('keydown', handleEsc, { capture: true });
        };
    }, [open]);

    const runCommand = (command: () => void) => {
        setOpen(false);
        command();
    };

    if (!open) return null;

    return (
        <div className="fixed inset-0 z-[9999] flex items-start justify-center pt-[20vh] px-4">
            {/* Backdrop */}
            <div
                className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
                onClick={() => setOpen(false)}
            />

            <div className="relative w-full max-w-2xl transform transition-all">
                <Command
                    className={clsx(
                        "flex flex-col w-full max-h-[60vh] overflow-hidden rounded-xl border shadow-2xl animate-in fade-in zoom-in-95 duration-200",
                        "bg-app-panel/95 backdrop-blur-xl border-app-border text-app-text"
                    )}
                    loop
                >
                    <div className="flex items-center border-b border-app-border px-4" cmdk-input-wrapper="">
                        <Search className="mr-2 h-5 w-5 shrink-0 opacity-50" />
                        <Command.Input
                            autoFocus
                            placeholder="Type a command or search..."
                            className={clsx(
                                "flex h-14 w-full rounded-md bg-transparent py-3 text-lg outline-none placeholder:text-app-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
                            )}
                        />
                    </div>

                    <Command.List className="overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-track-transparent scrollbar-thumb-app-border/50 p-2">
                        <Command.Empty className="py-6 text-center text-sm text-app-muted">
                            No results found.
                        </Command.Empty>

                        <Command.Group heading="Actions" className="text-xs font-semibold text-app-muted uppercase tracking-wider mb-2 px-2">
                            <Command.Item
                                onSelect={() => runCommand(openAddConnectionModal)}
                                className="relative flex cursor-pointer select-none items-center rounded-lg px-2 py-2.5 text-sm outline-none data-[selected=true]:bg-app-accent/20 data-[selected=true]:text-app-accent text-app-text transition-colors group mb-1"
                            >
                                <Plus className="mr-3 h-5 w-5 opacity-70" />
                                <span>New Connection</span>
                                <span className="ml-auto text-xs opacity-50">Cmd+N</span>
                            </Command.Item>

                            <Command.Item
                                onSelect={() => runCommand(() => openTab('local'))}
                                className="relative flex cursor-pointer select-none items-center rounded-lg px-2 py-2.5 text-sm outline-none data-[selected=true]:bg-app-accent/20 data-[selected=true]:text-app-accent text-app-text transition-colors group mb-1"
                            >
                                <Terminal className="mr-3 h-5 w-5 opacity-70" />
                                <span>Open Local Terminal</span>
                            </Command.Item>

                            <Command.Item
                                onSelect={() => runCommand(openSettings)}
                                className="relative flex cursor-pointer select-none items-center rounded-lg px-2 py-2.5 text-sm outline-none data-[selected=true]:bg-app-accent/20 data-[selected=true]:text-app-accent text-app-text transition-colors group mb-1"
                            >
                                <Settings className="mr-3 h-5 w-5 opacity-70" />
                                <span>Settings</span>
                                <span className="ml-auto text-xs opacity-50">Cmd+,</span>
                            </Command.Item>

                            <Command.Item
                                onSelect={() => runCommand(() => window.location.reload())}
                                className="relative flex cursor-pointer select-none items-center rounded-lg px-2 py-2.5 text-sm outline-none data-[selected=true]:bg-app-accent/20 data-[selected=true]:text-app-accent text-app-text transition-colors group mb-1"
                            >
                                <RefreshCw className="mr-3 h-5 w-5 opacity-70" />
                                <span>Reload Window</span>
                            </Command.Item>
                        </Command.Group>

                        <Command.Group heading="Connections" className="text-xs font-semibold text-app-muted uppercase tracking-wider mb-2 px-2 mt-4">
                            {connections.map((conn) => (
                                <Command.Item
                                    key={conn.id}
                                    onSelect={() => runCommand(() => {
                                        openTab(conn.id);
                                    })}
                                    className="relative flex cursor-pointer select-none items-center rounded-lg px-2 py-2.5 text-sm outline-none data-[selected=true]:bg-app-accent/20 data-[selected=true]:text-app-accent text-app-text transition-colors group mb-1"
                                >
                                    <div className="flex h-8 w-8 items-center justify-center rounded-md bg-app-surface border border-app-border mr-3 group-data-[selected=true]:border-app-accent/50 group-data-[selected=true]:bg-app-accent/10">
                                        <OSIcon icon={conn.icon || 'Server'} className="w-4 h-4" />
                                    </div>
                                    <div className="flex flex-col">
                                        <span className="font-medium">{conn.name || conn.host}</span>
                                        <span className="text-xs text-app-muted/70">{conn.username}@{conn.host}</span>
                                    </div>
                                    {conn.status === 'connected' && (
                                        <span className="ml-auto text-[10px] bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded animate-pulse">Connected</span>
                                    )}
                                </Command.Item>
                            ))}
                        </Command.Group>
                    </Command.List>

                    <div className="border-t border-app-border px-4 py-2 flex items-center justify-between text-xs text-app-muted">
                        <div className="flex gap-2">
                            <span><strong>↑↓</strong> to navigate</span>
                            <span><strong>↵</strong> to select</span>
                        </div>
                    </div>
                </Command>
            </div>
        </div>
    );
}
