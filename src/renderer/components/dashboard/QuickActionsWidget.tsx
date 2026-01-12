import { useState } from 'react';
import { Play, Terminal, Shield, RefreshCw, Activity, Layers, Server } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { useAppStore } from '../../store/useAppStore';
import { Modal } from '../ui/Modal';

interface QuickAction {
    id: string;
    label: string;
    command: string;
    icon: any;
    description: string;
    type: 'exec' | 'terminal'; // exec = run in background, terminal = paste in terminal
}

const DEFAULT_ACTIONS: QuickAction[] = [
    { id: '1', label: 'Check Disk Space', command: 'df -h', icon: Server, description: 'Show disk usage summary', type: 'exec' },
    { id: '2', label: 'List Docker Containers', command: 'docker ps -a', icon: Layers, description: 'Show all running containers', type: 'exec' },
    { id: '3', label: 'Check Listening Ports', command: 'netstat -tuln', icon: Activity, description: 'Show active network ports', type: 'exec' },
    { id: '4', label: 'System Updates', command: 'apt list --upgradable || yum check-update', icon: RefreshCw, description: 'Check for available updates', type: 'exec' },
    { id: '5', label: 'Active Connections', command: 'ss -s', icon: Shield, description: 'Socket statistics', type: 'exec' },
    { id: '6', label: 'Open htop', command: 'htop', icon: Terminal, description: 'Interactive process viewer', type: 'terminal' },
];

const WINDOWS_ACTIONS: QuickAction[] = [
    { id: 'w1', label: 'Check Disk Space', command: 'powershell "Get-PSDrive -PSProvider FileSystem | Format-Table"', icon: Server, description: 'Show disk usage', type: 'exec' },
    { id: 'w2', label: 'Docker Containers', command: 'docker ps -a', icon: Layers, description: 'Show running containers', type: 'exec' },
    { id: 'w3', label: 'Listening Ports', command: 'netstat -an | findstr LISTENING', icon: Activity, description: 'Show listening ports', type: 'exec' },
    { id: 'w4', label: 'System Info', command: 'systeminfo | findstr /B /C:"OS Name" /C:"OS Version"', icon: RefreshCw, description: 'Show OS details', type: 'exec' },
    { id: 'w5', label: 'Network Connections', command: 'netstat -an', icon: Shield, description: 'Show all connections', type: 'exec' },
    { id: 'w6', label: 'Open PowerShell', command: 'powershell', icon: Terminal, description: 'Start PowerShell session', type: 'terminal' },
];

export function QuickActionsWidget({ className, connectionId }: { className?: string; connectionId: string }) {
    const openTab = useAppStore(state => state.openTab);
    const showToast = useAppStore((state) => state.showToast);
    const [running, setRunning] = useState<string | null>(null);
    const [outputModal, setOutputModal] = useState<{ title: string; output: string } | null>(null);

    const handleAction = async (action: QuickAction) => {
        if (action.type === 'terminal') {
            openTab(connectionId);
            // Ideally we'd paste it in too, but we need access to the terminal instance. 
            // For now, simple context switch is okay, or we can use IPC to send 'write' event.
            // window.ipcRenderer.send('terminal:write', { termId: connectionId, data: action.command + '\r' });
            // The logic above assumes the termId matches connectionId (which it does in our MainLayout).
            setTimeout(() => {
                window.ipcRenderer.send('terminal:write', { termId: connectionId, data: action.command + '\r' });
            }, 500); // Small delay to allow tab switch
            return;
        }

        setRunning(action.id);
        try {
            const output = await window.ipcRenderer.invoke('ssh:exec', {
                id: connectionId,
                command: action.command
            });
            setOutputModal({
                title: action.label,
                output: output || 'Command executed successfully (No Output)'
            });
        } catch (err: any) {
            showToast('error', `Command failed: ${err.message}`);
            setOutputModal({
                title: `${action.label} (Failed)`,
                output: `Error: ${err.message}`
            });
        } finally {
            setRunning(null);
        }
    };

    const isWindowsLocal = connectionId === 'local' && navigator.userAgent.indexOf('Windows') !== -1;
    const actions = isWindowsLocal ? WINDOWS_ACTIONS : DEFAULT_ACTIONS;

    return (
        <>
            <div className={cn("bg-app-panel border border-app-border rounded-2xl p-6 shadow-sm backdrop-blur-xl bg-opacity-60 flex flex-col", className)}>
                <h3 className="text-xs font-medium text-app-muted uppercase tracking-wider flex items-center gap-2 mb-4">
                    <Play size={14} /> Quick Actions
                </h3>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {actions.map(action => (
                        <button
                            key={action.id}
                            onClick={() => handleAction(action)}
                            disabled={!!running}
                            className="flex items-start gap-3 p-3 rounded-xl border border-app-border/50 bg-app-surface/30 hover:bg-app-accent/10 hover:border-app-accent/30 transition-all text-left group"
                        >
                            <div className={cn(
                                "p-2 rounded-lg transition-colors",
                                "bg-app-surface group-hover:bg-app-accent/20 text-app-accent"
                            )}>
                                <action.icon size={18} />
                            </div>
                            <div>
                                <div className="font-semibold text-sm text-app-text group-hover:text-app-accent transition-colors flex items-center gap-2">
                                    {action.label}
                                    {running === action.id && <div className="w-3 h-3 rounded-full border-2 border-app-accent border-t-transparent animate-spin" />}
                                </div>
                                <div className="text-xs text-app-muted mt-0.5 line-clamp-1 group-hover:text-app-muted/80">
                                    {action.description}
                                </div>
                            </div>
                        </button>
                    ))}
                </div>
            </div>

            <Modal
                isOpen={!!outputModal}
                onClose={() => setOutputModal(null)}
                title={outputModal?.title || ''}
            >
                <div className="bg-[#0f111a] p-4 rounded-lg border border-app-border overflow-auto max-h-[60vh]">
                    <pre className="font-mono text-xs text-green-400 break-all whitespace-pre-wrap font-ligatures-none">
                        {outputModal?.output}
                    </pre>
                </div>
                <div className="flex justify-end mt-4">
                    <Button onClick={() => setOutputModal(null)}>Close</Button>
                </div>
            </Modal>
        </>
    );
}
