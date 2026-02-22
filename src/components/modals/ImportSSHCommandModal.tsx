import { useState, useEffect } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { GroupSelector } from '../ui/GroupSelector';
// import { parseSSHCommand } from '../../lib/sshCommandParser'; // Removed
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';

interface ImportSSHCommandModalProps {
    isOpen: boolean;
    onClose: () => void;
    connectionId?: string;
    onImport: () => void;
}

interface ParsedTunnel {
    type: 'local' | 'remote';
    localPort: number;
    remoteHost: string;
    remotePort: number;
    name?: string;
}

interface ParseResult {
    success: boolean;
    tunnels: ParsedTunnel[];
    errors: string[];
}

export function ImportSSHCommandModal({
    isOpen,
    onClose,
    connectionId,
    onImport
}: ImportSSHCommandModalProps) {
    const [command, setCommand] = useState('');
    const [parseResult, setParseResult] = useState<ParseResult | null>(null);
    const [selectedConnectionId, setSelectedConnectionId] = useState<string>(connectionId || '');
    const [group, setGroup] = useState<string | undefined>(undefined);
    const [isImporting, setIsImporting] = useState(false);

    const connections = useAppStore(state => state.connections);
    const tunnels = useAppStore(state => state.tunnels);
    const showToast = useAppStore(state => state.showToast);

    // Reset state when modal opens
    useEffect(() => {
        if (isOpen) {
            setCommand('');
            setParseResult(null);
            setSelectedConnectionId(connectionId || '');
            setGroup(undefined);
            setIsImporting(false);
        }
    }, [isOpen, connectionId]);

    // Parse command when input changes
    useEffect(() => {
        const timer = setTimeout(async () => {
            if (!command.trim()) {
                setParseResult(null);
                return;
            }

            try {
                // Call backend to parse command
                const result = await window.ipcRenderer.invoke('ssh_parse_command', { command }) as ParseResult;
                setParseResult(result);
            } catch (error) {
                console.error('Failed to parse SSH command:', error);
                setParseResult({
                    success: false,
                    tunnels: [],
                    errors: [`Failed to parse command: ${error}`]
                });
            }
        }, 500); // Debounce

        return () => clearTimeout(timer);
    }, [command]);

    const handleImport = async () => {
        if (!parseResult?.success || !selectedConnectionId) return;

        setIsImporting(true);
        try {
            // Save tunnels sequentially to avoid race conditions
            for (const tunnel of parseResult.tunnels) {
                const newTunnel = {
                    id: crypto.randomUUID(),
                    connectionId: selectedConnectionId,
                    name: tunnel.name || `${tunnel.type === 'local' ? 'Local' : 'Remote'} ${tunnel.localPort}:${tunnel.remotePort}`,
                    type: tunnel.type,
                    localPort: tunnel.localPort,
                    remoteHost: tunnel.remoteHost,
                    remotePort: tunnel.remotePort,
                    bindToAny: false,
                    autoStart: false,
                    status: 'stopped',
                    group: group || undefined,
                };

                await window.ipcRenderer.invoke('tunnel_save', newTunnel);
            }

            showToast('success', `Successfully imported ${parseResult.tunnels.length} tunnels`);
            onImport();
            onClose();
        } catch (error) {
            console.error('Failed to save imported tunnels:', error);
            showToast('error', 'Failed to save tunnels');
        } finally {
            setIsImporting(false);
        }
    };

    const hostOptions = connections.map(c => ({
        label: c.name || c.host,
        value: c.id,
        icon: c.icon
    }));

    const existingGroups = Array.from(new Set(
        Object.values(tunnels).flat().map(t => t.group).filter((g): g is string => !!g && g !== 'Ungrouped')
    )).sort();
    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title="Import from SSH Command"
            width="max-w-2xl"
        >
            <div className="space-y-4">
                <div>
                    <label className="text-xs font-semibold text-app-muted uppercase tracking-wider block mb-2 px-1">
                        Paste SSH Command
                    </label>
                    <textarea
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        placeholder="ssh -L 8080:localhost:80 -R 9000:localhost:3000 user@host..."
                        className="w-full h-32 px-3 py-2 text-sm font-mono bg-app-surface border border-app-border rounded-xl focus:outline-none focus:border-app-accent/50 resize-none placeholder:text-app-muted/30"
                        autoFocus
                    />
                    <p className="text-[10px] text-app-muted mt-2 px-1 opacity-70">
                        Supports <code>-L</code> (Local) and <code>-R</code> (Remote) forwarding flags.
                    </p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                    {!connectionId && (
                        <div>
                            <label className="text-xs font-semibold text-app-muted uppercase tracking-wider block mb-2 px-1">
                                Assign to Server
                            </label>
                            <Select
                                placeholder="Select server..."
                                value={selectedConnectionId}
                                onChange={setSelectedConnectionId}
                                options={hostOptions}
                            />
                        </div>
                    )}
                    <div className={!connectionId ? "" : "col-span-2"}>
                        <label className="text-xs font-semibold text-app-muted uppercase tracking-wider block mb-2 px-1">
                            Assign Group
                        </label>
                        <GroupSelector
                            value={group || ''}
                            onChange={setGroup}
                            existingGroups={existingGroups}
                            placeholder="Optional group name..."
                        />
                    </div>
                </div>

                {/* Preview Section */}
                {parseResult && (
                    <div className="mt-4 pt-4 border-t border-app-border/30">
                        <h4 className="text-xs font-semibold text-app-text mb-3 flex items-center gap-2">
                            {parseResult.success ? (
                                <>
                                    <CheckCircle2 size={14} className="text-app-success" />
                                    <span>Found {parseResult.tunnels.length} Tunnels</span>
                                </>
                            ) : (
                                <>
                                    <AlertCircle size={14} className="text-red-400" />
                                    <span className="text-red-400">Parse Error</span>
                                </>
                            )}
                        </h4>

                        {parseResult.success ? (
                            <div className="space-y-2 max-h-[150px] overflow-y-auto pr-1">
                                {parseResult.tunnels.map((t, i) => (
                                    <div key={i} className="flex items-center gap-3 p-2 rounded bg-app-surface/50 border border-app-border/20 text-xs text-app-muted">
                                        <div className="flex items-center gap-1.5 font-mono">
                                            <span className="text-app-text/90 font-bold">{t.type === 'local' ? t.localPort : t.remotePort}</span>
                                            <span className="text-app-muted/50">→</span>
                                            <span className="text-app-text/90 font-bold">
                                                {t.type === 'local' ? `${t.remoteHost}:${t.remotePort}` : `localhost:${t.localPort}`}
                                            </span>
                                        </div>
                                        <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider ${t.type === 'remote'
                                            ? 'bg-purple-500/10 text-purple-400 border border-purple-500/20'
                                            : 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                                            }`}>
                                            {t.type}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="p-3 rounded bg-red-500/5 border border-red-500/10 text-xs text-red-400">
                                <ul className="list-disc list-inside space-y-1">
                                    {parseResult.errors.map((err, i) => (
                                        <li key={i}>{err}</li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </div>
                )}

                <div className="flex justify-end gap-3 pt-2">
                    <Button variant="ghost" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        onClick={handleImport}
                        disabled={!parseResult?.success || !selectedConnectionId || isImporting}
                        className="bg-app-accent hover:bg-app-accent/90"
                    >
                        {isImporting ? 'Importing...' : 'Import Tunnels'}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
