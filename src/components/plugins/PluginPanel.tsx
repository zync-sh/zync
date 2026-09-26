import { useCallback, useEffect, useRef } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { getZyncThemePayload } from '../../lib/themePayload';
import { isDebugThemePayloadEnabled } from '../../lib/debugFlags';
import { confirmPluginTerminalAction } from '../../features/plugins/confirmPluginTerminalAction';
import { handlePanelPluginCommand } from '../../features/plugins/pluginCommandBridge';
import { parsePluginPaneMessage } from '../../features/plugins/runtime/paneMessages';
import { usePlugins } from '../../context/PluginContext';
import { isPluginShortcutCommandAllowed, matchPluginShortcut, pluginShortcutBindings, pluginShortcutBridgeScript } from '../../features/shortcuts/pluginShortcuts';
import { runShortcutCommand } from '../../features/shortcuts/actions';
import { TerminalDisconnectedView } from '../terminal/TerminalDisconnectedView';
import { findNode, layoutForCanvas } from '../../lib/paneLayout';

interface PluginPanelProps {
    html: string;
    panelId: string;
    pluginId: string;
    connectionId: string | null;
    legacyAccess: boolean;
    paneInstanceId: string;
}

/**
 * Renders a plugin panel inside a sandboxed iframe.
 * Provides a postMessage bridge so the panel can still call zync.terminal.send(), etc.
 */
export function PluginPanel(props: PluginPanelProps) {
    const { plugins } = usePlugins();
    const connection = useAppStore(s => s.connections.find(c => c.id === props.connectionId));
    const pendingRestore = useAppStore(s => Boolean(props.connectionId && s.terminals[props.connectionId]?.some(t => t.pendingRestore)));
    const connect = useAppStore(s => s.connect);
    const editHost = useAppStore(s => s.openConnectionModal);
    const isSurfaceActive = useAppStore(s => {
        const tab = s.tabs.find(t => t.id === s.activeTabId);
        if (!props.connectionId || tab?.connectionId !== props.connectionId) return false;
        if (props.paneInstanceId.startsWith('overlay:')) return tab.view === `plugin:${props.panelId}`;
        if (tab.view.startsWith('plugin:')) return false;
        const layout = layoutForCanvas(s.paneLayouts[props.connectionId], s.activeTerminalIds[props.connectionId], s.activePaneGroupOwner[props.connectionId]);
        const focused = layout && findNode(layout.root, layout.activePaneId);
        return focused?.type === 'pane' && focused.content.kind === 'plugin' && focused.content.instanceId === props.paneInstanceId;
    });
    const plugin = plugins.find(p => p.manifest.id === props.pluginId);
    const requiresSsh = plugin?.manifest.permissions?.required?.some(permission => permission.id.startsWith('ssh.'));
    // Connection UX belongs to the host. Network-only plugins still work offline.
    // Unmounting the frame also prevents its worker reads during reconnection.
    if (requiresSsh && props.connectionId && props.connectionId !== 'local' && connection?.status !== 'connected') {
        return <TerminalDisconnectedView
            connection={connection}
            activeConnectionId={props.connectionId}
            isPendingRestore={pendingRestore}
            surface="plugin"
            isSurfaceActive={isSurfaceActive}
            onReconnect={() => { void connect(props.connectionId!); }}
            onEditHost={() => editHost(props.connectionId)}
        />;
    }
    return <PluginPanelFrame {...props} />;
}

function PluginPanelFrame({ html, panelId, pluginId, connectionId, legacyAccess, paneInstanceId }: PluginPanelProps) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const frameGenerationRef = useRef(0);
    const theme = useAppStore(s => s.settings.theme);
    const accentColor = useAppStore(s => s.settings.accentColor);
    const keybindings = useAppStore(s => s.settings.keybindings);
    const shortcutBindings = pluginShortcutBindings(keybindings, /mac/i.test(navigator.platform));
    const shortcutBindingsRef = useRef(shortcutBindings);
    shortcutBindingsRef.current = shortcutBindings;
    const lastShortcutRef = useRef(0);
    const { postPaneMessage, registerPaneMessageTarget } = usePlugins();
    const sendShortcuts = useCallback(() => {
        iframeRef.current?.contentWindow?.postMessage({ type: 'zync:shortcuts:update', payload: shortcutBindingsRef.current }, '*');
    }, []);
    useEffect(sendShortcuts, [keybindings, sendShortcuts]);

    const sendTheme = useCallback(() => {
        if (!iframeRef.current || !iframeRef.current.contentWindow) return;
        const payload = getZyncThemePayload(theme);
        if (isDebugThemePayloadEnabled()) {
            // eslint-disable-next-line no-console
            console.debug('[Zync PluginPanel] theme payload', payload);
        }
        iframeRef.current.contentWindow.postMessage({
            type: 'zync:theme:update',
            // Back-compat: include the previous `theme` string field as well.
            payload: { theme, ...payload, paneInstanceId }
        }, '*');
    }, [theme, accentColor, paneInstanceId]);

    // Broadcast theme changes to the iframe natively
    useEffect(() => {
        // Theme variables are applied outside this component. Read them after the
        // host has updated its body, including System mode and late theme CSS.
        let frame = 0;
        const scheduleTheme = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(sendTheme);
        };
        const observer = new MutationObserver(scheduleTheme);
        observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
        const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
        systemTheme.addEventListener('change', scheduleTheme);
        window.addEventListener('zync:theme-registry-ready', scheduleTheme);
        scheduleTheme();
        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            systemTheme.removeEventListener('change', scheduleTheme);
            window.removeEventListener('zync:theme-registry-ready', scheduleTheme);
        };
    }, [sendTheme]);

    // Listen for messages FROM the iframe (plugin panel calling zync.*)
    useEffect(() => {
        let active = true;
        const handler = async (e: MessageEvent) => {
            const sourceWindow = iframeRef.current?.contentWindow;
            if (!sourceWindow || e.source !== sourceWindow) return;
            if (e.data?.type === 'zync:shortcut') {
                // This payload can be forged by the plugin; focus and a matching
                // chord do not establish a trusted keypress. Authorize only the
                // explicitly allowed navigation/presentation commands below.
                if (document.activeElement !== iframeRef.current || !document.hasFocus()) return;
                const id = matchPluginShortcut(e.data.payload, shortcutBindingsRef.current);
                if (!id || !isPluginShortcutCommandAllowed(id) || performance.now() - lastShortcutRef.current < 100) return;
                lastShortcutRef.current = performance.now();
                runShortcutCommand(id, new KeyboardEvent('keydown', e.data.payload));
                return;
            }
            if (!legacyAccess) {
                const message = parsePluginPaneMessage(e.data);
                if (message.ok) postPaneMessage(pluginId, panelId, paneInstanceId, message.message);
                return;
            }
            const generation = frameGenerationRef.current;
            const isCurrent = (requester: unknown) => (
                active
                && iframeRef.current?.contentWindow === requester
                && frameGenerationRef.current === generation
            );
            const handled = await handlePanelPluginCommand({
                event: e,
                pluginId,
                connectionId,
                getRequester: () => sourceWindow,
                isCurrent,
                confirm: confirmPluginTerminalAction,
                confirmUi: options => useAppStore.getState().showConfirmDialog(options),
                dispatch: (type, detail) => window.dispatchEvent(new CustomEvent(type, { detail })),
                post: (requester, message) => (requester as Window).postMessage(message, '*'),
                loadSshInvoker: async () => {
                    const { ipcRenderer } = await import('../../lib/tauri-ipc');
                    return (targetConnectionId, command) => ipcRenderer.invoke(
                        'ssh_exec',
                        { connectionId: targetConnectionId, command },
                    );
                },
            });
            if (handled || !isCurrent(sourceWindow)) return;

            const { type, payload } = e.data || {};
            if (!type) return;

            if (type === 'zync:statusbar:set') {
                window.dispatchEvent(new CustomEvent('zync:statusbar:set', { detail: payload }));
            } else if (type === 'zync:ui:notify') {
                window.dispatchEvent(new CustomEvent('zync:ui:notify', { detail: payload }));
            }
        };

        window.addEventListener('message', handler);
        return () => {
            active = false;
            window.removeEventListener('message', handler);
        };
    }, [panelId, pluginId, connectionId, legacyAccess, paneInstanceId, postPaneMessage]);

    useEffect(() => registerPaneMessageTarget(
        pluginId,
        panelId,
        paneInstanceId,
        connectionId ?? 'local',
        message => iframeRef.current?.contentWindow?.postMessage({
            type: 'zync:pane:message',
            payload: message,
        }, '*'),
    ), [connectionId, panelId, pluginId, paneInstanceId, registerPaneMessageTarget]);

    // Inject the zync shim into the panel HTML
    const shimScript = legacyAccess ? `
<script>
window.zync = {
    terminal: {
        send: function(text) {
            window.parent.postMessage({ type: 'zync:terminal:send', payload: { text } }, '*');
        },
        newTab: function(opts) {
            window.parent.postMessage({ type: 'zync:terminal:opentab', payload: opts }, '*');
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
                        if (payload.error) {
                            const error = new Error(typeof payload.error === 'string' ? payload.error : payload.error.message);
                            if (typeof payload.error === 'object') Object.assign(error, payload.error);
                            reject(error);
                        }
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
` : `
<script>
window.zync = Object.freeze({
    pane: Object.freeze({
        postMessage: function(message) {
            window.parent.postMessage({ type: 'zync:pane:message', payload: message }, '*');
        },
        onMessage: function(callback) {
            if (typeof callback !== 'function') return function() {};
            const listener = function(event) {
                if (event.source !== window.parent) return;
                const data = event.data;
                if (data && data.type === 'zync:pane:message') callback(data.payload);
            };
            window.addEventListener('message', listener);
            return function() { window.removeEventListener('message', listener); };
        }
    })
});
</script>
`;

    const securityMeta = `
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
`;

    const injection = `${securityMeta}${pluginShortcutBridgeScript()}${shimScript}`;
    const fullHtml = /<head(?:\s[^>]*)?>/i.test(html)
        ? html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}\n${injection}`)
        : `<html><head>${injection}</head><body>${html}</body></html>`;

    return (
        <div className="absolute inset-0 z-10 bg-app-bg flex flex-col">
            <iframe
                ref={iframeRef}
                srcDoc={fullHtml}
                onLoad={() => {
                    frameGenerationRef.current += 1;
                    sendTheme();
                    sendShortcuts();
                }}
                sandbox={legacyAccess ? 'allow-scripts allow-modals' : 'allow-scripts'}
                className="flex-1 w-full border-0 bg-transparent"
                title={`Plugin Panel: ${panelId}`}
            />
        </div>
    );
}
