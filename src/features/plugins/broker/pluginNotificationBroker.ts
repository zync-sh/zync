import { notify } from '../../notifications';
import { parsePluginUiNotify } from '../../notifications/pluginNotify';
import {
    createPluginNotifyActionRequestId,
    resolvePluginNotifyActionResponse,
    waitForPluginNotifyActionResult,
} from '../../notifications/pluginNotifyAction';
import { useAppStore } from '../../../store/useAppStore';
import { authorizePluginCapability } from '../runtime/nativePluginRuntime';
import { normalizePluginConfirmRequest } from '../runtime/pluginMessageRateLimiter';
import type { PluginBrokerWorker, PluginMessageBrokerDependencies } from './types';

let notificationSequence = 0;
const notificationActionsInFlight = new Set<string>();

type Respond = (payload: Record<string, unknown>) => void;

export async function handlePluginNotificationMessage<W extends PluginBrokerWorker>(
    dependencies: PluginMessageBrokerDependencies<W>,
    pluginId: string,
    type: string,
    payload: Record<string, unknown>,
    requester: W,
    respond: Respond,
): Promise<boolean> {
    if (type === 'api:ui:notify:action:response') {
        resolvePluginNotifyActionResponse(payload);
        return true;
    }
    if (type !== 'api:ui:notify' && type !== 'api:ui:confirm') return false;

    const runtimeInstanceId = dependencies.runtime.getRuntimeInstanceId(pluginId);
    const requestId = payload.requestId;
    if (!runtimeInstanceId) {
        respond({ requestId, error: 'Plugin runtime is not registered' });
        return true;
    }

    if (type === 'api:ui:confirm') {
        try {
            await authorizePluginCapability(runtimeInstanceId, 'ui.dialog.confirm');
            if (!isCurrent(dependencies, pluginId, requester, runtimeInstanceId)) return true;
            const confirmed = await useAppStore.getState().showConfirmDialog(
                normalizePluginConfirmRequest(payload),
            );
            if (dependencies.runtime.isCurrentWorker(pluginId, requester)) {
                respond({ requestId, result: confirmed });
            }
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

    try {
        await authorizePluginCapability(runtimeInstanceId, 'ui.notifications.emit');
    } catch (error) {
        respond({
            requestId,
            error: error instanceof Error ? error.message : String(error),
        });
        return true;
    }
    if (!isCurrent(dependencies, pluginId, requester, runtimeInstanceId)) return true;

    const parsed = parsePluginUiNotify(pluginId, payload);
    const options = { ...parsed.options };
    if (parsed.actionSpecs.length > 0 && !options.id) {
        notificationSequence += 1;
        options.id = `plugin-notify-${pluginId}-${Date.now().toString(36)}-${notificationSequence.toString(36)}`;
    }
    if (parsed.actionSpecs.length > 0) {
        options.actions = parsed.actionSpecs.map(spec => {
            const dismissOnSuccess = spec.dismiss !== false;
            return {
                ...spec,
                dismiss: false,
                onClick: () => {
                    if (!dependencies.runtime.isCurrentWorker(pluginId, requester)) {
                        notify.error('Plugin is not running', { source: `plugin:${pluginId}` });
                        return;
                    }
                    const notificationId = options.id;
                    const flightKey = `${pluginId}:${notificationId ?? ''}:${spec.id}`;
                    if (notificationActionsInFlight.has(flightKey)) return;
                    notificationActionsInFlight.add(flightKey);

                    const actionRequestId = createPluginNotifyActionRequestId();
                    const result = waitForPluginNotifyActionResult(actionRequestId, pluginId);
                    requester.postMessage({
                        type: 'api:ui:notify:action',
                        payload: {
                            requestId: actionRequestId,
                            pluginId,
                            actionId: spec.id,
                            notificationId,
                            message: parsed.message,
                            type: parsed.type,
                        },
                    });
                    void result
                        .then(actionResult => {
                            if (!dependencies.runtime.isCurrentWorker(pluginId, requester)) return;
                            if (!actionResult.ok) {
                                notify.error(actionResult.error || 'Plugin action failed', {
                                    source: `plugin:${pluginId}`,
                                    history: true,
                                });
                                return;
                            }
                            if (dismissOnSuccess && notificationId) {
                                useAppStore.getState().removeNotification(notificationId);
                            }
                        })
                        .catch((error: unknown) => {
                            if (!dependencies.runtime.isCurrentWorker(pluginId, requester)) return;
                            notify.error(error instanceof Error ? error.message : 'Plugin action failed', {
                                source: `plugin:${pluginId}`,
                                history: true,
                            });
                        })
                        .finally(() => {
                            notificationActionsInFlight.delete(flightKey);
                        });
                },
            };
        });
    }
    notify.emit(parsed.type, parsed.message, options);
    respond({ requestId, result: { ok: true } });
    return true;
}

function isCurrent<W extends PluginBrokerWorker>(
    dependencies: PluginMessageBrokerDependencies<W>,
    pluginId: string,
    requester: W,
    runtimeInstanceId: string,
): boolean {
    return dependencies.runtime.isCurrentWorker(pluginId, requester)
        && dependencies.runtime.isCurrentRuntime(pluginId, runtimeInstanceId);
}
