import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, Save } from 'lucide-react';

import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { useAppStore } from '../store/useAppStore';

interface PlainFileEditorProps {
  filename: string;
  initialContent: string;
  onSave: (content: string) => Promise<void>;
  onClose: () => void;
  /**
   * Hides the built-in header toolbar (Save, Close, Find toggle and shortcut chips).
   *
   * When true, editing actions remain available via keyboard shortcuts only
   * (Ctrl/Cmd+S save, Ctrl/Cmd+W close, Ctrl/Cmd+F find), so parent containers
   * should provide equivalent visible controls for discoverability/accessibility.
   */
  hideToolbar?: boolean;
}

export function PlainFileEditor({
  filename,
  initialContent,
  onSave,
  onClose,
  hideToolbar = false,
}: PlainFileEditorProps) {
  const [content, setContent] = useState(initialContent);
  // Track saved baseline separately so save does not reset edit history semantics.
  const [savedContent, setSavedContent] = useState(initialContent);
  const [searchText, setSearchText] = useState('');
  const [matchIndex, setMatchIndex] = useState(-1);
  const [isSaving, setIsSaving] = useState(false);
  const [showSearch, setShowSearch] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const showConfirmDialog = useAppStore((state) => state.showConfirmDialog);
  const showToast = useAppStore((state) => state.showToast);

  useEffect(() => {
    setContent(initialContent);
    setSavedContent(initialContent);
    setSearchText('');
    setMatchIndex(-1);
    setShowSearch(false);
  }, [filename, initialContent]);

  const isDirty = content !== savedContent;
  const languageLabel = useMemo(() => {
    const ext = filename.split('.').pop()?.toUpperCase() ?? 'TEXT';
    return ext || 'TEXT';
  }, [filename]);

  const matches = useMemo(() => {
    if (!searchText) return [];
    const haystack = content.toLowerCase();
    const needle = searchText.toLowerCase();
    const next: Array<{ start: number; end: number }> = [];
    let start = 0;
    while (start < haystack.length) {
      const index = haystack.indexOf(needle, start);
      if (index === -1) break;
      next.push({ start: index, end: index + needle.length });
      start = index + Math.max(needle.length, 1);
    }
    return next;
  }, [content, searchText]);

  const activeMatch = useMemo(
    () => (matchIndex >= 0 ? matches[matchIndex] : undefined),
    [matches, matchIndex],
  );

  useEffect(() => {
    setMatchIndex((previous) => {
      if (!matches.length) {
        return previous === -1 ? previous : -1;
      }
      const safeIndex = previous >= 0 && previous < matches.length ? previous : 0;
      return safeIndex === previous ? previous : safeIndex;
    });
  }, [matches]);

  useEffect(() => {
    if (matchIndex >= 0) {
      const textarea = textareaRef.current;
      const match = activeMatch;
      if (!textarea || !match) return;
      textarea.setSelectionRange(match.start, match.end);
    }
  }, [activeMatch, matchIndex]);

  const handleSave = useCallback(async () => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      await onSave(content);
      setSavedContent(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save file';
      showToast('error', message);
    } finally {
      setIsSaving(false);
    }
  }, [content, isSaving, onSave, showToast]);

  const handleClose = useCallback(async () => {
    if (!isDirty) {
      onClose();
      return;
    }

    const confirmed = await showConfirmDialog({
      title: 'Discard unsaved changes?',
      message: `Close ${filename} without saving your changes?`,
      confirmText: 'Discard',
      cancelText: 'Keep Editing',
      variant: 'danger',
    });

    if (confirmed) {
      onClose();
    }
  }, [filename, isDirty, onClose, showConfirmDialog]);

  const handleNextMatch = useCallback(() => {
    if (!matches.length) return;
    const nextIndex = matchIndex < 0 ? 0 : (matchIndex + 1) % matches.length;
    setMatchIndex(nextIndex);
  }, [matchIndex, matches.length]);

  const handlePrevMatch = useCallback(() => {
    if (!matches.length) return;
    const nextIndex = matchIndex <= 0 ? matches.length - 1 : matchIndex - 1;
    setMatchIndex(nextIndex);
  }, [matchIndex, matches.length]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const ctrlOrMeta = event.ctrlKey || event.metaKey;
      if (ctrlOrMeta && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void handleSave();
        return;
      }

      if (ctrlOrMeta && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setShowSearch(true);
        requestAnimationFrame(() => searchRef.current?.focus());
        return;
      }

      if (ctrlOrMeta && event.key.toLowerCase() === 'w') {
        event.preventDefault();
        void handleClose();
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        if (showSearch) {
          setShowSearch(false);
          searchRef.current?.blur();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [handleClose, handleSave, showSearch]);

  useEffect(() => {
    const el = document.getElementById('global-editor-status');
    if (!el) return;
    el.textContent = `${filename}  UTF-8  ${languageLabel}${isDirty ? '  • Modified' : ''}`;
    return () => {
      if (el.textContent === `${filename}  UTF-8  ${languageLabel}${isDirty ? '  • Modified' : ''}`) {
        el.textContent = '';
      }
    };
  }, [filename, isDirty, languageLabel]);

  return (
      <div className="absolute inset-0 z-[70] flex min-h-0 flex-col bg-app-panel">
        {!hideToolbar && (
          <div className="flex h-9 items-center justify-between border-b border-app-border px-3">
            <div className="min-w-0 truncate text-sm font-semibold text-app-text">{filename}</div>
            <div className="flex items-center gap-2">
              <span className="rounded border border-app-border bg-app-surface/40 px-2 py-0.5 text-[10px] font-medium text-app-muted">Ctrl/Cmd+S</span>
              <span className="rounded border border-app-border bg-app-surface/40 px-2 py-0.5 text-[10px] font-medium text-app-muted">Ctrl/Cmd+F</span>
              <Button variant="ghost" size="sm" onClick={() => {
                setShowSearch((current) => {
                  const next = !current;
                  if (next) requestAnimationFrame(() => searchRef.current?.focus());
                  return next;
                });
              }}>
                <Search className="mr-1 h-3.5 w-3.5" />
                Find
              </Button>
              <Button variant="secondary" size="sm" onClick={() => { void handleClose(); }}>
                Close
              </Button>
              <Button variant="primary" size="sm" isLoading={isSaving} onClick={() => { void handleSave(); }}>
                <Save className="mr-1 h-3.5 w-3.5" />
                Save
              </Button>
            </div>
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col">

        {showSearch && (
          <div className="flex items-center gap-2 border-b border-app-border bg-app-surface/30 px-3 py-2">
            <Input
              ref={searchRef}
              value={searchText}
              onChange={(event) => {
                setSearchText(event.target.value);
                setMatchIndex(0);
              }}
              placeholder="Find in file..."
              className="h-9"
            />
            <div className="min-w-[72px] text-right text-xs text-app-muted">
              {matches.length === 0
                ? '0'
                : `${Math.max(matchIndex, 0) + 1}/${matches.length}`}
            </div>
            <Button variant="secondary" size="sm" onClick={handlePrevMatch} disabled={!matches.length}>
              Prev
            </Button>
            <Button variant="secondary" size="sm" onClick={handleNextMatch} disabled={!matches.length}>
              Next
            </Button>
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          spellCheck={false}
          className="min-h-0 flex-1 resize-none border-0 bg-app-bg px-4 py-3 font-mono text-sm leading-6 text-app-text outline-none ring-0 placeholder:text-app-muted"
          aria-label={`Fallback editor for ${filename}`}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        />
      </div>
    </div>
  );
}
