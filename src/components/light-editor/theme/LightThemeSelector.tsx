import { Palette } from 'lucide-react';

import { LIGHT_EDITOR_THEME_OPTIONS } from './themes.js';
import type { LightEditorThemeId } from './types.js';

interface LightThemeSelectorProps {
  value: LightEditorThemeId;
  onChange: (themeId: LightEditorThemeId) => void;
}

export function LightThemeSelector({ value, onChange }: LightThemeSelectorProps) {
  return (
    <div className="flex items-center gap-2">
      <Palette size={14} className="text-app-muted" />
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as LightEditorThemeId)}
        className="rounded-md border border-app-border/50 bg-app-surface/70 px-2 py-1 text-[11px] text-app-text outline-none focus:border-app-accent/50"
        title="Editor theme"
      >
        {LIGHT_EDITOR_THEME_OPTIONS.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
