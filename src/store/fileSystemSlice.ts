import { StateCreator } from 'zustand';
import type { AppStore } from './useAppStore';
import type { FileEntry } from '../components/file-manager/types';

// @ts-ignore
const ipc = window.ipcRenderer;

export interface FileSystemState {
    files: Record<string, FileEntry[]>; // keyed by connectionId
    currentPath: Record<string, string>; // keyed by connectionId
    history: Record<string, string[]>; // keyed by connectionId
    historyIndex: Record<string, number>; // keyed by connectionId
    isLoading: Record<string, boolean>; // keyed by connectionId
    error: Record<string, string | null>; // keyed by connectionId
    clipboard: {
        files: FileEntry[];
        sourceConnectionId: string;
        sourcePath: string; // parent path
        op: 'copy' | 'cut';
    } | null;
}

export interface FileSystemActions {
    setPath: (connectionId: string, path: string) => void;
    loadFiles: (connectionId: string, path?: string, skipHistory?: boolean, silent?: boolean) => Promise<void>;
    refreshFiles: (connectionId: string) => Promise<void>;
    createFolder: (connectionId: string, name: string) => Promise<void>;
    renameEntry: (connectionId: string, oldName: string, newName: string) => Promise<void>;
    deleteEntries: (connectionId: string, paths: string[]) => Promise<void>;
    uploadFiles: (connectionId: string, localPaths: string[]) => Promise<void>;
    downloadFiles: (connectionId: string, remotePaths: string[]) => Promise<void>;
    navigateUp: (connectionId: string) => void;
    navigateBack: (connectionId: string) => void;
    navigateForward: (connectionId: string) => void;
    setClipboard: (files: FileEntry[], sourceConnectionId: string, sourcePath: string, op: 'copy' | 'cut') => void;
    clearClipboard: () => void;
    pasteEntries: (connectionId: string, sources: string[], op: 'copy' | 'cut') => Promise<void>;
    checkPathExists: (connectionId: string, path: string) => Promise<boolean>;
}

export type FileSystemSlice = FileSystemState & FileSystemActions;

export const createFileSystemSlice: StateCreator<AppStore, [], [], FileSystemSlice> = (set, get) => ({
    files: {},
    currentPath: {},
    history: {},
    historyIndex: {},
    isLoading: {},
    error: {},
    clipboard: null,

    setClipboard: (files, sourceConnectionId, sourcePath, op) => {
        set({ clipboard: { files, sourceConnectionId, sourcePath, op } });
    },

    clearClipboard: () => {
        set({ clipboard: null });
    },

    setPath: (connectionId, path) => {
        set(state => ({
            currentPath: { ...state.currentPath, [connectionId]: path }
        }));
    },

    loadFiles: async (connectionId, path, skipHistory = false, silent = false) => {
        const state = get();
        const targetPath = path !== undefined ? path : (state.currentPath[connectionId] || '/');

        // History Logic
        if (!skipHistory && targetPath !== state.currentPath[connectionId]) {
            const currentHistory = state.history[connectionId] || [];
            const currentIndex = state.historyIndex[connectionId] || 0;

            // If we are at the end of history, push new path
            // If we are in middle, truncate future and push
            const newHistory = [...currentHistory.slice(0, currentIndex + 1), targetPath];

            // If history is empty, initialize it with BOTH previous path (if exists) and new path?
            // Or just make sure initial path is there.
            if (newHistory.length === 1 && state.currentPath[connectionId]) {
                // First navigation: ensure start path is in history at index 0
                newHistory.unshift(state.currentPath[connectionId]);
            }

            set(state => ({
                history: { ...state.history, [connectionId]: newHistory },
                historyIndex: { ...state.historyIndex, [connectionId]: newHistory.length - 1 }
            }));
        }

        if (!silent) {
            set(state => ({
                isLoading: { ...state.isLoading, [connectionId]: true },
                error: { ...state.error, [connectionId]: null }
            }));
        } else {
            set(state => ({
                error: { ...state.error, [connectionId]: null }
            }));
        }

        try {
            const entries = await ipc.invoke('fs_list', { connectionId, path: targetPath });

            const mappedEntries: FileEntry[] = entries.map((e: any) => ({
                name: e.name,
                type: e.type,
                size: e.size,
                lastModified: e.lastModified,
                permissions: e.permissions,
                path: e.path,
            }));

            set(state => ({
                files: { ...state.files, [connectionId]: mappedEntries },
                currentPath: { ...state.currentPath, [connectionId]: targetPath },
                isLoading: { ...state.isLoading, [connectionId]: false }
            }));

            // Initialize history if empty
            const currentHist = get().history[connectionId];
            if (!currentHist || currentHist.length === 0) {
                set(state => ({
                    history: { ...state.history, [connectionId]: [targetPath] },
                    historyIndex: { ...state.historyIndex, [connectionId]: 0 }
                }));
            }

        } catch (error: any) {
            console.error('Failed to load files:', error);

            set(state => ({
                isLoading: { ...state.isLoading, [connectionId]: false },
                error: { ...state.error, [connectionId]: error.message }
            }));

            const osError = error.message || String(error);

            // Handle "No such file" (Directory deleted?)
            if (osError.includes('No such file') || osError.includes('does not exist')) {
                // If we are not at root, try moving up
                if (targetPath !== '/' && targetPath !== '') {
                    const parent = targetPath.substring(0, targetPath.lastIndexOf('/')) || '/';
                    console.log(`Path ${targetPath} not found, navigating up to ${parent}`);
                    // Update path state immediately to prevent loops
                    set(state => ({
                        currentPath: { ...state.currentPath, [connectionId]: parent }
                    }));
                    // Try loading parent
                    get().loadFiles(connectionId, parent);
                    return;
                }
            }

            if (osError.includes('Connection not found')) {
                get().disconnect(connectionId);
            }
        }
    },

    refreshFiles: async (connectionId) => {
        const path = get().currentPath[connectionId];
        if (path) {
            // Check if user is actively copying to avoid interrupting? No, standard refresh.
            // Use silent=true to prevent flicker
            await get().loadFiles(connectionId, path, true, true);
        }
    },

    createFolder: async (connectionId, name) => {
        const path = get().currentPath[connectionId];
        const fullPath = path === '/' ? `/${name}` : `${path}/${name}`;

        set(state => ({ isLoading: { ...state.isLoading, [connectionId]: true } }));
        try {
            await ipc.invoke('fs_mkdir', { connectionId, path: fullPath });
            // get().showToast('success', `Folder "${name}" created`);
            get().setLastAction(`Created folder "${name}"`, 'success');
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

        // set(state => ({ isLoading: { ...state.isLoading, [connectionId]: true } }));
        try {
            await ipc.invoke('fs_rename', { connectionId, oldPath, newPath });
            get().setLastAction(`Renaming to "${newName}"...`, 'info');
            // Background op: Wait for event to refresh
        } catch (error: any) {
            get().showToast('error', `Failed to rename: ${error.message}`);
        }
    },

    deleteEntries: async (connectionId, paths) => {
        // Optimistic Update: Immediately remove files from state
        set(state => {
            const currentFiles = state.files[connectionId] || [];
            const newFiles = currentFiles.filter(f => !paths.includes(f.path));
            return {
                files: { ...state.files, [connectionId]: newFiles }
            };
        });

        // set(state => ({ isLoading: { ...state.isLoading, [connectionId]: true } }));
        try {
            for (const p of paths) {
                await ipc.invoke('fs_delete', { connectionId, path: p });
            }
            get().setLastAction(`Deleting ${paths.length} item(s)...`, 'info');
            // Background op: Wait for event to refresh
        } catch (error: any) {
            get().showToast('error', `Delete failed: ${error.message}`);
            // On error, refresh to restore true state
            get().refreshFiles(connectionId);
        }
    },

    uploadFiles: async (connectionId, localPaths) => {
        const path = get().currentPath[connectionId];
        // Do not set isLoading to true here, as we want "background" upload

        // get().showToast('info', `Starting background upload of ${localPaths.length} items...`);
        get().setLastAction(`Starting upload of ${localPaths.length} items...`, 'info');

        try {
            // We need to access the store to add transfer
            // Since we are inside the store creator, we can use `get()` to access other slices if they are merged?
            // Yes, `get()` returns `AppStore`.
            const addTransfer = get().addTransfer;

            for (const localPath of localPaths) {
                // @ts-ignore
                const fileName = localPath.split(/[/\\]/).pop();
                const remotePath = path === '/' ? `/${fileName}` : `${path}/${fileName}`;

                const transferId = addTransfer({
                    sourceConnectionId: 'local',
                    sourcePath: localPath,
                    destinationConnectionId: connectionId,
                    destinationPath: remotePath
                });

                // Call backend asynchronously (fire and forget from frontend perspective)
                // The backend will emit events to update status
                ipc.invoke('sftp_put', { // Fix: Command name is sftp_put for background upload
                    id: connectionId,
                    localPath,
                    remotePath,
                    transferId // Pass transferId to backend
                }).catch((err: any) => {
                    console.error('Upload start failed:', err);
                    get().failTransfer(transferId, err.message || String(err));
                    get().showToast('error', `Failed to start upload: ${err.message || err}`);
                });
            }
        } catch (error: any) {
            get().showToast('error', `Upload initialization failed: ${error.message || error}`);
        }
    },

    downloadFiles: async (_connectionId, _remotePaths) => {
        // Implementation pending
        console.log('Download not fully implemented in store slice yet');
    },

    pasteEntries: async (connectionId, sources, op) => {
        const state = get();
        const currentPath = state.currentPath[connectionId] || '/';

        set(state => ({ isLoading: { ...state.isLoading, [connectionId]: true } }));

        try {
            // Processing list for optimistic updates
            const newEntries: FileEntry[] = [];
            const pathsToRemoveFromSource: string[] = [];
            const successfulSources: string[] = [];

            for (const source of sources) {
                // Extract filename
                const originalName = source.split('/').pop() || 'unknown';
                let destPath = currentPath === '/' ? `/${originalName}` : `${currentPath}/${originalName}`;

                // Handle Collision (Auto-Rename)
                // If cut and same path, skip
                if (op === 'cut' && source === destPath) continue;

                // Collision Detection Loop
                if (source === destPath || await get().checkPathExists(connectionId, destPath)) {
                    const match = originalName.match(/^(.*?)(\.[^.]*)?$/);
                    const base = match ? match[1] : originalName;
                    const ext = match && match[2] ? match[2] : '';
                    let counter = 1;

                    while (true) {
                        const newName = `${base} (${counter})${ext}`;
                        destPath = currentPath === '/' ? `/${newName}` : `${currentPath}/${newName}`;

                        // Check local optimistic list too to avoid collisions within the batch
                        const collisionInBatch = newEntries.some(e => e.path === destPath);
                        if (source !== destPath && !collisionInBatch && !(await get().checkPathExists(connectionId, destPath))) {
                            break;
                        }
                        counter++;
                        if (counter > 100) throw new Error('Too many duplicate files');
                    }
                }

                // Prepare Optimistic Entry
                const newName = destPath.split('/').pop() || 'unknown';

                // Map to FileEntry type ('d' | '-' | 'l')
                // Default to file ('-') if unknown
                let entryType: '-' | 'd' | 'l' = '-';
                let entrySize = 0;

                if (state.clipboard && state.clipboard.files) {
                    const clipEntry = state.clipboard.files.find(f => f.path === source);
                    if (clipEntry) {
                        entryType = clipEntry.type;
                        entrySize = clipEntry.size;
                    } else if (!source.includes('.')) {
                        // Fallback guess: no extension -> likely folder? Not reliable but acceptable for optimistic
                    }
                } else {
                    // If we are pasting but clipboard is null (how?), default to file
                    if (!source.includes('.')) entryType = 'd';
                }

                const newEntry: FileEntry = {
                    name: newName,
                    path: destPath,
                    type: entryType,
                    size: entrySize,
                    lastModified: Date.now() / 1000,
                    permissions: 'rwxr-xr-x', // Dummy permissions
                };

                newEntries.push(newEntry);
                successfulSources.push(source);
                if (op === 'cut') {
                    pathsToRemoveFromSource.push(source);
                }
            }

            // Fire Backend (Batch Optimized)
            if (newEntries.length > 0) {
                const operations = newEntries.map((e, idx) => ({
                    from: successfulSources[idx],
                    to: e.path
                }));

                const command = op === 'copy' ? 'fs_copy_batch' : 'fs_rename_batch';
                await ipc.invoke(command, { connectionId, operations });
            }

            // Apply Optimistic Updates
            set(state => {
                const currentFiles = state.files[connectionId] || [];
                let newFiles = [...currentFiles, ...newEntries];

                // If moving within same connection, remove sources
                if (op === 'cut' && state.clipboard?.sourceConnectionId === connectionId) {
                    newFiles = newFiles.filter(f => !pathsToRemoveFromSource.includes(f.path));
                }

                return {
                    isLoading: { ...state.isLoading, [connectionId]: false }, // Done "loading"
                    files: { ...state.files, [connectionId]: newFiles }
                };
            });

            // If cut from DIFFERENT connection, we should also update the SOURCE list if it's loaded?
            if (op === 'cut' && state.clipboard?.sourceConnectionId && state.clipboard.sourceConnectionId !== connectionId) {
                // Optimistically remove from source
                const srcId = state.clipboard.sourceConnectionId;
                set(state => {
                    const srcFiles = state.files[srcId];
                    if (!srcFiles) return {}; // Not loaded, ignore
                    return {
                        files: {
                            ...state.files,
                            [srcId]: srcFiles.filter(f => !pathsToRemoveFromSource.includes(f.path))
                        }
                    };
                });
            }

            get().setLastAction(`${op === 'copy' ? 'Copying' : 'Moving'} ${sources.length} item(s)...`, 'info');
            // Background op: Wait for event
        } catch (error: any) {
            get().showToast('error', `Paste failed: ${error.message}`);
            set(state => ({ isLoading: { ...state.isLoading, [connectionId]: false } }));
        }
    },

    navigateUp: (connectionId) => {
        const path = get().currentPath[connectionId];
        if (!path || path === '/') return;

        const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
        get().loadFiles(connectionId, parentPath); // History will be updated automatically
    },

    navigateBack: (connectionId) => {
        const state = get();
        const history = state.history[connectionId] || [];
        const index = state.historyIndex[connectionId] || 0;

        if (index > 0) {
            const newIndex = index - 1;
            const prevPath = history[newIndex];

            set(state => ({
                historyIndex: { ...state.historyIndex, [connectionId]: newIndex }
            }));

            get().loadFiles(connectionId, prevPath, true); // Skip history update
        }
    },

    navigateForward: (connectionId) => {
        const state = get();
        const history = state.history[connectionId] || [];
        const index = state.historyIndex[connectionId] || 0;

        if (index < history.length - 1) {
            const newIndex = index + 1;
            const nextPath = history[newIndex];

            set(state => ({
                historyIndex: { ...state.historyIndex, [connectionId]: newIndex }
            }));

            get().loadFiles(connectionId, nextPath, true); // Skip history update
        }
    },

    checkPathExists: async (connectionId, path) => {
        try {
            return await ipc.invoke('fs_exists', { connectionId, path });
        } catch (error) {
            console.error('Failed to check path existence:', error);
            return false;
        }
    }
});
