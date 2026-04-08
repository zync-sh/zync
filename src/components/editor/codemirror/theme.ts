import { EditorView } from '@codemirror/view';

export function createCodeMirrorTheme(theme: 'light' | 'dark') {
  return EditorView.theme({
    '&': {
      height: '100%',
      color: 'var(--color-app-text)',
      backgroundColor: 'var(--color-app-bg)',
      fontSize: '13px',
    },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      lineHeight: '1.55',
    },
    '.cm-content': {
      caretColor: 'var(--color-app-accent)',
    },
    '&.cm-focused': {
      outline: 'none',
    },
    '&.cm-focused .cm-cursor': {
      borderLeftColor: 'var(--color-app-accent)',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--color-app-surface)',
      color: 'var(--color-app-muted)',
      borderRight: '1px solid var(--color-app-border)',
    },
    '.cm-activeLine, .cm-activeLineGutter': {
      backgroundColor: theme === 'light'
        ? 'color-mix(in srgb, var(--color-app-accent) 10%, transparent)'
        : 'color-mix(in srgb, var(--color-app-accent) 14%, transparent)',
    },
    '.cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: theme === 'light'
        ? 'color-mix(in srgb, var(--color-app-accent) 24%, transparent)'
        : 'color-mix(in srgb, var(--color-app-accent) 32%, transparent)',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--color-app-accent)',
    },
    '.cm-panels': {
      backgroundColor: 'var(--color-app-surface)',
      color: 'var(--color-app-text)',
      borderBottom: '1px solid var(--color-app-border)',
    },
    '.cm-panels .cm-search button, .cm-panels .cm-search .cm-button': {
      border: '1px solid var(--color-app-border)',
      backgroundColor: 'var(--color-app-surface)',
      backgroundImage: 'none',
      color: 'var(--color-app-text)',
      borderRadius: '6px',
    },
    '.cm-panels .cm-search button:hover, .cm-panels .cm-search .cm-button:hover': {
      borderColor: 'var(--color-app-accent)',
      color: 'var(--color-app-accent)',
    },
    '.cm-panels .cm-search button:disabled, .cm-panels .cm-search .cm-button:disabled': {
      opacity: '0.45',
      color: 'var(--color-app-muted)',
      borderColor: 'var(--color-app-border)',
      backgroundColor: 'var(--color-app-surface)',
      backgroundImage: 'none',
    },
    '.cm-panels .cm-search button[aria-pressed="true"], .cm-panels .cm-search .cm-button[aria-pressed="true"]': {
      borderColor: 'var(--color-app-accent)',
      backgroundColor: 'color-mix(in srgb, var(--color-app-accent) 14%, transparent)',
      color: 'var(--color-app-accent)',
    },
    '.cm-panels .cm-search .cm-textfield': {
      border: '1px solid var(--color-app-border)',
      backgroundColor: 'var(--color-app-bg)',
      color: 'var(--color-app-text)',
    },
    '.cm-panels .cm-search .cm-textfield:focus': {
      outline: 'none',
      borderColor: 'var(--color-app-accent)',
    },
    '.cm-tooltip': {
      border: '1px solid var(--color-app-border)',
      backgroundColor: 'color-mix(in srgb, var(--color-app-panel) 90%, transparent)',
      color: 'var(--color-app-text)',
      borderRadius: '8px',
      boxShadow: '0 10px 24px rgba(0,0,0,0.35)',
      backdropFilter: 'blur(6px)',
      overflow: 'hidden',
    },
    '.cm-tooltip .cm-tooltip-arrow:before': {
      borderTopColor: 'var(--color-app-border)',
      borderBottomColor: 'var(--color-app-border)',
    },
    '.cm-tooltip .cm-tooltip-arrow:after': {
      borderTopColor: 'var(--color-app-panel)',
      borderBottomColor: 'var(--color-app-panel)',
    },
    '.cm-tooltip-autocomplete ul': {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: '12px',
      maxHeight: '220px',
      padding: '4px',
    },
    '.cm-tooltip-autocomplete ul li': {
      display: 'flex',
      alignItems: 'center',
      borderRadius: '6px',
      padding: '4px 8px',
      color: 'var(--color-app-text)',
    },
    '.cm-tooltip-autocomplete ul li[aria-selected="true"]': {
      backgroundColor: 'color-mix(in srgb, var(--color-app-accent) 34%, transparent)',
      color: 'var(--color-foreground-on-accent, #ffffff)',
      fontWeight: '600',
    },
    '.cm-tooltip-autocomplete ul li .cm-completionLabel': {
      color: 'inherit',
    },
    '.cm-tooltip-autocomplete ul li .cm-completionDetail': {
      color: 'var(--color-app-muted)',
    },
    '.cm-tooltip-autocomplete ul li .cm-completionIcon': {
      color: 'var(--color-app-muted)',
      marginRight: '6px',
    },
    '.cm-searchMatch': {
      backgroundColor: theme === 'light'
        ? 'color-mix(in srgb, var(--color-app-accent) 18%, transparent)'
        : 'color-mix(in srgb, var(--color-app-accent) 22%, transparent)',
      outline: '1px solid color-mix(in srgb, var(--color-app-accent) 45%, transparent)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: theme === 'light'
        ? 'color-mix(in srgb, var(--color-app-accent) 28%, transparent)'
        : 'color-mix(in srgb, var(--color-app-accent) 34%, transparent)',
      outline: '1px solid color-mix(in srgb, var(--color-app-accent) 60%, transparent)',
    },
  });
}
