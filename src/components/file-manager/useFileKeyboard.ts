import { type Dispatch, type RefObject, type SetStateAction, useEffect } from 'react';

import { resolveShortcutBindings } from '../../features/shortcuts/bindings';
import { SHORTCUT_CATALOG } from '../../features/shortcuts/catalog';
import { isMatch } from '../../lib/keyboard';
import type { AppSettings } from '../../store/settingsSlice';
import type { FileEntry } from './types';

function isFileManagerPanelShown(container: HTMLDivElement | null): boolean {
    if (!container) {
        return false;
    }
    return container.offsetParent !== null;
}

export function useFileKeyboard({
    requestFocusReveal,
    containerRef,
    listingFocusRef,
    isConnected,
    isFilesSurfaceActive,
    settings,
    paintedFiles,
    selectedFiles,
    focusedFile,
    setSelectedFiles,
    setFocusedFile,
    viewMode,
    gridColumnCount,
    isSearchOpen,
    searchTerm,
    setIsSearchOpen,
    setSearchTerm,
    isPropertiesOpen,
    setIsPropertiesOpen,
    isNewFolderModalOpen,
    isNewFileModalOpen,
    isRenameModalOpen,
    isCopyModalOpen,
    editingFile,
    activeConnectionId,
    handleNavigate,
    handleCopy,
    handlePaste,
    handleDelete,
    toggleBookmark,
    handleRefresh,
    navigateBack,
    navigateForward,
    setViewMode,
    updateFileManagerSettings,
    setIsEditingPath,
    openRenameModal,
}: {
    requestFocusReveal: () => void;
    containerRef: RefObject<HTMLDivElement | null>;
    listingFocusRef: RefObject<HTMLDivElement | null>;
    isConnected: boolean;
    isFilesSurfaceActive: boolean;
    settings: AppSettings;
    paintedFiles: FileEntry[];
    selectedFiles: string[];
    focusedFile: string | null;
    setSelectedFiles: Dispatch<SetStateAction<string[]>>;
    setFocusedFile: Dispatch<SetStateAction<string | null>>;
    viewMode: 'grid' | 'list';
    gridColumnCount: number;
    isSearchOpen: boolean;
    searchTerm: string;
    setIsSearchOpen: (open: boolean) => void;
    setSearchTerm: (term: string) => void;
    isPropertiesOpen: boolean;
    setIsPropertiesOpen: Dispatch<SetStateAction<boolean>>;
    isNewFolderModalOpen: boolean;
    isNewFileModalOpen: boolean;
    isRenameModalOpen: boolean;
    isCopyModalOpen: boolean;
    editingFile: FileEntry | null;
    activeConnectionId: string | undefined;
    handleNavigate: (name: string) => void;
    handleCopy: (cut?: boolean) => void;
    handlePaste: () => void;
    handleDelete: () => void;
    toggleBookmark: () => void;
    handleRefresh: () => void;
    navigateBack: (connectionId: string) => void;
    navigateForward: (connectionId: string) => void;
    setViewMode: (mode: 'grid' | 'list') => void;
    updateFileManagerSettings: (updates: Partial<AppSettings['fileManager']>) => Promise<void>;
    setIsEditingPath: (editing: boolean) => void;
    openRenameModal: (name: string) => void;
}) {
    useEffect(() => {
        if (!isConnected) {
            return;
        }

        const handleKeyDown = (e: KeyboardEvent) => {
            // Shared chrome/menu controls own their native keys, not the listing behind them.
            if (e.defaultPrevented || e.isComposing) {
                return;
            }
            if (!(e.target instanceof Node) || !containerRef.current?.contains(e.target)) {
                return;
            }
            if (
                e.target instanceof Element &&
                e.target.closest('[role="menu"], [role="dialog"], select, [contenteditable="true"]')
            ) {
                return;
            }
            // Resize handles own their keys; other chrome keeps its existing modified shortcuts.
            // Escape remains available for Files dismissal when a handle is not being dragged.
            if (
                e.key !== 'Escape' &&
                e.target instanceof Element &&
                (e.target.closest('[role="separator"]') ||
                    (!e.ctrlKey && !e.metaKey && !e.altKey && e.target.closest('button, a')))
            ) {
                return;
            }
            if (
                !isFilesSurfaceActive ||
                !isFileManagerPanelShown(containerRef.current) ||
                isNewFolderModalOpen ||
                isNewFileModalOpen ||
                isRenameModalOpen ||
                editingFile ||
                isCopyModalOpen
            ) {
                return;
            }
            if (
                (e.ctrlKey || e.metaKey) &&
                e.key.toLowerCase() === 'c' &&
                window.getSelection()?.toString()
            ) {
                return;
            }
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
                const isSearchInput = e.target.hasAttribute('data-file-filter-input');
                const isNavigationKey =
                    !e.ctrlKey &&
                    !e.metaKey &&
                    !e.altKey &&
                    ['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key);
                if (!(isSearchInput && isNavigationKey)) {
                    return;
                }
                listingFocusRef.current?.focus({ preventScroll: true });
            }

            const matches = (id: string) => {
                const command = SHORTCUT_CATALOG.find(
                    (row) => row.id === id && row.when === 'files',
                );
                return Boolean(
                    command &&
                        resolveShortcutBindings(
                            command,
                            settings.keybindings ?? {},
                            SHORTCUT_CATALOG,
                        ).active.some((chord) => isMatch(e, chord)),
                );
            };

            if (matches('fmSelectAll')) {
                e.preventDefault();
                setSelectedFiles(paintedFiles.map((f) => f.name));
                return;
            }

            if (isMatch(e, 'Escape')) {
                if (isPropertiesOpen) {
                    e.preventDefault();
                    setIsPropertiesOpen(false);
                    return;
                }
                if (isSearchOpen || searchTerm) {
                    setIsSearchOpen(false);
                    setSearchTerm('');
                } else {
                    setSelectedFiles([]);
                    setFocusedFile(null);
                }
                return;
            }

            if (matches('fmSearch')) {
                e.preventDefault();
                setIsSearchOpen(true);
                return;
            }

            if (matches('fmListView')) {
                e.preventDefault();
                setViewMode('list');
                return;
            }
            if (matches('fmGridView')) {
                e.preventDefault();
                setViewMode('grid');
                return;
            }
            if (matches('fmHidden')) {
                e.preventDefault();
                void updateFileManagerSettings({
                    showHiddenFiles: !settings.fileManager.showHiddenFiles,
                });
                return;
            }
            if (matches('fmBookmark')) {
                e.preventDefault();
                toggleBookmark();
                return;
            }
            if (matches('fmRefresh')) {
                e.preventDefault();
                handleRefresh();
                return;
            }
            if (!e.ctrlKey && !e.altKey && !e.metaKey && (e.key === '/' || e.key === '~')) {
                e.preventDefault();
                setIsEditingPath(true);
                return;
            }

            if (
                !e.ctrlKey &&
                !e.altKey &&
                !e.metaKey &&
                e.key.length === 1 &&
                /^[a-zA-Z0-9_\-]$/.test(e.key)
            ) {
                if (!isSearchOpen) {
                    e.preventDefault();
                    setIsSearchOpen(true);
                    setSearchTerm(e.key);
                    return;
                }
            }

            if (matches('fmBack')) {
                e.preventDefault();
                if (activeConnectionId) {
                    navigateBack(activeConnectionId);
                }
                return;
            }

            if (matches('fmForward')) {
                e.preventDefault();
                if (activeConnectionId) {
                    navigateForward(activeConnectionId);
                }
                return;
            }

            if (matches('fmUp')) {
                e.preventDefault();
                handleNavigate('..');
                return;
            }

            if (matches('fmDelete') && selectedFiles.length > 0) {
                e.preventDefault();
                handleDelete();
                return;
            }

            if (matches('fmRename') && (focusedFile || selectedFiles.length === 1)) {
                e.preventDefault();
                const fileToRename = focusedFile || selectedFiles[0];
                openRenameModal(fileToRename);
                return;
            }

            if (matches('fmEditPath')) {
                e.preventDefault();
                setIsEditingPath(true);
                return;
            }

            if (isMatch(e, 'Alt+Enter') && (focusedFile || selectedFiles.length > 0)) {
                e.preventDefault();
                if (!isPropertiesOpen && selectedFiles.length === 0 && focusedFile) {
                    setSelectedFiles([focusedFile]);
                }
                setIsPropertiesOpen((prev) => !prev);
                return;
            }

            if (matches('fmOpen') && focusedFile) {
                e.preventDefault();
                handleNavigate(focusedFile);
                return;
            }

            if (e.key === ' ' && focusedFile) {
                e.preventDefault();
                setSelectedFiles((prev) => {
                    const next = new Set(prev);
                    if (next.has(focusedFile)) {
                        next.delete(focusedFile);
                    } else {
                        next.add(focusedFile);
                    }
                    return Array.from(next);
                });
                return;
            }

            if (matches('fmCopy')) {
                e.preventDefault();
                handleCopy(false);
                return;
            }

            if (matches('fmCut')) {
                e.preventDefault();
                handleCopy(true);
                return;
            }

            if (matches('fmPaste')) {
                e.preventDefault();
                handlePaste();
                return;
            }

            // Horizontal movement in List view belongs to the viewport, not row selection.
            if (
                viewMode === 'list' &&
                !e.ctrlKey &&
                !e.metaKey &&
                !e.altKey &&
                (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
            ) {
                const viewport = listingFocusRef.current?.querySelector<HTMLElement>(
                    '[data-file-list-viewport]',
                );
                if (viewport) {
                    e.preventDefault();
                    viewport.scrollBy({
                        left: (e.key === 'ArrowRight' ? 1 : -1) * 64,
                        behavior: 'auto',
                    });
                }
                return;
            }

            if (paintedFiles.length === 0) {
                return;
            }

            const currentIndex = focusedFile
                ? paintedFiles.findIndex((f) => f.name === focusedFile)
                : -1;

            if (
                e.key === 'ArrowDown' ||
                e.key === 'ArrowUp' ||
                e.key === 'ArrowLeft' ||
                e.key === 'ArrowRight'
            ) {
                e.preventDefault();
                let newIndex = currentIndex;
                if (viewMode === 'grid') {
                    const gridCols = Math.max(1, gridColumnCount);
                    if (e.key === 'ArrowDown') {
                        newIndex = Math.min(currentIndex + gridCols, paintedFiles.length - 1);
                    } else if (e.key === 'ArrowUp') {
                        newIndex = Math.max(currentIndex - gridCols, 0);
                    } else if (e.key === 'ArrowRight') {
                        newIndex = Math.min(currentIndex + 1, paintedFiles.length - 1);
                    } else if (e.key === 'ArrowLeft') {
                        newIndex = Math.max(currentIndex - 1, 0);
                    }
                } else {
                    if (e.key === 'ArrowDown') {
                        newIndex = Math.min(currentIndex + 1, paintedFiles.length - 1);
                    } else if (e.key === 'ArrowUp') {
                        newIndex = Math.max(currentIndex - 1, 0);
                    }
                }
                if (newIndex === -1) {
                    newIndex = 0;
                }
                const newFocused = paintedFiles[newIndex]?.name;
                if (!newFocused) {
                    return;
                }
                setFocusedFile(newFocused);
                requestFocusReveal();
                if (e.shiftKey) {
                    setSelectedFiles((prev) => {
                        const next = new Set(prev);
                        next.add(newFocused);
                        return Array.from(next);
                    });
                } else if (!e.ctrlKey && !e.metaKey) {
                    setSelectedFiles([newFocused]);
                }
                return;
            }

            if (e.key === 'Home') {
                e.preventDefault();
                if (paintedFiles.length > 0) {
                    setFocusedFile(paintedFiles[0].name);
                }
                requestFocusReveal();
                return;
            }

            if (e.key === 'End') {
                e.preventDefault();
                if (paintedFiles.length > 0) {
                    setFocusedFile(paintedFiles[paintedFiles.length - 1].name);
                }
                requestFocusReveal();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [
        activeConnectionId,
        containerRef,
        listingFocusRef,
        editingFile,
        focusedFile,
        gridColumnCount,
        handleCopy,
        handleDelete,
        handleNavigate,
        handlePaste,
        isConnected,
        isCopyModalOpen,
        isFilesSurfaceActive,
        isNewFileModalOpen,
        isNewFolderModalOpen,
        isPropertiesOpen,
        isRenameModalOpen,
        isSearchOpen,
        navigateBack,
        navigateForward,
        paintedFiles,
        handleRefresh,
        requestFocusReveal,
        searchTerm,
        selectedFiles,
        setFocusedFile,
        setIsEditingPath,
        setIsPropertiesOpen,
        setIsSearchOpen,
        openRenameModal,
        setSearchTerm,
        setSelectedFiles,
        setViewMode,
        settings,
        toggleBookmark,
        updateFileManagerSettings,
        viewMode,
    ]);
}

export { isFileManagerPanelShown };
