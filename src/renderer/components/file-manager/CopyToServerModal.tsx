import { Copy, Server } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAppStore, type Connection } from '../../store/useAppStore'; // Updated Import
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';

interface CopyToServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  sourceFile: {
    connectionId: string;
    path: string;
    name: string;
  } | null;
}

export function CopyToServerModal({ isOpen, onClose, sourceFile }: CopyToServerModalProps) {
  const connections = useAppStore(state => state.connections);
  const addTransfer = useAppStore(state => state.addTransfer);
  const completeTransfer = useAppStore(state => state.completeTransfer);
  const failTransfer = useAppStore(state => state.failTransfer);
  const showToast = useAppStore((state) => state.showToast);
  const [selectedServerId, setSelectedServerId] = useState('');
  const [destinationPath, setDestinationPath] = useState('');
  const [fileName, setFileName] = useState('');

  // Initialize state when sourceFile changes
  useEffect(() => {
    if (sourceFile) {
      setFileName(sourceFile.name);
      // Extract directory from source path
      const sourceDir = sourceFile.path.substring(0, sourceFile.path.lastIndexOf('/'));
      setDestinationPath(sourceDir || '/');
    }
  }, [sourceFile]);

  // Get list of all servers excluding the source
  const availableServers = connections.filter((conn: Connection) => conn.id !== sourceFile?.connectionId);

  const handleCopy = async () => {
    if (!sourceFile || !selectedServerId || !destinationPath || !fileName) {
      showToast('error', 'Please fill in all fields');
      return;
    }

    const fullDestPath = `${destinationPath}/${fileName}`.replace('//', '/');

    // Add transfer to background system
    const transferId = addTransfer({
      sourceConnectionId: sourceFile.connectionId,
      sourcePath: sourceFile.path,
      destinationConnectionId: selectedServerId,
      destinationPath: fullDestPath,
    });

    // Close modal immediately
    showToast('info', 'Transfer started in background');
    onClose();

    // Execute transfer in background (non-blocking)
    (async () => {
      try {
        // Connect destination server if not connected
        const destServer = connections.find((c: Connection) => c.id === selectedServerId);
        if (destServer && destServer.status !== 'connected') {
          await window.ipcRenderer.invoke('ssh:connect', {
            id: selectedServerId,
            host: destServer.host,
            port: destServer.port,
            username: destServer.username,
            privateKeyPath: destServer.privateKeyPath,
            jumpServerId: destServer.jumpServerId,
          });
        }

        // Start the transfer (SFTP auto-connects when SSH is connected)
        await window.ipcRenderer.invoke('sftp:copyToServer', {
          sourceConnectionId: sourceFile.connectionId,
          sourcePath: sourceFile.path,
          destinationConnectionId: selectedServerId,
          destinationPath: fullDestPath,
          transferId, // Pass the ID to backend for tracking
        });

        completeTransfer(transferId);
        showToast('success', `File copied successfully`);
      } catch (error: any) {
        // Only mark as failed if not cancelled
        if (error.message && !error.message.includes('destroy')) {
          failTransfer(transferId, error.message);
          showToast('error', `Copy failed: ${error.message}`);
        }
      }
    })();
  };

  const handleClose = () => {
    setSelectedServerId('');
    setDestinationPath('');
    setFileName('');
    onClose();
  };

  if (!sourceFile) return null;

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Copy File to Server">
      <div className="space-y-6">
        {/* Source Info */}
        <div className="p-3 bg-app-surface rounded-lg border border-app-border">
          <div className="text-xs text-app-muted mb-1">Source</div>
          <div className="text-sm text-app-text font-medium">{sourceFile.name}</div>
          <div className="text-xs text-app-muted mt-1">
            {connections.find((c: Connection) => c.id === sourceFile.connectionId)?.name}
          </div>
        </div>

        {/* Destination Server Selector */}
        <div className="space-y-2">
          <label htmlFor="destServer" className="text-sm font-medium text-app-muted">
            Destination Server
          </label>
          {availableServers.length === 0 ? (
            <div className="p-4 bg-app-surface rounded-lg border border-app-border text-center">
              <Server size={24} className="mx-auto mb-2 text-app-muted" />
              <p className="text-sm text-app-muted">No other servers available</p>
            </div>
          ) : (
            <select
              id="destServer"
              value={selectedServerId}
              onChange={(e) => setSelectedServerId(e.target.value)}
              className="w-full px-3 py-2 bg-app-bg border border-app-border rounded-md text-app-text focus:outline-none focus:ring-2 focus:ring-app-accent"
            >
              <option value="">Select a server...</option>
              {availableServers.map((conn: Connection) => (
                <option key={conn.id} value={conn.id}>
                  {conn.name} ({conn.username}@{conn.host})
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Destination Path */}
        <div className="space-y-2">
          <label htmlFor="destinationPath" className="text-sm font-medium text-app-muted">
            Destination Directory
          </label>
          <Input
            id="destinationPath"
            value={destinationPath}
            onChange={(e) => setDestinationPath(e.target.value)}
            placeholder="/path/to/directory"
          />
        </div>

        {/* File Name */}
        <div className="space-y-2">
          <label htmlFor="fileName" className="text-sm font-medium text-app-muted">
            File Name
          </label>
          <Input
            id="fileName"
            value={fileName}
            onChange={(e) => setFileName(e.target.value)}
            placeholder="filename.ext"
          />
        </div>

        {/* Final Path Preview */}
        <div className="p-3 bg-app-bg rounded-lg border border-app-border">
          <div className="text-xs text-app-muted mb-1">Final Path</div>
          <div className="text-sm text-app-text font-mono">
            {destinationPath && fileName ? `${destinationPath}/${fileName}`.replace('//', '/') : '---'}
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3 justify-end pt-4">
          <Button variant="secondary" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            onClick={handleCopy}
            disabled={!selectedServerId || !destinationPath || !fileName || availableServers.length === 0}
          >
            <Copy size={16} className="mr-2" />
            Copy File
          </Button>
        </div>
      </div>
    </Modal>
  );
}
