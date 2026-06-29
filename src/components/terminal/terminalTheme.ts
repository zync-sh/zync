import type { CSSProperties } from 'react';
import type { ITheme, Terminal } from '@xterm/xterm';
import { LOCAL_TERMINAL_CONNECTION_ID } from '../../lib/terminal/connectionIds.js';
import { resolveZyncThemeMode } from '../../lib/themePayload.js';
import { terminalCache } from '../../lib/terminal/terminalCache.js';
import { useAppStore } from '../../store/useAppStore';

export const THEME_PRESETS: Record<string, Record<string, string>> = {
  red: { background: '#1a0b0b', cursor: '#ef4444', selectionBackground: 'rgba(239, 68, 68, 0.3)' },
  blue: { background: '#0b101a', cursor: '#3b82f6', selectionBackground: 'rgba(59, 130, 246, 0.3)' },
  green: { background: '#0b1a10', cursor: '#10b981', selectionBackground: 'rgba(16, 185, 129, 0.3)' },
  orange: { background: '#1a120b', cursor: '#f97316', selectionBackground: 'rgba(249, 115, 22, 0.3)' },
  purple: { background: '#160b1a', cursor: '#d946ef', selectionBackground: 'rgba(217, 70, 239, 0.3)' },
};

export type TerminalTransparencySettings = {
  enableVibrancy?: boolean;
  windowOpacity?: number;
};

export interface TerminalTransparencyState {
  enabled: boolean;
  opacity: number;
}

/** Returns true when the active app theme has a light background. */
export function isLightTheme(): boolean {
  return resolveZyncThemeMode() === 'light';
}

export function resolveTerminalTransparency(settings: TerminalTransparencySettings): TerminalTransparencyState {
  const opacity = Math.max(0, Math.min(1, settings.windowOpacity ?? 1));
  return {
    enabled: Boolean(settings.enableVibrancy) && opacity < 1,
    opacity: Boolean(settings.enableVibrancy) ? opacity : 1,
  };
}

export function withAlpha(color: string, alpha: number): string {
  const clampedAlpha = Math.max(0, Math.min(1, alpha));
  if (clampedAlpha <= 0) return 'rgba(0, 0, 0, 0)';
  if (!color) return `rgba(15, 17, 26, ${clampedAlpha})`;

  const normalized = color.trim();
  const hexMatch = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hexMatch) {
    const hex = hexMatch[1].length === 3
      ? hexMatch[1].split('').map(ch => ch + ch).join('')
      : hexMatch[1];
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${clampedAlpha})`;
  }

  const rgbMatch = normalized.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbMatch) {
    const channels = rgbMatch[1].split(',').map(part => part.trim());
    if (channels.length >= 3) {
      return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${clampedAlpha})`;
    }
  }

  if (clampedAlpha >= 1) {
    return normalized;
  }

  const fallbackRgb = isLightTheme() ? '248, 250, 252' : '15, 17, 26';
  return `rgba(${fallbackRgb}, ${clampedAlpha})`;
}

export function buildTerminalHostBackground(opacity: number): string {
  const clampedPercent = Math.max(0, Math.min(100, Math.round(opacity * 100)));
  return `color-mix(in srgb, var(--color-app-bg) ${clampedPercent}%, transparent)`;
}

export function buildTerminalHostStyle(transparency: TerminalTransparencyState): CSSProperties | undefined {
  if (!transparency.enabled) {
    return undefined;
  }

  return {
    backgroundColor: 'var(--color-app-bg)',
    background: buildTerminalHostBackground(transparency.opacity),
  };
}

function buildTerminalBackground(appBg: string, opacity: number, useHostBackground = false): string {
  if (useHostBackground) {
    return 'rgba(0, 0, 0, 0)';
  }

  const light = isLightTheme();
  const fallback = light ? '#f8fafc' : '#0f111a';
  return withAlpha(appBg || fallback, opacity);
}

function mergeTerminalThemePreset(
  theme: ITheme,
  preset: Record<string, string>,
  transparencyEnabled: boolean,
  opacity: number,
): ITheme {
  if (!transparencyEnabled) {
    return { ...theme, ...preset };
  }

  const merged = { ...theme, ...preset };
  if (preset.background) {
    merged.background = withAlpha(preset.background, opacity);
  }

  return merged;
}

function parseColorToRgb(color: string): { r: number; g: number; b: number } | null {
  const normalized = color.trim();
  if (!normalized) return null;

  const hexMatch = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3) {
      hex = hex.split('').map(ch => ch + ch).join('');
    }
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }

  const rgbMatch = normalized.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (rgbMatch) {
    return {
      r: Math.round(Number(rgbMatch[1])),
      g: Math.round(Number(rgbMatch[2])),
      b: Math.round(Number(rgbMatch[3])),
    };
  }

  return null;
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function blendWithWhite(color: string, ratio: number): string {
  const rgb = parseColorToRgb(color);
  if (!rgb) {
    return color || '#fcd34d';
  }
  const blendR = Math.round(rgb.r * ratio + 255 * (1 - ratio));
  const blendG = Math.round(rgb.g * ratio + 255 * (1 - ratio));
  const blendB = Math.round(rgb.b * ratio + 255 * (1 - ratio));
  return rgbToHex(blendR, blendG, blendB);
}

function blendWithBlack(color: string, ratio: number): string {
  const rgb = parseColorToRgb(color);
  if (!rgb) {
    return color || '#92400e';
  }
  const blendR = Math.round(rgb.r * ratio);
  const blendG = Math.round(rgb.g * ratio);
  const blendB = Math.round(rgb.b * ratio);
  return rgbToHex(blendR, blendG, blendB);
}

/** xterm "bright" ANSI slots use light pastels on dark backgrounds; light themes need saturated colors. */
function buildAnsiPalette(light: boolean, appAccent: string): Pick<
  ITheme,
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'brightBlack'
  | 'brightRed'
  | 'brightGreen'
  | 'brightYellow'
  | 'brightBlue'
  | 'brightMagenta'
  | 'brightCyan'
  | 'brightWhite'
> {
  if (light) {
    return {
      black: '#3f3f46',
      red: '#dc2626',
      green: '#15803d',
      yellow: appAccent ? blendWithBlack(appAccent, 0.72) : '#b45309',
      blue: '#2563eb',
      magenta: '#a21caf',
      cyan: '#0e7490',
      white: '#18181b',
      brightBlack: '#52525b',
      brightRed: '#b91c1c',
      brightGreen: '#166534',
      brightYellow: appAccent ? blendWithBlack(appAccent, 0.58) : '#92400e',
      brightBlue: '#1e40af',
      brightMagenta: '#86198f',
      brightCyan: '#155e75',
      brightWhite: '#09090b',
    };
  }

  return {
    black: '#000000',
    red: '#ef4444',
    green: '#10b981',
    yellow: appAccent || '#d97706',
    blue: '#3b82f6',
    magenta: '#d946ef',
    cyan: '#0891b2',
    white: '#ffffff',
    brightBlack: '#64748b',
    brightRed: '#fca5a5',
    brightGreen: '#86efac',
    brightYellow: appAccent ? blendWithWhite(appAccent, 0.8) : '#fcd34d',
    brightBlue: '#93c5fd',
    brightMagenta: '#f0abfc',
    brightCyan: '#67e8f9',
    brightWhite: '#f8fafc',
  };
}

export function buildXtermTheme(
  appBg: string,
  appText: string,
  appAccent: string,
  backgroundOpacity = 1,
  useHostBackground = false,
): ITheme {
  const light = isLightTheme();
  return {
    background: buildTerminalBackground(appBg, backgroundOpacity, useHostBackground),
    foreground: appText || (light ? '#18181b' : '#e2e8f0'),
    cursor: appAccent || '#6366f1',
    selectionBackground: appAccent ? withAlpha(appAccent, 0.2) : 'rgba(99, 102, 241, 0.3)',
    ...buildAnsiPalette(light, appAccent),
  };
}

function readAppCssColors(container: HTMLElement | null | undefined) {
  const bodyStyle = getComputedStyle(document.body);
  const containerStyle = container ? getComputedStyle(container) : bodyStyle;
  const readVar = (name: string) =>
    containerStyle.getPropertyValue(name).trim()
    || bodyStyle.getPropertyValue(name).trim();

  return {
    appBg: readVar('--color-app-bg'),
    appText: readVar('--color-app-text'),
    appAccent: readVar('--color-app-accent'),
  };
}

/** Resolves the xterm theme from CSS variables and optional connection preset. */
export function resolveXtermTheme(
  container: HTMLElement | null | undefined,
  connectionTheme: string | undefined,
  transparency: TerminalTransparencyState,
): ITheme {
  const { appBg, appText, appAccent } = readAppCssColors(container);
  const base = buildXtermTheme(
    appBg,
    appText,
    appAccent,
    transparency.opacity,
    transparency.enabled,
  );

  const preset = connectionTheme && THEME_PRESETS[connectionTheme]
    ? THEME_PRESETS[connectionTheme]
    : null;

  if (!preset) {
    return base;
  }

  return mergeTerminalThemePreset(
    base,
    preset,
    transparency.enabled,
    transparency.opacity,
  );
}

/** Applies the resolved xterm theme and redraws the visible buffer. */
export function applyXtermTheme(
  term: Terminal,
  container: HTMLElement | null | undefined,
  connectionTheme: string | undefined,
  transparency: TerminalTransparencyState,
): void {
  term.options.minimumContrastRatio = isLightTheme() ? 4.5 : 1;
  term.options.theme = resolveXtermTheme(container, connectionTheme, transparency);
  try {
    const lastRow = Math.max(0, term.rows - 1);
    term.refresh(0, lastRow);
  } catch {
    // Ignore refresh failures during renderer transitions.
  }
}

/** Refreshes every cached xterm instance after global theme/accent CSS vars change. */
export function refreshAllCachedTerminalThemes(): void {
  const { settings, connections } = useAppStore.getState();
  const transparency = resolveTerminalTransparency(settings);

  for (const cached of terminalCache.values()) {
    const container = cached.term.element?.parentElement ?? document.body;
    let connectionTheme: string | undefined;

    const connectionId = cached.connectionId;
    if (connectionId && connectionId !== LOCAL_TERMINAL_CONNECTION_ID) {
      connectionTheme = connections.find((connection) => connection.id === connectionId)?.theme;
    }

    applyXtermTheme(cached.term, container, connectionTheme, transparency);
  }
}