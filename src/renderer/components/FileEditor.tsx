import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { githubDark } from '@uiw/codemirror-theme-github';
import CodeMirror from '@uiw/react-codemirror';
import { FileCode, Loader2, Save, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from './ui/Button';

interface FileEditorProps {
  filename: string;
  initialContent: string;
  onSave: (content: string) => Promise<void>;
  onClose: () => void;
}

export function FileEditor({ filename, initialContent, onSave, onClose }: FileEditorProps) {
  const [content, setContent] = useState(initialContent);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    setContent(initialContent);
    setHasChanges(false);
  }, [initialContent]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave(content);
      setHasChanges(false);
    } catch (error) {
      console.error(error);
    } finally {
      setIsSaving(false);
    }
  };

  const onChange = useCallback(
    (val: string) => {
      setContent(val);
      setHasChanges(val !== initialContent);
    },
    [initialContent],
  );

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSave]); // Depend on content/handleSave to capture latest state

  // Detect Language extension
  const getExtensions = () => {
    const ext = filename.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'js':
      case 'jsx':
      case 'ts':
      case 'tsx':
        return [javascript({ jsx: true })];
      case 'html':
        return [html()];
      case 'css':
        return [css()];
      case 'json':
        return [json()];
      case 'py':
        return [python()];
      default:
        return [];
    }
  };

  return (
    <div className="absolute inset-0 z-50 bg-app-bg flex flex-col animate-in fade-in duration-200">
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
            onClick={onClose}
            className="hover:bg-app-danger/20 hover:text-app-danger"
          >
            <X size={18} />
          </Button>
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 overflow-auto relative">
        <CodeMirror
          value={content}
          height="100%"
          theme={githubDark}
          extensions={getExtensions()}
          onChange={onChange}
          className="h-full text-base font-mono"
          basicSetup={{
            foldGutter: true,
            dropCursor: true,
            allowMultipleSelections: true,
            indentOnInput: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: true,
            highlightActiveLine: true,
            highlightSelectionMatches: true,
            tabSize: 4,
          }}
        />
      </div>
    </div>
  );
}
