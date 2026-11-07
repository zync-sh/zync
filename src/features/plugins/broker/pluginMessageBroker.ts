import { ipcRenderer } from '../../../lib/tauri-ipc';
import { useAppStore } from '../../../store/useAppStore';
import { postCurrentWorkerResponse } from '../pluginCommandBridge';
import {
    authorizePluginCommandRegistration,
    registerNativePluginPane,
} from '../runtime/nativePluginRuntime';
import { validatePluginPaneMessage } from '../runtime/paneMessages';
import { handlePluginFilesystemMessage } from '../runtime/pluginFilesystem';
import { fetchPluginNetworkResource } from '../runtime/pluginNetwork';
import { createOptionalPermissionRequester } from '../runtime/pluginOptionalPermission';
import { handlePluginSshCommandMessage } from '../runtime/pluginSshCommand';
import {
    deletePluginStorageValue,
    getPluginStorageValue,
    listPluginStorageKeys,
    setPluginStorageValue,
} from '../runtime/pluginStorage';
import { handleTerminalWorkerMessage } from '../terminal/paneBridge';
import { handlePluginNotificationMessage } from './pluginNotificationBroker';
import type { PluginBrokerWorker, PluginMessageBrokerDependencies } from './types';

const requestOptionalPermission = createOptionalPermissionRequester({
    /** Ask native permission policy whether a digest-bound optional grant needs user approval. */
    inspect: (runtimeInstanceId, capability, approvedDigest) =>
        ipcRenderer.invoke('plugins:runtime_optional_permission', {
            runtimeInstanceId,
            capability,
            approvedDigest,
        }),
    /** Present the host-owned optional-permission confirmation dialog. */
    confirm: (prompt) =>
        useAppStore.getState().showConfirmDialog({
            title: 'Allow plugin permission?',
            message: `${prompt.pluginName} requests ${prompt.capability}.\n\n${prompt.reason}${prompt.capability === 'ssh.command.execute' ? '\n\nThis allows commands to run with the connected SSH account’s privileges.' : ''}\n\nAllow saves this permission. You can revoke it in Settings → Plugins. Deny cancels this action; the next attempt will ask again.`,
            confirmText: 'Allow',
            cancelText: 'Deny',
            variant: 'danger',
        }),
});

const ACTION_PERMISSIONS: Record<string, string> = {
    'api:filesystem:pick': 'filesystem.external.read',
    'api:filesystem:pick-write-file': 'filesystem.external.write',
    'api:filesystem:read-text': 'filesystem.external.read',
    'api:filesystem:write-text': 'filesystem.external.write',
    'api:filesystem:list': 'filesystem.external.read',
    'api:ssh-filesystem:list': 'ssh.filesystem.read',
    'api:ssh-filesystem:read-text': 'ssh.filesystem.read',
    'api:ssh-command:execute': 'ssh.command.execute',
    'api:terminal:context': 'ssh.terminal.open',
    'api:terminal:prepare': 'ssh.terminal.open',
    'api:network:fetch': 'network.fetch',
    'api:storage:get': 'filesystem.pluginData.read',
    'api:storage:keys': 'filesystem.pluginData.read',
    'api:storage:set': 'filesystem.pluginData.write',
    'api:storage:delete': 'filesystem.pluginData.write',
    'api:ui:confirm': 'ui.dialog.confirm',
    'api:ui:notify': 'ui.notifications.emit',
};

export interface PluginMessageBroker<W extends PluginBrokerWorker> {
    handleMessage(
        pluginId: string,
        type: unknown,
        payload: unknown,
        requester: W,
    ): Promise<boolean>;
}

/**
 * Associates a Worker generation with native broker calls. Permission and resource
 * authority remain native; this layer only validates message shape and routes replies.
 */
export function createPluginMessageBroker<W extends PluginBrokerWorker>(
    dependencies: PluginMessageBrokerDependencies<W>,
): PluginMessageBroker<W> {
    /** Post a broker response only while its requester remains the current worker. */
    const respond = (
        requester: W,
        pluginId: string,
        type: string,
        payload: Record<string, unknown>,
    ) => {
        postCurrentWorkerResponse(
            requester,
            (candidate) => dependencies.runtime.isCurrentWorker(pluginId, candidate),
            type,
            payload,
        );
    };

    return {
        /** Route a current worker message, pausing control-response expiry during permission approval. */
        async handleMessage(pluginId, rawType, rawPayload, requester) {
            if (typeof rawType !== 'string') {
                return true;
            }
            if (!dependencies.runtime.isCurrentWorker(pluginId, requester)) {
                return true;
            }

            const type = rawType;
            const payload = record(rawPayload);
            const reply = (response: Record<string, unknown>) => {
                respond(requester, pluginId, type, response);
            };
            const runtimeInstanceId = dependencies.runtime.getRuntimeInstanceId(pluginId);
            /** Fence broker continuations to both captured worker and native runtime identities. */
            const current = () =>
                Boolean(runtimeInstanceId) &&
                dependencies.runtime.isCurrentWorker(pluginId, requester) &&
                dependencies.runtime.isCurrentRuntime(pluginId, runtimeInstanceId!);

            const capability = ACTION_PERMISSIONS[type];
            if (capability && runtimeInstanceId) {
                const requestId = payload?.requestId;
                /** Pause the control RPC only while an actual user dialog is visible. */
                const onWait = (waitingForUser: boolean) => {
                    if (current()) {
                        requester.postMessage({
                            type: 'host:request:phase',
                            payload: { requestId, waitingForUser },
                        });
                    }
                };
                try {
                    if (
                        !(await requestOptionalPermission(
                            runtimeInstanceId,
                            capability,
                            current,
                            type === 'api:terminal:context' && typeof requestId === 'string'
                                ? onWait
                                : undefined,
                        ))
                    ) {
                        if (current()) {
                            reply({
                                requestId: payload?.requestId,
                                error: `Permission denied: ${capability}`,
                            });
                        }
                        return true;
                    }
                } catch (error) {
                    if (current()) {
                        reply({
                            requestId: payload?.requestId,
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                    return true;
                }
            }

            if (
                await handlePluginFilesystemMessage({
                    type,
                    payload,
                    runtimeInstanceId,
                    isCurrent: current,
                    respond: reply,
                })
            ) {
                return true;
            }

            if (
                await handlePluginSshCommandMessage({
                    type,
                    payload,
                    runtimeInstanceId,
                    isCurrent: current,
                    respond: reply,
                })
            ) {
                return true;
            }

            if (type === 'api:terminal:context' || type === 'api:terminal:prepare') {
                try {
                    const result = await handleTerminalWorkerMessage(
                        pluginId,
                        runtimeInstanceId,
                        type,
                        payload,
                    );
                    if (current()) {
                        reply({ requestId: payload?.requestId, result });
                    }
                } catch (error) {
                    if (current()) {
                        reply({
                            requestId: payload?.requestId,
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                }
                return true;
            }

            if (
                await handlePluginNotificationMessage(
                    dependencies,
                    pluginId,
                    type,
                    payload ?? {},
                    requester,
                    reply,
                )
            ) {
                return true;
            }

            switch (type) {
                case 'api:log':
                    console.log(`[Plugin Log]`, rawPayload);
                    return true;
                case 'api:panel:register':
                    return handlePanelRegistration(
                        dependencies,
                        pluginId,
                        payload,
                        requester,
                        runtimeInstanceId,
                        reply,
                    );
                case 'api:panel:post-message':
                    return handlePaneMessage(dependencies, pluginId, payload, reply);
                case 'api:commands:register':
                    return handleCommandRegistration(
                        dependencies,
                        pluginId,
                        payload,
                        requester,
                        runtimeInstanceId,
                        reply,
                    );
                case 'api:storage:get':
                case 'api:storage:keys':
                case 'api:storage:set':
                case 'api:storage:delete':
                    return handleStorage(type, payload, runtimeInstanceId, current, reply);
                case 'api:network:fetch':
                    return handleNetwork(payload, runtimeInstanceId, current, reply);
                default:
                    return false;
            }
        },
    };
}

/** Validate and publish a pane contribution only after native runtime authorization. */
async function handlePanelRegistration<W extends PluginBrokerWorker>(
    dependencies: PluginMessageBrokerDependencies<W>,
    pluginId: string,
    payload: Record<string, unknown> | undefined,
    requester: W,
    runtimeInstanceId: string | undefined,
    respond: (payload: Record<string, unknown>) => void,
): Promise<true> {
    const requestId = payload?.requestId;
    if (!runtimeInstanceId) {
        respond({ requestId, error: 'Plugin runtime is not registered' });
        return true;
    }
    const paneKindId = payload?.id;
    if (typeof paneKindId !== 'string' || !paneKindId) {
        respond({ requestId, error: 'Plugin pane id is required' });
        return true;
    }

    try {
        const registered = await registerNativePluginPane(runtimeInstanceId, paneKindId);
        if (!isCurrent(dependencies, pluginId, requester, runtimeInstanceId)) {
            return true;
        }
        const title = payload?.title;
        const html = payload?.html;
        if (!registered && (typeof title !== 'string' || typeof html !== 'string')) {
            throw new Error('Legacy plugin pane title and HTML are required');
        }
        const panel = registered ?? {
            id: paneKindId,
            title: title as string,
            html: html as string,
            allowMultiple: false,
            legacy: true,
        };
        dependencies.registerPanel({
            id: panel.id,
            title: panel.title,
            html: panel.html,
            pluginId,
            allowMultiple: panel.allowMultiple,
            legacyAccess: panel.legacy,
        });
        dependencies.dispatch('zync:panel:register', {
            id: panel.id,
            title: panel.title,
            pluginId,
        });
        respond({ requestId, result: { id: panel.id, title: panel.title } });
    } catch (error) {
        if (dependencies.runtime.isCurrentWorker(pluginId, requester)) {
            respond({
                requestId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return true;
}

/** Validate an owned pane destination before delivering a plugin message. */
function handlePaneMessage<W extends PluginBrokerWorker>(
    dependencies: PluginMessageBrokerDependencies<W>,
    pluginId: string,
    payload: Record<string, unknown> | undefined,
    respond: (payload: Record<string, unknown>) => void,
): true {
    const paneInstanceId =
        typeof payload?.paneInstanceId === 'string' ? payload.paneInstanceId : '';
    const parsed = validatePluginPaneMessage(payload?.message);
    const target = dependencies.getPaneMessageTarget(pluginId, paneInstanceId);
    if (!paneInstanceId || !parsed.ok || !target) {
        respond({
            requestId: payload?.requestId,
            error: 'Plugin pane is unavailable or the message is invalid',
        });
        return true;
    }
    target.post(parsed.message);
    respond({ requestId: payload?.requestId, result: true });
    return true;
}

/** Authorize and register a command contribution for the current plugin runtime. */
async function handleCommandRegistration<W extends PluginBrokerWorker>(
    dependencies: PluginMessageBrokerDependencies<W>,
    pluginId: string,
    payload: Record<string, unknown> | undefined,
    requester: W,
    runtimeInstanceId: string | undefined,
    respond: (payload: Record<string, unknown>) => void,
): Promise<true> {
    const requestId = payload?.requestId;
    if (!runtimeInstanceId) {
        respond({ requestId, error: 'Plugin runtime is not registered' });
        return true;
    }
    const commandId = payload?.id;
    const title = payload?.title;
    if (typeof commandId !== 'string' || typeof title !== 'string') {
        respond({ requestId, error: 'Plugin command id and title are required' });
        return true;
    }

    try {
        await authorizePluginCommandRegistration(runtimeInstanceId, commandId, title);
        if (!isCurrent(dependencies, pluginId, requester, runtimeInstanceId)) {
            return true;
        }
        dependencies.registerCommand({ id: commandId, title, pluginId });
        respond({ requestId, result: { ok: true } });
    } catch (error) {
        if (dependencies.runtime.isCurrentWorker(pluginId, requester)) {
            respond({
                requestId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return true;
}

/** Route bounded private-storage operations and preserve current-runtime response fencing. */
async function handleStorage(
    type: string,
    payload: Record<string, unknown> | undefined,
    runtimeInstanceId: string | undefined,
    isCurrentRuntime: () => boolean,
    respond: (payload: Record<string, unknown>) => void,
): Promise<true> {
    const requestId = payload?.requestId;
    if (!runtimeInstanceId) {
        respond({ requestId, error: 'Plugin runtime is not registered' });
        return true;
    }
    try {
        let result: unknown;
        if (type === 'api:storage:keys') {
            result = await listPluginStorageKeys(runtimeInstanceId);
        } else {
            const key = requiredString(payload?.key, 'Plugin storage key is required');
            if (type === 'api:storage:get') {
                result = await getPluginStorageValue(runtimeInstanceId, key);
            } else if (type === 'api:storage:set') {
                const value = requiredString(
                    payload?.value,
                    'Plugin storage value must be a string',
                );
                await setPluginStorageValue(runtimeInstanceId, key, value);
                result = true;
            } else {
                result = await deletePluginStorageValue(runtimeInstanceId, key);
            }
        }
        if (isCurrentRuntime()) {
            respond({ requestId, result });
        }
    } catch (error) {
        if (isCurrentRuntime()) {
            respond({ requestId, error: error instanceof Error ? error.message : String(error) });
        }
    }
    return true;
}

/** Fetch through native network policy and reply only to the active runtime. */
async function handleNetwork(
    payload: Record<string, unknown> | undefined,
    runtimeInstanceId: string | undefined,
    isCurrentRuntime: () => boolean,
    respond: (payload: Record<string, unknown>) => void,
): Promise<true> {
    const requestId = payload?.requestId;
    if (!runtimeInstanceId) {
        respond({ requestId, error: 'Plugin runtime is not registered' });
        return true;
    }
    try {
        const url = requiredString(payload?.url, 'Plugin network URL is required');
        const accept = payload?.accept;
        if (accept !== undefined && typeof accept !== 'string') {
            throw new Error('Plugin network Accept header must be a string');
        }
        const result = await fetchPluginNetworkResource(runtimeInstanceId, { url, accept });
        if (isCurrentRuntime()) {
            respond({ requestId, result });
        }
    } catch (error) {
        if (isCurrentRuntime()) {
            respond({ requestId, error: error instanceof Error ? error.message : String(error) });
        }
    }
    return true;
}

/** Require the same worker and native runtime before publishing asynchronous broker results. */
function isCurrent<W extends PluginBrokerWorker>(
    dependencies: PluginMessageBrokerDependencies<W>,
    pluginId: string,
    requester: W,
    runtimeInstanceId: string,
): boolean {
    return (
        dependencies.runtime.isCurrentWorker(pluginId, requester) &&
        dependencies.runtime.isCurrentRuntime(pluginId, runtimeInstanceId)
    );
}

/** Accept object-shaped request payloads without trusting primitive or missing input. */
function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

/** Reject absent or non-string broker fields before issuing native requests. */
function requiredString(value: unknown, message: string): string {
    if (typeof value !== 'string') {
        throw new Error(message);
    }
    return value;
}
