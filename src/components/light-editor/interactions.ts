import { resolveLightEditorCommand, type LightEditorCommandId } from './commands.js';

export type LightEditorKeyAction = LightEditorCommandId | 'noop';

interface LightEditorKeyActionInput {
  key: string;
  ctrlOrMeta: boolean;
  hasSuggestions: boolean;
}

export function getLightEditorKeyAction({
  key,
  ctrlOrMeta,
  hasSuggestions,
}: LightEditorKeyActionInput): LightEditorKeyAction {
  return resolveLightEditorCommand({ key, ctrlOrMeta, hasSuggestions }) ?? 'noop';
}
