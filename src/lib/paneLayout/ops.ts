import { createPaneId } from './ids';
import {
    activeTermId,
    collectLeaves,
    findLeafByTerm,
    findNode,
    findParentSplit,
    firstLeaf,
    firstTermLeaf,
    isFeatureContent,
    isPaneLeaf,
    isPluginContent,
    isPaneSplit,
    isTermContent,
    leafCount,
} from './query';
import { splitFromDockEdge } from './dock';
import { incomingIndexForInsert, markSplitIntro } from './intro';
import {
    MAX_VISIBLE_PANES,
    MIN_PANE_RATIO,
    PANE_LAYOUT_VERSION,
    featurePaneContent,
    isSplitFeatureId,
    pluginPaneContent,
    termPaneContent,
    type DockEdge,
    type PaneContent,
    type PaneLayout,
    type PaneLeaf,
    type PaneNode,
    type SplitDirection,
    type SplitFailReason,
    type SplitFeatureId,
    type SplitInsert,
} from './types';

export function singlePane(termId: string, paneId = createPaneId()): PaneLayout {
    return {
        version: PANE_LAYOUT_VERSION,
        root: { type: 'pane', id: paneId, content: termPaneContent(termId) },
        activePaneId: paneId,
    };
}

export function singleFeaturePane(featureId: SplitFeatureId, paneId = createPaneId(), instanceId?: string): PaneLayout {
    return {
        version: PANE_LAYOUT_VERSION,
        root: { type: 'pane', id: paneId, content: featurePaneContent(featureId, instanceId) },
        activePaneId: paneId,
    };
}

export function singlePluginPane(pluginId: string, paneId = createPaneId(), instanceId?: string): PaneLayout {
    return {
        version: PANE_LAYOUT_VERSION,
        root: { type: 'pane', id: paneId, content: pluginPaneContent(pluginId, instanceId) },
        activePaneId: paneId,
    };
}

export function canSplit(layout: PaneLayout | null | undefined, cap = MAX_VISIBLE_PANES): boolean {
    if (!layout) return true;
    return leafCount(layout.root) < cap;
}

function mapNode(node: PaneNode, id: string, replace: (current: PaneNode) => PaneNode): PaneNode {
    if (node.id === id) return replace(node);
    if (isPaneLeaf(node)) return node;
    return {
        ...node,
        children: [
            mapNode(node.children[0], id, replace),
            mapNode(node.children[1], id, replace),
        ],
    };
}

export function normalizeSizes(sizes: [number, number]): [number, number] {
    const a = Number.isFinite(sizes[0]) ? sizes[0] : 1;
    const b = Number.isFinite(sizes[1]) ? sizes[1] : 1;
    const sum = a + b;
    if (sum <= 0) return [0.5, 0.5];
    let left = a / sum;
    left = Math.min(1 - MIN_PANE_RATIO, Math.max(MIN_PANE_RATIO, left));
    return [left, 1 - left];
}

export function splitPane(
    layout: PaneLayout,
    paneId: string,
    direction: SplitDirection,
    content: PaneContent,
    cap = MAX_VISIBLE_PANES,
    insert: SplitInsert = 'after',
): { ok: true; layout: PaneLayout; newPaneId: string } | { ok: false; reason: SplitFailReason } {
    if (leafCount(layout.root) >= cap) {
        return { ok: false, reason: 'cap' };
    }
    const target = findNode(layout.root, paneId);
    if (!target) return { ok: false, reason: 'missing-pane' };
    if (!isPaneLeaf(target)) return { ok: false, reason: 'not-leaf' };

    const newLeaf: PaneNode = { type: 'pane', id: createPaneId(), content };
    const splitId = createPaneId();
    const root = mapNode(layout.root, paneId, (current) => ({
        type: 'split',
        id: splitId,
        direction,
        sizes: [0.5, 0.5],
        children: insert === 'before' ? [newLeaf, current] : [current, newLeaf],
    }));
    markSplitIntro(splitId, incomingIndexForInsert(insert));

    return { ok: true, layout: { ...layout, root }, newPaneId: newLeaf.id };
}

export function unsplitPane(layout: PaneLayout, paneId: string): PaneLayout {
    const parent = findParentSplit(layout.root, paneId);
    if (!parent) {
        return layout;
    }
    const sibling = parent.children[0].id === paneId ? parent.children[1] : parent.children[0];
    const root = parent.id === layout.root.id
        ? sibling
        : mapNode(layout.root, parent.id, () => sibling);

    const focused = findNode(root, layout.activePaneId)
        ? layout.activePaneId
        : firstLeaf(sibling).id;
    return { ...layout, root, activePaneId: focused };
}

export function focusPane(layout: PaneLayout, paneId: string): PaneLayout {
    if (!findNode(layout.root, paneId)) return layout;
    return { ...layout, activePaneId: paneId };
}

export function selectTerm(layout: PaneLayout, termId: string): PaneLayout {
    const existing = findLeafByTerm(layout.root, termId);
    if (existing) {
        return focusPane(layout, existing.id);
    }
    const focused = findNode(layout.root, layout.activePaneId);
    const termTarget = focused && isPaneLeaf(focused) && isTermContent(focused.content)
        ? focused
        : firstTermLeaf(layout.root);
    if (!termTarget) return layout;
    const root = mapNode(layout.root, termTarget.id, (current) => {
        if (!isPaneLeaf(current) || !isTermContent(current.content)) return current;
        return { ...current, content: termPaneContent(termId) };
    });
    return { ...layout, root, activePaneId: termTarget.id };
}

export function setSplitSizes(layout: PaneLayout, splitId: string, sizes: [number, number]): PaneLayout {
    const next = normalizeSizes(sizes);
    const root = mapNode(layout.root, splitId, (current) => {
        if (!isPaneSplit(current)) return current;
        return { ...current, sizes: next };
    });
    return { ...layout, root };
}

function dropLeaves(layout: PaneLayout, match: (leaf: PaneLeaf) => boolean): PaneLayout | null {
    const leaves = collectLeaves(layout.root).filter(match);
    if (leaves.length === 0) return layout;
    let next: PaneLayout = layout;
    for (const leaf of leaves) {
        if (isPaneLeaf(next.root) && next.root.id === leaf.id) {
            return null;
        }
        const after = unsplitPane(next, leaf.id);
        if (after === next) return null;
        next = after;
    }
    return next;
}

export function dropTerm(layout: PaneLayout, termId: string): PaneLayout | null {
    return dropLeaves(
        layout,
        (leaf) => isTermContent(leaf.content) && leaf.content.termId === termId,
    );
}

export function dropFeature(layout: PaneLayout, featureId: SplitFeatureId): PaneLayout | null {
    return dropLeaves(
        layout,
        (leaf) => isFeatureContent(leaf.content) && leaf.content.featureId === featureId,
    );
}

export function dropPlugin(layout: PaneLayout, pluginId: string): PaneLayout | null {
    return dropLeaves(
        layout,
        (leaf) => isPluginContent(leaf.content) && leaf.content.pluginId === pluginId,
    );
}

export function dockIntoLayout(
    layout: PaneLayout,
    content: PaneContent,
    edge: DockEdge,
    cap = MAX_VISIBLE_PANES,
    targetPaneId?: string,
): { ok: true; layout: PaneLayout; paneId: string; created: boolean } | { ok: false; reason: SplitFailReason } {
    if (content.kind === 'term') {
        const existing = findLeafByTerm(layout.root, content.termId);
        if (existing) {
            return { ok: true, layout: focusPane(layout, existing.id), paneId: existing.id, created: false };
        }
    }
    if (content.kind === 'feature' && content.instanceId) {
        const existing = collectLeaves(layout.root).find((leaf) => (
            isFeatureContent(leaf.content)
            && leaf.content.featureId === content.featureId
            && leaf.content.instanceId === content.instanceId
        ));
        if (existing) {
            return { ok: true, layout: focusPane(layout, existing.id), paneId: existing.id, created: false };
        }
    }

    const hinted = targetPaneId ? findNode(layout.root, targetPaneId) : null;
    const focused = findNode(layout.root, layout.activePaneId);
    const target = hinted && isPaneLeaf(hinted) ? hinted : (focused && isPaneLeaf(focused) ? focused : firstLeaf(layout.root));
    const { direction, insert } = splitFromDockEdge(edge);
    const result = splitPane(layout, target.id, direction, content, cap, insert);
    if (!result.ok) return result;
    return {
        ok: true,
        layout: focusPane(result.layout, result.newPaneId),
        paneId: result.newPaneId,
        created: true,
    };
}

export function openFeatureInLayout(
    layout: PaneLayout,
    featureId: SplitFeatureId,
    direction: SplitDirection = 'horizontal',
    cap = MAX_VISIBLE_PANES,
): { ok: true; layout: PaneLayout; paneId: string; created: boolean } | { ok: false; reason: SplitFailReason } {
    const edge: DockEdge = direction === 'vertical' ? 'bottom' : 'right';
    return dockIntoLayout(layout, { kind: 'feature', featureId }, edge, cap);
}

export function sanitizePaneLayout(layout: PaneLayout, knownTermIds: ReadonlySet<string>): PaneLayout | null {
    const prune = (node: PaneNode): PaneNode | null => {
        if (isPaneLeaf(node)) {
            if (isTermContent(node.content)) {
                return knownTermIds.has(node.content.termId) ? node : null;
            }
            if (isFeatureContent(node.content) && isSplitFeatureId(node.content.featureId)) {
                return node;
            }
            if (isPluginContent(node.content) && node.content.pluginId) {
                return node;
            }
            return null;
        }
        const left = prune(node.children[0]);
        const right = prune(node.children[1]);
        if (left && right) {
            return { ...node, children: [left, right] };
        }
        return left ?? right;
    };

    const root = prune(layout.root);
    if (!root) return null;
    const focused = findNode(root, layout.activePaneId);
    const active = focused && isPaneLeaf(focused) ? layout.activePaneId : firstLeaf(root).id;
    return { version: PANE_LAYOUT_VERSION, root, activePaneId: active };
}

export function layoutActiveTermId(layout: PaneLayout | null | undefined): string | null {
    return activeTermId(layout);
}
