import { ipcRenderer } from '../../../lib/tauri-ipc';

export async function handlePluginSshCommandMessage(options: {
    type: string;
    payload: Record<string, unknown> | undefined;
    runtimeInstanceId: string | undefined;
    isCurrent: () => boolean;
    respond: (payload: Record<string, unknown>) => void;
}): Promise<boolean> {
    const { type, payload, runtimeInstanceId, isCurrent, respond } = options;
    if (type !== 'api:ssh-command:execute') return false;
    const requestId = payload?.requestId;
    try {
        if (!runtimeInstanceId) throw new Error('Plugin runtime is not registered');
        if (typeof payload?.paneInstanceId !== 'string' || !payload.paneInstanceId) {
            throw new Error('Plugin pane instance is required');
        }
        const result = await ipcRenderer.invoke('plugins:ssh_command_execute', {
            runtimeInstanceId,
            paneInstanceId: payload.paneInstanceId,
            request: payload.request,
        });
        if (isCurrent()) respond({ requestId, result });
    } catch (error) {
        if (isCurrent()) respond({ requestId, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
}
