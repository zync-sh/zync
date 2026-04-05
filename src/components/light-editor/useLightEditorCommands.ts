import { useCallback } from 'react';

import { resolveLightEditorCommand } from './commands.js';
import type { LightEditorCompletionItem } from './contextEngine.js';

interface UseLightEditorCommandsParams {
  content: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  setContent: React.Dispatch<React.SetStateAction<string>>;
  updateCursorPosition: () => void;
  handleSave: () => Promise<void> | void;
  setCurrentWord: React.Dispatch<React.SetStateAction<string>>;
  completionItems: LightEditorCompletionItem[];
  selectedCompletionIndex: number;
  setSelectedCompletionIndex: React.Dispatch<React.SetStateAction<number>>;
  applyCompletion: (item: LightEditorCompletionItem) => void;
  clearCompletion: () => void;
}

export function useLightEditorCommands({
  content,
  textareaRef,
  setContent,
  updateCursorPosition,
  handleSave,
  setCurrentWord,
  completionItems,
  selectedCompletionIndex,
  setSelectedCompletionIndex,
  applyCompletion,
  clearCompletion,
}: UseLightEditorCommandsParams) {
  return useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const hasSuggestions = completionItems.length > 0;
    const command = resolveLightEditorCommand({
      key: event.key,
      ctrlOrMeta: event.ctrlKey || event.metaKey,
      hasSuggestions,
    });

    if (command === 'save') {
      event.preventDefault();
      void handleSave();
      return;
    }

    if (command === 'completion-next') {
      event.preventDefault();
      setSelectedCompletionIndex((prev) => (prev + 1) % completionItems.length);
      return;
    }

    if (command === 'completion-prev') {
      event.preventDefault();
      setSelectedCompletionIndex((prev) => (
        prev - 1 + completionItems.length
      ) % completionItems.length);
      return;
    }

    if (command === 'completion-accept') {
      event.preventDefault();
      const item = completionItems[selectedCompletionIndex] ?? completionItems[0];
      if (item) applyCompletion(item);
      return;
    }

    if (command === 'completion-clear') {
      event.preventDefault();
      setCurrentWord('');
      clearCompletion();
      return;
    }

    if (command === 'indent') {
      event.preventDefault();
      const textarea = textareaRef.current;
      if (!textarea) return;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const next = `${content.slice(0, start)}  ${content.slice(end)}`;
      setContent(next);
      requestAnimationFrame(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 2;
        updateCursorPosition();
      });
    }
  }, [
    applyCompletion,
    clearCompletion,
    completionItems,
    content,
    handleSave,
    selectedCompletionIndex,
    setContent,
    setCurrentWord,
    setSelectedCompletionIndex,
    textareaRef,
    updateCursorPosition,
  ]);
}
