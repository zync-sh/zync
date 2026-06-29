export type ThemeVariant = 'light' | 'dark';

const THEME_PLUGIN_PREFIX = 'com.zync.theme.';

const themeModes = new Map<string, ThemeVariant>();

function resolveSystemThemeMode(): ThemeVariant {
  if (typeof window === 'undefined') {
    return 'dark';
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Registers theme plugin ids → light/dark mode from plugin manifests. */
export function registerThemePluginModes(
  plugins: ReadonlyArray<{ manifest: { id: string; mode?: string | null } }>,
): void {
  themeModes.clear();

  for (const plugin of plugins) {
    const pluginId = plugin.manifest.id;
    if (!pluginId.startsWith(THEME_PLUGIN_PREFIX)) {
      continue;
    }

    const mode = plugin.manifest.mode;
    if (mode !== 'light' && mode !== 'dark') {
      continue;
    }

    const themeId = pluginId.slice(THEME_PLUGIN_PREFIX.length);
    themeModes.set(themeId, mode);
    themeModes.set(pluginId, mode);
  }
}

/** Resolves light/dark from the active settings theme id and registered manifests. */
export function resolveThemeModeFromRegistry(themeId: string | null | undefined): ThemeVariant | null {
  if (!themeId || themeId === 'system') {
    return resolveSystemThemeMode();
  }

  return themeModes.get(themeId) ?? null;
}