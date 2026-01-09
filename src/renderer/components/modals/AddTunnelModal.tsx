import { useState, useEffect } from 'react';
import { Server, ArrowRight } from 'lucide-react';
import { useConnections } from '../../context/ConnectionContext';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { useToast } from '../../context/ToastContext';
import { Modal } from '../ui/Modal';

interface AddTunnelModalProps {
    isOpen: boolean;
    onClose: () => void;
    initialConnectionId?: string; // Pre-select if opened from context
}

export function AddTunnelModal({ isOpen, onClose, initialConnectionId }: AddTunnelModalProps) {
    const { connections } = useConnections();
    const { showToast } = useToast();

    // Form State
    const [selectedConnectionId, setSelectedConnectionId] = useState(initialConnectionId || '');
    const [name, setName] = useState('');
    const [localPort, setLocalPort] = useState('8080');
    const [remoteHost, setRemoteHost] = useState('127.0.0.1');
    const [remotePort, setRemotePort] = useState('80');
    const [bindToAny, setBindToAny] = useState(false);
    const [autoStart, setAutoStart] = useState(false);

    // Update selection if prop changes
    useEffect(() => {
        if (initialConnectionId) setSelectedConnectionId(initialConnectionId);
    }, [initialConnectionId]);

    // Reset form on open
    useEffect(() => {
        if (isOpen) {
            if (!initialConnectionId) setSelectedConnectionId('');
            setName('');
            setLocalPort('8080');
            setRemoteHost('127.0.0.1');
            setRemotePort('80');
            setBindToAny(false);
            setAutoStart(false);
        }
    }, [isOpen]);

    const handleSave = async () => {
        if (!selectedConnectionId) {
            showToast('error', 'Please select a host');
            return;
        }
        if (!name) {
            showToast('error', 'Tunnel Name is required');
            return;
        }

        try {
            await window.ipcRenderer.invoke('tunnel:save', {
                id: crypto.randomUUID(),
                connectionId: selectedConnectionId,
                name,
                type: 'local', // Defaulting to Local for simplicity for now
                localPort: parseInt(localPort),
                remoteHost,
                remotePort: parseInt(remotePort),
                bindToAny,
                autoStart,
                status: 'stopped'
            });
            showToast('success', 'Tunnel created successfully');
            onClose();
        } catch (error: any) {
            showToast('error', `Failed to create tunnel: ${error.message}`);
        }
    };

    // Filter only valid SSH connections (ignore groups/folders if any, though context returns connections)
    const validConnections = connections.filter(c => c.host);

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Create New Tunnel">
            <div className="p-4 space-y-4">
                {/* Host Selection */}
                <div className="space-y-2">
                    <label className="text-xs font-medium text-app-muted uppercase tracking-wider">Host</label>
                    <div className="relative">
                        <select
                            value={selectedConnectionId}
                            onChange={(e) => setSelectedConnectionId(e.target.value)}
                            className="w-full bg-app-surface/50 border border-app-border rounded-lg pl-3 pr-8 py-2 text-sm text-app-text appearance-none focus:border-app-accent focus:outline-none"
                        >
                            <option value="" disabled>Select a Host...</option>
                            {validConnections.map(conn => (
                                <option key={conn.id} value={conn.id}>
                                    {conn.name || conn.host} ({conn.username}@{conn.host})
                                </option>
                            ))}
                        </select>
                        <Server className="absolute right-3 top-1/2 -translate-y-1/2 text-app-muted pointer-events-none" size={14} />
                    </div>
                </div>

                {/* Tunnel Details */}
                <div className="space-y-4 pt-2 border-t border-app-border/30">
                    <div className="space-y-2">
                        <label className="text-xs font-medium text-app-muted uppercase tracking-wider">Tunnel Name</label>
                        <Input
                            placeholder="e.g. Web Server, DB Access"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            autoFocus
                        />
                    </div>

                    <div className="grid grid-cols-[1fr,auto,1fr] gap-2 items-end">
                        <div className="space-y-2">
                            <label className="text-xs font-medium text-app-muted uppercase tracking-wider">Local Port</label>
                            <Input
                                type="number"
                                placeholder="8080"
                                value={localPort}
                                onChange={(e) => setLocalPort(e.target.value)}
                            />
                        </div>
                        <div className="pb-3 text-app-muted">
                            <ArrowRight size={16} />
                        </div>
                        <div className="space-y-2">
                            <label className="text-xs font-medium text-app-muted uppercase tracking-wider">Remote Port</label>
                            <Input
                                type="number"
                                placeholder="80"
                                value={remotePort}
                                onChange={(e) => setRemotePort(e.target.value)}
                            />
                        </div>
                    </div>

                    <div className="space-y-2">
                        <label className="text-xs font-medium text-app-muted uppercase tracking-wider">Remote Host (on server)</label>
                        <Input
                            placeholder="127.0.0.1"
                            value={remoteHost}
                            onChange={(e) => setRemoteHost(e.target.value)}
                        />
                    </div>
                </div>

                {/* Options */}
                <div className="space-y-3 pt-2">
                    <label className="flex items-center gap-2 cursor-pointer group">
                        <input
                            type="checkbox"
                            checked={bindToAny}
                            onChange={e => setBindToAny(e.target.checked)}
                            className="rounded border-app-border bg-app-surface text-app-accent focus:ring-offset-app-bg focus:ring-app-accent"
                        />
                        <span className="text-sm text-app-text group-hover:text-app-accent transition-colors">Allow LAN Access (Bind 0.0.0.0)</span>
                    </label>
                </div>

                {/* Footer */}
                <div className="flex justify-end gap-3 pt-4 mt-2 border-t border-app-border/30">
                    <Button variant="ghost" onClick={onClose}>Cancel</Button>
                    <Button
                        onClick={handleSave}
                        className="bg-app-accent text-white hover:bg-app-accent/90"
                    >
                        Create Tunnel
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
