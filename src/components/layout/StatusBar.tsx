import { Cable, CircleAlert, Monitor, PanelLeft, Sparkles, Wifi, WifiOff } from 'lucide-react';

import { LOCAL_TERMINAL_CONNECTION_ID } from '../../features/connections/application/tabService';
import { useEditorStatus } from '../../features/editor/editorStatus';
import { StatusBarInboxIndicator } from '../../features/feedbackInbox/StatusBarInboxIndicator';
import { runShortcutCommand } from '../../features/shortcuts/actions';
import {
    DEFAULT_STATUS_BAR_SETTINGS,
    StatusBarLatency,
    useConnectionLatency,
} from '../../features/statusBar';
import { StatusBarUpdateIndicator } from '../../features/updater/StatusBarUpdateIndicator';
import { sidebarPresentation } from '../../features/workspace/application/sidebarPresentation';
import { formatShortcutLabel } from '../../lib/shortcuts';
import { cn } from '../../lib/utils';
import { useAppStore } from '../../store/useAppStore';
import { StatusBarTransferIndicator } from '../file-manager/StatusBarTransferIndicator';
import { NotificationBell, useNotificationBellPlacement } from '../notifications/NotificationBell';
import { Tooltip } from '../ui/Tooltip';
import { ChromeActionItems } from './ChromeActionItems';
import { useChromeCustomizationMenu } from './useChromeCustomizationMenu';

const statusToggleBtnClass =
    'h-6 w-6 shrink-0 rounded-md text-app-muted hover:text-app-text hover:bg-app-surface border border-transparent hover:border-app-border/40 transition-colors flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/60 focus-visible:ring-offset-0';

function EditorStatusText() {
    const editorStatus = useEditorStatus();
    return (
        <span
            data-zync-color-label
            className="text-app-muted font-mono text-[11px] tracking-wide"
        >
            {editorStatus}
        </span>
    );
}

/** Show the selected connection's identity while transport-specific controls own live session state. */
export function StatusBar() {
    const activeConnectionId = useAppStore((state) => state.activeConnectionId);
    const activeTab = useAppStore((state) =>
        state.tabs.find((tab) => tab.id === state.activeTabId),
    );
    const standaloneKind =
        activeTab?.type === 'serial' ? 'Serial' : activeTab?.type === 'vnc' ? 'VNC' : undefined;
    const chromeActions = useAppStore((state) => state.settings.chromeActions);
    const statusMenu = useChromeCustomizationMenu('statusBar');
    const connections = useAppStore((state) => state.connections);
    const activeConnection = connections.find((c) => c.id === activeConnectionId);
    const isLocalWorkspace = activeConnectionId === LOCAL_TERMINAL_CONNECTION_ID;
    const sidebarCollapsed = useAppStore(
        (state) =>
            sidebarPresentation(
                state.settings.workspaceNavigation,
                state.globalSidebarSection,
                state.settings.sidebarCollapsed,
            ).collapsed,
    );
    const keybindings = useAppStore((state) => state.settings.keybindings);
    const toggleAiSidebar = useAppStore((state) => state.toggleAiSidebar);
    const isAiSidebarOpen = useAppStore((state) => state.isAiSidebarOpen);
    const editorDiagnosticsCount = useAppStore((state) => state.editorDiagnosticsCount);
    const editorDiagnosticsSeverity = useAppStore((state) => state.editorDiagnosticsSeverity);
    const editorDiagnosticsVisible = useAppStore((state) => state.editorDiagnosticsVisible);
    const setEditorDiagnosticsVisible = useAppStore((state) => state.setEditorDiagnosticsVisible);
    const isMac = (window.electronUtils?.platform || 'linux') === 'darwin';
    const sidebarShortcut = formatShortcutLabel(keybindings?.toggleSidebar ?? 'Mod+B', isMac);
    const aiShortcut = formatShortcutLabel(keybindings?.aiCommandBar ?? 'Mod+I', isMac);
    const sidebarHint = sidebarShortcut ? ` (${sidebarShortcut})` : '';
    const aiHint = aiShortcut ? ` (${aiShortcut})` : '';

    const toggleSidebar = () => {
        runShortcutCommand('toggleSidebar', new KeyboardEvent('keydown'));
    };

    const isLiveConnected = activeConnection?.status === 'connected';
    const isConnecting = activeConnection?.status === 'connecting';
    const { showInStatusLeft, showInStatusRight } = useNotificationBellPlacement();
    const showConnectionLatency =
        useAppStore((state) => state.settings.statusBar?.showConnectionLatency) ??
        DEFAULT_STATUS_BAR_SETTINGS.showConnectionLatency;
    const latencyMs = useConnectionLatency({
        connectionId: activeConnectionId,
        enabled: showConnectionLatency,
        isLive: Boolean(isLiveConnected && activeConnection),
    });

    return (
        <div
            data-zync-color="statusBar"
            tabIndex={-1}
            onContextMenu={statusMenu.onContextMenu}
            onKeyDown={statusMenu.onKeyDown}
            className="h-9 bg-app-panel border-t border-app-border flex items-center px-2.5 text-[11px] select-none text-app-text/80 justify-between shrink-0 gap-2"
        >
            {/* Bottom-left: sidebar toggle + connection status */}
            <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                <Tooltip
                    content={`${sidebarCollapsed ? 'Show Sidebar' : 'Hide Sidebar'}${sidebarHint}`}
                    position="top"
                >
                    <button
                        type="button"
                        onClick={toggleSidebar}
                        className={cn(
                            statusToggleBtnClass,
                            !sidebarCollapsed &&
                                'text-app-accent bg-app-accent/10 border-app-accent/20',
                        )}
                        aria-label={`${sidebarCollapsed ? 'Show Sidebar' : 'Hide Sidebar'}${sidebarHint}`}
                    >
                        <PanelLeft size={14} />
                    </button>
                </Tooltip>

                <div
                    className="h-4 w-px shrink-0 bg-app-border/50"
                    aria-hidden
                />

                {showInStatusLeft && (
                    <>
                        <NotificationBell
                            tooltipPosition="top"
                            size="status"
                        />
                        <div
                            className="h-4 w-px shrink-0 bg-app-border/50"
                            aria-hidden
                        />
                    </>
                )}

                {/*
          Cap host width with a fixed rem max (not % of a squeezed flex parent).
          Long names ellipsis; hover tooltip keeps the full label.
        */}
                <div className="flex min-w-0 max-w-[8rem] items-center gap-1.5 overflow-hidden">
                    {isLiveConnected && activeConnection ? (
                        <div className="flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden text-app-text/80">
                            {showConnectionLatency && latencyMs !== null ? (
                                <StatusBarLatency ms={latencyMs} />
                            ) : (
                                <Wifi
                                    size={12}
                                    className="text-app-success shrink-0"
                                />
                            )}
                            {/* Inner truncate span: Tooltip trigger is inline-flex and breaks ellipsis on the same node */}
                            <Tooltip
                                content={`Connected to ${activeConnection.name}`}
                                position="top"
                                className="min-w-0 max-w-full justify-start overflow-hidden"
                            >
                                <span className="inline-flex min-w-0 max-w-full overflow-hidden">
                                    <span
                                        data-zync-color-label
                                        className="min-w-0 truncate font-medium hover:text-white transition-colors"
                                    >
                                        {activeConnection.name}
                                    </span>
                                </span>
                            </Tooltip>
                        </div>
                    ) : isConnecting && activeConnection ? (
                        <Tooltip
                            content={`Connecting to ${activeConnection.name}`}
                            position="top"
                            className="min-w-0 max-w-full justify-start overflow-hidden"
                        >
                            <div className="flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden">
                                <Wifi
                                    size={12}
                                    className="text-app-warning shrink-0 animate-pulse"
                                />
                                <span
                                    data-zync-color-label
                                    className="min-w-0 truncate text-app-muted"
                                >
                                    {activeConnection.name}
                                </span>
                            </div>
                        </Tooltip>
                    ) : activeConnection ? (
                        <Tooltip
                            content={`${activeConnection.name} is offline`}
                            position="top"
                            className="min-w-0 max-w-full justify-start overflow-hidden"
                        >
                            <div className="flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden">
                                <WifiOff
                                    size={12}
                                    className="text-app-muted shrink-0"
                                />
                                <span
                                    data-zync-color-label
                                    className="min-w-0 truncate text-app-muted"
                                >
                                    {activeConnection.name}
                                </span>
                            </div>
                        </Tooltip>
                    ) : isLocalWorkspace ? (
                        <div className="flex shrink-0 items-center gap-1.5">
                            <Monitor
                                size={12}
                                className="text-app-muted shrink-0"
                            />
                            <span
                                data-zync-color-label
                                className="whitespace-nowrap text-app-muted"
                            >
                                Local
                            </span>
                        </div>
                    ) : standaloneKind && activeTab ? (
                        <Tooltip
                            content={`${standaloneKind}: ${activeTab.title}`}
                            position="top"
                            className="min-w-0 max-w-full justify-start overflow-hidden"
                        >
                            <div className="flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden">
                                {standaloneKind === 'Serial' ? (
                                    <Cable
                                        size={12}
                                        className="text-app-muted shrink-0"
                                    />
                                ) : (
                                    <Monitor
                                        size={12}
                                        className="text-app-muted shrink-0"
                                    />
                                )}
                                <span
                                    data-zync-color-label
                                    className="min-w-0 truncate text-app-muted"
                                >
                                    {activeTab.title}
                                </span>
                            </div>
                        </Tooltip>
                    ) : (
                        <div className="flex shrink-0 items-center gap-1.5">
                            <WifiOff
                                size={12}
                                className="text-app-muted shrink-0"
                            />
                            <span
                                data-zync-color-label
                                className="whitespace-nowrap text-app-muted"
                            >
                                No Connection
                            </span>
                        </div>
                    )}
                </div>

                {/* Plugin Status Bar Slots (Temporarily disabled per UX request) */}
            </div>

            {/* Bottom-right: status bits + AI toggle */}
            <div className="flex items-center gap-3 shrink-0">
                <ChromeActionItems
                    value={chromeActions}
                    area="statusBar"
                    slots={{
                        'status.editor': <EditorStatusText />,
                        'status.diagnostics': editorDiagnosticsCount > 0 && (
                            <Tooltip
                                content={`${editorDiagnosticsVisible ? 'Hide' : 'Show'} diagnostics (${editorDiagnosticsCount})`}
                                position="top"
                            >
                                <button
                                    type="button"
                                    onClick={() =>
                                        setEditorDiagnosticsVisible(!editorDiagnosticsVisible)
                                    }
                                    className="inline-flex items-center gap-1 rounded-sm px-1 py-0.5 hover:bg-app-surface/60"
                                    aria-label={`${editorDiagnosticsVisible ? 'Hide' : 'Show'} diagnostics (${editorDiagnosticsCount})`}
                                >
                                    <CircleAlert
                                        size={13}
                                        className={cn(
                                            editorDiagnosticsSeverity === 'error'
                                                ? 'text-app-danger'
                                                : 'text-app-warning',
                                            editorDiagnosticsVisible && 'opacity-100',
                                            !editorDiagnosticsVisible && 'opacity-85',
                                        )}
                                    />
                                    <span className="font-mono text-[11px] text-app-muted">
                                        {editorDiagnosticsCount}
                                    </span>
                                </button>
                            </Tooltip>
                        ),
                        'status.transfers': <StatusBarTransferIndicator />,
                        'status.updates': <StatusBarUpdateIndicator />,
                        'status.message': <StatusMessage />,
                        'status.inbox': <StatusBarInboxIndicator />,
                        'status.notifications': showInStatusRight && (
                            <NotificationBell
                                tooltipPosition="top"
                                size="status"
                            />
                        ),
                        'status.ai': (
                            <>
                                <div
                                    className="h-4 w-px shrink-0 bg-app-border/50"
                                    aria-hidden
                                />

                                <Tooltip
                                    content={`AI Assistant${aiHint}`}
                                    position="top"
                                >
                                    <button
                                        type="button"
                                        onClick={toggleAiSidebar}
                                        className={cn(
                                            statusToggleBtnClass,
                                            isAiSidebarOpen &&
                                                'text-app-accent bg-app-accent/10 border-app-accent/20',
                                        )}
                                        aria-label={`Toggle AI Sidebar${aiHint}`}
                                    >
                                        <Sparkles size={14} />
                                    </button>
                                </Tooltip>
                            </>
                        ),
                    }}
                />
            </div>
            {statusMenu.menu}
        </div>
    );
}

function StatusMessage() {
    const lastAction = useAppStore((state) => state.lastAction);

    if (!lastAction) {
        return null;
    }

    return (
        <span
            className={cn(
                'font-medium transition-all animate-in fade-in slide-in-from-bottom-1 duration-300',
                lastAction.type === 'success'
                    ? 'text-app-success'
                    : lastAction.type === 'error'
                      ? 'text-app-danger'
                      : 'text-app-text',
            )}
        >
            {lastAction.message}
        </span>
    );
}
