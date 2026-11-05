import { Save, Search } from 'lucide-react';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';

import {
    clearEditorStatus,
    createEditorStatusSource,
    publishEditorStatus,
} from '../features/editor/editorStatus';
import {
    type EditorSaveAccess,
    EditorSaveBlockedError,
    editorSaveBlocked,
    editorSaveErrorMessage,
} from '../features/files/domain/editorSaveAccess';
import { isXtermKeyboardTarget } from '../lib/shortcuts';
import { useAppStore } from '../store/useAppStore';
import { formatCodeMirrorStatus } from './editor/codemirror/status';
import { EditorSaveAccessStatus } from './editor/EditorSaveAccessStatus';
import { createPlainCursorIndex } from './editor/editorStatusReport';
import { markPlainDocumentSaved, reconcilePlainDocument } from './editor/plainDocumentState';
import { indexPlainSearchMatches } from './editor/plainSearchIndex';
import { Button } from './ui/Button';
import { Input } from './ui/Input';

interface PlainFileEditorProps {
    documentId?: string;
    filename: string;
    initialContent: string;
    onSave: (content: string) => Promise<void>;
    onClose: () => void;
    onDirtyChange?: (dirty: boolean) => void;
    /**
     * Hides the built-in header toolbar (Save, Close, Find toggle and shortcut chips).
     *
     * When true, editing actions remain available via keyboard shortcuts only
     * (Ctrl/Cmd+S save, Ctrl/Cmd+W close, Ctrl/Cmd+F find), so parent containers
     * should provide equivalent visible controls for discoverability/accessibility.
     */
    hideToolbar?: boolean;
    saveAccess?: EditorSaveAccess;
}

/** Edit the complete fallback document while indexing search and cursor status separately from selection. */
export function PlainFileEditor({
    documentId,
    filename,
    initialContent,
    onSave,
    onClose,
    onDirtyChange,
    hideToolbar = false,
    saveAccess,
}: PlainFileEditorProps) {
    const documentKey = documentId ?? filename;
    const [documentState, setDocumentState] = useState(() => ({
        documentId: documentKey,
        content: initialContent,
        savedContent: initialContent,
    }));
    const { content, savedContent } = documentState;
    const [searchText, setSearchText] = useState('');
    const [matchIndex, setMatchIndex] = useState(-1);
    const [isSaving, setIsSaving] = useState(false);
    const pendingSave = useRef(false);
    const saveBlocked = editorSaveBlocked(saveAccess);
    const [showSearch, setShowSearch] = useState(false);
    const [selectionStart, setSelectionStart] = useState(0);

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const statusSourceRef = useRef(createEditorStatusSource(`plain-editor:${filename}`));
    const showConfirmDialog = useAppStore((state) => state.showConfirmDialog);
    const showToast = useAppStore((state) => state.showToast);

    useEffect(() => {
        setDocumentState((current) => reconcilePlainDocument(current, documentKey, initialContent));
    }, [documentKey, initialContent]);

    useEffect(() => {
        setSearchText('');
        setMatchIndex(-1);
        setShowSearch(false);
        setSelectionStart(0);
    }, [documentKey]);

    const isDirty = content !== savedContent;
    const cursorIndex = useMemo(() => createPlainCursorIndex(content), [content]);
    const deferredContent = useDeferredValue(content);
    const deferredSearchText = useDeferredValue(searchText);
    const searchPending = deferredContent !== content || deferredSearchText !== searchText;
    const searchableContent = useMemo(
        () => (showSearch ? deferredContent.toLowerCase() : ''),
        [deferredContent, showSearch],
    );
    useEffect(() => onDirtyChange?.(isDirty), [isDirty, onDirtyChange]);
    const languageLabel = useMemo(() => {
        const ext = filename.split('.').pop()?.toUpperCase() ?? 'TEXT';
        return ext || 'TEXT';
    }, [filename]);

    const matches = useMemo(() => {
        return indexPlainSearchMatches(
            searchableContent,
            showSearch ? deferredSearchText.toLowerCase() : '',
        );
    }, [searchableContent, deferredSearchText, showSearch]);

    const activeMatch = useMemo(
        () => (!searchPending && matchIndex >= 0 ? matches.at(matchIndex) : undefined),
        [matches, matchIndex, searchPending],
    );

    useEffect(() => {
        setMatchIndex((previous) => {
            if (!matches.length) {
                return previous === -1 ? previous : -1;
            }
            const safeIndex = previous >= 0 && previous < matches.length ? previous : 0;
            return safeIndex === previous ? previous : safeIndex;
        });
    }, [matches]);

    useEffect(() => {
        if (matchIndex >= 0) {
            const textarea = textareaRef.current;
            const match = activeMatch;
            if (!textarea || !match) {
                return;
            }
            textarea.setSelectionRange(match.start, match.end);
        }
    }, [activeMatch, matchIndex]);

    const handleSave = useCallback(async () => {
        if (pendingSave.current || saveBlocked) {
            return;
        }
        pendingSave.current = true;
        setIsSaving(true);
        try {
            await onSave(content);
            setDocumentState((current) => markPlainDocumentSaved(current, documentKey, content));
        } catch (error) {
            if (!(error instanceof EditorSaveBlockedError)) {
                showToast('error', editorSaveErrorMessage(error));
            }
        } finally {
            setIsSaving(false);
            pendingSave.current = false;
        }
    }, [content, documentKey, onSave, saveBlocked, showToast]);

    const handleClose = useCallback(async () => {
        if (!isDirty) {
            onClose();
            return;
        }

        const confirmed = await showConfirmDialog({
            title: 'Discard unsaved changes?',
            message: `Close ${filename} without saving your changes?`,
            confirmText: 'Discard',
            cancelText: 'Keep Editing',
            variant: 'danger',
        });

        if (confirmed) {
            onClose();
        }
    }, [filename, isDirty, onClose, showConfirmDialog]);

    const handleNextMatch = useCallback(() => {
        if (!matches.length || searchPending) {
            return;
        }
        const nextIndex = matchIndex < 0 ? 0 : (matchIndex + 1) % matches.length;
        setMatchIndex(nextIndex);
    }, [matchIndex, matches.length, searchPending]);

    const handlePrevMatch = useCallback(() => {
        if (!matches.length || searchPending) {
            return;
        }
        const nextIndex = matchIndex <= 0 ? matches.length - 1 : matchIndex - 1;
        setMatchIndex(nextIndex);
    }, [matchIndex, matches.length, searchPending]);

    useEffect(() => {
        /** Route fallback-editor shortcuts without claiming terminal or composing input. */
        const handleKeyDown = (event: KeyboardEvent) => {
            // A mounted editor must not claim keys from a neighboring terminal pane.
            if (
                event.defaultPrevented ||
                event.isComposing ||
                isXtermKeyboardTarget(event.composedPath()[0] ?? event.target)
            ) {
                return;
            }
            const ctrlOrMeta = event.ctrlKey || event.metaKey;
            if (ctrlOrMeta && event.key.toLowerCase() === 's') {
                event.preventDefault();
                void handleSave();
                return;
            }

            if (ctrlOrMeta && event.key.toLowerCase() === 'f') {
                event.preventDefault();
                setShowSearch(true);
                requestAnimationFrame(() => searchRef.current?.focus());
                return;
            }

            if (ctrlOrMeta && event.key.toLowerCase() === 'w') {
                event.preventDefault();
                void handleClose();
                return;
            }

            if (event.key === 'Escape') {
                event.preventDefault();
                if (showSearch) {
                    setShowSearch(false);
                    searchRef.current?.blur();
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown, { capture: true });
        return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
    }, [handleClose, handleSave, showSearch]);

    useEffect(() => {
        const { line, column } = cursorIndex.position(selectionStart);
        publishEditorStatus(
            statusSourceRef.current,
            formatCodeMirrorStatus(filename, line, column, languageLabel, isDirty),
        );
    }, [cursorIndex, filename, isDirty, languageLabel, selectionStart]);

    useEffect(() => () => clearEditorStatus(statusSourceRef.current), []);

    return (
        <div className="absolute inset-0 z-[70] flex min-h-0 flex-col bg-app-panel">
            {!hideToolbar && (
                <div className="@container flex min-h-10 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-app-border px-3 py-1">
                    <div className="flex min-w-0 flex-1 basis-48 items-center gap-3">
                        <div className="truncate text-sm font-semibold text-app-text">
                            {filename}
                        </div>
                        <EditorSaveAccessStatus access={saveAccess} />
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        <span className="hidden rounded border border-app-border bg-app-surface/40 px-2 py-0.5 text-[10px] font-medium text-app-muted @min-[760px]:inline">
                            Ctrl/Cmd+S
                        </span>
                        <span className="hidden rounded border border-app-border bg-app-surface/40 px-2 py-0.5 text-[10px] font-medium text-app-muted @min-[760px]:inline">
                            Ctrl/Cmd+F
                        </span>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                                setShowSearch((current) => {
                                    const next = !current;
                                    if (next) {
                                        requestAnimationFrame(() => searchRef.current?.focus());
                                    }
                                    return next;
                                });
                            }}
                        >
                            <Search className="mr-1 h-3.5 w-3.5" />
                            Find
                        </Button>
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                                void handleClose();
                            }}
                        >
                            Close
                        </Button>
                        <Button
                            variant={saveBlocked ? 'ghost' : 'primary'}
                            size="sm"
                            disabled={saveBlocked}
                            isLoading={isSaving}
                            onClick={() => {
                                void handleSave();
                            }}
                        >
                            <Save className="mr-1 h-3.5 w-3.5" />
                            Save
                        </Button>
                    </div>
                </div>
            )}
            <div className="flex min-h-0 flex-1 flex-col">
                {hideToolbar && saveBlocked && (
                    <div className="border-b border-app-border px-3 py-1">
                        <EditorSaveAccessStatus access={saveAccess} />
                    </div>
                )}

                {showSearch && (
                    <div className="flex items-center gap-2 border-b border-app-border bg-app-surface/30 px-3 py-2">
                        <Input
                            ref={searchRef}
                            value={searchText}
                            onChange={(event) => {
                                setSearchText(event.target.value);
                                setMatchIndex(0);
                            }}
                            placeholder="Find in file..."
                            className="h-9"
                        />
                        <div className="min-w-[72px] text-right text-xs text-app-muted">
                            {searchPending
                                ? 'Searching…'
                                : matches.length === 0
                                  ? '0'
                                  : `${Math.max(matchIndex, 0) + 1}/${matches.length}`}
                        </div>
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={handlePrevMatch}
                            disabled={!matches.length || searchPending}
                        >
                            Prev
                        </Button>
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={handleNextMatch}
                            disabled={!matches.length || searchPending}
                        >
                            Next
                        </Button>
                    </div>
                )}

                <textarea
                    ref={textareaRef}
                    value={content}
                    readOnly={saveBlocked}
                    onChange={(event) => {
                        const nextContent = event.target.value;
                        setDocumentState((current) => ({ ...current, content: nextContent }));
                        setSelectionStart(event.target.selectionStart);
                    }}
                    onSelect={(event) => setSelectionStart(event.currentTarget.selectionStart)}
                    spellCheck={false}
                    className="min-h-0 flex-1 resize-none border-0 bg-app-bg px-4 py-3 font-mono text-sm leading-6 text-app-text outline-none ring-0 placeholder:text-app-muted"
                    aria-label={`Fallback editor for ${filename}`}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                />
            </div>
        </div>
    );
}
