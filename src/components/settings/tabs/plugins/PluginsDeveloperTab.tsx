import { useState, type ComponentType } from 'react';
import { AlertTriangle, Check, LockKeyhole, Minus, RefreshCw, ShieldCheck, Sparkles, X } from 'lucide-react';
import { diffPluginPermissions, type PluginPermissionChange } from '../../../../features/plugins/permissionDiff';
import {
    getDeclaredPluginPermissions,
    getPluginPermissionDefinition,
    isLegacyPluginManifest,
    type PluginInstallInspection,
    type PluginPermissionRequest,
} from '../../../../features/plugins/types';
import { Toggle } from '../../common/Toggle';

export interface LocalInstallAction {
    mode: 'zip' | 'folder';
    label: string;
    title: string;
    description: string;
    hint: string;
    icon: ComponentType<{ size?: number; className?: string }>;
}

interface PluginsDeveloperTabProps {
    localInstallActions: LocalInstallAction[];
    localPluginInstallMode: 'zip' | 'folder' | null;
    developerMode: boolean;
    isUpdatingDeveloperMode: boolean;
    onSetDeveloperMode: (enabled: boolean) => Promise<void>;
    onInstallLocalPlugin: (mode: 'zip' | 'folder') => Promise<void>;
}

export function PluginsDeveloperTab({
    localInstallActions,
    localPluginInstallMode,
    developerMode,
    isUpdatingDeveloperMode,
    onSetDeveloperMode,
    onInstallLocalPlugin,
}: PluginsDeveloperTabProps) {
    return (
        <div className="space-y-4">
            <div className="rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/35 p-4">
                <div className="flex items-start gap-3">
                    <div className="rounded-lg border border-[var(--color-app-border)] bg-[var(--color-app-bg)] p-2 text-[var(--color-app-accent)] shrink-0">
                        <Sparkles size={16} />
                    </div>
                    <div className="min-w-0">
                        <h4 className="text-sm font-semibold text-[var(--color-app-text)]">Developer plugin testing</h4>
                        <p className="mt-1 text-xs leading-5 text-[var(--color-app-muted)]">
                            Install local plugin builds here before publishing to marketplace.
                            Supports packaged ZIP archives and unpacked plugin folders.
                        </p>
                    </div>
                </div>
            </div>

            <div className="overflow-hidden rounded-xl border border-amber-500/25 bg-amber-500/5">
                <Toggle
                    label="Developer Mode"
                    description="Allow local and legacy plugins that are not verified by the signed marketplace. Keep this off unless you are testing code you trust."
                    checked={developerMode}
                    disabled={isUpdatingDeveloperMode}
                    onChange={(enabled) => {
                        void onSetDeveloperMode(enabled);
                    }}
                />
            </div>

            <div className="grid gap-3 md:grid-cols-2">
                {localInstallActions.map((action) => {
                    const ActionIcon = action.icon;
                    const isInstallingThis = localPluginInstallMode === action.mode;
                    const isAnyInstallRunning = localPluginInstallMode !== null;
                    const disabled = !developerMode || isAnyInstallRunning || isUpdatingDeveloperMode;

                    return (
                        <button
                            key={action.mode}
                            onClick={() => {
                                void onInstallLocalPlugin(action.mode).catch((error) => {
                                    console.error('Failed to install local plugin', error);
                                });
                            }}
                            disabled={disabled}
                            aria-busy={isInstallingThis}
                            aria-disabled={disabled}
                            title={!developerMode ? 'Enable Developer Mode to install local plugins' : undefined}
                            className="group min-h-[168px] rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/35 p-4 text-left transition-all hover:border-[var(--color-app-accent)]/35 hover:bg-[var(--color-app-surface)] disabled:cursor-not-allowed disabled:opacity-60"
                            type="button"
                        >
                            <div className="mb-3 flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2 text-[var(--color-app-accent)]">
                                    {isInstallingThis ? <RefreshCw size={16} className="animate-spin" /> : <ActionIcon size={16} />}
                                    <span className="text-[11px] font-semibold uppercase tracking-wide">{action.label}</span>
                                </div>
                                <span className="text-[10px] font-medium text-[var(--color-app-muted)] group-hover:text-[var(--color-app-text)]">
                                    {isInstallingThis ? 'Installing...' : developerMode ? 'Choose' : 'Locked'}
                                </span>
                            </div>
                            <p className="text-sm font-medium text-[var(--color-app-text)]">{action.title}</p>
                            <p className="mt-1 text-xs leading-5 text-[var(--color-app-muted)]">{action.description}</p>
                            <p className="mt-3 text-[11px] leading-4 text-[var(--color-app-muted)]/90">{action.hint}</p>
                        </button>
                    );
                })}
            </div>

            <div className="rounded-lg border border-dashed border-[var(--color-app-border)]/60 bg-[var(--color-app-bg)]/40 p-3 text-xs leading-5 text-[var(--color-app-muted)]">
                {developerMode
                    ? <>
                        Installed local plugins appear in the <span className="font-medium text-[var(--color-app-text)]">Installed</span> tab after install.
                        Use this flow to test theme-follow behavior and editor-provider integration before marketplace publication.
                    </>
                    : 'Local and legacy plugins stay stopped while Developer Mode is off. Signed marketplace plugins are unaffected.'}
            </div>

        </div>
    );
}

interface PluginPermissionReviewProps {
    inspection: PluginInstallInspection;
    isApproving: boolean;
    onApprove: (optionalPermissionIds: string[]) => Promise<void>;
    onCancel: () => Promise<void>;
}

function PermissionRow({
    permission,
    change,
}: {
    permission: PluginPermissionRequest & { required: boolean };
    change?: PluginPermissionChange;
}) {
    const definition = getPluginPermissionDefinition(permission.id);
    return (
        <div className="flex items-start gap-3 rounded-lg border border-[var(--color-app-border)]/50 bg-[var(--color-app-bg)]/55 p-3">
            <div className="mt-0.5 rounded-md bg-[var(--color-app-surface)] p-1.5 text-[var(--color-app-accent)]">
                {permission.required ? <LockKeyhole size={14} /> : <Check size={14} />}
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-medium text-[var(--color-app-text)]">
                        {definition?.title ?? permission.id}
                    </p>
                    <span className="rounded-full border border-[var(--color-app-border)] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-[var(--color-app-muted)]">
                        {permission.required ? 'Required' : 'Optional'}
                    </span>
                    {(change === 'added' || change === 'changed') && (
                        <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-amber-400">
                            {change === 'added' ? 'New access' : 'Access changed'}
                        </span>
                    )}
                </div>
                <p className="mt-1 text-[11px] leading-4 text-[var(--color-app-muted)]">
                    {definition?.description}
                </p>
                <p className="mt-1 text-[11px] leading-4 text-[var(--color-app-text)]/80">
                    Publisher reason: {permission.reason}
                </p>
                {(Boolean(permission.scope) || Boolean(permission.hosts?.length)) && (
                    <p className="mt-1 font-mono text-[10px] text-[var(--color-app-muted)]">
                        {[permission.scope && `Scope: ${permission.scope}`, permission.hosts?.length && `Hosts: ${permission.hosts.join(', ')}`]
                            .filter(Boolean)
                            .join(' · ')}
                    </p>
                )}
            </div>
        </div>
    );
}

export function PluginPermissionReview({
    inspection,
    isApproving,
    onApprove,
    onCancel,
}: PluginPermissionReviewProps) {
    const permissions = getDeclaredPluginPermissions(inspection.manifest);
    const optional = permissions.filter((permission) => !permission.required);
    const isUpdate = Boolean(inspection.previousVersion);
    const permissionDiff = isUpdate
        ? diffPluginPermissions(
            inspection.previousPermissions,
            inspection.manifest.permissions,
            inspection.previouslyGrantedOptional,
        )
        : null;
    const changeById = new Map(permissionDiff?.entries.map(entry => [entry.id, entry.change]));
    const [selectedOptional, setSelectedOptional] = useState<Set<string>>(
        () => new Set(permissionDiff?.optionalSelectedByDefault ?? []),
    );
    const legacy = isLegacyPluginManifest(inspection.manifest);

    const toggleOptional = (permissionId: string) => {
        setSelectedOptional((current) => {
            const next = new Set(current);
            if (next.has(permissionId)) next.delete(permissionId);
            else next.add(permissionId);
            return next;
        });
    };

    return (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/65 p-4" role="dialog" aria-modal="true" aria-labelledby="plugin-review-title">
            <div className="flex max-h-[min(720px,90vh)] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-[var(--color-app-border)] bg-[var(--color-app-bg)] shadow-2xl">
                <div className="flex items-start gap-3 border-b border-[var(--color-app-border)]/60 p-5">
                    <div className="rounded-lg bg-[var(--color-app-accent)]/10 p-2 text-[var(--color-app-accent)]">
                        <ShieldCheck size={19} />
                    </div>
                    <div className="min-w-0 flex-1">
                        <h3 id="plugin-review-title" className="text-sm font-semibold text-[var(--color-app-text)]">
                            {isUpdate ? 'Review plugin update' : 'Review plugin permissions'}
                        </h3>
                        <p className="mt-1 text-xs text-[var(--color-app-muted)]">
                            {inspection.manifest.name} {inspection.manifest.version} · {inspection.manifest.publisher ?? 'Unknown publisher'}
                        </p>
                        {inspection.previousVersion && (
                            <p className="mt-1 text-[10px] font-medium text-[var(--color-app-text)]/80">
                                Updating from {inspection.previousVersion} to {inspection.manifest.version}
                            </p>
                        )}
                        <p className="mt-1 text-[10px] text-[var(--color-app-muted)]">
                            {inspection.trustLabel} · {inspection.sourceLabel}
                        </p>
                        {inspection.signatureStatus && (
                            <p className="mt-1 break-all font-mono text-[9px] text-[var(--color-app-muted)]">
                                Signing key: {inspection.signatureStatus.keyId}
                            </p>
                        )}
                    </div>
                    <button type="button" onClick={() => void onCancel()} disabled={isApproving} className="rounded-md p-1.5 text-[var(--color-app-muted)] hover:bg-[var(--color-app-surface)] hover:text-[var(--color-app-text)] disabled:opacity-50" aria-label="Cancel plugin installation">
                        <X size={16} />
                    </button>
                </div>

                <div className="flex-1 space-y-3 overflow-y-auto p-5">
                    <div className="flex gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-[11px] leading-4 text-amber-200">
                        <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                        <p>
                            {legacy
                                ? 'This legacy plugin has no permission declarations. Only install it if you trust its source; it uses the compatibility bridge.'
                                : inspection.registryVersion
                                    ? `${inspection.publisherVerified ? 'Zync verified this publisher.' : 'The signed marketplace binds this publisher name to the package signing key.'} Package contents and identity were verified against registry version ${inspection.registryVersion}.`
                                : inspection.signatureStatus
                                    ? 'The package signature and every listed file are valid. This local flow has not verified that the signing key belongs to the claimed publisher.'
                                    : 'This is an unsigned local development plugin. Zync will remember approval only for these exact package contents.'}
                        </p>
                    </div>

                    {permissionDiff && (
                        <div className="rounded-lg border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/35 p-3">
                            <p className="text-xs font-medium text-[var(--color-app-text)]">Permission changes</p>
                            <p className="mt-1 text-[11px] leading-4 text-[var(--color-app-muted)]">
                                {permissionDiff.added.length} added · {permissionDiff.changed.length} changed · {permissionDiff.removed.length} removed · {permissionDiff.unchanged.length} unchanged
                            </p>
                            {permissionDiff.added.some(entry => entry.after?.required) && (
                                <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-4 text-amber-400">
                                    <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                                    This update adds required access. Review each highlighted permission before continuing.
                                </p>
                            )}
                            {permissionDiff.added.length === 0 && permissionDiff.changed.length === 0 && (
                                <p className="mt-2 text-[11px] text-emerald-500">This update does not add or change access.</p>
                            )}
                        </div>
                    )}

                    {permissions.length === 0 && !legacy && (
                        <p className="rounded-lg border border-[var(--color-app-border)]/50 p-3 text-xs text-[var(--color-app-muted)]">
                            This plugin does not request any permissions.
                        </p>
                    )}

                    {permissions.map((permission) => (
                        permission.required ? (
                            <PermissionRow key={`required:${permission.id}`} permission={permission} change={changeById.get(permission.id)} />
                        ) : (
                            <label key={`optional:${permission.id}`} className="block cursor-pointer">
                                <input
                                    type="checkbox"
                                    className="sr-only"
                                    checked={selectedOptional.has(permission.id)}
                                    onChange={() => toggleOptional(permission.id)}
                                    disabled={isApproving}
                                />
                                <div className={selectedOptional.has(permission.id) ? 'rounded-lg ring-1 ring-[var(--color-app-accent)]' : ''}>
                                    <PermissionRow permission={permission} change={changeById.get(permission.id)} />
                                </div>
                            </label>
                        )
                    ))}
                    {permissionDiff && permissionDiff.removed.length > 0 && (
                        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
                            <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-500">Removed access</p>
                            <div className="mt-2 space-y-1.5">
                                {permissionDiff.removed.map(entry => (
                                    <div key={entry.id} className="flex items-center gap-2 text-[11px] text-[var(--color-app-muted)]">
                                        <Minus size={12} className="shrink-0 text-emerald-500" />
                                        <span>{getPluginPermissionDefinition(entry.id)?.title ?? entry.id}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    {optional.length > 0 && (
                        <p className="text-[10px] leading-4 text-[var(--color-app-muted)]">
                            {isUpdate
                                ? 'Previously granted optional permissions stay selected only when their access scope is unchanged. New or changed optional access starts off.'
                                : 'Optional permissions are off by default. You can enable only the features you want.'}
                        </p>
                    )}
                </div>

                <div className="flex justify-end gap-2 border-t border-[var(--color-app-border)]/60 p-4">
                    <button type="button" onClick={() => void onCancel()} disabled={isApproving} className="rounded-lg px-3 py-2 text-xs font-medium text-[var(--color-app-muted)] hover:bg-[var(--color-app-surface)] hover:text-[var(--color-app-text)] disabled:opacity-50">
                        Cancel
                    </button>
                    <button type="button" onClick={() => void onApprove([...selectedOptional])} disabled={isApproving} className="flex items-center gap-2 rounded-lg bg-[var(--color-app-accent)] px-3 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60">
                        {isApproving && <RefreshCw size={13} className="animate-spin" />}
                        {isUpdate ? 'Update and activate' : 'Install and activate'}
                    </button>
                </div>
            </div>
        </div>
    );
}
