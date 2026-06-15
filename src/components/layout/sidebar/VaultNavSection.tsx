import { useCallback, useMemo } from 'react';
import { Shield } from 'lucide-react';
import { useAppStore } from '../../../store/useAppStore';
import { cn } from '../../../lib/utils';
import { DEFAULT_VAULT_PROFILE_ID } from '../../../vault/profileTypes';
import { useVaultStore } from '../../../vault/useVaultStore';
import { isVaultInUseError } from '../../../vault/vaultLoading';
import { SidebarActionButton } from './SidebarActionButton';
import { SplitSidebarActionButton } from './SplitSidebarActionButton';
import { VAULT_NAV_ITEMS } from './vaultNavConfig';
import { nextSidebarSectionsForVaultToggle, resolveVaultExpanded } from './vaultNavState';

function StatusDot({ className, title }: { className: string; title: string }) {
    return (
        <span
            title={title}
            className={cn('h-1.5 w-1.5 rounded-full', className)}
        />
    );
}

function resolveLocalVaultStatusDot(
    status: ReturnType<typeof useVaultStore.getState>['status'],
    error: ReturnType<typeof useVaultStore.getState>['error'],
) {
    if (isVaultInUseError(error)) {
        return { className: 'bg-orange-400/80', title: 'Vault open in another Zync window' };
    }
    if (status?.status === 'unlocked') {
        return { className: 'bg-emerald-400/80', title: 'Local vault unlocked' };
    }
    if (status?.status === 'locked') {
        return { className: 'bg-amber-400/80', title: 'Local vault locked' };
    }
    return { className: 'bg-app-muted/40', title: 'Local vault not set up' };
}

export function VaultNavSection() {
    const settings = useAppStore(state => state.settings);
    const updateSidebarSectionsSettings = useAppStore(state => state.updateSidebarSectionsSettings);
    const openVaultTab = useAppStore(state => state.openVaultTab);
    const activeVaultProfileId = useAppStore(state => {
        const activeTab = state.tabs.find(tab => tab.id === state.activeTabId);
        if (activeTab?.type !== 'vault') return null;
        return activeTab.vaultProfileId ?? DEFAULT_VAULT_PROFILE_ID;
    });
    const vaultStatus = useVaultStore(state => state.status);
    const vaultError = useVaultStore(state => state.error);

    const expanded = resolveVaultExpanded(settings);
    const localVaultStatus = useMemo(
        () => resolveLocalVaultStatusDot(vaultStatus, vaultError),
        [vaultStatus, vaultError],
    );

    const toggleExpanded = useCallback(() => {
        const sidebarSections = nextSidebarSectionsForVaultToggle(settings, expanded);
        void updateSidebarSectionsSettings(sidebarSections).catch(error => {
            console.warn('[VaultNavSection] Failed to persist expanded state:', error);
        });
    }, [expanded, settings, updateSidebarSectionsSettings]);

    const openLocalVault = useCallback(() => {
        openVaultTab(DEFAULT_VAULT_PROFILE_ID);
    }, [openVaultTab]);

    return (
        <>
            <SplitSidebarActionButton
                icon={<Shield size={13} />}
                label="Vault"
                expanded={expanded}
                active={activeVaultProfileId === DEFAULT_VAULT_PROFILE_ID}
                onPrimaryClick={openLocalVault}
                onToggleClick={toggleExpanded}
                toggleAriaLabel={expanded ? 'Collapse vault menu' : 'Expand vault menu'}
            />

            {expanded && (
                <div className="flex w-full flex-col gap-1">
                    {VAULT_NAV_ITEMS.map(item => {
                        const Icon = item.icon;
                        const isActive = activeVaultProfileId === item.id;
                        const status = item.id === 'local' ? localVaultStatus : null;

                        return (
                            <SidebarActionButton
                                key={item.id}
                                nested
                                active={isActive}
                                icon={<Icon size={12} />}
                                label={item.label}
                                onClick={() => openVaultTab(item.id)}
                                trailing={
                                    status
                                        ? <StatusDot className={status.className} title={status.title} />
                                        : undefined
                                }
                            />
                        );
                    })}
                </div>
            )}
        </>
    );
}