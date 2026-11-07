import { useRef } from 'react';

import type { WorkspaceActions } from '../../../components/workspace/workspaceActionsContext';
import { useAppStore } from '../../../store/useAppStore';
import { SerialTerminalPane } from './SerialTerminalPane';

/** Hardware edits retire their old session; profile naming and Enter behavior update in place. */
export function DirectSerialTab({
    tabId,
    profileId,
    active,
    registerMenuItems,
}: {
    tabId: string;
    profileId?: string;
    active: boolean;
    registerMenuItems: WorkspaceActions['registerContentMenuItems'];
}) {
    const profile = useAppStore((state) =>
        state.settings.serialProfiles.find(({ id }) => id === profileId),
    );
    const releaseBarrier = useRef<Promise<void> | undefined>(undefined);
    if (!profile) {
        return (
            <p
                role="status"
                className="p-3 text-sm text-app-muted"
            >
                This Serial profile is unavailable.
            </p>
        );
    }
    return (
        <SerialTerminalPane
            key={JSON.stringify([
                profile.portId,
                profile.settings.baudRate,
                profile.settings.dataBits,
                profile.settings.parity,
                profile.settings.stopBits,
                profile.settings.flowControl,
            ])}
            profile={profile}
            contentKey={tabId}
            visible={active}
            focused={active}
            registerMenuItems={registerMenuItems}
            releaseBarrier={releaseBarrier}
        />
    );
}
