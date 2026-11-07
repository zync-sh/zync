import type { Tab } from '../features/connections/domain/types.js';
import {
    type ContentPresentationMap,
    parseContentPresentation,
} from '../features/workspace/domain/contentPresentation';
import {
    parseWorkspaceDocking,
    type WorkspaceDockingMap,
} from '../features/workspace/domain/docking';
import {
    assertSupportedMainTabPresentations,
    type MainTabPresentation,
    parseMainTabPresentation,
    stablePinnedMainTabs,
} from '../features/workspace/domain/mainTabPresentation';
import { normalizeDisplayAlias } from '../features/workspace/domain/presentation';
import {
    findLayoutOwner,
    type PaneLayoutGroups,
    snapshotPaneLayoutGroups,
    visibleTermIds,
} from '../lib/paneLayout';
import type { VaultProfileId } from '../vault/profileTypes.js';

export interface TerminalTabSnapshot {
    id: string;
    title: string;
    cwd?: string;
    initialPath?: string;
    isSynced?: boolean;
    shellOverride?: string;
    tabVisible?: boolean;
}

export interface TabSnapshot {
    id: string;
    tabType: string;
    title: string;
    displayAlias?: string;
    presentation?: MainTabPresentation;
    connectionId?: string;
    vaultProfileId?: VaultProfileId;
    vncProfileId?: string;
    serialProfileId?: string;
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
    paneLayouts?: Record<string, PaneLayoutGroups>;
    contentPresentation?: ContentPresentationMap;
    workspaceDocking?: WorkspaceDockingMap;
}

export interface SessionStoreSnapshot {
    showWelcomeScreen?: boolean;
    activeTabId: string | null;
    activeConnectionId: string | null;
    tabs: Tab[];
    terminals: Record<string, SessionTerminalTabState[]>;
    activeTerminalIds: Record<string, string | null>;
    paneLayouts?: Record<string, PaneLayoutGroups | undefined>;
    contentPresentation?: ContentPresentationMap;
    workspaceDocking?: WorkspaceDockingMap;
}

export interface SessionTerminalTabState {
    id: string;
    title: string;
    lastKnownCwd?: string;
    initialPath?: string;
    isSynced?: boolean;
    shellOverride?: string;
    tabVisible?: boolean;
}

/** Additive optional presentation metadata remains compatible with version 1. */
export const SESSION_VERSION = 1;
export const MAX_TABS_PER_SCOPE = 20;

function keepTerminalsForSession(
    tabs: SessionTerminalTabState[],
    groups: PaneLayoutGroups | undefined,
    cap = MAX_TABS_PER_SCOPE,
): SessionTerminalTabState[] {
    const visibleAll = tabs.filter((t) => t.tabVisible !== false);
    const byId = new Map(tabs.map((t) => [t.id, t]));
    const keptVisible: SessionTerminalTabState[] = [];
    const keptHidden: SessionTerminalTabState[] = [];
    const keptHiddenIds = new Set<string>();
    let remaining = cap;

    for (const tab of visibleAll) {
        const extraHidden: SessionTerminalTabState[] = [];
        const owner = findLayoutOwner(groups, tab.id);
        const layout = owner ? groups?.[owner] : undefined;
        if (layout) {
            for (const id of visibleTermIds(layout)) {
                if (id === tab.id || keptHiddenIds.has(id)) {
                    continue;
                }
                const extra = byId.get(id);
                if (extra && extra.tabVisible === false) {
                    extraHidden.push(extra);
                }
            }
        }
        const needed = 1 + extraHidden.length;
        if (needed > remaining) {
            if (remaining < 1) {
                continue;
            }
            keptVisible.push(tab);
            remaining -= 1;
            continue;
        }
        keptVisible.push(tab);
        keptHidden.push(...extraHidden);
        for (const extra of extraHidden) {
            keptHiddenIds.add(extra.id);
        }
        remaining -= needed;
    }

    return [...keptVisible, ...keptHidden];
}

/** Snapshot supported tab metadata and bounded terminal inventory while excluding transport open requests. */
export function buildSessionData(state: SessionStoreSnapshot): SessionData {
    assertSupportedMainTabPresentations(state.tabs);
    const presentation = parseContentPresentation(state.contentPresentation);
    if (!presentation.ok) {
        throw new Error('SESSION_UNSUPPORTED_VERSION: unsupported content presentation metadata');
    }
    const docking = parseWorkspaceDocking(state.workspaceDocking);
    if (!docking.ok) {
        throw new Error('SESSION_UNSUPPORTED_VERSION: unsupported workspace docking metadata');
    }
    const filteredTabs = stablePinnedMainTabs(
        (state.tabs ?? []).filter((t) => t.type !== 'settings'),
    );
    const terminals = Object.fromEntries(
        Object.entries(state.terminals ?? {}).map(([connId, tabs]) => {
            const kept = keepTerminalsForSession(tabs, state.paneLayouts?.[connId]);
            return [
                connId,
                kept.map((t) => ({
                    id: t.id,
                    title: t.title,
                    cwd: t.lastKnownCwd,
                    initialPath: t.initialPath,
                    isSynced: t.isSynced,
                    ...(t.shellOverride !== undefined && { shellOverride: t.shellOverride }),
                    ...(t.tabVisible === false && { tabVisible: false as const }),
                })),
            ];
        }),
    ) as Record<string, TerminalTabSnapshot[]>;

    return {
        version: SESSION_VERSION,
        showWelcomeScreen: Boolean(state.showWelcomeScreen),
        activeTabId: filteredTabs.some((t) => t.id === state.activeTabId)
            ? (state.activeTabId ?? undefined)
            : undefined,
        activeConnectionId: state.activeConnectionId ?? undefined,
        // Exclude transient UI-only tabs (settings) from persistence.
        tabs: filteredTabs.map((t) => {
            const parsed = parseMainTabPresentation(t.presentation);
            // The complete inventory was validated before filtering transient tabs.
            const presentation = parsed.ok ? parsed.value : undefined;
            return {
                id: t.id,
                tabType: t.type,
                title: t.title,
                ...(normalizeDisplayAlias(t.displayAlias) && {
                    displayAlias: normalizeDisplayAlias(t.displayAlias),
                }),
                ...(presentation && { presentation }),
                connectionId: t.connectionId,
                ...(t.vaultProfileId !== undefined && { vaultProfileId: t.vaultProfileId }),
                ...(t.type === 'vnc' &&
                    t.vncProfileId !== undefined && { vncProfileId: t.vncProfileId }),
                ...(t.type === 'serial' &&
                    t.serialProfileId !== undefined && { serialProfileId: t.serialProfileId }),
                view: t.view,
            };
        }),
        terminals,
        activeTerminalIds: Object.fromEntries(
            (Object.entries(state.activeTerminalIds ?? {}) as [string, string | null][]).filter(
                (entry): entry is [string, string] =>
                    entry[1] != null &&
                    (terminals[entry[0]] ?? []).some((tab) => tab.id === entry[1]),
            ),
        ),
        paneLayouts: snapshotPaneLayoutGroups(state.paneLayouts ?? {}, terminals),
        ...(Object.keys(presentation.value).length && { contentPresentation: presentation.value }),
        ...(Object.keys(docking.value).length && { workspaceDocking: docking.value }),
    };
}
