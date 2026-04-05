import { KeyboardKey } from '../ui/KeyboardKey.js';
import {
  groupLightEditorCommands,
  LIGHT_EDITOR_COMMAND_GROUP_LABELS,
  splitCommandShortcut,
  type LightEditorCommand,
} from './commands.js';

interface LightShortcutsListProps {
  commands: readonly LightEditorCommand[];
}

export function LightShortcutsList({ commands }: LightShortcutsListProps) {
  const groups = groupLightEditorCommands(commands);

  return (
    <div className="space-y-5">
      {(Object.keys(groups) as Array<keyof typeof groups>).map((groupKey) => {
        const groupCommands = groups[groupKey];
        if (groupCommands.length === 0) return null;

        return (
          <section key={groupKey} className="space-y-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-widest text-app-muted/70">
              {LIGHT_EDITOR_COMMAND_GROUP_LABELS[groupKey]}
            </h4>
            <div className="space-y-2">
              {groupCommands.map((command) => (
                <div
                  key={command.id}
                  className="flex items-start justify-between gap-4 rounded-lg border border-app-border/40 bg-app-surface/30 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-app-text">{command.label}</div>
                    <div className="text-xs text-app-muted">{command.description}</div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                    {splitCommandShortcut(command.shortcut).map((part, index) => (
                      <KeyboardKey key={`${command.id}-${part}-${index}`}>{part}</KeyboardKey>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
