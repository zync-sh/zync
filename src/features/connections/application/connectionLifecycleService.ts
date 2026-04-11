import type { Connection, Tab } from '../domain/types.js';

export const markConnectionStatus = (
    connections: Connection[],
    connectionId: string,
    status: Connection['status'],
): Connection[] => {
    let updated = false;
    const next = connections.map((connection) => {
        if (connection.id !== connectionId) return connection;
        if (connection.status === status) return connection;
        updated = true;
        return { ...connection, status };
    });

    return updated ? next : connections;
};

export const markConnectionConnected = (
    connections: Connection[],
    connectionId: string,
    homePath: string,
    detectedOs?: string | null,
): Connection[] => {
    const normalizedOs = detectedOs?.toLowerCase();
    let updated = false;

    const next = connections.map((connection) => {
        if (connection.id !== connectionId) return connection;

        const nextConnection: Connection = {
            ...connection,
            status: 'connected',
            lastConnected: Date.now(),
            homePath,
        };

        if (normalizedOs && (!connection.icon || connection.icon === 'Server')) {
            nextConnection.icon = normalizedOs;
        }

        if (
            connection.status !== nextConnection.status ||
            connection.homePath !== nextConnection.homePath ||
            connection.icon !== nextConnection.icon ||
            connection.lastConnected !== nextConnection.lastConnected
        ) {
            updated = true;
        }

        return nextConnection;
    });

    return updated ? next : connections;
};

export const markConnectionErrorIfNeeded = (
    connections: Connection[],
    connectionId: string,
): Connection[] => {
    const current = connections.find((connection) => connection.id === connectionId);
    if (!current) return connections;
    if (current?.status === 'error') return connections;

    return markConnectionStatus(connections, connectionId, 'error');
};

export interface CloseTabStateResult {
    tabs: Tab[];
    activeTabId: string | null;
    activeConnectionId: string | null;
}

export interface CloseTabPreActions {
    disconnectConnectionId: string | null;
    clearLocalTerminals: boolean;
}

export const getCloseTabPreActions = (
    tab: Tab | undefined,
    tabs: Tab[],
    connections: Connection[],
): CloseTabPreActions => {
    if (!tab?.connectionId) {
        return { disconnectConnectionId: null, clearLocalTerminals: false };
    }

    if (tab.connectionId === 'local' && tab.view === 'terminal') {
        const hasOtherLocalTerminalTabs = tabs.some(
            (item) => item.id !== tab.id && item.connectionId === 'local' && item.view === 'terminal',
        );
        return {
            disconnectConnectionId: null,
            clearLocalTerminals: !hasOtherLocalTerminalTabs,
        };
    }

    const hasOtherTabsForConnection = tabs.some(
        (item) => item.id !== tab.id && item.connectionId === tab.connectionId,
    );
    if (hasOtherTabsForConnection) {
        return { disconnectConnectionId: null, clearLocalTerminals: false };
    }

    const connection = connections.find((item) => item.id === tab.connectionId);
    if (connection?.status === 'connected') {
        return { disconnectConnectionId: connection.id, clearLocalTerminals: false };
    }

    return { disconnectConnectionId: null, clearLocalTerminals: false };
};

export const reduceTabCloseState = (
    tabs: Tab[],
    activeTabId: string | null,
    closingTabId: string,
): CloseTabStateResult => {
    const nextTabs = tabs.filter((tab) => tab.id !== closingTabId);
    const hasCurrentActive = !!activeTabId && nextTabs.some((tab) => tab.id === activeTabId);
    const fallbackActiveTabId = nextTabs.length > 0 ? nextTabs[nextTabs.length - 1].id : null;
    const nextActiveTabId =
        activeTabId === closingTabId
            ? fallbackActiveTabId
            : hasCurrentActive
                ? activeTabId
                : fallbackActiveTabId;
    const activeTab = nextTabs.find((tab) => tab.id === nextActiveTabId);

    return {
        tabs: nextTabs,
        activeTabId: nextActiveTabId,
        activeConnectionId: activeTab?.connectionId || null,
    };
};
