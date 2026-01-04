import { createContext, useContext, useState, ReactNode, useEffect } from 'react';
import { connectionStorage } from '../lib/storage';
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
}

export interface Tab {
    id: string;
    type: 'connection' | 'settings';
    title: string;
    connectionId?: string;
    view: 'dashboard' | 'files' | 'tunnels' | 'snippets' | 'terminal'; // Per-tab view state
}

interface ConnectionContextType {
    connections: Connection[];
    tabs: Tab[];
    activeTabId: string | null;
    activeConnectionId: string | null; // Derived helper

    addConnection: (conn: Connection) => void;
    importConnections: (conns: Connection[]) => void;
    deleteConnection: (id: string) => void;
    clearConnections: () => void;

    // Tab Actions
    openTab: (connectionId: string) => void;
    closeTab: (tabId: string) => void;
    activateTab: (tabId: string) => void;
    setTabView: (tabId: string, view: 'dashboard' | 'files' | 'tunnels' | 'snippets' | 'terminal') => void;

    // Connection Actions
    connect: (id: string) => Promise<void>;
    disconnect: (id: string) => Promise<void>;
}

const ConnectionContext = createContext<ConnectionContextType | undefined>(undefined);

export function ConnectionProvider({ children }: { children: ReactNode }) {
    const [connections, setConnections] = useState<Connection[]>([]);
    const [tabs, setTabs] = useState<Tab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);

    // Derived: The Active Connection ID is the one associated with the active Tab
    const activeConnectionId = tabs.find(t => t.id === activeTabId)?.connectionId || null;

    const { showToast } = useToast();

    // Load connections and open Default Local Terminal
    useEffect(() => {
        const stored = connectionStorage.load();
        if (stored.length > 0) {
            setConnections(stored.map(c => ({ ...c, status: 'disconnected' as const })));
        }

        // Open Local Terminal by default if no tabs exist -> DISABLED for Welcome Screen
        // setTabs(prev => {
        //     if (prev.length === 0) {
        //         return [{
        //             id: crypto.randomUUID(),
        //             type: 'connection',
        //             title: 'Local Terminal',
        //             connectionId: 'local',
        //             view: 'terminal'
        //         }];
        //     }
        //     return prev;
        // });

        // Also set active if created
        setActiveTabId(prev => prev || (tabs.length > 0 ? tabs[0].id : null)); // This might race. 
        // Better to set activeTabId based on the newly created tab.
        // But setState inside setState is tricky for side effects.
        // I'll do it in a separate effect or just assume the user clicks.
        // Actually, let's simplify:
    }, []);

    // Set active tab on mount if local was added (hacky but works for now)
    useEffect(() => {
        if (tabs.length > 0 && !activeTabId) {
            setActiveTabId(tabs[0].id);
        }
    }, [tabs.length]); // Check when tabs change length (init)

    // Sync Loop: Periodically check if backend connections are still alive
    // This handles cases where the backend process restarts (dev mode) or crashes
    useEffect(() => {
        const checkConnections = async () => {
            const connectedIds = connections.filter(c => c.status === 'connected' || c.status === 'connecting').map(c => c.id);
            if (connectedIds.length === 0) return;

            for (const id of connectedIds) {
                try {
                    const isAlive = await window.ipcRenderer.invoke('ssh:status', id);
                    if (!isAlive) {
                        console.warn(`Connection ${id} lost in backend. Updating state.`);
                        setConnections(prev => prev.map(c => c.id === id ? { ...c, status: 'disconnected' } : c));
                        showToast('error', `Connection lost to host (Process restarted?)`);
                    }
                } catch (e) {
                    console.error('Failed to check status for', id, e);
                }
            }
        };

        const interval = setInterval(checkConnections, 5000); // Check every 5 seconds
        // Also run once immediately (or after short delay to allow init)
        setTimeout(checkConnections, 1000);

        return () => clearInterval(interval);
    }, [connections]); // Depend on connections to know which to check

    // Save connections
    useEffect(() => {
        if (connections.length > 0) {
            const toSave = connections.map(({ id, name, host, username, port, privateKeyPath, jumpServerId, lastConnected }) => ({
                id, name, host, username, port, privateKeyPath, jumpServerId, lastConnected
            }));
            connectionStorage.save(toSave);
        }
    }, [connections]);

    const addConnection = (conn: Connection) => {
        setConnections([...connections, conn]);
    };

    const importConnections = (newConns: Connection[]) => {
        setConnections(prev => {
            const existingMap = new Map(prev.map(c => [c.name, c.id]));
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
                    const existingConn = prev.find(c => c.id === existingId)!;

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

            // Fix references in the newly formed list (mixed of updated and new)
            // But wait, 'prev' still has the old ones. We need to REPLACE them.
            // So we shouldn't return [...prev, ...cleanedConns]. We should structure the final list.

            // Strategy:
            // 1. We have 'connsToAdd' which contains EVERYTHING we want to keep from the import (updates + new).
            // 2. What about connections in 'prev' that were NOT in the import? We should keep them too.
            // 3. So we start with 'prev' connections that are NOT in `existingMap` (wait, existingMap covers matches).
            //    Actually, we want to KEEP connections that are NOT in the import.

            const importedNames = new Set(newConns.map(c => c.name));
            const preservedOldConns = prev.filter(c => !importedNames.has(c.name));

            // Now resolve Jump IDs for everything in connsToAdd
            const finalizedImportedConns = connsToAdd.map(c => {
                if (c.jumpServerId && remappedIds.has(c.jumpServerId)) {
                    return { ...c, jumpServerId: remappedIds.get(c.jumpServerId) };
                }
                return c;
            });

            return [...preservedOldConns, ...finalizedImportedConns];
        });
    };

    const deleteConnection = (id: string) => {
        setConnections(prev => prev.filter(c => c.id !== id));
        // Also close tabs related to this connection
        const tabsToRemove = tabs.filter(t => t.connectionId === id);
        tabsToRemove.forEach(t => closeTab(t.id));
    };

    const clearConnections = () => {
        setConnections([]);
        setTabs([]);
        setActiveTabId(null);
    };

    // --- Tab Management ---

    const openTab = (connectionId: string) => {
        // Handle Local Terminal Special Case
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
            view: 'dashboard'
        };

        setTabs(prev => [...prev, newTab]);
        setActiveTabId(newTab.id);

        if (conn.status === 'disconnected') {
            connect(conn.id);
        }
    };

    const closeTab = (tabId: string) => {
        setTabs(prev => {
            const newTabs = prev.filter(t => t.id !== tabId);
            if (activeTabId === tabId) {
                // Determine new active tab (e.g., the last one)
                const newActive = newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null;
                setActiveTabId(newActive);
            }
            return newTabs;
        });

        // Note: Closing a tab does NOT strictly disconnect the session unless we want it to.
        // For standard behavior, closing the tab *should* disconnect the SSH session if it's the last tab for that connection.
        // But implementing that logic logic is complex.
        // Let's keep it simple: Close Tab = Just UI close.
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
            deleteConnection,
            openTab,
            closeTab,
            activateTab,
            setTabView,
            connect,
            disconnect,
            importConnections,
            clearConnections
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
