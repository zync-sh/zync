import { useMemo } from 'react';

import type { ContextMenuItem } from '../../../components/ui/ContextMenu';
import type { ContentMenuItems } from '../../../components/workspace/WorkspaceContextActions';
import { useAppStore } from '../../../store/useAppStore';
import type { Tab } from '../../connections/domain/types';
import { openSerialProfileEditor } from './SerialProfileManager';

/** Keep saved device settings available before a standalone serial tab has mounted. */
export function useSerialProfileTabMenuItems(
    tabs: readonly Tab[],
    contentItems?: ContentMenuItems,
): ContentMenuItems | undefined {
    const profiles = useAppStore((state) => state.settings.serialProfiles);
    return useMemo(() => {
        const profileIds = new Set(profiles.map(({ id }) => id));
        let items: Map<string, readonly ContextMenuItem[]> | undefined;
        for (const tab of tabs) {
            const profileId = tab.serialProfileId;
            if (tab.type !== 'serial' || !profileId || !profileIds.has(profileId)) {
                continue;
            }
            items ??= new Map(contentItems);
            items.set(tab.id, [
                {
                    label: 'Serial settings…',
                    /** Re-read saved metadata before creating an editor draft from an open menu. */
                    action: () => {
                        const profile = useAppStore
                            .getState()
                            .settings.serialProfiles.find(({ id }) => id === profileId);
                        if (profile) {
                            openSerialProfileEditor(profile);
                        }
                    },
                },
                ...(contentItems?.get(tab.id) ?? []),
            ]);
        }
        return items ?? contentItems;
    }, [contentItems, profiles, tabs]);
}
