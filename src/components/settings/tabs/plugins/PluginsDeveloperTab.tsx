import type { ComponentType } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';

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
    onInstallLocalPlugin: (mode: 'zip' | 'folder') => Promise<void>;
}

export function PluginsDeveloperTab({
    localInstallActions,
    localPluginInstallMode,
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

            <div className="grid gap-3 md:grid-cols-2">
                {localInstallActions.map((action) => {
                    const ActionIcon = action.icon;
                    const isInstallingThis = localPluginInstallMode === action.mode;
                    const isAnyInstallRunning = localPluginInstallMode !== null;

                    return (
                        <button
                            key={action.mode}
                            onClick={() => {
                                void onInstallLocalPlugin(action.mode).catch((error) => {
                                    console.error('Failed to install local plugin', error);
                                });
                            }}
                            disabled={isAnyInstallRunning}
                            aria-busy={isInstallingThis}
                            aria-disabled={isAnyInstallRunning}
                            className="group min-h-[168px] rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/35 p-4 text-left transition-all hover:border-[var(--color-app-accent)]/35 hover:bg-[var(--color-app-surface)] disabled:cursor-not-allowed disabled:opacity-60"
                            type="button"
                        >
                            <div className="mb-3 flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2 text-[var(--color-app-accent)]">
                                    {isInstallingThis ? <RefreshCw size={16} className="animate-spin" /> : <ActionIcon size={16} />}
                                    <span className="text-[11px] font-semibold uppercase tracking-wide">{action.label}</span>
                                </div>
                                <span className="text-[10px] font-medium text-[var(--color-app-muted)] group-hover:text-[var(--color-app-text)]">
                                    {isInstallingThis ? 'Installing...' : 'Choose'}
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
                Installed local plugins appear in the <span className="font-medium text-[var(--color-app-text)]">Installed</span> tab after install.
                Use this flow to test theme-follow behavior and editor-provider integration before marketplace publication.
            </div>
        </div>
    );
}
