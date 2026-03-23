import { cpp } from '@codemirror/lang-cpp';
import { css } from '@codemirror/lang-css';
import { go } from '@codemirror/lang-go';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { yaml } from '@codemirror/lang-yaml';
import { keymap, EditorView } from '@codemirror/view';
import { searchKeymap, openSearchPanel } from '@codemirror/search';
import { toggleComment, defaultKeymap, historyKeymap } from '@codemirror/commands';
import { StreamLanguage, indentUnit } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { autocompletion, completeAnyWord } from '@codemirror/autocomplete';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { useAppStore } from '../store/useAppStore';
import { AlertTriangle, FileCode, Loader2, Save, X, Search } from 'lucide-react';
import { useCallback, useEffect, useState, useRef, useMemo } from 'react';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';

interface FileEditorProps {
  filename: string;
  initialContent: string;
  onSave: (content: string) => Promise<void>;
  onClose: () => void;
}

export function FileEditor({ filename, initialContent, onSave, onClose }: FileEditorProps) {
  // No more 'content' state to avoid re-renders on every keystroke
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [showConfirmClose, setShowConfirmClose] = useState(false);
  const [showGoToLine, setShowGoToLine] = useState(false);
  const [targetLine, setTargetLine] = useState('');
  
  // Refs for Status Bar direct updates (performance)
  const lineRef = useRef<HTMLSpanElement>(null);
  const colRef = useRef<HTMLSpanElement>(null);
  const sizeRef = useRef<HTMLSpanElement>(null);

  const theme = useAppStore(state => state.settings.theme);

  // Custom Theme using Zync CSS variables
  const editorTheme = useMemo(() => {
    return EditorView.theme({
      "&": {
        backgroundColor: "var(--color-app-bg)",
        color: "var(--color-app-text)",
        height: "100%",
      },
      ".cm-content": {
        caretColor: "var(--color-app-accent)",
        fontFamily: "var(--font-mono)",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "var(--color-app-accent)"
      },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: "rgba(121, 123, 206, 0.25) !important" // app-accent with opacity
      },
      ".cm-panels": {
        backgroundColor: "var(--color-app-panel)",
        color: "var(--color-app-text)",
        borderBottom: "1px solid var(--color-app-border)"
      },
      ".cm-panels.cm-panels-top": {
        borderBottom: "2px solid var(--color-app-border)"
      },
      ".cm-panels.cm-panels-bottom": {
        borderTop: "2px solid var(--color-app-border)"
      },
      ".cm-search": {
        backgroundColor: "var(--color-app-panel)",
        color: "var(--color-app-text)",
        borderBottom: "1px solid var(--color-app-border)",
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        padding: "6px 10px !important",
        gap: "6px 12px"
      },
      ".cm-search input": {
        backgroundColor: "var(--color-app-bg) !important",
        color: "var(--color-app-text) !important",
        border: "1px solid var(--color-app-border) !important",
        borderRadius: "4px !important",
        padding: "2px 6px !important",
        fontSize: "12px !important",
        outline: "none !important"
      },
      ".cm-search input:focus": {
        borderColor: "var(--color-app-accent) !important",
      },
      ".cm-search label": {
        fontSize: "11px",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        color: "var(--color-app-muted)",
        display: "flex",
        alignItems: "center",
        gap: "4px"
      },
      ".cm-search .cm-button": {
        color: "var(--color-app-text) !important",
        backgroundColor: "var(--color-app-surface) !important",
        backgroundImage: "none !important",
        border: "1px solid var(--color-app-border) !important",
        borderRadius: "4px !important",
        padding: "2px 8px !important",
        fontSize: "11px !important",
        textTransform: "capitalize !important"
      },
      ".cm-search .cm-button:hover": {
        backgroundColor: "var(--color-app-bg) !important",
        borderColor: "var(--color-app-accent) !important"
      },
      ".cm-search .cm-button[name=close]": {
        backgroundColor: "transparent !important",
        border: "none !important",
        opacity: "0.6"
      },
      ".cm-search .cm-button[name=close]:hover": {
        opacity: "1",
        color: "var(--color-app-danger) !important"
      },
      ".cm-gutters": {
        backgroundColor: "var(--color-app-bg)", // Blend with background
        color: "var(--color-app-muted)",
        borderRight: "1px solid var(--color-app-border)"
      },
      ".cm-activeLine": {
        backgroundColor: "rgba(255, 255, 255, 0.03)"
      },
      ".cm-activeLineGutter": {
        backgroundColor: "rgba(255, 255, 255, 0.03)",
        color: "var(--color-app-text)"
      },
      // Autocomplete Tooltip
      ".cm-tooltip": {
        backgroundColor: "var(--color-app-panel) !important",
        border: "1px solid var(--color-app-border) !important",
        borderRadius: "6px !important",
        overflow: "hidden !important",
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.5) !important",
        padding: "4px !important"
      },
      ".cm-tooltip-autocomplete ul": {
        fontFamily: "var(--font-mono) !important",
        fontSize: "12px !important",
        maxHeight: "250px !important"
      },
      ".cm-tooltip-autocomplete ul li": {
        borderRadius: "4px !important",
        padding: "4px 8px !important",
        color: "var(--color-app-text) !important",
        display: "flex !important",
        alignItems: "center !important",
        gap: "8px !important"
      },
      ".cm-tooltip-autocomplete ul li[aria-selected]": {
        backgroundColor: "var(--color-app-accent) !important",
        color: "white !important"
      },
      ".cm-completionIcon": {
        opacity: "0.6",
        width: "12px !important",
        marginRight: "4px !important"
      },
      ".cm-completionIcon-word::after": {
        content: "'abc'",
        fontSize: "8px",
        fontWeight: "bold"
      },
      ".cm-completionLabel": {
        flex: 1
      },
      ".cm-completionDetail": {
        fontStyle: "italic",
        opacity: "0.5",
        fontSize: "10px"
      }
    }, { dark: theme === 'dark' });
  }, [theme]);

  // Refs for stability
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const contentRef = useRef(initialContent);

  useEffect(() => {
    contentRef.current = initialContent;
    setHasChanges(false);
  }, [initialContent]);

  // Force Focus on Mount
  useEffect(() => {
    const timer = setTimeout(() => {
      if (editorRef.current?.view) {
        editorRef.current.view.focus();
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [filename]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await onSave(contentRef.current);
      setHasChanges(false);
    } catch (error) {
      console.error(error);
    } finally {
      setIsSaving(false);
    }
  }, [onSave]);

  const saveRef = useRef(handleSave);
  useEffect(() => {
    saveRef.current = handleSave;
  }, [handleSave]);

  const handleClose = async () => {
    if (hasChanges) {
      setShowConfirmClose(true);
      return;
    }
    onClose();
  };

  const handleSearch = () => {
    if (editorRef.current?.view) {
      openSearchPanel(editorRef.current.view);
    }
  };

  const onChange = useCallback(
    (val: string) => {
      contentRef.current = val;
      const isDifferent = val !== initialContent;
      // Only trigger a re-render if the 'hasChanges' status actually changes
      setHasChanges(prev => {
        if (prev === isDifferent) return prev;
        return isDifferent;
      });
    },
    [initialContent],
  );

  const handleGoToLine = useCallback(() => {
    const lineNum = parseInt(targetLine);
    if (isNaN(lineNum) || !editorRef.current?.view) return;

    const { view } = editorRef.current;
    try {
      const line = view.state.doc.line(Math.max(1, Math.min(lineNum, view.state.doc.lines)));
      view.dispatch({
        selection: { head: line.from, anchor: line.from },
        scrollIntoView: true
      });
      setShowGoToLine(false);
      setTargetLine('');
      view.focus();
    } catch (e) {
      console.error("Failed to go to line:", e);
    }
  }, [targetLine]);

  // Detect Language extension - Memoized for performance
  const extensions = useMemo(() => {
    const exts = [];
    const fileExt = filename.split('.').pop()?.toLowerCase();

    // 1. Language Support
    switch (fileExt) {
      case 'js':
      case 'jsx':
      case 'ts':
      case 'tsx':
        exts.push(javascript({ jsx: true }));
        break;
      case 'html':
        exts.push(html());
        break;
      case 'css':
        exts.push(css());
        break;
      case 'json':
        exts.push(json());
        break;
      case 'py':
        exts.push(python());
        break;
      case 'md':
      case 'markdown':
        exts.push(markdown());
        break;
      case 'yml':
      case 'yaml':
        exts.push(yaml());
        break;
      case 'rs':
        exts.push(rust());
        break;
      case 'go':
        exts.push(go());
        break;
      case 'c':
      case 'cpp':
      case 'h':
      case 'hpp':
        exts.push(cpp());
        break;
      case 'sh':
      case 'bash':
      case 'zsh':
      case 'fish':
        exts.push(StreamLanguage.define(shell));
        break;
    }

    // 1b. Cursor Position & Filesize Tracker (Direct DOM updates)
    exts.push(EditorView.updateListener.of((update) => {
      if (update.selectionSet || update.docChanged) {
        const state = update.state;
        const pos = state.selection.main.head;
        const line = state.doc.lineAt(pos);
        
        if (lineRef.current) lineRef.current.textContent = line.number.toString();
        if (colRef.current) colRef.current.textContent = (pos - line.from + 1).toString();
        
        if (update.docChanged && sizeRef.current) {
          // Use TextEncoder to get actual UTF-8 byte length instead of UTF-16 code units
          const bytes = new TextEncoder().encode(state.doc.toString()).length;
          sizeRef.current.textContent = `${(bytes / 1024).toFixed(1)} KB`;
        }
      }
    }));

    // 2. Raw Event interceptor for ALL editor shortcuts
    // This catches events before they bubble to the browser or system
    exts.push(EditorView.domEventHandlers({
      keydown: (event, view) => {
        // Ctrl/Cmd + /
        if ((event.ctrlKey || event.metaKey) && event.key === '/') {
          event.preventDefault();
          event.stopPropagation();
          toggleComment(view);
          return true;
        }
        // Ctrl/Cmd + S
        if ((event.ctrlKey || event.metaKey) && event.key === 's') {
          event.preventDefault();
          event.stopPropagation();
          saveRef.current();
          return true;
        }
        // Ctrl/Cmd + F
        if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
          event.preventDefault();
          event.stopPropagation();
          openSearchPanel(view);
          return true;
        }
        // Ctrl/Cmd + G (Go to Line)
        if ((event.ctrlKey || event.metaKey) && event.key === 'g') {
          event.preventDefault();
          event.stopPropagation();
          setShowGoToLine(true);
          return true;
        }
        return false;
      }
    }));

    // 3. Search & Standard Keymaps
    exts.push(keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap]));

    exts.push(indentUnit.of("    "));

    // 5. Word Completion (buffer-based)
    exts.push(autocompletion({
      override: [completeAnyWord]
    }));

    return exts;
  }, [filename]); // Stable across handleSave/onSave changes

  return (
    <div 
      className="absolute inset-0 z-50 bg-app-bg flex flex-col animate-in fade-in duration-200"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Toolbar */}
      <div className="h-12 border-b border-app-border bg-app-panel flex items-center justify-between px-4 shrink-0 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded bg-app-surface flex items-center justify-center border border-app-border">
            <FileCode size={16} className="text-app-accent" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-medium text-app-text flex items-center gap-2">
              {filename}
              {hasChanges && <span className="h-2 w-2 rounded-full bg-app-accent animate-pulse" />}
            </span>
            <span className="text-[10px] text-app-muted">{hasChanges ? 'Unsaved changes' : 'All changes saved'}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleSearch}
            title="Search (Ctrl+F)"
            aria-label="Search"
            className="text-app-muted hover:text-app-text"
          >
            <Search size={18} />
          </Button>
          <div className="h-4 w-px bg-app-border mx-1" />
          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            disabled={!hasChanges || isSaving}
            className="w-24 gap-2"
          >
            {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save
          </Button>
          <div className="h-4 w-px bg-app-border mx-2" />
          <Button
            variant="ghost"
            size="icon"
            onClick={handleClose}
            className="hover:bg-app-danger/20 hover:text-app-danger"
          >
            <X size={18} />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden relative">
        <CodeMirror
          ref={editorRef}
          value={contentRef.current}
          height="100%"
          theme={editorTheme}
          autoFocus={true}
          extensions={extensions}
          onChange={onChange}
          className="h-full text-base font-mono"
          basicSetup={{
            foldGutter: true,
            dropCursor: true,
            allowMultipleSelections: true,
            indentOnInput: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: false, // Using custom extension instead
            highlightActiveLine: true,
            highlightSelectionMatches: true,
            tabSize: 4,
          }}
        />
      </div>

      {/* Status Bar */}
      <div className="h-7 bg-app-surface border-t border-app-border flex items-center justify-between px-3 text-[10px] text-app-muted font-medium select-none">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <span className="opacity-60 text-[9px]">LN</span>
            <span ref={lineRef} className="text-app-text min-w-[12px]">1</span>
            <span className="opacity-60 text-[9px] ml-1">COL</span>
            <span ref={colRef} className="text-app-text min-w-[12px]">1</span>
          </div>
          <div className="h-3 w-px bg-app-border/50" />
          <div className="flex items-center gap-1.5">
             <span className="opacity-60 text-[9px] uppercase">Filesize</span>
             <span ref={sizeRef} className="text-app-text">{(initialContent.length / 1024).toFixed(1)} KB</span>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <span className="opacity-60 text-[9px] uppercase">Language</span>
            <span className="text-app-accent font-semibold">{filename.split('.').pop()?.toUpperCase() || 'TEXT'}</span>
          </div>
          <div className="h-3 w-px bg-app-border/50" />
          <div className="flex items-center gap-1.5">
            <span className="opacity-60 text-[9px] uppercase">Encoding</span>
            <span className="text-app-text">UTF-8</span>
          </div>
        </div>
      </div>

      {/* Go To Line Modal */}
      <Modal
        isOpen={showGoToLine}
        onClose={() => setShowGoToLine(false)}
        title="Go to Line"
        width="max-w-[280px]"
      >
        <div className="space-y-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium text-app-muted uppercase tracking-wider">Line Number</label>
            <input
              autoFocus
              type="text"
              placeholder="e.g. 42"
              value={targetLine}
              onChange={(e) => setTargetLine(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => e.key === 'Enter' && handleGoToLine()}
              className="w-full bg-app-surface border border-app-border rounded px-3 py-2 text-sm text-app-text outline-none focus:border-app-accent transition-colors"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setShowGoToLine(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={handleGoToLine} className="px-6">
              Go
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showConfirmClose}
        onClose={() => setShowConfirmClose(false)}
        title="Unsaved Changes"
        width="max-w-sm"
      >
        <div className="space-y-4">
          <div className="flex items-start gap-4">
            <div className="h-10 w-10 rounded-full bg-app-danger/10 flex items-center justify-center shrink-0">
              <AlertTriangle className="h-5 w-5 text-app-danger" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-white">Discard changes?</p>
              <p className="text-sm text-app-muted leading-relaxed">
                You have unsaved changes in <span className="text-app-text font-mono underline decoration-app-accent/30">{filename}</span>. Closing will lose all modifications.
              </p>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="ghost"
              onClick={() => setShowConfirmClose(false)}
              className="px-4"
            >
              Keep Editing
            </Button>
            <Button
              variant="primary"
              onClick={onClose}
              className="bg-app-danger hover:bg-app-danger/90 text-white border-none px-4"
            >
              Discard Changes
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
