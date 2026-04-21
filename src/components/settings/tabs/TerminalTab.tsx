import { Terminal } from 'lucide-react';
import type { AppSettings } from '../../../store/settingsSlice';
import { Select } from '../../ui/Select';
import { Section } from '../common/Section';
import { Toggle } from '../common/Toggle';
import {
    DEFAULT_TERMINAL_FONT_STACK,
    DEFAULT_TERMINAL_FONT_SIZE,
    DEFAULT_TERMINAL_PADDING,
    DEFAULT_TERMINAL_LINE_HEIGHT,
    DEFAULT_TERMINAL_LIGATURES
} from '../constants/defaults';

interface TerminalTabProps {
    settings: AppSettings;
    terminalFontDraft: string;
    setTerminalFontDraft: (value: string) => void;
    wslDistros: string[];
    isWindows: boolean;
    updateTerminalSettings: (updates: Partial<AppSettings['terminal']>) => Promise<void>;
    updateLocalTermSettings: (updates: Partial<AppSettings['localTerm']>) => Promise<void>;
    setGhostSuggestionsField: (patch: Partial<AppSettings['ghostSuggestions']>) => void;
    setGhostProviderField: (patch: Partial<AppSettings['ghostSuggestions']['providers']>) => void;
}

export function TerminalTab({
    settings,
    terminalFontDraft,
    setTerminalFontDraft,
    wslDistros,
    isWindows,
    updateTerminalSettings,
    updateLocalTermSettings,
    setGhostSuggestionsField,
    setGhostProviderField
}: TerminalTabProps) {
    return (
        <div className="space-y-6">
            <Section title="Typography">
                <div className="space-y-4">
                    <div className="rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/40 p-4 space-y-3">
                        <Select
                            label="Font Family"
                            value={settings.terminal.fontFamily}
                            onChange={(val) => updateTerminalSettings({ fontFamily: val })}
                            options={[
                                {
                                    value: DEFAULT_TERMINAL_FONT_STACK,
                                    label: "System Monospace (Recommended)",
                                    description: "Best cross-platform default using built-in monospace fonts",
                                },
                                {
                                    value: "'Fira Code', 'FiraCode Nerd Font', 'FiraCode NFM', 'Cascadia Code', Consolas, 'Courier New', monospace",
                                    label: "Fira Code",
                                    description: "Supports Fira Code + common Nerd Font variants",
                                },
                                {
                                    value: "'JetBrains Mono', 'JetBrainsMono Nerd Font', 'JetBrainsMono NFM', 'Cascadia Mono', Consolas, 'Courier New', monospace",
                                    label: "JetBrains Mono",
                                    description: "Supports JetBrains Mono + common Nerd Font variants",
                                },
                                {
                                    value: "Menlo, Monaco, Consolas, 'Courier New', monospace",
                                    label: "Menlo",
                                    description: "Uses Menlo on macOS; falls back to Monaco/Consolas on Windows",
                                },
                                { value: "'Courier New', monospace", label: "Courier New", description: "Classic typewriter" }
                            ]}
                            triggerClassName="bg-app-bg/50"
                        />
                        <div className="space-y-2">
                            <label className="text-xs font-semibold uppercase tracking-wide text-[var(--color-app-muted)]">Custom Font Stack</label>
                            <div className="grid grid-cols-[1fr_auto] gap-2 items-stretch">
                                <input
                                    type="text"
                                    value={terminalFontDraft}
                                    onChange={(e) => setTerminalFontDraft(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
                                            e.stopPropagation();
                                        }
                                        if (e.key === 'Enter') {
                                            const next = terminalFontDraft.trim();
                                            if (next) void updateTerminalSettings({ fontFamily: next });
                                        }
                                    }}
                                    placeholder="e.g. 'Cascadia Code', Consolas, monospace"
                                    className="w-full min-h-[44px] bg-[var(--color-app-bg)] border border-[var(--color-app-border)] rounded-lg px-3 py-2.5 text-[14px] font-mono text-[var(--color-app-text)] focus:outline-none focus:border-[var(--color-app-accent)]"
                                />
                                <button
                                    type="button"
                                    onClick={() => {
                                        const next = terminalFontDraft.trim();
                                        if (next) void updateTerminalSettings({ fontFamily: next });
                                    }}
                                    className="min-w-[88px] px-4 py-2.5 rounded-lg text-sm font-semibold border border-[var(--color-app-border)] hover:bg-[var(--color-app-surface)]"
                                >
                                    Apply
                                </button>
                            </div>
                        </div>
                    </div>

                    <div className="rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/40 p-4 space-y-4">
                        <div className="space-y-2">
                            <div className="flex justify-between items-center">
                                <label className="text-sm font-medium text-[var(--color-app-text)]">Font Size</label>
                                <span className="text-sm text-[var(--color-app-accent)] font-mono">{settings.terminal.fontSize}px</span>
                            </div>
                            <input
                                type="range" min="10" max="24" step="1"
                                className="w-full accent-[var(--color-app-accent)] h-2 bg-[var(--color-app-surface)] rounded-lg appearance-none cursor-pointer"
                                value={settings.terminal.fontSize}
                                onChange={(e) => updateTerminalSettings({ fontSize: parseInt(e.target.value, 10) })}
                            />
                        </div>

                        <div className="space-y-2">
                            <div className="flex justify-between items-center">
                                <label className="text-sm font-medium text-[var(--color-app-text)]">Internal Padding</label>
                                <span className="text-sm text-[var(--color-app-accent)] font-mono">{settings.terminal.padding ?? 12}px</span>
                            </div>
                            <input
                                type="range" min="0" max="48" step="4"
                                className="w-full accent-[var(--color-app-accent)] h-2 bg-[var(--color-app-surface)] rounded-lg appearance-none cursor-pointer"
                                value={settings.terminal.padding ?? 12}
                                onChange={(e) => updateTerminalSettings({ padding: parseInt(e.target.value, 10) })}
                            />
                        </div>

                        <div className="space-y-2">
                            <div className="flex justify-between items-center">
                                <label className="text-sm font-medium text-[var(--color-app-text)]">Line Height</label>
                                <span className="text-sm text-[var(--color-app-accent)] font-mono">{(settings.terminal.lineHeight ?? 1.2).toFixed(2)}</span>
                            </div>
                            <input
                                type="range" min="1" max="2" step="0.05"
                                className="w-full accent-[var(--color-app-accent)] h-2 bg-[var(--color-app-surface)] rounded-lg appearance-none cursor-pointer"
                                value={settings.terminal.lineHeight ?? 1.2}
                                onChange={(e) => updateTerminalSettings({ lineHeight: parseFloat(e.target.value) })}
                            />
                        </div>
                    </div>

                    <div className="rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/40 p-3">
                        <Toggle
                            label="Enable Font Ligatures"
                            description="Use programming ligatures in terminal when the selected font supports them."
                            checked={settings.terminal.fontLigatures ?? false}
                            onChange={(v) => updateTerminalSettings({ fontLigatures: v })}
                        />
                    </div>

                    <div className="text-[11px] leading-relaxed text-[var(--color-app-muted)] rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/30 px-3 py-2.5">
                        Note: If a selected font looks unchanged, make sure that font is installed on your system.
                        For ligatures, the selected font must support ligatures.
                    </div>

                    <div className="flex items-center justify-between rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/30 px-3 py-2.5">
                        <p className="text-[11px] text-[var(--color-app-muted)]">
                            Reset terminal typography to recommended defaults.
                        </p>
                        <button
                            type="button"
                            onClick={() => {
                                void updateTerminalSettings({
                                    fontFamily: DEFAULT_TERMINAL_FONT_STACK,
                                    fontSize: DEFAULT_TERMINAL_FONT_SIZE,
                                    padding: DEFAULT_TERMINAL_PADDING,
                                    lineHeight: DEFAULT_TERMINAL_LINE_HEIGHT,
                                    fontLigatures: DEFAULT_TERMINAL_LIGATURES,
                                });
                            }}
                            className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-[var(--color-app-border)] hover:bg-[var(--color-app-surface)]"
                        >
                            Reset
                        </button>
                    </div>
                </div>
            </Section>

            <div className="h-px bg-[var(--color-app-border)]/20 my-2" />

            {isWindows && (
                <>
                    <Section title="Local Terminal (Windows)">
                        <div className="space-y-3">
                            <Select
                                label="Default Shell"
                                value={settings.localTerm?.windowsShell || 'default'}
                                onChange={(val) => updateLocalTermSettings({ windowsShell: val })}
                                options={[
                                    { value: 'default', label: 'Default', icon: <Terminal size={14} />, description: 'System Decision' },
                                    { value: 'powershell', label: 'PowerShell', icon: <Terminal size={14} /> },
                                    { value: 'cmd', label: 'Command Prompt', icon: <Terminal size={14} /> },
                                    { value: 'gitbash', label: 'Git Bash', icon: <Terminal size={14} /> },
                                    { value: 'wsl', label: 'WSL (Default)', icon: <Terminal size={14} /> },
                                    ...wslDistros.map(distro => ({
                                        value: `wsl:${distro}`,
                                        label: `WSL: ${distro}`,
                                        icon: <Terminal size={14} />
                                    }))
                                ]}
                                className="bg-app-bg/50"
                            />
                            <div className="text-[10px] text-[var(--color-app-muted)] pl-1">
                                Note: Changes take effect on new split panes or tabs.
                            </div>
                        </div>
                    </Section>

                    <div className="h-px bg-[var(--color-app-border)]/20 my-2" />
                </>
            )}

            <Section title="Cursor">
                <div className="grid grid-cols-3 gap-4">
                    {(['block', 'bar', 'underline'] as const).map(style => (
                        <button
                            key={style}
                            onClick={() => updateTerminalSettings({ cursorStyle: style })}
                            className={`p-4 rounded-lg border flex flex-col items-center gap-3 transition-all h-32 justify-center ${settings.terminal.cursorStyle === style
                                ? 'bg-[var(--color-app-accent)]/20 border-[var(--color-app-accent)] text-[var(--color-app-text)] ring-1 ring-[var(--color-app-accent)]'
                                : 'border-[var(--color-app-border)] hover:bg-[var(--color-app-surface)] text-[var(--color-app-muted)]'
                                }`}
                        >
                            <div className="h-12 w-24 bg-black/20 rounded border border-[var(--color-app-border)] flex items-center justify-center relative overflow-hidden font-mono text-xs">
                                <span className="text-[var(--color-app-muted)]">_</span>
                                <div className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-[var(--color-app-accent)]
                                    ${style === 'underline' ? 'h-0.5 w-2 mt-2' : style === 'bar' ? 'w-0.5 h-4' : 'w-2 h-4'}
                                `} />
                            </div>
                            <span className="capitalize text-sm font-medium">{style}</span>
                        </button>
                    ))}
                </div>
            </Section>

            <div className="h-px bg-[var(--color-app-border)]/20 my-2" />

            <Section title="Ghost Suggestions">
                <div className="space-y-1">
                    <Toggle
                        label="Inline ghost text"
                        description="Show faded fish-style inline completion while typing."
                        checked={settings.ghostSuggestions?.inlineEnabled ?? true}
                        onChange={(v) => setGhostSuggestionsField({ inlineEnabled: v })}
                    />
                    <Toggle
                        label="Tab popup suggestions"
                        description="Use Tab to open/navigate completion list before falling back to shell completion."
                        checked={settings.ghostSuggestions?.popupEnabled ?? true}
                        onChange={(v) => setGhostSuggestionsField({ popupEnabled: v })}
                    />
                    <Toggle
                        label="Context-menu suggestion actions"
                        description="Show suggestion actions in terminal right-click context menu."
                        checked={settings.ghostSuggestions?.contextMenuEnabled ?? false}
                        onChange={(v) => setGhostSuggestionsField({ contextMenuEnabled: v })}
                    />

                    <div className="rounded-lg border border-[var(--color-app-border)]/50 bg-[var(--color-app-bg)]/25 px-1 pt-3 pb-1 mt-2">
                        <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-app-muted)] px-3 pb-1">
                            Providers
                        </div>
                        <Toggle
                            label="History"
                            description="Suggest commands based on your past usage for this server/session scope."
                            checked={settings.ghostSuggestions?.providers?.history ?? true}
                            onChange={(v) => setGhostProviderField({ history: v })}
                        />
                        <Toggle
                            label="Filesystem paths"
                            description="Suggest local/remote path candidates for commands like cd."
                            checked={settings.ghostSuggestions?.providers?.filesystem ?? true}
                            onChange={(v) => setGhostProviderField({ filesystem: v })}
                        />
                    </div>
                </div>
            </Section>
        </div>
    );
}
