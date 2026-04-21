import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, Search } from 'lucide-react';
import { minimalSetup } from 'codemirror';
import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, undo, redo } from '@codemirror/commands';
import { searchKeymap, openSearchPanel, closeSearchPanel } from '@codemirror/search';
import { bracketMatching, foldGutter, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { lintKeymap } from '@codemirror/lint';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';

import { Button } from './ui/Button';
import { buildLineCommentChanges } from './editor/codemirror/comments';
import { getCodeMirrorLanguageId, getLanguageLabel, getLineCommentToken } from './editor/codemirror/fileTypes';
import { CODEMIRROR_SHORTCUT_HINTS, isCommentShortcut } from './editor/codemirror/keymap';
import { formatCodeMirrorStatus } from './editor/codemirror/status';
import { createCodeMirrorTheme } from './editor/codemirror/theme';
import { Input } from './ui/Input';
import { useAppStore } from '../store/useAppStore';

interface CodeMirrorFileEditorProps {
  filename: string;
  initialContent: string;
  onSave: (content: string) => Promise<void>;
  onClose: () => void;
  hideToolbar?: boolean;
}

function parseGoToLineInput(input: string, maxLine: number) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const [linePart, columnPart] = trimmed.split(/[:.,]/);
  const line = Number(linePart);
  if (!Number.isFinite(line)) return null;

  const resolvedLine = Math.max(1, Math.min(maxLine, Math.floor(line)));
  const column = columnPart !== undefined && columnPart !== ''
    ? Math.max(1, Math.floor(Number(columnPart)))
    : null;

  return {
    line: resolvedLine,
    column: Number.isFinite(column) ? column : null,
  };
}

function getLanguageExtension(filename: string) {
  switch (getCodeMirrorLanguageId(filename)) {
    case 'javascript':
      return javascript();
    case 'javascript-jsx':
      return javascript({ jsx: true });
    case 'typescript':
      return javascript({ typescript: true });
    case 'typescript-jsx':
      return javascript({ typescript: true, jsx: true });
    case 'json':
      return json();
    case 'html':
      return html();
    case 'css':
      return css();
    case 'markdown':
      return markdown();
    case 'python':
      return python();
    case 'rust':
      return rust();
    case 'xml':
      return xml();
    case 'yaml':
      return yaml();
    case 'sql':
      return sql();
    default:
      return [];
  }
}

export function CodeMirrorFileEditor({
  filename,
  initialContent,
  onSave,
  onClose,
  hideToolbar = false,
}: CodeMirrorFileEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartment = useRef(new Compartment()).current;
  const themeCompartment = useRef(new Compartment()).current;
  const [isSaving, setIsSaving] = useState(false);
  const [cursorLine, setCursorLine] = useState(1);
  const [cursorColumn, setCursorColumn] = useState(1);
  const [showGoToLine, setShowGoToLine] = useState(false);
  const [goToLineValue, setGoToLineValue] = useState('');
  const [goToLineError, setGoToLineError] = useState<string | null>(null);
  const [docText, setDocText] = useState(initialContent);
  // Saved baseline is intentionally decoupled from incoming props.
  // This preserves undo/redo history across save operations.
  const [savedContent, setSavedContent] = useState(initialContent);
  const [lineCount, setLineCount] = useState(initialContent.length === 0 ? 1 : initialContent.split('\n').length);
  const goToLineInputRef = useRef<HTMLInputElement>(null);
  const showConfirmDialog = useAppStore((state) => state.showConfirmDialog);
  const showToast = useAppStore((state) => state.showToast);
  const theme = useAppStore((state) => state.settings.theme);

  const isDirty = docText !== savedContent;
  const languageExtension = useMemo(() => getLanguageExtension(filename), [filename]);
  const lineCommentToken = useMemo(() => getLineCommentToken(filename), [filename]);
  const languageLabel = useMemo(() => getLanguageLabel(filename), [filename]);
  const saveRef = useRef<() => Promise<void> | void>(() => {});
  const toggleCommentRef = useRef<(view: EditorView) => boolean>(() => false);
  const isDirtyRef = useRef(isDirty);

  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);

  const syncCursorState = useCallback((state: EditorState) => {
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    setCursorLine(line.number);
    setCursorColumn(head - line.from + 1);
  }, []);

  const resolvedThemeMode = theme === 'light' ? 'light' : 'dark';
  const createTheme = useCallback(() => createCodeMirrorTheme(resolvedThemeMode), [resolvedThemeMode]);

  const handleSave = useCallback(async () => {
    const view = viewRef.current;
    if (!view || isSaving) return;
    setIsSaving(true);
    try {
      const current = view.state.doc.toString();
      await onSave(current);
      setSavedContent(current);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save file';
      showToast('error', message);
    } finally {
      setIsSaving(false);
      requestAnimationFrame(() => view.focus());
    }
  }, [isSaving, onSave, showToast]);

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

  const openSearch = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    openSearchPanel(view);
  }, []);

  const closeSearch = useCallback(() => {
    const view = viewRef.current;
    if (!view) return false;
    const hasSearchPanel = Boolean(view.dom.querySelector('.cm-search'));
    if (hasSearchPanel) {
      closeSearchPanel(view);
      requestAnimationFrame(() => view.focus());
      return true;
    }
    return false;
  }, []);

  const openGoToLineDialog = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const line = view.state.doc.lineAt(view.state.selection.main.head).number;
    setGoToLineValue(String(line));
    setGoToLineError(null);
    setShowGoToLine(true);
    requestAnimationFrame(() => {
      goToLineInputRef.current?.focus();
      goToLineInputRef.current?.select();
    });
  }, []);

  const handleGoToLine = useCallback(() => {
    const view = viewRef.current;
    const target = parseGoToLineInput(goToLineValue, lineCount);
    if (!view || !target) {
      setGoToLineError('Enter a valid line number (or line:column).');
      return;
    }
    const lineNumber = target.line;
    const line = view.state.doc.line(lineNumber);
    const to = target.column ? Math.min(line.to, line.from + target.column - 1) : line.from;
    view.dispatch({
      selection: EditorSelection.cursor(to),
      scrollIntoView: true,
    });
    view.focus();
    syncCursorState(view.state);
    setGoToLineError(null);
    setShowGoToLine(false);
  }, [goToLineValue, lineCount, syncCursorState]);

  const toggleLineComment = useCallback((view: EditorView) => {
    if (!lineCommentToken) return false;
    const changes = buildLineCommentChanges(
      view.state.doc.toString(),
      view.state.selection.ranges.map((range) => ({ from: range.from, to: range.to })),
      lineCommentToken,
    );
    if (!changes.length) return true;
    view.dispatch({ changes });
    return true;
  }, [lineCommentToken]);

  saveRef.current = handleSave;
  toggleCommentRef.current = toggleLineComment;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || viewRef.current) return;
    const initialTheme = createCodeMirrorTheme(resolvedThemeMode);

    const view = new EditorView({
      state: EditorState.create({
        doc: initialContent,
        extensions: [
          minimalSetup,
          history(),
          lineNumbers(),
          foldGutter(),
          bracketMatching(),
          indentOnInput(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          autocompletion(),
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            ...completionKeymap,
            ...lintKeymap,
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                void saveRef.current();
                return true;
              }
            },
            {
              key: 'Mod-/',
              run: (view) => toggleCommentRef.current(view)
            },
            {
              key: 'Mod-Shift-7',
              run: (view) => toggleCommentRef.current(view)
            },
            {
              key: 'Mod-f',
              run: (view) => {
                openSearchPanel(view);
                return true;
              }
            },
            {
              key: 'Mod-g',
              run: () => {
                openGoToLineDialog();
                return true;
              }
            }
          ]),
          EditorView.domEventHandlers({
            keydown: (event, view) => {
              if (isCommentShortcut(event)) {
                event.preventDefault();
                return toggleCommentRef.current(view);
              }

              return false;
            }
          }),
          languageCompartment.of(languageExtension),
          themeCompartment.of(initialTheme),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const next = update.state.doc.toString();
              setDocText(next);
              setLineCount(update.state.doc.lines);
            }
            if (update.docChanged || update.selectionSet) {
              syncCursorState(update.state);
            }
          }),
        ],
      }),
      parent: container,
    });

    viewRef.current = view;
    setDocText(initialContent);
    setSavedContent(initialContent);
    setLineCount(view.state.doc.lines);
    syncCursorState(view.state);
    requestAnimationFrame(() => view.focus());

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [openGoToLineDialog, syncCursorState]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    view.dispatch({
      effects: languageCompartment.reconfigure(languageExtension)
    });
  }, [languageCompartment, languageExtension]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.reconfigure(createTheme())
    });
  }, [createTheme, themeCompartment]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === initialContent) {
      setSavedContent(initialContent);
      return;
    }

    const applyIncomingContent = () => {
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: initialContent,
        }
      });
      setDocText(initialContent);
      setSavedContent(initialContent);
      setLineCount(initialContent.length === 0 ? 1 : initialContent.split('\n').length);
    };

    if (!isDirtyRef.current) {
      applyIncomingContent();
      return;
    }

    let cancelled = false;
    void (async () => {
      const confirmed = await showConfirmDialog({
        title: 'Replace unsaved changes?',
        message: `${filename} has unsaved edits. Reload incoming content and discard current edits?`,
        confirmText: 'Reload',
        cancelText: 'Keep Editing',
        variant: 'danger',
      });
      if (!confirmed || cancelled) return;
      applyIncomingContent();
    })();

    return () => {
      cancelled = true;
    };
  }, [filename, initialContent, showConfirmDialog]);

  useEffect(() => {
    const focusEditor = () => viewRef.current?.focus();
    requestAnimationFrame(focusEditor);
    const timer = window.setTimeout(focusEditor, 60);
    return () => window.clearTimeout(timer);
  }, [filename]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const ctrlOrMeta = event.ctrlKey || event.metaKey;
      if (ctrlOrMeta && event.key.toLowerCase() === 'w') {
        // Intercept app/tab/window close while editor is open and close only the editor overlay.
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        void handleClose();
        return;
      }

      if (ctrlOrMeta && (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')) {
        const view = viewRef.current;
        if (!view) return;
        const target = event.target as Node | null;
        if (target && !view.contentDOM.contains(target)) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        // Ensure undo/redo still works even if focus shifted after save.
        view.focus();
        if (event.key.toLowerCase() === 'y' || event.shiftKey) {
          redo(view);
        } else {
          undo(view);
        }
        return;
      }

      if (!ctrlOrMeta) {
        if (event.key === 'Escape') {
          event.preventDefault();
          if (showGoToLine) {
            setShowGoToLine(false);
            setGoToLineError(null);
            return;
          }
          closeSearch();
        }
        return;
      }

      const key = event.key.toLowerCase();
      const isSlash = key === '/' || event.code === 'Slash' || event.code === 'NumpadDivide';
      const view = viewRef.current;

      if (key === 's') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        void handleSave();
        return;
      }

      if (key === 'f') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        openSearch();
        return;
      }

      if (key === 'g') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        openGoToLineDialog();
        return;
      }

      if (isSlash && view) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        toggleCommentRef.current(view);
        return;
      }

    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [closeSearch, handleClose, handleSave, openGoToLineDialog, openSearch, showGoToLine]);

  useEffect(() => {
    const el = document.getElementById('global-editor-status');
    if (!el) return;
    el.textContent = formatCodeMirrorStatus(filename, cursorLine, cursorColumn, languageLabel, isDirty);
    return () => {
      if (el.textContent?.startsWith(filename)) {
        el.textContent = '';
      }
    };
  }, [cursorColumn, cursorLine, filename, isDirty, languageLabel]);

  return (
      <div className="absolute inset-0 z-[70] flex min-h-0 flex-col bg-app-panel">
        {!hideToolbar && (
          <div className="flex h-9 items-center justify-between border-b border-app-border px-3">
            <div className="min-w-0 truncate text-sm font-semibold text-app-text">{filename}</div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  const view = viewRef.current;
                  if (!view) return;
                  view.focus();
                }}
                className="inline-flex h-7 items-center gap-1 rounded border border-app-border bg-app-surface/40 px-2 text-[10px] font-medium text-app-muted transition-colors hover:bg-app-surface hover:text-app-text"
                title="Editor shortcuts: Ctrl/Cmd+S, Ctrl/Cmd+F, Ctrl/Cmd+G, Ctrl/Cmd+W · Esc closes Find/Go-to-line"
              >
                <Keyboard size={11} />
                {CODEMIRROR_SHORTCUT_HINTS.map((hint, index) => (
                  <span key={hint} className="contents">
                    {index > 0 && <span className="opacity-50">·</span>}
                    <span>{hint}</span>
                  </span>
                ))}
              </button>
              <Button variant="ghost" size="sm" onClick={openSearch}>
                <Search className="mr-1 h-3.5 w-3.5" />
                Find / Replace
              </Button>
            </div>
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col">
        {showGoToLine && (
          <div className="flex items-center gap-2 border-b border-app-border bg-app-surface/30 px-3 py-1.5">
            <Input
              ref={goToLineInputRef}
              value={goToLineValue}
              onChange={(event) => {
                setGoToLineValue(event.target.value);
                if (goToLineError) setGoToLineError(null);
              }}
              onKeyDownCapture={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  handleGoToLine();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setShowGoToLine(false);
                }
              }}
              placeholder={`Go to line (1-${lineCount}) or line:column`}
              className="h-8"
            />
            <Button variant="secondary" size="sm" type="button" onClick={() => setShowGoToLine(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" type="button" onClick={handleGoToLine}>
              Go
            </Button>
          </div>
        )}
        {showGoToLine && goToLineError && (
          <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-300">
            {goToLineError}
          </div>
        )}

        <div
          className="min-h-0 flex-1 overflow-hidden bg-app-bg"
          onMouseDown={(event) => {
            event.stopPropagation();
            const target = event.target as HTMLElement | null;
            if (target?.closest('.cm-panels')) return;
            requestAnimationFrame(() => viewRef.current?.focus());
          }}
          onClick={(event) => {
            event.stopPropagation();
            const target = event.target as HTMLElement | null;
            if (target?.closest('.cm-panels')) return;
            viewRef.current?.focus();
          }}
        >
          <div ref={containerRef} className="h-full w-full" />
        </div>
      </div>
    </div>
  );
}
