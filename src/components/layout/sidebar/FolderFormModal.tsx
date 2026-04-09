import { useState, useEffect } from 'react';
import { FolderPlus, Pencil } from 'lucide-react';
import { Modal } from '../../ui/Modal';
import { Input } from '../../ui/Input';
import { Button } from '../../ui/Button';

interface FolderFormModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSubmit: (name: string, tags: string[]) => void;
    /** When provided, the modal is in "edit" mode with pre-filled values */
    initialName?: string;
    initialTags?: string[];
}

export function FolderFormModal({ isOpen, onClose, onSubmit, initialName, initialTags }: FolderFormModalProps) {
    const isEditMode = initialName !== undefined;
    const [name, setName] = useState(initialName ?? '');
    const [tags, setTags] = useState<string[]>(initialTags ?? []);
    const [tagInput, setTagInput] = useState('');

    useEffect(() => {
        if (!isOpen) return;
        setName(initialName ?? '');
        setTags(initialTags ?? []);
        setTagInput('');
    }, [isOpen, initialName, initialTags]);

    const handleSubmit = () => {
        const trimmedName = name.trim();
        if (!trimmedName) return;
        onSubmit(trimmedName, tags);
    };

    const Icon = isEditMode ? Pencil : FolderPlus;

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={isEditMode ? "Rename Folder" : ""}>
            <div className="flex flex-col items-center pt-2 pb-4 px-2">
                {/* Icon Header */}
                <div className="mb-6 relative">
                    <div className="absolute inset-0 bg-app-accent/20 blur-xl rounded-full" />
                    <div className="relative bg-app-bg border border-app-border p-4 rounded-2xl shadow-xl">
                        <Icon className="h-8 w-8 text-app-accent" />
                    </div>
                </div>

                {!isEditMode && (
                    <div className="text-center mb-6">
                        <h3 className="text-lg font-bold text-app-text mb-1">New Folder</h3>
                        <p className="text-xs text-app-muted">Organize your connections by grouping them together.</p>
                    </div>
                )}

                <div className="w-full space-y-4">
                    <Input
                        label={isEditMode ? "Folder Name" : ""}
                        placeholder={isEditMode ? undefined : "Folder Name (e.g. Production)"}
                        value={name}
                        onChange={e => setName(e.target.value)}
                        autoFocus
                        className="py-2.5 text-center font-medium bg-app-surface/50 border-app-border focus:bg-app-bg transition-all"
                        onKeyDown={e => {
                            if (e.key === 'Enter' && name.trim()) handleSubmit();
                        }}
                    />

                    {/* Tags Input */}
                    <div className="space-y-2">
                        {isEditMode && (
                            <label className="text-xs font-semibold text-app-muted uppercase tracking-wider block">Tags</label>
                        )}
                        <div className="flex gap-2">
                            <Input
                                placeholder="Add a tag..."
                                className="flex-1 text-xs"
                                value={tagInput}
                                onChange={e => setTagInput(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        const val = tagInput.trim();
                                        if (val && !tags.includes(val)) {
                                            setTags([...tags, val]);
                                            setTagInput('');
                                        }
                                    }
                                }}
                            />
                        </div>
                        <div className="flex flex-wrap gap-2 min-h-6">
                            {tags.map(tag => (
                                <span key={tag} className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-app-surface border border-app-border text-xs font-medium text-app-text">
                                    {tag}
                                    <button
                                        aria-label={`Remove tag ${tag}`}
                                        onClick={() => setTags(tags.filter(t => t !== tag))}
                                        className="hover:text-red-400 transition-colors"
                                    >
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
                                    </button>
                                </span>
                            ))}
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3 pt-2">
                        <Button
                            variant="ghost"
                            onClick={onClose}
                            className="w-full hover:bg-app-surface text-app-muted hover:text-app-text"
                        >
                            Cancel
                        </Button>
                        <Button
                            onClick={handleSubmit}
                            disabled={!name.trim()}
                            className="w-full bg-app-accent hover:bg-app-accent/90 text-white shadow-lg shadow-app-accent/20"
                        >
                            {isEditMode ? 'Save Changes' : 'Create Folder'}
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
