import { useEffect, useMemo, useRef, useState, type FocusEvent } from 'react';
import type { AppSettings } from '../../../store/settingsSlice';
import { useAppStore } from '../../../store/useAppStore';
import { getPluginCategory } from '../../editor/providers';
import { SegmentedControl } from '../common/SegmentedControl';
import { DEFAULT_GLOBAL_FONT_SIZE, DEFAULT_GLOBAL_FONT_STACK } from '../constants/defaults';
import { AppearanceColorsPanel } from './appearance/AppearanceColorsPanel';
import { AppearanceInterfaceSection } from './appearance/AppearanceInterfaceSection';
import { AppearanceInterfaceTypographySection } from './appearance/AppearanceInterfaceTypographySection';
import { AppearanceTerminalColorsNotice } from './appearance/AppearanceTerminalColorsNotice';
import { AppearanceTerminalTypographySection } from './appearance/AppearanceTerminalTypographySection';
import { AppearanceTerminalViewportSection } from './appearance/AppearanceTerminalViewportSection';
import {
    getThemeAccent,
    normalizeHexColor,
    resolveAccentThemeName,
    resolveThemePluginId,
    type ThemePlugin,
} from './appearance/themeHelpers';
import type { AppearanceView } from './appearance/types';

const GLOBAL_FONT_SIZE_MIN = 10;
const GLOBAL_FONT_SIZE_MAX = 24;

const APPEARANCE_VIEWS = [
    { key: 'app' as const, label: 'App' },
    { key: 'terminal' as const, label: 'Terminal' },
];

const APP_THEME_HINT = 'App-wide theme and accent — sidebar, panels, controls, and terminal ANSI colors.';

interface AppearanceTabProps {
    settings: AppSettings;
    plugins: ThemePlugin[];
    globalFontDraft: string;
    setGlobalFontDraft: (value: string) => void;
    terminalFontDraft: string;
    setTerminalFontDraft: (value: string) => void;
    isWindows: boolean;
    updateSettings: (updates: Partial<AppSettings>) => Promise<void>;
    updateTerminalSettings: (updates: Partial<AppSettings['terminal']>) => Promise<void>;
    activeView: AppearanceView;
    onActiveViewChange: (view: AppearanceView) => void;
}

export function AppearanceTab({
    settings,
    plugins,
    globalFontDraft,
    setGlobalFontDraft,
    terminalFontDraft,
    setTerminalFontDraft,
    isWindows,
    updateSettings,
    updateTerminalSettings,
    activeView,
    onActiveViewChange,
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

    const themePlugins = useMemo(
        () => plugins.filter(
            (plugin) => plugin.manifest.id !== 'com.zync.theme.manager'
                && getPluginCategory(plugin.manifest) === 'theme',
        ),
        [plugins],
    );
    const lightPlugins = useMemo(
        () => themePlugins.filter((plugin) => (plugin.manifest.mode ?? 'light') === 'light'),
        [themePlugins],
    );
    const darkPlugins = useMemo(
        () => themePlugins.filter((plugin) => plugin.manifest.mode === 'dark'),
        [themePlugins],
    );

    const resolveThemeAccent = (themeId: string) => {
        const pluginId = resolveThemePluginId(themeId);
        const plugin = themePlugins.find((entry) => entry.manifest.id === pluginId);
        return getThemeAccent(plugin, resolveAccentThemeName(themeId));
    };

    const themeAccent = resolveThemeAccent(settings.theme);
    const normalizedAccentColor = normalizeHexColor(settings.accentColor);
    const normalizedThemeAccent = normalizeHexColor(themeAccent);
    const colorPickerValue = normalizedAccentColor ?? normalizedThemeAccent ?? '#6366f1';
    const [tempAccentColor, setTempAccentColor] = useState(colorPickerValue);

    useEffect(() => {
        setTempAccentColor(colorPickerValue);
    }, [colorPickerValue]);

    const selectTheme = (themeId: string) => {
        const normalized = normalizeHexColor(resolveThemeAccent(themeId)) ?? '#6366f1';
        setTempAccentColor(normalized);
        void applyUpdate({ theme: themeId, accentColor: null });
    };

    const commitAccentColor = () => {
        const normalizedTempAccentColor = normalizeHexColor(tempAccentColor);
        if (!normalizedTempAccentColor) {
            setTempAccentColor(colorPickerValue);
            return;
        }
        const themeDefaultAccent = normalizeHexColor(resolveThemeAccent(settings.theme)) ?? '#6366f1';
        if (!settings.accentColor && normalizedTempAccentColor === themeDefaultAccent) {
            setTempAccentColor(themeDefaultAccent);
            return;
        }
        if (normalizedTempAccentColor === colorPickerValue) {
            return;
        }
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
    const lastSubmittedGlobalFontSizeRef = useRef<number | null>(null);
    const lastSubmittedOpacityPercentRef = useRef<number | null>(null);

    useEffect(() => {
        setDraftGlobalFontSize(clampedGlobalFontSize);
        if (lastSubmittedGlobalFontSizeRef.current === clampedGlobalFontSize) {
            lastSubmittedGlobalFontSizeRef.current = null;
        }
    }, [clampedGlobalFontSize]);

    useEffect(() => {
        setDraftOpacityPercent(clampedPercent);
        if (lastSubmittedOpacityPercentRef.current === clampedPercent) {
            lastSubmittedOpacityPercentRef.current = null;
        }
    }, [clampedPercent]);

    const commitGlobalFontSize = () => {
        const next = Math.max(
            GLOBAL_FONT_SIZE_MIN,
            Math.min(GLOBAL_FONT_SIZE_MAX, Number.parseInt(String(draftGlobalFontSize), 10) || DEFAULT_GLOBAL_FONT_SIZE),
        );
        if (next === clampedGlobalFontSize) {
            setDraftGlobalFontSize(next);
            lastSubmittedGlobalFontSizeRef.current = null;
            return;
        }
        if (next === lastSubmittedGlobalFontSizeRef.current) {
            setDraftGlobalFontSize(next);
            return;
        }
        lastSubmittedGlobalFontSizeRef.current = next;
        void applyUpdate({ globalFontSize: next });
    };

    const commitTerminalOpacity = () => {
        const nextPercent = Math.max(30, Math.min(100, Number.parseInt(String(draftOpacityPercent), 10) || 100));
        if (nextPercent === clampedPercent) {
            setDraftOpacityPercent(nextPercent);
            lastSubmittedOpacityPercentRef.current = null;
            return;
        }
        if (nextPercent === lastSubmittedOpacityPercentRef.current) {
            setDraftOpacityPercent(nextPercent);
            return;
        }
        lastSubmittedOpacityPercentRef.current = nextPercent;
        void applyUpdate({ windowOpacity: nextPercent / 100 });
    };

    const handleColorInputBlur = (event: FocusEvent<HTMLInputElement>) => {
        const nextFocusedElement = event.relatedTarget as HTMLElement | null;
        if (nextFocusedElement?.getAttribute('aria-label')?.toLowerCase().includes('accent')) {
            return;
        }
        commitAccentColor();
    };

    const appPanel = (
        <>
            <AppearanceColorsPanel
                sectionTitle="Theme"
                hint={APP_THEME_HINT}
                settings={settings}
                lightPlugins={lightPlugins}
                darkPlugins={darkPlugins}
                themeAccent={themeAccent}
                tempAccentColor={tempAccentColor}
                onSelectTheme={selectTheme}
                onTempAccentColorChange={setTempAccentColor}
                onSelectPresetAccent={(color) => { void applyUpdate({ accentColor: color }); }}
                onCommitAccentColor={commitAccentColor}
                onColorInputBlur={handleColorInputBlur}
            />
            <div className="h-px bg-[var(--color-app-border)]/20 my-2" />
            <AppearanceInterfaceTypographySection
                settings={settings}
                globalFontDraft={globalFontDraft}
                draftGlobalFontSize={draftGlobalFontSize}
                onGlobalFontDraftChange={setGlobalFontDraft}
                onApplyCustomFont={() => {
                    const next = globalFontDraft.trim();
                    if (next) {
                        void applyUpdate({ globalFontFamily: next });
                    }
                }}
                onGlobalFontFamilyChange={(value) => { void applyUpdate({ globalFontFamily: value }); }}
                onDraftGlobalFontSizeChange={setDraftGlobalFontSize}
                onCommitGlobalFontSize={commitGlobalFontSize}
                onResetTypography={() => {
                    void applyUpdate({
                        globalFontFamily: DEFAULT_GLOBAL_FONT_STACK,
                        globalFontSize: DEFAULT_GLOBAL_FONT_SIZE,
                    });
                }}
            />
            <div className="h-px bg-[var(--color-app-border)]/20 my-2" />
            <AppearanceInterfaceSection
                compactMode={settings.compactMode}
                onCompactModeChange={(checked) => { void applyUpdate({ compactMode: checked }); }}
            />
        </>
    );

    const terminalPanel = (
        <>
            <AppearanceTerminalColorsNotice onOpenAppTheme={() => { onActiveViewChange('app'); }} />
            <div className="h-px bg-[var(--color-app-border)]/20 my-2" />
            <AppearanceTerminalTypographySection
                settings={settings}
                terminalFontDraft={terminalFontDraft}
                isWindows={isWindows}
                onTerminalFontDraftChange={setTerminalFontDraft}
                onUpdateTerminalSettings={(updates) => { void updateTerminalSettings(updates); }}
            />
            <div className="h-px bg-[var(--color-app-border)]/20 my-2" />
            <AppearanceTerminalViewportSection
                settings={settings}
                draftOpacityPercent={draftOpacityPercent}
                onDraftOpacityPercentChange={setDraftOpacityPercent}
                onCommitTerminalOpacity={commitTerminalOpacity}
                onTransparencyChange={(checked) => { void applyUpdate({ enableVibrancy: checked }); }}
                onCursorStyleChange={(style) => { void updateTerminalSettings({ cursorStyle: style }); }}
            />
        </>
    );

    return (
        <div className="space-y-6 animate-in fade-in duration-300">
            <SegmentedControl
                options={APPEARANCE_VIEWS}
                value={activeView}
                onChange={onActiveViewChange}
                ariaLabel="Appearance scope"
                idPrefix="appearance"
            />

            <div
                role="tabpanel"
                id="appearance-panel-app"
                aria-labelledby="appearance-tab-app"
                hidden={activeView !== 'app'}
                inert={activeView !== 'app' ? true : undefined}
                className="space-y-6"
            >
                {appPanel}
            </div>

            <div
                role="tabpanel"
                id="appearance-panel-terminal"
                aria-labelledby="appearance-tab-terminal"
                hidden={activeView !== 'terminal'}
                inert={activeView !== 'terminal' ? true : undefined}
                className="space-y-6"
            >
                {terminalPanel}
            </div>
        </div>
    );
}