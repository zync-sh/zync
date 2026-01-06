import { useEffect } from 'react';
import { useConnections } from '../../context/ConnectionContext';
import { useSettings } from '../../context/SettingsContext';

export function ShortcutManager() {
    const { openTab, activeTabId, closeTab, openAddConnectionModal } = useConnections();
    const { openSettings, isSettingsOpen, closeSettings, updateSettings, settings } = useSettings();

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Ignore if input is focused (unless it's a command key that generally works)
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
                // Allow some shortcuts even in input? Maybe later.
                // For now, let's block mostly to prevent typing issues.
                // BUT, Ctrl+W or Ctrl+N should probably still work? 
                // Let's allow Mod+ modifiers.
                // Actually, if in terminal, it might capture keys.
                // We depend on the terminal component's focus handling too.
            }

            // Check for Modifier (Ctrl on Windows/Linux, Cmd on Mac)
            // But usually e.ctrlKey or e.metaKey
            const isMod = e.ctrlKey || e.metaKey;

            if (!isMod) return;

            switch (e.key.toLowerCase()) {
                case 'b':
                    e.preventDefault();
                    updateSettings({ sidebarCollapsed: !settings.sidebarCollapsed });
                    break;
                case 'n':
                    e.preventDefault();
                    if (openAddConnectionModal) openAddConnectionModal();
                    break;
                case 't':
                    e.preventDefault();
                    openTab('local');
                    break;
                case ',':
                    e.preventDefault();
                    if (isSettingsOpen) closeSettings();
                    else openSettings();
                    break;
                case 'w':
                    e.preventDefault();
                    if (activeTabId) {
                        closeTab(activeTabId);
                    }
                    break;
                case 'tab':
                    // Switch tabs
                    // Logic for next/prev can be added here
                    break;
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [openTab, closeTab, activeTabId, isSettingsOpen, openSettings, closeSettings, openAddConnectionModal]);

    return null;
}
