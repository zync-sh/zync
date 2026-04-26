import type { Tab } from '../features/connections/domain/types.js';

export interface TerminalTabSnapshot {
    id: string;
    title: string;
    cwd?: string;
    initialPath?: string;
    isSynced?: boolean;
    shellOverride?: string;
}

export interface TabSnapshot {
    id: string;
    tabType: string;
    title: string;
    connectionId?: string;
    view: string;
}

export interface SessionData {
    version: number;
    showWelcomeScreen: boolean;
    activeTabId?: string;
    activeConnectionId?: string;
    tabs: TabSnapshot[];
    terminals: Record<string, TerminalTabSnapshot[]>;
    activeTerminalIds: Record<string, string>;
}

export interface SessionStoreSnapshot {
    showWelcomeScreen?: boolean;
    activeTabId: string | null;
    activeConnectionId: string | null;
    tabs: Tab[];
    terminals: Record<string, SessionTerminalTabState[]>;
    activeTerminalIds: Record<string, string | null>;
}

export interface SessionTerminalTabState {
    id: string;
    title: string;
    lastKnownCwd?: string;
    initialPath?: string;
    isSynced?: boolean;
    shellOverride?: string;
}

export const MAX_TABS_PER_SCOPE = 20;

export function buildSessionData(state: SessionStoreSnapshot): SessionData {
    const filteredTabs = (state.tabs ?? []).filter(t => t.type !== 'settings');
    const terminals = Object.fromEntries(
        Object.entries(state.terminals ?? {}).map(([connId, tabs]) => [
            connId,
            tabs.slice(0, MAX_TABS_PER_SCOPE).map(t => ({
                id: t.id,
                title: t.title,
                cwd: t.lastKnownCwd,
                initialPath: t.initialPath,
                isSynced: t.isSynced,
                shellOverride: t.shellOverride,
            })),
        ]),
    ) as Record<string, TerminalTabSnapshot[]>;

    return {
        version: 1,
        showWelcomeScreen: Boolean(state.showWelcomeScreen),
        activeTabId: filteredTabs.some(t => t.id === state.activeTabId)
            ? (state.activeTabId ?? undefined)
            : undefined,
        activeConnectionId: state.activeConnectionId ?? undefined,
        // Exclude transient UI-only tabs (settings) from persistence.
        tabs: filteredTabs.map(t => ({
            id: t.id,
            tabType: t.type,
            title: t.title,
            connectionId: t.connectionId,
            view: t.view,
        })),
        terminals,
        activeTerminalIds: Object.fromEntries(
            (Object.entries(state.activeTerminalIds ?? {}) as [string, string | null][])
                .filter(
                    (entry): entry is [string, string] =>
                        entry[1] != null &&
                        (terminals[entry[0]] ?? []).some(tab => tab.id === entry[1]),
                ),
        ),
    };
}
