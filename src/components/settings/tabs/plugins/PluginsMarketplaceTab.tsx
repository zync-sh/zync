import { RefreshCw } from 'lucide-react';
import { Marketplace } from '../../Marketplace';

interface PluginsMarketplaceTabProps {
    isLoadingRegistry: boolean;
    onInstallSuccess: () => void;
}

export function PluginsMarketplaceTab({ isLoadingRegistry, onInstallSuccess }: PluginsMarketplaceTabProps) {
    if (isLoadingRegistry) {
        return (
            <div
                className="flex items-center justify-center py-12 text-[var(--color-app-muted)] gap-2"
                role="status"
                aria-live="polite"
                aria-busy="true"
            >
                <RefreshCw size={14} className="animate-spin" />
                <span className="text-xs">Loading marketplace...</span>
            </div>
        );
    }

    return (
        <div className="h-full">
            <Marketplace onInstallSuccess={onInstallSuccess} />
        </div>
    );
}
