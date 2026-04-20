import { Play, RefreshCw } from 'lucide-react';
import { clsx } from 'clsx';
import type { ReactNode } from 'react';

export type PluginTab = 'installed' | 'marketplace' | 'developer';

interface PluginsTabProps {
    pluginTab: PluginTab;
    setPluginTab: (tab: PluginTab) => void;
    needsRestart: boolean;
    onRestartNow: () => void;
    content: ReactNode;
}

const PLUGIN_TABS: Array<{ key: PluginTab; label: string }> = [
    { key: 'installed', label: 'Installed' },
    { key: 'marketplace', label: 'Marketplace' },
    { key: 'developer', label: 'Developer' },
];

export function PluginsTab({
    pluginTab,
    setPluginTab,
    needsRestart,
    onRestartNow,
    content
}: PluginsTabProps) {
    return (
        <div className="h-full flex flex-col space-y-4 animate-in fade-in duration-300 overflow-hidden">
            <div className="mx-0 shrink-0">
                <div
                    className="flex bg-[var(--color-app-surface)]/50 p-1 rounded-lg border border-[var(--color-app-border)]/50"
                    role="tablist"
                    aria-label="Plugin sections"
                >
                    {PLUGIN_TABS.map((tab) => (
                        <button
                            key={tab.key}
                            id={`plugins-tab-${tab.key}`}
                            role="tab"
                            aria-selected={pluginTab === tab.key}
                            aria-controls={`plugins-panel-${tab.key}`}
                            onClick={() => setPluginTab(tab.key)}
                            className={clsx(
                                "flex-1 py-1.5 text-xs font-medium rounded-md transition-all",
                                pluginTab === tab.key
                                    ? "bg-[var(--color-app-accent)] text-white shadow-sm"
                                    : "text-[var(--color-app-muted)] hover:text-[var(--color-app-text)] hover:bg-[var(--color-app-surface)]"
                            )}
                            type="button"
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>
            </div>

            {needsRestart && (
                <div className="mx-6 p-2.5 rounded-lg bg-[var(--color-app-accent)]/10 border border-[var(--color-app-accent)]/20 flex items-center justify-between animate-in slide-in-from-top-2">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-[var(--color-app-accent)]/20 flex items-center justify-center text-[var(--color-app-accent)]">
                            <RefreshCw size={14} className="animate-spin-slow" />
                        </div>
                        <div>
                            <p className="text-[11px] font-semibold text-[var(--color-app-text)]">Restart Required</p>
                            <p className="text-[10px] text-[var(--color-app-muted)]">Changes will take effect after a restart.</p>
                        </div>
                    </div>
                    <button
                        onClick={onRestartNow}
                        className="px-3 py-1.5 rounded-md bg-[var(--color-app-accent)] text-white text-[10px] font-medium hover:opacity-90 transition-all flex items-center gap-1.5 shadow-sm"
                    >
                        <Play size={10} />
                        Restart Now
                    </button>
                </div>
            )}

            <div
                className="flex-1 overflow-y-auto px-0 pb-1 scrollbar-hide"
                role="tabpanel"
                id={`plugins-panel-${pluginTab}`}
                aria-labelledby={`plugins-tab-${pluginTab}`}
            >
                {content}
            </div>
        </div>
    );
}
