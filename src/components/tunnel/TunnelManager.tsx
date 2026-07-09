import { useEffect, useState, useRef } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Button } from '../ui/Button';
import { cn } from '../../lib/utils';
import { Plus, Network, ChevronDown, FileText, Play, Square, Folder, FolderOpen, ArrowRight } from 'lucide-react';
import { TUNNEL_PRESETS, TunnelPreset } from '../../lib/tunnelPresets';
import { AddTunnelModal } from '../modals/AddTunnelModal';
import { ImportSSHCommandModal } from '../modals/ImportSSHCommandModal';
import { Modal } from '../ui/Modal';
import { TopbarDropdown } from '../ui/TopbarDropdown';
import { TunnelCard, TunnelConfig } from './TunnelCard';
import { getConnectionDisplayLabels } from '../../features/connections/domain/connectionDisplay';

import {
  parsePortConflictError,
  tunnelWithSwappedPort,
} from '../../features/tunnels/application/tunnelPortConflict';
import { revertTunnelOriginalPort } from '../../features/tunnels/application/tunnelActions';

const EMPTY_TUNNELS: TunnelConfig[] = [];

export function TunnelManager({ connectionId }: { connectionId?: string }) {
  const globalId = useAppStore(state => state.activeConnectionId);
  const activeConnectionId = connectionId || globalId;

  const connections = useAppStore(state => state.connections);
  const conn = connections.find(c => c.id === activeConnectionId);
  const showToast = useAppStore((state) => state.showToast);
  const tunnels = useAppStore((state) =>
    activeConnectionId
      ? (state.tunnels[activeConnectionId] ?? EMPTY_TUNNELS)
      : EMPTY_TUNNELS,
  );
  const loadTunnels = useAppStore((state) => state.loadTunnels);
  const startTunnel = useAppStore((state) => state.startTunnel);
  const stopTunnel = useAppStore((state) => state.stopTunnel);
  const saveTunnel = useAppStore((state) => state.saveTunnel);
  const deleteTunnel = useAppStore((state) => state.deleteTunnel);
  const updateTunnelStatus = useAppStore((state) => state.updateTunnelStatus);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editingTunnel, setEditingTunnel] = useState<TunnelConfig | null>(null);
  const [showPresetDropdown, setShowPresetDropdown] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Port suggestion dialog state
  const [portSuggestion, setPortSuggestion] = useState<{
    tunnel: TunnelConfig;
    currentPort: number;
    suggestedPort: number;
  } | null>(null);
  const [customPort, setCustomPort] = useState<string>(''); // For custom port input

  const connectionStatus = conn?.status;

  useEffect(() => {
    if (!activeConnectionId) return;
    void loadTunnels(activeConnectionId);

    const handleStatusChange = (_: unknown, { id, status, error }: { id: string; status: TunnelConfig['status']; error?: string }) => {
      updateTunnelStatus(id, activeConnectionId, status, error);
    };

    window.ipcRenderer.on('tunnel:status-change', handleStatusChange);
    return () => {
      window.ipcRenderer.off('tunnel:status-change', handleStatusChange);
    };
  }, [activeConnectionId, loadTunnels, updateTunnelStatus]);

  useEffect(() => {
    if (!activeConnectionId || connectionStatus === 'connected') return;
    const reconcile = useAppStore.getState().reconcileTunnelsForConnection;
    void reconcile(activeConnectionId);
  }, [activeConnectionId, connectionStatus]);

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
        await stopTunnel(tunnel.id, tunnel.connectionId);
        showToast('info', 'Forwarding stopped');

        try {
          const reverted = await revertTunnelOriginalPort(tunnel, saveTunnel);
          if (reverted && tunnel.originalPort) {
            showToast('success', `Port reverted to ${tunnel.originalPort}`);
          }
        } catch (revertError: unknown) {
          const message = revertError instanceof Error ? revertError.message : String(revertError);
          showToast('error', `Failed to revert port: ${message}`);
        }
      } else {
        await startTunnel(tunnel.id, tunnel.connectionId);
        showToast('success', 'Forwarding started');
      }
    } catch (error: unknown) {
      const conflict = parsePortConflictError(error, tunnel);
      if (conflict) {
        setPortSuggestion(conflict);
        return;
      }
      const errorMsg = error instanceof Error ? error.message : String(error);
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
      const updatedTunnel = tunnelWithSwappedPort(tunnel, port);
      await saveTunnel(updatedTunnel);
      await startTunnel(updatedTunnel.id, updatedTunnel.connectionId);
      showToast('success', `Switched to port ${port}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      showToast('error', `Failed to start on port ${port}: ${message}`);
    }
  };

  const handleOpenBrowser = async (port: number) => {
    await window.ipcRenderer.invoke('shell:open', `http://localhost:${port}`);
  };

  const handleDeleteTunnel = async (id: string) => {
    if (!activeConnectionId) return;
    try {
      await deleteTunnel(id, activeConnectionId);
      showToast('success', 'Forward deleted');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      showToast('error', `Failed to delete: ${message}`);
    }
  };
  // Handle starting all tunnels in a group
  const handleStartGroup = async (groupName: string, groupTunnels: TunnelConfig[]) => {
    let successCount = 0;
    let failCount = 0;

    showToast('info', `Starting ${groupName === 'Ungrouped' ? 'ungrouped' : groupName} forwards...`);

    // Sequential start to avoid race conditions and potential UI freezing
    for (const tunnel of groupTunnels) {
      if (tunnel.status !== 'active') {
        try {
          await startTunnel(tunnel.id, tunnel.connectionId);
          successCount++;
        } catch (err) {
          console.error(`Failed to start tunnel ${tunnel.name}:`, err);
          failCount++;
        }
      }
    }

    if (activeConnectionId) {
      await loadTunnels(activeConnectionId);
    }

    if (failCount > 0) {
      showToast('error', `Started ${successCount} tunnels, failed ${failCount}`);
    } else if (successCount > 0) {
      showToast('success', `Started ${successCount} forwards`);
    }
  };

  // Handle stopping all tunnels in a group
  const handleStopGroup = async (groupName: string, groupTunnels: TunnelConfig[]) => {
    let count = 0;

    // Sequential stop
    for (const tunnel of groupTunnels) {
      if (tunnel.status === 'active') {
        try {
          await stopTunnel(tunnel.id, tunnel.connectionId);
          count++;
        } catch (err) {
          console.error(`Failed to stop tunnel ${tunnel.name}:`, err);
        }
      }
    }

    if (activeConnectionId) {
      await loadTunnels(activeConnectionId);
    }
    if (count > 0) showToast('info', `Stopped ${count} forwards in ${groupName === 'Ungrouped' ? 'ungrouped' : groupName}`);
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
        <div className="flex gap-1.5">
          <Button
            variant="ghost"
            onClick={() => setShowImportModal(true)}
            className="h-7 px-2 text-[10px] text-app-muted hover:text-app-text"
            title="Import from SSH Command"
          >
            <FileText size={12} className="mr-1" /> Import
          </Button>
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
              <TopbarDropdown
                align="right"
                widthClass="w-56"
                className="mt-1 rounded-lg shadow-xl p-0"
              >
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
              </TopbarDropdown>
            )}
          </div>
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
          <div className="space-y-8">
            {(() => {
              // Group tunnels
              const groups: Record<string, TunnelConfig[]> = {};
              tunnels.forEach(t => {
                const g = t.group || 'Ungrouped';
                if (!groups[g]) groups[g] = [];
                groups[g].push(t);
              });

              // Sort groups: named groups alphabetical, then Ungrouped
              const sortedGroupNames = Object.keys(groups).sort((a, b) => {
                if (a === 'Ungrouped') return 1;
                if (b === 'Ungrouped') return -1;
                return a.localeCompare(b);
              });

              return sortedGroupNames.map(groupName => {
                const groupTunnels = groups[groupName];
                const activeCount = groupTunnels.filter(t => t.status === 'active').length;

                return (
                  <div key={groupName} className="space-y-3">
                    {/* Group Header */}
                    <div className="flex items-center justify-between pl-1 pb-1 border-b border-app-border/30">
                      <div className="flex items-center gap-2">
                        {groupName === 'Ungrouped' ? (
                          <FolderOpen size={16} className="text-app-muted/60" />
                        ) : (
                          <Folder size={16} className="text-app-accent/80" />
                        )}
                        <h3 className={cn(
                          "text-sm font-semibold tracking-tight",
                          groupName === 'Ungrouped' ? "text-app-muted italic" : "text-app-text"
                        )}>
                          {groupName}
                        </h3>
                        <span className="ml-1 rounded-full bg-app-surface/50 px-1.5 py-0.5 font-mono text-[10px] text-app-muted/50">
                          {activeCount}/{groupTunnels.length} active
                        </span>
                      </div>

                      <div className="flex items-center gap-1">
                        {activeCount > 0 && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleStopGroup(groupName, groupTunnels)}
                            className="h-6 px-2 text-[10px] text-app-muted hover:text-red-400 hover:bg-red-400/10 gap-1"
                            title="Stop All"
                          >
                            <Square size={10} className="fill-current" /> Stop All
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleStartGroup(groupName, groupTunnels)}
                          className="h-6 px-2 text-[10px] text-app-muted hover:text-green-400 hover:bg-green-400/10 gap-1"
                          title="Start All"
                        >
                          <Play size={10} className="fill-current" /> Start All
                        </Button>
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      {groupTunnels.map(port => (
                        <TunnelCard
                          key={port.id}
                          tunnel={port}
                          connectionIcon={conn?.icon}
                          hostLabel={conn ? getConnectionDisplayLabels(conn, false).primary : undefined}
                          viewMode="list"
                          onToggle={handleToggleTunnel}
                          onEdit={(t) => {
                            setEditingTunnel(t);
                            setIsAddModalOpen(true);
                          }}
                          onDelete={handleDeleteTunnel}
                          onOpenBrowser={handleOpenBrowser}
                          onCopy={(text) => {
                            navigator.clipboard.writeText(text);
                            showToast('success', 'Copied');
                          }}
                        />
                      ))}
                    </div>
                  </div>
                );
              });
            })()}
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
          if (activeConnectionId) void loadTunnels(activeConnectionId);
        }}
      />

      <ImportSSHCommandModal
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        connectionId={activeConnectionId} // Pass the active connection ID
        onImport={() => {
          if (activeConnectionId) void loadTunnels(activeConnectionId);
        }}
      />
    </div>
  );
}
