import type { ComponentType, Dispatch, SetStateAction } from 'react';
import { Info, Monitor, MoreVertical, Package, Pause, Play, RefreshCw, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import type { RegistryPlugin } from '../../hooks/useSettingsPlugins';
import type { IconResolverProps } from '../../common/IconResolver';
import { getPluginCategory, getPluginCategoryLabel } from '../../../editor/providers';

interface PluginManifest {
    id: string;
    name: string;
    version: string;
    icon?: string;
    type?: string;
}

interface InstalledPlugin {
    manifest: PluginManifest;
    enabled: boolean;
    path: string;
}

interface PluginsInstalledTabProps {
    plugins: InstalledPlugin[];
    registry: RegistryPlugin[];
    isLoadingPlugins: boolean;
    processingId: string | null;
    activeMenu: string | null;
    setActiveMenu: Dispatch<SetStateAction<string | null>>;
    executeCommand: (commandId: string) => Promise<unknown> | unknown;
    onClose: () => void;
    onTogglePlugin: (id: string, enabled: boolean) => Promise<void>;
    onUpdatePlugin: (plugin: RegistryPlugin) => Promise<void>;
    onUninstallPlugin: (id: string) => Promise<void>;
    iconThemeCount: number;
    iconRenderer: ComponentType<IconResolverProps>;
}

function compareSemver(a: string, b: string): number {
    const normalize = (value: string) => value.replace(/^v/i, '').trim().replace(/\+.*/, '');
    const splitCorePre = (value: string) => {
        const normalized = normalize(value);
        const dashIndex = normalized.indexOf('-');
        if (dashIndex < 0) return { core: normalized, pre: '' };
        return {
            core: normalized.slice(0, dashIndex),
            pre: normalized.slice(dashIndex + 1),
        };
    };
    const { core: aCore, pre: aPre } = splitCorePre(a);
    const { core: bCore, pre: bPre } = splitCorePre(b);
    const aParts = aCore.split('.').map((part) => Number.parseInt(part, 10));
    const bParts = bCore.split('.').map((part) => Number.parseInt(part, 10));
    const length = Math.max(aParts.length, bParts.length);

    for (let i = 0; i < length; i++) {
        const left = Number.isFinite(aParts[i]) ? aParts[i] : 0;
        const right = Number.isFinite(bParts[i]) ? bParts[i] : 0;
        if (left > right) return 1;
        if (left < right) return -1;
    }

    if (!aPre && !bPre) return 0;
    if (!aPre) return 1;
    if (!bPre) return -1;
    return aPre.localeCompare(bPre, undefined, { numeric: true, sensitivity: 'base' });
}

export function PluginsInstalledTab({
    plugins,
    registry,
    isLoadingPlugins,
    processingId,
    activeMenu,
    setActiveMenu,
    executeCommand,
    onClose,
    onTogglePlugin,
    onUpdatePlugin,
    onUninstallPlugin,
    iconThemeCount,
    iconRenderer: IconRenderer,
}: PluginsInstalledTabProps) {
    const isThemePlugin = (plugin: InstalledPlugin) => (
        plugin.manifest.id !== 'com.zync.theme.manager' && getPluginCategory(plugin.manifest) === 'theme'
    );
    const installedThemes = plugins.filter(
        isThemePlugin
    ).length;
    const installedNonThemePlugins = plugins.filter(
        p => p.manifest.id !== 'com.zync.theme.manager' && !isThemePlugin(p)
    );

    return (
        <div className="space-y-4">
            <div className="flex flex-col gap-3">
                <div className="p-3 bg-[var(--color-app-surface)]/50 rounded-lg border border-[var(--color-app-border)]/50 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="p-1.5 bg-[var(--color-app-bg)] rounded-md border border-[var(--color-app-border)] text-[var(--color-app-accent)]">
                            <Monitor size={16} />
                        </div>
                        <div>
                            <h4 className="text-xs font-medium text-[var(--color-app-text)]">Color Theme</h4>
                            <p className="text-[10px] text-[var(--color-app-muted)]">Select from {installedThemes} themes</p>
                        </div>
                    </div>
                    <button
                        onClick={() => executeCommand('workbench.action.selectTheme')}
                        className="px-3 py-1 bg-[var(--color-app-accent)] hover:bg-[var(--color-app-accent)]/80 text-white rounded text-[10px] font-medium transition-colors"
                    >
                        Select Theme
                    </button>
                </div>

                <div className="p-3 bg-[var(--color-app-surface)]/50 rounded-lg border border-[var(--color-app-border)]/50 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="p-1.5 bg-[var(--color-app-bg)] rounded-md border border-[var(--color-app-border)] text-[var(--color-app-accent)]">
                            <Package size={16} />
                        </div>
                        <div>
                            <h4 className="text-xs font-medium text-[var(--color-app-text)]">Icon Theme</h4>
                            <p className="text-[10px] text-[var(--color-app-muted)]">Select from {iconThemeCount} sets</p>
                        </div>
                    </div>
                    <button
                        onClick={() => {
                            const themes = [
                                { label: 'VSCode Icons (Default)', id: 'vscode-icons' },
                                { label: 'Lucide Minimalist', id: 'lucide' },
                                ...plugins
                                    .filter(p => p.manifest.type === 'icon-theme' && p.enabled !== false)
                                    .map(p => ({ label: p.manifest.name, id: p.manifest.id }))
                            ];

                            window.dispatchEvent(new CustomEvent('zync:quick-pick', {
                                detail: {
                                    items: themes,
                                    options: { placeHolder: 'Select Icon Theme' },
                                    requestId: 'icon-theme-select',
                                    pluginId: 'system'
                                }
                            }));
                            onClose();
                        }}
                        className="px-3 py-1 bg-[var(--color-app-accent)] hover:bg-[var(--color-app-accent)]/80 text-white rounded text-[10px] font-medium transition-colors"
                    >
                        Select Icon Set
                    </button>
                </div>
            </div>

            <div className="h-px bg-[var(--color-app-border)]/20 my-1" />

            <div className="space-y-2">
                {isLoadingPlugins ? (
                    <div className="flex items-center justify-center py-10 text-[var(--color-app-muted)] gap-2">
                        <RefreshCw size={14} className="animate-spin" />
                        <span className="text-xs">Scanning...</span>
                    </div>
                ) : installedNonThemePlugins.length === 0 ? (
                    <div className="p-8 text-center text-[var(--color-app-muted)] bg-[var(--color-app-surface)]/30 rounded-lg border border-[var(--color-app-border)] border-dashed">
                        <p className="text-xs">No plugins installed.</p>
                    </div>
                ) : (
                    installedNonThemePlugins.map((plugin) => {
                        const registryItem = registry.find(r => r.id === plugin.manifest.id);
                        const hasUpdate = Boolean(
                            registryItem
                            && registryItem.version
                            && plugin.manifest.version
                            && compareSemver(registryItem.version, plugin.manifest.version) > 0
                        );
                        const isProcessing = processingId === plugin.manifest.id;
                        const categoryLabel = getPluginCategoryLabel(getPluginCategory(plugin.manifest));

                        return (
                            <div key={plugin.manifest.id} className="group relative flex items-center justify-between p-2.5 bg-[var(--color-app-surface)]/50 rounded-lg border border-[var(--color-app-border)]/50 transition-all hover:border-[var(--color-app-border)]">
                                {activeMenu === plugin.manifest.id && (
                                    <div
                                        className="absolute inset-0 z-40 rounded-lg"
                                        onClick={() => setActiveMenu(null)}
                                    />
                                )}
                                <div className="flex items-start gap-2.5">
                                    <div className="p-1.5 bg-[var(--color-app-bg)] rounded-md border border-[var(--color-app-border)] text-[var(--color-app-accent)] shrink-0 relative z-50">
                                        <IconRenderer name={plugin.manifest.icon} path={plugin.path} size={14} />
                                    </div>
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2">
                                            <h4 className="text-xs font-medium text-[var(--color-app-text)] leading-none truncate max-w-[150px]">{plugin.manifest.name}</h4>
                                            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[var(--color-app-bg)] border border-[var(--color-app-border)] text-[var(--color-app-muted)] shrink-0 uppercase tracking-wide">
                                                {categoryLabel}
                                            </span>
                                            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[var(--color-app-bg)] border border-[var(--color-app-border)] text-[var(--color-app-muted)] shrink-0">
                                                v{plugin.manifest.version}
                                            </span>
                                            {!plugin.enabled && (
                                                <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-500 border border-red-500/20 shrink-0">
                                                    Disabled
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-[10px] text-[var(--color-app-muted)] mt-0.5 font-mono opacity-60 leading-none truncate">
                                            {plugin.manifest.id}
                                        </p>
                                    </div>
                                </div>

                                <div className="flex items-center gap-2">
                                    {hasUpdate && <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />}

                                    <div className="relative">
                                        <button
                                            aria-label={`Open plugin menu for ${plugin.manifest.name}`}
                                            aria-expanded={activeMenu === plugin.manifest.id}
                                            aria-controls={`plugin-menu-${plugin.manifest.id}`}
                                            onClick={() => setActiveMenu(activeMenu === plugin.manifest.id ? null : plugin.manifest.id)}
                                            disabled={isProcessing}
                                            className={clsx(
                                                "p-1.5 rounded-md text-[var(--color-app-muted)] hover:text-[var(--color-app-text)] hover:bg-[var(--color-app-bg)] transition-colors",
                                                activeMenu === plugin.manifest.id && "bg-[var(--color-app-bg)] text-[var(--color-app-text)]",
                                                isProcessing && "opacity-50 cursor-not-allowed"
                                            )}
                                        >
                                            {isProcessing ? <RefreshCw size={14} className="animate-spin" /> : <MoreVertical size={14} />}
                                        </button>

                                        {activeMenu === plugin.manifest.id && (
                                            <div
                                                id={`plugin-menu-${plugin.manifest.id}`}
                                                className="absolute right-0 top-full mt-1 w-40 bg-[var(--color-app-surface)] border border-[var(--color-app-border)] rounded-lg shadow-xl py-1 z-50 animate-in fade-in zoom-in-95 duration-100 origin-top-right"
                                            >
                                                <button
                                                    onClick={() => {
                                                        if (isProcessing) return;
                                                        void onTogglePlugin(plugin.manifest.id, !plugin.enabled);
                                                    }}
                                                    disabled={isProcessing}
                                                    className={clsx(
                                                        "w-full px-3 py-2 text-left text-xs text-[var(--color-app-text)] flex items-center gap-2 transition-colors",
                                                        isProcessing ? "opacity-50 cursor-not-allowed" : "hover:bg-[var(--color-app-bg)]"
                                                    )}
                                                >
                                                    {plugin.enabled ? <Pause size={12} /> : <Play size={12} />}
                                                    {plugin.enabled ? 'Disable' : 'Enable'}
                                                </button>

                                                {hasUpdate && registryItem && (
                                                    <button
                                                        onClick={() => {
                                                            if (isProcessing) return;
                                                            void onUpdatePlugin(registryItem);
                                                        }}
                                                        disabled={isProcessing}
                                                        className={clsx(
                                                            "w-full px-3 py-2 text-left text-xs text-blue-500 flex items-center gap-2 transition-colors",
                                                            isProcessing ? "opacity-50 cursor-not-allowed" : "hover:bg-[var(--color-app-bg)]"
                                                        )}
                                                    >
                                                        <RefreshCw size={12} />
                                                        Update to v{registryItem.version}
                                                    </button>
                                                )}

                                                {!plugin.path.startsWith('builtin://') && (
                                                    <>
                                                        <div className="h-px bg-[var(--color-app-border)]/50 my-1" />
                                                        <button
                                                            onClick={() => {
                                                                if (isProcessing) return;
                                                                void onUninstallPlugin(plugin.manifest.id);
                                                            }}
                                                            disabled={isProcessing}
                                                            className={clsx(
                                                                "w-full px-3 py-2 text-left text-xs text-red-500 flex items-center gap-2 transition-colors",
                                                                isProcessing ? "opacity-50 cursor-not-allowed" : "hover:bg-red-500/10"
                                                            )}
                                                        >
                                                            <Trash2 size={12} />
                                                            Uninstall
                                                        </button>
                                                    </>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        );
                    })
                )}
                <div className="text-[10px] text-[var(--color-app-muted)] pt-2 flex items-center gap-1.5 opacity-70">
                    <Info size={10} />
                    Changes require an app restart.
                </div>
            </div>
        </div>
    );
}
