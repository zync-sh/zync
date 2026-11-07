import { Monitor, Plus } from 'lucide-react';

import { ProfileConnectionItem } from '../../../components/layout/sidebar/ProfileConnectionItem';
import {
    SidebarSection,
    type SidebarSectionCreateItem,
} from '../../../components/layout/sidebar/SidebarSection';
import { useAppStore } from '../../../store/useAppStore';
import { formatVncEndpoint } from '../domain/profile';
import { confirmDeleteVncProfile, openVncProfileEditor } from './VncProfileManager';

const createMenu: SidebarSectionCreateItem[] = [
    {
        id: 'new-vnc-profile',
        label: 'Add VNC profile',
        icon: (
            <Plus
                size={14}
                aria-hidden
            />
        ),
        /** Start a new profile without changing the selected SSH workspace. */
        onSelect: () => openVncProfileEditor(),
    },
];

/** Show saved direct desktops only when this device has at least one profile. */
export function VncProfileSection({ compactMode }: { compactMode: boolean }) {
    const profiles = useAppStore((state) => state.settings.vncProfiles);
    const showAddresses = useAppStore((state) => state.settings.privacy.showHostAddressesInLists);
    const openProfile = useAppStore((state) => state.openVncTab);
    const activeProfileId = useAppStore((state) => {
        const tab = state.tabs.find((item) => item.id === state.activeTabId);
        return tab?.type === 'vnc' ? tab.vncProfileId : undefined;
    });

    if (profiles.length === 0) {
        return null;
    }

    return (
        <SidebarSection
            title="VNC profiles"
            variant="action"
            defaultExpanded={false}
            compactMode={compactMode}
            count={profiles.length}
            icon={
                <Monitor
                    size={13}
                    aria-hidden
                />
            }
            createMenu={createMenu}
        >
            <ul
                aria-label="Saved VNC profiles"
                className="max-h-[min(26vh,12rem)] space-y-0.5 overflow-y-auto px-2"
            >
                {profiles.map((profile) => (
                    <li key={profile.id}>
                        <ProfileConnectionItem
                            kindLabel="VNC"
                            name={profile.name}
                            secondary={showAddresses ? formatVncEndpoint(profile) : undefined}
                            icon={<Monitor size={16} />}
                            compactMode={compactMode}
                            active={activeProfileId === profile.id}
                            onOpen={() => openProfile(profile.id)}
                            onEdit={() => openVncProfileEditor(profile)}
                            onDelete={() => confirmDeleteVncProfile(profile)}
                        />
                    </li>
                ))}
            </ul>
        </SidebarSection>
    );
}
