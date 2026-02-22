import { useEffect } from 'react';
import { useAppStore, type Tab } from '../../store/useAppStore';
import { matchShortcut } from '../../lib/shortcuts';



export function ShortcutManager() {
    const openTab = useAppStore(state => state.openTab);
    const activeTabId = useAppStore(state => state.activeTabId);
    // const closeTab = useAppStore(state => state.closeTab); // Removed to avoid conflict with TabBar
    const setAddConnectionModalOpen = useAppStore(state => state.setAddConnectionModalOpen);
    const activeConnectionId = useAppStore(state => state.activeConnectionId);
    const tabs = useAppStore(state => state.tabs);
    const activateTab = useAppStore(state => state.activateTab);

    const openSettings = useAppStore(state => state.openSettings);
    const isSettingsOpen = useAppStore(state => state.isSettingsOpen);
    const closeSettings = useAppStore(state => state.closeSettings);
    const updateSettings = useAppStore(state => state.updateSettings);
    const settings = useAppStore(state => state.settings);

    const openAddConnectionModal = () => setAddConnectionModalOpen(true);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const kb = settings.keybindings;
            if (!kb) return;

            // Ignore if input is focused (unless it's a command key that generally works)
            const isInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
            const isContentEditable = e.target instanceof HTMLElement && e.target.isContentEditable;

            if (isInput || isContentEditable) {
                // Allow terminal shortcuts to always pass through (terminal uses a hidden textarea)
                if (matchShortcut(e, kb.termCopy) || matchShortcut(e, kb.termPaste) || matchShortcut(e, kb.termFind)) {
                    // allow to pass through
                } else {
                    // Always ignore Mod+F, Mod+S, Mod+/, Mod+A, Mod+C/V/X in inputs/editors
                    const editorShortcuts = ['f', 's', 'a', 'z', 'y', 'c', 'v', 'x', '/'];
                    if ((e.ctrlKey || e.metaKey) && editorShortcuts.includes(e.key.toLowerCase())) {
                        return;
                    }
                    // Allow Mod keys to pass through for other shortcuts (like Mod+, or Mod+B)
                    if (!e.ctrlKey && !e.metaKey && !e.altKey) return;
                }
            }

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
            else if (matchShortcut(e, kb.closeTerminalTab || 'Mod+Shift+W')) {
                e.preventDefault();
                if (activeConnectionId) {
                    const event = new CustomEvent('ssh-ui:close-terminal-tab', {
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
            // closeTab handled in TabBar.tsx to support confirmation modal
            else if (matchShortcut(e, kb.commandPalette || 'Mod+P')) {
                e.preventDefault();
                window.dispatchEvent(new CustomEvent('ssh-ui:toggle-command-palette'));
            }
            else if (matchShortcut(e, kb.switchTabNext || 'Ctrl+Tab')) {
                e.preventDefault();
                e.stopPropagation(); // Stop propagation to prevent browser/electron defaults
                if (tabs.length > 1) {
                    const currentIndex = tabs.findIndex((t: Tab) => t.id === activeTabId);
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
                    const currentIndex = tabs.findIndex((t: Tab) => t.id === activeTabId);
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
            // Feature Shortcuts (Files, Port Forwarding, Snippets, Dashboard)
            else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') {
                e.preventDefault();
                if (activeTabId) {
                    const currentTab = tabs.find((t: Tab) => t.id === activeTabId);
                    if (currentTab && currentTab.type === 'connection') {
                        const event = new CustomEvent('ssh-ui:open-feature', {
                            detail: { feature: 'files', tabId: activeTabId }
                        });
                        window.dispatchEvent(event);
                    }
                }
            }
            else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'n') {
                e.preventDefault();
                if (activeTabId) {
                    const currentTab = tabs.find((t: Tab) => t.id === activeTabId);
                    if (currentTab && currentTab.type === 'connection') {
                        const event = new CustomEvent('ssh-ui:open-feature', {
                            detail: { feature: 'port-forwarding', tabId: activeTabId }
                        });
                        window.dispatchEvent(event);
                    }
                }
            }
            else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 's') {
                e.preventDefault();
                if (activeTabId) {
                    const currentTab = tabs.find((t: Tab) => t.id === activeTabId);
                    if (currentTab && currentTab.type === 'connection') {
                        const event = new CustomEvent('ssh-ui:open-feature', {
                            detail: { feature: 'snippets', tabId: activeTabId }
                        });
                        window.dispatchEvent(event);
                    }
                }
            }
            else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
                e.preventDefault();
                if (activeTabId) {
                    const currentTab = tabs.find((t: Tab) => t.id === activeTabId);
                    if (currentTab && currentTab.type === 'connection') {
                        const event = new CustomEvent('ssh-ui:open-feature', {
                            detail: { feature: 'dashboard', tabId: activeTabId }
                        });
                        window.dispatchEvent(event);
                    }
                }
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
    }, [openTab, activeTabId, activeConnectionId, isSettingsOpen, openSettings, closeSettings, setAddConnectionModalOpen, settings.sidebarCollapsed, settings.keybindings, updateSettings, tabs, activateTab]);

    return null;
}
