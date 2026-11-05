import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';

import { notify } from '../features/notifications';
import {
    rejectAllPendingPluginNotifyActions,
    rejectPendingPluginNotifyActionsForPlugin,
} from '../features/notifications/pluginNotifyAction';
import { createPluginMessageBroker } from '../features/plugins/broker/pluginMessageBroker';
import type {
    PluginCommandContribution,
    PluginPanelContribution,
} from '../features/plugins/broker/types';
import { confirmPluginTerminalAction } from '../features/plugins/confirmPluginTerminalAction';
import {
    getPluginManagementDetails,
    rollbackPluginVersion,
} from '../features/plugins/management/pluginManagement';
import {
    filterTrustedBuiltinThemeChoices,
    filterUnsupportedHostThemes,
    handleWorkerTerminalCommand,
    isTrustedBuiltinTheme,
    postCurrentWorkerResponse,
} from '../features/plugins/pluginCommandBridge';
import {
    authorizePluginCapability,
    bindNativePluginPaneConnection,
    clearNativePluginRuntimeFailures,
    clearNativePluginSafeMode,
    getNativePluginRecoveryStatus,
    type NativePluginRecoveryStatus,
    type PluginRuntimeFailureKind,
    recordNativePluginRuntimeFailure,
    resetNativePluginRuntimes,
    startNativePluginRuntime,
    stopNativePluginRuntime,
    unbindNativePluginPaneConnection,
} from '../features/plugins/runtime/nativePluginRuntime';
import { autoRollbackPlugin } from '../features/plugins/runtime/pluginAutoRollback';
import { parsePluginWorkerMessage } from '../features/plugins/runtime/pluginMessageEnvelope';
import { PluginMessageRateLimiter } from '../features/plugins/runtime/pluginMessageRateLimiter';
import {
    PluginPaneBindingQueue,
    postAfterPaneBinding,
} from '../features/plugins/runtime/pluginPaneBindingQueue';
import {
    createPluginReloadQueue,
    PluginLifecycleGeneration,
} from '../features/plugins/runtime/pluginReloadQueue';
import {
    type PluginRuntimeHealth,
    PluginRuntimeSupervisor,
} from '../features/plugins/runtime/pluginRuntimeSupervisor';
import type { Plugin } from '../features/plugins/types';
import { buildWorkspaceViewRegistrations } from '../features/workspace/application/viewRegistrationAdapters';
import { applyCspStyleNonce } from '../lib/cspStyleNonce';
import { ipcRenderer } from '../lib/tauri-ipc';
import { registerThemePluginModes } from '../lib/themeModeRegistry';
import { useAppStore } from '../store/useAppStore';

export type { Plugin } from '../features/plugins/types';

interface PluginContextType {
    plugins: Plugin[];
    editorProviders: Plugin[];
    loaded: boolean;
    commands: PluginCommandContribution[];
    panels: PluginPanelContribution[];
    runtimeHealth: PluginRuntimeHealth[];
    pluginSafeMode: boolean;
    executeCommand: (id: string) => void;
    reloadPlugins: (healthCheckPluginId?: string) => Promise<boolean>;
    retryPluginRuntime: (pluginId: string) => Promise<boolean>;
    exitPluginSafeMode: () => Promise<boolean>;
    postPaneMessage: (
        pluginId: string,
        panelId: string,
        paneInstanceId: string,
        message: unknown,
    ) => boolean;
    registerPaneMessageTarget: (
        pluginId: string,
        panelId: string,
        paneInstanceId: string,
        connectionId: string,
        post: (message: unknown) => void,
        onBound?: (runtime: string) => void,
    ) => () => void;
}

const PluginContext = createContext<PluginContextType>({
    plugins: [],
    editorProviders: [],
    loaded: false,
    commands: [],
    panels: [],
    runtimeHealth: [],
    pluginSafeMode: false,
    /** Ignore command execution before the plugin provider has mounted. */
    executeCommand: () => {},
    reloadPlugins: async () => false,
    retryPluginRuntime: async () => false,
    exitPluginSafeMode: async () => false,
    postPaneMessage: () => false,
    /** Return inert pane cleanup until a provider owns the runtime. */
    registerPaneMessageTarget: () => () => {},
});

export const usePlugins = () => useContext(PluginContext);

const PLUGIN_HEARTBEAT_INTERVAL_MS = 5_000;
const PLUGIN_HEARTBEAT_TIMEOUT_MS = 15_000;
const PLUGIN_ACTIVATION_TIMEOUT_MS = 5_000;

/** Recognize pre-v2 worker routes that require the explicit legacy permission bridge. */
function requiresLegacyWorkerBridge(type: string): boolean {
    return (
        type.startsWith('api:fs:') ||
        type.startsWith('api:window:') ||
        type === 'api:theme:set' ||
        type === 'api:statusbar:set' ||
        type === 'api:plugins:load' ||
        type === 'api:terminal:send'
    );
}

// The code that runs INSIDE the Web Worker
// We use a template literal to inject it securely
const WORKER_BOOTSTRAP = `
const denyAmbientNetwork = () => Promise.reject(new Error(
    'Direct network access is disabled. Use zync.network.fetch for an approved host.'
));
const denyAmbientNetworkConstructor = function () {
    throw new Error('Direct network access is disabled. Use the Zync network API.');
};
const blockedNetworkGlobals = {
    fetch: denyAmbientNetwork,
    XMLHttpRequest: denyAmbientNetworkConstructor,
    WebSocket: denyAmbientNetworkConstructor,
    EventSource: denyAmbientNetworkConstructor,
    Worker: denyAmbientNetworkConstructor,
    SharedWorker: denyAmbientNetworkConstructor,
    WebTransport: denyAmbientNetworkConstructor,
    CacheStorage: denyAmbientNetworkConstructor,
    caches: denyAmbientNetworkConstructor,
    importScripts: denyAmbientNetworkConstructor,
};
for (const [name, replacement] of Object.entries(blockedNetworkGlobals)) {
    let target = self;
    while (target) {
        if (Object.prototype.hasOwnProperty.call(target, name)) {
            try {
                Object.defineProperty(target, name, {
                    value: replacement,
                    writable: false,
                    configurable: false,
                });
            } catch {}
        }
        target = Object.getPrototypeOf(target);
    }
    try {
        Object.defineProperty(self, name, {
            value: replacement,
            writable: false,
            configurable: false,
        });
    } catch {}
}

const zync = {
    callbacks: {},
    commandHandlers: {},
    pendingRequests: new Map(),
    
    on: (event, callback) => {
        if (!zync.callbacks[event]) zync.callbacks[event] = [];
        zync.callbacks[event].push(callback);
        return () => {
            const callbacks = zync.callbacks[event] || [];
            zync.callbacks[event] = callbacks.filter(candidate => candidate !== callback);
        };
    },

    emit: (event, data) => {
        if (zync.callbacks[event]) {
            zync.callbacks[event].forEach(cb => cb(data));
        }
    },

    // Generic Request helper
    request: (() => {
        // Only short host-control reads get a response deadline. Native I/O and user-controlled
        // work keep their existing operation policies; accepted writes are never abandoned here.
        const MAX_PENDING_REQUESTS = 256;
        const REQUEST_RESPONSE_TIMEOUT_MS = 120_000;
        const BOUNDED_RESPONSE_REQUESTS = new Set([
            'api:terminal:context', 'api:panel:post-message',
        ]);
        let nextRequestId = 0;
        return (type, payload) => {
        return new Promise((resolve, reject) => {
             if (zync.pendingRequests.size >= MAX_PENDING_REQUESTS) {
                 reject(new Error('Too many outstanding plugin requests; wait for an earlier response.'));
                 return;
             }
             const requestId = String(++nextRequestId);
             let timer;
             const finish = (failed, value) => {
                 if (zync.pendingRequests.get(requestId) !== entry) return;
                 zync.pendingRequests.delete(requestId);
                 if (timer !== undefined) clearTimeout(timer);
                 if (failed) reject(value);
                 else resolve(value);
             };
             const pause = () => {
                 if (timer !== undefined) clearTimeout(timer);
                 timer = undefined;
             };
             const resume = () => {
                 pause();
                 if (BOUNDED_RESPONSE_REQUESTS.has(type)) {
                     timer = setTimeout(() => finish(true, new Error('Plugin response timed out; operation outcome is unknown.')), REQUEST_RESPONSE_TIMEOUT_MS);
                 }
             };
             const entry = { resolve: result => finish(false, result), reject: error => finish(true, error), pause, resume };
             zync.pendingRequests.set(requestId, entry);
             const requestPayload = { requestId };
             try {
                 for (const [key, value] of Object.entries(payload || {})) {
                     if (key !== 'requestId' && value !== undefined) requestPayload[key] = value;
                 }
                 resume();
                 self.postMessage({ type, payload: requestPayload });
             } catch (error) {
                 finish(true, error);
             }
        });
        };
    })(),

    ui: {
        /**
         * Show a host toast / inbox notification.
         * JSON-only options (no functions). Host tags source as plugin:<id>.
         * Supported: type, message|body|title, duration, persist, silent, history,
         * channel ('auto'|'toast'|'inbox'|'both'), id, actions: [{ id, label, dismiss? }].
         * Action clicks are delivered back as api:ui:notify:action (or zync.ui.onNotifyAction).
         */
        notify: (opts) => zync.request('api:ui:notify', opts),
        /** Show a Zync-owned confirmation dialog after the plugin is granted permission. */
        confirm: (opts) => zync.request('api:ui:confirm', opts),
        /**
         * Register a handler for notification action button clicks.
         * payload: { requestId, pluginId, actionId, notificationId?, message, type }
         * Handler may be async and may return { ok: false, error: '...' } to fail the action.
         * Returns an unsubscribe function.
         */
        onNotifyAction: (callback) => {
            if (typeof callback !== 'function') return () => {};
            if (!zync.callbacks['ui:notify:action']) zync.callbacks['ui:notify:action'] = [];
            zync.callbacks['ui:notify:action'].push(callback);
            return () => {
                const list = zync.callbacks['ui:notify:action'] || [];
                zync.callbacks['ui:notify:action'] = list.filter(cb => cb !== callback);
            };
        },
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
            return zync.request('api:commands:register', { id, title }).catch(error => {
                if (zync.commandHandlers[id] === handler) delete zync.commandHandlers[id];
                throw error;
            });
        }
    },

    storage: {
        get: (key) => zync.request('api:storage:get', { key }),
        keys: () => zync.request('api:storage:keys', {}),
        set: (key, value) => zync.request('api:storage:set', { key, value }),
        delete: (key) => zync.request('api:storage:delete', { key }),
    },

    network: {
        fetch: (url, options = {}) => zync.request('api:network:fetch', {
            url,
            accept: options.accept,
        }),
    },

    filesystem: {
        pickFile: () => zync.request('api:filesystem:pick', { kind: 'file' }),
        pickDirectory: () => zync.request('api:filesystem:pick', { kind: 'directory' }),
        pickWriteFile: () => zync.request('api:filesystem:pick-write-file', {}),
        readText: (handle, relativePath) => zync.request('api:filesystem:read-text', {
            handle,
            relativePath,
        }),
        writeText: (handle, content) => zync.request('api:filesystem:write-text', {
            handle,
            content,
        }),
        list: (handle, relativePath) => zync.request('api:filesystem:list', {
            handle,
            relativePath,
        }),
    },

    sshFilesystem: {
        list: (paneInstanceId, relativePath) => zync.request('api:ssh-filesystem:list', {
            paneInstanceId,
            relativePath,
        }),
        readText: (paneInstanceId, relativePath) => zync.request('api:ssh-filesystem:read-text', {
            paneInstanceId,
            relativePath,
        }),
    },
    sshCommand: {
        execute: (paneInstanceId, request) => zync.request('api:ssh-command:execute', {
            paneInstanceId,
            request,
        }),
    },
    sshTerminal: {
        context: paneInstanceId => zync.request('api:terminal:context', { paneInstanceId }),
        prepare: (paneInstanceId, request) => zync.request('api:terminal:prepare', { paneInstanceId, request }),
    },
    
    theme: {
        set: (themeName) => {
            self.postMessage({ type: 'api:theme:set', payload: { theme: themeName } });
        }
    },

    terminal: {
        send: (text) => {
            self.postMessage({ type: 'api:terminal:send', payload: { text } });
        }
    },

    statusBar: {
        set: (id, text) => {
            self.postMessage({ type: 'api:statusbar:set', payload: { id, text } });
        },
        clear: (id) => {
            self.postMessage({ type: 'api:statusbar:set', payload: { id, text: '' } });
        }
    },

    panel: {
        onMessage: (callback) => zync.on('pane:message', callback),
        postMessage: (paneInstanceId, message) => zync.request('api:panel:post-message', { paneInstanceId, message }),
        register: (id, title, html) => zync.request('api:panel:register', { id, title, html })
    },

    window: {
        showQuickPick: (items, options) => {
            return zync.request('api:window:showQuickPick', { items, options });
        }
    },

    plugins: {
        list: () => zync.request('api:plugins:load', {})
    },

    logger: {
        log: (msg) => {
            self.postMessage({ type: 'api:log', payload: msg });
        }
    }
};

self.onmessage = async (e) => {
    const { type, payload } = e.data;

    if (type === 'host:request:phase') {
        const handler = zync.pendingRequests.get(payload && payload.requestId);
        if (handler) {
            if (payload.waitingForUser) handler.pause();
            else handler.resume();
        }
        return;
    }
    
    // Handle Responses
    if (type.endsWith(':response')) {
         const { requestId, result, error } = payload;
         const handler = zync.pendingRequests.get(requestId);
         if (handler) {
             if (error) handler.reject(error);
             else handler.resolve(result); // Result might be selectedItem or file content
         }
         return;
    }
    
    if (type === 'host:heartbeat:ping') {
        self.postMessage({ type: 'host:heartbeat:pong', payload: { nonce: payload && payload.nonce } });
    } else if (type === 'init') {
        const callbacks = zync.callbacks.ready || [];
        for (const callback of callbacks) await callback();
        self.postMessage({ type: 'host:runtime:ready', payload: {} });
    } else if (type === 'command:execute') {
        const handler = zync.commandHandlers[payload.id];
        if (handler) await handler();
    } else if (type === 'pane:message') {
        zync.emit('pane:message', payload);
    } else if (type === 'api:ui:notify:action') {
        const requestId = payload && payload.requestId;
        const respond = (result, error) => {
            if (!requestId) return;
            self.postMessage({
                type: 'api:ui:notify:action:response',
                payload: error
                    ? { requestId, error: String(error) }
                    : { requestId, result: result ?? { ok: true } },
            });
        };
        try {
            const callbacks = zync.callbacks['ui:notify:action'] || [];
            let lastResult = { ok: true };
            for (const cb of callbacks) {
                const out = await cb(payload);
                if (out && typeof out === 'object') {
                    lastResult = out;
                }
            }
            if (lastResult && lastResult.ok === false) {
                respond(lastResult, lastResult.error || 'Action failed');
            } else {
                respond(lastResult || { ok: true });
            }
        } catch (err) {
            respond(null, err && err.message ? err.message : String(err || 'Action failed'));
        }
    }
};

// Expose zync globally to the user script
self.zync = zync;
`;

/** Own sandbox workers, native runtime identities, contributions and generation-fenced cleanup. */
export const PluginProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [plugins, setPlugins] = useState<Plugin[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [commands, setCommands] = useState<PluginCommandContribution[]>([]);
    const [panels, setPanels] = useState<PluginPanelContribution[]>([]);
    useEffect(() => {
        // A single transient metadata snapshot serves UI and store-level split guards.
        // This never opens panels, persists plugin runtime data or grants permissions.
        useAppStore
            .getState()
            .setWorkspaceViewRegistry(buildWorkspaceViewRegistrations(panels, plugins));
    }, [panels, plugins]);
    const [runtimeHealth, setRuntimeHealth] = useState<PluginRuntimeHealth[]>([]);
    const [pluginSafeMode, setPluginSafeMode] = useState(false);
    const runtimeSupervisor = useRef(new PluginRuntimeSupervisor<Worker>());
    const paneMessageTargets = useRef(
        new Map<
            string,
            {
                panelId: string;
                post: (message: unknown) => void;
                ready: Promise<void>;
            }
        >(),
    );
    const paneBindingQueue = useRef(new PluginPaneBindingQueue());
    const trustedBuiltinThemes = useRef<Plugin[]>([]);
    const messageBroker = useMemo(
        () =>
            createPluginMessageBroker<Worker>({
                runtime: {
                    /** Resolve the active native runtime identity for a plugin. */
                    getRuntimeInstanceId: (pluginId) =>
                        runtimeSupervisor.current.getRuntimeInstanceId(pluginId),
                    /** Reject messages from a worker superseded by reload or recovery. */
                    isCurrentWorker: (pluginId, worker) =>
                        runtimeSupervisor.current.isCurrentWorker(pluginId, worker),
                    /** Check the captured native runtime still belongs to this plugin generation. */
                    isCurrentRuntime: (pluginId, runtimeInstanceId) =>
                        runtimeSupervisor.current.isCurrentRuntime(pluginId, runtimeInstanceId),
                },
                /** Resolve only the current host-owned pane message destination. */
                getPaneMessageTarget: (pluginId, paneInstanceId) =>
                    paneMessageTargets.current.get(`${pluginId}\0${paneInstanceId}`),
                /** Replace a command contribution by identity without duplicating its registration. */
                registerCommand: (command) => {
                    setCommands((previous) =>
                        previous.some((existing) => existing.id === command.id)
                            ? previous
                            : [...previous, command],
                    );
                },
                /** Replace a panel contribution by identity while retaining its owning plugin. */
                registerPanel: (panel) => {
                    setPanels((previous) =>
                        previous.some((existing) => existing.id === panel.id)
                            ? previous
                            : [...previous, panel],
                    );
                },
                dispatch: (type, detail) => window.dispatchEvent(new CustomEvent(type, { detail })),
            }),
        [],
    );
    const reloadPluginsRef = useRef<(healthCheckPluginId?: string) => Promise<boolean>>(
        async () => false,
    );
    const reloadQueue = useRef(createPluginReloadQueue());
    const lifecycleGeneration = useRef(new PluginLifecycleGeneration());
    const autoRollbackInFlight = useRef(new Set<string>());
    const autoRollbackAttemptedVersions = useRef(new Set<string>());
    const editorProviders = useMemo(
        () =>
            plugins.filter(
                (plugin) =>
                    plugin.enabled &&
                    plugin.manifest.type === 'editor-provider' &&
                    (!pluginSafeMode || plugin.path.startsWith('builtin://')),
            ),
        [pluginSafeMode, plugins],
    );

    const attemptAutomaticRollback = useCallback(async (pluginId: string) => {
        if (autoRollbackInFlight.current.has(pluginId)) {
            return;
        }
        autoRollbackInFlight.current.add(pluginId);
        try {
            const details = await getPluginManagementDetails(pluginId);
            const attemptKey = `${pluginId}@${details.version}`;
            if (!details.rollback || autoRollbackAttemptedVersions.current.has(attemptKey)) {
                return;
            }
            autoRollbackAttemptedVersions.current.add(attemptKey);

            const result = await autoRollbackPlugin(pluginId, {
                rollback: rollbackPluginVersion,
                clearFailures: clearNativePluginRuntimeFailures,
                /** Clear local runtime quarantine before retrying a retained plugin version. */
                clearQuarantine: (id) => runtimeSupervisor.current.clearQuarantine(id),
                /** Reload the selected plugin and await its activation health check. */
                reloadAndCheck: (id) => reloadPluginsRef.current(id),
            });
            if (result.status === 'restored') {
                notify.warning(
                    `Plugin ${pluginId} crashed repeatedly. Zync restored version ${result.restoredVersion}.`,
                    { history: true, source: `plugin:${pluginId}` },
                );
                return;
            }
            notify.error(
                result.runtimeHealthy
                    ? `Plugin version ${result.failedVersion} also failed. Zync restored version ${result.restoredVersion}.`
                    : `Plugin recovery failed for ${pluginId}. The plugin remains stopped.`,
                { persist: !result.runtimeHealthy, history: true, source: `plugin:${pluginId}` },
            );
        } catch (error) {
            // No retained package is a normal state for a first install. The runtime stays
            // quarantined and Settings continues to offer the existing retry controls.
            console.error(`[Plugins] Automatic rollback was unavailable for ${pluginId}:`, error);
        } finally {
            autoRollbackInFlight.current.delete(pluginId);
        }
    }, []);

    const persistFailureAndRecover = useCallback(
        (pluginId: string, failureKind: PluginRuntimeFailureKind) => {
            void recordNativePluginRuntimeFailure(pluginId, failureKind)
                .catch((error) => {
                    console.error('[Plugins] Failed to persist runtime diagnostic:', error);
                })
                .finally(() => {
                    const health = runtimeSupervisor.current
                        .snapshot()
                        .find((item) => item.pluginId === pluginId);
                    if (health?.status === 'quarantined') {
                        void attemptAutomaticRollback(pluginId);
                    }
                });
        },
        [attemptAutomaticRollback],
    );

    const cleanUpFailedRuntime = useCallback(
        (
            pluginId: string,
            runtimeInstanceId: string | null,
            failureKind: PluginRuntimeFailureKind,
        ) => {
            rejectPendingPluginNotifyActionsForPlugin(pluginId, 'Plugin runtime stopped');
            setCommands((previous) => previous.filter((command) => command.pluginId !== pluginId));
            setPanels((previous) => previous.filter((panel) => panel.pluginId !== pluginId));
            if (runtimeInstanceId) {
                void stopNativePluginRuntime(runtimeInstanceId);
            }
            persistFailureAndRecover(pluginId, failureKind);
        },
        [persistFailureAndRecover],
    );

    useEffect(() => {
        const unsubscribeHealth = runtimeSupervisor.current.subscribe(setRuntimeHealth);
        const heartbeatTimer = window.setInterval(() => {
            const heartbeat = runtimeSupervisor.current.pollHeartbeats(PLUGIN_HEARTBEAT_TIMEOUT_MS);
            heartbeat.probes.forEach(({ worker, nonce }) => {
                worker.postMessage({ type: 'host:heartbeat:ping', payload: { nonce } });
            });
            heartbeat.unresponsive.forEach(({ pluginId, runtimeInstanceId }) => {
                cleanUpFailedRuntime(pluginId, runtimeInstanceId, 'heartbeat-timeout');
            });
        }, PLUGIN_HEARTBEAT_INTERVAL_MS);
        lifecycleGeneration.current.begin();
        void reloadPlugins();
        return () => {
            lifecycleGeneration.current.invalidate();
            window.clearInterval(heartbeatTimer);
            rejectAllPendingPluginNotifyActions('Plugins shutting down');
            runtimeSupervisor.current.stopAll((pluginId) => {
                rejectPendingPluginNotifyActionsForPlugin(pluginId, 'Plugins shutting down');
            });
            paneMessageTargets.current.clear();
            paneBindingQueue.current.clear();
            unsubscribeHealth();
            // Let an in-flight start release its lease before resetting the broker.
            void reloadQueue
                .current(() => resetNativePluginRuntimes())
                .catch((error) => {
                    console.error(
                        '[Plugins] Failed to reset native runtimes during shutdown:',
                        error,
                    );
                });
            trustedBuiltinThemes.current = [];
            document
                .querySelectorAll('style[data-zync-builtin-theme]')
                .forEach((style) => style.remove());
        };
    }, []);

    /** Reload verified plugins under a captured lifecycle generation and release stale starts. */
    const reloadPluginsUnsafe = async (
        healthCheckPluginId: string | undefined,
        isCurrent: () => boolean,
    ): Promise<boolean> => {
        try {
            if (!isCurrent()) {
                return false;
            }
            runtimeSupervisor.current.stopAll((pluginId) => {
                rejectPendingPluginNotifyActionsForPlugin(pluginId, 'Plugin reloaded');
            });
            // Registrations and routing belong to the Workers just stopped, even if reload fails.
            setCommands([]);
            setPanels([]);
            paneMessageTargets.current.clear();
            paneBindingQueue.current.clear();
            await resetNativePluginRuntimes();
            if (!isCurrent()) {
                return false;
            }
            if (healthCheckPluginId) {
                // An explicit activation check is a fresh generation. Old crash-loop state
                // must not prevent the package the user just installed or restored from starting.
                await clearNativePluginRuntimeFailures(healthCheckPluginId);
                runtimeSupervisor.current.clearQuarantine(healthCheckPluginId);
            }
            const loadedPlugins: Plugin[] = await ipcRenderer.invoke('plugins:load');
            if (!isCurrent()) {
                return false;
            }
            let recovery: NativePluginRecoveryStatus;
            try {
                recovery = await getNativePluginRecoveryStatus();
            } catch (error) {
                // Unknown history cannot safely authorize a new Worker generation.
                // Preserve supervisor quarantine and let an explicit reload retry status.
                console.warn('[Plugins] Recovery history is unavailable:', error);
                throw new Error('Plugin startup blocked: recovery history is unavailable.');
            }
            if (!isCurrent()) {
                return false;
            }
            // Ignore the retired global flag from older hosts and saved state.
            recovery.safeMode = false;
            setPluginSafeMode(false);
            recovery.diagnostics.forEach((diagnostic) => {
                runtimeSupervisor.current.restoreFailures(
                    diagnostic.pluginId,
                    diagnostic.failures.map((failure) => failure.atMs),
                    diagnostic.failures[diagnostic.failures.length - 1]?.kind,
                );
            });
            console.log('[Plugins] Discovered:', loadedPlugins);

            // Only app-owned built-in themes may style the host document or start a theme runtime.
            const hostCompatiblePlugins = filterUnsupportedHostThemes(loadedPlugins);
            const enabledPlugins = hostCompatiblePlugins.filter((plugin) => plugin.enabled);
            trustedBuiltinThemes.current = enabledPlugins.filter(isTrustedBuiltinTheme);
            runtimeSupervisor.current.syncKnownPlugins(
                hostCompatiblePlugins.map((plugin) => ({
                    pluginId: plugin.manifest.id,
                    enabled: plugin.enabled,
                    runnable: typeof plugin.script === 'string' && plugin.script.length > 0,
                    safeModeBlocked: recovery.safeMode && !plugin.path.startsWith('builtin://'),
                })),
            );
            const runnablePlugins = hostCompatiblePlugins.filter(
                (plugin): plugin is Plugin & { script: string } =>
                    plugin.enabled &&
                    (!recovery.safeMode || plugin.path.startsWith('builtin://')) &&
                    typeof plugin.script === 'string' &&
                    plugin.script.length > 0,
            );
            const healthCheckPlugin = healthCheckPluginId
                ? hostCompatiblePlugins.find((plugin) => plugin.manifest.id === healthCheckPluginId)
                : undefined;
            if (healthCheckPluginId && !healthCheckPlugin) {
                return false;
            }
            const targetBlockedBySafeMode = Boolean(
                healthCheckPlugin &&
                    recovery.safeMode &&
                    !healthCheckPlugin.path.startsWith('builtin://'),
            );
            let targetRuntimeCheck: 'healthy' | 'failed' | 'unchecked' = !healthCheckPlugin
                ? 'healthy'
                : targetBlockedBySafeMode ||
                    !healthCheckPlugin.enabled ||
                    typeof healthCheckPlugin.script !== 'string' ||
                    healthCheckPlugin.script.length === 0
                  ? 'unchecked'
                  : 'failed';

            document
                .querySelectorAll('style[data-zync-builtin-theme]')
                .forEach((style) => style.remove());
            enabledPlugins.forEach((plugin) => {
                if (!isTrustedBuiltinTheme(plugin) || !plugin.style) {
                    return;
                }
                const style = document.createElement('style');
                applyCspStyleNonce(style);
                style.dataset.zyncBuiltinTheme = plugin.manifest.id;
                style.textContent = plugin.style;
                document.head.appendChild(style);
            });

            // Third-party manifest.style is never injected. Editor styles remain inside
            // EditorPluginFrame; builtin:// theme CSS is trusted app-owned content.
            registerThemePluginModes(enabledPlugins);
            window.dispatchEvent(new CustomEvent('zync:theme-registry-ready'));
            setPlugins(loadedPlugins);
            // Initialize Workers
            for (const plugin of runnablePlugins) {
                if (!runtimeSupervisor.current.beginStart(plugin.manifest.id)) {
                    continue;
                }
                let runtimeInstanceId: string | null = null;
                try {
                    runtimeInstanceId = await startNativePluginRuntime(plugin.manifest.id);
                    if (!isCurrent()) {
                        await stopNativePluginRuntime(runtimeInstanceId);
                        return false;
                    }
                    // Combine bootstrap + user script
                    const blobContent = [
                        WORKER_BOOTSTRAP,
                        '\n\n// USER SCRIPT START\n\n',
                        plugin.script,
                    ];
                    const blob = new Blob(blobContent, { type: 'application/javascript' });
                    const workerUrl = URL.createObjectURL(blob);

                    const worker = new Worker(workerUrl);
                    URL.revokeObjectURL(workerUrl);
                    const messageRateLimiter = new PluginMessageRateLimiter();
                    let finishActivationCheck: ((healthy: boolean) => void) | null = null;
                    const activationCheck =
                        plugin.manifest.id === healthCheckPluginId
                            ? new Promise<boolean>((resolve) => {
                                  finishActivationCheck = resolve;
                              })
                            : null;

                    // Handle messages FROM the worker
                    worker.onmessage = (e) => {
                        if (!messageRateLimiter.consume()) {
                            const crashedRuntimeId = runtimeSupervisor.current.markCrash(
                                plugin.manifest.id,
                                worker,
                                'Plugin Worker exceeded the host message rate limit',
                            );
                            if (crashedRuntimeId) {
                                cleanUpFailedRuntime(
                                    plugin.manifest.id,
                                    crashedRuntimeId,
                                    'worker-error',
                                );
                            }
                            return;
                        }
                        const message = parsePluginWorkerMessage(e.data);
                        if (!message) {
                            const crashedRuntimeId = runtimeSupervisor.current.markCrash(
                                plugin.manifest.id,
                                worker,
                                'Plugin Worker sent an invalid or oversized message',
                            );
                            if (crashedRuntimeId) {
                                cleanUpFailedRuntime(
                                    plugin.manifest.id,
                                    crashedRuntimeId,
                                    'worker-error',
                                );
                            }
                            return;
                        }
                        const { type, payload } = message;
                        if (type === 'host:heartbeat:pong') {
                            const nonce =
                                payload !== null && typeof payload === 'object'
                                    ? (payload as Record<string, unknown>).nonce
                                    : undefined;
                            runtimeSupervisor.current.acknowledgeHeartbeat(
                                plugin.manifest.id,
                                worker,
                                nonce,
                            );
                            return;
                        }
                        if (type === 'host:runtime:ready') {
                            finishActivationCheck?.(true);
                            finishActivationCheck = null;
                            return;
                        }
                        handlePluginMessage(plugin.manifest.id, type, payload, worker);
                    };

                    worker.onerror = (e) => {
                        console.error(`[Plugin Error] ${plugin.manifest.id}:`, e.message);
                        const crashedRuntimeId = runtimeSupervisor.current.markCrash(
                            plugin.manifest.id,
                            worker,
                            e.message || 'Plugin Worker crashed',
                        );
                        finishActivationCheck?.(false);
                        finishActivationCheck = null;
                        if (!crashedRuntimeId) {
                            return;
                        }
                        cleanUpFailedRuntime(plugin.manifest.id, crashedRuntimeId, 'worker-error');
                    };

                    runtimeSupervisor.current.attach(plugin.manifest.id, worker, runtimeInstanceId);

                    // Start only after both the frontend Worker and native runtime identities exist.
                    worker.postMessage({ type: 'init' });

                    if (activationCheck) {
                        const timeout = new Promise<boolean>((resolve) => {
                            window.setTimeout(() => resolve(false), PLUGIN_ACTIVATION_TIMEOUT_MS);
                        });
                        const runtimeHealthy = await Promise.race([activationCheck, timeout]);
                        if (!isCurrent()) {
                            return false;
                        }
                        targetRuntimeCheck = runtimeHealthy ? 'healthy' : 'failed';
                        if (
                            !runtimeHealthy &&
                            runtimeSupervisor.current.isCurrentWorker(plugin.manifest.id, worker)
                        ) {
                            const crashedRuntimeId = runtimeSupervisor.current.markCrash(
                                plugin.manifest.id,
                                worker,
                                'Plugin did not become ready during activation',
                            );
                            if (crashedRuntimeId) {
                                cleanUpFailedRuntime(
                                    plugin.manifest.id,
                                    crashedRuntimeId,
                                    'start-failure',
                                );
                            }
                        }
                    }
                } catch (err) {
                    if (!isCurrent()) {
                        return false;
                    }
                    console.error(`[Plugin] Failed to start ${plugin.manifest.id}:`, err);
                    runtimeSupervisor.current.markStartFailure(plugin.manifest.id, err);
                    persistFailureAndRecover(plugin.manifest.id, 'start-failure');
                    if (runtimeInstanceId) {
                        void stopNativePluginRuntime(runtimeInstanceId);
                    }
                    if (plugin.manifest.id === healthCheckPluginId) {
                        targetRuntimeCheck = 'failed';
                    }
                }
            }

            if (!isCurrent()) {
                return false;
            }
            setLoaded(true);
            // Recovery state can restore a crash-loop quarantine before any new Worker starts.
            // Defer rollback until this reload has fully released the current generation.
            runtimeSupervisor.current
                .snapshot()
                .filter((health) => health.status === 'quarantined')
                .forEach((health) => {
                    window.setTimeout(() => void attemptAutomaticRollback(health.pluginId), 0);
                });
            return targetRuntimeCheck !== 'failed';
        } catch (err) {
            console.error('[Plugins] Failed to load:', err);
            return false;
        }
    };

    const reloadPlugins = (healthCheckPluginId?: string): Promise<boolean> => {
        const isCurrent = lifecycleGeneration.current.capture();
        return reloadQueue.current(() => reloadPluginsUnsafe(healthCheckPluginId, isCurrent));
    };

    /** Deliver a response only to the worker that still owns this plugin generation. */
    const respond = (
        requester: Worker,
        pluginId: string,
        type: string,
        payload: Record<string, unknown>,
    ) => {
        postCurrentWorkerResponse(
            requester,
            (candidate) => runtimeSupervisor.current.isCurrentWorker(pluginId, candidate),
            type,
            payload,
        );
    };

    /** Route current worker requests through the host broker and explicit legacy adapters. */
    const handlePluginMessage = async (
        pluginId: string,
        rawType: unknown,
        rawPayload: unknown,
        requester: Worker,
    ) => {
        if (!runtimeSupervisor.current.isCurrentWorker(pluginId, requester)) {
            return;
        }
        if (typeof rawType !== 'string') {
            return;
        }
        const type = rawType;
        const payload =
            rawPayload !== null && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
                ? (rawPayload as Record<string, unknown>)
                : {};
        if (requiresLegacyWorkerBridge(type)) {
            const runtimeInstanceId = runtimeSupervisor.current.getRuntimeInstanceId(pluginId);
            try {
                if (!runtimeInstanceId) {
                    throw new Error('Plugin runtime is not registered');
                }
                await authorizePluginCapability(runtimeInstanceId, 'legacy.compatibility');
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                respond(requester, pluginId, type, {
                    requestId: payload?.requestId,
                    error: message,
                });
                return;
            }
            if (
                !runtimeSupervisor.current.isCurrentWorker(pluginId, requester) ||
                !runtimeSupervisor.current.isCurrentRuntime(pluginId, runtimeInstanceId)
            ) {
                return;
            }
        }
        if (
            type === 'api:terminal:send' &&
            (await handleWorkerTerminalCommand({
                type,
                payload,
                pluginId,
                requester,
                /** Fence asynchronous terminal work to its captured worker and native runtime. */
                isCurrent: (candidate) =>
                    runtimeSupervisor.current.isCurrentWorker(pluginId, candidate as Worker),
                confirm: confirmPluginTerminalAction,
                getActiveConnectionId: () => useAppStore.getState().activeConnectionId,
                /** Publish terminal host events through the existing application event channel. */
                dispatch: (eventType, detail) =>
                    window.dispatchEvent(new CustomEvent(eventType, { detail })),
            }))
        ) {
            return;
        }
        if (await messageBroker.handleMessage(pluginId, type, rawPayload, requester)) {
            return;
        }

        // Manifest v1 compatibility stays here until the published migration window closes.
        switch (type) {
            case 'api:statusbar:set':
                window.dispatchEvent(
                    new CustomEvent('zync:statusbar:set', {
                        detail: { id: payload.id, text: payload.text },
                    }),
                );
                break;
            case 'api:theme:set': {
                const theme = typeof payload.theme === 'string' ? payload.theme : '';
                if (!theme) {
                    break;
                }
                console.log('[PluginContext] Theme set requested:', theme);
                useAppStore.getState().updateSettings({ theme });
                notify.success(`Theme changed to ${theme}`, { source: `plugin:${pluginId}` });
                break;
            }
            case 'api:window:showQuickPick': {
                const items = Array.isArray(payload.items)
                    ? payload.items.filter(
                          (item): item is Record<string, unknown> =>
                              item !== null && typeof item === 'object' && !Array.isArray(item),
                      )
                    : [];
                // Dispatch event for CommandPalette to handle
                window.dispatchEvent(
                    new CustomEvent('zync:quick-pick', {
                        detail: {
                            items:
                                pluginId === 'com.zync.theme.manager'
                                    ? filterTrustedBuiltinThemeChoices(
                                          items,
                                          trustedBuiltinThemes.current,
                                      )
                                    : items,
                            options: payload.options,
                            requestId: payload.requestId,
                            pluginId,
                            requester,
                        },
                    }),
                );
                break;
            }
            case 'api:plugins:load':
                try {
                    const list = await ipcRenderer.invoke('plugins:load');
                    respond(requester, pluginId, 'api:plugins:load', {
                        requestId: payload.requestId,
                        result: filterUnsupportedHostThemes(list),
                    });
                } catch (e) {
                    console.error('[PluginContext] Failed to load plugins for worker:', e);
                    respond(requester, pluginId, 'api:plugins:load', {
                        requestId: payload.requestId,
                        result: [],
                        error: String(e),
                    });
                }
                break;

            // File System Bridge
            case 'api:fs:read':
                try {
                    const content = await ipcRenderer.invoke('plugin_fs_read', {
                        path: payload.path,
                    });
                    respond(requester, pluginId, type, {
                        requestId: payload.requestId,
                        result: content,
                    });
                } catch (e: any) {
                    respond(requester, pluginId, type, {
                        requestId: payload.requestId,
                        error: e.toString(),
                    });
                }
                break;
            case 'api:fs:write':
                try {
                    await ipcRenderer.invoke('plugin_fs_write', {
                        path: payload.path,
                        content: payload.content,
                    });
                    respond(requester, pluginId, type, {
                        requestId: payload.requestId,
                        result: true,
                    });
                } catch (e: any) {
                    respond(requester, pluginId, type, {
                        requestId: payload.requestId,
                        error: e.toString(),
                    });
                }
                break;
            case 'api:fs:list':
                try {
                    const entries = await ipcRenderer.invoke('plugin_fs_list', {
                        path: payload.path,
                    });
                    respond(requester, pluginId, type, {
                        requestId: payload.requestId,
                        result: entries,
                    });
                } catch (e: any) {
                    respond(requester, pluginId, type, {
                        requestId: payload.requestId,
                        error: e.toString(),
                    });
                }
                break;
            case 'api:fs:exists':
                try {
                    const exists = await ipcRenderer.invoke('plugin_fs_exists', {
                        path: payload.path,
                    });
                    respond(requester, pluginId, type, {
                        requestId: payload.requestId,
                        result: exists,
                    });
                } catch (e: any) {
                    respond(requester, pluginId, type, {
                        requestId: payload.requestId,
                        error: e.toString(),
                    });
                }
                break;
            case 'api:fs:mkdir':
                try {
                    await ipcRenderer.invoke('plugin_fs_create_dir', { path: payload.path });
                    respond(requester, pluginId, type, {
                        requestId: payload.requestId,
                        result: true,
                    });
                } catch (e: any) {
                    respond(requester, pluginId, type, {
                        requestId: payload.requestId,
                        error: e.toString(),
                    });
                }
                break;
        }
    };

    /** Dispatch a registered command to its current plugin worker. */
    const executeCommand = (id: string) => {
        const cmd = commands.find((c) => c.id === id);
        if (!cmd) {
            return;
        }

        const worker = runtimeSupervisor.current.getWorker(cmd.pluginId);
        if (worker) {
            worker.postMessage({ type: 'command:execute', payload: { id } });
        }
    };
    reloadPluginsRef.current = reloadPlugins;

    /** Clear retryable runtime failure state and reload the selected plugin. */
    const retryPluginRuntime = async (pluginId: string): Promise<boolean> => {
        try {
            const health = runtimeSupervisor.current
                .snapshot()
                .find((item) => item.pluginId === pluginId);
            if (health?.status === 'quarantined') {
                await clearNativePluginRuntimeFailures(pluginId);
                runtimeSupervisor.current.clearQuarantine(pluginId);
            }
            return reloadPlugins();
        } catch (error) {
            console.error(`[Plugins] Failed to retry ${pluginId}:`, error);
            return false;
        }
    };

    const exitPluginSafeMode = async (): Promise<boolean> => {
        try {
            await clearNativePluginSafeMode();
            setPluginSafeMode(false);
            return reloadPlugins();
        } catch (error) {
            console.error('[Plugins] Failed to leave safe mode:', error);
            return false;
        }
    };

    const postPaneMessage = useCallback(
        (pluginId: string, panelId: string, paneInstanceId: string, message: unknown): boolean => {
            const worker = runtimeSupervisor.current.getWorker(pluginId);
            const key = `${pluginId}\0${paneInstanceId}`;
            const target = paneMessageTargets.current.get(key);
            if (!worker || !target || target.panelId !== panelId) {
                return false;
            }
            // A frame can start before native binding finishes, or disappear during a split.
            void postAfterPaneBinding(
                target.ready,
                () =>
                    paneMessageTargets.current.get(key) === target &&
                    runtimeSupervisor.current.isCurrentWorker(pluginId, worker),
                () =>
                    worker.postMessage({
                        type: 'pane:message',
                        payload: { panelId, paneInstanceId, message },
                    }),
            ).catch((error) => console.error('[Plugins] Pane connection is unavailable:', error));
            return true;
        },
        [cleanUpFailedRuntime],
    );

    const registerPaneMessageTarget = useCallback(
        (
            pluginId: string,
            panelId: string,
            paneInstanceId: string,
            connectionId: string,
            post: (message: unknown) => void,
            onBound?: (runtime: string) => void,
        ) => {
            const key = `${pluginId}\0${paneInstanceId}`;
            const target = { panelId, post, ready: Promise.resolve() };
            paneMessageTargets.current.set(key, target);
            const runtimeInstanceId = runtimeSupervisor.current.getRuntimeInstanceId(pluginId);
            if (runtimeInstanceId) {
                target.ready = paneBindingQueue.current.enqueue(key, async () => {
                    if (!runtimeSupervisor.current.isCurrentRuntime(pluginId, runtimeInstanceId)) {
                        return;
                    }
                    try {
                        await bindNativePluginPaneConnection(
                            runtimeInstanceId,
                            panelId,
                            paneInstanceId,
                            connectionId,
                        );
                        if (
                            paneMessageTargets.current.get(key) === target &&
                            runtimeSupervisor.current.isCurrentRuntime(pluginId, runtimeInstanceId)
                        ) {
                            onBound?.(runtimeInstanceId);
                        }
                    } catch (error) {
                        if (
                            runtimeSupervisor.current.isCurrentRuntime(pluginId, runtimeInstanceId)
                        ) {
                            throw error;
                        }
                    }
                });
                void target.ready.catch((error) =>
                    console.error('[Plugins] Failed to bind pane connection:', error),
                );
            }
            return () => {
                if (paneMessageTargets.current.get(key) === target) {
                    paneMessageTargets.current.delete(key);
                    if (runtimeInstanceId) {
                        void paneBindingQueue.current
                            .enqueue(key, () =>
                                unbindNativePluginPaneConnection(runtimeInstanceId, paneInstanceId),
                            )
                            .catch((error) => {
                                console.error('[Plugins] Failed to unbind pane connection:', error);
                            });
                    }
                }
            };
        },
        [],
    );

    // Listen for Quick Pick selections from UI
    useEffect(() => {
        /** Return a quick-pick result to its captured current requester. */
        const handleQuickPickSelect = (e: any) => {
            const {
                requestId,
                pluginId,
                selectedItem,
                requester = runtimeSupervisor.current.getWorker(pluginId),
            } = e.detail;
            if (!requester) {
                return;
            }
            postCurrentWorkerResponse(
                requester,
                (candidate: Worker) =>
                    runtimeSupervisor.current.isCurrentWorker(pluginId, candidate),
                'api:window:showQuickPick',
                { requestId, result: selectedItem },
            );
        };

        window.addEventListener('zync:quick-pick-select', handleQuickPickSelect);
        return () => window.removeEventListener('zync:quick-pick-select', handleQuickPickSelect);
    }, []);

    return (
        <PluginContext.Provider
            value={{
                plugins,
                editorProviders,
                loaded,
                commands,
                panels,
                runtimeHealth,
                pluginSafeMode,
                executeCommand,
                reloadPlugins,
                retryPluginRuntime,
                exitPluginSafeMode,
                postPaneMessage,
                registerPaneMessageTarget,
            }}
        >
            {children}
        </PluginContext.Provider>
    );
};
