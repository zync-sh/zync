import { Network, Play, Plus, Square, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useConnections } from '../../context/ConnectionContext';
import { useToast } from '../../context/ToastContext';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

interface TunnelConfig {
  id: string;
  connectionId: string;
  name: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  status: 'active' | 'error' | 'stopped';
  error?: string;
}

export function TunnelManager({ connectionId }: { connectionId?: string }) {
  const { activeConnectionId: globalId } = useConnections();
  const activeConnectionId = connectionId || globalId;
  const { showToast } = useToast();

  const [tunnels, setTunnels] = useState<TunnelConfig[]>([]);
  const [loading, setLoading] = useState(false);

  // Form State
  const [isCreating, setIsCreating] = useState(false);
  const [newTunnel, setNewTunnel] = useState({
    name: '',
    localPort: '8080',
    remoteHost: '127.0.0.1',
    remotePort: '80',
  });



  const loadTunnels = async () => {
    if (!activeConnectionId) return;
    try {
      const list = await window.ipcRenderer.invoke('tunnel:list', activeConnectionId);
      setTunnels(list);
    } catch (error) {
      console.error('Failed to load tunnels', error);
    }
  };

  useEffect(() => {
    if (activeConnectionId) {
      loadTunnels();
    }
  }, [activeConnectionId]); // Removed loadTunnels from deps to avoid infinite loop or need for useCallback


  const handleSaveTunnel = async () => {
    if (!activeConnectionId) return;

    const localPort = parseInt(newTunnel.localPort, 10);
    const remotePort = parseInt(newTunnel.remotePort, 10);

    if (Number.isNaN(localPort) || Number.isNaN(remotePort)) {
      showToast('error', 'Ports must be numbers');
      return;
    }

    const config: TunnelConfig = {
      id: crypto.randomUUID(),
      connectionId: activeConnectionId,
      name: newTunnel.name || `Tunnel ${localPort}:${remotePort}`,
      localPort,
      remoteHost: newTunnel.remoteHost,
      remotePort,
      status: 'stopped', // Default to stopped
    };

    setLoading(true);
    try {
      await window.ipcRenderer.invoke('tunnel:save', config);
      showToast('success', 'Tunnel definition saved');
      setIsCreating(false);
      setNewTunnel({
        name: '',
        localPort: '',
        remoteHost: '127.0.0.1',
        remotePort: '',
      });
      loadTunnels();
    } catch (error: any) {
      showToast('error', `Failed to save tunnel: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleTunnel = async (tunnel: TunnelConfig) => {
    try {
      if (tunnel.status === 'active') {
        await window.ipcRenderer.invoke('tunnel:stop', tunnel.id);
        showToast('info', 'Tunnel stopped');
      } else {
        await window.ipcRenderer.invoke('tunnel:start', tunnel.id);
        showToast('success', `Tunnel started on port ${tunnel.localPort}`);
      }
      loadTunnels();
    } catch (error: any) {
      showToast('error', `Tunnel action failed: ${error.message}`);
    }
  };

  const handleDeleteTunnel = async (id: string) => {
    if (!confirm('Are you sure you want to delete this tunnel?')) return;
    try {
      await window.ipcRenderer.invoke('tunnel:delete', id);
      showToast('success', 'Tunnel deleted');
      loadTunnels();
    } catch (error: any) {
      showToast('error', `Failed to delete tunnel: ${error.message}`);
    }
  };

  // ...

  return (
    <div className="flex flex-col h-full bg-app-bg">
      {/* Header */}
      <div className="p-4 border-b border-app-border flex justify-between items-center bg-app-panel">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Network size={20} className="text-app-accent" />
          SSH Tunnels
        </h2>
        <Button onClick={() => setIsCreating(true)} disabled={isCreating}>
          <Plus size={16} className="mr-2" /> New Tunnel
        </Button>
      </div>

      {/* Creation Form */}
      {isCreating && (
        <div className="p-4 border-b border-app-border bg-app-surface/30 animate-in slide-in-from-top-2">
          <div className="grid grid-cols-12 gap-4 items-end">
            <div className="col-span-3">
              <Input
                label="Name (Optional)"
                placeholder="My Web App"
                value={newTunnel.name}
                onChange={(e) => setNewTunnel({ ...newTunnel, name: e.target.value })}
              />
            </div>
            <div className="col-span-2">
              <Input
                label="Local Port"
                placeholder="8080"
                value={newTunnel.localPort}
                onChange={(e) => setNewTunnel({ ...newTunnel, localPort: e.target.value })}
              />
            </div>
            <div className="col-span-3">
              <Input
                label="Remote Host"
                placeholder="127.0.0.1"
                value={newTunnel.remoteHost}
                onChange={(e) => setNewTunnel({ ...newTunnel, remoteHost: e.target.value })}
              />
            </div>
            <div className="col-span-2">
              <Input
                label="Remote Port"
                placeholder="80"
                value={newTunnel.remotePort}
                onChange={(e) => setNewTunnel({ ...newTunnel, remotePort: e.target.value })}
              />
            </div>
            <div className="col-span-2 flex gap-2">
              <Button className="w-full bg-green-600 hover:bg-green-700" onClick={handleSaveTunnel} isLoading={loading}>
                Save
              </Button>
              <Button variant="ghost" onClick={() => setIsCreating(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-auto p-4">
        {tunnels.length === 0 ? (
          <div className="text-center text-app-muted mt-20">
            <p>No saved tunnels.</p>
            <p className="text-sm">Click "New Tunnel" to create one.</p>
          </div>
        ) : (
          <div className="grid gap-4">
            {tunnels.map((tunnel) => (
              <div
                key={tunnel.id}
                className="bg-app-panel border border-app-border rounded-lg p-4 flex items-center justify-between group"
              >
                <div className="flex items-center gap-4">
                  <div
                    className={`w-2 h-2 rounded-full ${tunnel.status === 'active' ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]' : 'bg-red-500'}`}
                  />
                  <div>
                    <div className="font-medium text-white">{tunnel.name}</div>
                    <div className="text-sm text-app-muted flex items-center gap-2 font-mono">
                      <span className="text-app-accent">127.0.0.1:{tunnel.localPort}</span>
                      <span>→</span>
                      <span>
                        {tunnel.remoteHost}:{tunnel.remotePort}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {/* Toggle Button */}
                  <button
                    onClick={() => handleToggleTunnel(tunnel)}
                    className={`p-2 rounded transition-colors ${tunnel.status === 'active' ? 'text-green-400 hover:bg-green-400/10' : 'text-app-muted hover:text-white hover:bg-app-surface'}`}
                    title={tunnel.status === 'active' ? 'Stop Tunnel' : 'Start Tunnel'}
                  >
                    {tunnel.status === 'active' ? (
                      <Square size={16} fill="currentColor" />
                    ) : (
                      <Play size={16} fill="currentColor" />
                    )}
                  </button>

                  {/* Delete Button */}
                  <button
                    onClick={() => handleDeleteTunnel(tunnel.id)}
                    className="p-2 text-app-muted hover:text-red-400 rounded hover:bg-app-surface transition-colors"
                    title="Delete Tunnel"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
