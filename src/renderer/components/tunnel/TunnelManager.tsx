import { Network, Play, Plus, Square, Trash2, ArrowRight, Laptop, Server as ServerIcon, Edit2, Zap, ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useConnections } from '../../context/ConnectionContext';
import { useToast } from '../../context/ToastContext';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { cn } from '../../lib/utils';

interface TunnelConfig {
  id: string;
  connectionId: string;
  name: string;
  type: 'local' | 'remote';
  localPort: number;
  remoteHost: string;
  remotePort: number;
  status: 'active' | 'error' | 'stopped';
  autoStart?: boolean;
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
  const [editingTunnelId, setEditingTunnelId] = useState<string | null>(null);
  const [newTunnel, setNewTunnel] = useState({
    name: '',
    type: 'local' as 'local' | 'remote',
    localPort: '8080',
    remoteHost: '127.0.0.1',
    remotePort: '80',
    autoStart: false,
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
  }, [activeConnectionId]);

  const handleCreateNew = () => {
    setEditingTunnelId(null);
    setNewTunnel({
      name: '',
      type: 'local',
      localPort: '8080',
      remoteHost: '127.0.0.1',
      remotePort: '80',
      autoStart: false,
    });
    setIsCreating(true);
  };

  const handleEditTunnel = (tunnel: TunnelConfig) => {
    if (tunnel.status === 'active') {
      showToast('error', 'Stop the tunnel before editing');
      return;
    }
    setEditingTunnelId(tunnel.id);
    setNewTunnel({
      name: tunnel.name,
      type: tunnel.type || 'local',
      localPort: tunnel.localPort.toString(),
      remoteHost: tunnel.remoteHost,
      remotePort: tunnel.remotePort.toString(),
      autoStart: !!tunnel.autoStart,
    });
    setIsCreating(true);
  };

  const handleSaveTunnel = async () => {
    if (!activeConnectionId) return;

    const localPort = parseInt(newTunnel.localPort, 10);
    const remotePort = parseInt(newTunnel.remotePort, 10);

    if (Number.isNaN(localPort) || Number.isNaN(remotePort)) {
      showToast('error', 'Ports must be numbers');
      return;
    }

    const config: TunnelConfig = {
      id: editingTunnelId || crypto.randomUUID(),
      connectionId: activeConnectionId,
      name: newTunnel.name || (newTunnel.type === 'local' ? `Local ${localPort} -> Remote ${remotePort}` : `Remote ${remotePort} -> Local ${localPort}`),
      type: newTunnel.type,
      localPort,
      remoteHost: newTunnel.remoteHost,
      remotePort,
      autoStart: newTunnel.autoStart,
      status: 'stopped',
    };

    setLoading(true);
    try {
      await window.ipcRenderer.invoke('tunnel:save', config);
      showToast('success', editingTunnelId ? 'Tunnel updated' : 'Tunnel saved');
      setIsCreating(false);
      setEditingTunnelId(null);
      setNewTunnel({
        name: '',
        type: 'local',
        localPort: '',
        remoteHost: '127.0.0.1',
        remotePort: '',
        autoStart: false,
      });
      loadTunnels();
    } catch (error: any) {
      showToast('error', `Failed to save tunnel: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenBrowser = async (port: number) => {
    try {
      await window.ipcRenderer.invoke('shell:open', `http://localhost:${port}`);
    } catch (e) {
      console.error('Failed to open browser', e);
    }
  };

  const handleToggleTunnel = async (tunnel: TunnelConfig) => {
    try {
      if (tunnel.status === 'active') {
        await window.ipcRenderer.invoke('tunnel:stop', tunnel.id);
        showToast('info', 'Tunnel stopped');
      } else {
        await window.ipcRenderer.invoke('tunnel:start', tunnel.id);
        const port = tunnel.type === 'local' ? tunnel.localPort : tunnel.remotePort;
        showToast('success', `Tunnel started on port ${port}`);
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

  return (
    <div className="flex flex-col h-full bg-app-bg">
      {/* Header */}
      <div className="p-4 border-b border-app-border flex justify-between items-center bg-app-panel">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Network size={20} className="text-app-accent" />
          SSH Tunnels
        </h2>
        <Button onClick={handleCreateNew} disabled={isCreating}>
          <Plus size={16} className="mr-2" /> New Tunnel
        </Button>
      </div>

      {/* Creation Form */}
      {isCreating && (
        <div className="p-4 border-b border-app-border bg-app-surface/30 animate-in slide-in-from-top-2">
          <div className="flex flex-col gap-4">

            {/* Top Row: Type & Name */}
            <div className="flex items-start gap-4">
              {/* Type Toggle */}
              <div className="flex-shrink-0 p-1 bg-app-bg/50 rounded-lg border border-app-border">
                <div className="flex gap-1">
                  <button
                    onClick={() => setNewTunnel({ ...newTunnel, type: 'local', remoteHost: '127.0.0.1' })}
                    className={cn(
                      "px-3 py-1.5 text-xs font-medium rounded-md transition-all flex items-center gap-2",
                      newTunnel.type === 'local' ? "bg-app-accent text-white shadow-sm" : "text-app-muted hover:text-app-text hover:bg-white/5"
                    )}
                  >
                    <Laptop size={14} />
                    Local Forwarding
                  </button>
                  <button
                    onClick={() => setNewTunnel({ ...newTunnel, type: 'remote', remoteHost: '0.0.0.0' })}
                    className={cn(
                      "px-3 py-1.5 text-xs font-medium rounded-md transition-all flex items-center gap-2",
                      newTunnel.type === 'remote' ? "bg-app-accent text-white shadow-sm" : "text-app-muted hover:text-app-text hover:bg-white/5"
                    )}
                  >
                    <ServerIcon size={14} />
                    Remote Forwarding
                  </button>
                </div>
              </div>

              {/* Name Input - Takes remaining width */}
              <div className="flex-1">
                <Input
                  placeholder="Tunnel Name (Optional)"
                  value={newTunnel.name}
                  onChange={(e) => setNewTunnel({ ...newTunnel, name: e.target.value })}
                />
              </div>
            </div>

            {/* Middle Row: Port Configuration */}
            <div className="grid grid-cols-12 gap-4 items-end bg-app-bg/30 p-3 rounded-md border border-app-border/50">
              {newTunnel.type === 'local' ? (
                <>
                  <div className="col-span-3">
                    <Input
                      label="Local Port"
                      placeholder="8080"
                      value={newTunnel.localPort}
                      onChange={(e) => setNewTunnel({ ...newTunnel, localPort: e.target.value })}
                    />
                  </div>
                  {/* Arrow/Visual */}
                  <div className="col-span-1 flex justify-center items-center h-10 text-app-muted/50 pb-1">
                    <ArrowRight size={16} />
                  </div>
                  <div className="col-span-5">
                    <Input
                      label="Destination Host"
                      placeholder="127.0.0.1"
                      value={newTunnel.remoteHost}
                      onChange={(e) => setNewTunnel({ ...newTunnel, remoteHost: e.target.value })}
                    />
                  </div>
                  <div className="col-span-3">
                    <Input
                      label="Dest Port"
                      placeholder="80"
                      value={newTunnel.remotePort}
                      onChange={(e) => setNewTunnel({ ...newTunnel, remotePort: e.target.value })}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="col-span-3">
                    <Input
                      label="Remote Port"
                      placeholder="9090"
                      value={newTunnel.remotePort}
                      onChange={(e) => setNewTunnel({ ...newTunnel, remotePort: e.target.value })}
                    />
                  </div>
                  {/* Arrow/Visual */}
                  <div className="col-span-1 flex justify-center items-center h-10 text-app-muted/50 pb-1">
                    <ArrowRight size={16} />
                  </div>
                  <div className="col-span-5">
                    <Input
                      label="Bind Address (on Server)"
                      placeholder="0.0.0.0"
                      value={newTunnel.remoteHost}
                      onChange={(e) => setNewTunnel({ ...newTunnel, remoteHost: e.target.value })}
                    />
                  </div>
                  <div className="col-span-3">
                    <Input
                      label="Local Port"
                      placeholder="3000"
                      value={newTunnel.localPort}
                      onChange={(e) => setNewTunnel({ ...newTunnel, localPort: e.target.value })}
                    />
                  </div>
                </>
              )}
            </div>

            {/* Footer Row: Helper Text & Actions */}
            <div className="flex justify-between items-center bg-app-panel/50 p-2 rounded-md">
              {/* Helper Text */}
              <div className="text-xs text-app-muted flex items-center gap-4 px-2">
                <div className="flex items-center gap-2">
                  {newTunnel.type === 'local' ? (
                    <>
                      <Laptop size={12} className="text-app-accent" />
                      <span className="font-medium text-app-text">This Computer</span>
                      <span className="text-app-muted">(:{newTunnel.localPort || '8080'})</span>
                      <ArrowRight size={12} />
                      <ServerIcon size={12} />
                      <span className="font-medium text-app-text">Remote Server</span>
                      <span className="text-app-muted">({newTunnel.remoteHost || '127.0.0.1'}:{newTunnel.remotePort || '80'})</span>
                    </>
                  ) : (
                    <>
                      <ServerIcon size={12} className="text-app-accent" />
                      <span className="font-medium text-app-text">Remote Server</span>
                      <span className="text-app-muted">(:{newTunnel.remotePort || '9090'})</span>
                      <ArrowRight size={12} />
                      <Laptop size={12} />
                      <span className="font-medium text-app-text">This Computer</span>
                      <span className="text-app-muted">(127.0.0.1:{newTunnel.localPort || '3000'})</span>
                    </>
                  )}
                </div>

                {/* Auto Start Checkbox */}
                <label className="flex items-center gap-2 cursor-pointer hover:text-app-text transition-colors">
                  <input
                    type="checkbox"
                    checked={newTunnel.autoStart}
                    onChange={(e) => setNewTunnel({ ...newTunnel, autoStart: e.target.checked })}
                    className="rounded border-app-border bg-app-bg text-app-accent focus:ring-app-accent/30 w-3.5 h-3.5"
                  />
                  <span>Auto-Start</span>
                </label>
              </div>

              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => { setIsCreating(false); setEditingTunnelId(null); }}>
                  Cancel
                </Button>
                <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white min-w-[80px]" onClick={handleSaveTunnel} isLoading={loading}>
                  {editingTunnelId ? 'Update' : 'Save'}
                </Button>
              </div>
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
                    className={cn(
                      "w-2 h-2 rounded-full transition-all",
                      tunnel.status === 'active' ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]' : 'bg-red-500'
                    )}
                  />
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-[var(--color-app-text)]">{tunnel.name}</span>
                      <span className={cn(
                        "text-[10px] px-1.5 py-0.5 rounded font-mono uppercase tracking-wider",
                        tunnel.type === 'remote' ? "bg-purple-500/10 text-purple-400 border border-purple-500/20" : "bg-blue-500/10 text-blue-400 border border-blue-500/20"
                      )}>
                        {tunnel.type === 'remote' ? 'Remote' : 'Local'}
                      </span>
                      {tunnel.autoStart && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded font-mono uppercase tracking-wider bg-yellow-500/10 text-yellow-400 border border-yellow-500/20 flex items-center gap-1">
                          <Zap size={8} fill="currentColor" /> Auto
                        </span>
                      )}
                    </div>
                    <div className="text-sm text-app-muted flex items-center gap-2 font-mono">
                      {tunnel.type === 'local' ? (
                        <>
                          <span className="text-app-accent">Loc:{tunnel.localPort}</span>
                          <ArrowRight size={12} />
                          <span>Rem:{tunnel.remoteHost}:{tunnel.remotePort}</span>
                        </>
                      ) : (
                        <>
                          <span className="text-purple-400">Rem:{tunnel.remotePort}</span>
                          <ArrowRight size={12} />
                          <span>Loc:127.0.0.1:{tunnel.localPort}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {tunnel.error && (
                    <div className="text-xs text-red-400 mr-2 max-w-[200px] truncate" title={tunnel.error}>
                      {tunnel.error}
                    </div>
                  )}

                  {/* Open in Browser (only for active local tunnels) */}
                  {tunnel.type === 'local' && (
                    <button
                      onClick={() => handleOpenBrowser(tunnel.localPort)}
                      className="p-2 text-app-muted hover:text-blue-400 rounded hover:bg-app-surface transition-colors"
                      title="Open in Browser"
                    >
                      <ExternalLink size={16} />
                    </button>
                  )}

                  <button
                    onClick={() => handleToggleTunnel(tunnel)}
                    className={`p-2 rounded transition-colors ${tunnel.status === 'active' ? 'text-green-400 hover:bg-green-400/10' : 'text-app-muted hover:text-[var(--color-app-text)] hover:bg-app-surface'}`}
                    title={tunnel.status === 'active' ? 'Stop Tunnel' : 'Start Tunnel'}
                  >
                    {tunnel.status === 'active' ? (
                      <Square size={16} fill="currentColor" />
                    ) : (
                      <Play size={16} fill="currentColor" />
                    )}
                  </button>

                  <button
                    onClick={() => handleEditTunnel(tunnel)}
                    className="p-2 text-app-muted hover:text-app-accent rounded hover:bg-app-surface transition-colors"
                    title="Edit Tunnel"
                  >
                    <Edit2 size={16} />
                  </button>

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
