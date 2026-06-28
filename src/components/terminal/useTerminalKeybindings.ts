import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import type { Terminal as XTerm } from '@xterm/xterm';
import type { TerminalSettingsSlice } from './useTerminalTheme';

export interface UseTerminalKeybindingsOptions {
  fontSize: number;
  updateTerminalSettings: (settings: Partial<TerminalSettingsSlice>) => void;
  isSearchOpenRef: MutableRefObject<boolean>;
  closeSearch: () => void;
}

export function useTerminalKeybindings({
  fontSize,
  updateTerminalSettings,
  isSearchOpenRef,
  closeSearch,
}: UseTerminalKeybindingsOptions) {
  const currentFontSizeRef = useRef(fontSize);

  useEffect(() => {
    currentFontSizeRef.current = fontSize;
  }, [fontSize]);

  const attachKeybindings = useCallback((term: XTerm) => {
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') {
        return true;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('zync:ai-command-bar'));
        return false;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        const currentSize = currentFontSizeRef.current;
        updateTerminalSettings({ fontSize: Math.min(currentSize + 1, 32) });
        return false;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        const currentSize = currentFontSizeRef.current;
        updateTerminalSettings({ fontSize: Math.max(currentSize - 1, 8) });
        return false;
      }

      if (e.key === 'Escape' && isSearchOpenRef.current) {
        closeSearch();
        term.focus();
        return false;
      }

      return true;
    });
  }, [closeSearch, isSearchOpenRef, updateTerminalSettings]);

  return { attachKeybindings };
}