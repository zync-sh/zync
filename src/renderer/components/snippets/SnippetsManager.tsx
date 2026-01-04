import { Code, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useConnections } from '../../context/ConnectionContext';
import { useToast } from '../../context/ToastContext';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';

export interface Snippet {
  id: string;
  name: string;
  command: string;
  category?: string;
}

export function SnippetsManager() {
  const { showToast } = useToast();
  const { activeConnectionId } = useConnections();
  const [snippets, setSnippets] = useState<Snippet[]>([]);

  // Modal
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingSnippet, setEditingSnippet] = useState<Partial<Snippet>>({
    name: '',
    command: '',
  });



  const loadSnippets = async () => {
    const list = await window.ipcRenderer.invoke('snippets:getAll');
    setSnippets(list);
  };

  useEffect(() => {
    loadSnippets();
  }, []); // Only run on mount


  const handleSave = async () => {
    if (!editingSnippet.name || !editingSnippet.command) {
      showToast('error', 'Name and Command are required');
      return;
    }

    const snippet: Snippet = {
      id: editingSnippet.id || crypto.randomUUID(),
      name: editingSnippet.name,
      command: editingSnippet.command,
      category: editingSnippet.category || 'General',
    };

    await window.ipcRenderer.invoke('snippets:save', snippet);
    showToast('success', 'Snippet saved');
    setIsModalOpen(false);
    setEditingSnippet({ name: '', command: '' });
    loadSnippets();
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Delete this snippet?')) return;

    await window.ipcRenderer.invoke('snippets:delete', id);
    showToast('success', 'Snippet deleted');
    loadSnippets();
  };

  const handleRun = (command: string) => {
    // Send to active terminal
    if (!activeConnectionId) {
      showToast('error', 'No active connection to run command');
      return;
    }

    // We need termID. Wait, active connection might have multiple terms?
    // For now, let's just write to the active connection's main session.
    // Wait, 'terminal:write' needs termId.
    // We can't easily guess termId from here without context.
    // Alternative: Copy to clipboard.
    navigator.clipboard.writeText(command);
    showToast('success', 'Command copied to clipboard');
  };

  return (
    <div className="flex flex-col h-full bg-app-bg">
      <div className="p-4 border-b border-app-border flex justify-between items-center bg-app-panel">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Code size={20} className="text-app-accent" />
          Snippets
        </h2>
        <Button
          onClick={() => {
            setEditingSnippet({ name: '', command: '' });
            setIsModalOpen(true);
          }}
        >
          <Plus size={16} className="mr-2" /> New
        </Button>
      </div>

      <div className="flex-1 overflow-auto p-4 grid gap-4">
        {snippets.length === 0 && (
          <div className="text-center text-app-muted mt-20">
            <p>No snippets found.</p>
            <p className="text-sm">Save your frequently used commands here.</p>
          </div>
        )}
        {snippets.map((snippet) => (
          <div
            key={snippet.id}
            className="bg-app-panel border border-app-border rounded-lg p-4 hover:border-app-accent transition-colors cursor-pointer group"
            onClick={() => handleRun(snippet.command)}
          >
            <div className="flex justify-between items-start mb-2">
              <h3 className="font-medium text-white">{snippet.name}</h3>
              <button
                onClick={(e) => handleDelete(snippet.id, e)}
                className="text-app-muted hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <Trash2 size={16} />
              </button>
            </div>
            <div className="bg-app-bg p-2 rounded border border-app-border font-mono text-xs text-app-text truncate">
              {snippet.command}
            </div>
            <div className="flex justify-end gap-2 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
              <span className="text-xs text-app-muted self-center">Click to Copy</span>
            </div>
          </div>
        ))}
      </div>

      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingSnippet.id ? 'Edit Snippet' : 'New Snippet'}
      >
        <div className="space-y-4">
          <Input
            label="Name"
            value={editingSnippet.name}
            onChange={(e) => setEditingSnippet({ ...editingSnippet, name: e.target.value })}
            placeholder="e.g. Check Disk Space"
          />
          <div>
            <label className="block text-xs font-medium text-app-muted mb-1">Command</label>
            <textarea
              className="w-full bg-app-bg border border-app-border rounded p-2 text-sm text-app-text focus:outline-none focus:border-app-accent font-mono"
              rows={4}
              value={editingSnippet.command}
              onChange={(e) =>
                setEditingSnippet({
                  ...editingSnippet,
                  command: e.target.value,
                })
              }
              placeholder="df -h"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setIsModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave}>Save</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
