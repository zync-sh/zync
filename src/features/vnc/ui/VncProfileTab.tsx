import type { WorkspaceActions } from '../../../components/workspace/workspaceActionsContext';
import { useAppStore } from '../../../store/useAppStore';
import { vncDestinationKey } from '../domain/profile';
import { VncPane } from './VncPane';

/** Resolve the saved endpoint at the point of use. Endpoint edits retire the old viewer. */
export function VncProfileTab({
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
        state.settings.vncProfiles?.find(({ id }) => id === profileId),
    );
    if (!profile) {
        return (
            <p
                role="status"
                className="p-3 text-sm text-app-muted"
            >
                This VNC profile is unavailable.
            </p>
        );
    }
    return (
        <VncPane
            key={vncDestinationKey(profile)}
            contentKey={tabId}
            profile={profile}
            visible={active}
            focused={active}
            registerMenuItems={registerMenuItems}
        />
    );
}
