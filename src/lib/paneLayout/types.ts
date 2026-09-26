/** `vertical` = stacked (column). `horizontal` = side by side (row). */

export const PANE_LAYOUT_VERSION = 1 as const;
export const MAX_VISIBLE_PANES = 4;
/** Restore/parse budget so a corrupt session file cannot nest forever. */
export const MAX_PANE_NESTING = 8;
export const MIN_PANE_RATIO = 0.2;

/** Host feature tabs that may occupy a split leaf. Plugins use `PluginPaneContent`. */
export const SPLIT_FEATURE_IDS = ['files', 'port-forwarding', 'dashboard', 'snippets'] as const;
export type SplitFeatureId = (typeof SPLIT_FEATURE_IDS)[number];

const SPLIT_FEATURE_ID_SET: ReadonlySet<string> = new Set(SPLIT_FEATURE_IDS);

export type SplitDirection = 'horizontal' | 'vertical';

export type TermPaneContent = {
    kind: 'term';
    termId: string;
};

export type FeaturePaneContent = {
    kind: 'feature';
    featureId: SplitFeatureId;
    /** Stable identity for this feature instance. Files also uses it as its listing key. */
    instanceId?: string;
};

export type PluginPaneContent = {
    kind: 'plugin';
    pluginId: string;
    /** Host-generated identity for one mounted pane; older sessions may omit it. */
    instanceId?: string;
};

export type PaneContent = TermPaneContent | FeaturePaneContent | PluginPaneContent;

export type PaneLeaf = {
    type: 'pane';
    id: string;
    content: PaneContent;
};

export type PaneSplit = {
    type: 'split';
    id: string;
    direction: SplitDirection;
    sizes: [number, number];
    children: [PaneNode, PaneNode];
};

export type PaneNode = PaneLeaf | PaneSplit;

export type PaneLayout = {
    version: typeof PANE_LAYOUT_VERSION;
    root: PaneNode;
    activePaneId: string;
};

export type SplitFailReason = 'cap' | 'missing-pane' | 'not-leaf';
export type SplitInsert = 'before' | 'after';
export type DockEdge = 'left' | 'right' | 'top' | 'bottom';

export type DockPayload =
    | { kind: 'term'; termId: string; sourcePaneId?: string }
    | { kind: 'feature'; featureId: SplitFeatureId; instanceId?: string; sourcePaneId?: string }
    | { kind: 'plugin'; pluginId: string; instanceId?: string; sourcePaneId?: string };

export type DockResult = 'opened' | 'focused' | 'moved' | 'refused-cap' | 'no-target' | 'self';

export type OpenSplitFeatureResult = DockResult;

export function isSplitFeatureId(value: unknown): value is SplitFeatureId {
    return typeof value === 'string' && SPLIT_FEATURE_ID_SET.has(value);
}

export function termPaneContent(termId: string): TermPaneContent {
    return { kind: 'term', termId };
}

export function featurePaneContent(featureId: SplitFeatureId, instanceId?: string): FeaturePaneContent {
    return instanceId
        ? { kind: 'feature', featureId, instanceId }
        : { kind: 'feature', featureId };
}

export function newFeatureInstanceId(featureId: SplitFeatureId): string {
    return `${featureId}-${crypto.randomUUID()}`;
}

export function newFilesInstanceId(): string {
    return newFeatureInstanceId('files');
}

export function newPluginInstanceId(): string {
    return `plugin-${crypto.randomUUID()}`;
}

export function pluginPaneContent(pluginId: string, instanceId = newPluginInstanceId()): PluginPaneContent {
    return { kind: 'plugin', pluginId, instanceId };
}

/** Preserve the exact pane identity when its header or Split tab starts a dock drag. */
export function paneDockPayload(pane: PaneLeaf): DockPayload {
    const { content } = pane;
    if (content.kind === 'term') {
        return { kind: 'term', termId: content.termId, sourcePaneId: pane.id };
    }
    if (content.kind === 'feature') {
        return {
            kind: 'feature',
            featureId: content.featureId,
            instanceId: content.instanceId,
            sourcePaneId: pane.id,
        };
    }
    return {
        kind: 'plugin',
        pluginId: content.pluginId,
        instanceId: content.instanceId,
        sourcePaneId: pane.id,
    };
}
