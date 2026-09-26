import { useEffect, useMemo, useState } from 'react';
import { Database, History, LockKeyhole, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';
import {
    getPluginManagementDetails,
    type PluginManagementDetails,
} from '../../../../features/plugins/management/pluginManagement';
import {
    getDeclaredPluginPermissions,
    getPluginPermissionDefinition,
    type InstalledPlugin,
} from '../../../../features/plugins/types';
import type { PluginRuntimeHealth } from '../../../../features/plugins/runtime/pluginRuntimeSupervisor';

interface PluginDetailsDialogProps {
    plugin: InstalledPlugin;
    health?: PluginRuntimeHealth;
    isProcessing: boolean;
    onClose: () => void;
    onSaveOptionalPermissions: (pluginId: string, permissionIds: string[]) => Promise<boolean>;
    onClearData: (plugin: InstalledPlugin) => Promise<boolean>;
    onRollback: (plugin: InstalledPlugin, version: string) => Promise<boolean>;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

export function PluginDetailsDialog({
    plugin,
    health,
    isProcessing,
    onClose,
    onSaveOptionalPermissions,
    onClearData,
    onRollback,
}: PluginDetailsDialogProps) {
    const [details, setDetails] = useState<PluginManagementDetails | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [selectedOptional, setSelectedOptional] = useState<Set<string>>(new Set());

    const permissions = useMemo(
        () => getDeclaredPluginPermissions(plugin.manifest),
        [plugin.manifest],
    );
    const optionalPermissions = permissions.filter(permission => !permission.required);

    const loadDetails = async () => {
        setError(null);
        try {
            const next = await getPluginManagementDetails(plugin.manifest.id);
            setDetails(next);
            setSelectedOptional(new Set(next.grant?.optionalPermissions ?? []));
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
    };

    useEffect(() => {
        void loadDetails();
    }, [plugin.manifest.id]);

    const canEditOptional = Boolean(
        details?.grant
        && !details.grant.legacyAccess
        && optionalPermissions.length > 0,
    );
    const grantedOptional = details?.grant?.optionalPermissions;
    const selectionChanged = grantedOptional
        ? selectedOptional.size !== grantedOptional.length
            || grantedOptional.some(id => !selectedOptional.has(id))
        : false;

    const toggleOptional = (permissionId: string) => {
        if (!canEditOptional || isProcessing) return;
        setSelectedOptional(current => {
            const next = new Set(current);
            if (next.has(permissionId)) next.delete(permissionId);
            else next.add(permissionId);
            return next;
        });
    };

    const savePermissions = async () => {
        const saved = await onSaveOptionalPermissions(plugin.manifest.id, [...selectedOptional]);
        if (saved) await loadDetails();
    };

    const clearData = async () => {
        const cleared = await onClearData(plugin);
        if (cleared) await loadDetails();
    };

    const rollback = async () => {
        const version = details?.rollback?.version;
        if (!version) return;
        if (await onRollback(plugin, version)) onClose();
    };

    const contributions = [
        ...(plugin.manifest.contributes?.commands ?? []).map(item => `Command: ${item.title}`),
        ...(plugin.manifest.contributes?.paneKinds ?? []).map(item => `Pane: ${item.title}`),
        ...(plugin.manifest.contributes?.dashboardCards ?? []).map(item => `Dashboard: ${item.title}`),
        ...(plugin.manifest.editor ? ['File editor'] : []),
    ];

    return (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/65 p-4" role="dialog" aria-modal="true" aria-labelledby="plugin-details-title">
            <div className="flex max-h-[min(760px,92vh)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[var(--color-app-border)] bg-[var(--color-app-bg)] shadow-2xl">
                <div className="flex items-start gap-3 border-b border-[var(--color-app-border)]/60 p-5">
                    <div className="rounded-lg bg-[var(--color-app-accent)]/10 p-2 text-[var(--color-app-accent)]">
                        <ShieldCheck size={19} />
                    </div>
                    <div className="min-w-0 flex-1">
                        <h3 id="plugin-details-title" className="text-sm font-semibold text-[var(--color-app-text)]">
                            {plugin.manifest.name}
                        </h3>
                        <p className="mt-1 text-xs text-[var(--color-app-muted)]">
                            {plugin.manifest.id} · v{plugin.manifest.version}
                        </p>
                    </div>
                    <button type="button" onClick={onClose} className="rounded-md p-1.5 text-[var(--color-app-muted)] hover:bg-[var(--color-app-surface)] hover:text-[var(--color-app-text)]" aria-label="Close plugin details">
                        <X size={16} />
                    </button>
                </div>

                <div className="flex-1 space-y-5 overflow-y-auto p-5">
                    {!details && !error && (
                        <div className="flex items-center gap-2 text-xs text-[var(--color-app-muted)]">
                            <RefreshCw size={13} className="animate-spin" />
                            Verifying installed package…
                        </div>
                    )}
                    {error && (
                        <div className="rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-xs text-red-300">
                            {error}
                        </div>
                    )}

                    {details && (
                        <>
                            <section className="grid grid-cols-2 gap-3 rounded-lg border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/45 p-4 text-xs">
                                <Detail label="Publisher" value={details.publisher ?? 'Unknown publisher'} />
                                <Detail label="Trust" value={details.trustLabel} />
                                <Detail label="Source" value={details.sourceLabel} />
                                <Detail label="Runtime" value={health?.status ?? (plugin.enabled ? 'Inactive' : 'Disabled')} />
                                <Detail label="Manifest" value={`Version ${details.manifestVersion}`} />
                                <Detail label="Approved" value={details.grant ? new Date(details.grant.approvedAtMs).toLocaleString() : 'App managed'} />
                                {details.signatureStatus && (
                                    <>
                                        <Detail label="Package signature" value="Valid" />
                                        <Detail
                                            label="Publisher identity"
                                            value={details.grant?.registryVersion == null
                                                ? 'Not registry verified'
                                                : details.grant.publisherVerified
                                                    ? 'Verified publisher'
                                                    : 'Bound by signed marketplace'}
                                        />
                                        <div className="col-span-2 min-w-0">
                                            <p className="text-[10px] uppercase tracking-wide text-[var(--color-app-muted)]">Signing key</p>
                                            <p className="mt-1 break-all font-mono text-[10px] text-[var(--color-app-text)]">{details.signatureStatus.keyId}</p>
                                        </div>
                                    </>
                                )}
                                {details.packageDigest && (
                                    <div className="col-span-2 min-w-0">
                                        <p className="text-[10px] uppercase tracking-wide text-[var(--color-app-muted)]">Package digest</p>
                                        <p className="mt-1 break-all font-mono text-[10px] text-[var(--color-app-text)]">{details.packageDigest}</p>
                                    </div>
                                )}
                            </section>

                            <section>
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <div>
                                        <h4 className="text-xs font-semibold text-[var(--color-app-text)]">Permissions</h4>
                                        <p className="mt-0.5 text-[10px] text-[var(--color-app-muted)]">Required access is fixed by the package. Optional access can be revoked at any time.</p>
                                    </div>
                                    {canEditOptional && (
                                        <button type="button" onClick={() => void savePermissions()} disabled={!selectionChanged || isProcessing} className="rounded-md bg-[var(--color-app-accent)] px-2.5 py-1.5 text-[10px] font-semibold text-white disabled:opacity-40">
                                            {isProcessing ? 'Applying…' : 'Apply changes'}
                                        </button>
                                    )}
                                </div>
                                <div className="space-y-2">
                                    {permissions.length === 0 && (
                                        <p className="rounded-lg border border-[var(--color-app-border)]/50 p-3 text-xs text-[var(--color-app-muted)]">No declared permissions.</p>
                                    )}
                                    {permissions.map(permission => {
                                        const definition = getPluginPermissionDefinition(permission.id);
                                        const granted = permission.required || selectedOptional.has(permission.id);
                                        return (
                                            <label key={permission.id} className="flex items-start gap-3 rounded-lg border border-[var(--color-app-border)]/50 bg-[var(--color-app-surface)]/35 p-3">
                                                <input
                                                    type="checkbox"
                                                    checked={granted}
                                                    disabled={permission.required || !canEditOptional || isProcessing}
                                                    onChange={() => toggleOptional(permission.id)}
                                                    className="mt-0.5"
                                                />
                                                <div className="min-w-0 flex-1">
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <span className="text-xs font-medium text-[var(--color-app-text)]">{definition?.title ?? permission.id}</span>
                                                        <span className="rounded-full border border-[var(--color-app-border)] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-[var(--color-app-muted)]">{permission.required ? 'Required' : granted ? 'Granted' : 'Denied'}</span>
                                                    </div>
                                                    <p className="mt-1 text-[10px] leading-4 text-[var(--color-app-muted)]">{permission.reason}</p>
                                                    {(permission.scope || permission.hosts?.length) && (
                                                        <p className="mt-1 break-all font-mono text-[9px] leading-4 text-[var(--color-app-muted)]">
                                                            {[
                                                                permission.scope && `Scope: ${permission.scope}`,
                                                                permission.hosts?.length && `Hosts: ${permission.hosts.join(', ')}`,
                                                            ].filter(Boolean).join(' · ')}
                                                        </p>
                                                    )}
                                                </div>
                                                {permission.required && <LockKeyhole size={13} className="mt-0.5 shrink-0 text-[var(--color-app-muted)]" />}
                                            </label>
                                        );
                                    })}
                                </div>
                            </section>

                            <section>
                                <h4 className="text-xs font-semibold text-[var(--color-app-text)]">Contributions</h4>
                                <p className="mt-2 text-[11px] leading-5 text-[var(--color-app-muted)]">
                                    {contributions.length > 0 ? contributions.join(' · ') : 'No registered UI or command contributions.'}
                                </p>
                            </section>

                            {details.rollback && (
                                <section className="flex items-center justify-between gap-4 rounded-lg border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/35 p-4">
                                    <div className="flex min-w-0 items-start gap-3">
                                        <History size={16} className="mt-0.5 shrink-0 text-[var(--color-app-accent)]" />
                                        <div>
                                            <h4 className="text-xs font-semibold text-[var(--color-app-text)]">Previous version</h4>
                                            <p className="mt-1 text-[10px] text-[var(--color-app-muted)]">
                                                Version {details.rollback.version} · retained {new Date(details.rollback.retainedAtMs).toLocaleString()}
                                            </p>
                                            <p className="mt-1 text-[10px] text-[var(--color-app-muted)]">Restores the package and its reviewed permissions. Private plugin data is kept.</p>
                                        </div>
                                    </div>
                                    <button type="button" onClick={() => void rollback()} disabled={isProcessing} className="flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--color-app-border)] px-2.5 py-1.5 text-[10px] font-medium text-[var(--color-app-text)] hover:bg-[var(--color-app-surface)] disabled:opacity-40">
                                        <History size={12} />
                                        {isProcessing ? 'Restoring…' : `Restore ${details.rollback.version}`}
                                    </button>
                                </section>
                            )}

                            <section className="flex items-center justify-between gap-4 rounded-lg border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/35 p-4">
                                <div className="flex min-w-0 items-start gap-3">
                                    <Database size={16} className="mt-0.5 shrink-0 text-[var(--color-app-accent)]" />
                                    <div>
                                        <h4 className="text-xs font-semibold text-[var(--color-app-text)]">Private device storage</h4>
                                        <p className="mt-1 text-[10px] text-[var(--color-app-muted)]">{details.storage.keyCount} keys · {formatBytes(details.storage.bytes)}</p>
                                    </div>
                                </div>
                                {!plugin.path.startsWith('builtin://') && (
                                    <button type="button" onClick={() => void clearData()} disabled={isProcessing || details.storage.keyCount === 0} className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[10px] font-medium text-red-400 hover:bg-red-500/10 disabled:opacity-40">
                                        <Trash2 size={12} />
                                        Clear data
                                    </button>
                                )}
                            </section>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

function Detail({ label, value }: { label: string; value: string }) {
    return (
        <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wide text-[var(--color-app-muted)]">{label}</p>
            <p className="mt-1 truncate text-[var(--color-app-text)] capitalize">{value}</p>
        </div>
    );
}
