import { isEditorOverlayOpen } from '../../components/editor/overlayState';
import { canSplit, isSplitFeatureId, paneNavDirectionFromKey } from '../../lib/paneLayout';
import { findWorkspacePane } from '../workspace/domain/canvases';
import { workspaceCanvasVisibility } from '../workspace/domain/visibleContent';
import { workspaceDockingView } from '../workspace/domain/dockingView';
import { neighborWorkspaceContentId } from '../workspace/domain/dockingNavigation';
import { resolveWorkspaceNavigation } from '../workspace/domain/navigation';
import { activateGlobalNavigation, type GlobalNavigationAction } from '../workspace/application/globalNavigation';
import { selectHostWorkspaceTab } from '../workspace/application/hostWorkspaceSelection';
import { sidebarPresentation, setSidebarVisibility } from '../workspace/application/sidebarPresentation';
import { useAppStore, type Tab } from '../../store/useAppStore';
import { keyboardFocus } from './focus';
import { SHORTCUT_CATALOG } from './catalog';
import { dispatchWorkspacePresentationAction } from './workspacePresentation';
import { runTerminalInteraction, terminalInteractionForEvent } from '../../lib/terminal/terminalInteraction';
import { TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from '../../components/settings/constants/defaults';

let sidebarCollapseTimer: ReturnType<typeof setTimeout> | null = null;

function emit(name: string, detail?: unknown): void {
    window.dispatchEvent(detail === undefined ? new CustomEvent(name) : new CustomEvent(name, { detail }));
}

function connectionFeature(feature: string): boolean {
    const { activeTabId, tabs } = useAppStore.getState();
    if (!activeTabId) return false;
    const current = tabs.find((t: Tab) => t.id === activeTabId);
    if (current?.type !== 'connection') return false;
    emit('ssh-ui:open-feature', { feature, tabId: activeTabId });
    return true;
}

/** Resolve current chrome selection without opening or enrolling any content. */
function activeWorkspaceCanvas(store: ReturnType<typeof useAppStore.getState>) {
    const tab = store.tabs.find(item => item.id === store.activeTabId);
    if (store.showWelcomeScreen || tab?.type !== 'connection' || !tab.connectionId
        || tab.connectionId !== store.activeConnectionId) return undefined;
    const pluginPanelId = tab.view.startsWith('plugin:') ? tab.view.slice('plugin:'.length) : undefined;
    const featureId = isSplitFeatureId(tab.view) ? tab.view : undefined;
    if (tab.view !== 'terminal' && !pluginPanelId && !featureId) return undefined;
    return { tab, connectionId: tab.connectionId, pluginPanelId, featureId, ...workspaceCanvasVisibility(store, tab.connectionId,
        undefined, pluginPanelId, featureId) };
}

/** One adapter for clicked and keyboard-selected destinations; never starts host sessions. */
export function runGlobalNavigation(action: GlobalNavigationAction): boolean {
    const state = useAppStore.getState();
    return activateGlobalNavigation(action, {
        workspaceDocked: resolveWorkspaceNavigation(state.settings.workspaceNavigation).workspaceTabsPosition !== 'default',
        showSection: section => {
            const current = sidebarPresentation(state.settings.workspaceNavigation, state.globalSidebarSection, state.settings.sidebarCollapsed);
            const collapse = section !== null && current.section === section && !current.collapsed;
            if (section) setSidebarVisibility(useAppStore.getState, collapse, section);
            else state.setGlobalSidebarSection(null);
        },
        selectWorkspace: () => {
            const tab = selectHostWorkspaceTab(state.tabs, state.activeTabId, state.activeConnectionId, state.lastRealConnectionId);
            if (!tab) return false;
            state.activateTab(tab.id); return true;
        },
        openPublicUrls: state.openPublicUrlsTab, openForwarding: state.openPortForwardingTab, openSnippets: state.openSnippetsTab,
        openSecurityAudits: state.openSecurityAuditsTab,
    });
}

/** Returns false if the event must not be consumed (pass through). */
export function runShortcutCommand(id: string, event: KeyboardEvent): boolean {
    const store = useAppStore.getState();
    id = SHORTCUT_CATALOG.find(command => command.id === id)?.actionId ?? id;
    const registered = SHORTCUT_CATALOG.find(command => command.id === id);
    if (registered?.shellAction === 'customize-navigation') { store.openSettings('layout'); return true; }
    if (registered?.shellAction === 'profile-menu') { emit('zync:open-profile-menu'); return true; }
    if (registered?.navigationAction) return runGlobalNavigation(registered.navigationAction);
    if (registered?.workspaceAction) return dispatchWorkspacePresentationAction(registered.workspaceAction, store);

    switch (id) {
        case 'toggleSidebar': {
            if (resolveWorkspaceNavigation(store.settings.workspaceNavigation).visible) return runGlobalNavigation('hosts');
            emit('zync:layout-transition-start');
            const { collapsed } = sidebarPresentation(store.settings.workspaceNavigation, store.globalSidebarSection, store.settings.sidebarCollapsed);
            setSidebarVisibility(useAppStore.getState, !collapsed);
            if (sidebarCollapseTimer) clearTimeout(sidebarCollapseTimer);
            sidebarCollapseTimer = setTimeout(() => {
                emit('zync:layout-transition-end');
                sidebarCollapseTimer = null;
            }, 320);
            return true;
        }
        case 'openNewConnection':
            store.setAddConnectionModalOpen(true);
            return true;
        case 'newLocalTerminal':
            store.openTab('local');
            return true;
        case 'newHostTerminal':
            if (store.activeConnectionId) {
                emit('ssh-ui:new-terminal-tab', { connectionId: store.activeConnectionId });
            }
            return true;
        case 'closeTerminalTab':
            if (store.activeConnectionId) {
                emit('ssh-ui:close-terminal-tab', { connectionId: store.activeConnectionId });
            }
            return true;
        case 'splitPanes': {
            if (keyboardFocus(event.target) === 'field') return false;
            const selected = activeWorkspaceCanvas(store);
            if (!selected) return false;
            const view = workspaceDockingView(store, selected.connectionId, selected);
            if (!view.projection.ok || !view.projection.value.focusedContentId) return false;
            const contentId = view.projection.value.focusedContentId;
            const target = findWorkspacePane(view.canvases, { contentId });
            if (!target || !canSplit(target.layout)) return false;
            const stacked = event.key === 'ArrowUp' || event.key === 'ArrowDown';
            const changed = store.splitPanes(selected.connectionId, stacked ? 'vertical' : 'horizontal', 'after', { contentId });
            if (changed && !view.preferences?.placements[contentId] && selected.tab.view !== 'terminal') store.setTabView(selected.tab.id, 'terminal');
            return changed;
        }
        case 'focusSplitPane': {
            if (keyboardFocus(event.target) === 'field') return false;
            const direction = paneNavDirectionFromKey(event.key);
            if (!direction) return false;
            const selected = activeWorkspaceCanvas(store);
            if (!selected) return false;
            const view = workspaceDockingView(store, selected.connectionId, selected);
            if (!view.projection.ok) return false;
            if (view.projection.value.maximizedContentId) return false;
            if (Object.keys(view.preferences?.placements ?? {}).length) {
                const next = neighborWorkspaceContentId(view.projection.value, direction, view.preferences?.sizes);
                return next ? store.focusWorkspaceContent(selected.connectionId, next) : false;
            }
            if (!selected.visible) return false;
            return store.focusPaneInDirection(selected.connectionId, direction, selected.visible.activePaneId);
        }
        case 'toggleSettings':
            if (store.isSettingsOpen) store.closeSettings();
            else store.openSettings();
            return true;
        case 'commandPalette':
            emit('zync:open-command-palette', { commandMode: false });
            return true;
        case 'commandPaletteMode':
            emit('zync:open-command-palette', { commandMode: true });
            return true;
        case 'aiCommandBar':
            store.toggleAiSidebar();
            return true;
        case 'closeTab':
            if (isEditorOverlayOpen()) {
                return false;
            }
            event.stopPropagation();
            emit('zync:close-active-tab');
            return true;
        case 'switchTabNext': {
            event.stopPropagation();
            const { tabs, activeTabId, activateTab } = store;
            if (tabs.length > 1) {
                const currentIndex = tabs.findIndex((t: Tab) => t.id === activeTabId);
                if (currentIndex !== -1) {
                    activateTab(tabs[(currentIndex + 1) % tabs.length].id);
                }
            }
            return true;
        }
        case 'switchTabPrev': {
            event.stopPropagation();
            const { tabs, activeTabId, activateTab } = store;
            if (tabs.length > 1) {
                const currentIndex = tabs.findIndex((t: Tab) => t.id === activeTabId);
                if (currentIndex !== -1) {
                    activateTab(tabs[(currentIndex - 1 + tabs.length) % tabs.length].id);
                }
            }
            return true;
        }
        case 'termCopy':
            return runTerminalInteraction('copy', event);
        case 'termPaste':
            return runTerminalInteraction('paste', event);
        case 'termFind':
            return runTerminalInteraction('find', event);
        case 'zoomIn':
        case 'zoomOut':
            if (terminalInteractionForEvent(event)) {
                const fontSize = Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN,
                    store.settings.terminal.fontSize + (id === 'zoomIn' ? 1 : -1)));
                void store.updateTerminalSettings({ fontSize }).catch(() => store.showToast('error', 'Could not save terminal font size.'));
            } else {
                void window.ipcRenderer?.invoke(id === 'zoomIn' ? 'app:zoomIn' : 'app:zoomOut');
            }
            return true;
        case 'filesFeature':
            return connectionFeature('files');
        case 'tunnelsFeature':
            return connectionFeature('port-forwarding');
        case 'snippetsFeature': {
            const { activeTabId, tabs } = store;
            if (activeTabId) {
                const current = tabs.find((t: Tab) => t.id === activeTabId);
                if (current?.type === 'connection') {
                    emit('ssh-ui:toggle-snippet-sidebar', { tabId: activeTabId });
                }
            }
            return true;
        }
        case 'dashboardFeature':
            return connectionFeature('dashboard');
        default: {
            if (id.startsWith('switchTab')) {
                const index = Number.parseInt(id.slice('switchTab'.length), 10) - 1;
                if (Number.isInteger(index) && store.tabs[index]) {
                    store.activateTab(store.tabs[index].id);
                }
                return true;
            }
            return false;
        }
    }
}
