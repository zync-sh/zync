export type LightEditorThemeId = 'system' | 'zync-dark' | 'zync-light' | 'editor-midnight' | 'editor-warm';

export interface LightEditorThemeColors {
  background: string;
  panel: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
}

export interface LightEditorThemeTokens {
  '--editor-background': string;
  '--editor-panel': string;
  '--editor-surface': string;
  '--editor-border': string;
  '--editor-text': string;
  '--editor-muted': string;
  '--editor-accent': string;
  '--editor-accent-soft': string;
  '--editor-active-line': string;
  '--editor-search-match': string;
  '--editor-search-match-active': string;
}
