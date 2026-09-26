import { lazy, Suspense } from 'react';
import type { SplitFeatureId } from '../../lib/paneLayout';
import { ErrorBoundary } from '../ErrorBoundary';
import { usePlugins } from '../../context/PluginContext';
import { PluginUnavailable } from '../plugins/PluginUnavailable';

const FileManager = lazy(() => import('../FileManager').then((module) => ({ default: module.FileManager })));
const Dashboard = lazy(() => import('../dashboard/Dashboard').then((module) => ({ default: module.Dashboard })));
const TunnelManager = lazy(() => import('../tunnel/TunnelManager').then((module) => ({ default: module.TunnelManager })));
const SnippetsManager = lazy(() => import('../snippets/SnippetsManager').then((module) => ({ default: module.SnippetsManager })));
const PluginPanel = lazy(() => import('../plugins/PluginPanel').then((module) => ({ default: module.PluginPanel })));

function FeaturePaneFallback() {
    return <div className="h-full w-full bg-app-bg" />;
}

export function FeaturePaneBody({
    connectionId,
    featureId,
    pluginId,
    instanceId,
    visible,
}: {
    connectionId: string;
    featureId?: SplitFeatureId;
    pluginId?: string;
    instanceId?: string;
    visible: boolean;
}) {
    const { panels, loaded } = usePlugins();
    const plugin = pluginId ? panels.find((panel) => panel.id === pluginId) : undefined;
    return (
        <Suspense fallback={<FeaturePaneFallback />}>
            {featureId === 'files' && (
                <ErrorBoundary isolate>
                    <FileManager connectionId={connectionId} surface="pane" instanceId={instanceId} active={visible} />
                </ErrorBoundary>
            )}
            {featureId === 'dashboard' && (
                <Dashboard connectionId={connectionId} isVisible={visible} />
            )}
            {featureId === 'port-forwarding' && (
                <TunnelManager connectionId={connectionId} />
            )}
            {featureId === 'snippets' && (
                <SnippetsManager connectionId={connectionId} />
            )}
            {plugin && (
                <PluginPanel
                    html={plugin.html}
                    panelId={plugin.id}
                    pluginId={plugin.pluginId}
                    connectionId={connectionId}
                    legacyAccess={plugin.legacyAccess}
                    paneInstanceId={instanceId ?? `plugin:${plugin.id}`}
                />
            )}
            {pluginId && !plugin && (loaded ? <PluginUnavailable panelId={pluginId} /> : <FeaturePaneFallback />)}
        </Suspense>
    );
}
