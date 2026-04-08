import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAppStore } from '../store/useAppStore';
import type { Plugin } from '../context/PluginContext';

interface EditorPluginFrameProps {
  plugin: Plugin;
  filename: string;
  initialContent: string;
  onSave: (content: string) => Promise<void>;
  onClose: () => void;
  onFatalError?: (reason: string) => void;
}

interface EditorDocumentPayload {
  docId: string;
  path: string;
  filename: string;
  language: string;
  content: string;
  readOnly: boolean;
}

function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    html: 'html',
    htm: 'html',
    css: 'css',
    md: 'markdown',
    markdown: 'markdown',
    py: 'python',
    rs: 'rust',
    xml: 'xml',
    yml: 'yaml',
    yaml: 'yaml',
    sql: 'sql',
  };

  return map[ext] ?? 'plaintext';
}

export function EditorPluginFrame({
  plugin,
  filename,
  initialContent,
  onSave,
  onClose,
  onFatalError,
}: EditorPluginFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isReady, setIsReady] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const theme = useAppStore((state) => state.settings.theme);
  const showToast = useAppStore((state) => state.showToast);
  const showConfirmDialog = useAppStore((state) => state.showConfirmDialog);
  const lastContentRef = useRef(initialContent);
  const savedContentRef = useRef(initialContent);
  const readyForDocRef = useRef(false);
  const currentDocIdRef = useRef<string | null>(null);

  const doc = useMemo<EditorDocumentPayload>(() => ({
    docId: `file-editor:${filename}`,
    path: filename,
    filename,
    language: detectLanguage(filename),
    content: initialContent,
    readOnly: false,
  }), [filename, initialContent]);

  const requestClose = useCallback(async () => {
    if (!dirty) {
      onClose();
      return;
    }

    if (await showConfirmDialog({
      title: 'Discard unsaved changes?',
      message: `Close ${filename} without saving changes from ${plugin.manifest.name}?`,
      confirmText: 'Discard',
      cancelText: 'Keep Editing',
      variant: 'danger',
    })) {
      onClose();
    }
  }, [dirty, filename, onClose, plugin.manifest.name, showConfirmDialog]);

  const postToFrame = useCallback((message: unknown) => {
    iframeRef.current?.contentWindow?.postMessage(message, '*');
  }, []);

  const sendTheme = useMemo(() => () => {
    const computed = getComputedStyle(document.documentElement);
    postToFrame({
      type: 'zync:editor:set-theme',
      payload: {
        mode: theme,
        colors: {
          background: computed.getPropertyValue('--app-bg').trim() || '#0f111a',
          surface: computed.getPropertyValue('--app-surface').trim() || '#1a1d2e',
          border: computed.getPropertyValue('--app-border').trim() || 'rgba(255,255,255,0.08)',
          text: computed.getPropertyValue('--app-text').trim() || '#e2e8f0',
          muted: computed.getPropertyValue('--app-muted').trim() || '#94a3b8',
          primary: computed.getPropertyValue('--app-accent').trim() || '#6366f1',
        },
      },
    });
  }, [postToFrame, theme]);

  useEffect(() => {
    if (!isReady) return;
    sendTheme();
  }, [isReady, sendTheme]);

  useEffect(() => {
    savedContentRef.current = initialContent;
    lastContentRef.current = initialContent;
    setDirty(false);
    setSaveError(null);
  }, [doc.docId, initialContent]);

  useEffect(() => {
    if (!isReady || !readyForDocRef.current) return;

    const isSameDoc = currentDocIdRef.current === doc.docId;
    postToFrame({
      type: isSameDoc ? 'zync:editor:update-document' : 'zync:editor:open-document',
      payload: isSameDoc ? { docId: doc.docId, content: doc.content } : doc,
    });
    postToFrame({
      type: 'zync:editor:set-readonly',
      payload: {
        docId: doc.docId,
        readOnly: doc.readOnly,
      },
    });
    postToFrame({
      type: 'zync:editor:focus',
      payload: { docId: doc.docId },
    });
    currentDocIdRef.current = doc.docId;
  }, [doc, isReady, postToFrame]);

  useEffect(() => {
    const handler = async (event: MessageEvent) => {
      try {
        if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
        const { type, payload } = event.data || {};

        switch (type) {
          case 'zync:editor:ready':
            setIsReady(true);
            readyForDocRef.current = true;
            postToFrame({
              type: 'zync:editor:init',
              payload: {
                pluginId: plugin.manifest.id,
                sessionId: `editor-session:${filename}`,
                capabilitiesRequested: plugin.manifest.editor?.supports ?? [],
              },
            });
            currentDocIdRef.current = null;
            sendTheme();
            break;
          case 'zync:editor:change': {
            const next = typeof payload?.content === 'string'
              ? payload.content
              : lastContentRef.current;
            lastContentRef.current = next;
            setDirty(next !== savedContentRef.current);
            break;
          }
          case 'zync:editor:dirty-change':
            setDirty(Boolean(payload?.dirty));
            break;
          case 'zync:editor:save-request':
            try {
              setSaveError(null);
              const content = typeof payload?.content === 'string'
                ? payload.content
                : lastContentRef.current;
              await onSave(content);
              savedContentRef.current = content;
              lastContentRef.current = content;
              setDirty(false);
              showToast('success', `${plugin.manifest.name} saved ${filename}`);
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              setSaveError(message);
              showToast('error', `Plugin editor save failed: ${message}`);
            }
            break;
          case 'zync:editor:request-close':
            await requestClose();
            break;
          case 'zync:editor:error':
            if (payload?.message) {
              setLastError(payload.message);
              showToast(payload?.fatal ? 'error' : 'info', payload.message);
              if (payload?.fatal) {
                onFatalError?.(payload.message);
              }
            }
            break;
        }
      } catch (err) {
        console.error('EditorPluginFrame message handler error:', err);
        const message = err instanceof Error ? err.message : String(err);
        setLastError(message);
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [filename, onFatalError, onSave, plugin.manifest.editor?.supports, plugin.manifest.id, plugin.manifest.name, postToFrame, requestClose, sendTheme, showToast]);

  useEffect(() => {
    return () => {
      postToFrame({
        type: 'zync:editor:dispose',
        payload: {
          docId: currentDocIdRef.current ?? undefined,
        },
      });
      readyForDocRef.current = false;
      currentDocIdRef.current = null;
    };
  }, [postToFrame]);

  const shimScript = `
<script>
(function () {
  const listeners = new Set();
  window.zyncEditor = {
    onMessage(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    emitReady(payload = {}) {
      window.parent.postMessage({ type: 'zync:editor:ready', payload }, '*');
    },
    emitChange(payload = {}) {
      window.parent.postMessage({ type: 'zync:editor:change', payload }, '*');
    },
    emitDirtyChange(dirty) {
      window.parent.postMessage({ type: 'zync:editor:dirty-change', payload: { dirty } }, '*');
    },
    requestSave(content) {
      window.parent.postMessage({ type: 'zync:editor:save-request', payload: { content } }, '*');
    },
    requestClose() {
      window.parent.postMessage({ type: 'zync:editor:request-close', payload: {} }, '*');
    },
    reportError(code, message, fatal) {
      window.parent.postMessage({ type: 'zync:editor:error', payload: { code, message, fatal } }, '*');
    }
  };

  window.addEventListener('message', (event) => {
    const message = event.data;
    listeners.forEach((listener) => {
      try { listener(message); } catch (error) { console.error(error); }
    });
    window.dispatchEvent(new CustomEvent('zync-editor-message', { detail: message }));
  });
})();
</script>
`;

  const fullHtml = (plugin.editorHtml || plugin.style || plugin.script)
    ? (() => {
        const html = plugin.editorHtml || '<html><head></head><body></body></html>';
        if (/<head\b[^>]*>/i.test(html)) {
          return html.replace(/<head\b[^>]*>/i, (match) => `${match}${shimScript}`);
        }
        if (/<\/head>/i.test(html)) {
          return html.replace(/<\/head>/i, `${shimScript}</head>`);
        }
        return `<html><head>${shimScript}</head><body>${html}</body></html>`;
      })()
    : `<html><head>${shimScript}</head><body style="font-family: sans-serif; background: #111827; color: white; display:flex; align-items:center; justify-content:center; min-height:100vh;">No editor entry found.</body></html>`;

  return (
      <div className="absolute inset-0 z-[70] flex min-h-0 flex-col bg-app-panel">
        <div className="flex h-10 items-center justify-between border-b border-app-border px-3">
          <h3 className="truncate text-base font-semibold text-app-text">
            {filename} · {plugin.manifest.editor?.displayName || plugin.manifest.name}
          </h3>
          <div className="flex items-center gap-3 text-xs text-app-muted">
            <span>{isReady ? 'Connected' : 'Connecting…'}</span>
            <span>{dirty ? 'Modified' : 'Saved'}</span>
            <button
              type="button"
              onClick={() => { void requestClose(); }}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-app-muted transition-colors hover:bg-app-surface hover:text-app-text"
              aria-label="Close editor"
            >
              ×
            </button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
        {saveError && (
          <div className="border-b border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            Save failed: {saveError}
          </div>
        )}
        {lastError && !saveError && (
          <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            Editor warning: {lastError}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-hidden bg-app-bg">
          <iframe
            ref={iframeRef}
            srcDoc={fullHtml}
            onLoad={() => {
              postToFrame({ type: 'zync:editor:bootstrap', payload: {} });
            }}
            sandbox="allow-scripts allow-same-origin"
            className="h-full w-full border-0 bg-transparent"
            title={`Editor Provider: ${plugin.manifest.id}`}
          />
        </div>
      </div>
    </div>
  );
}
