import type { Connection, Tab } from '../domain/types.js';

export interface TabState {
    tabs: Tab[];
    activeTabId: string | null;
    activeConnectionId: string | null;
}

export const LOCAL_TERMINAL_CONNECTION_ID = 'local';
export const GLOBAL_SNIPPETS_CONNECTION_ID = 'global';

export const createLocalTerminalTabState = (tabs: Tab[]): TabState => {
    const existingLocalTerminal = tabs.find(
        (tab) => tab.connectionId === LOCAL_TERMINAL_CONNECTION_ID && tab.type === 'connection' && tab.view === 'terminal',
    );
    if (existingLocalTerminal) {
        return {
            tabs,
            activeTabId: existingLocalTerminal.id,
            activeConnectionId: LOCAL_TERMINAL_CONNECTION_ID,
        };
    }

    const newTab: Tab = {
        id: crypto.randomUUID(),
        type: 'connection',
        title: 'Local Terminal',
        connectionId: LOCAL_TERMINAL_CONNECTION_ID,
        view: 'terminal',
    };

    return {
        tabs: [...tabs, newTab],
        activeTabId: newTab.id,
        activeConnectionId: LOCAL_TERMINAL_CONNECTION_ID,
    };
};

export const findConnectionTab = (tabs: Tab[], connectionId: string): Tab | undefined =>
    tabs.find((tab) => tab.connectionId === connectionId && tab.type === 'connection');

export const activateExistingConnectionTab = (
    tabs: Tab[],
    existingTab: Tab,
    startView: Tab['view'],
): TabState => {
    const updatedTabs = tabs.map((tab) =>
        tab.id === existingTab.id && startView && tab.view !== startView
            ? { ...tab, view: startView }
            : tab,
    );

    return {
        tabs: updatedTabs,
        activeTabId: existingTab.id,
        activeConnectionId: existingTab.connectionId ?? null,
    };
};

export const createConnectionTabState = (
    tabs: Tab[],
    connection: Connection,
    startView: Tab['view'],
): TabState => {
    const newTab: Tab = {
        id: crypto.randomUUID(),
        type: 'connection',
        title: connection.name || connection.host || 'Untitled Connection',
        connectionId: connection.id,
        view: startView,
    };

    return {
        tabs: [...tabs, newTab],
        activeTabId: newTab.id,
        activeConnectionId: connection.id,
    };
};

export const ensureSingleTabByType = (
    tabs: Tab[],
    type: Tab['type'],
    makeTab: () => Tab,
): { tabs?: Tab[]; activeTabId: string; activeConnectionId?: string | null } => {
    const nextActiveConnectionId = type === 'connection' ? undefined : null;
    const existing = tabs.find((tab) => tab.type === type);
    if (existing) {
        return { activeTabId: existing.id, activeConnectionId: nextActiveConnectionId };
    }

    const newTab = makeTab();
    return { tabs: [...tabs, newTab], activeTabId: newTab.id, activeConnectionId: nextActiveConnectionId };
};

export const ensureGlobalSnippetsTab = (
    tabs: Tab[],
): { tabs?: Tab[]; activeTabId: string; activeConnectionId?: string } => {
    const existing = tabs.find(
        (tab) => tab.connectionId === GLOBAL_SNIPPETS_CONNECTION_ID && tab.type === 'connection' && tab.view === 'snippets',
    );
    if (existing) {
        return { activeTabId: existing.id, activeConnectionId: GLOBAL_SNIPPETS_CONNECTION_ID };
    }

    const newTab: Tab = {
        id: crypto.randomUUID(),
        type: 'connection',
        title: 'Global Snippets',
        connectionId: GLOBAL_SNIPPETS_CONNECTION_ID,
        view: 'snippets',
    };

    return {
        tabs: [...tabs, newTab],
        activeTabId: newTab.id,
        activeConnectionId: GLOBAL_SNIPPETS_CONNECTION_ID,
    };
};
