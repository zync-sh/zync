import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { OSIcon } from '../../../components/icons/OSIcon';
import { Button } from '../../../components/ui/Button';
import { Modal } from '../../../components/ui/Modal';
import { Select } from '../../../components/ui/Select';
import { LOCAL_TERMINAL_CONNECTION_ID } from '../../../lib/terminal/connectionIds';
import { useAppStore } from '../../../store/useAppStore';
import { getConnectionDisplayLabels } from '../../connections/domain/connectionDisplay';
import { useShowHostAddressesInLists } from '../../connections/presentation/useConnectionDisplayLabels';

/** Selecting a saved SSH host opens setup only; connection and assessment approval remain separate actions. */
export function NewAuditDialog({ onClose, onChoose }: { onClose(): void; onChoose(connectionId: string): void }) {
    const connections = useAppStore(state => state.connections);
    const openConnectionModal = useAppStore(state => state.openConnectionModal);
    const showHostAddresses = useShowHostAddressesInLists();
    const [selected, setSelected] = useState('');
    const hosts = useMemo(() => connections.filter(connection => connection.id !== LOCAL_TERMINAL_CONNECTION_ID && Boolean(connection.host.trim())), [connections]);
    const options = useMemo(() => hosts.map(connection => {
        const labels = getConnectionDisplayLabels(connection, showHostAddresses);
        return {
            value: connection.id,
            label: labels.primary || 'Unknown host',
            description: labels.secondary,
            icon: <OSIcon icon={connection.icon || 'Server'} className="h-4 w-4" />,
        };
    }), [hosts, showHostAddresses]);
    const available = hosts.some(connection => connection.id === selected);

    return <Modal isOpen title="New audit" subtitle="Choose a Linux SSH host" onClose={onClose} width="max-w-md">
        <form className="space-y-5" onSubmit={event => {
            event.preventDefault();
            const current = useAppStore.getState().connections.find(connection => connection.id === selected);
            if (!current || current.id === LOCAL_TERMINAL_CONNECTION_ID || !current.host.trim()) { setSelected(''); return; }
            onChoose(current.id);
        }}>
            {hosts.length > 0 ? <Select label="Host" ariaLabel="Host to audit" value={available ? selected : ''}
                onChange={setSelected} options={options} placeholder="Choose a host" showSearch portal />
                : <div className="space-y-3 text-xs text-app-muted">
                    <p>No saved SSH hosts yet.</p>
                    <Button variant="secondary" size="sm" type="button" onClick={() => { onClose(); openConnectionModal(); }}>
                        <Plus size={13} className="mr-2" aria-hidden="true" />Add host
                    </Button>
                </div>}
            <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
                <Button type="submit" disabled={!available}>Continue</Button>
            </div>
        </form>
    </Modal>;
}
