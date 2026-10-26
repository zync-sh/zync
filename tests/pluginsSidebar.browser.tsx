import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TooltipProvider } from '@radix-ui/react-tooltip';
import { PluginsSidebarContent } from '../src/components/plugins/PluginsSidebarContent';
import { PluginPermissionReview } from '../src/components/settings/tabs/plugins/PluginsDeveloperTab';
import { ConfirmModal } from '../src/components/ui/ConfirmModal';
import { activateGlobalNavigation, type GlobalSidebarSection } from '../src/features/workspace/application/globalNavigation';
import type { InstalledPlugin, PluginInstallInspection, RegistryPlugin } from '../src/features/plugins/types';
import { Button } from '../src/components/ui/Button';
import '../src/index.css';
import './uiOverlays.browser.css';

const plugins: InstalledPlugin[] = [
    { path: 'builtin://fixture-tool', enabled: true, manifest: { id: 'fixture.tool', name: 'Host Monitor', version: '1.2.0', description: 'Monitor resource usage on your host.' } },
    { path: 'builtin://fixture-editor', enabled: false, manifest: { id: 'fixture.editor', name: 'Code Editor', version: '2.0.0', description: 'Edit files in a host workspace.' } },
    { path: '/fixture/plugin-long', enabled: true, manifest: { id: 'fixture.long', name: 'A plugin with a longer descriptive name', version: '1.0.0', description: 'Long text wraps without widening the sidebar or hiding its actions.' } },
    { path: 'builtin://dark', enabled: true, manifest: { id: 'com.zync.theme.dark', name: 'Dark Theme', version: '1.0.0', type: 'theme' } },
    { path: 'builtin://light', enabled: true, manifest: { id: 'com.zync.theme.light', name: 'Light Theme', version: '1.0.0', type: 'theme' } },
];
const registry: RegistryPlugin[] = [
    { id: 'fixture.long', name: 'A plugin with a longer descriptive name', version: '2.0.0', registryVerified: true,
        description: 'An update is available.', downloadUrl: '' },
    { id: 'fixture.new', name: 'Example Marketplace Tool', version: '1.0.0', registryVerified: true,
        description: 'A signed catalog example. No native packages are installed in this fixture.', downloadUrl: '' },
    { id: 'fixture.legacy', name: 'Unverified Entry', version: '1.0.0', description: 'Unsigned catalog entries cannot be installed.', downloadUrl: '' },
];

/** Real sidebar view and navigation controller; boundary actions are inert counters. */
function Fixture() {
    const [section, setSection] = useState<GlobalSidebarSection>('hosts');
    const [settingsRequests, setSettingsRequests] = useState(0);
    const [width, setWidth] = useState(288);
    const [empty, setEmpty] = useState(false);
    const [loaded, setLoaded] = useState(true);
    const [theme, setTheme] = useState('dark');
    const [inventory, setInventory] = useState(plugins);
    const [review, setReview] = useState<PluginInstallInspection | null>(null);
    const [uninstall, setUninstall] = useState<InstalledPlugin | null>(null);
    const [action, setAction] = useState('None');
    const [error, setError] = useState(false);
    useEffect(() => {
        document.body.dataset.overlayGalleryTheme = theme;
        document.body.dataset.theme = theme;
    }, [theme]);
    const openPlugins = () => activateGlobalNavigation('plugins', {
        showSection: setSection, selectWorkspace: () => false,
        openPublicUrls() {}, openForwarding() {}, openSecurityAudits() {}, openSnippets() {},
    });
    return <main className="h-full overflow-auto bg-app-bg text-app-text p-6">
        <h1 className="text-lg font-semibold">Plugins sidebar fixture</h1>
        <div className="flex gap-3 flex-wrap my-4">
            <Button size="sm" onClick={openPlugins}>Open Plugins</Button>
            <Button size="sm" onClick={() => setWidth(width === 288 ? 200 : 288)}>Toggle narrow width</Button>
            <Button size="sm" onClick={() => setEmpty(!empty)}>Toggle empty list</Button>
            <Button size="sm" onClick={() => setLoaded(!loaded)}>Toggle loading</Button>
            <Button size="sm" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>Toggle theme</Button>
            <Button size="sm" onClick={() => setError(!error)}>Toggle load error</Button>
        </div>
        <p role="status" className="text-sm mb-4">Section: {section}; Settings opened: {settingsRequests}</p>
        <p role="status" className="text-sm mb-4">Last action: {action}</p>
        <div className="h-[480px] flex bg-app-panel border border-app-border rounded-lg overflow-hidden" style={{ width }}>
            {section === 'plugins' ? <PluginsSidebarContent plugins={empty ? [] : inventory} registry={empty ? [] : registry}
                loadingPlugins={!loaded} loadingRegistry={!loaded} runtimeHealth={[]} busy={false} needsRestart={false}
                pluginsError={error ? 'Could not load installed plugins. Try refreshing.' : null}
                registryError={error ? 'Could not load the marketplace. Try refreshing.' : null}
                onOpenSettings={() => setSettingsRequests(count => count + 1)} onChooseTheme={() => setAction('Choose theme')}
                onRefresh={() => { setError(false); setLoaded(true); setAction('Refresh'); }}
                onDetails={plugin => setAction(`Details: ${plugin.manifest.id}`)}
                onToggle={plugin => { setInventory(items => items.map(item => item.manifest.id === plugin.manifest.id ? { ...item, enabled: !item.enabled } : item)); setAction(`Toggle: ${plugin.manifest.id}`); }}
                onUninstall={setUninstall} onRetryRuntime={id => setAction(`Retry: ${id}`)}
                onInspect={plugin => { setAction(`Inspect: ${plugin.id}`); setReview({ inspectionId: plugin.id, packageDigest: 'fixture-digest',
                    sourceLabel: 'Browser fixture', trustLabel: 'Test-only signed entry', registryVersion: 1,
                    manifest: { id: plugin.id, name: plugin.name, version: plugin.version, manifestVersion: 2,
                        permissions: { required: [], optional: [{ id: 'network.fetch', hosts: ['example.com'], reason: 'Check for updates when requested.' }] } } }); }} /> : <p className="p-3 text-sm">Hosts sidebar</p>}
        </div>
        {review && <PluginPermissionReview standalone key={review.inspectionId} inspection={review} isApproving={false}
            onCancel={async () => { setReview(null); setAction('Review cancelled; no install'); }}
            onApprove={async ids => { setReview(null); setAction(`Fixture approval: ${ids.join(', ') || 'no optional permissions'}; no native install`); }} />}
        <ConfirmModal isOpen={Boolean(uninstall)} title="Uninstall plugin" message={`Remove ${uninstall?.manifest.name}? Its private data will be kept.`}
            confirmLabel="Uninstall" variant="danger" onClose={() => setUninstall(null)} onConfirm={() => {
                setInventory(items => items.filter(item => item.manifest.id !== uninstall?.manifest.id));
                setUninstall(null); setAction('Fixture uninstall confirmed; no native removal');
            }} />
    </main>;
}

createRoot(document.getElementById('root')!).render(<TooltipProvider><Fixture /></TooltipProvider>);
