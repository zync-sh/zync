import {
  Clipboard,
  Copy,
  Download,
  FolderInput,
  HardDrive,
  RotateCw,
  Scissors,
  Server,
  Trash2,
  Upload,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useAppStore, Connection } from '../store/useAppStore';
import { FileEditor } from './FileEditor';
import { CopyToServerModal } from './file-manager/CopyToServerModal';
import { FileGrid, getCurrentDragSource } from './file-manager/FileGrid';
import { FileToolbar } from './file-manager/FileToolbar';
import type { FileEntry } from './file-manager/types';
import { Button } from './ui/Button';
import { ContextMenu, type ContextMenuItem } from './ui/ContextMenu';
import { Input } from './ui/Input';
import { Modal } from './ui/Modal';

export function FileManager({ connectionId }: { connectionId?: string }) {
  const globalActiveId = useAppStore(state => state.activeConnectionId);
  const connections = useAppStore(state => state.connections);
  const connect = useAppStore(state => state.connect);
  const activeConnectionId = connectionId || globalActiveId;
  const addTransfer = useAppStore(state => state.addTransfer);

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
  // const downloadAction = useAppStore(state => state.downloadFiles); // Not implemented fully yet

  // Derived State
  const files = activeConnectionId ? (filesMap[activeConnectionId] || []) : [];
  const currentPath = activeConnectionId ? (currentPathMap[activeConnectionId] || '') : '';
  const homePath = ''; // We can probably store this in the store too or just rely on init? For now kept local or derived.
  const loading = activeConnectionId ? (loadingMap[activeConnectionId] || false) : false;

  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState('');

  // Editor State
  const [editingFile, setEditingFile] = useState<FileEntry | null>(null);
  const [editorContent, setEditorContent] = useState('');

  // Modal States
  const [isNewFolderModalOpen, setIsNewFolderModalOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [isRenameModalOpen, setIsRenameModalOpen] = useState(false);
  const [renameOldName, setRenameOldName] = useState('');
  const [renameNewName, setRenameNewName] = useState('');

  // Context Menu State
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    file: FileEntry | null;
  } | null>(null);

  // Drag Drop State
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [dragType, setDragType] = useState<'local' | 'server' | null>(null);
  const [dragSourceConnectionId, setDragSourceConnectionId] = useState<string | null>(null);

  // Clipboard State
  const [clipboard, setClipboard] = useState<{
    files: FileEntry[];
    connectionId: string;
    path: string;
    op: 'copy' | 'cut';
  } | null>(null);

  // Copy to Server State
  const [isCopyModalOpen, setIsCopyModalOpen] = useState(false);
  const [fileToCopy, setFileToCopy] = useState<{
    connectionId: string;
    path: string;
    name: string;
  } | null>(null);

  // ... existing Drag Drop State ...

  const [isProcessing, setIsProcessing] = useState(false);
  const completeTransfer = useAppStore(state => state.completeTransfer);
  const failTransfer = useAppStore(state => state.failTransfer);

  // Combine store loading and local processing
  const isLoading = loading || isProcessing;

  // --- Copy / Paste Logic ---
  const handleCopy = (cut = false) => {
    if (!activeConnectionId || !contextMenu?.file) return;
    setClipboard({
      files: [contextMenu.file], // Currently single file context menu
      connectionId: activeConnectionId,
      path: currentPath,
      op: cut ? 'cut' : 'copy',
    });
    showToast('info', `${cut ? 'Cut' : 'Copied'} ${contextMenu.file.name}`);
    setContextMenu(null);
  };

  const handlePaste = async () => {
    if (!clipboard || !activeConnectionId) return;

    // Same Server Paste
    if (clipboard.connectionId === activeConnectionId) {
      setIsProcessing(true);
      try {
        for (const file of clipboard.files) {
          const srcPath = clipboard.path === '/' ? `/${file.name}` : `${clipboard.path}/${file.name}`;
          // Destination is current directory
          const cmdCmd = clipboard.op === 'cut' ? 'mv' : 'cp -r';

          // Simple quote escaping (basic)
          const cmd = `${cmdCmd} "${srcPath}" "${currentPath === '/' ? '' : currentPath}/"`;

          await window.ipcRenderer.invoke('ssh:exec', {
            id: activeConnectionId,
            command: cmd,
          });
        }
        showToast('success', `${clipboard.op === 'cut' ? 'Move' : 'Paste'} complete`);
        loadFiles(activeConnectionId, currentPath);
        if (clipboard.op === 'cut') setClipboard(null); // Clear clipboard after move
      } catch (error: any) {
        showToast('error', `${clipboard.op === 'cut' ? 'Move' : 'Paste'} failed: ` + error.message);
      } finally {
        setIsProcessing(false);
      }
    } else {
      // Different Server Paste (Cross-Server Transfer)
      if (clipboard.op === 'cut') {
        showToast('warning', 'Cross-server cut/move not fully supported yet. Converting to Copy.');
      }

      for (const file of clipboard.files) {
        const srcPath = clipboard.path === '/' ? `/${file.name}` : `${clipboard.path}/${file.name}`;
        const destPath = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;

        // Add transfer
        const transferId = addTransfer({
          sourceConnectionId: clipboard.connectionId,
          sourcePath: srcPath,
          destinationConnectionId: activeConnectionId,
          destinationPath: destPath,
        });

        // Execute background
        window.ipcRenderer.invoke('sftp:copyToServer', {
          sourceConnectionId: clipboard.connectionId,
          sourcePath: srcPath,
          destinationConnectionId: activeConnectionId,
          destinationPath: destPath, // target path needs filename
          transferId,
        })
          .then(() => {
            completeTransfer(transferId);
            showToast('success', `Transfer of ${file.name} complete`);
            // Refresh if we are viewing the destination
            if (activeConnectionId) refreshFiles(activeConnectionId);
          })
          .catch((error: any) => {
            console.error('Transfer failed', error);
            failTransfer(transferId, error.message);
            showToast('error', `Transfer of ${file.name} failed: ${error.message}`);
          });
      }
      showToast('info', 'Transfer started in background');
      setClipboard(null);
    }
    setContextMenu(null);
  };

  const initHomeDirectory = useCallback(async () => {
    if (!activeConnectionId || !isConnected) return;

    // If we already have a path for this connection, just ensure it's loaded
    // If not, fetch home dir
    if (!currentPath) {
      try {
        const path = await window.ipcRenderer.invoke('sftp:cwd', {
          id: activeConnectionId,
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
    // ... (existing logic) ...
    if (!activeConnectionId) return;
    setIsProcessing(true);
    try {
      const fullPath = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;
      const content = await window.ipcRenderer.invoke('sftp:readFile', {
        id: activeConnectionId,
        path: fullPath,
      });
      setEditorContent(content);
      setEditingFile(file);
    } catch (error: any) {
      showToast('error', `Failed to open file: ${error.message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSaveFile = async (content: string) => {
    // ... (existing logic) ...
    if (!activeConnectionId || !editingFile) return;
    try {
      const fullPath = currentPath === '/' ? `/${editingFile.name}` : `${currentPath}/${editingFile.name}`;
      await window.ipcRenderer.invoke('sftp:writeFile', {
        id: activeConnectionId,
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
    if (!renameNewName.trim() || renameNewName === renameOldName || !activeConnectionId) return;
    await renameEntry(activeConnectionId, renameOldName, renameNewName);
    setIsRenameModalOpen(false);
    setRenameNewName('');
  };

  const openRenameModal = (filename: string) => {
    setRenameOldName(filename);
    setRenameNewName(filename);
    setIsRenameModalOpen(true);
  };

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

  const performUpload = async (filePaths: string[]) => {
    if (!activeConnectionId) return;
    await uploadAction(activeConnectionId, filePaths);
  };

  const handleDownload = async () => {
    if (selectedFiles.length === 0 || !activeConnectionId) return;
    try {
      const { filePaths, canceled } = await window.ipcRenderer.invoke('dialog:openDirectory');
      if (canceled || filePaths.length === 0) return;
      const targetDir = filePaths[0];

      // We process download locally in component for now as it involves local FS dialog
      setIsProcessing(true);
      showToast('info', `Downloading ${selectedFiles.length} file(s)...`);
      for (const fileName of selectedFiles) {
        const remotePath = currentPath === '/' ? `/${fileName}` : `${currentPath}/${fileName}`;
        const localPath = targetDir.includes('\\') ? `${targetDir}\\${fileName}` : `${targetDir}/${fileName}`;
        await window.ipcRenderer.invoke('sftp:get', {
          id: activeConnectionId,
          remotePath,
          localPath,
        });
      }
      showToast('success', 'Download complete');
      setIsProcessing(false);
    } catch (error: any) {
      showToast('error', `Download failed: ${error.message}`);
      setIsProcessing(false);
    }
  };

  const handleDelete = async () => {
    if (selectedFiles.length === 0 || !activeConnectionId) return;

    if (settings.fileManager.confirmDelete) {
      if (!confirm(`Are you sure you want to delete ${selectedFiles.length} item(s)?`)) return;
    }

    const paths = selectedFiles.map(name => currentPath === '/' ? `/${name}` : `${currentPath}/${name}`);
    await deleteEntries(activeConnectionId, paths);
    setSelectedFiles([]);
  };

  // Drag and Drop
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(true);

    // Detect drag type
    const types = e.dataTransfer.types;
    if (types.includes('application/json')) {
      setDragType('server');
      // Check if it's from the same server
      const dragSource = getCurrentDragSource();
      if (dragSource) {
        setDragSourceConnectionId(dragSource.connectionId);
      }
    } else if (types.includes('Files')) {
      setDragType('local');
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);
    setDragType(null);
    setDragSourceConnectionId(null);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);
    setDragType(null);
    setDragSourceConnectionId(null);

    // Try to parse as server-to-server file
    try {
      const jsonData = e.dataTransfer.getData('application/json');
      if (jsonData) {
        const dragData = JSON.parse(jsonData);
        setDragSourceConnectionId(dragData.connectionId);
        if (dragData.type === 'server-file' && activeConnectionId) {
          // Server-to-server drop!
          if (dragData.connectionId === activeConnectionId) {
            // Same server - silently ignore
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

          showToast('info', 'Transfer started in background');

          // Execute transfer in background
          (async () => {
            try {
              await window.ipcRenderer.invoke('sftp:copyToServer', {
                sourceConnectionId: dragData.connectionId,
                sourcePath: dragData.path,
                destinationConnectionId: activeConnectionId,
                destinationPath: destPath,
                transferId,
              });

              // Refresh file list
              loadFiles(currentPath);
            } catch (error: any) {
              if (error.message && !error.message.includes('destroy')) {
                showToast('error', `Transfer failed: ${error.message}`);
              }
            }
          })();

          return;
        }
      }
    } catch (_err) {
      // Not JSON or not a server file, try as local files
    }

    // Handle local file upload
    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length === 0) return;
    const filePaths = droppedFiles
      .map((f: any) => window.electronUtils?.getPathForFile(f) || f.path)
      .filter((p) => !!p);
    if (filePaths.length > 0) performUpload(filePaths);
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
            const fullPath =
              currentPath === '/' ? `/${contextMenu.file.name}` : `${currentPath}/${contextMenu.file.name}`;
            setFileToCopy({
              connectionId: activeConnectionId,
              path: fullPath,
              name: contextMenu.file.name,
            });
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
          action: () => loadFiles(currentPath),
        },
      );
    }
  }

  if (!activeConnectionId) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-app-muted">
        <HardDrive size={64} className="mb-4 text-app-border" strokeWidth={1} />
        <p>Select a connection to view files</p>
      </div>
    );
  }

  if (!isConnected) {
    if (connection?.status === 'connecting') {
      return (
        <div className="h-full flex flex-col items-center justify-center text-app-muted gap-4">
          <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-app-accent"></div>
          <p>Establishing secure connection...</p>
        </div>
      );
    }

    return (
      <div className="h-full flex flex-col items-center justify-center text-app-muted gap-4">
        <div className="h-12 w-12 rounded-full bg-app-surface border border-app-border flex items-center justify-center text-app-muted/50">
          <Server size={24} />
        </div>
        <div className="text-center">
          <p className="text-sm font-medium text-app-text mb-1">Disconnected</p>
          <p className="text-xs text-app-muted mb-4 opacity-70">The remote session was terminated</p>
          <Button onClick={() => connect(activeConnectionId)}>Reconnect</Button>
        </div>
      </div>
    );
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: intractable div
    <div
      className="flex flex-col h-full relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Editor Overlay */}
      {editingFile && (
        <FileEditor
          filename={editingFile.name}
          initialContent={editorContent}
          onSave={handleSaveFile}
          onClose={() => {
            setEditingFile(null);
            setEditorContent('');
          }}
        />
      )}

      {/* Drag Overlay - only show if not same server */}
      {isDraggingOver && !(dragType === 'server' && dragSourceConnectionId === activeConnectionId) && (
        <div className="absolute inset-0 bg-app-accent/20 border-2 border-app-accent border-dashed z-50 flex items-center justify-center backdrop-blur-sm pointer-events-none">
          <div className="bg-app-panel p-8 rounded-xl border border-app-accent flex flex-col items-center animate-in zoom-in-95 duration-200">
            {dragType === 'server' ? (
              <>
                <Copy size={48} className="text-app-accent mb-4" />
                <h3 className="text-xl font-bold text-white">Drop to Copy Here</h3>
                <p className="text-sm text-app-muted mt-2">Server-to-server transfer</p>
              </>
            ) : (
              <>
                <Upload size={48} className="text-app-accent mb-4" />
                <h3 className="text-xl font-bold text-white">Drop to Upload</h3>
              </>
            )}
          </div>
        </div>
      )}

      <FileToolbar
        currentPath={currentPath}
        homePath={homePath}
        onNavigate={handleNavigate}
        onRefresh={() => activeConnectionId && refreshFiles(activeConnectionId)}
        onUpload={handleUpload}
        onNewFolder={() => setIsNewFolderModalOpen(true)}
        viewMode={viewMode}
        onToggleView={setViewMode}
        onSearch={setSearchTerm}
      />

      {/** biome-ignore lint/a11y/noStaticElementInteractions: interactive div */}
      <div className="flex-1 overflow-hidden relative flex flex-col" onClick={() => setContextMenu(null)}>
        <FileGrid
          files={filteredFiles}
          selectedFiles={selectedFiles}
          onSelect={handleSelect}
          onNavigate={handleNavigate}
          onContextMenu={handleContextMenu}
          viewMode={viewMode}
          isLoading={isLoading}
          connectionId={activeConnectionId}
          currentPath={currentPath}
        />
      </div>

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
          setFileToCopy(null);
        }}
        sourceFile={fileToCopy}
      />
    </div>
  );
}
