import { useEffect, useState, useRef } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Button } from '../ui/Button';
import { cn } from '../../lib/utils';
import { ExternalLink, ArrowRight, Plus, Network, Trash2, ChevronDown } from 'lucide-react';
import { TUNNEL_PRESETS, TunnelPreset } from '../../lib/tunnelPresets';
import { AddTunnelModal } from '../modals/AddTunnelModal';
import { Modal } from '../ui/Modal';

// Re-using interface to ensure type safety, though it's in store usually
interface TunnelConfig {
  id: string;
  connectionId: string;
  name: string;
  type: 'local' | 'remote';
  localPort: number;
  remoteHost: string;
  remotePort: number;
  bindToAny?: boolean;
  status: 'active' | 'error' | 'stopped';
  autoStart?: boolean;
  error?: string;
  originalPort?: number; // Tracks original port when auto-switched
}

export function TunnelManager({ connectionId }: { connectionId?: string }) {
  const globalId = useAppStore(state => state.activeConnectionId);
  const activeConnectionId = connectionId || globalId;

  // Store Hooks

  const showToast = useAppStore((state) => state.showToast);

  // Local state for this view
  const [tunnels, setTunnels] = useState<TunnelConfig[]>([]);
  const [, setLoading] = useState(false);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editingTunnel, setEditingTunnel] = useState<TunnelConfig | null>(null);
  const [showPresetDropdown, setShowPresetDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Port suggestion dialog state
  const [portSuggestion, setPortSuggestion] = useState<{
    tunnel: TunnelConfig;
    currentPort: number;
    suggestedPort: number;
  } | null>(null);
  const [customPort, setCustomPort] = useState<string>(''); // For custom port input

  // Fetch ONLY tunnels for this connection (or all and filter if needed, but let's try specific fetch first to be efficient)
  // Actually, to match Global List success, let's just fetch all and filter client-side for now to guarantee consistency 
  // until we confirm tunnel:list endpoint behavior.
  const loadTunnels = async () => {
    if (!activeConnectionId) return;
    setLoading(true);
    try {
      // We use tunnel:getAll and filter because we know it works for the Global view
      const list: TunnelConfig[] = await window.ipcRenderer.invoke('tunnel:getAll');
      const filtered = list.filter(t => t.connectionId === activeConnectionId);
      setTunnels(filtered);
    } catch (error) {
      console.error('Failed to load tunnels', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTunnels();

    const handleStatusChange = (_: any, { id, status, error }: any) => {
      setTunnels(prev => prev.map(t => t.id === id ? { ...t, status: status, error } : t));
    };

    window.ipcRenderer.on('tunnel:status-change', handleStatusChange);
    const interval = setInterval(loadTunnels, 30000);

    return () => {
      clearInterval(interval);
      window.ipcRenderer.off('tunnel:status-change', handleStatusChange);
    };
  }, [activeConnectionId]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowPresetDropdown(false);
      }
    };

    if (showPresetDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showPresetDropdown]);

  // Handle preset selection
  const handlePresetSelect = (preset: TunnelPreset) => {
    setShowPresetDropdown(false);
    setEditingTunnel({
      id: '',
      connectionId: activeConnectionId || '',
      name: preset.name,
      type: preset.type,
      localPort: preset.localPort,
      remoteHost: preset.remoteHost,
      remotePort: preset.remotePort,
      bindToAny: preset.bindToAny,
      status: 'stopped',
    } as TunnelConfig);
    setIsAddModalOpen(true);
  };




  const handleToggleTunnel = async (tunnel: TunnelConfig) => {
    try {
      if (tunnel.status === 'active') {
        // Stop the tunnel
        await window.ipcRenderer.invoke('tunnel:stop', tunnel.id);
        showToast('info', 'Forwarding stopped');

        // Auto-revert if it was using a suggested port
        if (tunnel.originalPort) {
          try {
            const revertedTunnel = {
              ...tunnel,
              [tunnel.type === 'local' ? 'localPort' : 'remotePort']: tunnel.originalPort,
              originalPort: undefined,
            };
            await window.ipcRenderer.invoke('tunnel:save', revertedTunnel);
            showToast('success', `Port reverted to ${tunnel.originalPort}`);
            setTimeout(() => loadTunnels(), 200); // Refresh UI
          } catch (revertError: any) {
            showToast('error', `Failed to revert port: ${revertError.message || revertError}`);
          }
        }
      } else {
        if (tunnel.type === 'remote') {
          await window.ipcRenderer.invoke('tunnel:start_remote',
            tunnel.connectionId,
            tunnel.remotePort,
            tunnel.remoteHost || '127.0.0.1',
            tunnel.localPort
          );
        } else {
          await window.ipcRenderer.invoke('tunnel:start_local',
            tunnel.connectionId,
            tunnel.localPort,
            tunnel.remoteHost,
            tunnel.remotePort
          );
        }
        showToast('success', 'Forwarding started');
      }
      // Optimistic update or wait for event? Event will handle it.
      loadTunnels(); // Refresh to be safe
    } catch (error: any) {
      const errorMsg = error.message || error.toString();

      // Parse error for suggested port: "Port X is already in use... Port Y is available."
      const suggestedPortMatch = errorMsg.match(/Port (\d+) is available/);

      if (suggestedPortMatch) {
        const suggestedPort = parseInt(suggestedPortMatch[1], 10);
        const currentPort = tunnel.type === 'local' ? tunnel.localPort : tunnel.remotePort;

        // Show custom dialog instead of native confirm
        setPortSuggestion({
          tunnel,
          currentPort,
          suggestedPort,
        });
        return;
      }

      showToast('error', `Action failed: ${errorMsg}`);
    }
  };

  // Handle accepting the suggested port
  const handleAcceptSuggestedPort = async (port: number) => {
    if (!portSuggestion) return;
    const { tunnel } = portSuggestion;
    setPortSuggestion(null); // Close dialog
    setCustomPort(''); // Reset custom port input

    try {
      const currentPort = tunnel.type === 'local' ? tunnel.localPort : tunnel.remotePort;
      const updatedTunnel = {
        ...tunnel,
        [tunnel.type === 'local' ? 'localPort' : 'remotePort']: port,
        originalPort: tunnel.originalPort || currentPort, // Store original if not already stored
      };

      // Save the updated config
      await window.ipcRenderer.invoke('tunnel:save', updatedTunnel);

      // Then start tunnel with port
      if (tunnel.type === 'remote') {
        await window.ipcRenderer.invoke('tunnel:start_remote',
          tunnel.connectionId,
          port,
          tunnel.remoteHost || '127.0.0.1',
          tunnel.localPort
        );
      } else {
        await window.ipcRenderer.invoke('tunnel:start_local',
          tunnel.connectionId,
          port,
          tunnel.remoteHost,
          tunnel.remotePort
        );
      }
      showToast('success', `Switched to port ${port}`);

      // Force reload to show the new tunnel - use multiple attempts
      setTimeout(() => loadTunnels(), 100);
      setTimeout(() => loadTunnels(), 500);
      setTimeout(() => loadTunnels(), 1000);
    } catch (error: any) {
      showToast('error', `Failed to start on port ${port}: ${error.message || error}`);
    }
  };

  const handleOpenBrowser = async (port: number) => {
    await window.ipcRenderer.invoke('shell:open', `http://localhost:${port}`);
  };

  const handleDeleteTunnel = async (id: string) => {
    try {
      await window.ipcRenderer.invoke('tunnel:delete', id);
      showToast('success', 'Forward deleted');
      loadTunnels();
    } catch (error: any) {
      showToast('error', `Failed to delete: ${error.message || error}`);
    }
  };

  if (!activeConnectionId) return <div className="p-4 text-app-muted">No connection selected</div>;

  return (
    <div className="flex flex-col h-full bg-app-bg animate-in fade-in duration-300">
      {/* Minimal Header for Tab View */}
      <div className="py-2.5 px-4 bg-app-panel/40 border-b border-app-border/30 backdrop-blur-md sticky top-0 z-20 flex justify-between items-center">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-bold tracking-tight text-app-text">Port Forwarding</h2>
          {tunnels.length > 0 && (
            <span className="text-[10px] text-app-muted/60 font-medium px-1.5 py-0.5 rounded-md bg-app-surface/50 border border-app-border/30">
              {tunnels.filter(t => t.status === 'active').length} Active
            </span>
          )}
        </div>
        <div className="relative" ref={dropdownRef}>
          <div className="flex">
            <Button
              onClick={() => {
                setEditingTunnel(null);
                setIsAddModalOpen(true);
              }}
              className="h-7 px-2.5 bg-app-accent text-white hover:bg-app-accent/90 text-[10px] font-bold whitespace-nowrap rounded-r-none border-r border-white/20"
            >
              <Plus size={12} className="mr-1" /> New Forward
            </Button>
            <Button
              onClick={() => setShowPresetDropdown(!showPresetDropdown)}
              className="h-7 px-1.5 bg-app-accent text-white hover:bg-app-accent/90 rounded-l-none"
              title="Quick Tunnels"
            >
              <ChevronDown size={12} />
            </Button>
          </div>

          {/* Preset Dropdown */}
          {showPresetDropdown && (
            <div className="absolute right-0 mt-1 w-56 bg-app-panel border border-app-border rounded-lg shadow-xl z-50 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
              {TUNNEL_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => handlePresetSelect(preset)}
                  className="w-full px-3 py-2.5 text-left hover:bg-app-surface transition-colors border-b border-app-border/30 last:border-b-0 group"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="font-semibold text-xs text-app-text group-hover:text-app-accent transition-colors">{preset.name}</div>
                      <div className="text-[10px] text-app-muted mt-0.5">{preset.description}</div>
                    </div>
                    <div className="text-[9px] font-mono text-app-muted/60 bg-app-surface/50 px-1.5 py-0.5 rounded">
                      {preset.localPort}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {tunnels.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center -mt-20">
            <div className="w-20 h-20 rounded-3xl bg-app-surface/50 border border-app-border/40 flex items-center justify-center mb-6 shadow-sm">
              <Network className="text-app-muted/40 w-10 h-10" />
            </div>
            <h3 className="text-xl font-semibold text-app-text">No Port Forwards</h3>
            <p className="text-sm text-app-muted mt-2 max-w-xs text-center opacity-70">
              Bridge your local environment with remote servers securely.
            </p>

            <Button
              variant="ghost"
              className="mt-6 text-app-accent hover:bg-app-accent/5"
              onClick={() => {
                setEditingTunnel(null);
                setIsAddModalOpen(true);
              }}
            >
              Create your first forward
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
            {tunnels.map(port => {
              const isActive = port.status === 'active';
              return (
                <div
                  key={port.id}
                  className={cn(
                    "group flex flex-col p-2.5 rounded-xl bg-app-panel/50 border transition-all duration-200 hover:shadow-lg hover:bg-app-panel",
                    isActive ? "border-app-accent/40 bg-app-accent/[0.03]" : "border-app-border/40 hover:border-app-border/80"
                  )}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 overflow-hidden">
                      <div className={cn(
                        "w-1.5 h-1.5 shrink-0 rounded-full",
                        isActive ? "bg-app-success shadow-[0_0_6px_rgba(var(--color-app-success),0.4)]" : "bg-app-muted/30"
                      )} />
                      <span className="font-bold text-[11px] text-app-text truncate">{port.name}</span>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      {port.type === 'local' && (
                        <button
                          onClick={() => handleOpenBrowser(port.localPort)}
                          className="p-1 rounded hover:bg-app-surface text-app-muted hover:text-blue-400 transition-colors"
                          title="Open Browser"
                        >
                          <ExternalLink size={11} />
                        </button>
                      )}
                      <button
                        onClick={() => {
                          setEditingTunnel(port);
                          setIsAddModalOpen(true);
                        }}
                        className="p-1 rounded hover:bg-app-surface text-app-muted hover:text-app-text transition-colors"
                        title="Forward Settings"
                      >
                        <div className="flex gap-0.5">
                          <div className="w-0.5 h-0.5 rounded-full bg-current" />
                          <div className="w-0.5 h-0.5 rounded-full bg-current" />
                          <div className="w-0.5 h-0.5 rounded-full bg-current" />
                        </div>
                      </button>
                      <button
                        onClick={() => handleDeleteTunnel(port.id)}
                        className="p-1 rounded hover:bg-red-500/10 text-app-muted hover:text-red-500 transition-colors"
                        title="Delete Forward"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>

                  {/* Middle Section: Details */}
                  <div className="flex flex-col gap-1.5 py-2 text-[11px]">
                    <div className="flex items-center gap-1.5 text-app-muted/80">
                      <span className="font-semibold text-app-text/60 text-[10px] uppercase tracking-wider">Target</span>
                      <span className="font-mono font-medium text-app-text/90">{port.remoteHost}:{port.type === 'local' ? port.remotePort : port.localPort}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {port.bindToAny !== undefined && (
                        <span className={cn(
                          "text-[9px] px-2 py-1 rounded-md font-bold uppercase tracking-wider",
                          port.bindToAny
                            ? "bg-orange-500/10 text-orange-400/90 border border-orange-500/20"
                            : "bg-green-500/10 text-green-400/90 border border-green-500/20"
                        )}>
                          {port.bindToAny ? "Public" : "Localhost"}
                        </span>
                      )}
                      {port.autoStart && (
                        <span className="text-[9px] px-2 py-1 rounded-md bg-blue-500/10 text-blue-400/90 font-bold uppercase tracking-wider border border-blue-500/20">
                          Auto-Start
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-app-border/30">
                    <div className="flex items-center gap-1.5 font-mono text-[9px] text-app-muted/60">
                      <span className="text-app-text/80 font-bold">{port.type === 'local' ? port.localPort : port.remotePort}</span>
                      <ArrowRight size={10} className="shrink-0 opacity-30" />
                      <span className="text-app-text/80 font-bold">{port.type === 'local' ? port.remotePort : port.localPort}</span>
                      <span className={cn(
                        "ml-1 text-[8px] px-1 rounded uppercase font-extrabold tracking-tighter shrink-0",
                        port.type === 'remote' ? "bg-purple-500/10 text-purple-400/80" : "bg-blue-500/10 text-blue-400/80"
                      )}>
                        {port.type === 'remote' ? 'REM' : 'LOC'}
                      </span>
                    </div>

                    <Button
                      size="sm"
                      onClick={() => handleToggleTunnel(port)}
                      className={cn(
                        "h-6 px-2 min-w-[50px] rounded text-[9px] font-bold uppercase tracking-tight",
                        isActive
                          ? "bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white"
                          : "bg-app-surface border border-app-border/60 hover:border-app-accent hover:text-app-accent"
                      )}
                    >
                      {isActive ? 'Stop' : 'Start'}
                    </Button>
                  </div>
                </div>
              );
            })}

            {/* Add Forward Card */}
            <button
              onClick={() => {
                setEditingTunnel(null);
                setIsAddModalOpen(true);
              }}
              className="group flex flex-col items-center justify-center min-h-[110px] p-4 rounded-xl border border-dashed border-app-border/40 hover:border-app-accent/50 bg-app-panel/20 hover:bg-app-accent/[0.02] transition-all duration-300"
            >
              <Plus size={24} className="mb-2 text-app-muted/40 group-hover:text-app-accent/80 group-hover:scale-110 transition-all duration-300" />
              <span className="text-[10px] font-medium text-app-muted/50 group-hover:text-app-accent/80 transition-colors">Add Forward</span>
            </button>
          </div>
        )}
      </div>

      {/* Port Suggestion Modal */}
      {portSuggestion && (
        <Modal
          isOpen={true}
          onClose={() => {
            setPortSuggestion(null);
            setCustomPort('');
          }}
          title="Port Conflict"
          width="max-w-sm"
        >
          <div className="space-y-3">
            <p className="text-xs text-app-muted">
              Port <span className="font-mono font-semibold text-app-accent">{portSuggestion.currentPort}</span> is busy.
            </p>

            {/* Quick suggestion */}
            <button
              onClick={() => handleAcceptSuggestedPort(portSuggestion.suggestedPort)}
              className="w-full px-3 py-2 text-xs font-medium text-left bg-app-accent/10 hover:bg-app-accent/20 border border-app-accent/30 hover:border-app-accent/50 rounded-lg transition-all flex items-center justify-between group"
            >
              <span className="text-app-text">Use port <span className="font-mono font-semibold text-app-accent">{portSuggestion.suggestedPort}</span></span>
              <ArrowRight size={14} className="text-app-accent opacity-50 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" />
            </button>

            {/* Custom port input */}
            <div className="space-y-2">
              <div className="flex gap-2">
                <input
                  type="number"
                  value={customPort}
                  onChange={(e) => {
                    // Only allow digits, no decimals or negatives
                    const value = e.target.value.replace(/[^0-9]/g, '');
                    setCustomPort(value);
                  }}
                  placeholder="Or enter custom port..."
                  className="flex-1 px-3 py-2 text-xs bg-app-surface border border-app-border/40 rounded-lg focus:outline-none focus:border-app-accent/50 font-mono"
                  min="1"
                  max="65535"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && customPort) {
                      const port = parseInt(customPort);
                      if (port > 0 && port < 65536) {
                        handleAcceptSuggestedPort(port);
                      }
                    }
                  }}
                />
                <Button
                  onClick={() => {
                    const port = parseInt(customPort);
                    if (port && port > 0 && port < 65536) {
                      handleAcceptSuggestedPort(port);
                    }
                  }}
                  disabled={!customPort || parseInt(customPort) <= 0 || parseInt(customPort) > 65535}
                  className="px-3 text-xs bg-app-accent hover:bg-app-accent/90 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Use
                </Button>
              </div>
            </div>
          </div>
        </Modal>
      )}

      <AddTunnelModal
        isOpen={isAddModalOpen}
        editingTunnel={editingTunnel}
        initialConnectionId={activeConnectionId}
        onClose={() => {
          setIsAddModalOpen(false);
          setEditingTunnel(null);
          loadTunnels();
        }}
      />
    </div>
  );
}
