import type { ReactNode } from 'react';

type PluginSubTab = 'installed' | 'marketplace' | 'developer';

interface PluginTabContentSwitchProps {
    pluginTab: PluginSubTab;
    renderInstalled: () => ReactNode;
    renderMarketplace: () => ReactNode;
    renderDeveloper: () => ReactNode;
}

export function PluginTabContentSwitch({
    pluginTab,
    renderInstalled,
    renderMarketplace,
    renderDeveloper,
}: PluginTabContentSwitchProps) {
    switch (pluginTab) {
        case 'installed':
            return renderInstalled();
        case 'marketplace':
            return renderMarketplace();
        case 'developer':
            return renderDeveloper();
        default:
            {
                const exhaustiveCheck: never = pluginTab;
                void exhaustiveCheck;
                return null;
            }
    }
}
