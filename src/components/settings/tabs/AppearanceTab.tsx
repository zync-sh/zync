import { useEffect, useState, type FocusEvent } from 'react';
import type { AppSettings } from '../../../store/settingsSlice';
import { useAppStore } from '../../../store/useAppStore';
import { getPluginCategory } from '../../editor/providers';
import { Select } from '../../ui/Select';
import { Section } from '../common/Section';
import { Toggle } from '../common/Toggle';
import { DEFAULT_GLOBAL_FONT_SIZE, DEFAULT_GLOBAL_FONT_STACK } from '../constants/defaults';

const THEME_PREFIX = 'com.zync.theme.';
const GLOBAL_FONT_SIZE_MIN = 10;
const GLOBAL_FONT_SIZE_MAX = 24;

interface PluginManifest {
    id: string;
    name: string;
    mode?: 'light' | 'dark';
    preview_bg?: string;
    preview_accent?: string;
}

interface ThemePlugin {
    manifest: PluginManifest;
}

interface AppearanceTabProps {
    settings: AppSettings;
    plugins: ThemePlugin[];
    globalFontDraft: string;
    setGlobalFontDraft: (value: string) => void;
    updateSettings: (updates: Partial<AppSettings>) => Promise<void>;
}

interface ThemeButtonProps {
    plugin: ThemePlugin;
    isSelected: boolean;
    onClick: () => void;
}

function getThemeId(pluginId: string) {
    return pluginId.replace(THEME_PREFIX, '');
}

function getThemeAccent(plugin: ThemePlugin | undefined, themeName: string): string {
    if (plugin?.manifest.preview_accent) return plugin.manifest.preview_accent;
    if (themeName === 'dark') return '#797bce';
    if (themeName === 'light') return '#6366f1';
    return 'var(--color-app-accent)';
}

function normalizeHexColor(value: string | null | undefined): string | null {
    if (!value) return null;
    const trimmed = value.trim();
    const shortMatch = /^#([0-9A-Fa-f]{3})$/.exec(trimmed);
    if (shortMatch) {
        const [r, g, b] = shortMatch[1].split('');
        return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
    }
    const fullMatch = /^#([0-9A-Fa-f]{6})$/.exec(trimmed);
    if (fullMatch) {
        return `#${fullMatch[1]}`.toLowerCase();
    }
    return null;
}

function ThemeButton({ plugin, isSelected, onClick }: ThemeButtonProps) {
    const themeId = getThemeId(plugin.manifest.id);
    const isLight = plugin.manifest.mode !== 'dark';

    return (
        <button
            onClick={onClick}
            className={`group p-4 rounded-xl border text-left flex items-center gap-4 transition-all relative overflow-hidden ${isSelected
                ? 'bg-[var(--color-app-bg)] border-[var(--color-app-accent)] ring-1 ring-[var(--color-app-accent)]'
                : 'bg-[var(--color-app-bg)]/40 border-[var(--color-app-border)] hover:bg-[var(--color-app-bg)]/60 hover:border-[var(--color-app-border)]'
                }`}
        >
            <div
                className={`w-12 h-12 rounded-lg shadow-inner flex items-center justify-center shrink-0 ${isLight ? 'border border-black/5' : 'border border-white/10'}`}
                style={{ background: plugin.manifest.preview_bg || (isLight ? '#ffffff' : '#000000') }}
            >
                <div className="w-3 h-3 rounded-full shadow-sm" style={{ backgroundColor: plugin.manifest.preview_accent || (isLight ? '#000000' : '#ffffff') }} />
            </div>
            <div>
                <div className="font-semibold text-[var(--color-app-text)] text-sm">{plugin.manifest.name.replace(' Theme', '')}</div>
                <div className="text-xs text-[var(--color-app-muted)] mt-0.5">{themeId === 'system' ? 'Auto-detect' : plugin.manifest.mode === 'dark' ? 'Dark' : 'Light'}</div>
            </div>
        </button>
    );
}

export function AppearanceTab({
    settings,
    plugins,
    globalFontDraft,
    setGlobalFontDraft,
    updateSettings
}: AppearanceTabProps) {
    const showToast = useAppStore((state) => state.showToast);
    const applyUpdate = async (updates: Partial<AppSettings>) => {
        try {
            await updateSettings(updates);
        } catch (error) {
            console.error('Failed to save appearance settings', error);
            const message = error instanceof Error ? error.message : String(error);
            showToast('error', `Failed to save appearance settings: ${message}`);
        }
    };

    const applyCustomFont = () => {
        const next = globalFontDraft.trim();
        if (!next) return;
        void applyUpdate({ globalFontFamily: next });
    };

    const themePlugins = plugins.filter(
        (p) => p.manifest.id !== 'com.zync.theme.manager' && getPluginCategory(p.manifest) === 'theme',
    );
    const lightPlugins = themePlugins.filter((p) => (p.manifest.mode ?? 'light') === 'light');
    const darkPlugins = themePlugins.filter((p) => p.manifest.mode === 'dark');
    const baseFontOptions = [
        {
            value: DEFAULT_GLOBAL_FONT_STACK,
            label: "System UI (Recommended)",
            description: "Best cross-platform default using built-in system fonts",
        },
        {
            value: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif",
            label: "Inter",
            description: "Inter first, then system fallback",
        },
        {
            value: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
            label: "Segoe UI",
            description: "Windows-native UI style",
        },
        {
            value: "'SF Pro Text', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif",
            label: "SF Pro / Apple",
            description: "Apple-style UI fallback stack",
        },
    ];
    const hasMatchingFontOption = baseFontOptions.some((option) => option.value === settings.globalFontFamily);
    const fontOptions = hasMatchingFontOption
        ? baseFontOptions
        : [
            {
                value: settings.globalFontFamily,
                label: "Custom",
                description: settings.globalFontFamily,
            },
            ...baseFontOptions,
        ];
    const activeThemePlugin = themePlugins.find((p) => p.manifest.id === `${THEME_PREFIX}${settings.theme}`);
    const themeAccent = getThemeAccent(activeThemePlugin, settings.theme);
    const normalizedAccentColor = normalizeHexColor(settings.accentColor);
    const normalizedThemeAccent = normalizeHexColor(themeAccent);
    const colorPickerValue = normalizedAccentColor ?? normalizedThemeAccent ?? '#6366f1';
    const [tempAccentColor, setTempAccentColor] = useState(colorPickerValue);
    useEffect(() => {
        setTempAccentColor(colorPickerValue);
    }, [colorPickerValue]);

    const commitAccentColor = () => {
        const normalizedTempAccentColor = normalizeHexColor(tempAccentColor);
        if (!normalizedTempAccentColor) {
            setTempAccentColor(colorPickerValue);
            return;
        }
        if (normalizedTempAccentColor === colorPickerValue) return;
        setTempAccentColor(normalizedTempAccentColor);
        void applyUpdate({ accentColor: normalizedTempAccentColor });
    };

    const clampedGlobalFontSize = Math.max(
        GLOBAL_FONT_SIZE_MIN,
        Math.min(GLOBAL_FONT_SIZE_MAX, settings.globalFontSize ?? DEFAULT_GLOBAL_FONT_SIZE),
    );
    const clampedOpacity = Math.min(1, Math.max(0.3, settings.windowOpacity ?? 1));
    const clampedPercent = Math.round(clampedOpacity * 100);
    const [draftGlobalFontSize, setDraftGlobalFontSize] = useState(clampedGlobalFontSize);
    const [draftOpacityPercent, setDraftOpacityPercent] = useState(clampedPercent);

    useEffect(() => {
        setDraftGlobalFontSize(clampedGlobalFontSize);
    }, [clampedGlobalFontSize]);

    useEffect(() => {
        setDraftOpacityPercent(clampedPercent);
    }, [clampedPercent]);

    const commitGlobalFontSize = () => {
        const next = Math.max(
            GLOBAL_FONT_SIZE_MIN,
            Math.min(GLOBAL_FONT_SIZE_MAX, Number.parseInt(String(draftGlobalFontSize), 10) || DEFAULT_GLOBAL_FONT_SIZE),
        );
        if (next === clampedGlobalFontSize) return;
        void applyUpdate({ globalFontSize: next });
    };

    const commitTerminalOpacity = () => {
        const nextPercent = Math.max(30, Math.min(100, Number.parseInt(String(draftOpacityPercent), 10) || 100));
        if (nextPercent === clampedPercent) return;
        void applyUpdate({ windowOpacity: nextPercent / 100 });
    };

    const handleColorInputBlur = (event: FocusEvent<HTMLInputElement>) => {
        const nextFocusedElement = event.relatedTarget as HTMLElement | null;
        if (nextFocusedElement?.getAttribute('aria-label')?.toLowerCase().includes('accent')) {
            return;
        }
        commitAccentColor();
    };

    return (
        <div className="space-y-6">
            <Section title="Theme">
                <div className="space-y-6">
                    <div className="space-y-3">
                        <h4 className="text-xs font-semibold text-[var(--color-app-muted)] uppercase tracking-wider pl-1">System default</h4>
                        <div className="grid grid-cols-2 gap-4">
                            <button
                                onClick={() => { void applyUpdate({ theme: 'system' }); }}
                                className={`group p-4 rounded-xl border text-left flex items-center gap-4 transition-all relative overflow-hidden ${settings.theme === 'system'
                                    ? 'bg-[var(--color-app-bg)] border-[var(--color-app-accent)] ring-1 ring-[var(--color-app-accent)]'
                                    : 'bg-[var(--color-app-bg)]/40 border-[var(--color-app-border)] hover:bg-[var(--color-app-bg)]/60 hover:border-[var(--color-app-border)]'
                                    }`}
                            >
                                <div
                                    className="w-12 h-12 rounded-lg shadow-inner flex items-center justify-center shrink-0 border border-white/10"
                                    style={{ background: 'linear-gradient(135deg, #09090b 50%, #ffffff 50%)' }}
                                >
                                    <div className="w-3 h-3 rounded-full shadow-sm" style={{ backgroundColor: '#6366f1' }} />
                                </div>
                                <div>
                                    <div className="font-semibold text-[var(--color-app-text)] text-sm">System</div>
                                    <div className="text-xs text-[var(--color-app-muted)] mt-0.5">Auto-detect</div>
                                </div>
                            </button>
                        </div>
                    </div>

                    <div className="h-px bg-[var(--color-app-border)]/20 my-2" />

                    <div className="space-y-3">
                        <h4 className="text-xs font-semibold text-[var(--color-app-muted)] uppercase tracking-wider pl-1">Light Themes</h4>
                        <div className="grid grid-cols-2 gap-4">
                            {lightPlugins.map((plugin) => (
                                <ThemeButton
                                    key={plugin.manifest.id}
                                    plugin={plugin}
                                    isSelected={settings.theme === getThemeId(plugin.manifest.id)}
                                    onClick={() => { void applyUpdate({ theme: getThemeId(plugin.manifest.id) }); }}
                                />
                            ))}
                        </div>
                    </div>

                    <div className="h-px bg-[var(--color-app-border)]/20 my-2" />

                    <div className="space-y-3">
                        <h4 className="text-xs font-semibold text-[var(--color-app-muted)] uppercase tracking-wider pl-1">Dark Themes</h4>
                        <div className="grid grid-cols-2 gap-4">
                            {darkPlugins.map((plugin) => (
                                <ThemeButton
                                    key={plugin.manifest.id}
                                    plugin={plugin}
                                    isSelected={settings.theme === getThemeId(plugin.manifest.id)}
                                    onClick={() => { void applyUpdate({ theme: getThemeId(plugin.manifest.id) }); }}
                                />
                            ))}
                        </div>
                    </div>
                </div>
            </Section>

            <div className="h-px bg-[var(--color-app-border)]/20 my-2" />

            <Section title="Typography">
                <div className="space-y-4 rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/40 p-4">
                    <Select
                        label="Global UI Font"
                        value={settings.globalFontFamily}
                        onChange={(val) => { void applyUpdate({ globalFontFamily: val }); }}
                        options={fontOptions}
                        triggerClassName="bg-app-bg/50"
                    />

                    <div className="space-y-2">
                        <label className="text-xs font-semibold uppercase tracking-wide text-[var(--color-app-muted)]">Custom UI Font Stack</label>
                        <div className="grid grid-cols-[1fr_auto] gap-2 items-stretch">
                            <input
                                type="text"
                                value={globalFontDraft}
                                onChange={(e) => setGlobalFontDraft(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
                                        e.stopPropagation();
                                    }
                                    if (e.key === 'Enter') {
                                        applyCustomFont();
                                    }
                                }}
                                placeholder="e.g. 'IBM Plex Sans', 'Segoe UI', sans-serif"
                                className="w-full min-h-[44px] bg-[var(--color-app-bg)] border border-[var(--color-app-border)] rounded-lg px-3 py-2.5 text-[14px] text-[var(--color-app-text)] focus:outline-none focus:border-[var(--color-app-accent)]"
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

                    <div className="space-y-2">
                        <div className="flex justify-between items-center">
                            <label className="text-sm font-medium text-[var(--color-app-text)]">Global Font Size</label>
                            <span className="text-sm text-[var(--color-app-accent)] font-mono">{draftGlobalFontSize}px</span>
                        </div>
                        <input
                            type="range"
                            min={GLOBAL_FONT_SIZE_MIN}
                            max={GLOBAL_FONT_SIZE_MAX}
                            step="1"
                            className="w-full accent-[var(--color-app-accent)] h-2 bg-[var(--color-app-surface)] rounded-lg appearance-none cursor-pointer"
                            value={draftGlobalFontSize}
                            onChange={(e) => {
                                const parsed = Number.parseInt(e.target.value, 10);
                                const clamped = Math.max(GLOBAL_FONT_SIZE_MIN, Math.min(GLOBAL_FONT_SIZE_MAX, Number.isFinite(parsed) ? parsed : GLOBAL_FONT_SIZE_MIN));
                                setDraftGlobalFontSize(clamped);
                            }}
                            onPointerUp={commitGlobalFontSize}
                            onKeyUp={commitGlobalFontSize}
                            onBlur={commitGlobalFontSize}
                        />
                        <div className="text-[11px] text-[var(--color-app-muted)]">
                            Changes app-wide UI text scale (menus, panels, labels, buttons).
                        </div>
                    </div>

                    <div className="text-[11px] leading-relaxed text-[var(--color-app-muted)] rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/30 px-3 py-2.5">
                        Note: Global UI font/size applies across the app interface. If a custom font looks unchanged, confirm it is installed on your system.
                    </div>

                    <div className="flex items-center justify-between rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/30 px-3 py-2.5">
                        <p className="text-[11px] text-[var(--color-app-muted)]">
                            Reset global UI typography to recommended defaults.
                        </p>
                        <button
                            type="button"
                            onClick={() => {
                                void applyUpdate({
                                    globalFontFamily: DEFAULT_GLOBAL_FONT_STACK,
                                    globalFontSize: DEFAULT_GLOBAL_FONT_SIZE,
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

            <Section title="Customization">
                <div className="space-y-4">
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <label className="text-sm font-medium text-[var(--color-app-text)] opacity-80">Accent Color</label>
                            {!settings.accentColor && (
                                <span className="text-[10px] bg-[var(--color-app-accent)]/10 text-[var(--color-app-accent)] px-1.5 py-0.5 rounded-full font-bold uppercase tracking-tighter border border-[var(--color-app-accent)]/20">Theme Default</span>
                            )}
                        </div>
                        <div className="flex gap-2 flex-wrap">
                            <button
                                onClick={() => { void applyUpdate({ accentColor: null }); }}
                                className={`w-8 h-8 rounded-full border-2 transition-all relative ${!settings.accentColor
                                    ? 'border-[var(--color-app-text)] scale-110 shadow-lg shadow-[var(--color-app-accent)]/20'
                                    : 'border-transparent hover:scale-110'
                                    }`}
                                title="Theme Default"
                                aria-label="Use theme default accent color"
                                type="button"
                            >
                                <div className="absolute inset-0.5 rounded-full" style={{ backgroundColor: themeAccent }} />
                            </button>

                            {['#6366f1', '#0969da', '#10b981', '#ef4444', '#f59e0b', '#8b5cf6', '#ec4899'].map(color => (
                                <button
                                    key={color}
                                    onClick={() => { void applyUpdate({ accentColor: color }); }}
                                    className={`w-8 h-8 rounded-full border-2 transition-all ${settings.accentColor === color
                                        ? 'border-[var(--color-app-text)] scale-110'
                                        : 'border-transparent hover:scale-110'
                                        }`}
                                    style={{ backgroundColor: color }}
                                    title={`Accent ${color}`}
                                    aria-label={`Select accent color ${color}`}
                                    type="button"
                                />
                            ))}
                            <input
                                type="color"
                                value={tempAccentColor}
                                onChange={(e) => { setTempAccentColor(e.target.value); }}
                                onBlur={handleColorInputBlur}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') {
                                        commitAccentColor();
                                    }
                                }}
                                className="w-8 h-8 rounded-lg overflow-hidden border-0 p-0 cursor-pointer"
                                title="Custom accent color"
                                aria-label="Choose custom accent color"
                            />
                        </div>
                    </div>

                    <div className="space-y-3 pt-4 border-t border-[var(--color-app-border)]/50">
                        <div className="flex justify-between">
                            <label className="text-sm font-medium text-[var(--color-app-text)] opacity-80">Terminal Opacity</label>
                            <span className="text-sm text-[var(--color-app-accent)] font-mono">{draftOpacityPercent}%</span>
                        </div>
                        <input
                            type="range" min="30" max="100" step="1"
                            className="w-full accent-[var(--color-app-accent)] h-2 bg-[var(--color-app-surface)] rounded-lg appearance-none cursor-pointer"
                            value={draftOpacityPercent}
                            onChange={(e) => {
                                const parsed = Number.parseInt(e.target.value, 10);
                                const clamped = Math.max(30, Math.min(100, Number.isFinite(parsed) ? parsed : 30));
                                setDraftOpacityPercent(clamped);
                            }}
                            onPointerUp={commitTerminalOpacity}
                            onKeyUp={commitTerminalOpacity}
                            onBlur={commitTerminalOpacity}
                        />
                        <div className="text-xs text-[var(--color-app-muted)]">
                            100% keeps the terminal solid. Lower values let the desktop show through the terminal viewport only.
                        </div>
                    </div>
                </div>
            </Section>

            <div className="h-px bg-[var(--color-app-border)]/20 my-2" />

            <Section title="Interface">
                <div className="space-y-2 rounded-lg border border-[var(--color-app-border)]/50 bg-[var(--color-app-surface)]/50 p-1">
                    <Toggle
                        label="Compact Mode"
                        description="Reduce spacing for denser UI."
                        checked={settings.compactMode}
                        onChange={(checked) => { void applyUpdate({ compactMode: checked }); }}
                    />
                    <Toggle
                        label="Terminal Transparency"
                        description="Reveal the desktop behind the terminal viewport only."
                        checked={settings.enableVibrancy}
                        onChange={(checked) => { void applyUpdate({ enableVibrancy: checked }); }}
                    />
                </div>
            </Section>
        </div>
    );
}
