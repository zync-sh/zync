import { FileText } from 'lucide-react';
import { useState } from 'react';
import { useConnections } from '../../context/ConnectionContext';
import { useToast } from '../../context/ToastContext';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';

export function AddConnectionModal() {
  const { isAddConnectionModalOpen, closeAddConnectionModal, addConnection, importConnections, connections } =
    useConnections();
  const { showToast } = useToast();

  const [formData, setFormData] = useState({
    name: '',
    host: '',
    username: '',
    port: 22,
    password: '',
    privateKeyPath: '',
    jumpServerId: undefined as string | undefined,
  });

  const [authMethod, setAuthMethod] = useState<'password' | 'key'>('password');

  const handleSave = () => {
    if (!formData.host || !formData.username) {
      alert('Host and Username are required');
      return;
    }

    addConnection({
      id: crypto.randomUUID(),
      ...formData,
      status: 'disconnected',
    });

    closeAddConnectionModal();
    setFormData({
      name: '',
      host: '',
      username: '',
      port: 22,
      password: '',
      privateKeyPath: '',
      jumpServerId: undefined,
    });
    showToast('success', 'Connection added');
  };

  return (
    <Modal isOpen={isAddConnectionModalOpen} onClose={closeAddConnectionModal} title="New Connection">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Name"
            placeholder="Production DB"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          />
          <Input
            label="Host"
            placeholder="192.168.1.1"
            value={formData.host}
            onChange={(e) => setFormData({ ...formData, host: e.target.value })}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Username"
            placeholder="root"
            value={formData.username}
            onChange={(e) => setFormData({ ...formData, username: e.target.value })}
          />
          <Input
            label="Port"
            type="number"
            placeholder="22"
            value={formData.port}
            onChange={(e) => setFormData({ ...formData, port: Number(e.target.value) })}
          />
        </div>

        <div className="pt-4 border-t border-app-border">
          <div className="flex gap-2 mb-3">
            <Button
              size="sm"
              variant={authMethod === 'password' ? 'primary' : 'secondary'}
              onClick={() => setAuthMethod('password')}
            >
              Password
            </Button>
            <Button
              size="sm"
              variant={authMethod === 'key' ? 'primary' : 'secondary'}
              onClick={() => setAuthMethod('key')}
            >
              Private Key
            </Button>
          </div>

          {authMethod === 'password' ? (
            <Input
              label="Password"
              type="password"
              value={formData.password}
              onChange={(e) => setFormData({ ...formData, password: e.target.value })}
            />
          ) : (
            <div className="space-y-2">
              <label className="text-xs font-semibold text-app-muted uppercase tracking-wider block">Private Key</label>
              <div className="flex gap-2">
                <Input
                  className="flex-1"
                  readOnly
                  placeholder="No key selected"
                  value={formData.privateKeyPath ? formData.privateKeyPath.split(/[/\\]/).pop() : ''}
                />
                <Button
                  onClick={async () => {
                    try {
                      const { filePaths, canceled } = await window.ipcRenderer.invoke('dialog:openFile');
                      if (!canceled && filePaths.length > 0) {
                        const importedPath = await window.ipcRenderer.invoke('ssh:importKey', filePaths[0]);
                        setFormData({
                          ...formData,
                          privateKeyPath: importedPath,
                        });
                      }
                    } catch (e) {
                      console.error(e);
                      alert('Failed to import key');
                    }
                  }}
                >
                  Browse
                </Button>
              </div>
              <p className="text-[10px] text-app-muted/70">Selected key will be securely imported.</p>
            </div>
          )}
        </div>

        <div className="pt-4 border-t border-app-border">
          <label className="text-xs font-semibold text-app-muted uppercase tracking-wider block mb-2">
            Jump Server (Optional)
          </label>
          <select
            className="w-full bg-app-bg border border-app-border rounded-md px-3 py-2 text-sm text-app-text focus:border-app-accent focus:outline-none appearance-none"
            value={formData.jumpServerId || ''}
            onChange={(e) =>
              setFormData({
                ...formData,
                jumpServerId: e.target.value === '' ? undefined : e.target.value,
              })
            }
          >
            <option value="">None (Direct Connection)</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name || c.host} ({c.username}@{c.host})
              </option>
            ))}
          </select>
          <p className="text-[10px] text-app-muted/70 mt-1">Select a bastion host to route this connection through.</p>
        </div>

        <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-app-border">
          <Button
            variant="secondary"
            onClick={async () => {
              if (confirm('Import connections from ~/.ssh/config? This will skip duplicates.')) {
                try {
                  const configs = await window.ipcRenderer.invoke('ssh:readConfig');
                  if (configs && configs.length > 0) {
                    importConnections(configs);
                    alert(`Imported ${configs.length} connections.`);
                    closeAddConnectionModal();
                  } else {
                    alert('No connections found in config file.');
                  }
                } catch (e: any) {
                  console.error(e);
                  alert(`Failed to import config: ${e.message}`);
                }
              }
            }}
            className="mr-auto"
          >
            <FileText className="h-4 w-4 mr-2" />
            Import Config
          </Button>
          <Button variant="ghost" onClick={closeAddConnectionModal}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Create</Button>
        </div>
      </div>
    </Modal>
  );
}
