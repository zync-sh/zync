import { ipcRenderer } from '../../../lib/tauri-ipc';

export interface PluginNetworkFetchRequest {
    url: string;
    accept?: string;
}

export interface PluginNetworkFetchResponse {
    status: number;
    finalUrl: string;
    contentType?: string;
    body: string;
    bodyEncoding: 'utf8' | 'base64';
}

export function fetchPluginNetworkResource(
    runtimeInstanceId: string,
    request: PluginNetworkFetchRequest,
): Promise<PluginNetworkFetchResponse> {
    return ipcRenderer.invoke('plugins:network_fetch', {
        runtimeInstanceId,
        request,
    });
}
