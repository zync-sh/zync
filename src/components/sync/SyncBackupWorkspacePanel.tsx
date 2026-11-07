import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useAppStore } from '../../store/useAppStore';
import { getSyncBackupPageStatusMessage } from '../../vault/syncPageCopy';
import { useVaultStore } from '../../vault/useVaultStore';
import { useVaultPanelActions } from '../settings/tabs/vault/hooks/useVaultPanelActions';
import { RestoreConflictModal } from '../settings/tabs/vault/RestoreConflictModal';
import { SyncCollectionSetupModal } from '../settings/tabs/vault/SyncCollectionSetupModal';
import { SyncCollectionUnlockModal } from '../settings/tabs/vault/SyncCollectionUnlockModal';
import { VaultSyncCard } from '../settings/tabs/vault/VaultSyncCard';
import { Button } from '../ui/Button';
import { RecoveryKeyModal } from '../vault/RecoveryKeyModal';

export default function SyncBackupWorkspacePanel() {
    const { status, refresh, lock, refreshItems } = useVaultStore();
    const showToast = useAppStore((state) => state.showToast);
    const showConfirmDialog = useAppStore((state) => state.showConfirmDialog);
    const connections = useAppStore((state) => state.connections);
    const tabs = useAppStore((state) => state.tabs);
    const disconnectConnection = useAppStore((state) => state.disconnect);
    const loadConnections = useAppStore((state) => state.loadConnections);
    const openVaultTab = useAppStore((state) => state.openVaultTab);

    const [isSyncCollectionSetupOpen, setIsSyncCollectionSetupOpen] = useState(false);
    const [isSyncCollectionUnlockOpen, setIsSyncCollectionUnlockOpen] = useState(false);
    const isVaultUnlocked = status?.status === 'unlocked';
    const hasVaultConfigured = status?.status === 'locked' || status?.status === 'unlocked';

    const loadAllTunnels = useAppStore((state) => state.loadAllTunnels);
    const loadSnippets = useAppStore((state) => state.loadSnippets);
    const loadSettings = useAppStore((state) => state.loadSettings);

    const panel = useVaultPanelActions({
        connections,
        tabs,
        showToast,
        showConfirmDialog,
        onLocked: lock,
        onRefresh: refresh,
        onRefreshItems: refreshItems,
        onLoadConnections: loadConnections,
        onDisconnectConnection: disconnectConnection,
        onReloadTunnels: loadAllTunnels,
        onReloadSnippets: loadSnippets,
        onReloadSettings: loadSettings,
    });

    const { loadGoogleSync, loadGoogleCollection, loadDomainPolicies } = panel;

    useEffect(() => {
        void refresh().catch((error) => {
            console.warn('[Sync & Backup] Failed to refresh vault status:', error);
        });
        void loadGoogleSync();
        void loadGoogleCollection();
        void loadDomainPolicies();
    }, [refresh, loadGoogleSync, loadGoogleCollection, loadDomainPolicies]);

    const statusMessage = getSyncBackupPageStatusMessage(panel.googleSync, panel.googleCollection);

    return (
        <div className="h-full overflow-auto">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-5">
                <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                        <h1 className="text-lg font-semibold tracking-tight text-[var(--color-app-text)]">
                            Sync & Backup
                        </h1>
                        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-[var(--color-app-muted)]">
                            {statusMessage}
                        </p>
                    </div>
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                            void Promise.all([
                                refresh(),
                                loadGoogleSync(),
                                loadGoogleCollection(),
                                loadDomainPolicies(),
                            ]).catch((error) => {
                                console.warn('[Sync & Backup] Refresh failed:', error);
                            });
                        }}
                        className="gap-1.5 shrink-0"
                    >
                        <RefreshCw size={13} />
                        Refresh
                    </Button>
                </header>

                <p className="text-[11px] text-[var(--color-app-muted)]">
                    SSH passwords and keys are managed separately in{' '}
                    <button
                        type="button"
                        onClick={() => openVaultTab('local')}
                        className="font-medium text-[var(--color-app-accent)] underline-offset-2 hover:underline"
                    >
                        Vault Credentials
                    </button>
                    .
                </p>

                <VaultSyncCard
                    googleSync={panel.googleSync}
                    googleCollection={panel.googleCollection}
                    isSyncing={panel.isSyncing}
                    isSyncingVault={panel.isSyncingVault}
                    isRestoringVault={panel.isRestoringVault}
                    isSyncingHosts={panel.isSyncingHosts}
                    isRestoringHosts={panel.isRestoringHosts}
                    isPreviewingConnections={panel.isPreviewingConnections}
                    isRestoringConnections={panel.isConnectionsRestoreBusy}
                    isSyncingTunnels={panel.isSyncingTunnels}
                    isRestoringTunnels={panel.isRestoringTunnels}
                    isSyncingSnippets={panel.isSyncingSnippets}
                    isRestoringSnippets={panel.isRestoringSnippets}
                    isSyncingSettings={panel.isSyncingSettings}
                    isRestoringSettings={panel.isRestoringSettings}
                    hostsSyncEnabled={panel.hostsSyncEnabled}
                    isUpdatingDomainPolicy={panel.isUpdatingDomainPolicy}
                    domainPolicies={panel.domainPolicies}
                    isSettingUpCollection={panel.isSettingUpCollection}
                    isUnlockingCollection={panel.isUnlockingCollection}
                    isLockingCollection={panel.isLockingCollection}
                    isRegeneratingCollectionRecoveryKey={panel.isRegeneratingCollectionRecoveryKey}
                    hasVaultConfigured={hasVaultConfigured}
                    isVaultUnlocked={isVaultUnlocked}
                    onConnect={panel.handleGoogleConnect}
                    onDisconnect={panel.handleGoogleDisconnect}
                    onSetupCollection={() => setIsSyncCollectionSetupOpen(true)}
                    onUnlockCollection={() => setIsSyncCollectionUnlockOpen(true)}
                    onLockCollection={panel.handleLockGoogleCollection}
                    onRegenerateCollectionRecoveryKey={
                        panel.handleRegenerateGoogleCollectionRecoveryKey
                    }
                    onUpload={panel.handleSyncUpload}
                    onDownload={panel.handleSyncDownload}
                    onSyncHosts={() => void panel.handleSyncHosts()}
                    onRestoreHosts={() => void panel.handleRestoreHosts()}
                    onRestoreConnections={(args) => void panel.handleRestoreConnections(args)}
                    onRestoreGlobalSnippets={() => void panel.handleRestoreGlobalSnippets()}
                    onSetHostsSyncEnabled={(enabled) =>
                        void panel.handleSetHostsSyncEnabled(enabled)
                    }
                    onSetDomainPolicyEnabled={(domain, enabled) =>
                        void panel.handleSetDomainPolicyEnabled(domain, enabled)
                    }
                    onSyncTunnels={() => void panel.handleSyncTunnels()}
                    onRestoreTunnels={() => void panel.handleRestoreTunnels()}
                    onSyncSnippets={() => void panel.handleSyncSnippets()}
                    onRestoreSnippets={() => void panel.handleRestoreSnippets()}
                    onSyncSettings={() => void panel.handleSyncSettings()}
                    onRestoreSettings={() => void panel.handleRestoreSettings()}
                />
            </div>

            <RecoveryKeyModal
                isOpen={panel.isRecoveryModalOpen}
                recoveryKey={panel.recoveryKey}
                onClose={panel.closeRecoveryModal}
                title={panel.recoveryKeyTitle}
                subtitle={panel.recoveryKeySubtitle}
                fileTitle={panel.recoveryKeyFileTitle}
                fileDescription={panel.recoveryKeyFileDescription}
                downloadFileName={panel.recoveryKeyDownloadFileName}
            />

            <SyncCollectionSetupModal
                isOpen={isSyncCollectionSetupOpen}
                isSubmitting={panel.isSettingUpCollection}
                hasLocalVaultConfigured={hasVaultConfigured}
                onClose={() => setIsSyncCollectionSetupOpen(false)}
                onSubmit={panel.handleSetupGoogleCollection}
            />

            <SyncCollectionUnlockModal
                isOpen={isSyncCollectionUnlockOpen}
                isSubmitting={panel.isUnlockingCollection}
                hasRecoveryKey={Boolean(panel.googleCollection?.hasRecoveryKey)}
                onClose={() => setIsSyncCollectionUnlockOpen(false)}
                onSubmit={panel.handleUnlockGoogleCollection}
            />

            <RestoreConflictModal
                isOpen={panel.isRestoreConflictModalOpen}
                isSubmitting={panel.isRestoringVault}
                preview={panel.restorePreview}
                conflicts={panel.restoreConflictItems}
                selectedLogicalIds={panel.selectedConflictLogicalIds}
                onClose={panel.closeRestoreConflictModal}
                onToggleLogicalId={panel.toggleConflictLogicalId}
                onSelectAll={panel.selectAllConflictLogicalIds}
                onClearAll={panel.clearConflictLogicalIds}
                onConfirmRestore={panel.confirmRestoreWithConflictSelection}
            />
        </div>
    );
}
