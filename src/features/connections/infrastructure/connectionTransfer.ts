import type { Connection, Folder } from '../domain/types.js';

export type ConnectionExchangeExportFormat = 'zync' | 'json' | 'csv' | 'ssh_config';
export type ConnectionExchangeImportFormat = 'auto' | 'zync' | 'json' | 'csv';

export interface ConnectionExportToFileRequest {
    path: string;
    format: ConnectionExchangeExportFormat;
    connectionIds?: string[];
    includeSecrets?: boolean;
}

export interface ConnectionImportFromFileRequest {
    path: string;
    format?: ConnectionExchangeImportFormat;
}

export interface ImportedConnectionsData {
    connections: Array<Omit<Connection, 'status'>>;
    folders: Folder[];
}

export const exportConnectionsToFileIpc = async (
    request: ConnectionExportToFileRequest,
): Promise<string> =>
    window.ipcRenderer.invoke('connections:exportToFile', request);

export const importConnectionsFromFileIpc = async (
    request: ConnectionImportFromFileRequest,
): Promise<ImportedConnectionsData> =>
    window.ipcRenderer.invoke('connections:importFromFile', request);
