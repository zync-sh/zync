import { Cloud, Shield } from 'lucide-react';
import { VaultTab } from '../settings/tabs/VaultTab';
import { DEFAULT_VAULT_PROFILE_ID, type VaultProfileId } from '../../vault/profileTypes';
import { useAppStore } from '../../store/useAppStore';
import { Button } from '../ui/Button';

interface VaultWorkspacePanelProps {
    profileId?: VaultProfileId;
}

export default function VaultWorkspacePanel({
    profileId = DEFAULT_VAULT_PROFILE_ID,
}: VaultWorkspacePanelProps) {
    const openSyncBackupTab = useAppStore(state => state.openSyncBackupTab);

    return (
        <div className="h-full overflow-auto">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-5">
                <section className="rounded-2xl border border-app-border/60 bg-gradient-to-br from-app-surface/55 to-app-bg/40 p-5 shadow-sm">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        <div className="min-w-0">
                            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-app-accent/25 bg-app-accent/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-app-accent">
                                <Shield size={13} />
                                Vault Credentials
                            </div>
                            <h1 className="text-2xl font-semibold tracking-tight text-app-text">
                                Manage local encrypted credentials
                            </h1>
                            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-app-muted">
                                Store SSH credentials in the local vault, rotate them safely, assign
                                them to hosts, and review recovery/export options. Provider setup and
                                app-data sync live in Sync & Backup.
                            </p>
                        </div>
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={openSyncBackupTab}
                            className="gap-1.5 shrink-0"
                        >
                            <Cloud size={13} />
                            Open Sync & Backup
                        </Button>
                    </div>
                </section>

                <VaultTab focusedProfileId={profileId} />
            </div>
        </div>
    );
}
