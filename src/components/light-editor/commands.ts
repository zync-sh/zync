export type LightEditorCommandId =
  | 'save'
  | 'find'
  | 'replace'
  | 'goto'
  | 'close-utility'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'select-all'
  | 'fold-all'
  | 'unfold-all'
  | 'fold-imports'
  | 'fold-current'
  | 'completion-next'
  | 'completion-prev'
  | 'completion-accept'
  | 'completion-clear'
  | 'indent';

export interface LightEditorCommand {
  id: LightEditorCommandId;
  label: string;
  shortcut?: string;
  description: string;
  group: 'file' | 'search' | 'completion' | 'editing';
}

export const LIGHT_EDITOR_COMMAND_GROUP_LABELS: Record<LightEditorCommand['group'], string> = {
  file: 'File',
  search: 'Search',
  completion: 'Completion',
  editing: 'Editing',
};

export const LIGHT_EDITOR_COMMANDS: readonly LightEditorCommand[] = [
  {
    id: 'save',
    label: 'Save',
    shortcut: 'Ctrl/Cmd+S',
    description: 'Save the current file',
    group: 'file',
  },
  {
    id: 'find',
    label: 'Find',
    shortcut: 'Ctrl/Cmd+F',
    description: 'Open the find widget',
    group: 'search',
  },
  {
    id: 'replace',
    label: 'Replace',
    shortcut: 'Ctrl/Cmd+H',
    description: 'Open find with replace enabled',
    group: 'search',
  },
  {
    id: 'goto',
    label: 'Go to Line',
    shortcut: 'Ctrl/Cmd+G',
    description: 'Open the go-to-line widget',
    group: 'search',
  },
  {
    id: 'close-utility',
    label: 'Close Utility',
    shortcut: 'Escape',
    description: 'Close the active utility widget',
    group: 'search',
  },
  {
    id: 'cut',
    label: 'Cut',
    shortcut: 'Ctrl/Cmd+X',
    description: 'Cut the current selection',
    group: 'editing',
  },
  {
    id: 'copy',
    label: 'Copy',
    shortcut: 'Ctrl/Cmd+C',
    description: 'Copy the current selection',
    group: 'editing',
  },
  {
    id: 'paste',
    label: 'Paste',
    shortcut: 'Ctrl/Cmd+V',
    description: 'Paste clipboard text at the current cursor',
    group: 'editing',
  },
  {
    id: 'select-all',
    label: 'Select All',
    shortcut: 'Ctrl/Cmd+A',
    description: 'Select the entire file',
    group: 'editing',
  },
  {
    id: 'fold-all',
    label: 'Fold All',
    description: 'Collapse all foldable regions',
    group: 'editing',
  },
  {
    id: 'unfold-all',
    label: 'Unfold All',
    description: 'Expand all collapsed regions',
    group: 'editing',
  },
  {
    id: 'fold-imports',
    label: 'Fold Imports',
    description: 'Collapse import groups',
    group: 'editing',
  },
  {
    id: 'fold-current',
    label: 'Fold Current Block',
    description: 'Collapse the foldable block at the current line',
    group: 'editing',
  },
  {
    id: 'completion-next',
    label: 'Next Suggestion',
    shortcut: 'ArrowDown',
    description: 'Move to the next completion item',
    group: 'completion',
  },
  {
    id: 'completion-prev',
    label: 'Previous Suggestion',
    shortcut: 'ArrowUp',
    description: 'Move to the previous completion item',
    group: 'completion',
  },
  {
    id: 'completion-accept',
    label: 'Accept Suggestion',
    shortcut: 'Enter / Tab',
    description: 'Insert the selected completion item',
    group: 'completion',
  },
  {
    id: 'completion-clear',
    label: 'Dismiss Suggestions',
    shortcut: 'Escape',
    description: 'Hide the current completion list',
    group: 'completion',
  },
  {
    id: 'indent',
    label: 'Indent',
    shortcut: 'Tab',
    description: 'Insert editor indentation',
    group: 'editing',
  },
] as const;

interface ResolveLightEditorCommandInput {
  key: string;
  ctrlOrMeta: boolean;
  hasSuggestions: boolean;
}

export function resolveLightEditorCommand({
  key,
  ctrlOrMeta,
  hasSuggestions,
}: ResolveLightEditorCommandInput): LightEditorCommandId | null {
  const normalized = key.toLowerCase();

  if (ctrlOrMeta && normalized === 's') {
    return 'save';
  }

  if (hasSuggestions && key === 'ArrowDown') {
    return 'completion-next';
  }

  if (hasSuggestions && key === 'ArrowUp') {
    return 'completion-prev';
  }

  if (hasSuggestions && (key === 'Enter' || key === 'Tab')) {
    return 'completion-accept';
  }

  if (hasSuggestions && key === 'Escape') {
    return 'completion-clear';
  }

  if (key === 'Tab') {
    return 'indent';
  }

  return null;
}

export function splitCommandShortcut(shortcut?: string): string[] {
  if (!shortcut) return [];
  return shortcut
    .split('/')
    .flatMap((part) => part.split('+'))
    .flatMap((part) => part.split('·'))
    .flatMap((part) => part.split(','))
    .flatMap((part) => part.split(' '))
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => part.split(/(?<!^)\s*\|\s*/))
    .flatMap((part) => part.split(/\s*\/\s*/))
    .flatMap((part) => part.split(/\s*\+\s*/))
    .map((part) => part.trim())
    .filter(Boolean);
}

export function groupLightEditorCommands(commands: readonly LightEditorCommand[]) {
  return commands.reduce<Record<LightEditorCommand['group'], LightEditorCommand[]>>((groups, command) => {
    groups[command.group].push(command);
    return groups;
  }, {
    file: [],
    search: [],
    completion: [],
    editing: [],
  });
}
