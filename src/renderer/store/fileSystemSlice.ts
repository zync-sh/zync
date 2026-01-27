import { StateCreator } from 'zustand';
import type { AppStore } from './useAppStore';
import type { FileEntry } from '../components/file-manager/types';

// @ts-ignore
const ipc = window.ipcRenderer;

export interface FileSystemState {
    files: Record<string, FileEntry[]>; // keyed by connectionId
    currentPath: Record<string, string>; // keyed by connectionId
    history: Record<string, string[]>; // keyed by connectionId (future use for back/forward)
    isLoading: Record<string, boolean>; // keyed by connectionId
    error: Record<string, string | null>; // keyed by connectionId
}

export interface FileSystemActions {
    setPath: (connectionId: string, path: string) => void;
    loadFiles: (connectionId: string, path?: string) => Promise<void>;
    refreshFiles: (connectionId: string) => Promise<void>;
    createFolder: (connectionId: string, name: string) => Promise<void>;
    renameEntry: (connectionId: string, oldName: string, newName: string) => Promise<void>;
    deleteEntries: (connectionId: string, paths: string[]) => Promise<void>;
    uploadFiles: (connectionId: string, localPaths: string[]) => Promise<void>;
    downloadFiles: (connectionId: string, remotePaths: string[]) => Promise<void>;
    navigateUp: (connectionId: string) => void;
}

export type FileSystemSlice = FileSystemState & FileSystemActions;

export const createFileSystemSlice: StateCreator<AppStore, [], [], FileSystemSlice> = (set, get) => ({
    files: {},
    currentPath: {},
    history: {},
    isLoading: {},
    error: {},

    setPath: (connectionId, path) => {
        set(state => ({
            currentPath: { ...state.currentPath, [connectionId]: path }
        }));
    },

    loadFiles: async (connectionId, path) => {
        const state = get();
        const targetPath = path || state.currentPath[connectionId] || '/'; // Default to root if no path

        set(state => ({
            isLoading: { ...state.isLoading, [connectionId]: true },
            error: { ...state.error, [connectionId]: null }
        }));

        try {
            // Note: If path is not strictly provided, we might want to check cwd first via IPC
            // But for now, we assume targetPath is valid.
            const entries = await ipc.invoke('sftp:list', { id: connectionId, path: targetPath });

            const mappedEntries: FileEntry[] = entries.map((e: any) => ({
                name: e.name,
                type: e.type,
                size: e.size,
                modifyTime: e.modifyTime,
                accessTime: e.accessTime || 0,
                rights: e.rights || {},
                owner: e.owner || 0,
                group: e.group || 0,
            }));

            set(state => ({
                files: { ...state.files, [connectionId]: mappedEntries },
                currentPath: { ...state.currentPath, [connectionId]: targetPath },
                isLoading: { ...state.isLoading, [connectionId]: false }
            }));
        } catch (error: any) {
            console.error('Failed to load files:', error);
            set(state => ({
                isLoading: { ...state.isLoading, [connectionId]: false },
                error: { ...state.error, [connectionId]: error.message }
            }));

            // Handle connection lost
            if (error.message?.includes('Connection not found')) {
                get().disconnect(connectionId);
            }
        }
    },

    refreshFiles: async (connectionId) => {
        const path = get().currentPath[connectionId];
        if (path) {
            await get().loadFiles(connectionId, path);
        }
    },

    createFolder: async (connectionId, name) => {
        const path = get().currentPath[connectionId];
        const fullPath = path === '/' ? `/${name}` : `${path}/${name}`;

        set(state => ({ isLoading: { ...state.isLoading, [connectionId]: true } }));
        try {
            await ipc.invoke('sftp:mkdir', { id: connectionId, path: fullPath });
            get().showToast('success', `Folder "${name}" created`);
            await get().refreshFiles(connectionId);
        } catch (error: any) {
            get().showToast('error', `Failed to create folder: ${error.message}`);
            set(state => ({ isLoading: { ...state.isLoading, [connectionId]: false } }));
        }
    },

    renameEntry: async (connectionId, oldName, newName) => {
        const path = get().currentPath[connectionId];
        const oldPath = path === '/' ? `/${oldName}` : `${path}/${oldName}`;
        const newPath = path === '/' ? `/${newName}` : `${path}/${newName}`;

        set(state => ({ isLoading: { ...state.isLoading, [connectionId]: true } }));
        try {
            await ipc.invoke('sftp:rename', { id: connectionId, oldPath, newPath });
            get().showToast('success', `Renamed to "${newName}"`);
            await get().refreshFiles(connectionId);
        } catch (error: any) {
            get().showToast('error', `Failed to rename: ${error.message}`);
            set(state => ({ isLoading: { ...state.isLoading, [connectionId]: false } }));
        }
    },

    deleteEntries: async (connectionId, paths) => {
        set(state => ({ isLoading: { ...state.isLoading, [connectionId]: true } }));
        try {
            for (const p of paths) {
                await ipc.invoke('sftp:delete', { id: connectionId, path: p });
            }
            get().showToast('success', 'Items deleted');
            await get().refreshFiles(connectionId);
        } catch (error: any) {
            get().showToast('error', `Delete failed: ${error.message}`);
            set(state => ({ isLoading: { ...state.isLoading, [connectionId]: false } }));
        }
    },

    uploadFiles: async (connectionId, localPaths) => {
        const path = get().currentPath[connectionId];

        set(state => ({ isLoading: { ...state.isLoading, [connectionId]: true } }));
        get().showToast('info', `Uploading ${localPaths.length} file(s)...`);

        try {
            for (const localPath of localPaths) {
                // @ts-ignore
                const fileName = localPath.split(/[/\\]/).pop();
                const remotePath = path === '/' ? `/${fileName}` : `${path}/${fileName}`;
                await ipc.invoke('sftp:put', { id: connectionId, localPath, remotePath });
            }
            get().showToast('success', 'Upload complete');
            await get().refreshFiles(connectionId);
        } catch (error: any) {
            get().showToast('error', `Upload failed: ${error.message}`);
            set(state => ({ isLoading: { ...state.isLoading, [connectionId]: false } }));
        }
    },

    downloadFiles: async (_connectionId, _remotePaths) => {
        // Not implemented fully yet - handled locally in FileManager for now due to Dialog requirement
        return;
    },

    navigateUp: (connectionId) => {
        const path = get().currentPath[connectionId];
        if (!path || path === '/') return;
        const parent = path.substring(0, path.lastIndexOf('/')) || '/';
        get().loadFiles(connectionId, parent);
    }
});
