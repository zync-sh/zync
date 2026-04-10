import type { Connection, Folder } from '../domain/types.js';
import {
    addFolderExact,
    isFolderOrDescendant,
    mergeImportedConnectionsByName,
    normalizeFolderPath,
    normalizePort,
    normalizeText,
    remapFolderPath,
    updateConnectionFolderExact,
} from '../domain/index.js';

export interface ConnectionFolderState {
    connections: Connection[];
    folders: Folder[];
}

interface ConnectionEndpointDraft {
    host?: string;
    username?: string;
    port?: number | string;
}

const ensureFolderExists = (folders: Folder[], folderName: string | undefined): Folder[] => {
    const normalized = normalizeFolderPath(folderName || '');
    if (!normalized) return folders;
    if (folders.some((folder) => normalizeFolderPath(folder.name) === normalized)) return folders;
    return [...folders, { name: normalized }];
};

export const mergeImportedConnections = (
    existingConnections: Connection[],
    importedConnections: Connection[],
): Connection[] => mergeImportedConnectionsByName(existingConnections, importedConnections).merged;

export const findDuplicateConnectionByEndpoint = (
    connections: Connection[],
    draft: ConnectionEndpointDraft,
    excludeConnectionId?: string | null,
): Connection | null => {
    const normalizedHost = normalizeText(draft.host).toLowerCase();
    const normalizedUsername = normalizeText(draft.username).toLowerCase();
    if (!normalizedHost || !normalizedUsername) return null;

    const normalizedPort = normalizePort(draft.port);
    return connections.find((connection) => {
        if (excludeConnectionId && connection.id === excludeConnectionId) return false;
        return (
            normalizeText(connection.host).toLowerCase() === normalizedHost &&
            normalizeText(connection.username).toLowerCase() === normalizedUsername &&
            normalizePort(connection.port) === normalizedPort
        );
    }) || null;
};

export const addFolderToState = (
    state: ConnectionFolderState,
    name: string,
    tags?: string[],
): ConnectionFolderState => {
    const canonicalName = normalizeFolderPath(name);
    if (!canonicalName) return state;
    return {
        ...state,
        folders: addFolderExact(state.folders, canonicalName, tags),
    };
};

export const deleteFolderFromState = (
    state: ConnectionFolderState,
    name: string,
): ConnectionFolderState => {
    const targetFolder = normalizeFolderPath(name);
    if (!targetFolder) return state;

    return {
        ...state,
        folders: state.folders.filter((folder) => !isFolderOrDescendant(targetFolder, normalizeFolderPath(folder.name))),
        connections: state.connections.map((connection) => {
            const currentFolder = normalizeFolderPath(connection.folder || '');
            if (!currentFolder || !isFolderOrDescendant(targetFolder, currentFolder)) return connection;
            return { ...connection, folder: '' };
        }),
    };
};

export const renameFolderInState = (
    state: ConnectionFolderState,
    oldName: string,
    newName: string,
    newTags?: string[],
): ConnectionFolderState => {
    const oldFolder = normalizeFolderPath(oldName);
    const newFolder = normalizeFolderPath(newName);
    if (!oldFolder || !newFolder || oldFolder === newFolder) return state;

    const hasCollision = state.folders.some((folder) => {
        const existing = normalizeFolderPath(folder.name);
        return existing === newFolder && existing !== oldFolder;
    });
    if (hasCollision) return state;

    return {
        ...state,
        folders: state.folders.map((folder) => {
            const current = normalizeFolderPath(folder.name);
            if (!isFolderOrDescendant(oldFolder, current)) return folder;
            const renamedPath = remapFolderPath(current, oldFolder, newFolder);
            if (current === oldFolder) {
                return { ...folder, name: renamedPath, tags: newTags || folder.tags };
            }
            return { ...folder, name: renamedPath };
        }),
        connections: state.connections.map((connection) => {
            const currentFolder = normalizeFolderPath(connection.folder || '');
            if (!currentFolder || !isFolderOrDescendant(oldFolder, currentFolder)) return connection;
            return { ...connection, folder: remapFolderPath(currentFolder, oldFolder, newFolder) };
        }),
    };
};

export const updateConnectionFolderInState = (
    state: ConnectionFolderState,
    connectionId: string,
    folderName: string,
): ConnectionFolderState => {
    const normalizedFolder = normalizeFolderPath(folderName);
    return {
        ...state,
        folders: ensureFolderExists(state.folders, normalizedFolder),
        connections: updateConnectionFolderExact(state.connections, connectionId, normalizedFolder),
    };
};

export const upsertConnectionInState = (
    state: ConnectionFolderState,
    connection: Connection,
): ConnectionFolderState => {
    const normalizedFolder = normalizeFolderPath(connection.folder || '');
    const nextConnection: Connection = { ...connection, folder: normalizedFolder };
    const exists = state.connections.some((item) => item.id === connection.id);
    const nextConnections = exists
        ? state.connections.map((item) => (item.id === connection.id ? nextConnection : item))
        : [...state.connections, nextConnection];

    return {
        connections: nextConnections,
        folders: ensureFolderExists(state.folders, normalizedFolder),
    };
};
