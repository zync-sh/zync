import { ipcRenderer } from '../../../lib/tauri-ipc';

export function getPluginStorageValue(
    runtimeInstanceId: string,
    key: string,
): Promise<string | null> {
    return ipcRenderer.invoke('plugins:storage_get', { runtimeInstanceId, key });
}

export function listPluginStorageKeys(runtimeInstanceId: string): Promise<string[]> {
    return ipcRenderer.invoke('plugins:storage_keys', { runtimeInstanceId });
}

export function setPluginStorageValue(
    runtimeInstanceId: string,
    key: string,
    value: string,
): Promise<void> {
    return ipcRenderer.invoke('plugins:storage_set', { runtimeInstanceId, key, value });
}

export function deletePluginStorageValue(
    runtimeInstanceId: string,
    key: string,
): Promise<boolean> {
    return ipcRenderer.invoke('plugins:storage_delete', { runtimeInstanceId, key });
}
