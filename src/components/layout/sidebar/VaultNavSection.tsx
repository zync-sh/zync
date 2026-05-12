import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, Shield } from 'lucide-react';
import { useAppStore } from '../../../store/useAppStore';
import { cn } from '../../../lib/utils';
import { DEFAULT_VAULT_PROFILE_ID } from '../../../vault/profileTypes';
import { useVaultStore } from '../../../vault/useVaultStore';
import { syncIpc, SYNC_STATUS_CHANGED_EVENT, type SyncProviderStatus } from '../../../vault/syncIpc';
import { SidebarActionButton } from './SidebarActionButton';
import { VAULT_NAV_ITEMS } from './vaultNavConfig';
import { nextSidebarSectionsForVaultToggle, resolveVaultExpanded } from './vaultNavState';

function StatusDot({ className, title }: { className: string; title: string }) {
    return (
        <span
            title={title}
            className={cn("h-1.5 w-1.5 rounded-full", className)}
        />
    );
}

export function VaultNavSection() {
    const settings = useAppStore(state => state.settings);
    const updateSidebarSectionsSettings = useAppStore(state => state.updateSidebarSectionsSettings);
    const openVaultTab = useAppStore(state => state.openVaultTab);
    const activeVaultProfileId = useAppStore(state => {
        const activeTab = state.tabs.find(tab => tab.id === state.activeTabId);
        if (activeTab?.type === 'vault') return activeTab.vaultProfileId ?? DEFAULT_VAULT_PROFILE_ID;

        return state.tabs.find(tab => tab.type === 'vault')?.vaultProfileId ?? DEFAULT_VAULT_PROFILE_ID;
    });
    const vaultStatus = useVaultStore(state => state.status);
    const [googleSync, setGoogleSync] = useState<SyncProviderStatus | null>(null);

    const expanded = resolveVaultExpanded(settings);

    const refreshGoogleSync = useCallback(() => {
        syncIpc.status('google')
            .then(setGoogleSync)
            .catch(error => console.warn('[VaultNavSection] Failed to load Google sync status:', error));
    }, []);

    useEffect(() => {
        refreshGoogleSync();
        const interval = window.setInterval(refreshGoogleSync, 10_000);
        const handleSyncChanged = (event: Event) => {
            const detail = (event as CustomEvent<{ provider?: string }>).detail;
            if (!detail?.provider || detail.provider === 'google') {
                refreshGoogleSync();
            }
        };
        window.addEventListener(SYNC_STATUS_CHANGED_EVENT, handleSyncChanged);
        return () => {
            window.clearInterval(interval);
            window.removeEventListener(SYNC_STATUS_CHANGED_EVENT, handleSyncChanged);
        };
    }, [refreshGoogleSync]);

    const toggleExpanded = useCallback(() => {
        const sidebarSections = nextSidebarSectionsForVaultToggle(settings, expanded);
        void updateSidebarSectionsSettings(sidebarSections).catch(error => {
            console.warn('[VaultNavSection] Failed to persist expanded state:', error);
        });
    }, [expanded, settings, updateSidebarSectionsSettings]);

    const statusByProfile = useMemo(() => ({
        local: vaultStatus?.status === 'unlocked'
            ? { className: 'bg-emerald-400/80', title: 'Local vault unlocked' }
            : vaultStatus?.status === 'locked'
                ? { className: 'bg-amber-400/80', title: 'Local vault locked' }
                : { className: 'bg-app-muted/40', title: 'Local vault not set up' },
        google: googleSync?.connected
            ? { className: 'bg-blue-400/80', title: 'Google sync connected' }
            : { className: 'bg-app-muted/40', title: 'Google sync not connected' },
    }), [googleSync?.connected, vaultStatus?.status]);

    return (
        <>
            <SidebarActionButton
                icon={<Shield size={13} />}
                label="Vault"
                onClick={toggleExpanded}
                trailing={(
                    <ChevronDown
                        size={12}
                        className={cn(
                            "transition-transform duration-200",
                            !expanded && "-rotate-90",
                        )}
                    />
                )}
            />

            {expanded && (
                <div className="flex flex-col gap-1 w-full">
                    {VAULT_NAV_ITEMS.map((item) => {
                        const Icon = item.icon;
                        const status = statusByProfile[item.id];
                        if (!status && !import.meta.env.PROD) {
                            console.warn('[VaultNavSection] Missing statusByProfile entry for profile id:', item.id, statusByProfile);
                        }
                        const resolvedStatus = status ?? { className: 'bg-app-muted/40', title: 'Unknown vault profile' };

                        return (
                            <SidebarActionButton
                                key={item.id}
                                nested
                                active={activeVaultProfileId === item.id}
                                icon={<Icon size={12} />}
                                label={item.label}
                                onClick={() => openVaultTab(item.id)}
                                trailing={<StatusDot className={resolvedStatus.className} title={resolvedStatus.title} />}
                            />
                        );
                    })}
                </div>
            )}
        </>
    );
}
