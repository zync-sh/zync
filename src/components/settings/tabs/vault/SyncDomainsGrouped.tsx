import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import { useId, useState } from 'react';

import { cn } from '../../../../lib/utils';
import { getSyncDomainDefinition } from '../../../../vault/syncDomains';
import type {
    SyncCollectionStatus,
    SyncConnectionsRestoreArgs,
    SyncDomain,
    SyncDomainPolicy,
    SyncProviderStatus,
} from '../../../../vault/syncIpc';
import { Button } from '../../../ui/Button';
import {
    ConnectionsRestoreBundleModal,
    formatRestoreBundleSummary,
} from './ConnectionsRestoreBundleModal';
import { SyncDomainListCard } from './SyncDomainListCard';
import { SyncDomainRow } from './SyncDomainRow';

interface SyncDomainsGroupedProps {
    googleSync: SyncProviderStatus | null;
    googleCollection: SyncCollectionStatus | null;
    hostsSyncEnabled: boolean;
    domainPolicies: SyncDomainPolicy[];
    isUpdatingDomainPolicy: boolean;
    isCollectionActionBlocked: boolean;
    isProviderDomainActionDisabled: boolean;
    providerGateReason: string | null;
    hasVaultConfigured: boolean;
    isVaultUnlocked: boolean;
    isSyncingVault: boolean;
    isRestoringVault: boolean;
    isSyncingHosts: boolean;
    isRestoringHosts: boolean;
    isPreviewingConnections: boolean;
    isRestoringConnections: boolean;
    isSyncingTunnels: boolean;
    isRestoringTunnels: boolean;
    isSyncingSnippets: boolean;
    isRestoringSnippets: boolean;
    isSyncingSettings: boolean;
    isRestoringSettings: boolean;
    onSetHostsSyncEnabled: (enabled: boolean) => void;
    onSetDomainPolicyEnabled: (domain: SyncDomain, enabled: boolean) => void;
    onSyncHosts: () => void;
    onRestoreConnections: (args: SyncConnectionsRestoreArgs) => void;
    onRestoreHosts: () => void;
    onSyncTunnels: () => void;
    onRestoreTunnels: () => void;
    onSyncSnippets: () => void;
    onRestoreGlobalSnippets: () => void;
    onRestoreSnippets: () => void;
    onSyncSettings: () => void;
    onRestoreSettings: () => void;
    onUpload: (forceFull?: boolean) => void;
    onDownload: () => void;
}

/** Render a heading for a group of backup domains. */
function SectionLabel({ title }: { title: string }) {
    return (
        <h4 className="px-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-app-muted)]">
            {title}
        </h4>
    );
}

/** Group backup controls by domain and expose a full credential upload alongside regular sync. */
export function SyncDomainsGrouped(props: SyncDomainsGroupedProps) {
    const advancedSectionId = useId();
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [restoreBundleOpen, setRestoreBundleOpen] = useState(false);
    const [includeTunnels, setIncludeTunnels] = useState(true);
    const [includeHostSnippets, setIncludeHostSnippets] = useState(true);
    const [includeReferencedCredentials, setIncludeReferencedCredentials] = useState(true);

    const domainStatusByKey = new Map(
        (props.googleSync?.domainStatuses ?? []).map((status) => [status.domain, status]),
    );
    /** Read a domain policy, falling back to the domain default before policies load. */
    const domainPolicyEnabled = (
        domain: SyncDomain,
        fallback = getSyncDomainDefinition(domain).defaultEnabled,
    ) => props.domainPolicies.find((policy) => policy.domain === domain)?.enabled ?? fallback;

    const tunnelsEnabled = domainPolicyEnabled('tunnels');
    const snippetsEnabled = domainPolicyEnabled('snippets');
    const settingsEnabled = domainPolicyEnabled('settings');
    const isVaultDomainEnabled = domainPolicyEnabled('vault');

    const restoreBundleArgs: SyncConnectionsRestoreArgs = {
        includeHostDefinitions: true,
        includeTunnels: tunnelsEnabled && includeTunnels,
        includeHostSnippets: snippetsEnabled && includeHostSnippets,
        includeReferencedCredentials,
    };

    /** Start the connection restore flow with the current bundle choices. */
    const restoreConnections = () => {
        props.onRestoreConnections(restoreBundleArgs);
    };

    return (
        <div className="space-y-5">
            <section className="space-y-2">
                <SectionLabel title="Connections" />

                <SyncDomainListCard>
                    <SyncDomainRow
                        label="Hosts & related data"
                        description="Hosts plus the tunnels, snippets, and credentials that belong to them."
                        hint={formatRestoreBundleSummary(
                            includeTunnels,
                            includeHostSnippets,
                            includeReferencedCredentials,
                            tunnelsEnabled,
                            snippetsEnabled,
                        )}
                        enabled={props.hostsSyncEnabled}
                        status={domainStatusByKey.get('hosts')}
                        isUpdatingPolicy={props.isUpdatingDomainPolicy}
                        isActionBlocked={props.isCollectionActionBlocked}
                        syncDisabled={
                            props.isProviderDomainActionDisabled ||
                            !props.hostsSyncEnabled ||
                            props.isSyncingHosts
                        }
                        restoreDisabled={
                            props.isProviderDomainActionDisabled ||
                            !props.hostsSyncEnabled ||
                            props.isPreviewingConnections ||
                            props.isRestoringConnections
                        }
                        isSyncing={props.isSyncingHosts}
                        isRestoring={props.isPreviewingConnections || props.isRestoringConnections}
                        gateMessage={props.providerGateReason ?? undefined}
                        extraActions={
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setRestoreBundleOpen(true)}
                                disabled={
                                    props.isProviderDomainActionDisabled || !props.hostsSyncEnabled
                                }
                                className="h-7 gap-1.5 px-2"
                            >
                                <SlidersHorizontal size={13} />
                                Options
                            </Button>
                        }
                        onToggleEnabled={() => props.onSetHostsSyncEnabled(!props.hostsSyncEnabled)}
                        onSync={props.onSyncHosts}
                        onRestore={restoreConnections}
                    />
                </SyncDomainListCard>

                <ConnectionsRestoreBundleModal
                    isOpen={restoreBundleOpen}
                    onClose={() => setRestoreBundleOpen(false)}
                    includeTunnels={includeTunnels}
                    includeHostSnippets={includeHostSnippets}
                    includeReferencedCredentials={includeReferencedCredentials}
                    tunnelsEnabled={tunnelsEnabled}
                    snippetsEnabled={snippetsEnabled}
                    onIncludeTunnelsChange={setIncludeTunnels}
                    onIncludeHostSnippetsChange={setIncludeHostSnippets}
                    onIncludeReferencedCredentialsChange={setIncludeReferencedCredentials}
                />
            </section>

            <section className="space-y-2">
                <SectionLabel title="App-wide" />
                <SyncDomainListCard>
                    <SyncDomainRow
                        label="Global snippets"
                        description={getSyncDomainDefinition('snippets').description}
                        enabled={snippetsEnabled}
                        status={domainStatusByKey.get('snippets')}
                        isUpdatingPolicy={props.isUpdatingDomainPolicy}
                        isActionBlocked={props.isCollectionActionBlocked}
                        syncDisabled={
                            props.isProviderDomainActionDisabled ||
                            !snippetsEnabled ||
                            props.isSyncingSnippets
                        }
                        restoreDisabled={
                            props.isProviderDomainActionDisabled ||
                            !snippetsEnabled ||
                            props.isRestoringSnippets
                        }
                        isSyncing={props.isSyncingSnippets}
                        isRestoring={props.isRestoringSnippets}
                        restoreLabel="Restore global"
                        onToggleEnabled={() =>
                            props.onSetDomainPolicyEnabled('snippets', !snippetsEnabled)
                        }
                        onSync={props.onSyncSnippets}
                        onRestore={props.onRestoreGlobalSnippets}
                    />
                    <SyncDomainRow
                        label="Settings"
                        description={getSyncDomainDefinition('settings').description}
                        enabled={settingsEnabled}
                        status={domainStatusByKey.get('settings')}
                        isUpdatingPolicy={props.isUpdatingDomainPolicy}
                        isActionBlocked={props.isCollectionActionBlocked}
                        syncDisabled={
                            props.isProviderDomainActionDisabled ||
                            !settingsEnabled ||
                            props.isSyncingSettings
                        }
                        restoreDisabled={
                            props.isProviderDomainActionDisabled ||
                            !settingsEnabled ||
                            props.isRestoringSettings
                        }
                        isSyncing={props.isSyncingSettings}
                        isRestoring={props.isRestoringSettings}
                        onToggleEnabled={() =>
                            props.onSetDomainPolicyEnabled('settings', !settingsEnabled)
                        }
                        onSync={props.onSyncSettings}
                        onRestore={props.onRestoreSettings}
                    />
                </SyncDomainListCard>
            </section>

            <section className="space-y-2">
                <SectionLabel title="Vault" />
                <SyncDomainListCard>
                    <SyncDomainRow
                        label="Vault credentials"
                        description={getSyncDomainDefinition('vault').description}
                        hint="Restores your full encrypted credential library from Drive. Connection restore only pulls creds referenced by hosts."
                        enabled={isVaultDomainEnabled}
                        status={domainStatusByKey.get('vault')}
                        isUpdatingPolicy={props.isUpdatingDomainPolicy}
                        isActionBlocked={props.isCollectionActionBlocked}
                        syncDisabled={
                            props.isProviderDomainActionDisabled ||
                            !props.hasVaultConfigured ||
                            !isVaultDomainEnabled ||
                            props.isSyncingVault ||
                            props.isRestoringVault
                        }
                        restoreDisabled={
                            props.isProviderDomainActionDisabled ||
                            !props.isVaultUnlocked ||
                            !isVaultDomainEnabled ||
                            props.isSyncingVault ||
                            props.isRestoringVault
                        }
                        isSyncing={props.isSyncingVault}
                        isRestoring={props.isRestoringVault}
                        onToggleEnabled={() =>
                            props.onSetDomainPolicyEnabled('vault', !isVaultDomainEnabled)
                        }
                        onSync={() => props.onUpload()}
                        extraActions={
                            <Button
                                variant="ghost"
                                size="sm"
                                disabled={
                                    props.isProviderDomainActionDisabled ||
                                    !props.isVaultUnlocked ||
                                    !isVaultDomainEnabled ||
                                    props.isSyncingVault ||
                                    props.isRestoringVault
                                }
                                onClick={() => props.onUpload(true)}
                                title="Upload every live credential again, including unchanged records"
                            >
                                Upload all again
                            </Button>
                        }
                        onRestore={props.onDownload}
                    />
                </SyncDomainListCard>
            </section>

            <section className="space-y-2">
                <button
                    type="button"
                    onClick={() => setAdvancedOpen((value) => !value)}
                    aria-expanded={advancedOpen}
                    aria-controls={advancedSectionId}
                    className="flex w-full items-center justify-between px-1 py-1 text-left"
                >
                    <div>
                        <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-app-muted)]">
                            Advanced per-domain
                        </p>
                        <p className="mt-0.5 text-[11px] text-[var(--color-app-muted)]/85">
                            Upload or restore one domain at a time. On a new device, use Restore in
                            Connections above.
                        </p>
                    </div>
                    <ChevronDown
                        size={14}
                        className={cn(
                            'shrink-0 text-[var(--color-app-muted)] transition-transform',
                            advancedOpen && 'rotate-180',
                        )}
                    />
                </button>
                {advancedOpen && (
                    <SyncDomainListCard id={advancedSectionId}>
                        {(['hosts', 'tunnels', 'snippets'] as const).map((domain) => {
                            const enabled =
                                domain === 'hosts'
                                    ? props.hostsSyncEnabled
                                    : domainPolicyEnabled(domain);
                            const definition = getSyncDomainDefinition(domain);
                            return (
                                <SyncDomainRow
                                    key={domain}
                                    label={definition.label}
                                    description={definition.description}
                                    enabled={enabled}
                                    status={domainStatusByKey.get(domain)}
                                    isUpdatingPolicy={props.isUpdatingDomainPolicy}
                                    isActionBlocked={props.isCollectionActionBlocked}
                                    syncDisabled={
                                        props.isProviderDomainActionDisabled ||
                                        !enabled ||
                                        (domain === 'hosts'
                                            ? props.isSyncingHosts
                                            : domain === 'tunnels'
                                              ? props.isSyncingTunnels
                                              : props.isSyncingSnippets)
                                    }
                                    restoreDisabled={
                                        props.isProviderDomainActionDisabled ||
                                        !enabled ||
                                        (domain === 'hosts'
                                            ? props.isRestoringHosts
                                            : domain === 'tunnels'
                                              ? props.isRestoringTunnels
                                              : props.isRestoringSnippets)
                                    }
                                    isSyncing={
                                        domain === 'hosts'
                                            ? props.isSyncingHosts
                                            : domain === 'tunnels'
                                              ? props.isSyncingTunnels
                                              : props.isSyncingSnippets
                                    }
                                    isRestoring={
                                        domain === 'hosts'
                                            ? props.isRestoringHosts
                                            : domain === 'tunnels'
                                              ? props.isRestoringTunnels
                                              : props.isRestoringSnippets
                                    }
                                    onToggleEnabled={
                                        domain === 'hosts'
                                            ? () =>
                                                  props.onSetHostsSyncEnabled(
                                                      !props.hostsSyncEnabled,
                                                  )
                                            : () => props.onSetDomainPolicyEnabled(domain, !enabled)
                                    }
                                    onSync={
                                        domain === 'hosts'
                                            ? props.onSyncHosts
                                            : domain === 'tunnels'
                                              ? props.onSyncTunnels
                                              : props.onSyncSnippets
                                    }
                                    onRestore={
                                        domain === 'hosts'
                                            ? props.onRestoreHosts
                                            : domain === 'tunnels'
                                              ? props.onRestoreTunnels
                                              : props.onRestoreSnippets
                                    }
                                />
                            );
                        })}
                    </SyncDomainListCard>
                )}
            </section>
        </div>
    );
}
