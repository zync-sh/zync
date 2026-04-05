import type { LightEditorThemeColors, LightEditorThemeId, LightEditorThemeTokens } from './types.js';

export const LIGHT_EDITOR_THEME_OPTIONS: ReadonlyArray<{
  id: LightEditorThemeId;
  label: string;
  description: string;
}> = [
  { id: 'system', label: 'System', description: 'Match the current Zync/system theme' },
  { id: 'zync-dark', label: 'Zync Dark', description: 'Use the current dark Zync palette' },
  { id: 'zync-light', label: 'Zync Light', description: 'Use the current light Zync palette' },
  { id: 'editor-midnight', label: 'Midnight', description: 'A cooler editor-only dark theme' },
  { id: 'editor-warm', label: 'Warm', description: 'A warmer editor-only dark theme' },
] as const;

export function resolveLightEditorThemeId(appTheme: string, bodyTheme: string | null): LightEditorThemeId {
  if (appTheme === 'system') return 'system';
  if (bodyTheme === 'light' || appTheme === 'light' || appTheme === 'light-warm') return 'zync-light';
  return 'zync-dark';
}

export function buildLightEditorThemeTokens(colors: LightEditorThemeColors): LightEditorThemeTokens {
  return {
    '--editor-background': colors.background,
    '--editor-panel': colors.panel,
    '--editor-surface': colors.surface,
    '--editor-border': colors.border,
    '--editor-text': colors.text,
    '--editor-muted': colors.muted,
    '--editor-accent': colors.accent,
    '--editor-accent-soft': `color-mix(in srgb, ${colors.accent} 14%, transparent)`,
    '--editor-active-line': `color-mix(in srgb, ${colors.text} 3.5%, ${colors.background})`,
    '--editor-search-match': `color-mix(in srgb, ${colors.accent} 10%, transparent)`,
    '--editor-search-match-active': `color-mix(in srgb, ${colors.accent} 16%, transparent)`,
  };
}

export function getEditorThemeColors(themeId: LightEditorThemeId, appColors: LightEditorThemeColors): LightEditorThemeColors {
  if (themeId === 'editor-midnight') {
    return {
      background: '#07111e',
      panel: '#0f1727',
      surface: '#152033',
      border: '#21314a',
      text: '#dbe9ff',
      muted: '#8ca4c6',
      accent: appColors.accent || '#6d8cff',
    };
  }

  if (themeId === 'editor-warm') {
    return {
      background: '#15110d',
      panel: '#201914',
      surface: '#2b221b',
      border: '#3c2f25',
      text: '#f2e8dc',
      muted: '#b9a693',
      accent: appColors.accent || '#c78f55',
    };
  }

  return appColors;
}
