import { FEATURE_META, type FeatureId } from '../featureMeta';
import type { ShellEntry } from '../../../lib/shells/types';
import type { WorkspaceOpenFeatureState, WorkspaceOpenItem, WorkspaceOpenPluginState } from './types';

export const WORKSPACE_OPEN_GROUP_ORDER: WorkspaceOpenItem['group'][] = [
    'create',
    'shells',
    'open',
];

export const WORKSPACE_OPEN_GROUP_LABEL: Record<WorkspaceOpenItem['group'], string> = {
    create: 'Create',
    shells: 'Shells',
    open: 'Open',
};

const FEATURE_ORDER: FeatureId[] = [
    'files',
    'port-forwarding',
    'dashboard',
    'snippets',
];

function uniqueKeywords(...parts: Array<string | undefined>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const part of parts) {
        const token = part?.trim().toLowerCase();
        if (!token || seen.has(token)) continue;
        seen.add(token);
        out.push(token);
    }
    return out;
}

export function buildWorkspaceOpenItems(input: {
    shells: readonly ShellEntry[];
    canOpenFeature: boolean;
    features?: readonly WorkspaceOpenFeatureState[];
    plugins?: readonly WorkspaceOpenPluginState[];
}): WorkspaceOpenItem[] {
    const items: WorkspaceOpenItem[] = [
        {
            id: 'create:new-shell',
            group: 'create',
            kind: 'new-shell',
            label: 'New Shell',
            keywords: uniqueKeywords('new shell', 'terminal', 'tab'),
        },
    ];

    if (input.shells.length > 0) {
        items.push({
            id: 'create:other-shells',
            group: 'create',
            kind: 'other-shells',
            label: 'Other shells',
            keywords: uniqueKeywords('other shells', 'shells', 'shell'),
            hint: String(input.shells.length),
        });
    }

    for (const shell of input.shells) {
        items.push({
            id: `shell:${shell.id}`,
            group: 'shells',
            kind: 'shell',
            label: shell.label,
            keywords: uniqueKeywords(shell.label, shell.id, 'shell', 'other shells'),
            shell,
        });
    }

    if (!input.canOpenFeature) return items;

    const stateById = new Map((input.features ?? []).map((feature) => [feature.id, feature]));
    for (const featureId of FEATURE_ORDER) {
        const meta = FEATURE_META[featureId];
        if (!meta) continue;
        const state = stateById.get(featureId);
        items.push({
            id: `feature:${featureId}`,
            group: 'open',
            kind: 'feature',
            label: meta.label,
            keywords: uniqueKeywords(meta.label, featureId, 'open'),
            featureId,
            hint: state?.isOpen ? 'New tab' : undefined,
        });
    }

    for (const plugin of input.plugins ?? []) {
        items.push({
            id: `plugin:${plugin.id}`,
            group: 'open',
            kind: 'plugin',
            label: plugin.title,
            keywords: uniqueKeywords(plugin.title, plugin.id, 'plugin', 'pane', 'open'),
            pluginId: plugin.id,
            hint: plugin.isOpen ? 'Open' : undefined,
        });
    }

    return items;
}
