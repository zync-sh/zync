import { VaultTab } from '../settings/tabs/VaultTab';
import { DEFAULT_VAULT_PROFILE_ID, type VaultProfileId } from '../../vault/profileTypes';
import { cn } from '../../lib/utils';

interface VaultWorkspacePanelProps {
    profileId?: VaultProfileId;
}

const VAULT_PROFILES: ReadonlyArray<{ id: VaultProfileId; label: string }> = [
    { id: 'local', label: 'Local Vault' },
    { id: 'google', label: 'Google Drive Sync' },
];

export default function VaultWorkspacePanel({
    profileId = DEFAULT_VAULT_PROFILE_ID,
}: VaultWorkspacePanelProps) {
    return (
        <div className="h-full overflow-auto p-4 space-y-4">
            <div className="rounded-lg border border-app-border/40 bg-app-surface/20 p-3">
                <div className="text-xs font-semibold text-app-text mb-2">Vault Profiles (current scope)</div>
                <div className="flex flex-wrap gap-2" role="list">
                    {VAULT_PROFILES.map(item => (
                        <span
                            key={item.id}
                            role="listitem"
                            aria-current={profileId === item.id ? 'true' : undefined}
                            className={cn(
                                'px-2 py-1 rounded-md text-xs border border-app-border/40',
                                profileId === item.id
                                    ? 'bg-app-surface text-app-text'
                                    : 'bg-app-surface/40 text-app-muted',
                            )}
                        >
                            {item.label}
                        </span>
                    ))}
                </div>
            </div>
            <VaultTab focusedProfileId={profileId} />
        </div>
    );
}
