import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { ipcRenderer } from '../lib/tauri-ipc';
import { useAppStore } from '../store/useAppStore';

interface Plugin {
    path: string;
    manifest: {
        id: string;
        name: string;
        version: string;
        main?: string;
    };
    script?: string;
    style?: string;
}

interface PluginCommand {
    id: string;
    title: string;
    pluginId: string;
}

interface PluginContextType {
    plugins: Plugin[];
    loaded: boolean;
    commands: PluginCommand[];
    executeCommand: (id: string) => void;
}

const PluginContext = createContext<PluginContextType>({
    plugins: [],
    loaded: false,
    commands: [],
    executeCommand: () => { }
});

export const usePlugins = () => useContext(PluginContext);

// The code that runs INSIDE the Web Worker
// We use a template literal to inject it securely
// The code that runs INSIDE the Web Worker
// We use a template literal to inject it securely
const WORKER_BOOTSTRAP = `
const zync = {
    callbacks: {},
    commandHandlers: {},
    pendingRequests: {},
    
    on: (event, callback) => {
        if (!zync.callbacks[event]) zync.callbacks[event] = [];
        zync.callbacks[event].push(callback);
    },

    emit: (event, data) => {
        if (zync.callbacks[event]) {
            zync.callbacks[event].forEach(cb => cb(data));
        }
    },

    // Generic Request helper
    request: (type, payload) => {
        return new Promise((resolve, reject) => {
             const requestId = Math.random().toString(36).substring(7);
             zync.pendingRequests[requestId] = { resolve, reject };
             self.postMessage({ type, payload: { ...payload, requestId } });
        });
    },

    ui: {
        notify: async (opts) => {
            self.postMessage({ type: 'api:ui:notify', payload: opts });
        }
    },

    fs: {
        readFile: (path) => zync.request('api:fs:read', { path }),
        writeFile: (path, content) => zync.request('api:fs:write', { path, content }),
        ls: (path) => zync.request('api:fs:list', { path }),
        exists: (path) => zync.request('api:fs:exists', { path }),
        mkdir: (path) => zync.request('api:fs:mkdir', { path }),
    },

    commands: {
        register: (id, title, handler) => {
            zync.commandHandlers[id] = handler;
            self.postMessage({ type: 'api:commands:register', payload: { id, title } });
        }
    },
    
    theme: {
        set: (themeName) => {
            self.postMessage({ type: 'api:theme:set', payload: { theme: themeName } });
        }
    },

    window: {
        showQuickPick: (items, options) => {
            return zync.request('api:window:showQuickPick', { items, options });
        },
        create: (options) => {
            return zync.request('api:window:create', options);
        }
    },

    logger: {
        log: (msg) => {
            self.postMessage({ type: 'api:log', payload: msg });
        }
    }
};

self.onmessage = async (e) => {
    const { type, payload } = e.data;
    
    // Handle Responses
    if (type.endsWith(':response')) {
         const { requestId, result, error } = payload;
         // Special handling for Quick Pick legacy format (optional, but good for robust)
         // Actually, if we standardized zync.request, we use zync.pendingRequests
         
         const handler = zync.pendingRequests[requestId];
         if (handler) {
             if (error) handler.reject(error);
             else handler.resolve(result); // Result might be selectedItem or file content
             delete zync.pendingRequests[requestId];
         }
         return;
    }
    
    if (type === 'init') {
        zync.emit('ready');
    } else if (type === 'command:execute') {
        const handler = zync.commandHandlers[payload.id];
        if (handler) await handler();
    }
};

// Expose zync globally to the user script
self.zync = zync;
`;

export const PluginProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [plugins, setPlugins] = useState<Plugin[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [commands, setCommands] = useState<PluginCommand[]>([]);
    const workers = useRef<Map<string, Worker>>(new Map());
    const showToast = useAppStore(state => state.showToast);

    useEffect(() => {
        loadPlugins();
        return () => {
            // Cleanup workers
            workers.current.forEach(w => w.terminate());
            workers.current.clear();
        };
    }, []);

    const loadPlugins = async () => {
        try {
            const loadedPlugins: Plugin[] = await ipcRenderer.invoke('plugins:load');
            console.log('[Plugins] Discovered:', loadedPlugins);
            setPlugins(loadedPlugins);

            // Initialize Workers
            loadedPlugins.forEach(plugin => {
                // 1. Inject CSS if present
                if (plugin.style) {
                    const styleId = `plugin-style-${plugin.manifest.id}`;
                    if (!document.getElementById(styleId)) {
                        const styleEl = document.createElement('style');
                        styleEl.id = styleId;
                        styleEl.textContent = plugin.style;
                        document.head.appendChild(styleEl);
                        // console.log(`[Plugin] Injected styles for ${plugin.manifest.id}`);
                    }
                }

                // 2. Start Worker if script is present
                if (!plugin.script) return;

                try {
                    // Combine bootstrap + user script
                    const blobContent = [WORKER_BOOTSTRAP, '\n\n// USER SCRIPT START\n\n', plugin.script];
                    const blob = new Blob(blobContent, { type: 'application/javascript' });
                    const workerUrl = URL.createObjectURL(blob);

                    const worker = new Worker(workerUrl);

                    // Handle messages FROM the worker
                    worker.onmessage = (e) => {
                        const { type, payload } = e.data;
                        handlePluginMessage(plugin.manifest.id, type, payload);
                    };

                    worker.onerror = (e) => {
                        console.error(`[Plugin Error] ${plugin.manifest.id}:`, e.message);
                    };

                    // Start it
                    worker.postMessage({ type: 'init' });

                    workers.current.set(plugin.manifest.id, worker);

                } catch (err) {
                    console.error(`[Plugin] Failed to start ${plugin.manifest.id}:`, err);
                }
            });

            setLoaded(true);
        } catch (err) {
            console.error('[Plugins] Failed to load:', err);
        }
    };

    const respond = (pluginId: string, type: string, payload: any) => {
        const worker = workers.current.get(pluginId);
        if (worker) {
            worker.postMessage({ type: `${type}:response`, payload });
        }
    };

    const handlePluginMessage = async (pluginId: string, type: string, payload: any) => {
        // API Implementation Bridge
        switch (type) {
            case 'api:ui:notify':
                showToast(payload.type || 'info', payload.message);
                break;
            case 'api:log':
                console.log(`[Plugin Log]`, payload);
                break;
            case 'api:commands:register':
                setCommands(prev => {
                    if (prev.some(cmd => cmd.id === payload.id)) return prev;
                    return [...prev, {
                        id: payload.id,
                        title: payload.title,
                        pluginId
                    }];
                });
                break;
            case 'api:theme:set':
                console.log('[PluginContext] Theme set requested:', payload.theme);
                useAppStore.getState().updateSettings({ theme: payload.theme });
                showToast('success', `Theme changed to ${payload.theme}`);
                break;
            case 'api:window:showQuickPick':
                // Dispatch event for CommandPalette to handle
                window.dispatchEvent(new CustomEvent('zync:quick-pick', {
                    detail: {
                        items: payload.items,
                        options: payload.options,
                        requestId: payload.requestId,
                        pluginId
                    }
                }));
                break;

            // File System Bridge
            case 'api:fs:read':
                try {
                    const content = await ipcRenderer.invoke('plugin_fs_read', { path: payload.path });
                    respond(pluginId, type, { requestId: payload.requestId, result: content });
                } catch (e: any) {
                    respond(pluginId, type, { requestId: payload.requestId, error: e.toString() });
                }
                break;
            case 'api:fs:write':
                try {
                    await ipcRenderer.invoke('plugin_fs_write', { path: payload.path, content: payload.content });
                    respond(pluginId, type, { requestId: payload.requestId, result: true });
                } catch (e: any) {
                    respond(pluginId, type, { requestId: payload.requestId, error: e.toString() });
                }
                break;
            case 'api:fs:list':
                try {
                    const entries = await ipcRenderer.invoke('plugin_fs_list', { path: payload.path });
                    respond(pluginId, type, { requestId: payload.requestId, result: entries });
                } catch (e: any) {
                    respond(pluginId, type, { requestId: payload.requestId, error: e.toString() });
                }
                break;
            case 'api:fs:exists':
                try {
                    const exists = await ipcRenderer.invoke('plugin_fs_exists', { path: payload.path });
                    respond(pluginId, type, { requestId: payload.requestId, result: exists });
                } catch (e: any) {
                    respond(pluginId, type, { requestId: payload.requestId, error: e.toString() });
                }
                break;
            case 'api:fs:mkdir':
                try {
                    await ipcRenderer.invoke('plugin_fs_create_dir', { path: payload.path });
                    respond(pluginId, type, { requestId: payload.requestId, result: true });
                } catch (e: any) {
                    respond(pluginId, type, { requestId: payload.requestId, error: e.toString() });
                }
                break;
            case 'api:window:create':
                try {
                    await ipcRenderer.invoke('plugin_window_create', payload);
                    respond(pluginId, type, { requestId: payload.requestId, result: true });
                } catch (e: any) {
                    respond(pluginId, type, { requestId: payload.requestId, error: e.toString() });
                }
                break;
        }
    };

    const executeCommand = (id: string) => {
        const cmd = commands.find(c => c.id === id);
        if (!cmd) return;

        const worker = workers.current.get(cmd.pluginId);
        if (worker) {
            worker.postMessage({ type: 'command:execute', payload: { id } });
        }
    };

    // Listen for Quick Pick selections from UI
    useEffect(() => {
        const handleQuickPickSelect = (e: any) => {
            const { requestId, pluginId, selectedItem } = e.detail;
            // console.log('[PluginContext] Quick Pick selected:', { requestId, pluginId, selectedItem });

            // Respond using standardized format? 
            // The worker expects `result` in payload for generic handler.
            // But for Quick Pick, we sent `selectedItem`.
            // Let's modify respond helper or just call postMessage manually here to match expectation.
            // Wait, my updated WORKER_BOOTSTRAP uses generic handler which expects `result`.
            // So I should send `result: selectedItem`.

            const worker = workers.current.get(pluginId);
            if (worker) {
                worker.postMessage({
                    type: 'api:window:showQuickPick:response',
                    payload: { requestId, result: selectedItem } // CHANGED from selectedItem to result
                });
            }
        };

        window.addEventListener('zync:quick-pick-select', handleQuickPickSelect);
        return () => window.removeEventListener('zync:quick-pick-select', handleQuickPickSelect);
    }, []);

    return (
        <PluginContext.Provider value={{ plugins, loaded, commands, executeCommand }}>
            {children}
        </PluginContext.Provider>
    );
};
