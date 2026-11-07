import { useMemo } from 'react';

import type { ContextMenuItem } from '../../../components/ui/ContextMenu';
import type { ContentMenuItems } from '../../../components/workspace/WorkspaceContextActions';
import { useAppStore } from '../../../store/useAppStore';
import type { Tab } from '../../connections/domain/types';
import { openVncProfileEditor } from './VncProfileManager';

/** Keep profile settings available from the tab even before its viewer is mounted. */
export function useVncProfileTabMenuItems(
    tabs: readonly Tab[],
    contentItems?: ContentMenuItems,
): ContentMenuItems | undefined {
    const profiles = useAppStore((state) => state.settings.vncProfiles);
    return useMemo(() => {
        const profileIds = new Set(profiles.map(({ id }) => id));
        let items: Map<string, readonly ContextMenuItem[]> | undefined;
        for (const tab of tabs) {
            const profileId = tab.vncProfileId;
            if (tab.type !== 'vnc' || !profileId || !profileIds.has(profileId)) {
                continue;
            }
            items ??= new Map(contentItems);
            items.set(tab.id, [
                {
                    label: 'Display settings…',
                    action: () => {
                        const profile = useAppStore
                            .getState()
                            .settings.vncProfiles.find(({ id }) => id === profileId);
                        if (profile) {
                            openVncProfileEditor(profile, { focusDisplay: true });
                        }
                    },
                },
                ...(contentItems?.get(tab.id) ?? []),
            ]);
        }
        return items ?? contentItems;
    }, [contentItems, profiles, tabs]);
}
