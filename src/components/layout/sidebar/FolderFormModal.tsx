import { useState, useEffect, useRef } from 'react';
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
    const normalizeTag = (tag: string) => tag.trim().toLowerCase();
    const normalizeTags = (tags: string[] = []) => Array.from(new Set(tags.map(normalizeTag).filter(Boolean)));

    const isEditMode = Boolean(initialName?.trim());
    const [name, setName] = useState(initialName ?? '');
    const [tags, setTags] = useState<string[]>(normalizeTags(initialTags));
    const [tagInput, setTagInput] = useState('');
    const wasOpenRef = useRef(false);

    useEffect(() => {
        const isOpening = !wasOpenRef.current && isOpen;
        if (isOpening) {
            setName(initialName ?? '');
            setTags(normalizeTags(initialTags));
            setTagInput('');
        }
        wasOpenRef.current = isOpen;
    }, [isOpen, initialName, initialTags]);

    const handleSubmit = () => {
        const trimmedName = name.trim();
        if (!trimmedName) return;
        onSubmit(trimmedName, tags);
    };

    const Icon = isEditMode ? Pencil : FolderPlus;

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={isEditMode ? "Rename Folder" : "New Folder"}>
            <div className="flex flex-col items-center pt-0 pb-2 px-1">
                {/* Icon Header */}
                <div className="mb-3">
                    <div className="bg-app-bg border border-app-border p-2.5 rounded-lg shadow-sm">
                        <Icon className="h-6 w-6 text-app-accent" />
                    </div>
                </div>

                {!isEditMode && (
                    <div className="text-center mb-3">
                        <h3 className="text-base font-bold text-app-text mb-1">New Folder</h3>
                        <p className="text-xs text-app-muted">Organize your connections by grouping them together.</p>
                    </div>
                )}

                <div className="w-full space-y-2.5">
                    <Input
                        label={isEditMode ? "Folder Name" : ""}
                        placeholder={isEditMode ? undefined : "Folder Name (e.g. Production)"}
                        value={name}
                        onChange={e => setName(e.target.value)}
                        autoFocus
                        className="py-2 text-center font-medium bg-app-surface/50 border-app-border focus:bg-app-bg transition-all"
                        onKeyDown={e => {
                            if (e.key === 'Enter' && name.trim()) handleSubmit();
                        }}
                    />

                    {/* Tags Input */}
                    <div className="space-y-1.5">
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
                                        const normalizedTag = normalizeTag(tagInput);
                                        if (normalizedTag && !tags.includes(normalizedTag)) {
                                            setTags([...tags, normalizedTag]);
                                            setTagInput('');
                                        }
                                    }
                                }}
                            />
                        </div>
                        <div className="flex flex-wrap gap-1.5 min-h-5">
                            {tags.map((tag, index) => (
                                <span key={`${tag}-${index}`} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-app-surface border border-app-border text-xs font-medium text-app-text">
                                    {tag}
                                    <button
                                        aria-label={`Remove tag ${tag}`}
                                        onClick={() => setTags(tags.filter((_, tagIndex) => tagIndex !== index))}
                                        className="hover:text-red-400 transition-colors"
                                    >
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
                                    </button>
                                </span>
                            ))}
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5 pt-1">
                        <Button
                            variant="ghost"
                            onClick={onClose}
                            className="w-full h-9 hover:bg-app-surface text-app-muted hover:text-app-text"
                        >
                            Cancel
                        </Button>
                        <Button
                            onClick={handleSubmit}
                            disabled={!name.trim()}
                            className="w-full h-9 bg-app-accent hover:bg-app-accent/90 text-white shadow-lg shadow-app-accent/20"
                        >
                            {isEditMode ? 'Save Changes' : 'Create Folder'}
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
