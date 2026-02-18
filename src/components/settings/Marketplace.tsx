import { useState, useEffect } from 'react';
import { Search, Download, Trash2, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { usePlugins } from '../../context/PluginContext';
import { ipcRenderer } from '../../lib/tauri-ipc';

// Registry Data Type
interface RegistryPlugin {
    id: string;
    name: string;
    version: string;
    description: string;
    author: string;
    downloadUrl: string;
    thumbnailUrl?: string; // Optional
    mode?: 'dark' | 'light';
    type?: 'theme' | 'tool';
}

// Registry URL (Make this configurable later)
const REGISTRY_URL = "https://raw.githubusercontent.com/gajendraxdev/zync-extensions/main/marketplace.json";

export function Marketplace() {
    const { plugins: installedPlugins } = usePlugins();
    const [registry, setRegistry] = useState<RegistryPlugin[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [installingId, setInstallingId] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetchRegistry();
    }, []);

    const fetchRegistry = async () => {
        setIsLoading(true);
        setError(null);
        try {
            // Try fetching from real URL
            const res = await fetch(REGISTRY_URL);
            if (!res.ok) throw new Error('Failed to fetch registry');
            const data = await res.json();
            setRegistry(data.plugins || []);
        } catch (err) {
            console.error(err);
            // If fetch fails, we just show empty list since mock is empty now
            // But we might want to show the error to the user so they know to check their connection/URL
            setError("Failed to load marketplace registry.");
            setRegistry([]);
        } finally {
            setIsLoading(false);
        }
    };

    const handleInstall = async (plugin: RegistryPlugin) => {
        setInstallingId(plugin.id);
        try {
            // 1. Install via Backend
            // We use the downloadUrl. If it's a mock URL, this will fail in the backend unless we mock that too.
            // For the mock "Oceanic", let's assume it might fail if the URL isn't real.
            // But the flow is correct.
            await ipcRenderer.invoke('plugins_install', { url: plugin.downloadUrl });

            // 2. Reload Plugins locally (Backend doesn't auto-reload yet, or maybe it does?)
            // We should trigger a reload.
            await ipcRenderer.invoke('plugins:load'); // Trigger backend scan

            // 3. Notify
            // (Ideally reload happens automatically via event, but we can force it)
            window.location.reload(); // Simple way to reload context for now, or assume PluginContext updates? 
            // PluginContext listens to 'plugins:load' only on mount. We might need a 'refresh' method.
            // For now, let's just reload the window or ask user to reload.
        } catch (err: any) {
            console.error(err);
            alert(`Failed to install: ${err.message || err}`);
        } finally {
            setInstallingId(null);
        }
    };

    const handleUninstall = async (id: string) => {
        if (!confirm("Are you sure you want to uninstall this plugin?")) return;
        setInstallingId(id); // Use same loading state
        try {
            await ipcRenderer.invoke('plugins_uninstall', { id });
            window.location.reload(); // Refresh to update list
        } catch (err: any) {
            console.error(err);
            alert(`Failed to uninstall: ${err.message || err}`);
        } finally {
            setInstallingId(null);
        }
    };

    const isInstalled = (id: string) => {
        return installedPlugins.some(p => p.manifest.id === id);
    };

    const filteredPlugins = registry.filter(p =>
        p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.description.toLowerCase().includes(searchQuery.toLowerCase())
    );

    return (
        <div className="flex flex-col h-full bg-[var(--color-app-bg)] text-[var(--color-app-text)]">
            {/* Header / Search */}
            <div className="p-4 border-b border-[var(--color-app-border)] flex items-center gap-3">
                <Search className="w-4 h-4 text-[var(--color-app-muted)]" />
                <input
                    type="text"
                    placeholder="Search plugins & themes..."
                    className="bg-transparent border-none outline-none flex-1 placeholder-[var(--color-app-muted)] text-sm"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                />
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {isLoading ? (
                    <div className="flex items-center justify-center h-full text-[var(--color-app-muted)] gap-2">
                        <Loader2 className="w-5 h-5 animate-spin" />
                        <span>Loading registry...</span>
                    </div>
                ) : error ? (
                    <div className="text-red-500 text-center py-8">{error}</div>
                ) : (
                    filteredPlugins.map(plugin => {
                        const installed = isInstalled(plugin.id);
                        const processing = installingId === plugin.id;

                        return (
                            <div
                                key={plugin.id}
                                className={clsx(
                                    "p-4 rounded-lg flex gap-4 border transition-colors",
                                    "border-[var(--color-app-border)] hover:bg-[var(--color-app-surface)]"
                                )}
                            >
                                {/* Thumbnail / Icon */}
                                <div className="w-16 h-16 rounded bg-[var(--color-app-surface)] flex items-center justify-center shrink-0 border border-[var(--color-app-border)] overflow-hidden">
                                    {plugin.thumbnailUrl ? (
                                        <img src={plugin.thumbnailUrl} alt={plugin.name} className="w-full h-full object-cover" />
                                    ) : (
                                        <div className="text-[var(--color-app-muted)] text-xs font-mono">
                                            {plugin.type === 'theme' ? 'THEME' : 'PLUGIN'}
                                        </div>
                                    )}
                                </div>

                                {/* Details */}
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-start justify-between">
                                        <div>
                                            <h3 className="font-medium text-sm text-[var(--color-app-text)]">{plugin.name}</h3>
                                            <p className="text-xs text-[var(--color-app-muted)] mt-0.5">v{plugin.version} • by {plugin.author}</p>
                                        </div>
                                        {/* Action Button */}
                                        {installed ? (
                                            <button
                                                onClick={() => handleUninstall(plugin.id)}
                                                disabled={processing}
                                                className={clsx(
                                                    "px-3 py-1.5 rounded text-xs font-medium flex items-center gap-1.5 transition-colors",
                                                    "bg-[var(--color-app-surface)] hover:bg-red-500/10 hover:text-red-500 text-[var(--color-app-muted)]",
                                                    processing && "opacity-50 cursor-not-allowed"
                                                )}
                                            >
                                                {processing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                                                Uninstall
                                            </button>
                                        ) : (
                                            <button
                                                onClick={() => handleInstall(plugin)}
                                                disabled={processing}
                                                className={clsx(
                                                    "px-3 py-1.5 rounded text-xs font-medium flex items-center gap-1.5 transition-colors",
                                                    "bg-[var(--color-app-accent)] text-white hover:opacity-90",
                                                    processing && "opacity-50 cursor-not-allowed"
                                                )}
                                            >
                                                {processing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                                                Install
                                            </button>
                                        )}
                                    </div>
                                    <p className="text-xs text-[var(--color-app-muted)] mt-2 line-clamp-2">
                                        {plugin.description}
                                    </p>
                                </div>
                            </div>
                        );
                    })
                )}

                {!isLoading && filteredPlugins.length === 0 && (
                    <div className="text-center py-12 text-[var(--color-app-muted)]">
                        <p>No results found for "{searchQuery}"</p>
                    </div>
                )}
            </div>

            {/* Footer */}
            <div className="p-3 border-t border-[var(--color-app-border)] text-[10px] text-[var(--color-app-muted)] flex justify-between">
                <span>Registry: GitHub (Static)</span>
                {/* <button className="hover:text-[var(--color-app-text)] flex items-center gap-1">
                    <GitBranch className="w-3 h-3" />
                    Submit Plugin
                </button> */}
            </div>
        </div>
    );
}
