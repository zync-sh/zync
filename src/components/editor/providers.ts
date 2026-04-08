import type { Plugin } from '../../context/PluginContext';

// Synthetic frontend routing ID used to render PlainFileEditor directly (not the backend plugin ID).
export const BUILTIN_PLAIN_EDITOR_ID = 'builtin-plain';
export const CODEMIRROR_EDITOR_ID = 'com.zync.editor.codemirror';

export type PluginCategory = 'editor-provider' | 'icon-theme' | 'theme' | 'tool';

export interface EditorProviderOption {
  value: string;
  label: string;
  description: string;
}

const EDITOR_SUPPORT_LABELS: Record<string, string> = {
  search: 'Search',
  replace: 'Replace',
  'goto-line': 'Go to Line',
  'syntax-highlight': 'Syntax',
  folding: 'Folding',
  'multi-selection': 'Multi-cursor',
  completion: 'Completion',
  hover: 'Hover',
  definition: 'Definition',
  diagnostics: 'Diagnostics',
  minimap: 'Minimap',
  diff: 'Diff',
  readonly: 'Read-only',
  'large-file-safe': 'Large-file Safe',
  save: 'Save',
};

export function getPluginCategory(pluginLike: {
  id?: string;
  type?: string;
  manifest?: { id?: string; type?: string };
}) : PluginCategory {
  const type = pluginLike.type ?? pluginLike.manifest?.type;
  const id = pluginLike.id ?? pluginLike.manifest?.id ?? '';

  if (type === 'editor-provider') return 'editor-provider';
  if (type === 'icon-theme') return 'icon-theme';
  if (type === 'theme') return 'theme';
  if (id.startsWith('com.zync.theme.')) return 'theme';
  return 'tool';
}

export function getPluginCategoryLabel(category: PluginCategory) {
  switch (category) {
    case 'editor-provider':
      return 'Editor';
    case 'icon-theme':
      return 'Icon Theme';
    case 'theme':
      return 'Theme';
    case 'tool':
      return 'Tool';
    default: {
      const _exhaustive: never = category;
      return _exhaustive;
    }
  }
}

export function isBuiltinProvider(plugin: Pick<Plugin, 'path'>) {
  return plugin.path.startsWith('builtin://');
}

export function sortEditorProviders(editorProviders: Plugin[]) {
  return [...editorProviders].sort((a, b) => {
    const priorityA = a.manifest.editor?.priority ?? 0;
    const priorityB = b.manifest.editor?.priority ?? 0;
    if (priorityA !== priorityB) return priorityB - priorityA;

    const builtinA = isBuiltinProvider(a);
    const builtinB = isBuiltinProvider(b);
    if (builtinA !== builtinB) return builtinA ? -1 : 1;

    return a.manifest.name.localeCompare(b.manifest.name);
  });
}

export function formatEditorCapabilities(supports: string[] | undefined, limit = 3) {
  const normalized = (supports ?? [])
    .map((capability) => EDITOR_SUPPORT_LABELS[capability] ?? capability)
    .filter(Boolean);

  if (!normalized.length) return 'Plugin editor';

  const shown = normalized.slice(0, limit);
  const remaining = normalized.length - shown.length;
  if (remaining <= 0) return shown.join(', ');
  return `${shown.join(', ')} +${remaining}`;
}

export function buildEditorProviderOptions(editorProviders: Plugin[]): EditorProviderOption[] {
  const sortedProviders = sortEditorProviders(editorProviders);

  return [
    {
      value: BUILTIN_PLAIN_EDITOR_ID,
      label: 'Built-in Fallback',
      description: 'Minimal recovery editor for quick edits and plugin failures',
    },
    ...sortedProviders.map((plugin) => ({
      value: plugin.manifest?.id ?? '',
      label: plugin.manifest?.editor?.displayName || plugin.manifest?.name || 'Unknown Editor',
      description: `Plugin editor · ${formatEditorCapabilities(plugin.manifest.editor?.supports)}`,
    })),
  ];
}
