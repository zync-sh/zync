import { Cable, Plus } from 'lucide-react';

import { ProfileConnectionItem } from '../../../components/layout/sidebar/ProfileConnectionItem';
import {
    SidebarSection,
    type SidebarSectionCreateItem,
} from '../../../components/layout/sidebar/SidebarSection';
import { useAppStore } from '../../../store/useAppStore';
import { confirmDeleteSerialProfile, openSerialProfileEditor } from './SerialProfileManager';

const createMenu: SidebarSectionCreateItem[] = [
    {
        id: 'new-serial-profile',
        label: 'Add Serial profile',
        icon: (
            <Plus
                size={14}
                aria-hidden
            />
        ),
        /** Keep the current connection selected until the user opens a saved profile. */
        onSelect: () => openSerialProfileEditor(),
    },
];

/** Show saved serial devices only when this device has at least one profile. */
export function SerialProfileSection({ compactMode }: { compactMode: boolean }) {
    const profiles = useAppStore((state) => state.settings.serialProfiles);
    const openProfile = useAppStore((state) => state.openSerialTab);
    const activeProfileId = useAppStore((state) => {
        const tab = state.tabs.find((item) => item.id === state.activeTabId);
        return tab?.type === 'serial' ? tab.serialProfileId : undefined;
    });

    if (profiles.length === 0) {
        return null;
    }

    return (
        <SidebarSection
            title="Serial profiles"
            variant="action"
            defaultExpanded={false}
            compactMode={compactMode}
            count={profiles.length}
            icon={
                <Cable
                    size={13}
                    aria-hidden
                />
            }
            createMenu={createMenu}
        >
            <ul
                aria-label="Saved Serial profiles"
                className="max-h-[min(26vh,12rem)] space-y-0.5 overflow-y-auto px-2"
            >
                {profiles.map((profile) => (
                    <li key={profile.id}>
                        <ProfileConnectionItem
                            kindLabel="Serial"
                            name={profile.name}
                            secondary={`${profile.portId} · ${profile.settings.baudRate}`}
                            icon={<Cable size={16} />}
                            compactMode={compactMode}
                            active={activeProfileId === profile.id}
                            onOpen={() => openProfile(profile.id)}
                            onEdit={() => openSerialProfileEditor(profile)}
                            onDelete={() => confirmDeleteSerialProfile(profile)}
                        />
                    </li>
                ))}
            </ul>
        </SidebarSection>
    );
}
