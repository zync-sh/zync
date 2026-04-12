export type ZyncThemeMode = 'light' | 'dark';

export interface ZyncThemeColors {
  background: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  primary: string;
}

export interface ZyncThemePayload {
  /**
   * Payload version for forward-compatible host → plugin theming.
   * Plugins should treat unknown versions as best-effort.
   */
  version: 1;
  mode: ZyncThemeMode;
  colors: ZyncThemeColors;
  /**
   * The currently-selected theme id/name in Zync settings.
   * This is not necessarily equal to mode (light/dark).
   */
  themeId?: string;
}

/**
 * Read the currently-applied Zync theme colors from CSS variables.
 *
 * This is the canonical source of truth for host → plugin theming.
 * Keep this small and stable; editor-provider + panel plugins can rely on it.
 */
function parseCssColorToRgb(color: string): { r: number; g: number; b: number } | null {
  const normalized = color.trim();
  const hex = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const raw = hex[1].length === 3
      ? hex[1].split('').map((c) => c + c).join('')
      : hex[1];
    const r = Number.parseInt(raw.slice(0, 2), 16);
    const g = Number.parseInt(raw.slice(2, 4), 16);
    const b = Number.parseInt(raw.slice(4, 6), 16);
    return { r, g, b };
  }

  const rgb = normalized.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    // Accept both legacy comma syntax: rgb(10, 20, 30)
    // and modern space + optional alpha syntax: rgb(10 20 30 / 0.5)
    const inner = rgb[1].trim().replace(/,/g, ' ');
    const tokens = inner
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .flatMap((t) => t.split('/').map((x) => x.trim()).filter(Boolean));

    if (tokens.length >= 3) {
      const parseChannel = (raw: string) => {
        const value = raw.trim();
        if (value.endsWith('%')) {
          const p = Number.parseFloat(value.slice(0, -1));
          if (!Number.isFinite(p)) return NaN;
          return (p / 100) * 255;
        }
        return Number.parseFloat(value);
      };

      const r = parseChannel(tokens[0]);
      const g = parseChannel(tokens[1]);
      const b = parseChannel(tokens[2]);
      if ([r, g, b].every((v) => Number.isFinite(v))) return { r, g, b };
    }
  }

  return null;
}

function readCssVar(style: CSSStyleDeclaration, names: string[], fallback: string): string {
  for (const name of names) {
    const value = style.getPropertyValue(name).trim();
    if (value) return value;
  }
  return fallback;
}

function readCssVarFrom(
  primary: CSSStyleDeclaration,
  secondary: CSSStyleDeclaration,
  names: string[],
  fallback: string
): string {
  const first = readCssVar(primary, names, '');
  if (first) return first;
  const second = readCssVar(secondary, names, '');
  if (second) return second;
  return fallback;
}

function relativeLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
  // sRGB -> linear
  const toLinear = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const R = toLinear(r);
  const G = toLinear(g);
  const B = toLinear(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

export function resolveZyncThemeMode(): ZyncThemeMode {
  // Prefer explicit app signal if present.
  const dataTheme = document.body.getAttribute('data-theme');
  if (dataTheme === 'light' || dataTheme === 'dark') return dataTheme;

  // Some Zync themes mark mode via body classes.
  const classes = document.body.classList;
  if (classes.contains('light') || classes.contains('light-warm')) return 'light';
  if (classes.contains('dark') || classes.contains('dark-warm')) return 'dark';

  // Fallback: infer from effective background luminance.
  // NOTE: Zync applies theme variables on <body> (see MainLayout). Reading from
  // :root can yield empty values depending on how the CSS is authored.
  const bodyStyle = getComputedStyle(document.body);
  const rootStyle = getComputedStyle(document.documentElement);
  const bg = readCssVarFrom(bodyStyle, rootStyle, ['--color-app-bg', '--app-bg'], '#0f111a');
  const rgb = parseCssColorToRgb(bg);
  if (!rgb) return 'dark';
  return relativeLuminance(rgb) > 0.55 ? 'light' : 'dark';
}

export function getZyncThemePayload(themeId?: string): ZyncThemePayload {
  const mode = resolveZyncThemeMode();
  const bodyStyle = getComputedStyle(document.body);
  const rootStyle = getComputedStyle(document.documentElement);
  return {
    version: 1,
    mode,
    colors: {
      background: readCssVarFrom(bodyStyle, rootStyle, ['--color-app-bg', '--app-bg'], '#0f111a'),
      surface: readCssVarFrom(
        bodyStyle,
        rootStyle,
        ['--color-app-surface', '--color-app-panel', '--app-surface'],
        '#1a1d2e'
      ),
      border: readCssVarFrom(bodyStyle, rootStyle, ['--color-app-border', '--app-border'], 'rgba(255,255,255,0.08)'),
      text: readCssVarFrom(bodyStyle, rootStyle, ['--color-app-text', '--app-text'], '#e2e8f0'),
      muted: readCssVarFrom(bodyStyle, rootStyle, ['--color-app-muted', '--app-muted'], '#94a3b8'),
      primary: readCssVarFrom(bodyStyle, rootStyle, ['--color-app-accent', '--app-accent'], '#6366f1'),
    },
    themeId,
  };
}
