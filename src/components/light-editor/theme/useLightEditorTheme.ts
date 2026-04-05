import type { CSSProperties } from 'react';
import { useEffect, useMemo, useState } from 'react';

import { useAppStore } from '../../../store/useAppStore.js';
import {
  buildLightEditorThemeTokens,
  getEditorThemeColors,
  resolveLightEditorThemeId,
} from './themes.js';
import type { LightEditorThemeId } from './types.js';

function readAppThemeColors() {
  const style = getComputedStyle(document.body);
  return {
    background: style.getPropertyValue('--color-app-bg').trim(),
    panel: style.getPropertyValue('--color-app-panel').trim(),
    surface: style.getPropertyValue('--color-app-surface').trim(),
    border: style.getPropertyValue('--color-app-border').trim(),
    text: style.getPropertyValue('--color-app-text').trim(),
    muted: style.getPropertyValue('--color-app-muted').trim(),
    accent: style.getPropertyValue('--color-app-accent').trim(),
  };
}

export function useLightEditorTheme() {
  const appTheme = useAppStore((state) => state.settings.theme);
  const accentColor = useAppStore((state) => state.settings.accentColor);
  const [editorThemeOverride, setEditorThemeOverride] = useState<LightEditorThemeId>('system');
  const [themeVersion, setThemeVersion] = useState(0);

  useEffect(() => {
    const notify = () => setThemeVersion((value) => value + 1);
    const observer = new MutationObserver(notify);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-theme', 'style', 'class'],
    });

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener?.('change', notify);

    return () => {
      observer.disconnect();
      media.removeEventListener?.('change', notify);
    };
  }, []);

  return useMemo(() => {
    const bodyTheme = document.body.getAttribute('data-theme');
    const colors = readAppThemeColors();
    if (accentColor) {
      colors.accent = accentColor;
    }

    const inheritedThemeId = resolveLightEditorThemeId(appTheme, bodyTheme);
    const themeId = editorThemeOverride === 'system' ? inheritedThemeId : editorThemeOverride;
    const themeColors = getEditorThemeColors(themeId, colors);

    return {
      themeId,
      editorThemeOverride,
      setEditorThemeOverride,
      themeStyle: buildLightEditorThemeTokens(themeColors) as CSSProperties,
    };
  }, [accentColor, appTheme, editorThemeOverride, themeVersion]);
}
