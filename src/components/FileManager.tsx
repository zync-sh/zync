import {
  Clipboard,
  Copy,
  Download,
  FileArchive,
  FolderInput,
  RotateCw,
  Scissors,
  Server,
  Trash2,
  Upload,
} from 'lucide-react';
import { ConfirmModal } from './ui/ConfirmModal';
import { useCallback, useEffect, useState, useRef } from 'react';
import { useAppStore, Connection } from '../store/useAppStore';
import { isMatch } from '../lib/keyboard';
import { FileEditor } from './FileEditor';
import { CopyToServerModal } from './file-manager/CopyToServerModal';
import { FileGrid } from './file-manager/FileGrid';
import { getCurrentDragSource } from '../lib/dragDrop';
import { FileToolbar } from './file-manager/FileToolbar';
import type { FileEntry } from './file-manager/types';
import { PropertiesPanel } from './file-manager/PropertiesPanel';
import { Info } from 'lucide-react'; // Add Info icon import
import { Button } from './ui/Button';
import { ContextMenu, type ContextMenuItem } from './ui/ContextMenu';
import { Input } from './ui/Input';
import { Modal } from './ui/Modal';
import { useTauriFileDrop } from '../hooks/useTauriFileDrop';
import { FileBottomToolbar } from './file-manager/FileBottomToolbar';

export function FileManager({ connectionId, isVisible }: { connectionId?: string; isVisible?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const globalActiveId = useAppStore(state => state.activeConnectionId);
  const connections = useAppStore(state => state.connections);
  const activeConnectionId = connectionId || globalActiveId;
  const addTransfer = useAppStore(state => state.addTransfer);
  const failTransfer = useAppStore(state => state.failTransfer);

  // Find the actual connection object to check status
  const isLocal = activeConnectionId === 'local';
  const connection = !isLocal ? connections.find((c: Connection) => c.id === activeConnectionId) : null;
  // Local is always "connected" for file operations
  const isConnected = isLocal || connection?.status === 'connected';

  const settings = useAppStore(state => state.settings);
  const showToast = useAppStore((state) => state.showToast);

  // Zustand Store Hooks
  const filesMap = useAppStore(state => state.files);
  const currentPathMap = useAppStore(state => state.currentPath);
  const loadingMap = useAppStore(state => state.isLoading);
  const loadFiles = useAppStore(state => state.loadFiles);
  const refreshFiles = useAppStore(state => state.refreshFiles);
  const createFolder = useAppStore(state => state.createFolder);
  const renameEntry = useAppStore(state => state.renameEntry);
  const deleteEntries = useAppStore(state => state.deleteEntries);
  const uploadAction = useAppStore(state => state.uploadFiles);
  const navigateBack = useAppStore(state => state.navigateBack);
  const navigateForward = useAppStore(state => state.navigateForward);
  const pasteEntries = useAppStore(state => state.pasteEntries);
  const clipboard = useAppStore(state => state.clipboard);
  const setClipboard = useAppStore(state => state.setClipboard);
  const clearClipboard = useAppStore(state => state.clearClipboard);
  const updateSettings = useAppStore(state => state.updateSettings);
  // const downloadAction = useAppStore(state => state.downloadFiles); // Not implemented fully yet

  // Derived State
  const files = activeConnectionId ? (filesMap[activeConnectionId] || []) : [];
  const currentPath = activeConnectionId ? (currentPathMap[activeConnectionId] || '') : '';
  const loading = activeConnectionId ? (loadingMap[activeConnectionId] || false) : false;

  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [focusedFile, setFocusedFile] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isEditingPath, setIsEditingPath] = useState(false);

  // Editor State
  const [editingFile, setEditingFile] = useState<FileEntry | null>(null);
  const [editorContent, setEditorContent] = useState('');

  // Modal States
  const [isNewFolderModalOpen, setIsNewFolderModalOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [isRenameModalOpen, setIsRenameModalOpen] = useState(false);
  const [renameOldName, setRenameOldName] = useState('');
  const [renameNewName, setRenameNewName] = useState('');

  // Properties Panel State
  const [isPropertiesOpen, setIsPropertiesOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Context Menu State
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    file: FileEntry | null;
  } | null>(null);

  // Drag Drop State
  const [isInternalDraggingOver, setIsInternalDraggingOver] = useState(false);
  const [dragType, setDragType] = useState<'local' | 'server' | null>(null);
  const [dragSourceConnectionId, setDragSourceConnectionId] = useState<string | null>(null);

  // Copy to Server State
  const [isCopyModalOpen, setIsCopyModalOpen] = useState(false);
  const [filesToCopy, setFilesToCopy] = useState<{
    connectionId: string;
    path: string;
    name: string;
  }[]>([]);
  const [initialDestConnectionId, setInitialDestConnectionId] = useState<string | undefined>();
  const [initialDestPath, setInitialDestPath] = useState<string | undefined>();

  const [isProcessing, setIsProcessing] = useState(false);
  const [isZipping, setIsZipping] = useState(false);
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);

  const isSmallScreen = windowWidth < 640;

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Combine store loading and local processing
  const isLoading = loading || isProcessing;

  const performUpload = useCallback(async (filePaths: string[]) => {
    if (!activeConnectionId) return;
    await uploadAction(activeConnectionId, filePaths);
  }, [activeConnectionId, uploadAction]);

  const { isDraggingOver: isTauriDraggingOver } = useTauriFileDrop(useCallback((paths) => {
    // Clear any leftover HTML5 drag state (HTML5 drop won't fire when Tauri intercepts)
    setIsInternalDraggingOver(false);
    setDragType(null);
    setDragSourceConnectionId(null);
    if (activeConnectionId) {
      performUpload(paths);
    }
  }, [activeConnectionId, performUpload]));

  // --- Copy / Paste Logic ---
  const handleCopy = (cut = false) => {
    if (!activeConnectionId || selectedFiles.length === 0) return;

    // Create list of file entries from selection
    const selectedEntries = files.filter(f => selectedFiles.includes(f.name));

    setClipboard(selectedEntries, activeConnectionId, currentPath, cut ? 'cut' : 'copy');

    showToast('info', `${cut ? 'Cut' : 'Copied'} ${selectedEntries.length} item(s)`);
  };

  const handlePaste = async () => {
    if (!clipboard || !activeConnectionId) return;
    if (clipboard.files.length === 0) return;

    if (clipboard.sourceConnectionId === activeConnectionId) {
      // Same connection: Use fs_copy/fs_rename (via store action)
      const sources = clipboard.files.map(f => f.path);
      await pasteEntries(activeConnectionId, sources, clipboard.op);

    } else {
      // Loop through all the files and start background task
      for (const file of clipboard.files) {
        const destPath = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;

        // Create transfer record in UI
        const transferId = addTransfer({
          sourceConnectionId: clipboard.sourceConnectionId,
          sourcePath: file.path,
          destinationConnectionId: activeConnectionId,
          destinationPath: destPath,
        });

        let command = "sftp:copyToServer"

        const args: any = {
          sourcePath: file.path,
          destinationPath: destPath,
          transferId
        }

        if (clipboard.sourceConnectionId === "local") {
          command = "sftp:put";
          args.id = activeConnectionId;
          args.localPath = file.path;
          args.remotePath = destPath
        } else if (activeConnectionId === "local") {
          command = "sftp:get";
          args.id = clipboard.sourceConnectionId;
          args.remotePath = file.path;
          args.localPath = destPath
        } else {
          args.sourceConnectionId = clipboard.sourceConnectionId;
          args.destinationConnectionId = activeConnectionId;
        }

        // Start actual transfer file via IPC
        window.ipcRenderer.invoke(command, args).catch(err => {
          failTransfer(transferId, err.message);
        });
      }
    }

    if (clipboard.op === 'cut') {
      clearClipboard();
    }
  };

  const handleMoveFiles = async (moves: { source: string; target: string }[]) => {
    if (!activeConnectionId || moves.length === 0) return;

    setIsProcessing(true);
    try {
      // Execute moves sequentially to ensure stability
      let movedCount = 0;
      for (const m of moves) {
        await window.ipcRenderer.invoke('fs_rename', {
          connectionId: activeConnectionId,
          oldPath: m.source,
          newPath: m.target,
        });
        movedCount++;
      }

      showToast('success', `Moved ${movedCount} item(s)`);
      loadFiles(activeConnectionId, currentPath);
      setSelectedFiles([]); // Clear selection after move
    } catch (e: any) {
      showToast('error', `Move failed: ${e.message}`);
      loadFiles(activeConnectionId, currentPath); // Refresh anyway
    } finally {
      setIsProcessing(false);
    }
  };


  const initHomeDirectory = useCallback(async () => {
    if (!activeConnectionId || !isConnected) return;

    // If we already have a path for this connection, just ensure it's loaded
    // If not, fetch home dir
    if (!currentPath) {
      try {
        const path = await window.ipcRenderer.invoke('fs_cwd', {
          connectionId: activeConnectionId,
        });
        loadFiles(activeConnectionId, path);
      } catch (error: any) {
        if (error.message?.includes('Connection not found')) {
          useAppStore.getState().disconnect(activeConnectionId);
          return;
        }
        console.error('Failed to get home dir:', error);
        loadFiles(activeConnectionId, '/');
      }
    } else {
      // Already have a path, maybe refresh?
      if (files.length === 0) {
        loadFiles(activeConnectionId, currentPath);
      }
    }
  }, [activeConnectionId, isConnected, currentPath, files.length, loadFiles]);

  useEffect(() => {
    if (activeConnectionId && isConnected) {
      initHomeDirectory();
    }
  }, [activeConnectionId, isConnected, initHomeDirectory]);



  const handleNavigate = (pathOrName: string) => {
    if (!activeConnectionId) return;

    if (pathOrName === '..') {
      // Use useAppStore navUp or custom logic
      useAppStore.getState().navigateUp(activeConnectionId);
      return;
    }

    const isPath = pathOrName.startsWith('/');

    if (!isPath) {
      const entry = files.find((f) => f.name === pathOrName);
      if (entry && entry.type === '-') {
        handleOpenFile(entry);
        return;
      }
    }

    let newPath = pathOrName;
    if (!isPath) {
      newPath = currentPath === '/' ? `/${pathOrName}` : `${currentPath}/${pathOrName}`;
    }
    loadFiles(activeConnectionId, newPath);
  };

  const handleOpenFile = async (file: FileEntry) => {
    if (!activeConnectionId) return;
    setIsFileLoading(true);
    try {
      const fullPath = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;
      const content = await window.ipcRenderer.invoke('fs_read_file', {
        connectionId: activeConnectionId,
        path: fullPath,
      });
      setEditorContent(content);
      setEditingFile(file);
    } catch (error: any) {
      showToast('error', `Failed to open file: ${error.message}`);
    } finally {
      setIsFileLoading(false);
    }
  };

  const handleSaveFile = async (content: string) => {
    // ... (existing logic) ...
    if (!activeConnectionId || !editingFile) return;
    try {
      const fullPath = currentPath === '/' ? `/${editingFile.name}` : `${currentPath}/${editingFile.name}`;
      await window.ipcRenderer.invoke('fs_write_file', {
        connectionId: activeConnectionId,
        path: fullPath,
        content,
      });
      showToast('success', 'File saved');
    } catch (error: any) {
      showToast('error', `Failed to save file: ${error.message}`);
      throw error;
    }
  };

  const handleSelect = (filename: string, multi: boolean) => {
    if (!filename) {
      setSelectedFiles([]);
      return;
    }

    if (multi) {
      setSelectedFiles((prev) => (prev.includes(filename) ? prev.filter((f) => f !== filename) : [...prev, filename]));
    } else {
      setSelectedFiles([filename]);
      setFocusedFile(filename);
    }
  };

  const handleContextMenu = (e: React.MouseEvent, file?: FileEntry) => {
    e.preventDefault();
    e.stopPropagation(); // Just in case
    setContextMenu({ x: e.clientX, y: e.clientY, file: file || null });

    // Only select if it's a file context menu
    if (file) {
      if (!selectedFiles.includes(file.name)) {
        setSelectedFiles([file.name]);
      }
    } else {
      // Background context menu - maybe clear selection?
      // setSelectedFiles([]); // Optional: clear selection on background right-click
    }
  };

  const filteredFiles = files.filter((f) => {
    if (!settings.fileManager.showHiddenFiles && f.name.startsWith('.')) return false;
    return f.name.toLowerCase().includes(searchTerm.toLowerCase());
  });

  // --- Action Handlers (Create, Rename, Upload, Delete, Download) ---

  const handleCreateFolder = async () => {
    if (!newFolderName.trim() || !activeConnectionId) return;
    await createFolder(activeConnectionId, newFolderName);
    setIsNewFolderModalOpen(false);
    setNewFolderName('');
  };

  const handleRename = async () => {
    if (!renameNewName.trim() || !activeConnectionId) return;

    if (renameNewName !== renameOldName) {
      await renameEntry(activeConnectionId, renameOldName, renameNewName);
    }
    setIsRenameModalOpen(false);
    setRenameNewName('');
  };

  const openRenameModal = (filename: string) => {
    setRenameOldName(filename);
    setRenameNewName(filename);
    setIsRenameModalOpen(true);
  };

  // Move performUpload up to be stable and reusable
  // (Done above)

  const handleUpload = async () => {
    // ... (existing logic) ...
    try {
      const { filePaths, canceled } = await window.ipcRenderer.invoke('dialog:openFile');
      if (canceled || filePaths.length === 0) return;
      performUpload(filePaths);
    } catch (error: any) {
      showToast('error', `Upload failed: ${error.message}`);
    }
  };

  const handleDownload = async () => {
    if (selectedFiles.length === 0 || !activeConnectionId) return;
    try {
      const { filePaths, canceled } = await window.ipcRenderer.invoke('dialog:openDirectory');
      if (canceled || filePaths.length === 0) return;
      const targetDir = filePaths[0];

      // We process download locally in component for now as it involves local FS dialog
      setIsProcessing(true);

      for (const fileName of selectedFiles) {
        const remotePath = currentPath === '/' ? `/${fileName}` : `${currentPath}/${fileName}`;
        const localPath = targetDir.includes('\\') ? `${targetDir}\\${fileName}` : `${targetDir}/${fileName}`;

        // Add transfer to store for progress tracking
        const transferId = addTransfer({
          sourceConnectionId: activeConnectionId,
          sourcePath: remotePath,
          destinationConnectionId: 'local',
          destinationPath: localPath,
        });

        // Fire and forget - tracking happens via events
        window.ipcRenderer.invoke('sftp:get', {
          id: activeConnectionId,
          remotePath,
          localPath,
          transferId,
        }).catch(err => {
          console.error('Download failed', err);
          failTransfer(transferId, err.message);
        });
      }
      setIsProcessing(false);
    } catch (error: any) {
      showToast('error', `Download failed: ${error.message}`);
      setIsProcessing(false);
    }
  };

  const handleDownloadAsZip = async () => {
    if (selectedFiles.length === 0 || !activeConnectionId) return;
    if (isZipping) return; // Prevent double-click opening two dialogs
    if (activeConnectionId === 'local') {
      showToast('error', 'Download as Archive is only available for remote server connections');
      return;
    }

    setIsZipping(true);
    try {
      const date = new Date().toISOString().slice(0, 10);
      const defaultName = `zync_download_${date}.tar.gz`;
      const { filePath, canceled } = await window.ipcRenderer.invoke('dialog:saveFile', {
        defaultPath: defaultName,
        filters: [{ name: 'Tar Archive', extensions: ['tar.gz', 'tgz'] }],
      });
      if (canceled || !filePath) return;

      const remotePaths = selectedFiles.map(name =>
        currentPath === '/' ? `/${name}` : `${currentPath}/${name}`
      );

      const transferId = addTransfer({
        sourceConnectionId: activeConnectionId,
        sourcePath: remotePaths.length === 1 ? remotePaths[0] : `${remotePaths.length} items → ${filePath.split('/').pop() || filePath}`,
        destinationConnectionId: 'local',
        destinationPath: filePath,
        label: 'Compressing',
      });

      // Fire-and-forget: completion/failure reported via transfer-success/transfer-error events
      window.ipcRenderer.invoke('sftp:downloadAsZip', {
        id: activeConnectionId,
        remotePaths,
        localPath: filePath,
        transferId,
      }).catch((err: any) => {
        // Catches invoke-level errors (e.g. command not found) — backend errors come via transfer-error
        failTransfer(transferId, err.message);
      });
    } catch (error: any) {
      showToast('error', `Archive download failed: ${error.message}`);
    } finally {
      setIsZipping(false);
    }
  };

  const handleDelete = () => {
    if (selectedFiles.length === 0 || !activeConnectionId) return;

    if (settings.fileManager.confirmDelete) {
      setIsDeleteModalOpen(true);
    } else {
      executeDelete();
    }
  };

  const executeDelete = async () => {
    if (selectedFiles.length === 0 || !activeConnectionId) return;

    const paths = selectedFiles.map(name => currentPath === '/' ? `/${name}` : `${currentPath}/${name}`);

    setIsDeleting(true);
    try {
      await deleteEntries(activeConnectionId, paths);
      setSelectedFiles([]);
      setIsDeleteModalOpen(false);
    } catch (e: any) {
      showToast('error', `Delete failed: ${e.message}`);
    } finally {
      setIsDeleting(false);
    }
  };

  // Drag and Drop
  const handleDragOver = (e: React.DragEvent) => {
    // Must call preventDefault for ALL drags — this signals WebView to accept the drop,
    // which is required for Tauri to emit tauri://drop for OS file drags.
    e.preventDefault();
    const types = e.dataTransfer.types;

    if (types.includes('application/json')) {
      // In-app server-to-server drag
      setIsInternalDraggingOver(true);
      setDragType('server');
      const dragSource = getCurrentDragSource();
      if (dragSource) {
        setDragSourceConnectionId(dragSource.connectionId);
      }
    }
    // OS file drags: visual handled by isTauriDraggingOver (ring border) via tauri://drag-enter
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsInternalDraggingOver(false);
    setDragType(null);
    setDragSourceConnectionId(null);
  };

  const handleDrop = async (e: React.DragEvent) => {
    // Always prevent default to stop WebView from navigating to dropped file URL
    e.preventDefault();
    setIsInternalDraggingOver(false);
    setDragType(null);
    setDragSourceConnectionId(null);

    // OS file drops are handled by Rust's on_window_event → zync://file-drop
    const jsonData = e.dataTransfer.getData('application/json');
    if (!jsonData) {
      return;
    }

    // Parse as server-to-server file drop
    try {
      const dragData = JSON.parse(jsonData);
      if (dragData.type === 'server-file' && activeConnectionId) {
        // Check for Same Server (Relaxed check)
        if (String(dragData.connectionId) === String(activeConnectionId)) {
          // Same server drop logic
          const destPath = currentPath === '/' ? `/${dragData.name}` : `${currentPath}/${dragData.name}`;

          // If dragging to same folder, ignore
          if (dragData.path === destPath) return;

          // Default to Move for internal drag
          handleMoveFiles([{ source: dragData.path, target: destPath }]);
          return;
        }

        const destPath = currentPath === '/' ? `/${dragData.name}` : `${currentPath}/${dragData.name}`;

        // Add transfer
        const transferId = addTransfer({
          sourceConnectionId: dragData.connectionId,
          sourcePath: dragData.path,
          destinationConnectionId: activeConnectionId,
          destinationPath: destPath,
        });

        // Fire-and-forget: completion/failure reported via transfer events
        // useTransferEvents handles refreshFiles on transfer-success
        window.ipcRenderer.invoke('sftp:copyToServer', {
          sourceConnectionId: dragData.connectionId,
          sourcePath: dragData.path,
          destinationConnectionId: activeConnectionId,
          destinationPath: destPath,
          transferId,
        }).catch(() => {
          // Transfer errors are shown in the TransferPanel
        });
      }
    } catch (_err) {
      // Not valid JSON — ignore
    }
  };

  // Context Menu Items
  const contextMenuItems: ContextMenuItem[] = contextMenu ? [] : [];

  if (contextMenu) {
    if (contextMenu.file) {
      // File Context Menu
      contextMenuItems.push(
        {
          label: 'Download',
          icon: <Download size={14} />,
          action: handleDownload,
        },
        {
          label: 'Download as Archive (.tar.gz)',
          icon: <FileArchive size={14} />,
          action: handleDownloadAsZip,
        },
        {
          label: 'Copy',
          icon: <Copy size={14} />,
          action: () => handleCopy(false),
        },
        {
          label: 'Cut',
          icon: <Scissors size={14} />,
          action: () => handleCopy(true),
        },
        {
          label: 'Copy to Server...',
          icon: <Server size={14} />,
          action: () => {
            if (!contextMenu?.file || !activeConnectionId) return;

            // If the right-clicked file is part of a selection, copy all selected
            const targetFiles = selectedFiles.includes(contextMenu.file.name)
              ? selectedFiles
              : [contextMenu.file.name];

            const toCopy = targetFiles.map(name => ({
              connectionId: activeConnectionId,
              path: currentPath === '/' ? `/${name}` : `${currentPath}/${name}`,
              name: name,
            }));

            setFilesToCopy(toCopy);
            setIsCopyModalOpen(true);
            setContextMenu(null);
          },
        },
        {
          label: 'Rename',
          icon: <FolderInput size={14} />,
          action: () => openRenameModal(contextMenu.file?.name as string),
        },
        {
          label: 'Delete',
          icon: <Trash2 size={14} />,
          variant: 'danger',
          action: handleDelete,
        },
        {
          label: 'Properties',
          icon: <Info size={14} />,
          action: () => {
            // If triggered on a file via right click, it might not be selected/focused yet in some logic, 
            // but handleContextMenu sets selection if not selected.
            // We want to show properties for the file we clicked on.
            if (contextMenu.file) {
              setFocusedFile(contextMenu.file.name);
              setIsPropertiesOpen(true);
            }
            setContextMenu(null);
          }
        },
      );
    } else {
      // Background Context Menu
      contextMenuItems.push({
        label: clipboard ? `Paste ${clipboard.files.length > 1 ? `(${clipboard.files.length})` : ''}` : 'Paste',
        icon: <Clipboard size={14} />,
        action: handlePaste,
        disabled: !clipboard,
      });

      contextMenuItems.push(
        {
          label: 'Upload Files',
          icon: <Upload size={14} />,
          action: handleUpload,
        },
        {
          label: 'New Folder',
          icon: <FolderInput size={14} />,
          action: () => setIsNewFolderModalOpen(true),
        },
        {
          label: 'Refresh',
          icon: <RotateCw size={14} />,
          action: () => activeConnectionId && loadFiles(activeConnectionId, currentPath),
        },
      );
    }
  }



  // Keyboard Navigation Handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't interfere with background tabs, modals, inputs, or when strict focus is needed
      if (!isVisible || isNewFolderModalOpen || isRenameModalOpen || editingFile || isCopyModalOpen || isPropertiesOpen) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        // Special case: Allow arrow keys and Enter to pass through if we are in the search input
        // so that users can navigate results while typing.
        const isSearchInput = e.target.placeholder?.includes('Search');
        const isNavigationKey = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key);
        if (isSearchInput && isNavigationKey) {
          // Continue to global handler
        } else {
          return;
        }
      }

      const filteredFiles = files.filter((f) =>
        f.name.toLowerCase().includes(searchTerm.toLowerCase())
      );

      const bindings = settings.keybindings || {};

      // Select All
      if (isMatch(e, bindings.fmSelectAll || 'Mod+A')) {
        e.preventDefault();
        setSelectedFiles(filteredFiles.map((f) => f.name));
        return;
      }

      // Clear Selection / Search
      if (isMatch(e, 'Escape')) {
        if (isSearchOpen || searchTerm) {
          setIsSearchOpen(false);
          setSearchTerm('');
        } else {
          setSelectedFiles([]);
          setFocusedFile(null);
        }
        return;
      }

      // Search (Mod+F)
      if (isMatch(e, bindings.fmSearch || 'Mod+F')) {
        e.preventDefault();
        setIsSearchOpen(true);
        return;
      }

      // Type-to-search logic: A-Z / 0-9 starts searching
      if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1 && /^[a-zA-Z0-9_\-]$/.test(e.key)) {
        // If not already focused on search, open it and let it handle further input
        if (!isSearchOpen) {
          e.preventDefault(); // Prevent browser from typing the char into the newly focused input
          setIsSearchOpen(true);
          // We can't easily "forward" the key to the input immediately after state change in the same tick 
          // but if we set the searchTerm here, it will appear in the input when it renders.
          setSearchTerm(e.key);
          return;
        }
      }

      // Go Back
      if (isMatch(e, bindings.fmBack || 'Alt+Left')) {
        e.preventDefault();
        if (activeConnectionId) navigateBack(activeConnectionId);
        return;
      }

      // Go Forward
      if (isMatch(e, bindings.fmForward || 'Alt+Right')) {
        e.preventDefault();
        if (activeConnectionId) navigateForward(activeConnectionId);
        return;
      }

      // Go Up
      if (isMatch(e, bindings.fmUp || 'Backspace')) {
        e.preventDefault();
        handleNavigate('..');
        return;
      }

      // Delete
      if (isMatch(e, bindings.fmDelete || 'Delete') && selectedFiles.length > 0) {
        e.preventDefault();
        handleDelete();
        return;
      }

      // Rename
      if (isMatch(e, bindings.fmRename || 'F2') && (focusedFile || selectedFiles.length === 1)) {
        e.preventDefault();
        const fileToRename = focusedFile || selectedFiles[0];
        setRenameOldName(fileToRename);
        setRenameNewName(fileToRename);
        setIsRenameModalOpen(true);
        return;
      }

      // Edit Path
      if (isMatch(e, bindings.fmEditPath || 'Mod+L')) {
        e.preventDefault();
        setIsEditingPath(true);
        return;
      }

      // Properties Panel (Alt+Enter)
      if (isMatch(e, 'Alt+Enter') && (focusedFile || selectedFiles.length > 0)) {
        e.preventDefault();
        setIsPropertiesOpen(prev => !prev);
        return;
      }

      // Open Selection (Enter)
      if (isMatch(e, bindings.fmOpen || 'Enter') && focusedFile) {
        e.preventDefault();
        handleNavigate(focusedFile);
        return;
      }

      // Space: Toggle selection
      if (e.key === ' ' && focusedFile) {
        e.preventDefault();
        setSelectedFiles(prev => {
          const set = new Set(prev);
          if (set.has(focusedFile)) {
            set.delete(focusedFile);
          } else {
            set.add(focusedFile);
          }
          return Array.from(set);
        });
        return;
      }

      // Clipboard Shortcuts
      if (isMatch(e, bindings.fmCopy || 'Mod+C')) {
        e.preventDefault();
        handleCopy(false);
        return;
      }

      if (isMatch(e, bindings.fmCut || 'Mod+X')) {
        e.preventDefault();
        handleCopy(true);
        return;
      }

      if (isMatch(e, bindings.fmPaste || 'Mod+V')) {
        e.preventDefault();
        handlePaste();
        return;
      }

      if (filteredFiles.length === 0) return;

      const currentIndex = focusedFile ? filteredFiles.findIndex((f) => f.name === focusedFile) : -1;

      // Arrow Keys: Navigate
      // Note: These are standard navigation keys, not strictly "commands"
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();

        let newIndex = currentIndex;

        if (viewMode === 'grid') {
          // Dynamic Grid Column Calculation
          // We measure the DOM to find how many items fit in one row
          let gridCols = settings.compactMode ? 12 : 6; // Default fallback

          if (filteredFiles.length > 0) {
            const firstItem = document.getElementById(`file-item-${filteredFiles[0].name}`);
            if (firstItem && firstItem.parentElement) {
              const baseTop = firstItem.offsetTop;
              let count = 0;
              // distinct scan to find row break
              for (let i = 0; i < filteredFiles.length; i++) {
                const el = document.getElementById(`file-item-${filteredFiles[i].name}`);
                if (el && Math.abs(el.offsetTop - baseTop) < 10) {
                  count++;
                } else {
                  break; // Found the break
                }
                // Safety break for huge lists if layout is weird (e.g. all horizontal)
                if (count > 50) break;
              }
              if (count > 0) gridCols = count;
            }
          }

          if (e.key === 'ArrowDown') newIndex = Math.min(currentIndex + gridCols, filteredFiles.length - 1);
          else if (e.key === 'ArrowUp') newIndex = Math.max(currentIndex - gridCols, 0);
          else if (e.key === 'ArrowRight') newIndex = Math.min(currentIndex + 1, filteredFiles.length - 1);
          else if (e.key === 'ArrowLeft') newIndex = Math.max(currentIndex - 1, 0);
        } else {
          // List view: only up/down
          if (e.key === 'ArrowDown') newIndex = Math.min(currentIndex + 1, filteredFiles.length - 1);
          else if (e.key === 'ArrowUp') newIndex = Math.max(currentIndex - 1, 0);
        }

        if (newIndex === -1) newIndex = 0;
        const newFocused = filteredFiles[newIndex]?.name;
        setFocusedFile(newFocused);

        // Update selection if Shift is held
        if (e.shiftKey && newFocused) {
          setSelectedFiles(prev => {
            const set = new Set(prev);
            if (set.has(newFocused)) {
              // Already selected
            } else {
              set.add(newFocused);
            }
            return Array.from(set);
          });
        } else if (!e.ctrlKey && !e.metaKey) {
          // Single selection
          setSelectedFiles([newFocused]);
        }
        return;
      }

      // Home
      if (e.key === 'Home') {
        e.preventDefault();
        if (filteredFiles.length > 0) setFocusedFile(filteredFiles[0].name);
        return;
      }

      // End
      if (e.key === 'End') {
        e.preventDefault();
        if (filteredFiles.length > 0) setFocusedFile(filteredFiles[filteredFiles.length - 1].name);
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    activeConnectionId, searchTerm, isSearchOpen, files, settings, isNewFolderModalOpen, isRenameModalOpen,
    editingFile, selectedFiles, focusedFile, handleNavigate, handleCopy, handlePaste,
    handleDelete, isMatch, navigateBack, navigateForward
  ]);

  // Focus management
  useEffect(() => {
    if (isVisible && containerRef.current) {
      containerRef.current.focus();
    }
  }, [isVisible]);

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      className={`flex-1 flex flex-col h-full bg-app-bg relative outline-none focus-within:ring-0 transition-all duration-150 ${isTauriDraggingOver ? 'ring-2 ring-app-accent ring-inset' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={(e) => {
        // Only focus if clicking the container or its non-input children
        if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
          containerRef.current?.focus();
        }
      }}
    >
      {/* Server-to-server drag overlay (small card, no fullscreen blur) */}
      {isInternalDraggingOver && dragType === 'server' && dragSourceConnectionId !== activeConnectionId && (
        <div className="absolute inset-0 z-50 flex items-center justify-center pointer-events-none">
          <div className="bg-app-panel p-6 rounded-xl border border-app-accent flex flex-col items-center animate-in zoom-in-95 duration-200 shadow-xl">
            <Copy size={36} className="text-app-accent mb-3" />
            <h3 className="text-base font-bold text-white">Drop to Copy Here</h3>
            <p className="text-xs text-app-muted mt-1">Server-to-server transfer</p>
          </div>
        </div>
      )}

      <FileToolbar
        currentPath={currentPath}
        onNavigate={(path) => loadFiles(activeConnectionId!, path)}
        onRefresh={() => refreshFiles(activeConnectionId!)}
        onUpload={handleUpload}
        onUploadFolder={async () => {
          if (!activeConnectionId || !isConnected) return;
          try {
            const { filePaths, canceled } = await window.ipcRenderer.invoke('dialog:openDirectory');
            if (canceled || filePaths.length === 0) return;
            performUpload(filePaths);
          } catch (err) {
            console.error('Failed to open directory dialog:', err);
          }
        }}
        onNewFolder={() => setIsNewFolderModalOpen(true)}
        onDownloadAsZip={activeConnectionId !== 'local' ? handleDownloadAsZip : undefined}
        selectedCount={selectedFiles.length}
        viewMode={viewMode}
        onToggleView={setViewMode}
        searchTerm={searchTerm}
        onSearch={setSearchTerm}
        isSearchOpen={isSearchOpen}
        onToggleSearch={setIsSearchOpen}
        isEditingPath={isEditingPath}
        onTogglePathEdit={setIsEditingPath}
        isSmallScreen={isSmallScreen}
        onToggleSidebar={() => updateSettings({ sidebarCollapsed: !settings.sidebarCollapsed })}
      />

      {/* biome-ignore lint/a11y/noStaticElementInteractions: interactive div */}
      <div className="flex-1 overflow-hidden relative flex flex-col" onClick={() => setContextMenu(null)}>
        <FileGrid
          files={filteredFiles}
          selectedFiles={selectedFiles}
          focusedFile={focusedFile || undefined}
          onSelect={handleSelect}
          onNavigate={handleNavigate}
          onContextMenu={handleContextMenu}
          viewMode={viewMode}
          isLoading={isLoading}
          connectionId={activeConnectionId || undefined}
          currentPath={currentPath}
          onMove={handleMoveFiles}
        />
      </div>

      {isSmallScreen && (
        <FileBottomToolbar
          onBack={() => activeConnectionId && navigateBack(activeConnectionId)}
          onForward={() => activeConnectionId && navigateForward(activeConnectionId)}
          viewMode={viewMode}
          onToggleView={setViewMode}
          // Simple history check
          canGoBack={activeConnectionId ? (useAppStore.getState().historyIndex[activeConnectionId] || 0) > 0 : false}
          canGoForward={activeConnectionId ? (useAppStore.getState().historyIndex[activeConnectionId] || 0) < (useAppStore.getState().history[activeConnectionId]?.length || 0) - 1 : false}
        />
      )}

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Modals */}
      <Modal isOpen={isNewFolderModalOpen} onClose={() => setIsNewFolderModalOpen(false)} title="New Folder">
        <div className="space-y-4">
          <Input
            label="Folder Name"
            placeholder="my-folder"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && handleCreateFolder()}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setIsNewFolderModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateFolder}>Create</Button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={isRenameModalOpen} onClose={() => setIsRenameModalOpen(false)} title="Rename">
        <div className="space-y-4">
          <Input
            label="New Name"
            value={renameNewName}
            onChange={(e) => setRenameNewName(e.target.value)}
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && handleRename()}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setIsRenameModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleRename}>Rename</Button>
          </div>
        </div>
      </Modal>

      {/* Copy to Server Modal */}
      <CopyToServerModal
        isOpen={isCopyModalOpen}
        onClose={() => {
          setIsCopyModalOpen(false);
          setFilesToCopy([]);
          setInitialDestConnectionId(undefined);
          setInitialDestPath(undefined);
        }}
        sourceFiles={filesToCopy}
        destinationConnectionId={initialDestConnectionId}
        destinationPath={initialDestPath}
      />

      {/* File Editor Overlay */}
      {editingFile && (
        <FileEditor
          filename={editingFile.name}
          initialContent={editorContent}
          onSave={handleSaveFile}
          onClose={() => setEditingFile(null)}
        />
      )}

      {isFileLoading && (
        <div className="absolute inset-0 z-[60] bg-black/20 flex items-center justify-center backdrop-blur-[1px]">
          <div className="bg-app-panel p-4 rounded-lg border border-app-border flex items-center gap-3 shadow-xl">
            <RotateCw size={18} className="animate-spin text-app-accent" />
            <span className="text-sm">Reading file...</span>
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={isDeleteModalOpen}
        onClose={() => setIsDeleteModalOpen(false)}
        onConfirm={executeDelete}
        title="Delete Confirmation"
        message={`Are you sure you want to delete ${selectedFiles.length} item(s)? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        isLoading={isDeleting}
      />

      <PropertiesPanel
        isOpen={isPropertiesOpen}
        onClose={() => setIsPropertiesOpen(false)}
        file={files.find(f => f.name === (focusedFile || selectedFiles[0])) || null}
      />
    </div>
  );
}
