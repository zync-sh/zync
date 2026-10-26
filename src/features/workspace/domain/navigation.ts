import { reorderItemsById } from './presentation';
import { isPluginWorkspaceViewId } from './registrations';

/** Global chrome and host-tab placement preferences, not live identities or plugin permissions. */
export const LEGACY_NAVIGATION_IDS = ['hosts', 'files', 'tunnels', 'snippets', 'dashboard', 'ai', 'commands', 'settings'] as const;
export const NAVIGATION_IDS = ['hosts', 'workspace', 'public-urls', 'tunnels', 'security-audits', 'snippets', 'commands', 'vaults', 'plugins', 'settings', 'profile'] as const;
// New destinations are additive; previously saved v3 orders remain supported.
const REQUIRED_NAVIGATION_IDS = NAVIGATION_IDS.filter(id => id !== 'security-audits');
export type GlobalNavigationId = typeof NAVIGATION_IDS[number];
export type NavigationId = GlobalNavigationId | typeof LEGACY_NAVIGATION_IDS[number] | `plugin:${string}`;
export const MAX_NAVIGATION_ITEMS = 267;
export type NavigationPosition = 'left' | 'right' | 'top' | 'bottom';
export type WorkspaceTabsPosition = 'default' | 'left' | 'right';
export interface WorkspaceNavigation {
    readonly version: 1 | 2 | 3;
    readonly visible: boolean;
    readonly position: NavigationPosition;
    /** Legacy persisted field retained for compatibility; activity-bar buttons are icon-only. */
    readonly showLabels: boolean;
    readonly order: readonly NavigationId[];
    readonly hidden: readonly NavigationId[];
    readonly workspaceTabsPosition?: WorkspaceTabsPosition;
}

/** Missing preferences show the activity bar; saved visibility remains authoritative. */
export const DEFAULT_WORKSPACE_NAVIGATION: WorkspaceNavigation = Object.freeze({
    version: 3, visible: true, position: 'left', showLabels: false,
    order: NAVIGATION_IDS, hidden: Object.freeze([]), workspaceTabsPosition: 'default',
});

// Unsupported settings may contain a hidden preference we cannot interpret.
// Preserve the existing hidden recovery view without rewriting that envelope.
const READ_ONLY_WORKSPACE_NAVIGATION: WorkspaceNavigation = Object.freeze({
    ...DEFAULT_WORKSPACE_NAVIGATION, visible: false,
});

export function isNavigationId(value: unknown): value is NavigationId {
    return NAVIGATION_IDS.some(id => id === value) || isPluginWorkspaceViewId(value);
}

function isIds(value: unknown, version: 1 | 2 | 3): value is NavigationId[] {
    return Array.isArray(value) && value.length <= (version === 1 ? LEGACY_NAVIGATION_IDS.length : version === 2 ? 264 : MAX_NAVIGATION_ITEMS)
        && value.every(id => version === 3 ? isNavigationId(id) : LEGACY_NAVIGATION_IDS.some(host => host === id) || (version === 2 && isPluginWorkspaceViewId(id)))
        && new Set(value).size === value.length;
}

/** Unknown data is preserved by the settings owner, never repaired into a writable default. */
export function parseWorkspaceNavigation(value: unknown): WorkspaceNavigation | null {
    if (value === undefined) return DEFAULT_WORKSPACE_NAVIGATION;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    const keys = ['version', 'visible', 'position', 'showLabels', 'order', 'hidden', ...(item.version === 3 ? ['workspaceTabsPosition'] : [])];
    if (Object.keys(item).length !== keys.length || Object.keys(item).some(key => !keys.includes(key))
        || (item.version !== 1 && item.version !== 2 && item.version !== 3) || typeof item.visible !== 'boolean' || typeof item.showLabels !== 'boolean'
        || typeof item.position !== 'string' || !['left', 'right', 'top', 'bottom'].includes(item.position)
        || (item.version === 3 && (!['left', 'right'].includes(item.position)
            || typeof item.workspaceTabsPosition !== 'string' || !['default', 'left', 'right'].includes(item.workspaceTabsPosition)))
        || !isIds(item.order, item.version) || !(item.version === 3 ? REQUIRED_NAVIGATION_IDS : LEGACY_NAVIGATION_IDS).every(id => (item.order as string[]).includes(id))
        || !isIds(item.hidden, item.version) || !item.hidden.every(id => (item.order as NavigationId[]).includes(id))) return null;
    if (item.version === 3 && item.hidden.some(id => id === 'settings' || id === 'profile')) return null;
    return { version: item.version, visible: item.visible, position: item.position as NavigationPosition,
        showLabels: item.showLabels, order: [...item.order], hidden: [...item.hidden],
        ...(item.version === 3 ? { workspaceTabsPosition: item.workspaceTabsPosition as WorkspaceTabsPosition } : {}) };
}

/** Project old mixed navigation into global chrome without writing on load or promoting host plugins. */
export function migrateWorkspaceNavigation(current: WorkspaceNavigation): WorkspaceNavigation {
    if (current.version === 3) return current;
    const order = current.order.filter(id => NAVIGATION_IDS.some(global => global === id));
    for (const id of NAVIGATION_IDS) if (!order.includes(id)) order.push(id);
    return { ...current, version: 3, position: current.position === 'right' ? 'right' : 'left',
        order, hidden: current.hidden.filter(id => order.includes(id) && id !== 'settings' && id !== 'profile'), workspaceTabsPosition: 'default' };
}

/** Append new registrations without persisting or erasing temporarily unavailable entries. */
export function navigationOrder(current: WorkspaceNavigation, available: readonly NavigationId[] = []): readonly NavigationId[] {
    const order = [...current.order];
    for (const id of available) {
        if (order.length === MAX_NAVIGATION_ITEMS) break;
        if (isNavigationId(id) && !order.includes(id)) order.push(id);
    }
    return order;
}

export type NavigationChange =
    | { type: 'visible'; value: boolean }
    | { type: 'position'; value: NavigationPosition }
    | { type: 'workspace-tabs'; value: WorkspaceTabsPosition }
    | { type: 'labels'; value: boolean }
    | { type: 'hidden'; id: NavigationId; value: boolean }
    | { type: 'move'; id: NavigationId; targetId: NavigationId }
    | { type: 'restore'; value: WorkspaceNavigation; expected: WorkspaceNavigation }
    | { type: 'reset' };

/** Pointer and keyboard actions share this bounded, resource-independent reducer. */
export function changeWorkspaceNavigation(current: WorkspaceNavigation, action: NavigationChange, available: readonly NavigationId[] = NAVIGATION_IDS): WorkspaceNavigation {
    const original = current;
    current = migrateWorkspaceNavigation(current);
    let next: WorkspaceNavigation;
    const order = navigationOrder(current, available);
    const itemBase = { ...current, order };
    switch (action.type) {
        case 'visible': next = { ...current, visible: action.value }; break;
        case 'position': next = { ...current, position: action.value }; break;
        case 'workspace-tabs': next = { ...current, workspaceTabsPosition: action.value,
            ...(action.value !== 'default' ? { visible: true, hidden: current.hidden.filter(id => id !== 'workspace') } : {}) }; break;
        case 'labels': next = { ...current, showLabels: action.value }; break;
        case 'hidden':
            if (!isNavigationId(action.id) || !order.includes(action.id)) throw new Error('Unknown navigation item.');
            if (action.id === 'settings' || action.id === 'profile') throw new Error('Settings and Profile remain available.');
            next = { ...itemBase, hidden: order.filter(id => id === action.id ? action.value : current.hidden.includes(id)) };
            break;
        case 'move':
            if ([action.id, action.targetId].some(id => id === 'settings' || id === 'profile')) return original;
            if (!order.includes(action.id) || !order.includes(action.targetId) || action.id === action.targetId) return current;
            next = { ...itemBase, order: reorderItemsById(order.map(id => ({ id })), action.id, action.targetId).map(item => item.id) }; break;
        case 'reset': next = { ...DEFAULT_WORKSPACE_NAVIGATION, workspaceTabsPosition: current.workspaceTabsPosition }; break;
        case 'restore':
            if (JSON.stringify(original) !== JSON.stringify(parseWorkspaceNavigation(action.expected))) {
                throw new Error('Navigation changed after the layout preview. Refresh the preview before applying it.');
            }
            next = action.value; break;
        default: throw new Error('Unknown navigation action.');
    }
    const valid = parseWorkspaceNavigation(next);
    if (!valid) throw new Error('Invalid navigation preferences.');
    return JSON.stringify(valid) === JSON.stringify(current) ? current : valid;
}

/** Missing settings inherit defaults; unsupported raw settings retain a hidden read-only fallback. */
export function resolveWorkspaceNavigation(value: unknown): WorkspaceNavigation {
    const parsed = parseWorkspaceNavigation(value);
    return parsed ? migrateWorkspaceNavigation(parsed) : READ_ONLY_WORKSPACE_NAVIGATION;
}
