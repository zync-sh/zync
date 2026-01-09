import { createContext, useContext, useState, ReactNode, useEffect, useMemo } from 'react';
// import { connectionStorage } from '../lib/storage'; // Removed
import { useToast } from './ToastContext';

export interface Connection {
    id: string;
    name: string;
    host: string;
    username: string;
    port: number;
    password?: string;
    privateKeyPath?: string;
    status: 'disconnected' | 'connecting' | 'connected' | 'error';
    jumpServerId?: string;
    lastConnected?: number;
    icon?: string;
    folder?: string;
    theme?: string; // 'red', 'blue', 'green', 'orange', etc.
    tags?: string[]; // Array of tag IDs or Colors
    // ... existing fields

    createdAt?: number;
}

export interface Folder {
    name: string;
    tags?: string[];
}

// ... existing imports

export interface Tab {
    id: string;
    type: 'connection' | 'settings' | 'tunnels'; // Added tunnels
    title: string;
    connectionId?: string;
    view: 'dashboard' | 'files' | 'tunnels' | 'snippets' | 'terminal';
}

interface ConnectionContextType {
    connections: Connection[];
    tabs: Tab[];
    activeTabId: string | null;
    activeConnectionId: string | null;

    addConnection: (conn: Connection) => void;
    editConnection: (conn: Connection) => void;
    importConnections: (conns: Connection[]) => void;
    deleteConnection: (id: string) => void;
    clearConnections: () => void;

    // Tab Actions
    openTab: (connectionId: string) => void;
    openTunnelsTab: () => void;
    closeTab: (tabId: string) => void;
    activateTab: (tabId: string) => void;
    setTabView: (tabId: string, view: 'dashboard' | 'files' | 'tunnels' | 'snippets' | 'terminal') => void;

    // Connection Actions
    connect: (id: string) => Promise<void>;
    disconnect: (id: string) => Promise<void>;

    // Folders
    folders: Folder[];
    addFolder: (name: string, tags?: string[]) => void;
    deleteFolder: (name: string) => void;
    renameFolder: (oldName: string, newName: string, newTags?: string[]) => void;
    updateConnectionFolder: (connectionId: string, folderName: string) => void;

    // UI State
    isAddConnectionModalOpen: boolean;
    openAddConnectionModal: () => void;
    closeAddConnectionModal: () => void;
}

const ConnectionContext = createContext<ConnectionContextType | undefined>(undefined);

export function ConnectionProvider({ children }: { children: ReactNode }) {
    const [connections, setConnections] = useState<Connection[]>([]);
    const [customFolders, setCustomFolders] = useState<Folder[]>([]); // Explicitly created folders
    const [tabs, setTabs] = useState<Tab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);
    // const [isLoaded, setIsLoaded] = useState(false); // Unused with manual save strategy
    const [isAddConnectionModalOpen, setIsAddConnectionModalOpen] = useState(false);

    // Derived: The Active Connection ID is the one associated with the active Tab
    const activeConnectionId = tabs.find(t => t.id === activeTabId)?.connectionId || null;

    const { showToast } = useToast();

    // Load connections and folders
    const loadFromStorage = async () => {
        try {
            let loaded = await window.ipcRenderer.invoke('connections:get');
            const hasMainData = loaded && ((loaded.connections && loaded.connections.length > 0) || (Array.isArray(loaded) && loaded.length > 0));

            if (!hasMainData) {
                // Sync Migration: Check legacy localStorage
                const local = localStorage.getItem('ssh-connections');
                if (local) {
                    try {
                        console.log('Migrating legacy localStorage to Main Process...');
                        const parsed = JSON.parse(local);
                        let conns: Connection[] = [];
                        let folders: string[] = [];

                        if (Array.isArray(parsed)) {
                            conns = parsed;
                        } else if (parsed.connections) {
                            conns = parsed.connections;
                            folders = parsed.folders || [];
                        }

                        if (conns.length > 0) {
                            // Immediately save to Main/Disk to complete migration
                            // Convert legacy folders to object folders if needed
                            const folderObjects = folders.map(f => typeof f === 'string' ? { name: f } : f);
                            await saveToMain(conns, folderObjects);
                            loaded = { connections: conns, folders: folderObjects };
                        }
                    } catch (e) {
                        console.error('Migration failed:', e);
                    }
                }
            }

            if (loaded) {
                if (loaded.connections) {
                    setConnections(loaded.connections.map((c: any) => ({ ...c, status: 'disconnected' as const })));

                    // Migration: Convert loaded folders (string[] | Folder[]) to Folder[]
                    const loadedFolders = loaded.folders || [];
                    const normalizedFolders = loadedFolders.map((f: any) => typeof f === 'string' ? { name: f } : f);
                    setCustomFolders(normalizedFolders);
                } else if (Array.isArray(loaded)) { // Fallback for legacy format if any
                    setConnections(loaded.map((c: any) => ({ ...c, status: 'disconnected' as const })));
                }
            }
            // setIsLoaded(true);
        } catch (error) {
            console.error('Failed to load connections from main process:', error);
            showToast('error', 'Failed to load connections');
        }
    };

    useEffect(() => {
        loadFromStorage();

        // Listen for Real-Time Updates from Main Process (Single Source of Truth)
        const handleSync = (_: any, data: any) => {
            console.log('Received connection sync from main process');
            if (data && data.connections) {
                // Merge status? No, status is runtime. We only sync CONFIG data.
                // But we need to preserve status of currently active connections!
                setConnections(prev => {
                    const statusMap = new Map(prev.map(c => [c.id, c.status]));

                    return data.connections.map((remoteConn: Connection) => ({
                        ...remoteConn,
                        // Preserve local runtime state like status, unless it's a new connection
                        status: statusMap.get(remoteConn.id) || 'disconnected',
                    }));
                });

                if (data.folders) {
                    const loadedFolders = data.folders || [];
                    const normalizedFolders = loadedFolders.map((f: any) => typeof f === 'string' ? { name: f } : f);
                    setCustomFolders(normalizedFolders);
                }
            }
        };

        window.ipcRenderer.on('connections:updated', handleSync);
        return () => {
            // @ts-ignore
            window.ipcRenderer.off('connections:updated', handleSync);
        };
    }, []);

    // Helper to Save to Main Process
    const saveToMain = async (newConnections: Connection[], newFolders: Folder[]) => {
        try {
            // Strip runtime status before saving
            const toSave = newConnections.map(({ status, ...c }) => c);
            await window.ipcRenderer.invoke('connections:save', {
                connections: toSave,
                folders: newFolders
            });
        } catch (error) {
            console.error('Failed to save to main process:', error);
            showToast('error', 'Failed to save changes');
        }
    };

    const addConnection = (conn: Connection) => {
        const newConns = [...connections, conn];
        setConnections(newConns);
        saveToMain(newConns, customFolders);
    };

    const editConnection = (updatedConn: Connection) => {
        const newConns = connections.map(c => c.id === updatedConn.id ? updatedConn : c);
        setConnections(newConns);
        saveToMain(newConns, customFolders);
        // If the connection name changed, we might want to update tabs, but ID references are stable.
    };

    const importConnections = (newConns: Connection[]) => {
        const existingMap = new Map(connections.map(c => [c.name, c.id]));
        const remappedIds = new Map<string, string>(); // Map [ImportedID] -> [ExistingID]
        const connsToAdd: Connection[] = [];

        for (const conn of newConns) {
            if (existingMap.has(conn.name)) {
                // Update existing connection with new details
                // We must keep the EXISTING ID so tabs remain valid
                const existingId = existingMap.get(conn.name)!;

                // Map the *imported* ID to the *existing* ID for jump server resolution later
                remappedIds.set(conn.id, existingId);

                // Create updated connection object: Use Imported Data but Existing ID
                // We also need to be careful about 'status' - keep existing status?
                const existingConn = connections.find(c => c.id === existingId)!;

                connsToAdd.push({
                    ...conn,
                    id: existingId,
                    status: existingConn.status, // Preserve status (e.g. connected)
                    // jumpServerId will be resolved in the next step
                });
            } else {
                connsToAdd.push(conn);
            }
        }

        const importedNames = new Set(newConns.map(c => c.name));
        const preservedOldConns = connections.filter(c => !importedNames.has(c.name));

        // Now resolve Jump IDs for everything in connsToAdd
        const finalizedImportedConns = connsToAdd.map(c => {
            if (c.jumpServerId && remappedIds.has(c.jumpServerId)) {
                return { ...c, jumpServerId: remappedIds.get(c.jumpServerId) };
            }
            return c;
        });

        const finalConns = [...preservedOldConns, ...finalizedImportedConns];
        setConnections(finalConns);
        saveToMain(finalConns, customFolders);
    };

    const deleteConnection = (id: string) => {
        const newConns = connections.filter(c => c.id !== id);
        setConnections(newConns);
        saveToMain(newConns, customFolders);

        // Also close tabs related to this connection
        const tabsToRemove = tabs.filter(t => t.connectionId === id);
        tabsToRemove.forEach(t => closeTab(t.id));
    };

    // Folder Management
    const addFolder = (name: string, tags: string[] = []) => {
        if (!name || customFolders.some(f => f.name === name)) return;
        const newFolders = [...customFolders, { name, tags }];
        setCustomFolders(newFolders);
        saveToMain(connections, newFolders);
    };

    const deleteFolder = (folderToDelete: string) => {
        // 1. Identify Parent Path
        const parentPath = folderToDelete.includes('/')
            ? folderToDelete.substring(0, folderToDelete.lastIndexOf('/'))
            : '';

        // 2. Update Sub-Folders
        // We keep all folders EXCEPT the one being deleted.
        // But we RENAME the ones that were inside it to move them UP.
        const newFolders = customFolders
            .filter(f => f.name !== folderToDelete) // Remove the specific folder
            .map(f => {
                if (f.name.startsWith(folderToDelete + '/')) {
                    // Promote: "Target/Child" -> "Parent/Child"
                    // If Parent is empty: "Child"
                    const suffix = f.name.substring(folderToDelete.length + 1);
                    return {
                        ...f,
                        name: parentPath ? `${parentPath}/${suffix}` : suffix
                    };
                }
                return f;
            });

        setCustomFolders(newFolders);

        // 3. Update Connections
        // Move connections inside this folder (or sub-folders) UP one level
        let connectionsUpdated = false;
        const newConns = connections.map(c => {
            if (c.folder === folderToDelete) {
                // Direct child -> Move to Parent
                connectionsUpdated = true;
                return { ...c, folder: parentPath };
            }
            if (c.folder?.startsWith(folderToDelete + '/')) {
                // Nested child -> Promote path
                connectionsUpdated = true;
                const suffix = c.folder.substring(folderToDelete.length + 1);
                return {
                    ...c,
                    folder: parentPath ? `${parentPath}/${suffix}` : suffix
                };
            }
            return c;
        });

        if (connectionsUpdated) {
            setConnections(newConns);
            saveToMain(newConns, newFolders);
        } else {
            saveToMain(connections, newFolders);
        }
    };

    const renameFolder = (oldName: string, newName: string, newTags?: string[]) => {
        if (!newName || (newName !== oldName && customFolders.some(f => f.name === newName))) return; // Prevent renaming to an existing folder name

        // Update folders: Rename the target folder AND all its sub-folders
        const newFolders = customFolders.map(f => {
            if (f.name === oldName) {
                return { ...f, name: newName, tags: newTags !== undefined ? newTags : f.tags };
            }
            if (f.name.startsWith(oldName + '/')) {
                // Rename sub-folder: Replace the prefix
                // e.g. "Parent/Child" -> "NewParent/Child"
                return { ...f, name: newName + f.name.substring(oldName.length) };
            }
            return f;
        });
        setCustomFolders(newFolders);

        // Update all connections in this folder
        const newConns = connections.map(c => {
            if (c.folder === oldName) return { ...c, folder: newName };

            if (c.folder?.startsWith(oldName + '/')) {
                return { ...c, folder: newName + c.folder.substring(oldName.length) };
            }
            return c;
        });
        setConnections(newConns);
        saveToMain(newConns, newFolders);
    };

    const updateConnectionFolder = (connectionId: string, folderName: string) => {
        const newConns = connections.map(c => c.id === connectionId ? { ...c, folder: folderName } : c);
        setConnections(newConns);
        saveToMain(newConns, customFolders);
    };

    // Computed list of all unique folders (implicit + explicit)
    const allFolders = useMemo(() => {
        const folderMap = new Map<string, Folder>();

        // 1. Add explicit folders (source of truth for tags)
        customFolders.forEach(f => folderMap.set(f.name, f));

        // 2. Add implicit folders from connections
        connections.forEach(c => {
            if (c.folder && !folderMap.has(c.folder)) {
                folderMap.set(c.folder, { name: c.folder });
            }
        });

        return Array.from(folderMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    }, [customFolders, connections]);

    const clearConnections = () => {
        setConnections([]);
        setCustomFolders([]);
        setTabs([]);
        setActiveTabId(null);
        saveToMain([], []);
    };

    // --- Tab Management ---

    const openTab = (connectionId: string) => {
        // ... (existing implementation)
        if (connectionId === 'local') {
            const newTab: Tab = {
                id: crypto.randomUUID(),
                type: 'connection',
                title: 'Local Terminal',
                connectionId: 'local',
                view: 'terminal' // Default to terminal view for local
            };
            setTabs(prev => [...prev, newTab]);
            setActiveTabId(newTab.id);
            // connect('local'); // Optional, but connect handles the toast
            return;
        }

        const conn = connections.find(c => c.id === connectionId);
        if (!conn) return;

        const newTab: Tab = {
            id: crypto.randomUUID(),
            type: 'connection',
            title: conn.name || conn.host,
            connectionId: conn.id,
            view: 'terminal'
        };

        setTabs(prev => [...prev, newTab]);
        setActiveTabId(newTab.id);

        if (conn.status === 'disconnected') {
            connect(conn.id);
        }
    };

    const openTunnelsTab = () => {
        const existing = tabs.find(t => t.type === 'tunnels');
        if (existing) {
            setActiveTabId(existing.id);
            return;
        }
        const newTab: Tab = {
            id: crypto.randomUUID(),
            type: 'tunnels',
            title: 'Global Tunnels',
            view: 'tunnels'
        };
        setTabs(prev => [...prev, newTab]);
        setActiveTabId(newTab.id);
    };

    const closeTab = (tabId: string) => {
        const tab = tabs.find(t => t.id === tabId);
        if (tab && tab.connectionId && tab.connectionId !== 'local') {
            const conn = connections.find(c => c.id === tab.connectionId);
            if (conn && conn.status === 'connected') {
                if (confirm(`Connection "${conn.name || conn.host}" is active. Do you want to disconnect and close the tab?`)) {
                    disconnect(conn.id);
                } else {
                    return; // Cancel close
                }
            }
        }

        setTabs(prev => {
            const newTabs = prev.filter(t => t.id !== tabId);
            if (activeTabId === tabId) {
                // Determine new active tab (e.g., the last one)
                const newActive = newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null;
                setActiveTabId(newActive);
            }
            return newTabs;
        });
    };

    const activateTab = (tabId: string) => {
        setActiveTabId(tabId);
    };

    const setTabView = (tabId: string, view: 'dashboard' | 'files' | 'tunnels' | 'snippets' | 'terminal') => {
        setTabs(prev => prev.map(t => t.id === tabId ? { ...t, view } : t));
    };

    // --- Connection Logic (Unchanged mostly) ---

    const connect = async (id: string) => {
        if (id === 'local') {
            showToast('success', 'Connected to Local Terminal');
            return;
        }

        setConnections(prev => prev.map(c => c.id === id ? { ...c, status: 'connecting' } : c));
        try {
            const connection = connections.find(c => c.id === id);
            if (!connection) throw new Error('Connection not found');

            // Prevent duplicate connection attempts
            if (connection.status === 'connecting' || connection.status === 'connected') {
                const isAlive = await window.ipcRenderer.invoke('ssh:status', id);
                if (isAlive) {
                    setConnections(prev => prev.map(c => c.id === id ? { ...c, status: 'connected' } : c));
                    return;
                }
            }

            // Recursive Jump Server Connection
            if (connection.jumpServerId) {
                const jumpServer = connections.find(c => c.id === connection.jumpServerId);
                if (jumpServer) {
                    if (jumpServer.status !== 'connected') {
                        showToast('info', `Connecting to Jump Server: ${jumpServer.name || jumpServer.host}...`);
                        await connect(jumpServer.id);
                    }
                } else {
                    throw new Error(`Jump Server with ID ${connection.jumpServerId} not found.`);
                }
            }

            await window.ipcRenderer.invoke('ssh:connect', {
                id: connection.id,
                host: connection.host,
                port: connection.port,
                username: connection.username,
                password: connection.password,
                privateKeyPath: connection.privateKeyPath,
                jumpServerId: connection.jumpServerId
            });

            setConnections(prev => prev.map(c => c.id === id ? { ...c, status: 'connected', lastConnected: Date.now() } : c));
            showToast('success', `Connected to ${connection.name || connection.host}`);
        } catch (e: any) {
            console.error(e);
            setConnections(prev => prev.map(c => c.id === id ? { ...c, status: 'error' } : c));
            showToast('error', 'Connection failed: ' + (e.message || 'Unknown error'));
        }
    };

    const disconnect = async (id: string) => {
        // ... (Send disconnect IPC) ...
        await window.ipcRenderer.invoke('ssh:disconnect', id);
        setConnections(prev => prev.map(c => c.id === id ? { ...c, status: 'disconnected' } : c));
    };

    return (
        <ConnectionContext.Provider value={{
            connections,
            tabs,
            activeTabId,
            activeConnectionId,
            addConnection,
            editConnection,
            deleteConnection,
            openTab,
            openTunnelsTab,
            closeTab,
            activateTab,
            setTabView,
            connect,
            disconnect,
            importConnections,
            clearConnections,
            folders: allFolders,
            addFolder,
            deleteFolder,
            renameFolder,
            updateConnectionFolder,
            isAddConnectionModalOpen,
            openAddConnectionModal: () => setIsAddConnectionModalOpen(true),
            closeAddConnectionModal: () => setIsAddConnectionModalOpen(false)
        }}>
            {children}
        </ConnectionContext.Provider>
    );
}

export function useConnections() {
    const context = useContext(ConnectionContext);
    if (context === undefined) {
        throw new Error('useConnections must be used within a ConnectionProvider');
    }
    return context;
}
