import { Plug } from 'lucide-react';
import { usePlugins } from '../../context/PluginContext';
import { resolvePluginPanelOwner } from '../../features/plugins/pluginPanelOwner';

/** Trusted glyphs only: a plugin icon must never inject markup into the host. */
export function PluginIcon({ panelId, size = 14, className }: { panelId: string; size?: number; className?: string }) {
    const { panels, plugins } = usePlugins();
    const pluginId = resolvePluginPanelOwner(panelId, panels, plugins);
    const icon = plugins.find(plugin => plugin.manifest.id === pluginId)?.manifest.icon;
    if (icon !== 'icons/process-manager.svg') return <Plug size={size} className={className} aria-hidden />;
    return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true" style={{ flexShrink: 0 }}>
            <rect width="32" height="32" rx="8" fill="#0F766E" />
            <path d="M7 25V7h6a5 5 0 0 1 0 10H7" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M22 10c6-2 7 5 2 8l-4 5h7" stroke="#99F6E4" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}
