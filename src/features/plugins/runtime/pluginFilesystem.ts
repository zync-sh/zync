import { ipcRenderer } from '../../../lib/tauri-ipc';

export type PluginFilesystemPickKind = 'file' | 'directory';

export interface PluginFilesystemHandle {
    handle: string;
    kind: PluginFilesystemPickKind;
    access: 'read' | 'write';
    name: string;
}

export interface PluginFilesystemEntry {
    name: string;
    kind: 'file' | 'directory' | 'unavailable';
    size?: number;
}

export type PluginSshFilesystemEntry = PluginFilesystemEntry;

type PluginFilesystemMessageType =
    | 'api:filesystem:pick'
    | 'api:filesystem:pick-write-file'
    | 'api:filesystem:read-text'
    | 'api:filesystem:write-text'
    | 'api:filesystem:list'
    | 'api:ssh-filesystem:list'
    | 'api:ssh-filesystem:read-text';

interface PluginFilesystemMessageOptions {
    type: string;
    payload: Record<string, unknown> | undefined;
    runtimeInstanceId: string | undefined;
    isCurrent: () => boolean;
    respond: (payload: Record<string, unknown>) => void;
}

const FILESYSTEM_MESSAGE_TYPES = new Set<PluginFilesystemMessageType>([
    'api:filesystem:pick',
    'api:filesystem:pick-write-file',
    'api:filesystem:read-text',
    'api:filesystem:write-text',
    'api:filesystem:list',
    'api:ssh-filesystem:list',
    'api:ssh-filesystem:read-text',
]);

export function pickPluginFilesystemItem(
    runtimeInstanceId: string,
    kind: PluginFilesystemPickKind,
): Promise<PluginFilesystemHandle | null> {
    return ipcRenderer.invoke('plugins:filesystem_pick', {
        runtimeInstanceId,
        request: { kind },
    });
}

export function readPluginFilesystemText(
    runtimeInstanceId: string,
    handle: string,
    relativePath?: string,
): Promise<string> {
    return ipcRenderer.invoke('plugins:filesystem_read_text', {
        runtimeInstanceId,
        handle,
        relativePath,
    });
}

export function pickPluginFilesystemWriteFile(
    runtimeInstanceId: string,
): Promise<PluginFilesystemHandle | null> {
    return ipcRenderer.invoke('plugins:filesystem_pick_write_file', { runtimeInstanceId });
}

export function writePluginFilesystemText(
    runtimeInstanceId: string,
    handle: string,
    content: string,
): Promise<void> {
    return ipcRenderer.invoke('plugins:filesystem_write_text', {
        runtimeInstanceId,
        handle,
        content,
    });
}

export function listPluginFilesystemDirectory(
    runtimeInstanceId: string,
    handle: string,
    relativePath?: string,
): Promise<PluginFilesystemEntry[]> {
    return ipcRenderer.invoke('plugins:filesystem_list', {
        runtimeInstanceId,
        handle,
        relativePath,
    });
}

export function listPluginSshFilesystemDirectory(
    runtimeInstanceId: string,
    paneInstanceId: string,
    relativePath?: string,
): Promise<PluginSshFilesystemEntry[]> {
    return ipcRenderer.invoke('plugins:ssh_filesystem_list', {
        runtimeInstanceId,
        paneInstanceId,
        relativePath,
    });
}

export function readPluginSshFilesystemText(
    runtimeInstanceId: string,
    paneInstanceId: string,
    relativePath: string,
): Promise<string> {
    return ipcRenderer.invoke('plugins:ssh_filesystem_read_text', {
        runtimeInstanceId,
        paneInstanceId,
        relativePath,
    });
}

export async function handlePluginFilesystemMessage({
    type,
    payload,
    runtimeInstanceId,
    isCurrent,
    respond,
}: PluginFilesystemMessageOptions): Promise<boolean> {
    if (!FILESYSTEM_MESSAGE_TYPES.has(type as PluginFilesystemMessageType)) return false;

    const requestId = payload?.requestId;
    if (!runtimeInstanceId) {
        respond({ requestId, error: 'Plugin runtime is not registered' });
        return true;
    }

    try {
        let result: unknown;
        if (type === 'api:ssh-filesystem:list' || type === 'api:ssh-filesystem:read-text') {
            const paneInstanceId = payload?.paneInstanceId;
            const relativePath = payload?.relativePath;
            if (typeof paneInstanceId !== 'string' || !paneInstanceId) {
                throw new Error('Plugin pane instance is required');
            }
            if (relativePath !== undefined && typeof relativePath !== 'string') {
                throw new Error('Server filesystem relative path must be a string');
            }
            if (type === 'api:ssh-filesystem:list') {
                result = await listPluginSshFilesystemDirectory(runtimeInstanceId, paneInstanceId, relativePath);
            } else {
                if (!relativePath) throw new Error('Server file relative path is required');
                result = await readPluginSshFilesystemText(runtimeInstanceId, paneInstanceId, relativePath);
            }
        } else if (type === 'api:filesystem:pick') {
            const kind = payload?.kind;
            if (kind !== 'file' && kind !== 'directory') {
                throw new Error('Filesystem picker kind must be file or directory');
            }
            result = await pickPluginFilesystemItem(runtimeInstanceId, kind);
        } else if (type === 'api:filesystem:pick-write-file') {
            result = await pickPluginFilesystemWriteFile(runtimeInstanceId);
        } else {
            const handle = payload?.handle;
            const relativePath = payload?.relativePath;
            if (typeof handle !== 'string') throw new Error('Filesystem handle is required');
            if (relativePath !== undefined && typeof relativePath !== 'string') {
                throw new Error('Filesystem relative path must be a string');
            }
            if (type === 'api:filesystem:read-text') {
                result = await readPluginFilesystemText(runtimeInstanceId, handle, relativePath);
            } else if (type === 'api:filesystem:write-text') {
                const content = payload?.content;
                if (typeof content !== 'string') throw new Error('Filesystem content must be a string');
                await writePluginFilesystemText(runtimeInstanceId, handle, content);
                result = true;
            } else {
                result = await listPluginFilesystemDirectory(runtimeInstanceId, handle, relativePath);
            }
        }
        if (isCurrent()) respond({ requestId, result });
    } catch (error) {
        if (isCurrent()) {
            respond({
                requestId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return true;
}
