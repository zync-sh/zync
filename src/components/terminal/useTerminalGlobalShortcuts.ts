import { useEffect, type RefObject } from 'react';
import type { Terminal as XTerm } from '@xterm/xterm';

export interface UseTerminalGlobalShortcutsOptions {
  isVisible: boolean;
  termRef: RefObject<XTerm | null>;
  onOpenSearch: () => void;
}

export function useTerminalGlobalShortcuts({
  isVisible,
  termRef,
  onOpenSearch,
}: UseTerminalGlobalShortcutsOptions) {
  useEffect(() => {
    const handleGlobalCopy = async () => {
      if (isVisible && termRef.current?.hasSelection()) {
        const selection = termRef.current.getSelection();
        if (selection) {
          try {
            const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
            await writeText(selection);
          } catch (e) {
            console.error('Tauri copy failed, falling back to navigator:', e);
            navigator.clipboard.writeText(selection).catch(console.error);
          }
        }
      }
    };

    const handleGlobalPaste = async () => {
      if (!isVisible) return;
      try {
        const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
        const text = await readText();
        if (text && termRef.current) {
          termRef.current.paste(text);
        }
      } catch (e) {
        console.error('Paste failed:', e);
        try {
          const text = await navigator.clipboard.readText();
          if (text && termRef.current) termRef.current.paste(text);
        } catch (e2) {
          console.error('Fallback paste failed:', e2);
        }
      }
    };

    const handleGlobalFind = () => {
      if (isVisible) {
        onOpenSearch();
      }
    };

    const handleGlobalFocus = () => {
      if (isVisible) {
        termRef.current?.focus();
      }
    };

    window.addEventListener('ssh-ui:term-copy', handleGlobalCopy);
    window.addEventListener('ssh-ui:term-paste', handleGlobalPaste);
    window.addEventListener('ssh-ui:term-find', handleGlobalFind);
    window.addEventListener('ssh-ui:term-focus', handleGlobalFocus);

    return () => {
      window.removeEventListener('ssh-ui:term-copy', handleGlobalCopy);
      window.removeEventListener('ssh-ui:term-paste', handleGlobalPaste);
      window.removeEventListener('ssh-ui:term-find', handleGlobalFind);
      window.removeEventListener('ssh-ui:term-focus', handleGlobalFocus);
    };
  }, [isVisible, termRef, onOpenSearch]);
}