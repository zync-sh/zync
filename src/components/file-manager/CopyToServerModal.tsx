import { Copy, Server, ArrowRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAppStore, type Connection } from '../../store/useAppStore';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';
import { Select, type SelectOption } from '../ui/Select';

interface CopyToServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  sourceFiles: {
    connectionId: string;
    path: string;
    name: string;
  }[];
  destinationConnectionId?: string;
  destinationPath?: string;
}

export function CopyToServerModal({
  isOpen,
  onClose,
  sourceFiles,
  destinationConnectionId,
  destinationPath: initialDestPath
}: CopyToServerModalProps) {
  const connections = useAppStore(state => state.connections);
  const addTransfer = useAppStore(state => state.addTransfer);
  const completeTransfer = useAppStore(state => state.completeTransfer);
  const failTransfer = useAppStore(state => state.failTransfer);
  const showToast = useAppStore((state) => state.showToast);
  const connect = useAppStore(state => state.connect);

  const [selectedServerId, setSelectedServerId] = useState('');
  const [destinationPath, setDestinationPath] = useState('');
  const [fileName, setFileName] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [isFetchingSuggestions, setIsFetchingSuggestions] = useState(false);

  const isMultiSelect = sourceFiles.length > 1;
  const firstFile = sourceFiles[0];

  // Initialize state when sourceFiles or selected server changes
  useEffect(() => {
    if (sourceFiles.length > 0) {
      if (!isMultiSelect) {
        setFileName(firstFile.name);
      } else {
        setFileName(''); // Clear rename field for multiple files
      }

      // Handle default destination path based on target home or initial path
      if (initialDestPath) {
        setDestinationPath(initialDestPath);
      } else if (selectedServerId) {
        const targetServer = connections.find(c => c.id === selectedServerId);
        if (targetServer) {
          // Use stored homePath if available, else guess based on username
          const guessedHome = targetServer.username === 'root' ? '/root' : `/home/${targetServer.username}`;
          setDestinationPath(targetServer.homePath || guessedHome);
        }
      } else if (!destinationPath) {
        // Fallback placeholder if no server or path is provided yet
        setDestinationPath('~/');
      }

      if (destinationConnectionId) {
        setSelectedServerId(destinationConnectionId);
      } else if (selectedServerId === firstFile.connectionId) {
        setSelectedServerId('');
      }
    }
  }, [sourceFiles, destinationConnectionId, initialDestPath, isMultiSelect, firstFile, selectedServerId, connections]);

  // Path Navigation Helpers
  const goToHome = () => {
    const targetServer = connections.find(c => c.id === selectedServerId);
    if (targetServer) {
      const guessedHome = targetServer.username === 'root' ? '/root' : `/home/${targetServer.username}`;
      setDestinationPath(targetServer.homePath || guessedHome);
    }
  };

  const goToRoot = () => setDestinationPath('/');

  const goUp = () => {
    const parts = destinationPath.split('/').filter(Boolean);
    if (parts.length > 0) {
      parts.pop();
      setDestinationPath('/' + parts.join('/'));
    } else {
      setDestinationPath('/');
    }
  };

  // Autocomplete Logic
  useEffect(() => {
    let isActive = true;
    const isSpecialHome = destinationPath === '~/';
    const endsWithSlash = destinationPath.endsWith('/');

    if (!selectedServerId || (!endsWithSlash && !isSpecialHome) || destinationPath.length < 1) {
      setSuggestions([]);
      return;
    }

    const timer = setTimeout(async () => {
      setIsFetchingSuggestions(true);
      try {
        const targetServer = connections.find(c => c.id === selectedServerId);
        if (targetServer && targetServer.status !== 'connected') {
          await connect(selectedServerId);
        }

        if (!isActive) return;

        const listPath = isSpecialHome ? '' : destinationPath;
        const files = await window.ipcRenderer.invoke('fs:list', selectedServerId, listPath);

        if (!isActive) return;
        const dirs = files
          .filter((f: any) => f.type === 'd') // backend uses 'type': 'd'
          .map((f: any) => f.name)
          .filter((name: string) => name !== '.' && name !== '..');

        setSuggestions(dirs);
      } catch (err) {
        if (isActive) console.error('Failed to fetch suggestions:', err);
      } finally {
        if (isActive) setIsFetchingSuggestions(false);
      }
    }, 300);

    return () => {
      isActive = false;
      clearTimeout(timer);
    };
  }, [destinationPath, selectedServerId, connections, connect]);

  const handleSuggestionClick = (dir: string) => {
    if (dir === '.') {
      setDestinationPath(prev => prev.endsWith('/') ? prev.slice(0, -1) : prev);
    } else {
      const newPath = `${destinationPath}${dir}/`.replace('//', '/');
      setDestinationPath(newPath);
    }
    setSuggestions([]);
  };

  const availableServers = connections.filter((conn: Connection) => conn.id !== firstFile?.connectionId);
  const serverOptions: SelectOption[] = availableServers.map(conn => ({
    value: conn.id,
    label: conn.name,
    description: `${conn.username}@${conn.host}`,
    icon: <Server size={16} className="text-app-muted" />
  }));

  const handleCopy = async () => {
    if (sourceFiles.length === 0 || !selectedServerId || !destinationPath) {
      showToast('error', 'Please fill in all fields');
      return;
    }

    if (!isMultiSelect && !fileName) {
      showToast('error', 'Please provide a file name');
      return;
    }

    showToast('info', `Starting transfer of ${sourceFiles.length} item(s)`);
    onClose();

    (async () => {
      try {
        const destServer = connections.find((c: Connection) => c.id === selectedServerId);
        if (destServer && destServer.status !== 'connected') {
          await connect(selectedServerId);
        }

        // Process all files
        for (const file of sourceFiles) {
          const targetName = isMultiSelect ? file.name : fileName;
          const fullDestPath = `${destinationPath}/${targetName}`.replace('//', '/');

          const transferId = addTransfer({
            sourceConnectionId: file.connectionId,
            sourcePath: file.path,
            destinationConnectionId: selectedServerId,
            destinationPath: fullDestPath,
          });

          window.ipcRenderer.invoke('sftp_copy_to_server', {
            sourceConnectionId: file.connectionId,
            sourcePath: file.path,
            destinationConnectionId: selectedServerId,
            destinationPath: fullDestPath,
            transferId,
          }).then(() => {
            completeTransfer(transferId);
          }).catch((error: any) => {
            if (error.message && !error.message.includes('destroy')) {
              failTransfer(transferId, error.message);
              showToast('error', `Copy failed for ${file.name}: ${error.message}`);
            }
          });
        }
      } catch (error: any) {
        showToast('error', `Batch transfer setup failed: ${error.message}`);
      }
    })();
  };

  const handleClose = () => {
    onClose();
  };

  if (sourceFiles.length === 0) return null;

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Copy File to Server" width="max-w-xl">
      <div className="space-y-6 py-2 px-1 text-app-text pb-24">
        {/* The Compact Bridge */}
        <div className="relative flex items-center justify-between gap-4">
          {/* Source Hub */}
          <div className="flex-1 min-w-0 bg-app-surface/20 border border-white/5 rounded-xl p-4 backdrop-blur-xl relative group transition-all duration-500 hover:bg-app-surface/30 shadow-[inset_0_0_15px_rgba(255,255,255,0.01)]">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5 opacity-40">
                <Server size={12} className="text-app-accent" />
                <span className="text-[8px] font-bold uppercase tracking-widest">Source</span>
              </div>
              <div className="text-base font-bold tracking-tight text-app-text truncate leading-tight transition-colors">
                {connections.find((c: Connection) => c.id === firstFile.connectionId)?.name}
              </div>
              <div className="text-[10px] text-app-muted font-medium opacity-50 truncate">
                {connections.find((c: Connection) => c.id === firstFile.connectionId)?.username}@{connections.find((c: Connection) => c.id === firstFile.connectionId)?.host}
              </div>
            </div>
          </div>

          {/* The Ethereal Bridge */}
          <div className="flex-none w-12 relative flex items-center justify-center">
            <div className="w-full h-[1.5px] rounded-full overflow-hidden bg-white/5 relative">
              <div className="absolute inset-0 animate-ethereal-glow" />
            </div>
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-app-panel border border-white/10 flex items-center justify-center shadow-lg animate-zync-float backdrop-blur-md">
              <ArrowRight size={12} className="text-app-accent/80" />
            </div>
          </div>

          {/* Target Hub */}
          <div className={`flex-1 min-w-0 border rounded-xl p-4 backdrop-blur-xl transition-all duration-700 shadow-[inset_0_0_15px_rgba(255,255,255,0.01)] ${selectedServerId ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-app-surface/10 border-white/5 opacity-50'}`}>
            <div className="flex flex-col gap-1.5 text-right">
              <div className="flex items-center gap-1.5 opacity-40 justify-end">
                <span className="text-[8px] font-bold uppercase tracking-widest text-emerald-500/80">Target</span>
                <Server size={12} className={selectedServerId ? 'text-emerald-500' : 'text-app-muted'} />
              </div>
              <div className="text-base font-bold tracking-tight text-app-text leading-tight truncate">
                {selectedServerId ? availableServers.find(s => s.id === selectedServerId)?.name : 'Destination...'}
              </div>
              <div className="text-[10px] text-app-muted font-medium opacity-50 truncate">
                {selectedServerId ? `${availableServers.find(s => s.id === selectedServerId)?.username}@${availableServers.find(s => s.id === selectedServerId)?.host}` : 'Select a hub'}
              </div>
            </div>
          </div>
        </div>

        {/* File Indicator (Compact) */}
        <div className="bg-white/[0.02] border border-white/5 rounded-lg p-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 overflow-hidden">
            <div className="w-1.5 h-1.5 rounded-full bg-app-accent animate-pulse shrink-0" />
            <div className="text-[11px] font-medium text-app-text truncate">
              {isMultiSelect ? `${sourceFiles.length} items staged` : firstFile.name}
            </div>
          </div>
          <div className="text-[9px] text-app-muted font-mono opacity-30 shrink-0 uppercase tracking-tighter">
            {isMultiSelect ? 'Batch Link' : 'Secure Stream'}
          </div>
        </div>

        <div className="space-y-5">
          <div className="space-y-3.5">
            <Select
              label="Select Gateway"
              value={selectedServerId}
              onChange={setSelectedServerId}
              options={serverOptions}
              placeholder="Destination Gateway..."
              className="z-[110] bg-app-surface/30 border-white/5 rounded-lg py-2.5 text-sm"
            />

            <div className={`grid gap-3.5 relative ${isMultiSelect ? 'grid-cols-1' : 'grid-cols-2'}`}>
              <div className="space-y-2">
                <Input
                  label="Destination Path"
                  value={destinationPath}
                  onChange={(e) => setDestinationPath(e.target.value)}
                  placeholder="/home/user/data"
                  className="bg-app-surface/20 border-white/5 focus:bg-app-surface/40 transition-all rounded-lg py-2.5 text-sm"
                />

                {/* Suggestions Dropdown (Quick Traverse Style) */}
                {suggestions.length > 0 && (
                  <div className="absolute z-[120] left-0 right-0 mt-2 bg-[#1a1b1e] border border-white/5 rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
                    <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 bg-white/[0.02]">
                      <span className="text-[10px] font-bold text-app-muted uppercase tracking-widest">Quick Traverse</span>
                      <button onClick={() => setSuggestions([])} className="text-app-muted hover:text-white transition-colors">
                        <span className="sr-only">Close</span>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                      </button>
                    </div>
                    <div className="p-1 max-h-60 overflow-y-auto custom-scrollbar">
                      <button
                        onClick={() => handleSuggestionClick('.')}
                        className="w-full text-left px-3 py-2 text-sm text-app-text hover:bg-white/5 rounded-lg transition-colors flex items-center gap-3 group"
                      >
                        <div className="w-5 h-5 rounded flex items-center justify-center bg-emerald-500/10 text-emerald-500">
                          <div className="w-1 h-1 rounded-full bg-current" />
                        </div>
                        <span className="font-mono text-emerald-500">.</span>
                      </button>
                      <button
                        onClick={goUp}
                        className="w-full text-left px-3 py-2 text-sm text-app-text hover:bg-white/5 rounded-lg transition-colors flex items-center gap-3 group"
                      >
                        <div className="w-5 h-5 rounded flex items-center justify-center bg-amber-500/10 text-amber-500">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
                        </div>
                        <span className="font-mono text-amber-500">..</span>
                      </button>
                      {suggestions.map((dir) => (
                        <button
                          key={dir}
                          onClick={() => handleSuggestionClick(dir)}
                          className="w-full text-left px-3 py-2 text-sm text-app-text/80 hover:text-white hover:bg-white/5 rounded-lg transition-all flex items-center gap-3 group"
                        >
                          <div className="w-5 h-5 rounded flex items-center justify-center bg-[#ca8a04]/10 text-[#ca8a04] group-hover:bg-[#ca8a04]/20 transition-colors">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M20 20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v11Z" /></svg>
                          </div>
                          <span className="truncate">{dir}/</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Quick-Path Chips */}
                {selectedServerId && (
                  <div className="flex flex-wrap gap-1.5 px-0.5">
                    <button
                      onClick={goToHome}
                      className="px-2 py-0.5 rounded-full bg-white/5 border border-white/5 text-[9px] font-bold text-app-accent hover:bg-app-accent/10 hover:border-app-accent/30 transition-all"
                    >
                      ~ Home
                    </button>
                    <button
                      onClick={goToRoot}
                      className="px-2 py-0.5 rounded-full bg-white/5 border border-white/5 text-[9px] font-bold text-app-muted hover:bg-white/10 hover:border-white/20 transition-all"
                    >
                      / Root
                    </button>
                    {isFetchingSuggestions && (
                      <div className="flex items-center gap-1.5 px-2 py-0.5">
                        <div className="w-1.5 h-1.5 rounded-full bg-app-accent animate-ping" />
                        <span className="text-[8px] text-app-muted uppercase tracking-widest font-bold">Scanning...</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {!isMultiSelect && (
                <Input
                  label="Asset Name"
                  value={fileName}
                  onChange={(e) => setFileName(e.target.value)}
                  placeholder="name"
                  className="bg-app-surface/20 border-white/5 focus:bg-app-surface/40 transition-all rounded-lg py-2.5 text-sm"
                />
              )}
            </div>
          </div>

          <div className="flex items-center justify-between pt-4 border-t border-white/5">
            {/* Technical Note */}
            <div className="flex-1 pr-6">
              <div className="flex items-center gap-1.5 mb-1 opacity-40">
                <div className="w-1 h-1 rounded-full bg-app-accent" />
                <span className="text-[8px] font-black uppercase tracking-widest leading-none">Secure Relay</span>
              </div>
              <p className="text-[9px] text-app-muted leading-relaxed opacity-50 max-w-[280px]">
                Files are streamed securely through volatile <span className="text-app-accent/80 font-bold">memory buffers</span>. Zero-disk writes ensure your data leaves no trace on the local machine.
              </p>
            </div>

            <div className="flex gap-2.5 shrink-0">
              <Button variant="secondary" onClick={handleClose} className="px-5 py-2 rounded-lg font-bold opacity-60 hover:opacity-100 transition-all text-[11px]">
                Cancel
              </Button>
              <Button
                onClick={handleCopy}
                disabled={!selectedServerId || !destinationPath || (!isMultiSelect && !fileName) || availableServers.length === 0}
                className="group relative px-8 py-2 rounded-lg bg-gradient-to-br from-app-accent to-[#8a8cf2] shadow-md hover:shadow-app-accent/20 hover:-translate-y-0.5 active:translate-y-0 transition-all font-bold text-[11px]"
              >
                <div className="flex items-center gap-2 relative z-10">
                  <Copy size={14} className="group-hover:rotate-12 transition-transform duration-300" />
                  <span>Start Transfer</span>
                </div>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
