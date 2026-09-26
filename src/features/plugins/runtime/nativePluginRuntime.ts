import { ipcRenderer } from '../../../lib/tauri-ipc';

interface NativePluginRuntimeRegistration {
    runtimeInstanceId: string;
}

export interface NativePluginPaneRegistration {
    id: string;
    title: string;
    html: string;
    allowMultiple: boolean;
    legacy: boolean;
}

export type PluginRuntimeFailureKind = 'worker-error' | 'heartbeat-timeout' | 'start-failure';

export interface NativePluginRecoveryStatus {
    safeMode: boolean;
    diagnostics: Array<{
        pluginId: string;
        failures: Array<{
            atMs: number;
            kind: PluginRuntimeFailureKind;
        }>;
    }>;
}

export async function resetNativePluginRuntimes(): Promise<void> {
    await ipcRenderer.invoke('plugins:runtime_reset');
}

export async function startNativePluginRuntime(pluginId: string): Promise<string> {
    const registration = await ipcRenderer.invoke('plugins:runtime_start', {
        pluginId,
    }) as NativePluginRuntimeRegistration;
    return registration.runtimeInstanceId;
}

export async function stopNativePluginRuntime(runtimeInstanceId: string): Promise<void> {
    await ipcRenderer.invoke('plugins:runtime_stop', { runtimeInstanceId });
}

export function getNativePluginRecoveryStatus(): Promise<NativePluginRecoveryStatus> {
    return ipcRenderer.invoke('plugins:recovery_status');
}

export function recordNativePluginRuntimeFailure(
    pluginId: string,
    kind: PluginRuntimeFailureKind,
): Promise<void> {
    return ipcRenderer.invoke('plugins:recovery_record_failure', { pluginId, kind });
}

export function clearNativePluginSafeMode(): Promise<void> {
    return ipcRenderer.invoke('plugins:recovery_clear_safe_mode');
}

export function clearNativePluginRuntimeFailures(pluginId: string): Promise<void> {
    return ipcRenderer.invoke('plugins:recovery_clear_plugin_failures', { pluginId });
}

export async function authorizePluginCapability(
    runtimeInstanceId: string,
    capability: string,
): Promise<void> {
    await ipcRenderer.invoke('plugins:runtime_authorize', {
        runtimeInstanceId,
        capability,
    });
}

export async function authorizePluginCommandRegistration(
    runtimeInstanceId: string,
    commandId: string,
    title: string,
): Promise<void> {
    await ipcRenderer.invoke('plugins:runtime_register_command', {
        runtimeInstanceId,
        commandId,
        title,
    });
}

export function registerNativePluginPane(
    runtimeInstanceId: string,
    paneKindId: string,
): Promise<NativePluginPaneRegistration | null> {
    return ipcRenderer.invoke('plugins:runtime_register_pane', {
        runtimeInstanceId,
        paneKindId,
    });
}

export function bindNativePluginPaneConnection(
    runtimeInstanceId: string,
    paneKindId: string,
    paneInstanceId: string,
    connectionId: string,
): Promise<void> {
    return ipcRenderer.invoke('plugins:runtime_bind_pane', {
        runtimeInstanceId,
        paneKindId,
        paneInstanceId,
        connectionId,
    });
}

export function unbindNativePluginPaneConnection(
    runtimeInstanceId: string,
    paneInstanceId: string,
): Promise<void> {
    return ipcRenderer.invoke('plugins:runtime_unbind_pane', {
        runtimeInstanceId,
        paneInstanceId,
    });
}
