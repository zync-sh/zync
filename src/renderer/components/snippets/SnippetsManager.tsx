import { Code, Plus, Trash2, Edit2, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';
import type { Snippet } from '../../store/useAppStore';

// Snippet interface is now imported from store
// export interface Snippet ... removed


export function SnippetsManager({ connectionId }: { connectionId?: string }) {
  const showToast = useAppStore((state) => state.showToast);
  const activeConnectionId = connectionId || useAppStore(state => state.activeConnectionId);

  // Zustand State
  const snippets = useAppStore(state => state.snippets);
  const addSnippet = useAppStore(state => state.addSnippet);
  const deleteSnippet = useAppStore(state => state.deleteSnippet);
  const loadSnippets = useAppStore(state => state.loadSnippets);


  // Modal
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingSnippet, setEditingSnippet] = useState<Partial<Snippet>>({
    name: '',
    command: '',
    category: '',
    connectionId: undefined // Default to global
  });



  // Initial Load
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
      connectionId: editingSnippet.connectionId
    };

    await addSnippet(snippet);
    showToast('success', 'Snippet saved');
    setIsModalOpen(false);
    setEditingSnippet({ name: '', command: '', category: '', connectionId: undefined });

  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Delete this snippet?')) return;

    await deleteSnippet(id);
    showToast('success', 'Snippet deleted');

  };

  const handleEdit = (snippet: Snippet, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingSnippet(snippet);
    setIsModalOpen(true);
  };

  const handleCopy = (command: string, e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(command);
    showToast('success', 'Copied to clipboard');
  };

  const handleRun = (command: string) => {
    // Send to active terminal via Event Bus
    if (!activeConnectionId) {
      showToast('error', 'No active connection to run command');
      return;
    }

    // Dispatch event for TerminalManager to pick up
    const event = new CustomEvent('ssh-ui:run-command', {
      detail: {
        connectionId: activeConnectionId,
        command: command + '\r' // Append return to execute
      }
    });
    window.dispatchEvent(event);
    showToast('success', 'Command sent to terminal');
  };

  // Filter snippets based on connection scope
  const filteredSnippets = snippets.filter(s => {
    // Show if global (no connectionId) OR if it matches current connection
    return !s.connectionId || s.connectionId === activeConnectionId;
  });

  // Group snippets by category
  const groupedSnippets = filteredSnippets.reduce((acc, snippet) => {
    const cat = snippet.category || 'General';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(snippet);
    return acc;
  }, {} as Record<string, Snippet[]>);

  return (
    <div className="flex flex-col h-full bg-app-bg">
      <div className="p-4 border-b border-app-border flex justify-between items-center bg-app-panel">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Code size={20} className="text-app-accent" />
          Snippets
        </h2>
        <Button
          onClick={() => {
            // Default to current host/local if available, otherwise global
            const defaultScope = activeConnectionId ? activeConnectionId : undefined;
            setEditingSnippet({ name: '', command: '', category: '', connectionId: defaultScope });
            setIsModalOpen(true);
          }}
        >
          <Plus size={16} className="mr-2" /> New
        </Button>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-6">
        {filteredSnippets.length === 0 && (
          <div className="text-center text-app-muted mt-20">
            <p>No snippets found.</p>
            <p className="text-sm">Save your frequently used commands here.</p>
          </div>
        )}

        {Object.entries(groupedSnippets).map(([category, items]) => (
          <div key={category}>
            <h3 className="text-xs font-bold text-app-muted uppercase tracking-wider mb-2 ml-1">{category}</h3>
            <div className="grid gap-3">
              {items.map((snippet) => (
                <div
                  key={snippet.id}
                  className="bg-app-panel border border-app-border rounded-lg p-3 hover:border-app-accent transition-colors cursor-pointer group relative"
                  onClick={() => handleRun(snippet.command)}
                >
                  <div className="flex justify-between items-start mb-1">
                    <div className="flex items-center gap-2">
                      <h4 className="font-medium text-app-text text-sm">{snippet.name}</h4>
                      {snippet.connectionId && (
                        <span className="text-[10px] bg-app-accent/20 text-app-accent px-1.5 py-0.5 rounded-full">Host Only</span>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <button
                        onClick={(e) => handleCopy(snippet.command, e)}
                        className="text-app-muted hover:text-white opacity-0 group-hover:opacity-100 transition-opacity p-1"
                        title="Copy to Clipboard"
                      >
                        <Copy size={14} />
                      </button>
                      <button
                        onClick={(e) => handleEdit(snippet, e)}
                        className="text-app-muted hover:text-app-accent opacity-0 group-hover:opacity-100 transition-opacity p-1"
                        title="Edit"
                      >
                        <Edit2 size={14} />
                      </button>
                      <button
                        onClick={(e) => handleDelete(snippet.id, e)}
                        className="text-app-muted hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity p-1"
                        title="Delete"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  <div className="bg-app-bg/50 p-1.5 rounded border border-app-border/50 font-mono text-[10px] text-app-muted/80 truncate">
                    {snippet.command}
                  </div>
                  <div className="absolute right-3 bottom-3 opacity-0 group-hover:opacity-100 transition-opacity">
                    {/* Play icon or similar status could go here */}
                    <div className="text-[10px] text-app-accent font-medium bg-app-accent/10 px-2 py-0.5 rounded">Run</div>
                  </div>
                </div>
              ))}
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
          <Input
            label="Category"
            value={editingSnippet.category || ''}
            onChange={(e) => setEditingSnippet({ ...editingSnippet, category: e.target.value })}
            placeholder="e.g. System, Logs (Optional)"
          />

          {/* Scope Selection */}
          <div className="p-3 bg-app-surface/30 rounded-lg border border-app-border">
            <span className="text-xs font-medium text-app-text block mb-2">Scope</span>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm text-app-muted cursor-pointer hover:text-app-text">
                <input
                  type="radio"
                  name="scope"
                  checked={!editingSnippet.connectionId}
                  onChange={() => setEditingSnippet({ ...editingSnippet, connectionId: undefined })}
                  className="accent-app-accent"
                />
                Global (All Hosts)
              </label>
              {activeConnectionId && (
                <label className="flex items-center gap-2 text-sm text-app-muted cursor-pointer hover:text-app-text">
                  <input
                    type="radio"
                    name="scope"
                    checked={editingSnippet.connectionId === activeConnectionId}
                    onChange={() => setEditingSnippet({ ...editingSnippet, connectionId: activeConnectionId })}
                    className="accent-app-accent"
                  />
                  {activeConnectionId === 'local' ? 'Local Terminal Only' : 'This Host Only'}
                </label>
              )}
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-app-muted uppercase tracking-wider">Command</label>
            <textarea
              className="flex min-h-[80px] w-full rounded-md border border-app-border bg-app-surface/50 px-3 py-2 text-sm text-app-text shadow-sm transition-colors placeholder:text-app-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-app-accent font-mono"
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
