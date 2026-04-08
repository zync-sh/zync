export const CODEMIRROR_SHORTCUT_HINTS = [
  'Ctrl/Cmd+S',
  'Ctrl/Cmd+W',
  'Ctrl/Cmd+G',
  'Ctrl/Cmd+/',
] as const;

export function isCommentShortcut(event: KeyboardEvent): boolean {
  const ctrlOrMeta = event.ctrlKey || event.metaKey;
  const isSlashShortcut =
    event.key === '/' ||
    event.code === 'Slash' ||
    event.code === 'NumpadDivide';

  return ctrlOrMeta && isSlashShortcut;
}
