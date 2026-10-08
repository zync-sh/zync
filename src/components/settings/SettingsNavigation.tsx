import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Code, FileText, Info, Keyboard, MessageSquare, Monitor, Package, PanelBottom, Settings, Sparkles, Type } from 'lucide-react';
import { TabButton } from './common/TabButton.js';

export const SETTINGS_SECTIONS = [
    { key: 'general', label: 'General', icon: Settings },
    { key: 'terminal', label: 'Terminal', icon: Type },
    { key: 'appearance', label: 'Appearance', icon: Monitor },
    { key: 'statusBar', label: 'Status Bar', icon: PanelBottom },
    { key: 'fileManager', label: 'File Manager', icon: FileText },
    { key: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
    { key: 'plugins', label: 'Plugins', icon: Package },
    { key: 'ai', label: 'AI', icon: Sparkles },
    { key: 'feedback', label: 'Feedback', icon: MessageSquare },
    { key: 'about', label: 'About', icon: Info },
] as const;

export type SettingsSection = typeof SETTINGS_SECTIONS[number]['key'];

/** Resolve vertical navigation without consuming Tab or horizontal control keys. */
export function nextSettingsSection(current: SettingsSection, key: string): SettingsSection | undefined {
    const index = SETTINGS_SECTIONS.findIndex(section => section.key === current);
    if (key === 'Home') return SETTINGS_SECTIONS[0].key;
    if (key === 'End') return SETTINGS_SECTIONS[SETTINGS_SECTIONS.length - 1].key;
    if (key !== 'ArrowDown' && key !== 'ArrowUp') return undefined;
    return SETTINGS_SECTIONS[(index + (key === 'ArrowDown' ? 1 : -1) + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length].key;
}

export const settingsTabId = (prefix: string, section: SettingsSection) => `${prefix}-tab-${section}`;
export const settingsPanelId = (prefix: string) => `${prefix}-panel`;

interface SettingsNavigationProps {
    idPrefix: string;
    activeTab: SettingsSection;
    onTabChange: (section: SettingsSection) => void;
    onOpenJson: () => void;
    aboutBadge?: boolean;
    aboutBadgeLabel?: string;
}

/** Settings-only navigation. Arrows move focus; native Enter/Space activates.
 * Manual activation avoids loading sections while traversing the list. Tab leaves
 * the composite, and re-entry starts at the selected section. No settings writes.
 */
export function SettingsNavigation({ idPrefix, activeTab, onTabChange, onOpenJson, aboutBadge, aboutBadgeLabel }: SettingsNavigationProps) {
    const listRef = useRef<HTMLDivElement>(null);
    const [focusedTab, setFocusedTab] = useState(activeTab);
    useEffect(() => {
        if (!listRef.current?.contains(document.activeElement)) setFocusedTab(activeTab);
    }, [activeTab]);

    const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, section: SettingsSection) => {
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const next = nextSettingsSection(section, event.key);
        if (!next) return;
        event.preventDefault();
        const button = event.currentTarget.ownerDocument.getElementById(settingsTabId(idPrefix, next));
        if (button && listRef.current?.contains(button)) button.focus();
    };

    return <div className="w-[180px] shrink-0 flex flex-col border-r border-app-border/40 bg-app-surface/20 p-2">
        <div className="px-3 py-4 mb-1 text-xs font-bold text-app-muted uppercase tracking-wider opacity-70">Settings</div>
        <div ref={listRef} role="tablist" aria-label="Settings sections" aria-orientation="vertical"
            className="flex flex-1 flex-col gap-0.5"
            onBlur={event => {
                if (!event.currentTarget.contains(event.relatedTarget)) setFocusedTab(activeTab);
            }}>
            {SETTINGS_SECTIONS.map(({ key, label, icon: Icon }) => <div key={key}
                className={key === 'about' ? 'mt-auto pt-2 border-t border-app-border/30' : undefined}>
                <TabButton id={settingsTabId(idPrefix, key)} aria-controls={settingsPanelId(idPrefix)}
                    active={activeTab === key} onClick={() => onTabChange(key)} onFocus={() => setFocusedTab(key)}
                    onKeyDown={event => handleKeyDown(event, key)}
                    tabIndex={focusedTab === key ? 0 : -1} label={label} icon={<Icon size={15} />}
                    badge={key === 'about' && aboutBadge} badgeLabel={aboutBadgeLabel} />
            </div>)}
        </div>
        <button type="button" onClick={onOpenJson}
            className="mt-2 w-full flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-app-muted hover:text-app-text hover:bg-app-surface/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-control-focus">
            <Code size={15} aria-hidden="true" /> settings.json
        </button>
    </div>;
}
