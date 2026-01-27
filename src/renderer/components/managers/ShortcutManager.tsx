import { useEffect } from 'react';
import { useConnections } from '../../context/ConnectionContext';
import { useSettings } from '../../context/SettingsContext';

// Helper to check if event matches "Mod+Shift+T" or "Ctrl+B" etc.
function matchShortcut(e: KeyboardEvent, shortcut: string): boolean {
    if (!shortcut) return false;
    const parts = shortcut.toLowerCase().split('+');
    const key = parts[parts.length - 1];

    // Check modifiers
    const hasCtrl = parts.includes('ctrl') || parts.includes('control');
    const hasShift = parts.includes('shift');
    const hasAlt = parts.includes('alt');
    const hasMeta = parts.includes('meta') || parts.includes('cmd') || parts.includes('command') || parts.includes('super');
    const hasMod = parts.includes('mod'); // Ctrl on Win/Linux, Meta on Mac

    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const effectiveCtrl = hasCtrl || (hasMod && !isMac);
    const effectiveMeta = hasMeta || (hasMod && isMac);

    if (e.ctrlKey !== effectiveCtrl) return false;
    if (e.metaKey !== effectiveMeta) return false;
    if (e.altKey !== hasAlt) return false;
    if (e.shiftKey !== hasShift) return false;

    // Check key
    // For simple keys, e.key is mostly sufficient (e.g., 'b', 't', ',', 'Tab')
    // Special mapping might be needed for some edge cases, but for now:
    if (e.key.toLowerCase() === key) return true;
    if (key === 'tab' && e.key === 'Tab') return true;

    return false;
}

export function ShortcutManager() {
    const { openTab, activeTabId, closeTab, openAddConnectionModal, activeConnectionId, tabs, activateTab } = useConnections();
    const { openSettings, isSettingsOpen, closeSettings, updateSettings, settings } = useSettings();

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Ignore if input is focused (unless it's a command key that generally works)
            const isInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
            if (isInput) {
                // Allow Mod keys to pass through
                if (!e.ctrlKey && !e.metaKey) return;
            }

            const kb = settings.keybindings;
            if (!kb) return;

            if (matchShortcut(e, kb.toggleSidebar)) {
                e.preventDefault();
                updateSettings({ sidebarCollapsed: !settings.sidebarCollapsed });
            }
            else if (matchShortcut(e, kb.openNewConnection)) {
                e.preventDefault();
                if (openAddConnectionModal) openAddConnectionModal();
            }
            else if (matchShortcut(e, kb.newLocalTerminal)) {
                e.preventDefault();
                openTab('local');
            }
            else if (matchShortcut(e, kb.newHostTerminal)) {
                e.preventDefault();
                if (activeConnectionId) {
                    const event = new CustomEvent('ssh-ui:new-terminal-tab', {
                        detail: { connectionId: activeConnectionId }
                    });
                    window.dispatchEvent(event);
                }
            }
            else if (matchShortcut(e, kb.toggleSettings)) {
                e.preventDefault();
                if (isSettingsOpen) closeSettings();
                else openSettings();
            }
            else if (matchShortcut(e, kb.closeTab)) {
                e.preventDefault();
                if (activeTabId) closeTab(activeTabId);
            }
            else if (matchShortcut(e, kb.commandPalette || 'Mod+P')) {
                e.preventDefault();
                window.dispatchEvent(new CustomEvent('ssh-ui:toggle-command-palette'));
            }
            else if (matchShortcut(e, kb.switchTabNext || 'Ctrl+Tab')) {
                e.preventDefault();
                e.stopPropagation(); // Stop propagation to prevent browser/electron defaults
                if (tabs.length > 1) {
                    const currentIndex = tabs.findIndex(t => t.id === activeTabId);
                    if (currentIndex !== -1) {
                        const nextIndex = (currentIndex + 1) % tabs.length;
                        activateTab(tabs[nextIndex].id);
                    }
                }
            }
            else if (matchShortcut(e, kb.switchTabPrev || 'Ctrl+Shift+Tab')) {
                e.preventDefault();
                e.stopPropagation();
                if (tabs.length > 1) {
                    const currentIndex = tabs.findIndex(t => t.id === activeTabId);
                    if (currentIndex !== -1) {
                        const prevIndex = (currentIndex - 1 + tabs.length) % tabs.length;
                        activateTab(tabs[prevIndex].id);
                    }
                }
            }
            // Tab Jumping (1-9)
            else if (['1', '2', '3', '4', '5', '6', '7', '8', '9'].some(n => matchShortcut(e, kb[`switchTab${n}` as keyof typeof kb] || 'Mod+' + n))) {
                e.preventDefault();
                const key = e.key; // '1' to '9'
                const index = parseInt(key) - 1;
                if (tabs[index]) {
                    activateTab(tabs[index].id);
                }
            }
            // Zoom
            else if (matchShortcut(e, kb.zoomIn || 'Mod+=')) {
                e.preventDefault();
                // Send to main process or handle in renderer? 
                // Renderer zoom can be done via webFrame but usually global
                window.ipcRenderer.invoke('app:zoomIn');
            }
            else if (matchShortcut(e, kb.zoomOut || 'Mod+-')) {
                e.preventDefault();
                window.ipcRenderer.invoke('app:zoomOut');
            }
            // Terminal Actions (Dispatch to Active Terminal)
            else if (matchShortcut(e, kb.termCopy || 'Mod+Shift+C')) {
                e.preventDefault();
                window.dispatchEvent(new CustomEvent('ssh-ui:term-copy'));
            }
            else if (matchShortcut(e, kb.termPaste || 'Mod+Shift+V')) {
                e.preventDefault();
                // Paste needs to read clipboard, might need async, but event is enough trigger
                window.dispatchEvent(new CustomEvent('ssh-ui:term-paste'));
            }
            else if (matchShortcut(e, kb.termFind || 'Mod+F')) {
                e.preventDefault();
                window.dispatchEvent(new CustomEvent('ssh-ui:term-find'));
            }
        };

        window.addEventListener('keydown', handleKeyDown, { capture: true });
        return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
    }, [openTab, closeTab, activeTabId, activeConnectionId, isSettingsOpen, openSettings, closeSettings, openAddConnectionModal, settings.sidebarCollapsed, settings.keybindings, updateSettings, tabs, activateTab]);

    return null;
}
