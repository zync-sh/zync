import { createElement, useCallback, useMemo, useState } from 'react';
import { Clipboard, Copy, Hash, Save, Scissors, Search, Type, WholeWord } from 'lucide-react';

import type { ContextMenuItem } from '../ui/ContextMenu.js';

export interface LightEditorContextMenuAction {
  id:
    | 'cut'
    | 'copy'
    | 'paste'
    | 'select-all'
    | 'find'
    | 'replace'
    | 'goto'
    | 'fold-current'
    | 'fold-imports'
    | 'fold-all'
    | 'unfold-all'
    | 'save';
  disabled?: boolean;
}

export function getLightEditorContextMenuActions(hasSelection: boolean): LightEditorContextMenuAction[] {
  return [
    { id: 'cut', disabled: !hasSelection },
    { id: 'copy', disabled: !hasSelection },
    { id: 'paste' },
    { id: 'select-all' },
    { id: 'find' },
    { id: 'replace' },
    { id: 'goto' },
    { id: 'fold-current' },
    { id: 'fold-imports' },
    { id: 'fold-all' },
    { id: 'unfold-all' },
    { id: 'save' },
  ];
}

interface UseLightEditorContextMenuParams {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  setContent: React.Dispatch<React.SetStateAction<string>>;
  setCurrentWord: React.Dispatch<React.SetStateAction<string>>;
  updateCursorPosition: () => void;
  showToast: (type: 'success' | 'error' | 'warning' | 'info', message: string, duration?: number) => void;
  onSave: () => void;
  onFind: () => void;
  onReplace: () => void;
  onGoto: () => void;
  onFoldAll: () => void;
  onUnfoldAll: () => void;
  onFoldImports: () => void;
  onFoldCurrent: () => void;
}

async function writeClipboardText(text: string) {
  try {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
    await writeText(text);
    return;
  } catch {
    await navigator.clipboard.writeText(text);
  }
}

async function readClipboardText() {
  try {
    const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
    return await readText();
  } catch {
    return await navigator.clipboard.readText();
  }
}

function replaceSelection(
  content: string,
  selectionStart: number,
  selectionEnd: number,
  insertion: string,
) {
  return `${content.slice(0, selectionStart)}${insertion}${content.slice(selectionEnd)}`;
}

export function useLightEditorContextMenu({
  textareaRef,
  setContent,
  setCurrentWord,
  updateCursorPosition,
  showToast,
  onSave,
  onFind,
  onReplace,
  onGoto,
  onFoldAll,
  onUnfoldAll,
  onFoldImports,
  onFoldCurrent,
}: UseLightEditorContextMenuParams) {
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [menuHasSelection, setMenuHasSelection] = useState(false);

  const closeContextMenu = useCallback(() => {
    setMenuPosition(null);
  }, []);

  const handleContextMenu = useCallback((event: React.MouseEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    setMenuHasSelection(textarea.selectionStart !== textarea.selectionEnd);
    setMenuPosition({ x: event.clientX, y: event.clientY });
  }, [textareaRef]);

  const handleCopy = useCallback(async () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
    if (!selected) return;
    await writeClipboardText(selected);
  }, [textareaRef]);

  const handleCut = useCallback(async () => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const { selectionStart, selectionEnd } = textarea;
    const selected = textarea.value.slice(selectionStart, selectionEnd);
    if (!selected) return;

    await writeClipboardText(selected);
    setContent((prev) => replaceSelection(prev, selectionStart, selectionEnd, ''));
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(selectionStart, selectionStart);
      updateCursorPosition();
    });
  }, [setContent, textareaRef, updateCursorPosition]);

  const handlePaste = useCallback(async () => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const text = await readClipboardText();
    if (!text) return;

    const { selectionStart, selectionEnd } = textarea;
    setContent((prev) => replaceSelection(prev, selectionStart, selectionEnd, text));
    requestAnimationFrame(() => {
      const nextOffset = selectionStart + text.length;
      textarea.focus();
      textarea.setSelectionRange(nextOffset, nextOffset);
      updateCursorPosition();
    });
  }, [setContent, textareaRef, updateCursorPosition]);

  const handleSelectAll = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(0, textarea.value.length);
    setCurrentWord('');
    updateCursorPosition();
  }, [setCurrentWord, textareaRef, updateCursorPosition]);

  const items = useMemo<ContextMenuItem[]>(() => {
    const actions = getLightEditorContextMenuActions(menuHasSelection);
    const map = new Map(actions.map((action) => [action.id, action]));

    return [
      {
        label: 'Cut',
        icon: createElement(Scissors, { size: 14 }),
        action: async () => {
          try {
            await handleCut();
          } catch (error) {
            console.error('[LightEditorContextMenu] cut failed', error);
            showToast('error', 'Cut failed');
          }
        },
        disabled: map.get('cut')?.disabled,
      },
      {
        label: 'Copy',
        icon: createElement(Copy, { size: 14 }),
        action: async () => {
          try {
            await handleCopy();
          } catch (error) {
            console.error('[LightEditorContextMenu] copy failed', error);
            showToast('error', 'Copy failed');
          }
        },
        disabled: map.get('copy')?.disabled,
      },
      {
        label: 'Paste',
        icon: createElement(Clipboard, { size: 14 }),
        action: async () => {
          try {
            await handlePaste();
          } catch (error) {
            console.error('[LightEditorContextMenu] paste failed', error);
            showToast('error', 'Paste failed');
          }
        },
      },
      { separator: true },
      {
        label: 'Select All',
        icon: createElement(WholeWord, { size: 14 }),
        action: handleSelectAll,
      },
      { separator: true },
      {
        label: 'Find',
        icon: createElement(Search, { size: 14 }),
        action: onFind,
      },
      {
        label: 'Replace',
        icon: createElement(Type, { size: 14 }),
        action: onReplace,
      },
      {
        label: 'Go to Line',
        icon: createElement(Hash, { size: 14 }),
        action: onGoto,
      },
      { separator: true },
      {
        label: 'Fold Current Block',
        icon: createElement(Hash, { size: 14 }),
        action: onFoldCurrent,
      },
      {
        label: 'Fold Imports',
        icon: createElement(Hash, { size: 14 }),
        action: onFoldImports,
      },
      {
        label: 'Fold All',
        icon: createElement(Hash, { size: 14 }),
        action: onFoldAll,
      },
      {
        label: 'Unfold All',
        icon: createElement(Hash, { size: 14 }),
        action: onUnfoldAll,
      },
      { separator: true },
      {
        label: 'Save',
        icon: createElement(Save, { size: 14 }),
        action: onSave,
      },
    ];
  }, [handleCopy, handleCut, handlePaste, handleSelectAll, menuHasSelection, onFind, onFoldAll, onFoldCurrent, onFoldImports, onGoto, onReplace, onSave, onUnfoldAll, showToast]);

  return {
    menuPosition,
    items,
    handleContextMenu,
    closeContextMenu,
  };
}
