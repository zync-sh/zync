import type { AppSettings } from '../../../../store/settingsSlice';
import { Section } from '../../common/Section';
import { SettingsGroup } from '../../common/SettingsGroup';
import { Toggle } from '../../common/Toggle';

export interface AppearanceInterfaceSectionProps {
    compactMode: AppSettings['compactMode'];
    onCompactModeChange: (enabled: boolean) => void;
}

export function AppearanceInterfaceSection({
    compactMode,
    onCompactModeChange,
}: AppearanceInterfaceSectionProps) {
    return (
        <Section title="Interface">
            <SettingsGroup>
                <Toggle
                    label="Compact Mode"
                    description="Reduce spacing for denser UI."
                    checked={compactMode}
                    onChange={onCompactModeChange}
                />
            </SettingsGroup>
        </Section>
    );
}
