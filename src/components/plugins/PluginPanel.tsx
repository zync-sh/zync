import { useRef, useEffect } from 'react';

interface PluginPanelProps {
    html: string;
    panelId: string;
    pluginId: string;
    connectionId: string | null;
}

/**
 * Renders a plugin panel inside a sandboxed iframe.
 * Provides a postMessage bridge so the panel can still call zync.terminal.send(), etc.
 */
export function PluginPanel({ html, panelId, pluginId, connectionId }: PluginPanelProps) {
    const iframeRef = useRef<HTMLIFrameElement>(null);

    // Listen for messages FROM the iframe (plugin panel calling zync.*)
    useEffect(() => {
        const handler = (e: MessageEvent) => {
            if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
            const { type, payload } = e.data || {};
            if (!type) return;

            if (type === 'zync:terminal:send') {
                window.dispatchEvent(new CustomEvent('zync:terminal:send', { detail: { text: payload.text } }));
            } else if (type === 'zync:statusbar:set') {
                window.dispatchEvent(new CustomEvent('zync:statusbar:set', { detail: payload }));
            } else if (type === 'zync:ui:notify') {
                window.dispatchEvent(new CustomEvent('zync:ui:notify', { detail: payload }));
            } else if (type === 'zync:ssh:exec') {
                if (!connectionId) {
                    iframeRef.current?.contentWindow?.postMessage({
                        type: 'zync:ssh:exec:response',
                        payload: { requestId: payload.requestId, error: 'No active connection' }
                    }, '*');
                    return;
                }
                import('../../lib/tauri-ipc').then(({ ipcRenderer }) => {
                    ipcRenderer.invoke('ssh_exec', { connectionId, command: payload.command })
                        .then(result => {
                            iframeRef.current?.contentWindow?.postMessage({
                                type: 'zync:ssh:exec:response',
                                payload: { requestId: payload.requestId, result }
                            }, '*');
                        })
                        .catch(error => {
                            iframeRef.current?.contentWindow?.postMessage({
                                type: 'zync:ssh:exec:response',
                                payload: { requestId: payload.requestId, error: String(error) }
                            }, '*');
                        });
                });
            }
        };

        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [panelId, pluginId, connectionId]);

    // Inject the zync shim into the panel HTML
    const shimScript = `
<script>
window.zync = {
    terminal: {
        send: function(text) {
            window.parent.postMessage({ type: 'zync:terminal:send', payload: { text } }, '*');
        }
    },
    statusBar: {
        set: function(id, text) {
            window.parent.postMessage({ type: 'zync:statusbar:set', payload: { id, text } }, '*');
        }
    },
    ui: {
        notify: function(opts) {
            window.parent.postMessage({ type: 'zync:ui:notify', payload: opts }, '*');
        },
        confirm: function(opts) {
            return new Promise((resolve) => {
                const reqId = Math.random().toString(36).substr(2, 9);
                
                const listener = (event) => {
                    const { type, payload } = event.data || {};
                    if (type === 'zync:ui:confirm:response' && payload.requestId === reqId) {
                        window.removeEventListener('message', listener);
                        resolve(payload.confirmed);
                    }
                };
                window.addEventListener('message', listener);
                
                window.parent.postMessage({ 
                    type: 'zync:ui:confirm', 
                    payload: { ...opts, requestId: reqId } 
                }, '*');
            });
        }
    },
    ssh: {
        exec: function(command) {
            return new Promise((resolve, reject) => {
                const reqId = Math.random().toString(36).substr(2, 9);
                
                const listener = (event) => {
                    const { type, payload } = event.data || {};
                    if (type === 'zync:ssh:exec:response' && payload.requestId === reqId) {
                        window.removeEventListener('message', listener);
                        if (payload.error) reject(new Error(payload.error));
                        else resolve(payload.result);
                    }
                };
                window.addEventListener('message', listener);
                
                window.parent.postMessage({ 
                    type: 'zync:ssh:exec', 
                    payload: { command, requestId: reqId } 
                }, '*');
            });
        }
    }
};
</script>
`;

    const fullHtml = html.replace('<head>', `<head>\n${shimScript}`) || `<html><head>${shimScript}</head><body>${html}</body></html>`;

    return (
        <div className="absolute inset-0 z-10 bg-app-bg flex flex-col">
            <iframe
                ref={iframeRef}
                srcDoc={fullHtml}
                sandbox="allow-scripts allow-same-origin allow-modals"
                className="flex-1 w-full border-0 bg-transparent"
                title={`Plugin Panel: ${panelId}`}
            />
        </div>
    );
}
