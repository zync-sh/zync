import { useMemo } from 'react';
import { useAvailableShells } from '../../../hooks/useAvailableShells';
import { shellEntryForIcon } from '../../../lib/shells/bundledShellIcon';
import type { ShellEntry } from '../../../lib/shells/types';
import type { AppSettings } from '../../../store/settingsSlice';
import { ShellIcon } from '../../icons/ShellIcon';
import { Select } from '../../ui/Select';
import { withOrphanSelectOption } from '../../ui/selectOptions';
import { Section } from '../common/Section';
import { SettingsGroup } from '../common/SettingsGroup';
import { Toggle } from '../common/Toggle';
import {
    DEFAULT_TERMINAL_GPU_ACCELERATION,
    DEFAULT_SUSPEND_IDLE_HOST_PTYS,
    DEFAULT_IDLE_HOST_PTY_SUSPEND_MINUTES,
} from '../constants/defaults';
import { TerminalRendererStatus } from './TerminalRendererStatus';
import { TerminalTabIntro } from './TerminalTabIntro';

function shellSelectIcon(shellId: string, detected?: ReadonlyArray<ShellEntry>) {
    return <ShellIcon shell={shellEntryForIcon(shellId, detected)} size={14} />;
}

interface TerminalTabProps {
    settings: AppSettings;
    wslDistros: string[];
    isWindows: boolean;
    onOpenAppearanceTerminal: () => void;
    onOpenAppearanceApp: () => void;
    updateTerminalSettings: (updates: Partial<AppSettings['terminal']>) => Promise<void>;
    updateLocalTermSettings: (updates: Partial<AppSettings['localTerm']>) => Promise<void>;
    setGhostSuggestionsField: (patch: Partial<AppSettings['ghostSuggestions']>) => void;
    setGhostProviderField: (patch: Partial<AppSettings['ghostSuggestions']['providers']>) => void;
}

export function TerminalTab({
    settings,
    wslDistros,
    isWindows,
    onOpenAppearanceTerminal,
    onOpenAppearanceApp,
    updateTerminalSettings,
    updateLocalTermSettings,
    setGhostSuggestionsField,
    setGhostProviderField,
}: TerminalTabProps) {
    const { shells: detectedShells } = useAvailableShells({ isWindows, connectionId: 'local' });
    // Match resolveLocalWindowsShellId trimming so padded/empty values do not look "unavailable".
    const windowsShellRaw = settings.localTerm?.windowsShell?.trim() || 'default';
    const windowsShell = windowsShellRaw === '' ? 'default' : windowsShellRaw;
    const shellOptions = useMemo(() => {
        const icon = (id: string) => shellSelectIcon(id, detectedShells);
        const base = [
            { value: 'default', label: 'Default', icon: icon('powershell'), description: 'System Decision (PowerShell)' },
            { value: 'powershell', label: 'PowerShell', icon: icon('powershell') },
            { value: 'cmd', label: 'Command Prompt', icon: icon('cmd') },
            { value: 'gitbash', label: 'Git Bash', icon: icon('gitbash') },
            { value: 'wsl', label: 'WSL (Default)', icon: icon('wsl') },
            ...wslDistros.map((distro) => ({
                value: `wsl:${distro}`,
                label: `WSL: ${distro}`,
                icon: icon(`wsl:${distro}`),
            })),
        ];
        const baseIds = new Set(base.map((option) => option.value));
        // Detected shells (e.g. pwsh) that are not already in the fixed list.
        const detectedExtras = detectedShells
            .filter((shell) => shell.id && !baseIds.has(shell.id) && shell.id !== 'default')
            .map((shell) => ({
                value: shell.id,
                label: shell.label || shell.id,
                description: 'Detected on this machine',
                icon: icon(shell.id),
            }));
        const merged = [...base, ...detectedExtras];
        return withOrphanSelectOption(merged, windowsShell, {
            label: windowsShell.startsWith('wsl:')
                ? `WSL: ${windowsShell.slice(4)} (unavailable)`
                : `${windowsShell} (unavailable)`,
            description: 'Saved shell is missing — pick another option',
            icon: icon(windowsShell),
        });
    }, [windowsShell, wslDistros, detectedShells]);

    return (
        <div className="space-y-6">
            <TerminalTabIntro
                onOpenAppearanceTerminal={onOpenAppearanceTerminal}
                onOpenAppearanceApp={onOpenAppearanceApp}
            />

            {isWindows && (
                <>
                    <Section title="Local shell (Windows)">
                        <div className="space-y-3">
                            <Select
                                label="Default Shell"
                                value={windowsShell}
                                onChange={(value) => { void updateLocalTermSettings({ windowsShell: value }); }}
                                options={shellOptions}
                                className="bg-app-bg/50"
                            />
                            <div className="text-[10px] text-[var(--color-app-muted)] pl-1">
                                Changes take effect on new split panes or tabs.
                            </div>
                        </div>
                    </Section>

                    <div className="h-px bg-[var(--color-app-border)]/20 my-2" />
                </>
            )}

            <Section title="Rendering">
                <SettingsGroup>
                    <Toggle
                        label="GPU Acceleration (WebGL)"
                        description="Faster rendering for large output. On Windows, GPU text is rasterized to a canvas and can look sharper/thinner than DOM mode, which uses native ClearType."
                        checked={settings.terminal.gpuAcceleration ?? DEFAULT_TERMINAL_GPU_ACCELERATION}
                        onChange={(value) => { void updateTerminalSettings({ gpuAcceleration: value }); }}
                    />
                    <div className="px-4 pb-3">
                        <TerminalRendererStatus
                            gpuAcceleration={settings.terminal.gpuAcceleration ?? DEFAULT_TERMINAL_GPU_ACCELERATION}
                        />
                    </div>
                </SettingsGroup>
            </Section>

            <div className="h-px bg-[var(--color-app-border)]/20 my-2" />

            <Section title="Background hosts">
                <SettingsGroup>
                    <Toggle
                        label="Suspend idle host shells"
                        description="After switching away from a workspace host, suspend its PTYs once quiet (scrollback preserved). Shells still producing output stay alive. Press Enter on return to resume. Off by default — SSH hosts show a fresh login on auto-respawn."
                        checked={settings.terminal.suspendIdleHostPtys ?? DEFAULT_SUSPEND_IDLE_HOST_PTYS}
                        onChange={(value) => { void updateTerminalSettings({ suspendIdleHostPtys: value }); }}
                    />
                    {(settings.terminal.suspendIdleHostPtys ?? DEFAULT_SUSPEND_IDLE_HOST_PTYS) && (
                        <div className="px-4 pb-3">
                            <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/30 px-3 py-2.5">
                                <div>
                                    <p id="idle-host-pty-timeout-label" className="text-sm font-medium text-[var(--color-app-text)]">Idle timeout</p>
                                    <p className="text-[11px] text-[var(--color-app-muted)]">Minutes before background host PTYs suspend</p>
                                </div>
                                <input
                                    type="number"
                                    min={1}
                                    max={60}
                                    inputMode="numeric"
                                    aria-labelledby="idle-host-pty-timeout-label"
                                    value={settings.terminal.idleHostPtySuspendMinutes ?? DEFAULT_IDLE_HOST_PTY_SUSPEND_MINUTES}
                                    onChange={(e) => {
                                        const minutes = Math.max(1, Math.min(60, Number(e.target.value) || 1));
                                        void updateTerminalSettings({ idleHostPtySuspendMinutes: minutes });
                                    }}
                                    className="w-16 min-h-[36px] rounded-lg border border-[var(--color-app-border)] bg-[var(--color-app-bg)]/50 px-2 py-1.5 text-sm text-center text-[var(--color-app-text)] [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none focus:outline-none focus:border-[var(--color-app-accent)] focus:ring-1 focus:ring-[var(--color-app-accent)]/20"
                                />
                            </div>
                        </div>
                    )}
                </SettingsGroup>
            </Section>

            <div className="h-px bg-[var(--color-app-border)]/20 my-2" />

            <Section title="Ghost suggestions">
                <SettingsGroup plain>
                    <Toggle
                        label="Inline ghost text"
                        description="Show faded fish-style inline completion while typing."
                        checked={settings.ghostSuggestions?.inlineEnabled ?? true}
                        onChange={(value) => { setGhostSuggestionsField({ inlineEnabled: value }); }}
                    />
                    <Toggle
                        label="Context-menu suggestion actions"
                        description="Show suggestion actions in terminal right-click context menu."
                        checked={settings.ghostSuggestions?.contextMenuEnabled ?? false}
                        onChange={(value) => { setGhostSuggestionsField({ contextMenuEnabled: value }); }}
                    />
                    <div className="px-4 py-2 space-y-1">
                        <Select
                            label="Native shell sessions"
                            value={settings.ghostSuggestions?.nativeShellPolicy ?? 'auto'}
                            onChange={(value) => {
                                if (value === 'auto' || value === 'always' || value === 'off') {
                                    setGhostSuggestionsField({ nativeShellPolicy: value });
                                }
                            }}
                            options={[
                                { value: 'auto', label: 'Auto (recommended)' },
                                { value: 'always', label: 'Always on' },
                                { value: 'off', label: 'Off for native shells' },
                            ]}
                            className="bg-app-bg/50"
                        />
                        <p className="text-[10px] text-[var(--color-app-muted)] pl-1">
                            Auto hides inline ghost on fish and on zsh only when zsh-autosuggestions is detected in init files.
                        </p>
                    </div>

                    <SettingsGroup>
                        <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-app-muted)] px-4 pt-3 pb-1">
                            Providers
                        </div>
                        <Toggle
                            label="History"
                            description="Suggest commands based on your past usage for this server/session scope."
                            checked={settings.ghostSuggestions?.providers?.history ?? true}
                            onChange={(value) => { setGhostProviderField({ history: value }); }}
                        />
                        <Toggle
                            label="Import remote shell history on connect"
                            description="One-time read of ~/.zsh_history and ~/.bash_history over SFTP when an SSH host connects. Never logged; scoped per host."
                            checked={settings.ghostSuggestions?.importRemoteHistoryOnConnect ?? false}
                            onChange={(value) => { setGhostSuggestionsField({ importRemoteHistoryOnConnect: value }); }}
                        />
                        <Toggle
                            label="Filesystem paths"
                            description="Suggest local/remote path candidates for commands like cd."
                            checked={settings.ghostSuggestions?.providers?.filesystem ?? true}
                            onChange={(value) => { setGhostProviderField({ filesystem: value }); }}
                        />
                    </SettingsGroup>
                </SettingsGroup>
            </Section>
        </div>
    );
}
