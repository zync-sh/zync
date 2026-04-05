import { useCallback, useEffect, useState } from 'react';

import type { LineModel } from './core/lineModel.js';
import { getLineStartOffset } from './core/lineModel.js';
import { LIGHT_EDITOR_LINE_HEIGHT, LIGHT_EDITOR_VERTICAL_PADDING } from './highlight.js';

export interface LightEditorUtilityState {
  utilityMode: 'find' | 'goto' | null;
  targetLine: string;
  showReplace: boolean;
}

export function resolveUtilityShortcut(key: string, hasModifier: boolean) {
  if (!hasModifier) return null;
  const normalizedKey = key.toLowerCase();
  if (normalizedKey === 'f') return 'find';
  if (normalizedKey === 'h') return 'replace';
  if (normalizedKey === 'g') return 'goto';
  return null;
}

export function getUtilityStateForAction(
  action: 'find' | 'replace' | 'goto' | 'close',
  current: LightEditorUtilityState,
): LightEditorUtilityState {
  if (action === 'find') {
    return {
      utilityMode: 'find',
      targetLine: current.targetLine,
      showReplace: false,
    };
  }

  if (action === 'replace') {
    return {
      utilityMode: 'find',
      targetLine: current.targetLine,
      showReplace: true,
    };
  }

  if (action === 'goto') {
    return {
      utilityMode: 'goto',
      targetLine: current.targetLine,
      showReplace: false,
    };
  }

  return {
    utilityMode: null,
    targetLine: '',
    showReplace: false,
  };
}

interface UseLightEditorUtilitiesParams {
  lineModel: LineModel;
  lineCount: number;
  rootRef: React.RefObject<HTMLDivElement | null>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  findInputRef: React.RefObject<HTMLInputElement | null>;
  replaceInputRef: React.RefObject<HTMLInputElement | null>;
  goToLineInputRef: React.RefObject<HTMLInputElement | null>;
  updateCursorPosition: () => void;
}

export function useLightEditorUtilities({
  lineModel,
  lineCount,
  rootRef,
  textareaRef,
  findInputRef,
  replaceInputRef,
  goToLineInputRef,
  updateCursorPosition,
}: UseLightEditorUtilitiesParams) {
  const [utilityState, setUtilityState] = useState<LightEditorUtilityState>({
    utilityMode: null,
    targetLine: '',
    showReplace: false,
  });

  const { utilityMode, targetLine, showReplace } = utilityState;

  const setTargetLine = useCallback((value: string) => {
    setUtilityState((current) => ({ ...current, targetLine: value }));
  }, []);

  const setShowReplace = useCallback((value: React.SetStateAction<boolean>) => {
    setUtilityState((current) => ({
      ...current,
      showReplace: typeof value === 'function' ? value(current.showReplace) : value,
    }));
  }, []);

  const setUtilityMode = useCallback((value: 'find' | 'goto' | null) => {
    setUtilityState((current) => ({
      ...current,
      utilityMode: value,
      showReplace: value === 'find' ? current.showReplace : false,
    }));
  }, []);

  const closeUtility = useCallback(() => {
    setUtilityState((current) => getUtilityStateForAction('close', current));
  }, []);

  const resetGoToLine = useCallback(() => {
    setUtilityState((current) => ({ ...current, targetLine: '' }));
  }, []);

  const handleGoToLine = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const requested = Number.parseInt(targetLine, 10);
    if (!Number.isFinite(requested)) return;

    const safeLine = Math.max(1, Math.min(requested, lineCount));
    const offset = getLineStartOffset(lineModel, safeLine);
    textarea.focus();
    textarea.setSelectionRange(offset, offset);
    textarea.scrollTop = Math.max(
      0,
      LIGHT_EDITOR_VERTICAL_PADDING + (safeLine - 1) * LIGHT_EDITOR_LINE_HEIGHT - LIGHT_EDITOR_LINE_HEIGHT * 2,
    );
    updateCursorPosition();
    setUtilityState((current) => getUtilityStateForAction('close', { ...current, targetLine: '' }));
  }, [lineCount, lineModel, targetLine, textareaRef, updateCursorPosition]);

  useEffect(() => {
    if (utilityMode === 'find') {
      requestAnimationFrame(() => {
        if (showReplace) replaceInputRef.current?.focus();
        else findInputRef.current?.focus();
      });
    } else if (utilityMode === 'goto') {
      requestAnimationFrame(() => goToLineInputRef.current?.focus());
    }
  }, [findInputRef, goToLineInputRef, replaceInputRef, showReplace, utilityMode]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root) return;
      const active = document.activeElement;
      if (!(active instanceof Node) || !root.contains(active)) return;
      const action = resolveUtilityShortcut(event.key, event.ctrlKey || event.metaKey);
      if (!action) return;

      event.preventDefault();
      setUtilityState((current) => getUtilityStateForAction(action, current));
    };

    window.addEventListener('keydown', handleShortcut, { capture: true });
    return () => window.removeEventListener('keydown', handleShortcut, { capture: true });
  }, [rootRef]);

  return {
    utilityMode,
    setUtilityMode,
    targetLine,
    setTargetLine,
    showReplace,
    setShowReplace,
    closeUtility,
    resetGoToLine,
    handleGoToLine,
  };
}
