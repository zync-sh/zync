import type { PaneContent } from '../../../lib/paneLayout';
import type { AppStore } from '../../../store/useAppStore';

/** Resolve Files store owners; legacy instance-less panes share the base listing. */
function filesInstances(contents: Iterable<PaneContent>): Set<string | undefined> {
    const instances = new Set<string | undefined>();
    for (const content of contents) {
        if (content.kind === 'feature' && content.featureId === 'files') {
            instances.add(content.instanceId?.trim() || undefined);
        }
    }
    return instances;
}

/** Dispose removed content resources only after their last inventory owner closes. */
export function disposeWorkspaceContent(
    state: Pick<AppStore, 'disposeFilesInstance'>,
    connectionId: string,
    removed: Iterable<PaneContent>,
    remaining: Iterable<PaneContent>,
): void {
    const retained = filesInstances(remaining);
    for (const instanceId of filesInstances(removed)) {
        if (!retained.has(instanceId)) {
            state.disposeFilesInstance(connectionId, instanceId);
        }
    }
}
