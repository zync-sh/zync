import {
    Activity,
    Layers,
    type LucideIcon,
    Play,
    RefreshCw,
    Server,
    Shield,
    Terminal,
} from 'lucide-react';
import { useState } from 'react';

import { cn } from '../../lib/utils';
import { useAppStore } from '../../store/useAppStore';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';

interface QuickAction {
    id: string;
    label: string;
    command: string;
    icon: LucideIcon;
    description: string;
    type: 'exec' | 'terminal'; // exec = run in background, terminal = paste in terminal
}

const DEFAULT_ACTIONS: QuickAction[] = [
    {
        id: '1',
        label: 'Check Disk Space',
        command: 'df -h',
        icon: Server,
        description: 'Show disk usage summary',
        type: 'exec',
    },
    {
        id: '2',
        label: 'List Docker Containers',
        command: 'docker ps -a',
        icon: Layers,
        description: 'Show all running containers',
        type: 'exec',
    },
    {
        id: '3',
        label: 'Check Listening Ports',
        command: 'netstat -tuln',
        icon: Activity,
        description: 'Show active network ports',
        type: 'exec',
    },
    {
        id: '4',
        label: 'System Updates',
        command: 'apt list --upgradable || yum check-update',
        icon: RefreshCw,
        description: 'Check for available updates',
        type: 'exec',
    },
    {
        id: '5',
        label: 'Active Connections',
        command: 'ss -s',
        icon: Shield,
        description: 'Socket statistics',
        type: 'exec',
    },
    {
        id: '6',
        label: 'Open htop',
        command: 'htop',
        icon: Terminal,
        description: 'Interactive process viewer',
        type: 'terminal',
    },
];

const WINDOWS_ACTIONS: QuickAction[] = [
    {
        id: 'w1',
        label: 'Check Disk Space',
        command: 'powershell "Get-PSDrive -PSProvider FileSystem | Format-Table"',
        icon: Server,
        description: 'Show disk usage',
        type: 'exec',
    },
    {
        id: 'w2',
        label: 'Docker Containers',
        command: 'docker ps -a',
        icon: Layers,
        description: 'Show running containers',
        type: 'exec',
    },
    {
        id: 'w3',
        label: 'Listening Ports',
        command: 'netstat -an | findstr LISTENING',
        icon: Activity,
        description: 'Show listening ports',
        type: 'exec',
    },
    {
        id: 'w4',
        label: 'System Info',
        command: 'systeminfo | findstr /B /C:"OS Name" /C:"OS Version"',
        icon: RefreshCw,
        description: 'Show OS details',
        type: 'exec',
    },
    {
        id: 'w5',
        label: 'Network Connections',
        command: 'netstat -an',
        icon: Shield,
        description: 'Show all connections',
        type: 'exec',
    },
    {
        id: 'w6',
        label: 'Open PowerShell',
        command: 'powershell',
        icon: Terminal,
        description: 'Start PowerShell session',
        type: 'terminal',
    },
];

/** Runs dashboard shortcuts against the connection that owns this widget. */
export function QuickActionsWidget({
    className,
    connectionId,
}: {
    className?: string;
    connectionId: string;
}) {
    const openTab = useAppStore((state) => state.openTab);
    const showToast = useAppStore((state) => state.showToast);
    const [running, setRunning] = useState<string | null>(null);
    const [outputModal, setOutputModal] = useState<{ title: string; output: string } | null>(null);

    /** Sends background commands to the selected host or opens its terminal action. */
    const handleAction = async (action: QuickAction) => {
        if (action.type === 'terminal') {
            openTab(connectionId);
            // Preserve the existing terminal action route after the workspace switch.
            setTimeout(() => {
                window.ipcRenderer.send('terminal:write', {
                    termId: connectionId,
                    data: action.command + '\r',
                });
            }, 500); // Small delay to allow tab switch
            return;
        }

        setRunning(action.id);
        try {
            const output = await window.ipcRenderer.invoke('ssh:exec', {
                connectionId,
                command: action.command,
            });
            setOutputModal({
                title: action.label,
                output: output || 'Command executed successfully (No Output)',
            });
        } catch (err: unknown) {
            const message =
                typeof err === 'object' && err !== null && 'message' in err
                    ? String(err.message)
                    : String(err);
            showToast('error', `Command failed: ${message}`);
            setOutputModal({
                title: `${action.label} (Failed)`,
                output: `Error: ${message}`,
            });
        } finally {
            setRunning(null);
        }
    };

    const isWindowsLocal =
        connectionId === 'local' && navigator.userAgent.indexOf('Windows') !== -1;
    const actions = isWindowsLocal ? WINDOWS_ACTIONS : DEFAULT_ACTIONS;

    return (
        <>
            <section
                aria-label="Quick actions"
                className={cn(
                    '@container/actions min-w-0 rounded-lg border border-app-border bg-app-panel p-4',
                    className,
                )}
            >
                <h3 className="mb-3 flex items-center gap-2 text-xs font-medium text-app-muted">
                    <Play
                        size={14}
                        className="shrink-0"
                        aria-hidden="true"
                    />{' '}
                    Quick actions
                </h3>

                <div className="grid grid-cols-1 gap-2 @[32rem]/actions:grid-cols-2 @[50rem]/actions:grid-cols-3">
                    {actions.map((action) => (
                        <Button
                            key={action.id}
                            type="button"
                            variant="secondary"
                            onClick={() => {
                                void handleAction(action);
                            }}
                            disabled={!!running}
                            isLoading={running === action.id}
                            className="h-auto min-w-0 items-start justify-start gap-3 whitespace-normal p-3 text-left"
                        >
                            {running !== action.id && (
                                <action.icon
                                    size={16}
                                    className="mt-0.5 shrink-0 text-app-muted"
                                    aria-hidden="true"
                                />
                            )}
                            <span className="min-w-0 flex-1">
                                <span className="block text-sm font-medium text-app-text">
                                    {action.label}
                                </span>
                                <span className="mt-1 block text-xs text-app-muted">
                                    {action.description}
                                </span>
                            </span>
                        </Button>
                    ))}
                </div>
            </section>

            <Modal
                isOpen={!!outputModal}
                onClose={() => setOutputModal(null)}
                title={outputModal?.title || ''}
            >
                <div className="max-h-[60vh] overflow-auto rounded-lg border border-app-border bg-app-bg p-4">
                    <pre className="break-all whitespace-pre-wrap font-mono text-xs text-app-text font-ligatures-none">
                        {outputModal?.output}
                    </pre>
                </div>
                <div className="flex justify-end mt-4">
                    <Button
                        variant="secondary"
                        onClick={() => setOutputModal(null)}
                    >
                        Close
                    </Button>
                </div>
            </Modal>
        </>
    );
}
