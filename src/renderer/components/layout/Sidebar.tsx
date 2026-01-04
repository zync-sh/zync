import { PanelLeftClose, PanelLeftOpen, Plus, Search, Server, Settings, Terminal } from 'lucide-react';
import { useState } from 'react';
import { useConnections } from '../../context/ConnectionContext';
import { useToast } from '../../context/ToastContext';
import { useTransfers } from '../../context/TransferContext';
import { cn } from '../../lib/utils';
import { getCurrentDragSource } from '../file-manager/FileGrid';
import { SettingsModal } from '../settings/SettingsModal';
import { Button } from '../ui/Button';
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu';

export function Sidebar() {
  const { connections, activeConnectionId, deleteConnection, openTab, connect, disconnect, openAddConnectionModal } =
    useConnections();
  const { addTransfer } = useTransfers();
  const { showToast } = useToast();

  // UI State
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    connectionId: string;
  } | null>(null);

  const filteredConnections = connections.filter((c) =>
    (c.name || c.host).toLowerCase().includes(searchTerm.toLowerCase()),
  );

  return (
    <div
      className={cn(
        'bg-app-panel/95 backdrop-blur-xl border-r border-app-border/50 flex flex-col h-full shrink-0 transition-all duration-300 ease-in-out relative z-50',
        isCollapsed ? 'w-20' : 'w-72',
      )}
    >
      {/* Header */}
      <div
        className={cn(
          'h-16 flex items-center shrink-0 mb-4',
          isCollapsed ? 'justify-center px-2' : 'justify-between px-6',
        )}
        style={{ WebkitAppRegion: 'drag' } as any}
      >
        {!isCollapsed && (
          <div className="flex items-center gap-3">
            {/* App Icon */}
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-app-accent to-app-accent/50 flex items-center justify-center text-white font-bold shadow-lg shadow-app-accent/25">
              <Server className="w-5 h-5" />
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-bold text-app-text tracking-wide">Hosts</span>
              <span className="text-[10px] uppercase font-semibold text-app-accent/80 tracking-widest mt-0.5">
                Explorer
              </span>
            </div>
          </div>
        )}

        <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as any}>
          {!isCollapsed && (
            <div className="relative group">
              <div className="absolute inset-0 bg-app-accent/20 blur-md rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => openAddConnectionModal()}
                className="relative h-8 w-8 text-app-accent hover:bg-app-accent hover:text-white rounded-full transition-all duration-300"
              >
                <Plus className="h-5 w-5" />
              </Button>
            </div>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="h-8 w-8 text-app-muted hover:text-white transition-colors"
          >
            {isCollapsed ? <PanelLeftOpen className="h-5 w-5" /> : <PanelLeftClose className="h-5 w-5" />}
          </Button>
        </div>
      </div>

      {/* Collapsed Add Button */}
      {isCollapsed && (
        <div className="flex justify-center mb-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => openAddConnectionModal()}
            className="h-10 w-10 text-app-accent bg-app-accent/10 hover:bg-app-accent hover:text-white rounded-xl transition-all"
            style={{ WebkitAppRegion: 'no-drag' } as any}
          >
            <Plus className="h-5 w-5" />
          </Button>
        </div>
      )}

      {/* Search */}
      {!isCollapsed && (
        <div className="px-5 mb-6">
          <div className="relative group">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-app-muted group-focus-within:text-app-accent transition-colors" />
            <input
              className="w-full bg-app-surface/50 border border-app-border/50 rounded-xl px-3 py-2 pl-10 text-sm text-app-text focus:border-app-accent/50 focus:ring-2 focus:ring-app-accent/20 focus:outline-none placeholder:text-app-muted/40 transition-all font-medium"
              placeholder="Search hosts..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto px-3 pb-4 space-y-2 scrollbar-hide">
        {/* Local Terminal Item */}
        {/** biome-ignore lint/a11y/noStaticElementInteractions: <explanation> */}
        <div
          className={cn(
            'group relative flex items-center transition-all cursor-pointer border select-none',
            isCollapsed ? 'justify-center p-2 rounded-xl mx-auto w-12 h-12' : 'gap-3 p-3 rounded-xl mx-2',
            'border-transparent hover:bg-app-surface/50',
            activeConnectionId === 'local'
              ? 'bg-gradient-to-r from-app-accent/10 to-transparent border-app-accent/20 shadow-[0_0_15px_rgba(99,102,241,0.15)]'
              : 'text-app-muted hover:text-app-text',
          )}
          onClick={() => openTab('local')}
          title="Open Local Terminal"
        >
          <div
            className={cn(
              'relative flex items-center justify-center rounded-lg transition-all duration-300',
              isCollapsed ? 'w-8 h-8' : 'w-10 h-10',
              activeConnectionId === 'local'
                ? 'bg-app-accent text-white shadow-lg shadow-app-accent/30 scale-105'
                : 'bg-app-surface text-app-muted group-hover:text-app-accent group-hover:scale-110',
            )}
          >
            <Terminal className="w-5 h-5" />
          </div>

          {!isCollapsed && (
            <div className="flex flex-col overflow-hidden">
              <span
                className={cn(
                  'font-medium truncate transition-colors duration-200',
                  activeConnectionId === 'local' ? 'text-app-accent' : 'text-app-text group-hover:text-white',
                )}
              >
                Local Terminal
              </span>
              <span className="text-xs text-app-muted/60 truncate group-hover:text-app-muted/80">This Computer</span>
            </div>
          )}
        </div>

        {/* Divider if needed, or just space */}
        <div className="h-px bg-app-border/30 mx-4 my-2" />

        {filteredConnections.map((conn) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: interactive div
          <div
            key={conn.id}
            className={cn(
              'group relative flex items-center transition-all cursor-pointer border select-none',
              // Layout & Spacing
              isCollapsed ? 'justify-center p-2 rounded-xl mx-auto w-12 h-12' : 'gap-3 p-3 rounded-xl mx-2',
              // Default State
              'border-transparent hover:bg-app-surface/50',
              // Active State (Glowing Pill)
              activeConnectionId === conn.id
                ? 'bg-gradient-to-r from-app-accent/10 to-transparent border-app-accent/20 shadow-[0_0_15px_rgba(99,102,241,0.15)]'
                : 'text-app-muted hover:text-app-text',
              dropTargetId === conn.id && 'bg-app-accent/20 border-app-accent ring-2 ring-app-accent/30',
            )}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setContextMenu({
                x: e.clientX,
                y: e.clientY,
                connectionId: conn.id,
              });
            }}
            onDoubleClick={() => openTab(conn.id)}
            draggable
            onDragStart={(e) => {
              // Can drag to drop on other folders? For now just visual or for future 'organization' features
              // We don't have folders yet, so maybe disable drag unless dragging AS a file source?
              // Actually, let's keep it disabled for now to avoid confusion with file dragging.
              e.preventDefault();
            }}
            // ... drop handlers remain the same ...
            onDragOver={(e) => {
              const dragSource = getCurrentDragSource();
              if (dragSource && dragSource.connectionId !== conn.id && conn.status === 'connected') {
                e.preventDefault();
                setDropTargetId(conn.id);
              }
            }}
            onDragLeave={() => setDropTargetId(null)}
            onDrop={async (e) => {
              // ... existing drop logic ...
              e.preventDefault();
              setDropTargetId(null);

              try {
                const jsonData = e.dataTransfer.getData('application/json');
                if (jsonData) {
                  const dragData = JSON.parse(jsonData);
                  if (dragData.type === 'server-file' && dragData.connectionId !== conn.id) {
                    // Get home directory first
                    let destPath: string;
                    try {
                      const homeDir = await window.ipcRenderer.invoke('sftp:cwd', { id: conn.id });
                      const fileName = dragData.name;
                      destPath = homeDir === '/' ? `/${fileName}` : `${homeDir}/${fileName}`;
                    } catch (_err) {
                      showToast('error', 'Failed to get home directory');
                      return;
                    }

                    // Start transfer
                    const transferId = addTransfer({
                      sourceConnectionId: dragData.connectionId,
                      sourcePath: dragData.path,
                      destinationConnectionId: conn.id,
                      destinationPath: destPath,
                    });

                    showToast('info', `Copying to ${conn.name || conn.host}...`);

                    // Execute in background
                    (async () => {
                      try {
                        await window.ipcRenderer.invoke('sftp:copyToServer', {
                          sourceConnectionId: dragData.connectionId,
                          sourcePath: dragData.path,
                          destinationConnectionId: conn.id,
                          destinationPath: destPath,
                          transferId,
                        });
                      } catch (error: any) {
                        if (error.message && !error.message.includes('destroy')) {
                          showToast('error', `Transfer failed: ${error.message}`);
                        }
                      }
                    })();
                  }
                }
              } catch (_err) {}
            }}
          >
            {/* Active Marker Line (Left) */}
            {activeConnectionId === conn.id && (
              <div className="absolute left-0 top-3 bottom-3 w-1 rounded-r-lg bg-app-accent shadow-[0_0_10px_rgba(99,102,241,0.5)]" />
            )}

            {/* Icon */}
            <div
              className={cn(
                'relative shrink-0 h-10 w-10 rounded-xl flex items-center justify-center transition-all duration-300',
                activeConnectionId === conn.id
                  ? 'bg-app-accent text-white shadow-lg shadow-app-accent/20 scale-105'
                  : 'bg-app-surface border border-app-border/50 group-hover:border-app-accent/30 group-hover:bg-app-surface/80',
              )}
            >
              <Server
                size={18}
                className={cn(
                  'transition-transform duration-500',
                  activeConnectionId === conn.id
                    ? 'text-white'
                    : 'text-app-muted group-hover:text-app-text group-hover:scale-110',
                )}
              />

              {/* Status Dot */}
              {conn.status === 'connected' && (
                <div className="absolute -bottom-1 -right-1 h-3 w-3 rounded-full bg-app-success border-2 border-app-panel shadow-sm animate-pulse-slow" />
              )}
            </div>

            {!isCollapsed && (
              <div className="flex flex-col overflow-hidden min-w-0 flex-1">
                <span
                  className={cn(
                    'truncate font-semibold text-sm leading-tight transition-colors',
                    activeConnectionId === conn.id ? 'text-white' : 'text-app-text/90 group-hover:text-white',
                  )}
                >
                  {conn.name || conn.host}
                </span>
                <span className="truncate text-xs text-app-muted/60 leading-tight mt-0.5 group-hover:text-app-muted/80">
                  {conn.username}@{conn.host}
                </span>
              </div>
            )}

            {/* Hover Chevron (Subtle hint) */}
            {!isCollapsed && activeConnectionId !== conn.id && (
              <div className="opacity-0 group-hover:opacity-100 transition-opacity -mr-1">
                <div className="h-1.5 w-1.5 rounded-full bg-app-border/80" />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Footer / User */}
      <div className={cn('p-4 border-t border-app-border/30 backdrop-blur-md bg-app-panel/50', isCollapsed && 'p-2')}>
        <button
          onClick={() => setIsSettingsOpen(true)}
          className={cn(
            'flex items-center gap-3 w-full p-2.5 rounded-xl transition-all duration-200 group',
            'hover:bg-app-surface/80 border border-transparent hover:border-app-border/50',
            isCollapsed && 'justify-center p-0 h-12 w-12 rounded-2xl bg-app-surface/30',
          )}
        >
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shrink-0 shadow-lg shadow-indigo-500/20 group-hover:shadow-indigo-500/40 transition-shadow">
            <span className="text-xs font-bold text-white">OP</span>
          </div>
          {!isCollapsed && (
            <div className="flex-1 text-left overflow-hidden">
              <div className="text-sm font-semibold text-app-text group-hover:text-white transition-colors">
                Operator
              </div>
              <div className="text-[10px] text-app-muted uppercase tracking-wider">Settings</div>
            </div>
          )}
        </button>
      </div>

      {/* Modals */}
      {/* Modals - Removed Local Add Modal, using Global Context */}
      {/* Context Menu */}

      {/* Context Menu */}
      {contextMenu &&
        (() => {
          const conn = connections.find((c) => c.id === contextMenu.connectionId);
          if (!conn) return null;

          const items: ContextMenuItem[] = [
            {
              label: conn.status === 'connected' ? 'Disconnect' : 'Connect',
              action: () => {
                if (conn.status === 'connected') {
                  disconnect(conn.id);
                } else {
                  connect(conn.id);
                  openTab(conn.id);
                }
              },
            },
            {
              label: 'Properties',
              action: () => alert('Properties not implemented yet'),
            },
            {
              label: 'Delete',
              variant: 'danger',
              action: () => {
                if (confirm('Are you sure you want to delete this connection?')) {
                  deleteConnection(conn.id);
                }
              },
            },
          ];

          return <ContextMenu x={contextMenu.x} y={contextMenu.y} items={items} onClose={() => setContextMenu(null)} />;
        })()}
      {/* Footer */}
      <div className={cn('p-4 border-t border-app-border/30 mt-auto', isCollapsed ? 'flex justify-center' : '')}>
        <Button
          variant="ghost"
          className={cn(
            'w-full flex items-center gap-3 text-app-muted hover:text-white transition-colors',
            isCollapsed ? 'justify-center px-0 py-2 h-auto' : 'justify-start px-3 py-2',
          )}
          onClick={() => setIsSettingsOpen(true)}
        >
          <Settings className="h-5 w-5" />
          {!isCollapsed && <span>Settings</span>}
        </Button>
      </div>

      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
    </div>
  );
}
