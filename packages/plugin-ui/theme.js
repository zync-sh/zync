const COLOR_KEYS = ['background', 'surface', 'border', 'text', 'muted', 'primary'];
const STATUS_COLORS = {
  light: { positive: '#18734d', negative: '#b12d3a', warning: '#8a5b12', info: '#2867a6' },
  dark: { positive: '#67d8ac', negative: '#fa8d91', warning: '#e7bc75', info: '#89b9ea' },
};

/** Only known color properties are accepted. Never apply arbitrary CSS or markup. */
export function normalizeTheme(payload, supportsColor = value => globalThis.CSS?.supports('color', value) === true) {
  const theme = { colors: {} };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return theme;
  if (payload.mode === 'light' || payload.mode === 'dark') theme.mode = payload.mode;
  for (const key of COLOR_KEYS) {
    const value = payload.colors?.[key];
    if (typeof value === 'string' && value.length <= 256 && supportsColor(value)) theme.colors[key] = value;
  }
  return theme;
}

export function applyTheme(payload, root = document.documentElement) {
  const css = root.ownerDocument.defaultView.CSS;
  const theme = normalizeTheme(payload, value => css.supports('color', value));
  for (const [key, color] of Object.entries(theme.colors)) root.style.setProperty(`--zui-${key}`, color);
  if (theme.mode) {
    root.style.colorScheme = theme.mode;
    root.style.setProperty('--zui-color-scheme', theme.mode);
    for (const [key, color] of Object.entries(STATUS_COLORS[theme.mode])) root.style.setProperty(`--zui-${key}`, color);
  }
  return theme;
}

export function installThemeBridge({ targetWindow = window, source = targetWindow.parent, root = targetWindow.document.documentElement, onChange } = {}) {
  const listener = event => {
    if (event.source !== source || event.data?.type !== 'zync:theme:update') return;
    const theme = applyTheme(event.data.payload, root);
    onChange?.(theme);
  };
  targetWindow.addEventListener('message', listener);
  return () => targetWindow.removeEventListener('message', listener);
}
