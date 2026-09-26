import {
    collectLeaves,
    isFeatureContent,
    isSplitFeatureId,
    type PaneLayout,
    type PaneLayoutGroups,
    type SplitFeatureId,
} from '../../lib/paneLayout';
import type { WorkspaceFeatureTab } from './featureMeta';

/** Installed pane definitions survive worker reloads; runtime HTML never enters this inventory. */
export function stablePluginPanelInventory(
    active: readonly { id: string; title: string }[],
    installed: readonly { manifest: { id: string; contributes?: { paneKinds?: readonly { id: string; title: string }[] } } }[],
): { id: string; title: string }[] {
    const panels = new Map(active.map(panel => [panel.id, { id: panel.id, title: panel.title }]));
    for (const plugin of installed) {
        for (const pane of plugin.manifest.contributes?.paneKinds ?? []) {
            const id = `${plugin.manifest.id}:${pane.id}`;
            if (!panels.has(id)) panels.set(id, { id, title: pane.title });
        }
    }
    return [...panels.values()];
}

/** Pinned and restored active plugins must not depend on a mount-local open list. */
export function pluginTabInventory(openFeatures: string[], pinnedFeatures: string[], activeView: string): string[] {
    return [...new Set([...openFeatures, ...pinnedFeatures, activeView])]
        .filter(view => view.startsWith('plugin:') && view.length > 'plugin:'.length);
}

/** Feature panes already stored for a host. One tab per instance id. */
export function featureTabsFromPaneGroups(
    groups: PaneLayoutGroups | null | undefined,
): WorkspaceFeatureTab[] {
    const tabs: WorkspaceFeatureTab[] = [];
    const seen = new Set<string>();
    for (const layout of Object.values(groups ?? {})) {
        for (const leaf of collectLeaves(layout.root)) {
            if (!isFeatureContent(leaf.content) || !leaf.content.instanceId) continue;
            if (!isSplitFeatureId(leaf.content.featureId)) continue;
            if (seen.has(leaf.content.instanceId)) continue;
            seen.add(leaf.content.instanceId);
            tabs.push({
                id: leaf.content.instanceId,
                featureId: leaf.content.featureId,
                instanceId: leaf.content.instanceId,
            });
        }
    }
    return tabs;
}

/** Append instance tabs that are not already in the inventory. */
export function mergeFeatureTabs(
    existing: readonly WorkspaceFeatureTab[],
    incoming: readonly WorkspaceFeatureTab[],
): WorkspaceFeatureTab[] {
    if (incoming.length === 0) return existing as WorkspaceFeatureTab[];
    const seen = new Set(existing.map(item => item.id));
    const additions = incoming.filter(item => !seen.has(item.id));
    return additions.length > 0 ? [...existing, ...additions] : existing as WorkspaceFeatureTab[];
}

function layoutHasFeatureInstance(layout: PaneLayout, instanceId: string): boolean {
    return collectLeaves(layout.root).some(leaf => (
        isFeatureContent(leaf.content) && leaf.content.instanceId === instanceId
    ));
}

/**
 * The tab inside the active pane group, otherwise the latest tab of that feature.
 * `activeOwner` is the group key (a shell id, a feature instance, or "workspace"),
 * not the feature instance id nested inside that group.
 */
export function preferredFeatureTabId(
    tabs: readonly WorkspaceFeatureTab[],
    featureId: SplitFeatureId,
    groups: PaneLayoutGroups | null | undefined,
    activeOwner: string | null | undefined,
): string | null {
    const matching = tabs.filter(tab => tab.featureId === featureId);
    const activeLayout = activeOwner ? groups?.[activeOwner] : undefined;
    const owned = activeLayout
        ? matching.find(tab => layoutHasFeatureInstance(activeLayout, tab.instanceId))
        : undefined;
    return owned?.id ?? matching[matching.length - 1]?.id ?? null;
}

/**
 * Inventory for a host screen that just mounted.
 * Reuse panes that survived the switch. Create a tab only when this view has none.
 */
export function initialFeatureTabsForView(
    view: string | undefined,
    groups: PaneLayoutGroups | null | undefined,
    activeOwner: string | null | undefined,
    createTab: (featureId: SplitFeatureId) => WorkspaceFeatureTab,
): { tabs: WorkspaceFeatureTab[]; activeId: string | null } {
    const restored = featureTabsFromPaneGroups(groups);
    if (!isSplitFeatureId(view)) {
        return { tabs: restored, activeId: null };
    }
    const activeId = preferredFeatureTabId(restored, view, groups, activeOwner);
    if (activeId) {
        return { tabs: restored, activeId };
    }
    const created = createTab(view);
    return { tabs: [...restored, created], activeId: created.id };
}
