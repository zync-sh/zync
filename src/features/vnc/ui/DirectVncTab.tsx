import type { WorkspaceActions } from '../../../components/workspace/workspaceActionsContext';
import { useAppStore } from '../../../store/useAppStore';
import { VncPane } from './VncPane';

/** Resolve the saved endpoint at the point of use. Endpoint edits retire the old viewer. */
export function DirectVncTab({
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
            key={JSON.stringify([profile.host, profile.port])}
            contentKey={tabId}
            direct={profile}
            visible={active}
            focused={active}
            registerMenuItems={registerMenuItems}
        />
    );
}
