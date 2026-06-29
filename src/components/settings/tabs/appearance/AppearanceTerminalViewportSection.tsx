import type { AppSettings } from '../../../../store/settingsSlice';
import { Section } from '../../common/Section';
import { Toggle } from '../../common/Toggle';

const CURSOR_STYLES = ['block', 'bar', 'underline'] as const;

export interface AppearanceTerminalViewportSectionProps {
    settings: AppSettings;
    draftOpacityPercent: number;
    onDraftOpacityPercentChange: (value: number) => void;
    onCommitTerminalOpacity: () => void;
    onTransparencyChange: (enabled: boolean) => void;
    onCursorStyleChange: (style: AppSettings['terminal']['cursorStyle']) => void;
}

export function AppearanceTerminalViewportSection({
    settings,
    draftOpacityPercent,
    onDraftOpacityPercentChange,
    onCommitTerminalOpacity,
    onTransparencyChange,
    onCursorStyleChange,
}: AppearanceTerminalViewportSectionProps) {
    return (
        <Section title="Viewport">
            <div className="space-y-4 rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/40 p-4">
                <p className="text-[11px] leading-relaxed text-[var(--color-app-muted)]">
                    Opacity and transparency only affect how see-through the terminal panel is.
                    Colors follow the app theme (Appearance → App), not these controls.
                </p>

                <div className="space-y-3">
                    <div className="flex justify-between">
                        <label
                            htmlFor="terminal-opacity-slider"
                            id="terminal-opacity-label"
                            className="text-sm font-medium text-[var(--color-app-text)]"
                        >
                            Opacity
                        </label>
                        <span className="text-sm text-[var(--color-app-accent)] font-mono">{draftOpacityPercent}%</span>
                    </div>
                    <input
                        id="terminal-opacity-slider"
                        type="range"
                        min="30"
                        max="100"
                        step="1"
                        aria-labelledby="terminal-opacity-label"
                        aria-valuetext={`${draftOpacityPercent} percent`}
                        className="w-full accent-[var(--color-app-accent)] h-2 bg-[var(--color-app-surface)] rounded-lg appearance-none cursor-pointer"
                        value={draftOpacityPercent}
                        onChange={(e) => {
                            const parsed = Number.parseInt(e.target.value, 10);
                            const clamped = Math.max(30, Math.min(100, Number.isFinite(parsed) ? parsed : 30));
                            onDraftOpacityPercentChange(clamped);
                        }}
                        onPointerUp={onCommitTerminalOpacity}
                        onKeyUp={onCommitTerminalOpacity}
                        onBlur={onCommitTerminalOpacity}
                    />
                    <div className="text-[11px] text-[var(--color-app-muted)]">
                        100% is fully solid. Lower values let the desktop show through the terminal area only.
                    </div>
                </div>

                <Toggle
                    label="Desktop transparency"
                    description="Reveal the desktop behind the terminal viewport (requires opacity below 100%)."
                    checked={settings.enableVibrancy}
                    onChange={onTransparencyChange}
                />

                <div className="space-y-2 pt-2 border-t border-[var(--color-app-border)]/50">
                    <span id="terminal-cursor-style-label" className="text-sm font-medium text-[var(--color-app-text)]">
                        Cursor style
                    </span>
                    <div
                        className="grid grid-cols-3 gap-3"
                        role="group"
                        aria-labelledby="terminal-cursor-style-label"
                    >
                        {CURSOR_STYLES.map((style) => (
                            <button
                                key={style}
                                type="button"
                                aria-pressed={settings.terminal.cursorStyle === style}
                                aria-label={`${style} cursor`}
                                onClick={() => { onCursorStyleChange(style); }}
                                className={`p-3 rounded-lg border flex flex-col items-center gap-2 transition-all h-28 justify-center ${settings.terminal.cursorStyle === style
                                    ? 'bg-[var(--color-app-accent)]/20 border-[var(--color-app-accent)] text-[var(--color-app-text)] ring-1 ring-[var(--color-app-accent)]'
                                    : 'border-[var(--color-app-border)] hover:bg-[var(--color-app-surface)] text-[var(--color-app-muted)]'
                                    }`}
                            >
                                <div className="h-10 w-20 bg-black/20 rounded border border-[var(--color-app-border)] flex items-center justify-center relative overflow-hidden font-mono text-xs">
                                    <span className="text-[var(--color-app-muted)]">_</span>
                                    <div className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-[var(--color-app-accent)]
                                        ${style === 'underline' ? 'h-0.5 w-2 mt-2' : style === 'bar' ? 'w-0.5 h-4' : 'w-2 h-4'}
                                    `} />
                                </div>
                                <span className="capitalize text-xs font-medium">{style}</span>
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        </Section>
    );
}