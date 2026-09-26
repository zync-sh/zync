import { useState } from 'react';
import { usePlugins } from '../../context/PluginContext';

export function PluginUnavailable({ panelId }: { panelId?: string }) {
    const { plugins, runtimeHealth, retryPluginRuntime } = usePlugins();
    const [retrying, setRetrying] = useState(false);
    const [retryFailed, setRetryFailed] = useState(false);
    const plugin = plugins.find(item => item.manifest.contributes?.paneKinds?.some(pane => `${item.manifest.id}:${pane.id}` === panelId));
    const health = runtimeHealth.find(item => item.pluginId === plugin?.manifest.id);
    const starting = health?.status === 'starting';
    const canRetry = Boolean(plugin?.enabled && health?.status !== 'safe-mode' && !starting);
    const description = health?.status === 'disabled' || plugin?.enabled === false
        ? 'This plugin is disabled. Enable it in Settings → Plugins.'
        : health?.status === 'safe-mode'
            ? 'Safe mode has stopped this plugin. Review its status in Settings → Plugins.'
            : health?.status === 'quarantined'
                ? 'Repeated failures stopped this plugin. You can explicitly retry after reviewing the error.'
                : starting ? 'The plugin is starting. This pane will return when registration completes.'
                    : 'The plugin has not registered this pane. Its workspace position is preserved.';
    return (
        <div className="flex h-full w-full items-center justify-center bg-app-bg px-6 text-center">
            <div className="max-w-sm space-y-2">
                <p className="text-sm font-medium text-app-text">{starting ? 'Starting plugin…' : `${plugin?.manifest.name ?? 'Plugin'} pane unavailable`}</p>
                <p className="text-xs text-app-muted">
                    {description}
                </p>
                {health?.lastError && <p className="break-words text-xs text-app-muted">{health.lastError}</p>}
                {canRetry && <button type="button" disabled={retrying} className="rounded-md border border-app-border px-3 py-1.5 text-xs text-app-text" onClick={async () => {
                    if (!plugin || retrying) return;
                    setRetrying(true);
                    setRetryFailed(false);
                    try { setRetryFailed(!await retryPluginRuntime(plugin.manifest.id)); }
                    finally { setRetrying(false); }
                }}>{retrying ? 'Retrying…' : 'Retry plugin runtime'}</button>}
                {retryFailed && <p role="status" className="text-xs text-app-muted">Retry failed. Review the plugin in Settings → Plugins.</p>}
            </div>
        </div>
    );
}
