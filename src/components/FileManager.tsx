import {
  Clipboard,
  Copy,
  Download,
  FileArchive,
  FilePlus,
  FolderInput,
  Plus,
  RotateCw,
  Scissors,
  Server,
  Trash2,
  Upload,
  Unplug,
  Terminal,
  Zap,
  Settings as SettingsIcon,
} from 'lucide-react';
import { ConfirmModal } from './ui/ConfirmModal';
import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { useAppStore, Connection } from '../store/useAppStore';
import { isMatch } from '../lib/keyboard';
import { FileEditor } from './FileEditor';
import { CopyToServerModal } from './file-manager/CopyToServerModal';
import { FileGrid } from './file-manager/FileGrid';
import { getCurrentDragSource } from '../lib/dragDrop';
import { FileToolbar } from './file-manager/FileToolbar';
import type { FileEntry } from './file-manager/types';
import { PropertiesPanel } from './file-manager/PropertiesPanel';
import { ConflictModal, type ConflictAction } from './file-manager/ConflictModal';
import { Info } from 'lucide-react'; // Add Info icon import
import { Button } from './ui/Button';
import { ContextMenu, type ContextMenuItem } from './ui/ContextMenu';
import { Input } from './ui/Input';
import { Modal } from './ui/Modal';
import { useTauriFileDrop } from '../hooks/useTauriFileDrop';
import { FileBottomToolbar } from './file-manager/FileBottomToolbar';
import { usePlugins } from '../context/PluginContext';
import { buildEditorProviderOptions, CODEMIRROR_EDITOR_ID } from './editor/providers';
import { clearEditorOverlayOpen, markEditorOverlayOpen } from './editor/overlayState';

export interface Conflict {
  source: string;
  target: string;
  name: string;
  op: 'move' | 'copy';
  sourceConnectionId: string;
}

export function FileManager({ connectionId, isVisible }: { connectionId?: string; isVisible?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const globalActiveId = useAppStore(state => state.activeConnectionId);
  const activeTabId = useAppStore(state => state.activeTabId);
  const connections = useAppStore(state => state.connections);
  const activeConnectionId = connectionId || globalActiveId;
  const syncedTerminalId = useAppStore(state => state.syncedTerminalId[activeConnectionId || 'local']);
  const addTransfer = useAppStore(state => state.addTransfer);
  const failTransfer = useAppStore(state => state.failTransfer);

  // Find the actual connection object to check status
  const isLocal = activeConnectionId === 'local';
  const connection = !isLocal ? connections.find((c: Connection) => c.id === activeConnectionId) : null;
  // Local is always "connected" for file operations
  const isConnected = isLocal || connection?.status === 'connected';

  const settings = useAppStore(state => state.settings);
  const { editorProviders } = usePlugins();
  const showToast = useAppStore((state) => state.showToast);

  // Zustand Store Hooks
  const filesMap = useAppStore(state => state.files);
  const currentPathMap = useAppStore(state => state.currentPath);
  const loadingMap = useAppStore(state => state.isLoading);
  const errorMap = useAppStore(state => state.error);
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
  const currentError = activeConnectionId ? (errorMap[activeConnectionId] || null) : null;

  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [focusedFile, setFocusedFile] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isEditingPath, setIsEditingPath] = useState(false);

  // Editor State
  const [editingFile, setEditingFile] = useState<FileEntry | null>(null);
  const [editorContent, setEditorContent] = useState('');
  const [editorProviderOverride, setEditorProviderOverride] = useState<string | null>(null);

  // Modal States
  const [isNewFolderModalOpen, setIsNewFolderModalOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [isNewFileModalOpen, setIsNewFileModalOpen] = useState(false);
  const [newFileName, setNewFileName] = useState('');
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

  // Conflict Resolution State
  const [pendingConflicts, setPendingConflicts] = useState<Conflict[]>([]);
  const [currentConflict, setCurrentConflict] = useState<Conflict | null>(null);

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
  const editorProviderOptions = useMemo(() => buildEditorProviderOptions(editorProviders), [editorProviders]);

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Sync terminal to FM navigation if a synced terminal is active
  useEffect(() => {
    if (syncedTerminalId && currentPath && isVisible) {
      console.log('[FM] Syncing terminal to:', currentPath);
      // Use the safe navigation IPC instead of manual string injection
      window.ipcRenderer.invoke('terminal:navigate', { termId: syncedTerminalId, path: currentPath });
      // Update store tracking
      useAppStore.getState().setTerminalCwd(activeConnectionId || 'local', syncedTerminalId, currentPath);
    }
  }, [currentPath, syncedTerminalId, activeConnectionId, isVisible]);

  // Combine store loading and local processing
  const isLoading = loading || isProcessing;

  const performUpload = useCallback(async (filePaths: string[]) => {
    if (!activeConnectionId) return;
    await uploadAction(activeConnectionId, filePaths);
  }, [activeConnectionId, uploadAction]);

  const handleConnectionError = useCallback((connectionId: string, err: any) => {
    const msg = err.message || String(err);
    if (msg.includes('DISCONNECTED:')) {
      useAppStore.setState(state => ({
        error: { ...state.error, [connectionId]: 'DISCONNECTED' }
      }));
      // Close any open modals to show the overlay clearly
      setIsEditingPath(false);
      setIsRenameModalOpen(false);
      setEditingFile(null);
      setIsCopyModalOpen(false);
      setIsPropertiesOpen(false);
      setIsDeleteModalOpen(false);
      setIsNewFolderModalOpen(false);
      setIsNewFileModalOpen(false);
      return true;
    }
    return false;
  }, []);

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

  const executeFileOperations = async (ops: {
    source: string;
    target: string;
    name: string;
    op: 'move' | 'copy';
    sourceConnectionId: string
  }[], targetDirectory?: string) => {
    if (!activeConnectionId || ops.length === 0) return;

    setIsProcessing(true);
    const conflicts: typeof pendingConflicts = [];
    const executionList: typeof ops = [];

    try {
      // Pass 1: Check for existence (Parallelized)
      const existenceResults = await Promise.all(ops.map(op =>
        window.ipcRenderer.invoke('fs_exists', {
          connectionId: activeConnectionId,
          path: op.target,
        })
      ));

      existenceResults.forEach((exists, i) => {
        if (exists) {
          conflicts.push(ops[i]);
        } else {
          executionList.push(ops[i]);
        }
      });

      // Pass 2: Execute immediate actions
      if (executionList.length > 0) {
        const sameConnection = executionList.every(item => item.sourceConnectionId === activeConnectionId);

        if (sameConnection) {
          // Group by operation type (move/copy) to ensure correct store action
          const groups = executionList.reduce((acc, item) => {
            if (!acc[item.op]) acc[item.op] = [];
            acc[item.op].push(item.source);
            return acc;
          }, {} as Record<string, string[]>);

          for (const [opType, sources] of Object.entries(groups)) {
            await pasteEntries(activeConnectionId, sources, opType === 'move' ? 'cut' : 'copy', targetDirectory);
          }
        } else {
          // Cross connection: Loop through and start transfers
          for (const item of executionList) {
            const transferId = addTransfer({
              sourceConnectionId: item.sourceConnectionId,
              sourcePath: item.source,
              destinationConnectionId: activeConnectionId,
              destinationPath: item.target,
            });

            let command = "sftp:copyToServer";
            const args: any = { sourcePath: item.source, destinationPath: item.target, transferId };

            if (item.sourceConnectionId === "local") {
              command = "sftp:put";
              args.id = activeConnectionId;
              args.localPath = item.source;
              args.remotePath = item.target;
            } else if (activeConnectionId === "local") {
              command = "sftp:get";
              args.id = item.sourceConnectionId;
              args.remotePath = item.source;
              args.localPath = item.target;
            } else {
              args.sourceConnectionId = item.sourceConnectionId;
              args.destinationConnectionId = activeConnectionId;
            }

            window.ipcRenderer.invoke(command, args).catch(err => {
              failTransfer(transferId, err.message || String(err));
            });
          }
          showToast('info', `Started background transfer of ${executionList.length} item(s)`);
        }
      }

      // Pass 3: Handle Conflicts
      if (conflicts.length > 0) {
        setPendingConflicts(conflicts);
        setCurrentConflict(conflicts[0]);
      } else {
        // Only clear clipboard if it was a successful 'cut' (move)
        const isCut = ops.some(o => o.op === 'move' && clipboard?.op === 'cut');
        if (isCut) clearClipboard();
        setSelectedFiles([]);
      }

      if (executionList.length > 0) {
        loadFiles(activeConnectionId, currentPath);
      }

    } catch (e: any) {
      if (handleConnectionError(activeConnectionId, e)) return;
      showToast('error', `Operation failed: ${e.message || String(e)}`);
      loadFiles(activeConnectionId, currentPath);
    } finally {
      setIsProcessing(false);
    }
  };

  const handlePaste = async () => {
    if (!clipboard || !activeConnectionId) return;
    if (clipboard.files.length === 0) return;

    const ops = clipboard.files.map(file => ({
      source: file.path,
      target: currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`,
      name: file.name,
      op: (clipboard.op === 'cut' ? 'move' : 'copy') as 'move' | 'copy',
      sourceConnectionId: clipboard.sourceConnectionId
    }));

    await executeFileOperations(ops);
  };

  const handleMoveFiles = async (moves: { source: string; target: string; sourceConnectionId?: string }[]) => {
    if (!activeConnectionId || moves.length === 0) return;

    const ops = moves.map(m => ({
      ...m,
      name: m.target.split('/').pop() || 'unknown',
      op: 'move' as const,
      sourceConnectionId: m.sourceConnectionId || activeConnectionId
    }));

    // Extract target directory from the first move (they should all be to the same place)
    const firstTarget = moves[0]?.target;
    const targetDir = firstTarget ? firstTarget.substring(0, firstTarget.lastIndexOf('/')) || '/' : undefined;

    await executeFileOperations(ops, targetDir);
  };

  const resolveConflict = async (action: ConflictAction, applyToAll = false) => {
    if (!currentConflict || !activeConnectionId || isProcessing) return;

    setIsProcessing(true);
    const toProcess = applyToAll ? [...pendingConflicts] : [currentConflict];
    let successCount = 0;

    try {
      for (const conflict of toProcess) {
        const { source, target, op, sourceConnectionId } = conflict;

        if (action === 'skip') {
          // Just skip
        } else {
          // For Overwrite and Rename

          // Generate unique target if renaming (unified logic)
          let finalTarget = target;
          if (action === 'rename') {
            let counter = 1;
            const pathParts = target.match(/^(.*?)(\.[^.]*)?$/);
            const base = pathParts ? pathParts[1] : target;
            const ext = pathParts && pathParts[2] ? pathParts[2] : '';

            let exists = true;
            while (exists) {
              const candidate = `${base} (${counter})${ext}`;
              exists = await window.ipcRenderer.invoke('fs_exists', {
                connectionId: activeConnectionId,
                path: candidate,
              });
              if (!exists) {
                finalTarget = candidate;
                break;
              }
              counter++;
              if (counter > 100) {
                showToast('error', `Could not find a unique name for "${conflict.name}" after 100 attempts. Skipping.`);
                finalTarget = ''; // Flag as failed
                break;
              }
            }
          }

          if (!finalTarget) {
            // Renaming failed or was skipped
            continue;
          }

          if (action === 'overwrite') {
            // Safe Overwrite: Rename existing to backup first
            const backupPath = `${target}.bak-${Date.now()}`;
            try {
              await window.ipcRenderer.invoke('fs_rename', {
                connectionId: activeConnectionId,
                oldPath: target,
                newPath: backupPath,
                autoRename: false
              });

              // Now perform the move/copy
              let opSuccess = false;
              try {
                if (sourceConnectionId === activeConnectionId) {
                  if (op === 'move') {
                    await window.ipcRenderer.invoke('fs_rename', {
                      connectionId: activeConnectionId,
                      oldPath: source,
                      newPath: finalTarget,
                      autoRename: false
                    });
                  } else {
                    await window.ipcRenderer.invoke('fs_copy_batch', {
                      connectionId: activeConnectionId,
                      operations: [{ from: source, to: finalTarget }]
                    });
                  }
                } else {
                  // Cross connection
                  const transferId = addTransfer({
                    sourceConnectionId,
                    sourcePath: source,
                    destinationConnectionId: activeConnectionId,
                    destinationPath: finalTarget,
                  });

                  const args: any = { sourcePath: source, destinationPath: finalTarget, transferId };
                  let command = "sftp:copyToServer";

                  if (sourceConnectionId === "local") {
                    command = "sftp:put";
                    args.id = activeConnectionId;
                    args.localPath = source;
                    args.remotePath = finalTarget;
                  } else if (activeConnectionId === "local") {
                    command = "sftp:get";
                    args.id = sourceConnectionId;
                    args.remotePath = source;
                    args.localPath = finalTarget;
                  } else {
                    args.sourceConnectionId = sourceConnectionId;
                    args.destinationConnectionId = activeConnectionId;
                  }

                  await window.ipcRenderer.invoke(command, args);
                }
                opSuccess = true;
              } finally {
                if (opSuccess) {
                  // Success: Delete the backup
                  await window.ipcRenderer.invoke('fs_delete', {
                    connectionId: activeConnectionId,
                    path: backupPath,
                  }).catch(() => { }); // If delete fails, it's just a stray file
                } else {
                  // Failure: Restore the backup
                  await window.ipcRenderer.invoke('fs_rename', {
                    connectionId: activeConnectionId,
                    oldPath: backupPath,
                    newPath: target,
                    autoRename: false
                  }).catch(() => { });
                }
              }
              successCount++;
              continue; // Handled specially
            } catch (err) {
              showToast('error', `Failed to prepare overwrite for "${conflict.name}"`);
              continue;
            }
          }

          if (sourceConnectionId === activeConnectionId) {
            // Same connection
            if (op === 'move') {
              await window.ipcRenderer.invoke('fs_rename', {
                connectionId: activeConnectionId,
                oldPath: source,
                newPath: finalTarget,
                autoRename: false, // We already handled it explicitly
              });
            } else {
              // Same-connection copy: use fs_copy_batch with single operation for consistency
              await window.ipcRenderer.invoke('fs_copy_batch', {
                connectionId: activeConnectionId,
                operations: [{ from: source, to: finalTarget }]
              });
            }
          } else if (sourceConnectionId) {
            // Cross connection
            const transferId = addTransfer({
              sourceConnectionId,
              sourcePath: source,
              destinationConnectionId: activeConnectionId,
              destinationPath: finalTarget,
            });

            const args: any = { sourcePath: source, destinationPath: finalTarget, transferId };
            let command = "sftp:copyToServer";

            if (sourceConnectionId === "local") {
              command = "sftp:put";
              args.id = activeConnectionId;
              args.localPath = source;
              args.remotePath = finalTarget;
            } else if (activeConnectionId === "local") {
              command = "sftp:get";
              args.id = sourceConnectionId;
              args.remotePath = source;
              args.localPath = finalTarget;
            } else {
              args.sourceConnectionId = sourceConnectionId;
              args.destinationConnectionId = activeConnectionId;
            }

            try {
              await window.ipcRenderer.invoke(command, args);
            } catch (err: any) {
              failTransfer(transferId, err.message || String(err));
              continue; // Don't increment successCount if it failed to start
            }
          }
        }
        successCount++;
      }

      const displayAction = action === 'overwrite' ? 'Overwritten' : (action === 'rename' ? 'Renamed' : 'Skipped');
      showToast('success', `${displayAction} ${successCount} item(s)`);

      // Refresh and move to next conflict or close
      loadFiles(activeConnectionId, currentPath);

      if (applyToAll) {
        setPendingConflicts([]);
        setCurrentConflict(null);
        setSelectedFiles([]);
        if (clipboard && clipboard.op === 'cut') clearClipboard();
      } else {
        const remaining = pendingConflicts.slice(1);
        setPendingConflicts(remaining);
        if (remaining.length > 0) {
          setCurrentConflict(remaining[0]);
        } else {
          setCurrentConflict(null);
          setSelectedFiles([]);
          if (clipboard && clipboard.op === 'cut') clearClipboard();
        }
      }

    } catch (e: any) {
      showToast('error', `Failed to resolve conflict: ${e.message || String(e)}`);
      setCurrentConflict(null);
      setPendingConflicts([]);
    } finally {
      setIsProcessing(false);
    }
  };


  const ensureTerminal = useAppStore(state => state.ensureTerminal);

  const initHomeDirectory = useCallback(async () => {
    if (!activeConnectionId || !isConnected) return;

    if (!currentPath) {
      try {
        const path = await window.ipcRenderer.invoke('fs_cwd', {
          connectionId: activeConnectionId,
        });
        loadFiles(activeConnectionId, path);

        // Ensure a terminal exists for this connection and seed it with the home path.
        // If TerminalManager already created one without a path, ensureTerminal is a no-op
        // (terminal already exists). If none exists yet, it creates one with the path baked in.
        // Either way, we then tag any still-untracked terminals (covers the race case).
        // Either way, we then tag any still-untracked terminals (covers the race case).
        const termId = ensureTerminal(activeConnectionId, path);
        const store = useAppStore.getState();
        const t = store.terminals[activeConnectionId]?.find(tab => tab.id === termId);
        if (t && !t.initialPath && !t.lastKnownCwd && !t.isSynced) {
          store.setTerminalInitialPath(activeConnectionId, t.id, path);
          store.setTerminalCwd(activeConnectionId, t.id, path);
        }
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
  }, [activeConnectionId, isConnected, currentPath, files.length, loadFiles, ensureTerminal]);

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

  const handleOpenFile = useCallback(async (file: FileEntry, providerOverride?: string) => {
    if (!activeConnectionId) return;
    setIsFileLoading(true);
    try {
      const fullPath = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;
      const content = await window.ipcRenderer.invoke('fs_read_file', {
        connectionId: activeConnectionId,
        path: fullPath,
      });
      setEditorProviderOverride(providerOverride ?? null);
      setEditorContent(content);
      setEditingFile(file);
    } catch (error: any) {
      if (handleConnectionError(activeConnectionId, error)) return;
      showToast('error', `Failed to open file: ${error.message || String(error)}`);
    } finally {
      setIsFileLoading(false);
    }
  }, [activeConnectionId, currentPath, handleConnectionError, showToast]);

  const handleOpenFileWithProvider = useCallback(async (file: FileEntry, providerId: string) => {
    await handleOpenFile(file, providerId);
    const providerLabel = editorProviderOptions.find((option) => option.value === providerId)?.label ?? providerId;
    showToast('info', `Opening ${file.name} with ${providerLabel}`);
  }, [editorProviderOptions, handleOpenFile, showToast]);

  const handleSetDefaultEditorProvider = useCallback(async (providerId: string) => {
    const currentProvider = settings.editor?.defaultProvider ?? CODEMIRROR_EDITOR_ID;
    if (providerId === currentProvider) return;

    await updateSettings({
      editor: {
        ...(settings.editor || {}),
        defaultProvider: providerId,
      },
    });

    const providerLabel = editorProviderOptions.find((option) => option.value === providerId)?.label ?? providerId;
    showToast('success', `Default editor set to ${providerLabel}`);
  }, [editorProviderOptions, settings.editor, showToast, updateSettings]);

  const handleSaveFile = useCallback(async (content: string) => {
    if (!activeConnectionId || !editingFile) return;
    try {
      const fullPath = currentPath === '/' ? `/${editingFile.name}` : `${currentPath}/${editingFile.name}`;
      await window.ipcRenderer.invoke('fs_write_file', {
        connectionId: activeConnectionId,
        path: fullPath,
        content,
      });
      setEditorContent(content);
      showToast('success', 'File saved');
    } catch (error: any) {
      if (handleConnectionError(activeConnectionId, error)) return;
      showToast('error', `Failed to save file: ${error.message || String(error)}`);
      throw error;
    }
  }, [activeConnectionId, editingFile, currentPath, handleConnectionError, showToast]);

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
    const trimmedName = newFolderName.trim();
    if (!trimmedName || !activeConnectionId) return;
    if (trimmedName.includes('/') || trimmedName.includes('\\') || trimmedName === '.' || trimmedName === '..') {
      showToast('error', 'Invalid folder name: Contains invalid characters');
      return;
    }
    // Check for local collision
    if (files.some(f => f.name === trimmedName)) {
      showToast('error', `A file or folder named "${trimmedName}" already exists.`);
      return;
    }
    await createFolder(activeConnectionId, trimmedName);
    setIsNewFolderModalOpen(false);
    setNewFolderName('');
  };

  const handleCreateFile = async () => {
    const trimmedName = newFileName.trim();
    if (!trimmedName || !activeConnectionId) return;
    if (trimmedName.includes('/') || trimmedName.includes('\\') || trimmedName === '.' || trimmedName === '..') {
      showToast('error', 'Invalid file name: Contains invalid characters');
      return;
    }
    // Check for local collision
    if (files.some(f => f.name === trimmedName)) {
      showToast('error', `A file or folder named "${trimmedName}" already exists.`);
      return;
    }
    try {
      const fullPath = currentPath === '/' ? `/${trimmedName}` : `${currentPath}/${trimmedName}`;
      await window.ipcRenderer.invoke('fs_touch', { connectionId: activeConnectionId, path: fullPath });
      refreshFiles(activeConnectionId);
      setIsNewFileModalOpen(false);
      setNewFileName('');
    } catch (error: any) {
      if (handleConnectionError(activeConnectionId, error)) return;
      showToast('error', `Failed to create file: ${error.message || String(error)}`);
    }
  };


  const handleRename = async () => {
    const trimmedName = renameNewName.trim();
    if (!trimmedName || !activeConnectionId) return;
    if (trimmedName.includes('/') || trimmedName.includes('\\') || trimmedName === '.' || trimmedName === '..') {
      showToast('error', 'Invalid name: Contains invalid characters');
      return;
    }

    if (trimmedName !== renameOldName) {
      // Check for local collision (exclude the current file being renamed to allow case-only changes)
      if (files.some(f => f.name !== renameOldName && f.name === trimmedName)) {
        showToast('error', `A file or folder named "${trimmedName}" already exists.`);
        return;
      }
      await renameEntry(activeConnectionId, renameOldName, trimmedName);
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
      showToast('error', `Upload failed: ${error.message || String(error)}`);
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
          failTransfer(transferId, err.message || String(err));
        });
      }
      setIsProcessing(false);
    } catch (error: any) {
      setIsProcessing(false);
      if (handleConnectionError(activeConnectionId, error)) return;
      showToast('error', `Download failed: ${error.message || String(error)}`);
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
        failTransfer(transferId, err.message || String(err));
      });
    } catch (error: any) {
      if (handleConnectionError(activeConnectionId, error)) return;
      showToast('error', `Archive download failed: ${error.message || String(error)}`);
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
      if (handleConnectionError(activeConnectionId, e)) return;
      showToast('error', `Delete failed: ${e.message || String(e)}`);
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


    const jsonData = e.dataTransfer.getData('application/json');

    // Friendly message for external file drops
    const types = Array.from(e.dataTransfer.types);
    if (!jsonData && (types.includes('Files') || types.includes('text/uri-list'))) {
      showToast('info', 'External file drop is currently disabled to ensure stability. We are working to bring this feature to Zync soon!');
      return;
    }

    if (!jsonData) {
      return;
    }

    // Parse as server-to-server file drop
    try {
      const dragData = JSON.parse(jsonData);
      if (dragData.type === 'server-file' && activeConnectionId) {

        // Prepare list of operations
        const ops: {
          source: string;
          target: string;
          name: string;
          op: 'move' | 'copy';
          sourceConnectionId: string
        }[] = [];

        if (dragData.paths && Array.isArray(dragData.paths)) {
          // Multi-file drag
          dragData.paths.forEach((sourcePath: string, index: number) => {
            const name = dragData.names?.[index] || sourcePath.split(/[/\\]/).pop() || 'unknown';
            const destPath = currentPath === '/' ? `/${name}` : `${currentPath}/${name}`;

            // Avoid moving to same folder
            if (sourcePath !== destPath) {
              ops.push({
                source: sourcePath,
                target: destPath,
                name: name,
                op: 'move', // Default DND to move
                sourceConnectionId: dragData.connectionId
              });
            }
          });
        } else {
          // Single file drag
          const destPath = currentPath === '/' ? `/${dragData.name}` : `${currentPath}/${dragData.name}`;
          if (dragData.path !== destPath) {
            ops.push({
              source: dragData.path,
              target: destPath,
              name: dragData.name,
              op: 'move',
              sourceConnectionId: dragData.connectionId
            });
          }
        }

        if (ops.length > 0) {
          await executeFileOperations(ops);
        }
        return;
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
        ...(contextMenu.file.type === '-' ? [{
          label: 'Open With…',
          icon: <FilePlus size={14} />,
          children: editorProviderOptions.map((option) => ({
            label: `${option.value === (settings.editor?.defaultProvider ?? 'com.zync.editor.codemirror') ? '✓ ' : ''}${option.label}`,
            action: () => {
              if (!contextMenu?.file) return;
              void handleOpenFileWithProvider(contextMenu.file, option.value);
            },
          })),
        } as ContextMenuItem, {
          label: 'Set Default Editor',
          icon: <SettingsIcon size={14} />,
          children: editorProviderOptions.map((option) => ({
            label: `${option.value === (settings.editor?.defaultProvider ?? 'com.zync.editor.codemirror') ? '✓ ' : ''}${option.label}`,
            action: () => { void handleSetDefaultEditorProvider(option.value); },
          })),
        } as ContextMenuItem] : []),
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
          label: 'Open Terminal Here',
          icon: <Terminal size={14} />,
          action: () => {
            if (!contextMenu?.file || !activeConnectionId) return;
            const item = contextMenu.file;
            const targetPath = item.type === 'd'
              ? (currentPath === '/' ? `/${item.name}` : `${currentPath}/${item.name}`)
              : currentPath;

            const connId = activeConnectionId || 'local';
            const terminals = useAppStore.getState().terminals[connId] || [];

            // Case 1: A terminal is already at this exact path — just switch focus. Zero IPC.
            const match = terminals.find(t => (t.lastKnownCwd === targetPath || t.initialPath === targetPath) && !t.isSynced);
            if (match) {
              useAppStore.getState().setActiveTerminal(connId, match.id);
            } else {
              // Case 2: No match — spawn a new terminal that starts natively at the target path.
              // The shell opens there directly; no 'cd' command is ever typed.
              const termId = useAppStore.getState().createTerminal(activeConnectionId, targetPath);
              useAppStore.getState().setActiveTerminal(activeConnectionId, termId);
              useAppStore.getState().setTerminalCwd(connId, termId, targetPath);
            }

            if (activeTabId) {
              useAppStore.getState().setTabView(activeTabId, 'terminal');
            }
            setContextMenu(null);
          }
        },
        {
          label: 'Open Synced Terminal Here',
          icon: <Zap size={14} className="text-yellow-500" />,
          action: () => {
            if (!contextMenu?.file || !activeConnectionId) return;
            const item = contextMenu.file;
            const targetPath = item.type === 'd'
              ? (currentPath === '/' ? `/${item.name}` : `${currentPath}/${item.name}`)
              : currentPath;

            const terminals = useAppStore.getState().terminals[activeConnectionId || 'local'] || [];
            const existingSynced = terminals.find(t => t.isSynced);

            const handleSyncedTerminal = async () => {
              let termId: string;
              if (existingSynced) {
                termId = existingSynced.id;
                // CodeRabbit: Await reused synced terminal IPC before updating store to prevent desync on failure
                try {
                  await window.ipcRenderer.invoke('terminal:navigate', { termId, path: targetPath });
                  useAppStore.getState().setTerminalCwd(activeConnectionId || 'local', termId, targetPath);
                } catch (err: any) {
                  showToast('error', `Failed to navigate synced terminal: ${err.message || String(err)}`);
                  return; // Halt on failure
                }
              } else {
                termId = useAppStore.getState().createTerminal(activeConnectionId, targetPath, true);
                useAppStore.getState().setTerminalCwd(activeConnectionId || 'local', termId, targetPath);
              }

              if (activeTabId) {
                useAppStore.getState().setTabView(activeTabId, 'terminal');
              }
              useAppStore.getState().setActiveTerminal(activeConnectionId, termId);
              setContextMenu(null);
            };
            handleSyncedTerminal();
          }
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
          label: 'Open Terminal Here',
          icon: <Terminal size={14} />,
          action: () => {
            if (!activeConnectionId) return;
            const targetPath = currentPath;
            const connId = activeConnectionId || 'local';
            const terminals = useAppStore.getState().terminals[connId] || [];

            // Case 1: A terminal is already at this exact path — switch focus only. Zero IPC.
            const match = terminals.find(t => (t.lastKnownCwd === targetPath || t.initialPath === targetPath) && !t.isSynced);
            if (match) {
              useAppStore.getState().setActiveTerminal(connId, match.id);
            } else {
              // Case 2: No match — spawn a new terminal that starts natively at the target path.
              // The shell opens there directly; no 'cd' command is ever typed.
              const termId = useAppStore.getState().createTerminal(activeConnectionId, targetPath);
              useAppStore.getState().setActiveTerminal(activeConnectionId, termId);
              useAppStore.getState().setTerminalCwd(connId, termId, targetPath);
            }

            if (activeTabId) {
              useAppStore.getState().setTabView(activeTabId, 'terminal');
            }
            setContextMenu(null);
          }
        },
        {
          label: 'Open Synced Terminal Here',
          icon: <Zap size={14} className="text-yellow-500" />,
          action: () => {
            if (!activeConnectionId) return;
            const connId = activeConnectionId || 'local';
            const terminals = useAppStore.getState().terminals[connId] || [];
            const existingSynced = terminals.find(t => t.isSynced);

            const handleSyncedTerminal = async () => {
              let termId: string;
              if (existingSynced) {
                termId = existingSynced.id;
                // Navigate existing synced terminal to current path safely
                try {
                  await window.ipcRenderer.invoke('terminal:navigate', { termId, path: currentPath });
                  useAppStore.getState().setTerminalCwd(connId, termId, currentPath);
                } catch (err: any) {
                  showToast('error', `Failed to navigate synced terminal: ${err.message || String(err)}`);
                  return; // Halt on failure
                }
              } else {
                termId = useAppStore.getState().createTerminal(activeConnectionId, currentPath, true);
                useAppStore.getState().setTerminalCwd(connId, termId, currentPath);
              }

              if (activeTabId) {
                useAppStore.getState().setTabView(activeTabId, 'terminal');
              }
              useAppStore.getState().setActiveTerminal(activeConnectionId, termId);
              setContextMenu(null);
            };
            handleSyncedTerminal();
          }
        },
        {
          label: 'New...',
          icon: <Plus size={14} />,
          children: [
            {
              label: 'New File',
              icon: <FilePlus size={14} />,
              action: () => setIsNewFileModalOpen(true),
            },
            {
              label: 'New Folder',
              icon: <FolderInput size={14} />,
              action: () => setIsNewFolderModalOpen(true),
            },
          ]
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
      if (!isVisible || isNewFolderModalOpen || isNewFileModalOpen || isRenameModalOpen || editingFile || isCopyModalOpen || isPropertiesOpen) return;
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
    activeConnectionId, searchTerm, isSearchOpen, files, settings, isNewFolderModalOpen, isNewFileModalOpen, isRenameModalOpen,
    editingFile, selectedFiles, focusedFile, handleNavigate, handleCopy, handlePaste,
    handleDelete, isMatch, navigateBack, navigateForward
  ]);

  // Focus management
  useEffect(() => {
    if (isVisible && containerRef.current) {
      containerRef.current.focus();
    }
  }, [isVisible]);

  useEffect(() => {
    if (!editingFile) return;
    markEditorOverlayOpen();
    return () => {
      clearEditorOverlayOpen();
    };
  }, [editingFile]);

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
        onNewFile={() => setIsNewFileModalOpen(true)}
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
        {currentError === 'DISCONNECTED' ? (
          <div className="flex-1 flex flex-col items-center justify-center text-app-text p-8 text-center animate-in fade-in zoom-in-95 duration-300">
            <div className="bg-app-surface/50 border border-app-border rounded-xl p-8 max-w-sm shadow-xl flex flex-col items-center">
              <div className="bg-red-500/10 text-red-500 p-4 rounded-full mb-4">
                <Unplug size={48} strokeWidth={1.5} />
              </div>
              <h2 className="text-xl font-bold mb-2">Connection Lost</h2>
              <p className="text-sm text-app-muted mb-6">
                Zync lost the connection to the server and could not automatically recover it. Please check your internet connection and try again.
              </p>
              <Button
                onClick={() => {
                  if (activeConnectionId) {
                    loadFiles(activeConnectionId, currentPath || '/');
                  }
                }}
                className="w-full gap-2"
              >
                <RotateCw size={16} />
                Reconnect
              </Button>
            </div>
          </div>
        ) : (
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
        )}
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
      <Modal isOpen={isNewFileModalOpen} onClose={() => setIsNewFileModalOpen(false)} title="New File">
        <div className="space-y-4">
          <Input
            label="File Name"
            placeholder="my-file.txt"
            value={newFileName}
            onChange={(e) => setNewFileName(e.target.value)}
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && handleCreateFile()}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setIsNewFileModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateFile}>Create</Button>
          </div>
        </div>
      </Modal>


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
          preferredProviderId={editorProviderOverride ?? undefined}
          onSave={handleSaveFile}
          onClose={() => {
            setEditingFile(null);
            setEditorProviderOverride(null);
          }}
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
      {/* Conflict Resolution Modal */}
      <ConflictModal
        isOpen={!!currentConflict}
        onClose={() => {
          if (isProcessing) return;
          setCurrentConflict(null);
          setPendingConflicts([]);
        }}
        onResolve={resolveConflict}
        fileName={currentConflict?.name || ''}
        destinationPath={currentPath}
        isBatch={pendingConflicts.length > 1}
        isResolving={isProcessing}
      />
    </div>
  );
}
