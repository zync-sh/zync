import type { AppSettings } from '../../../../store/settingsSlice';
import { Select } from '../../../ui/Select';
import { Section } from '../../common/Section';
import { Toggle } from '../../common/Toggle';
import {
    DEFAULT_TERMINAL_FONT_STACK,
    DEFAULT_TERMINAL_FONT_STACK_WIN32,
    DEFAULT_TERMINAL_FONT_WEIGHT,
    DEFAULT_TERMINAL_FONT_WEIGHT_WIN32,
    DEFAULT_TERMINAL_LIGATURES,
    DEFAULT_TERMINAL_LINE_HEIGHT,
    DEFAULT_TERMINAL_PADDING,
    TERMINAL_FONT_WEIGHT_OPTIONS,
    resolveDefaultTerminalTypography,
    type TerminalFontWeightSetting,
} from '../../constants/defaults';
import { resolveTerminalFontWeightBold } from '../../../../lib/terminal/terminalTypography';

export interface AppearanceTerminalTypographySectionProps {
    settings: AppSettings;
    terminalFontDraft: string;
    isWindows: boolean;
    onTerminalFontDraftChange: (value: string) => void;
    onUpdateTerminalSettings: (updates: Partial<AppSettings['terminal']>) => void;
}

export function AppearanceTerminalTypographySection({
    settings,
    terminalFontDraft,
    isWindows,
    onTerminalFontDraftChange,
    onUpdateTerminalSettings,
}: AppearanceTerminalTypographySectionProps) {
    const recommendedTypography = resolveDefaultTerminalTypography();
    const recommendedFontStack = isWindows
        ? DEFAULT_TERMINAL_FONT_STACK_WIN32
        : DEFAULT_TERMINAL_FONT_STACK;
    const recommendedFontWeight = isWindows
        ? DEFAULT_TERMINAL_FONT_WEIGHT_WIN32
        : DEFAULT_TERMINAL_FONT_WEIGHT;

    const applyCustomFont = () => {
        const next = terminalFontDraft.trim();
        if (next) {
            onUpdateTerminalSettings({ fontFamily: next });
        }
    };

    return (
        <Section title="Monospace font">
            <div className="space-y-4">
                <div className="rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/40 p-4 space-y-3">
                    <Select
                        label="Font Family"
                        value={settings.terminal.fontFamily}
                        onChange={(value) => { onUpdateTerminalSettings({ fontFamily: value }); }}
                        options={[
                            {
                                value: recommendedFontStack,
                                label: isWindows ? 'Windows Monospace (Recommended)' : 'System Monospace (Recommended)',
                                description: isWindows
                                    ? 'Consolas and Cascadia Mono — heavier and clearer on Windows'
                                    : 'Best cross-platform default using built-in monospace fonts',
                            },
                            {
                                value: "'Fira Code', 'Fira Code VF', 'FiraCode Nerd Font', 'FiraCode NFM', 'Cascadia Code', Consolas, 'Courier New', monospace",
                                label: 'Fira Code',
                                description: 'Supports Fira Code + common Nerd Font variants',
                            },
                            {
                                value: "'JetBrains Mono', 'JetBrainsMono Nerd Font', 'JetBrainsMono NFM', 'Cascadia Mono', Consolas, 'Courier New', monospace",
                                label: 'JetBrains Mono',
                                description: 'Supports JetBrains Mono + common Nerd Font variants',
                            },
                            {
                                value: "Menlo, Monaco, Consolas, 'Courier New', monospace",
                                label: 'Menlo',
                                description: 'Uses Menlo on macOS; falls back to Monaco/Consolas on Windows',
                            },
                            { value: "'Courier New', monospace", label: 'Courier New', description: 'Classic typewriter' },
                        ]}
                        triggerClassName="bg-app-bg/50"
                    />
                    <div className="space-y-2">
                        <label
                            htmlFor="terminal-custom-font-stack-input"
                            className="text-xs font-semibold uppercase tracking-wide text-[var(--color-app-muted)]"
                        >
                            Custom Font Stack
                        </label>
                        <div className="grid grid-cols-[1fr_auto] gap-2 items-stretch">
                            <input
                                id="terminal-custom-font-stack-input"
                                type="text"
                                value={terminalFontDraft}
                                onChange={(e) => { onTerminalFontDraftChange(e.target.value); }}
                                onKeyDown={(e) => {
                                    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
                                        e.stopPropagation();
                                    }
                                    if (e.key === 'Enter') {
                                        applyCustomFont();
                                    }
                                }}
                                placeholder="e.g. 'Cascadia Code', Consolas, monospace"
                                className="w-full min-h-[44px] bg-[var(--color-app-bg)] border border-[var(--color-app-border)] rounded-lg px-3 py-2.5 text-[14px] font-mono text-[var(--color-app-text)] focus:outline-none focus:border-[var(--color-app-accent)]"
                            />
                            <button
                                type="button"
                                onClick={applyCustomFont}
                                className="min-w-[88px] px-4 py-2.5 rounded-lg text-sm font-semibold border border-[var(--color-app-border)] hover:bg-[var(--color-app-surface)]"
                            >
                                Apply
                            </button>
                        </div>
                    </div>
                </div>

                <div className="rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/40 p-4 space-y-4">
                    <Select
                        label="Font Weight"
                        value={String(settings.terminal.fontWeight ?? recommendedFontWeight)}
                        onChange={(value) => {
                            const fontWeight = value === 'normal'
                                ? 'normal'
                                : (Number(value) as TerminalFontWeightSetting);
                            onUpdateTerminalSettings({ fontWeight });
                        }}
                        options={TERMINAL_FONT_WEIGHT_OPTIONS.map((option) => ({
                            value: String(option.value),
                            label: option.label,
                            description: option.description,
                        }))}
                        triggerClassName="bg-app-bg/50"
                    />

                    <div className="space-y-2">
                        <div className="flex justify-between items-center">
                            <label
                                htmlFor="terminal-font-size-slider"
                                id="terminal-font-size-label"
                                className="text-sm font-medium text-[var(--color-app-text)]"
                            >
                                Font Size
                            </label>
                            <span className="text-sm text-[var(--color-app-accent)] font-mono">{settings.terminal.fontSize}px</span>
                        </div>
                        <input
                            id="terminal-font-size-slider"
                            type="range"
                            min="10"
                            max="24"
                            step="1"
                            aria-labelledby="terminal-font-size-label"
                            aria-valuetext={`${settings.terminal.fontSize} pixels`}
                            className="w-full accent-[var(--color-app-accent)] h-2 bg-[var(--color-app-surface)] rounded-lg appearance-none cursor-pointer"
                            value={settings.terminal.fontSize}
                            onChange={(e) => { onUpdateTerminalSettings({ fontSize: Number.parseInt(e.target.value, 10) }); }}
                        />
                    </div>

                    <div className="space-y-2">
                        <div className="flex justify-between items-center">
                            <label
                                htmlFor="terminal-internal-padding-slider"
                                id="terminal-internal-padding-label"
                                className="text-sm font-medium text-[var(--color-app-text)]"
                            >
                                Internal Padding
                            </label>
                            <span className="text-sm text-[var(--color-app-accent)] font-mono">{settings.terminal.padding ?? 12}px</span>
                        </div>
                        <input
                            id="terminal-internal-padding-slider"
                            type="range"
                            min="0"
                            max="48"
                            step="4"
                            aria-labelledby="terminal-internal-padding-label"
                            aria-valuetext={`${settings.terminal.padding ?? 12} pixels`}
                            className="w-full accent-[var(--color-app-accent)] h-2 bg-[var(--color-app-surface)] rounded-lg appearance-none cursor-pointer"
                            value={settings.terminal.padding ?? 12}
                            onChange={(e) => { onUpdateTerminalSettings({ padding: Number.parseInt(e.target.value, 10) }); }}
                        />
                    </div>

                    <div className="space-y-2">
                        <div className="flex justify-between items-center">
                            <label
                                htmlFor="terminal-line-height-slider"
                                id="terminal-line-height-label"
                                className="text-sm font-medium text-[var(--color-app-text)]"
                            >
                                Line Height
                            </label>
                            <span className="text-sm text-[var(--color-app-accent)] font-mono">{(settings.terminal.lineHeight ?? 1.2).toFixed(2)}</span>
                        </div>
                        <input
                            id="terminal-line-height-slider"
                            type="range"
                            min="1"
                            max="2"
                            step="0.05"
                            aria-labelledby="terminal-line-height-label"
                            aria-valuetext={(settings.terminal.lineHeight ?? 1.2).toFixed(2)}
                            className="w-full accent-[var(--color-app-accent)] h-2 bg-[var(--color-app-surface)] rounded-lg appearance-none cursor-pointer"
                            value={settings.terminal.lineHeight ?? 1.2}
                            onChange={(e) => { onUpdateTerminalSettings({ lineHeight: Number.parseFloat(e.target.value) }); }}
                        />
                    </div>

                    <Toggle
                        label="Font ligatures"
                        description="Programming ligatures when the selected font supports them."
                        checked={settings.terminal.fontLigatures ?? false}
                        onChange={(enabled) => { onUpdateTerminalSettings({ fontLigatures: enabled }); }}
                    />
                </div>

                <div className="text-[11px] leading-relaxed text-[var(--color-app-muted)] rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/30 px-3 py-2.5">
                    If a font looks unchanged, confirm it is installed. Weight changes need a multi-weight font —
                    for Fira Code use <span className="font-mono text-[var(--color-app-text)]/80">Fira Code VF</span>
                    {' '}or static Medium/SemiBold/Bold files. Single-weight Nerd Font builds ignore weight settings.
                </div>

                <div className="flex items-center justify-between rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/30 px-3 py-2.5">
                    <p className="text-[11px] text-[var(--color-app-muted)]">
                        Reset monospace font defaults.
                    </p>
                    <button
                        type="button"
                        onClick={() => {
                            onUpdateTerminalSettings({
                                fontFamily: recommendedTypography.fontFamily,
                                fontSize: recommendedTypography.fontSize,
                                fontWeight: recommendedTypography.fontWeight,
                                fontWeightBold: resolveTerminalFontWeightBold(recommendedTypography.fontWeight),
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
    );
}