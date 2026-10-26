import { type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../../store/useAppStore';
import { resolveWorkspaceNavigation } from '../../../features/workspace/domain/navigation';
import { runGlobalNavigation, runShortcutCommand } from '../../../features/shortcuts/actions';
import { ActivityBar } from './ActivityBar';
import { NavigationFrame } from './NavigationFrame';
import { GlobalUtilityActions } from '../GlobalUtilityActions';
import { GLOBAL_SNIPPETS_CONNECTION_ID, LOCAL_TERMINAL_CONNECTION_ID } from '../../../features/connections/application/tabService';
import { selectHostWorkspaceTab } from '../../../features/workspace/application/hostWorkspaceSelection';
import { WorkspaceSidebarProvider } from './WorkspaceSidebarContext';
import { OSIcon } from '../../icons/OSIcon';
import { Monitor } from 'lucide-react';

/** Thin shell adapter. The existing workspace subtree has one persistent parent at every placement. */
export function WorkspaceNavigationFrame({ children }: { children: ReactNode }) {
    const { raw, keybindings, openSettings, activeId, activeConnection, section, workspace, connections } = useAppStore(useShallow(state => ({
        raw: state.settings.workspaceNavigation, keybindings: state.settings.keybindings,
        openSettings: state.openSettings, activeId: state.tabs.find(tab => tab.id === state.activeTabId)?.type,
        activeConnection: state.tabs.find(tab => tab.id === state.activeTabId)?.connectionId,
        section: state.globalSidebarSection,
        workspace: selectHostWorkspaceTab(state.tabs, state.activeTabId, state.activeConnectionId, state.lastRealConnectionId),
        connections: state.connections,
    })));
    const preferences = resolveWorkspaceNavigation(raw);
    const host = connections.find(connection => connection.id === workspace?.connectionId);
    const workspaceLabel = workspace?.displayAlias ?? (workspace?.connectionId === LOCAL_TERMINAL_CONNECTION_ID ? 'Local Terminal' : host?.name ?? workspace?.title);
    const workspaceBadge = workspace ? (workspace.connectionId === LOCAL_TERMINAL_CONNECTION_ID ? <Monitor className="h-2.5 w-2.5" />
        : <OSIcon icon={host?.icon ?? 'server'} className="h-2.5 w-2.5" />) : undefined;
    return <WorkspaceSidebarProvider><NavigationFrame position={preferences.position} navigation={<ActivityBar preferences={preferences}
        hasWorkspace={Boolean(workspace)} keybindings={keybindings}
        workspaceLabel={workspaceLabel} workspaceBadge={workspaceBadge}
        activeId={section ?? (activeId === 'public-urls' ? 'public-urls' : activeId === 'port-forwarding' ? 'tunnels'
            : activeId === 'security-audits' ? 'security-audits'
            : activeId === 'connection' ? activeConnection === GLOBAL_SNIPPETS_CONNECTION_ID ? 'snippets' : 'workspace' : undefined)}
        footer={<GlobalUtilityActions location="activity" />}
        onChange={action => useAppStore.getState().updateWorkspaceNavigation(action)}
        onError={() => {
            useAppStore.getState().showToast('error', 'Could not save navigation. Please retry or reload settings.');
        }}
        onGlobal={runGlobalNavigation}
        onCommand={id => { runShortcutCommand(id, new KeyboardEvent('keydown')); }}
        onCustomize={() => openSettings('layout')} />}>
        {children}
    </NavigationFrame></WorkspaceSidebarProvider>;
}
