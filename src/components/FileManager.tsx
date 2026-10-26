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
  Terminal,
  Zap,
  Settings as SettingsIcon,
  Info,
  Pin,
} from 'lucide-react';
import { ConfirmModal } from './ui/ConfirmModal';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useState, useRef } from 'react';
import { useAppStore, Connection } from '../store/useAppStore';

import { FileEditor } from './FileEditor';
import { CopyToServerModal } from './file-manager/CopyToServerModal';
import { FileGrid } from './file-manager/FileGrid';
import { FILE_LIST_SORT_INITIAL, sortFileEntries, type FileSortColumn, type FileSortDirection } from './file-manager/fileGridLayout';
import { getCurrentDragSource } from '../lib/dragDrop';
import { FileToolbar } from './file-manager/FileToolbar';
import { FileContentsHeader } from './file-manager/FileContentsHeader';
import type { FileDetailColumn } from './file-manager/fileListPresentation';
import { useFileInspectorFocus } from './file-manager/useFileInspectorFocus';
import { useFileActivationFocus } from './file-manager/useFileActivationFocus';
import { useFileSelectionColors } from './file-manager/useFileSelectionColors';
import { useFilePanelLayout } from './file-manager/useFilePanelLayout';
import { FilePlacesSidebar } from './file-manager/FilePlacesSidebar';
import { loadLocalFileVolumes, type FileVolume } from './file-manager/fileVolumes';
import { FileSideDrawer } from './file-manager/FileSideDrawer';
import { FileLayoutSurface } from './file-manager/FileLayoutSurface';
import { FILE_GRID_ZOOM, FILE_LIST_ZOOM, FILE_PLACES_WIDTH_PX, FILE_PROPERTIES_WIDTH_PX, clampFileGridZoom, clampFileListZoom, clampFileRecentLimit } from './file-manager/fileChrome';
import { filePathLeafLabel, inferHomePath, isFilePathEqual, normalizeFilePath, parentFilePath } from './file-manager/filePathNav';
import { fileMatchesQuery, fileMatchesSearchType } from './file-manager/fileSearchFilter';
import type { FileSearchTypeFilter } from './file-manager/FileQueryEditor';
import type { FileEntry } from './file-manager/types';
import { EDITOR_READ_LIMIT_MESSAGE, exceedsEditorReadLimit, isEditorReadLimitError, MAX_EDITOR_FILE_BYTES } from './file-manager/editorReadPolicy';
import { PropertiesPanel } from './file-manager/PropertiesPanel';
import { useFilePermissionEditor } from '../features/files/application/useFilePermissionEditor';
import { useFileActionAccess } from '../features/files/application/useFileActionAccess';
import { useFolderSizes } from '../features/files/application/useFolderSizes';
import { FolderSizeDetails } from './file-manager/FolderSizeValue';
import { useFileClipboard } from './file-manager/useFileClipboard';
import { isFileManagerPanelShown, useFileKeyboard } from './file-manager/useFileKeyboard';
import { useFileSelection } from './file-manager/useFileSelection';
import { fileSelectionSummary } from './file-manager/fileSelectionSummary';
import { fileFolderOptions } from './file-manager/fileFolderOptions';
import { useFileUploads } from './file-manager/useFileUploads';
import { ConflictModal, type ConflictAction } from './file-manager/ConflictModal';
import { useFileConflictQueue } from './file-manager/useFileConflictQueue';
import { Button } from './ui/Button';
import { ContextMenu, type ContextMenuItem } from './ui/ContextMenu';
import { Input } from './ui/Input';
import { Modal } from './ui/Modal';
import { StateMessage } from './ui/StateMessage';
import './file-manager/files.css';

import { usePlugins } from '../context/PluginContext';
import { buildEditorProviderOptions, CODEMIRROR_EDITOR_ID } from './editor/providers';
import { clearEditorOverlayOpen, markEditorOverlayOpen } from './editor/overlayState';
import { TerminalDisconnectedView } from './terminal/TerminalDisconnectedView';
import { collectLeaves, isFeatureContent, layoutForCanvas, layoutForFeatureInstance } from '../lib/paneLayout';
import { acknowledgeMovedClipboard, filesStoreKey, splitFileName } from '../store/fileSystemSlice';
import { paneCloseScope, registerPaneCloseBlocker } from '../lib/paneCloseBlockers';
import { isCurrentEditorRead, type EditorFileTarget } from './file-manager/editorReadIdentity';
import { executeFileTransfer, tryStagedFileTransfer, isTransferCancellation, transferErrorMessage, fileTransferFailureMessage, isFileTransferNotStarted, type FileTransferRequest } from '../features/files/application/executeFileTransfer';
import { createFileTransferExecution } from '../features/files/application/transferEventProjection';
import { acquireFileDestination, type FileDestinationReservation } from '../features/files/application/fileDestinationReservations';
import { replaceFileWithBackup, replacementPreconditionError } from '../features/files/application/replaceFileWithBackup';
import type { AppStore } from '../store/useAppStore';
import { runFileTransferBatch, fileTransferBatchFailure, recordFileTransferFailure, type FileTransferBatchResult } from '../features/files/application/runFileTransferBatch';
import { canSplitBesideFiles, isUnconfirmedHomeToken, isUnresolvedFilesPath, openHerePlacementItems, openTerminalHere, pickFilesHomePath } from './layout/tabDock';

export type FileManagerSurface = 'overlay' | 'pane';

const EMPTY_FILES: FileEntry[] = [];
const EMPTY_PATHS: string[] = [];

function isFileManagerActive(
  state: AppStore,
  connectionId: string | undefined,
  surface: FileManagerSurface,
  instanceId?: string,
): boolean {
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  if (!tab) return false;
  if (connectionId != null && tab.connectionId !== connectionId) return false;
  const scope = connectionId ?? tab.connectionId;
  if (!scope) return false;
  if (surface === 'overlay') return tab.view === 'files' && !instanceId;
  const groups = state.paneLayouts[scope];
  const layout = (instanceId ? layoutForFeatureInstance(groups, instanceId) : undefined)
    ?? layoutForCanvas(groups, state.activeTerminalIds[scope], state.activePaneGroupOwner[scope]);
  if (!layout) return false;
  return collectLeaves(layout.root).some((leaf) => (
    isFeatureContent(leaf.content)
    && leaf.content.featureId === 'files'
    && (instanceId ? leaf.content.instanceId === instanceId : !leaf.content.instanceId)
  ));
}

export interface Conflict {
  source: string;
  target: string;
  name: string;
  op: 'move' | 'copy';
  sourceConnectionId: string;
  destinationConnectionId?: string;
  sourceKind?: string;
  canCombine?: boolean;
}

function terminalHereMenuItems(
  connectionId: string,
  listedPath: string,
  file: { type: string; name: string; path?: string } | undefined,
  onDone: () => void,
  instanceId?: string,
): ContextMenuItem[] {
  const splitDisabled = !canSplitBesideFiles(connectionId, { instanceId });
  const syncedSplitDisabled = !canSplitBesideFiles(connectionId, { instanceId, synced: true });
  const run = (opts?: { synced?: boolean; edge?: 'left' | 'right' | 'top' | 'bottom' }) => {
    void openTerminalHere(connectionId, listedPath, { ...opts, file, instanceId }).then(onDone);
  };
  return [
    {
      label: 'Open Terminal Here',
      icon: <Terminal size={14} />,
      children: openHerePlacementItems(
        () => run(),
        (edge) => run({ edge }),
        splitDisabled,
      ),
    },
    {
      label: 'Follow with Terminal',
      icon: <Zap size={14} className="text-yellow-500" />,
      children: openHerePlacementItems(
        () => run({ synced: true }),
        (edge) => run({ synced: true, edge }),
        syncedSplitDisabled,
      ),
    },
  ];
}

export const FileManager = memo(function FileManager({
  connectionId,
  surface = 'overlay',
  instanceId,
  active,
  focused,
}: {
  connectionId?: string;
  surface?: FileManagerSurface;
  instanceId?: string;
  active?: boolean;
  /** Renderer-owned keyboard focus; listing visibility remains independent. */
  focused?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const listingFocusRef = useRef<HTMLDivElement>(null);
  const [focusRevealRequest, setFocusRevealRequest] = useState(0);
  const requestFocusReveal = useCallback(() => setFocusRevealRequest(value => value + 1), []);
  const activationFocus = useFileActivationFocus(containerRef, listingFocusRef);
  const selectionColors = useFileSelectionColors(containerRef);
  const { focusOnActivation } = activationFocus;
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
  const connect = useAppStore((state) => state.connect);
  const openConnectionModal = useAppStore((state) => state.openConnectionModal);
  const openVaultTab = useAppStore((state) => state.openVaultTab);
  const setTabView = useAppStore((state) => state.setTabView);
  const isPendingRestore = useAppStore((state) => {
    if (!activeConnectionId || isLocal) return false;
    const tabs = state.terminals[activeConnectionId];
    return !!tabs?.some((t) => t.pendingRestore);
  });
  const storeSurfaceActive = useAppStore((state) => isFileManagerActive(state, connectionId, surface, instanceId));
  const isFilesSurfaceActive = active ?? storeSurfaceActive;
  const isFilesFocusOwner = isFilesSurfaceActive && (focused ?? true);
  const filesFocusOwnerRef = useRef(isFilesFocusOwner);
  filesFocusOwnerRef.current = isFilesFocusOwner;
  const storeKey = activeConnectionId ? filesStoreKey(activeConnectionId, instanceId) : '';

  // Zustand Store Hooks — subscribe to this connection only so other hosts do not re-paint Files.
  const files = useAppStore(state => (
    storeKey ? (state.files[storeKey] ?? EMPTY_FILES) : EMPTY_FILES
  ));
  const currentPath = useAppStore(state => (
    storeKey ? (state.currentPath[storeKey] ?? '') : ''
  ));
  const loading = useAppStore(state => Boolean(storeKey && state.isLoading[storeKey]));
  const currentError = useAppStore(state => (
    storeKey ? (state.error[storeKey] ?? null) : null
  ));
  const readDeniedPath = useAppStore(state => {
    const denial = state.listingReadDenial[storeKey];
    return state.error[storeKey] && denial && denial.connection === state.connections.find(item => item.id === activeConnectionId)
      ? denial.path : undefined;
  });
  const loadFilesStore = useAppStore(state => state.loadFiles);
  const loadFiles = useCallback((cid: string, path?: string, skipHistory?: boolean, silent?: boolean) => (
    loadFilesStore(cid, path, skipHistory, silent, instanceId)
  ), [loadFilesStore, instanceId]);
  const refreshFilesStore = useAppStore(state => state.refreshFiles);
  const refreshFiles = useCallback((cid: string) => refreshFilesStore(cid, instanceId), [refreshFilesStore, instanceId]);
  const createFolderStore = useAppStore(state => state.createFolder);
  const createFolder = useCallback((cid: string, name: string) => createFolderStore(cid, name, instanceId), [createFolderStore, instanceId]);
  const renameEntryStore = useAppStore(state => state.renameEntry);
  const renameEntry = useCallback((cid: string, oldName: string, newName: string) => renameEntryStore(cid, oldName, newName, instanceId), [renameEntryStore, instanceId]);
  const deleteEntriesStore = useAppStore(state => state.deleteEntries);
  const deleteEntries = useCallback((cid: string, paths: string[]) => deleteEntriesStore(cid, paths, instanceId), [deleteEntriesStore, instanceId]);
  const navigateBackStore = useAppStore(state => state.navigateBack);
  const navigateBack = useCallback((cid: string) => navigateBackStore(cid, instanceId), [navigateBackStore, instanceId]);
  const navigateForwardStore = useAppStore(state => state.navigateForward);
  const navigateForward = useCallback((cid: string) => navigateForwardStore(cid, instanceId), [navigateForwardStore, instanceId]);
  const navigateHistoryToStore = useAppStore(state => state.navigateHistoryTo);
  const navigateHistoryTo = useCallback((cid: string, index: number) => navigateHistoryToStore(cid, index, instanceId), [navigateHistoryToStore, instanceId]);
  const pasteEntriesStore = useAppStore(state => state.pasteEntries);
  const pasteEntries = useCallback((cid: string, sources: string[], op: 'copy' | 'cut', dest?: string) => (
    pasteEntriesStore(cid, sources, op, dest, instanceId)
  ), [pasteEntriesStore, instanceId]);
  const clipboard = useAppStore(state => state.clipboard);
  const updateSettings = useAppStore(state => state.updateSettings);
  const updateFileManagerSettings = useAppStore(state => state.updateFileManagerSettings);
  const clearRecentPaths = useAppStore(state => state.clearRecentPaths);
  // const downloadAction = useAppStore(state => state.downloadFiles); // Not implemented fully yet

  const activeHistoryIndex = useAppStore(state => (
    storeKey ? (state.historyIndex[storeKey] || 0) : 0
  ));
  const activeHistory = useAppStore(state => (
    (storeKey && state.history[storeKey]) || EMPTY_PATHS
  ));
  const activeHistoryLength = activeHistory.length;
  const recentPaths = useAppStore(state => (
    (activeConnectionId && state.recentPaths[activeConnectionId]) || EMPTY_PATHS
  ));
  const filesOpenHint = useAppStore((state) => {
    if (!activeConnectionId) return '';
    const path = state.currentPath[storeKey] ?? '';
    const listing = state.files[storeKey];
    const waiting = (!path || path === '/' || path === '~') && (!listing || listing.length === 0);
    if (!waiting) return '';
    const home = state.connections.find((item) => item.id === activeConnectionId)?.homePath;
    return home || '';
  });

  const viewMode: 'grid' | 'list' = settings.fileManager.defaultView === 'list' ? 'list' : 'grid';
  const setViewMode = useCallback((mode: 'grid' | 'list') => {
    if (mode === viewMode) return;
    void updateFileManagerSettings({ defaultView: mode });
  }, [updateFileManagerSettings, viewMode]);
  const [typeFilter, setTypeFilter] = useState<FileSearchTypeFilter>('all');
  // Wide Places is visible only by default; explicit saved visibility remains authoritative.
  const placesCollapsed = settings.fileManager.placesCollapsed ?? false;
  const [volumes, setVolumes] = useState<FileVolume[]>([]);
  const {
    selectedFiles,
    setSelectedFiles,
    focusedFile,
    setFocusedFile,
    handleSelect,
    handleSelectAll,
    handleSelectMany,
    selectContextFile,
  } = useFileSelection(currentPath, activeConnectionId ?? undefined, files);
  const [sortColumn, setSortColumn] = useState<FileSortColumn>('name');
  const [sortDirection, setSortDirection] = useState<FileSortDirection>('asc');
  const [detailColumns, setDetailColumns] = useState<FileDetailColumn[]>([]);
  /** Stable action identity lets the existing view-controls memo skip scan updates. */
  const handleToggleColumn = useCallback((column: FileDetailColumn) => {
    setDetailColumns(current => current.includes(column) ? current.filter(item => item !== column) : [...current, column]);
  }, []);
  const [gridColumnCount, setGridColumnCount] = useState(1);
  const [searchTerm, setSearchTerm] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isEditingPath, setIsEditingPath] = useState(false);

  // A quick filter belongs to one listing, never a different host or directory.
  useEffect(() => {
    setSearchTerm('');
    setTypeFilter('all');
    setIsSearchOpen(false);
  }, [currentPath, activeConnectionId]);

  // Editor State
  const [editingFile, setEditingFile] = useState<FileEntry | null>(null);
  const [editingFileTarget, setEditingFileTarget] = useState<EditorFileTarget | null>(null);
  const editorTargetRef = useRef<EditorFileTarget | null>(null);
  const editorReadRequestRef = useRef(0);
  const editorConnectionRef = useRef(activeConnectionId);
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  const editorCloseToken = useRef({});
  const [editorContent, setEditorContent] = useState('');
  const [editorProviderOverride, setEditorProviderOverride] = useState<string | null>(null);
  useLayoutEffect(() => {
    editorConnectionRef.current = activeConnectionId;
    editorReadRequestRef.current += 1;
    editorTargetRef.current = null;
    setEditingFile(null);
    setEditingFileTarget(null);
    setEditorDirty(false);
    setEditorContent('');
    setEditorProviderOverride(null);
    setIsFileLoading(false);
  }, [activeConnectionId]);

  useLayoutEffect(() => {
    if (surface !== 'pane' || !editingFile || !editorDirty || !activeConnectionId) return;
    const scope = paneCloseScope(activeConnectionId, {
      kind: 'feature',
      featureId: 'files',
      instanceId,
    });
    return scope ? registerPaneCloseBlocker(scope, editorCloseToken.current) : undefined;
  }, [activeConnectionId, editorDirty, editingFile, instanceId, surface]);

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
    keyboard?: boolean;
  } | null>(null);

  // Drag Drop State
  const [isInternalDraggingOver, setIsInternalDraggingOver] = useState(false);
  const [dragType, setDragType] = useState<'local' | 'server' | null>(null);
  const [dragSourceConnectionId, setDragSourceConnectionId] = useState<string | null>(null);

  // Conflict Resolution State
  const { conflicts: pendingConflicts, current: currentConflict, replace: replaceConflicts,
    clear: clearConflicts, take: takeConflicts } = useFileConflictQueue<Conflict>();

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
  const operationGeneration = useRef(0);
  const [isZipping, setIsZipping] = useState(false);
  const { placesInline, propertiesInline } = useFilePanelLayout(containerRef);
  const isNarrow = !placesInline;
  const [placesOverlayOpen, setPlacesOverlayOpen] = useState(false);
  const showPlaces = isNarrow ? placesOverlayOpen : !placesCollapsed;
  useFileInspectorFocus(isPropertiesOpen, propertiesInline, containerRef, listingFocusRef, isFilesSurfaceActive);
  const editorProviderOptions = useMemo(() => buildEditorProviderOptions(editorProviders), [editorProviders]);

  useLayoutEffect(() => {
    operationGeneration.current += 1;
    clearConflicts();
    setIsProcessing(false);
    return () => { operationGeneration.current += 1; };
  }, [activeConnectionId, instanceId, clearConflicts]);

  useEffect(() => { if (!isNarrow) setPlacesOverlayOpen(false); }, [isNarrow]);

  useLayoutEffect(() => {
    if (isFilesSurfaceActive) return;
    setPlacesOverlayOpen(false);
    // Inline details are retained with their pane; transient dialogs are dismissed.
    if (!propertiesInline) setIsPropertiesOpen(false);
  }, [isFilesSurfaceActive, propertiesInline]);

  // Sync terminal to FM navigation if a synced terminal is active
  useEffect(() => {
    if (!isFilesSurfaceActive) return;
    if (syncedTerminalId && currentPath && isFileManagerPanelShown(containerRef.current)) {
      window.ipcRenderer.invoke('terminal:navigate', { termId: syncedTerminalId, path: currentPath });
      useAppStore.getState().setTerminalCwd(activeConnectionId || 'local', syncedTerminalId, currentPath);
    }
  }, [currentPath, syncedTerminalId, activeConnectionId, isFilesSurfaceActive]);

  // Combine store loading and local processing
  const isLoading = loading || isProcessing;
  const isReconnectPending = !isLocal && connection?.status === 'connecting';
  const actionTargetName = selectedFiles.length === 1 ? selectedFiles[0] : selectedFiles.length === 0 ? focusedFile : null;
  const actionAccess = useFileActionAccess(activeConnectionId ?? undefined, currentPath,
    actionTargetName ? files.find(file => file.name === actionTargetName)?.path ?? null : null,
    isFilesSurfaceActive && isConnected && !loading, files, readDeniedPath);
  const actionBlocked = actionAccess.blocked;
  const { handleCopy, copyUnavailable, cutUnavailable } = useFileClipboard({
    connectionId: activeConnectionId ?? undefined, currentPath, files, selectedFiles, instanceId,
    isBlocked: actionBlocked,
    active: isFilesSurfaceActive && isConnected,
  });
  const canGoBack = Boolean(activeConnectionId) && activeHistoryIndex > 0;
  const canGoForward = Boolean(activeConnectionId) && activeHistoryIndex < activeHistoryLength - 1;

  const clearDragVisual = useCallback(() => {
    setIsInternalDraggingOver(false);
    setDragType(null);
    setDragSourceConnectionId(null);
  }, []);
  const handleConnectionError = useCallback((connectionId: string, err: any, preserveEditor = false) => {
    const msg = err.message || String(err);
    if (msg.includes('DISCONNECTED:')) {
      const key = filesStoreKey(connectionId, instanceId);
      useAppStore.setState(state => ({
        error: { ...state.error, [key]: 'DISCONNECTED' }
      }));
      // Close any open modals to show the overlay clearly
      setIsEditingPath(false);
      setIsRenameModalOpen(false);
      if (!preserveEditor) {
        editorTargetRef.current = null;
        setEditingFile(null);
        setEditingFileTarget(null);
      }
      setIsCopyModalOpen(false);
      setIsPropertiesOpen(false);
      setIsDeleteModalOpen(false);
      setIsNewFolderModalOpen(false);
      setIsNewFileModalOpen(false);
      return true;
    }
    return false;
  }, [instanceId]);

  const transferFile = useCallback(async (request: Omit<FileTransferRequest, 'transferId'>,
    options?: { recoveryBackupPath?: string; reservation?: FileDestinationReservation }) => {
    const transferId = addTransfer({ ...request, recoveryBackupPath: options?.recoveryBackupPath });
    const execution = createFileTransferExecution((command, args) => window.ipcRenderer.invoke(command, args), useAppStore.getState);
    await executeFileTransfer({ ...request, transferId }, execution, options?.reservation);
    return transferId;
  }, [addTransfer]);

  /** Native file/folder replacement; only an explicit unhandled kind permits the legacy policy. */
  const tryStagedReplacement = useCallback(async (request: Omit<FileTransferRequest, 'transferId'>) => {
    // Reject a busy replacement before creating another receipt for the same decision.
    const reservation = acquireFileDestination(request.destinationConnectionId, request.destinationPath);
    try {
      const store = useAppStore.getState();
      const transferId = store.addTransfer(request);
      const handled = await tryStagedFileTransfer({ ...request, transferId, overwrite: true },
        createFileTransferExecution((command, args) => window.ipcRenderer.invoke(command, args), useAppStore.getState), reservation);
      if (!handled) store.removeTransfer(transferId);
      return handled;
    } finally { reservation.release(); }
  }, []);

  const executeFileOperations = useCallback(async (ops: {
    source: string;
    target: string;
    name: string;
    op: 'move' | 'copy';
    sourceConnectionId: string
  }[], targetDirectory?: string, targetConnectionId?: string) => {
    const destinationConnectionId = targetConnectionId ?? activeConnectionId;
    if (!destinationConnectionId || ops.length === 0) return;
    if (destinationConnectionId === activeConnectionId
      && isFilePathEqual(targetDirectory ?? currentPath, currentPath) && actionBlocked('receive')) return;

    const generation = operationGeneration.current;
    setIsProcessing(true);
    const conflicts: typeof pendingConflicts = [];
    const executionList: typeof ops = [];
    let refreshAfterMutation = false;
    let immediateFailed = false;

    try {
      const destination = useAppStore.getState().connections.find(item => item.id === destinationConnectionId);
      if (destinationConnectionId !== 'local' && destination && destination.status !== 'connected') {
        await useAppStore.getState().connect(destinationConnectionId);
        if (generation !== operationGeneration.current) return;
      }
      // Pass 1: Check for existence (Parallelized)
      const existenceResults = await Promise.all(ops.map(op =>
        window.ipcRenderer.invoke('fs_exists', {
          connectionId: destinationConnectionId,
          path: op.target,
        })
      ));
      if (generation !== operationGeneration.current) return;

      existenceResults.forEach((exists, i) => {
        if (exists) {
          conflicts.push({ ...ops[i], destinationConnectionId });
        } else {
          executionList.push(ops[i]);
        }
      });

      // Pass 2: Execute immediate actions
      if (executionList.length > 0) {
        for (const item of executionList) {
          const precondition = replacementPreconditionError({ sourceConnectionId: item.sourceConnectionId,
            sourcePath: item.source, destinationConnectionId, destinationPath: item.target });
          if (precondition) throw new Error(precondition);
        }
        const sameConnection = executionList.every(item => item.sourceConnectionId === destinationConnectionId);

        if (sameConnection) {
          refreshAfterMutation = true;
          // Group by operation type (move/copy) to ensure correct store action
          const groups = executionList.reduce((acc, item) => {
            if (!acc[item.op]) acc[item.op] = [];
            acc[item.op].push(item.source);
            return acc;
          }, {} as Record<string, string[]>);

          for (const [opType, sources] of Object.entries(groups)) {
            if (!await pasteEntries(destinationConnectionId, sources, opType === 'move' ? 'cut' : 'copy', targetDirectory ?? currentPath)) {
              void useAppStore.getState().refreshConnectionFiles(destinationConnectionId);
              refreshAfterMutation = false;
              immediateFailed = true;
              break;
            }
          }
        } else {
          // The background promise owns admission until native completion without blocking browsing.
          void runFileTransferBatch(executionList, item => transferFile({
              sourceConnectionId: item.sourceConnectionId,
              sourcePath: item.source,
              destinationConnectionId,
              destinationPath: item.target,
            })).then(result => {
              const failure = fileTransferBatchFailure(result);
              if (failure) showToast('error', `Copy failed: ${failure}`);
            });
          const preservesSource = executionList.some(item => item.op === 'move');
          if (preservesSource) showToast('info', 'Cross-connection moves copy files; source files are kept.');
        }
      }

      // Pass 3: Handle Conflicts
      if (generation !== operationGeneration.current) return;
      if (conflicts.length > 0) {
        // Optional choice metadata uses the existing bounded batch runner. A
        // failed read hides Combine; it never authorizes a write or a fallback.
        await runFileTransferBatch(conflicts, async conflict => {
          try {
            const [sourceKind, destinationKind] = await Promise.all([
              window.ipcRenderer.invoke('fs_entry_kind', { connectionId: conflict.sourceConnectionId, path: conflict.source }),
              window.ipcRenderer.invoke('fs_entry_kind', { connectionId: destinationConnectionId, path: conflict.target }),
            ]);
            conflict.sourceKind = sourceKind;
            conflict.canCombine = sourceKind === 'Directory' && destinationKind === 'Directory'
              && (conflict.op === 'copy' || conflict.sourceConnectionId !== destinationConnectionId);
          } catch { /* Preserve the existing choices if optional metadata is unavailable. */ }
        });
        if (generation !== operationGeneration.current) return;
        replaceConflicts(conflicts);
      } else if (!immediateFailed) {
        // The Files slice acknowledges only confirmed same-endpoint moves.
        setSelectedFiles([]);
      }

      if (refreshAfterMutation) {
        void useAppStore.getState().refreshConnectionFiles(destinationConnectionId);
      }

    } catch (e: any) {
      if (generation !== operationGeneration.current) return;
      if (destinationConnectionId === activeConnectionId && handleConnectionError(destinationConnectionId, e)) return;
      showToast('error', `Operation failed: ${fileTransferFailureMessage(e)}`);
      if (refreshAfterMutation) void useAppStore.getState().refreshConnectionFiles(destinationConnectionId);
    } finally {
      if (generation === operationGeneration.current) setIsProcessing(false);
    }
  }, [
    activeConnectionId,
    currentPath,
    handleConnectionError,
    pasteEntries,
    replaceConflicts,
    showToast,
    transferFile,
    actionBlocked,
  ]);

  const uploadPaths = useCallback(async (paths: string[]) => {
    await executeFileOperations(paths.map(source => {
      const name = filePathLeafLabel(source);
      return { source, name, sourceConnectionId: 'local', op: 'copy',
        target: currentPath === '/' ? `/${name}` : `${currentPath}/${name}` };
    }));
  }, [executeFileOperations, currentPath]);
  const { handleUpload, handleUploadFolder, isTauriDraggingOver } = useFileUploads({
    connectionId: activeConnectionId ?? undefined, isConnected, onDragVisualClear: clearDragVisual, instanceId,
    onUploadPaths: uploadPaths,
    isBlocked: actionBlocked,
  });

  const handlePaste = useCallback(async () => {
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
  }, [activeConnectionId, clipboard, currentPath, executeFileOperations]);

  const handleMoveFiles = useCallback(async (moves: { source: string; target: string; sourceConnectionId?: string }[]) => {
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
  }, [activeConnectionId, executeFileOperations]);

  const resolveConflict = async (action: ConflictAction, applyToAll = false) => {
    const destinationConnectionId = currentConflict?.destinationConnectionId ?? activeConnectionId;
    if (!currentConflict || !destinationConnectionId || isProcessing) return;

    const toProcess = takeConflicts(currentConflict, applyToAll, action === 'combine'
      ? item => item.canCombine === true
      : item => !currentConflict.sourceKind || item.sourceKind === currentConflict.sourceKind);
    if (toProcess.length === 0) return;
    if (applyToAll || pendingConflicts.length === 1) setSelectedFiles([]);
    let successCount = 0;
    const copiesOnly = toProcess.some(item => item.op === 'move' && item.sourceConnectionId !== destinationConnectionId);
    const clipboardAtStart = clipboard;
    const movedSources: string[] = [];
    const sourceReservations: FileDestinationReservation[] = [];
    let refreshAfterMutation = false;
    const failures: FileTransferBatchResult = { failed: 0, cancelled: 0 };
    let firstWarning: string | undefined;
    let warningCount = 0;

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
            const name = filePathLeafLabel(target);
            const parent = target.slice(0, -name.length);
            const { base, ext } = splitFileName(name, conflict.sourceKind === 'Directory');

            let exists = true;
            while (exists) {
              const candidate = `${parent}${base} (${counter})${ext}`;
              exists = await window.ipcRenderer.invoke('fs_exists', {
                connectionId: destinationConnectionId,
                path: candidate,
              });
              if (!exists) {
                finalTarget = candidate;
                break;
              }
              counter++;
              if (counter > 100) {
                recordFileTransferFailure(failures, `Could not find a unique name for "${conflict.name}" after 100 attempts. Skipping.`);
                finalTarget = ''; // Flag as failed
                break;
              }
            }
          }

          if (!finalTarget) {
            // Renaming failed or was skipped
            continue;
          }

          const preconditionError = replacementPreconditionError({ sourceConnectionId, sourcePath: source,
            destinationConnectionId: destinationConnectionId, destinationPath: finalTarget });
          if (preconditionError) {
            recordFileTransferFailure(failures, preconditionError);
            continue;
          }

          if (action === 'overwrite' || action === 'combine') {
            if (op === 'copy' || sourceConnectionId !== destinationConnectionId) {
              try {
                if (await tryStagedReplacement({ sourceConnectionId, sourcePath: source,
                  destinationConnectionId: destinationConnectionId, destinationPath: finalTarget,
                  ...(action === 'combine' ? { folderMode: 'combine' as const } : {}) })) {
                  successCount++;
                  continue;
                }
              } catch (error) {
                if (!isTransferCancellation(error)) recordFileTransferFailure(failures,
                  `Cannot ${action === 'combine' ? 'combine' : 'replace'} "${conflict.name}": ${fileTransferFailureMessage(error)}${isFileTransferNotStarted(error) ? '' : '. Check Transfers for details.'}`);
                continue;
              }
            }
            if (op === 'move' && sourceConnectionId === destinationConnectionId) {
              try {
                sourceReservations.push(acquireFileDestination(sourceConnectionId, source));
              } catch (error) {
                recordFileTransferFailure(failures, `Cannot move "${conflict.name}": ${transferErrorMessage(error)}`);
                continue;
              }
            }
            let replacementTransferId: string | undefined;
            refreshAfterMutation = true;
            const result = await replaceFileWithBackup(target, {
              destinationConnectionId: destinationConnectionId,
              createBackupId: () => crypto.randomUUID(),
              rename: async (from, to) => {
                await window.ipcRenderer.invoke('fs_rename', {
                  connectionId: destinationConnectionId, oldPath: from, newPath: to, autoRename: false,
                });
              },
              write: async (backupPath, reservation) => {
                if (sourceConnectionId === destinationConnectionId) {
                  if (op === 'move') {
                    await window.ipcRenderer.invoke('fs_rename', {
                      connectionId: destinationConnectionId, oldPath: source, newPath: finalTarget, autoRename: false,
                    });
                  } else {
                    await window.ipcRenderer.invoke('fs_copy_batch', {
                      connectionId: destinationConnectionId,
                      operations: [{ from: source, to: finalTarget }]
                    });
                  }
                } else {
                  replacementTransferId = await transferFile({
                    sourceConnectionId,
                    sourcePath: source,
                    destinationConnectionId: destinationConnectionId,
                    destinationPath: finalTarget,
                  }, { recoveryBackupPath: backupPath, reservation });
                }
              },
              remove: async (path) => {
                await window.ipcRenderer.invoke('fs_delete', { connectionId: destinationConnectionId, path });
              },
            });
            if (result.outcome === 'blocked') {
              recordFileTransferFailure(failures, result.error);
              continue;
            }
            if (result.outcome === 'unconfirmed') {
              if (!isTransferCancellation(result.error)) recordFileTransferFailure(failures,
                `Replacement not confirmed for "${conflict.name}": ${transferErrorMessage(result.error)}. Check the destination and possible recovery backup at "${result.backupPath}" before retrying.`);
              continue;
            }
            if (replacementTransferId) {
              useAppStore.getState().setTransferRecovery(replacementTransferId,
                result.outcome === 'replaced-backup-retained'
                  ? { backupPath: result.backupPath, warning: `Could not remove the original backup: ${transferErrorMessage(result.error)}` }
                  : null);
            }
            if (result.outcome === 'replaced-backup-retained') {
              firstWarning ??= `Replaced "${conflict.name}", but could not remove its backup at "${result.backupPath}": ${transferErrorMessage(result.error)}`;
              warningCount++;
            }
            if (op === 'move' && sourceConnectionId === destinationConnectionId) movedSources.push(source);
            successCount++;
            continue;
          }

          let reservation: FileDestinationReservation;
          try {
            reservation = acquireFileDestination(destinationConnectionId, finalTarget);
          } catch (error) {
            recordFileTransferFailure(failures, `Cannot create "${conflict.name}": ${transferErrorMessage(error)}`);
            continue;
          }
          try {
            if (sourceConnectionId === destinationConnectionId) {
              // Same connection
              refreshAfterMutation = true;
              if (op === 'move') {
                const sourceReservation = acquireFileDestination(sourceConnectionId, source);
                try {
                  await window.ipcRenderer.invoke('fs_rename', {
                    connectionId: destinationConnectionId, oldPath: source, newPath: finalTarget,
                    autoRename: false, // We already handled it explicitly.
                  });
                } finally {
                  sourceReservation.release();
                }
              } else {
                // Same-connection copy: use fs_copy_batch with single operation for consistency
                await window.ipcRenderer.invoke('fs_copy_batch', {
                  connectionId: destinationConnectionId,
                  operations: [{ from: source, to: finalTarget }]
                });
              }
            } else if (sourceConnectionId) {
              await transferFile({ sourceConnectionId, sourcePath: source, destinationConnectionId: destinationConnectionId, destinationPath: finalTarget }, { reservation });
            }
            if (op === 'move' && sourceConnectionId === destinationConnectionId) movedSources.push(source);
          } catch (error) {
            recordFileTransferFailure(failures, transferErrorMessage(error));
            continue;
          } finally {
            reservation.release();
          }
        }
        successCount++;
      }

      const displayAction = action === 'combine' ? 'Combined' : action === 'overwrite' ? 'Overwritten' : (action === 'rename' ? 'Renamed' : 'Skipped');
      if (successCount > 0) useAppStore.getState().setLastAction(`${displayAction} ${successCount} item(s)${copiesOnly ? '; source files are kept' : ''}`, 'info');

    } catch (e: any) {
      recordFileTransferFailure(failures, e);
    } finally {
      const failure = fileTransferBatchFailure(failures);
      if (failure) showToast('error', firstWarning ? `${failure} ${firstWarning}` : failure);
      else if (firstWarning) showToast('warning', `${firstWarning}${warningCount > 1 ? ` (${warningCount} backups need attention.)` : ''}`);
      sourceReservations.forEach(reservation => reservation.release());
      if (movedSources.length > 0) {
        useAppStore.setState(state => {
          const next = acknowledgeMovedClipboard(state.clipboard, clipboardAtStart, destinationConnectionId, movedSources);
          return next === state.clipboard ? state : { clipboard: next };
        });
      }
      // Refresh each instance's live location, never navigate back to a captured path.
      if (refreshAfterMutation) void useAppStore.getState().refreshConnectionFiles(destinationConnectionId);
    }
  };


  const initHomeDirectory = useCallback(async () => {
    if (!activeConnectionId || !isConnected) return;

    const store = useAppStore.getState();
    const connection = store.connections.find((item) => item.id === activeConnectionId);
    const picked = pickFilesHomePath({ homePath: connection?.homePath });
    // connect() stores `/` before SFTP cwd; wait for fs_cwd. A confirmed
    // fs_cwd of `/` (root home) is listable.
    const fromPick = picked && picked !== '/' ? picked : '';
    const listingIsPlaceholder = isUnresolvedFilesPath(currentPath) && files.length === 0;

    if (listingIsPlaceholder) {
      try {
        const cwd = fromPick || await window.ipcRenderer.invoke('fs_cwd', {
          connectionId: activeConnectionId,
        });
        const path = typeof cwd === 'string' ? cwd.trim() : '';
        if (!path || isUnconfirmedHomeToken(path)) return;
        loadFiles(activeConnectionId, path);

        const next = useAppStore.getState();
        const termId = next.activeTerminalIds[activeConnectionId]
          ?? next.terminals[activeConnectionId]?.[0]?.id;
        const t = termId
          ? next.terminals[activeConnectionId]?.find(tab => tab.id === termId)
          : undefined;
        if (t && !t.initialPath && !t.lastKnownCwd && !t.isSynced) {
          next.setTerminalInitialPath(activeConnectionId, t.id, path);
          next.setTerminalCwd(activeConnectionId, t.id, path);
        }
      } catch (error: any) {
        if (error.message?.includes('Connection not found')) {
          useAppStore.getState().disconnect(activeConnectionId);
          return;
        }
        console.error('Failed to get home dir:', error);
        if (fromPick) loadFiles(activeConnectionId, fromPick);
      }
    } else if (files.length === 0) {
      loadFiles(activeConnectionId, currentPath);
    }
  }, [activeConnectionId, isConnected, currentPath, files.length, filesOpenHint, loadFiles]);

  const handleReconnect = useCallback(async () => {
    if (!activeConnectionId || isLocal) return;
    try {
      await connect(activeConnectionId);
      const reconnected = useAppStore.getState().connections.find((c) => c.id === activeConnectionId) as (Connection & { error?: string }) | undefined;
      if (reconnected?.status === 'connected') {
        const listingIsPlaceholder = isUnresolvedFilesPath(currentPath) && files.length === 0;
        let nextPath = listingIsPlaceholder ? '' : currentPath;
        if (!nextPath) {
          try {
            const cwd = await window.ipcRenderer.invoke('fs_cwd', { connectionId: activeConnectionId });
            if (typeof cwd === 'string' && cwd.trim() && !isUnconfirmedHomeToken(cwd)) {
              nextPath = cwd.trim();
            }
          } catch {
            // Keep empty; listing `/` as a silent fallback hides the real home.
          }
        }
        if (nextPath) await loadFiles(activeConnectionId, nextPath);
        return;
      }
      showToast('error', reconnected?.error || 'Failed to reconnect');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      showToast('error', `Failed to reconnect: ${message}`);
    }
  }, [activeConnectionId, connect, currentPath, files.length, isLocal, loadFiles, showToast]);

  useEffect(() => {
    if (activeConnectionId && isConnected) {
      initHomeDirectory();
    }
  }, [activeConnectionId, isConnected, initHomeDirectory]);



  const handleOpenFile = useCallback(async (file: FileEntry, providerOverride?: string) => {
    if (!activeConnectionId) return false;
    if (actionBlocked('read', file.path)) return false;
    if (exceedsEditorReadLimit(file.size)) {
      showToast('error', EDITOR_READ_LIMIT_MESSAGE);
      return false;
    }
    const sourceConnectionId = activeConnectionId;
    const requestId = ++editorReadRequestRef.current;
    setIsFileLoading(true);
    try {
      const fullPath = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;
      const content = await window.ipcRenderer.invoke('fs_read_file', {
        connectionId: sourceConnectionId,
        path: fullPath,
        maxBytes: MAX_EDITOR_FILE_BYTES,
      });
      if (!isCurrentEditorRead(sourceConnectionId, editorConnectionRef.current, requestId, editorReadRequestRef.current)) return false;
      const target = { connectionId: sourceConnectionId, path: fullPath };
      editorTargetRef.current = target;
      setEditorProviderOverride(providerOverride ?? null);
      setEditorContent(content);
      setEditingFileTarget(target);
      setEditingFile(file);
      return true;
    } catch (error: any) {
      if (!isCurrentEditorRead(sourceConnectionId, editorConnectionRef.current, requestId, editorReadRequestRef.current)) return false;
      if (!handleConnectionError(sourceConnectionId, error)) {
        showToast('error', isEditorReadLimitError(error)
          ? EDITOR_READ_LIMIT_MESSAGE
          : `Failed to open file: ${error.message || String(error)}`);
      }
      return false;
    } finally {
      if (requestId === editorReadRequestRef.current) setIsFileLoading(false);
    }
  }, [activeConnectionId, currentPath, handleConnectionError, showToast, actionBlocked]);

  const handleOpenFileWithProvider = useCallback(async (file: FileEntry, providerId: string) => {
    if (!await handleOpenFile(file, providerId)) return;
    const providerLabel = editorProviderOptions.find((option) => option.value === providerId)?.label ?? providerId;
    showToast('info', `Opening ${file.name} with ${providerLabel}`);
  }, [editorProviderOptions, handleOpenFile, showToast]);

  const handleNavigate = useCallback((pathOrName: string) => {
    if (!activeConnectionId) return;

    if (pathOrName === '..') {
      useAppStore.getState().navigateUp(activeConnectionId, instanceId);
      return;
    }

    const isPath = pathOrName.startsWith('/');

    if (!isPath) {
      const entry = files.find((f) => f.name === pathOrName);
      if (entry && entry.type === '-') {
        void handleOpenFile(entry);
        return;
      }
    }

    const newPath = isPath
      ? pathOrName
      : (currentPath === '/' ? `/${pathOrName}` : `${currentPath}/${pathOrName}`);
    loadFiles(activeConnectionId, newPath);
  }, [activeConnectionId, currentPath, files, handleOpenFile, loadFiles]);

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
    const target = editingFileTarget;
    if (!editingFile || !target || editorTargetRef.current !== target) {
      throw new Error('The file or its connection is no longer available');
    }
    let reservation: FileDestinationReservation | undefined;
    try {
      reservation = acquireFileDestination(target.connectionId, target.path);
      await window.ipcRenderer.invoke('fs_write_file', {
        connectionId: target.connectionId,
        path: target.path,
        content,
      });
      if (editorTargetRef.current === target) {
        setEditorContent(content);
      }
    } catch (error: any) {
      // The editor owns save feedback; Files only updates connection state.
      if (editorTargetRef.current === target) handleConnectionError(target.connectionId, error, true);
      throw error;
    } finally {
      reservation?.release();
    }
  }, [editingFile, editingFileTarget, handleConnectionError]);

  const handleContextMenu = useCallback((e: React.MouseEvent, file?: FileEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, file: file || null });
    selectContextFile(file);
  }, [selectContextFile]);
  const handleKeyboardContextMenu = useCallback((position: { x: number; y: number }, file?: FileEntry) => {
    setContextMenu({ ...position, file: file ?? null, keyboard: true });
    selectContextFile(file);
  }, [selectContextFile]);

  const showHiddenFiles = settings.fileManager.showHiddenFiles;
  const loadBreadcrumbFolders = useCallback(async (path: string) => {
    if (!activeConnectionId || !isConnected) throw new Error('Files connection unavailable');
    const entries: FileEntry[] = await window.ipcRenderer.invoke('fs_list', { connectionId: activeConnectionId, path });
    return fileFolderOptions(entries, path, showHiddenFiles);
  }, [activeConnectionId, isConnected, showHiddenFiles]);
  const folderFiles = useMemo(() => showHiddenFiles ? files : files.filter(file => !file.name.startsWith('.')), [files, showHiddenFiles]);
  const filteredFiles = useMemo(
    () => folderFiles.filter((f) => {
      if (!fileMatchesQuery(f, searchTerm)) return false;
      if (!fileMatchesSearchType(f, typeFilter)) return false;
      return true;
    }),
    [folderFiles, searchTerm, typeFilter],
  );
  const paintedFiles = useMemo(
    () => sortFileEntries(filteredFiles, sortColumn, sortDirection, settings.fileManager.sortFoldersFirst !== false),
    [filteredFiles, sortColumn, sortDirection, settings.fileManager.sortFoldersFirst],
  );
  const selectionSummary = useMemo(() => fileSelectionSummary(files, selectedFiles), [files, selectedFiles]);
  const handleSort = useCallback((column: FileSortColumn) => {
    if (column === sortColumn) {
      setSortDirection((dir) => (dir === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortColumn(column);
    setSortDirection(FILE_LIST_SORT_INITIAL[column]);
  }, [sortColumn]);
  const applySort = useCallback((column: FileSortColumn, direction: FileSortDirection) => {
    setSortColumn(column);
    setSortDirection(direction);
  }, []);

  // --- Action Handlers (Create, Rename, Upload, Delete, Download) ---

  const handleCreateFolder = async () => {
    const trimmedName = newFolderName.trim();
    if (!trimmedName || !activeConnectionId) return;
    if (actionBlocked('createFolder')) return;
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
    if (actionBlocked('createFile')) return;
    if (trimmedName.includes('/') || trimmedName.includes('\\') || trimmedName === '.' || trimmedName === '..') {
      showToast('error', 'Invalid file name: Contains invalid characters');
      return;
    }
    // Check for local collision
    if (files.some(f => f.name === trimmedName)) {
      showToast('error', `A file or folder named "${trimmedName}" already exists.`);
      return;
    }
    let reservation: FileDestinationReservation | undefined;
    try {
      const fullPath = currentPath === '/' ? `/${trimmedName}` : `${currentPath}/${trimmedName}`;
      reservation = acquireFileDestination(activeConnectionId, fullPath);
      await window.ipcRenderer.invoke('fs_touch', { connectionId: activeConnectionId, path: fullPath });
      refreshFiles(activeConnectionId);
      setIsNewFileModalOpen(false);
      setNewFileName('');
    } catch (error: any) {
      if (handleConnectionError(activeConnectionId, error)) return;
      showToast('error', `Failed to create file: ${error.message || String(error)}`);
    } finally {
      reservation?.release();
    }
  };


  const handleRename = async () => {
    const trimmedName = renameNewName.trim();
    if (!trimmedName || !activeConnectionId) return;
    if (actionBlocked('rename', files.find(file => file.name === renameOldName)?.path)) return;
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

  const openRenameModal = useCallback((filename: string) => {
    const file = files.find(file => file.name === filename);
    if (!file || actionBlocked('rename', file.path)) return;
    setRenameOldName(filename);
    setRenameNewName(filename);
    setIsRenameModalOpen(true);
  }, [files, actionBlocked]);

  // Move performUpload up to be stable and reusable
  // (Done above)

  const inferredHome = inferHomePath(connection?.homePath, currentPath);
  const [heldHome, setHeldHome] = useState<{ connectionId: string; path: string } | null>(null);
  const activeHomeIdRef = useRef(activeConnectionId);
  useEffect(() => {
    activeHomeIdRef.current = activeConnectionId;
  }, [activeConnectionId]);
  useEffect(() => {
    if (!activeConnectionId) {
      setHeldHome(null);
      return;
    }
    if (inferredHome) {
      setHeldHome({ connectionId: activeConnectionId, path: inferredHome });
      return;
    }
    setHeldHome((prev) => (prev?.connectionId === activeConnectionId ? prev : null));
  }, [activeConnectionId, inferredHome]);
  useEffect(() => {
    if (!isLocal || !activeConnectionId || inferredHome) return;
    const connId = activeConnectionId;
    let cancelled = false;
    void window.ipcRenderer.invoke('fs_cwd', { connectionId: 'local' }).then((cwd: unknown) => {
      if (cancelled || connId !== activeHomeIdRef.current) return;
      const path = typeof cwd === 'string' ? inferHomePath(cwd, cwd) : '';
      if (!path) return;
      setHeldHome((prev) => (
        prev?.connectionId === connId && prev.path ? prev : { connectionId: connId, path }
      ));
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeConnectionId, inferredHome, isLocal]);
  const homePath = inferredHome
    || (heldHome?.connectionId === activeConnectionId ? heldHome.path : '');
  const osName = isLocal
    ? (typeof navigator !== 'undefined' && /win/i.test(navigator.platform) ? 'Windows' : 'Operating System')
    : 'Operating System';
  const bookmarks = settings.fileManager.bookmarksByConnection?.[activeConnectionId || ''] ?? EMPTY_PATHS;
  const isBookmarked = Boolean(currentPath && bookmarks.some((path) => isFilePathEqual(path, currentPath)));
  const gridZoom = clampFileGridZoom(settings.fileManager.gridZoom ?? 1);
  const listZoom = clampFileListZoom(settings.fileManager.listZoom ?? 0);
  const canZoomIn = viewMode === 'grid' ? gridZoom < FILE_GRID_ZOOM.length - 1 : listZoom < FILE_LIST_ZOOM.length - 1;
  const canZoomOut = viewMode === 'grid' ? gridZoom > 0 : listZoom > 0;
  const pathLabel = (path: string) => filePathLeafLabel(path, { homePath, osName });
  const backEntries = useMemo(() => {
    const entries = [];
    for (let i = activeHistoryIndex - 1; i >= 0; i--) {
      entries.push({ label: pathLabel(activeHistory[i]), path: activeHistory[i], index: i });
    }
    return entries;
  }, [activeHistory, activeHistoryIndex, homePath, osName]);
  const forwardEntries = useMemo(() => {
    const entries = [];
    for (let i = activeHistoryIndex + 1; i < activeHistory.length; i++) {
      entries.push({ label: pathLabel(activeHistory[i]), path: activeHistory[i], index: i });
    }
    return entries;
  }, [activeHistory, activeHistoryIndex, homePath, osName]);

  const writeBookmarks = useCallback((next: string[]) => {
    if (!activeConnectionId) return;
    void updateFileManagerSettings({
      bookmarksByConnection: {
        ...(useAppStore.getState().settings.fileManager.bookmarksByConnection || {}),
        [activeConnectionId]: next,
      },
    });
  }, [activeConnectionId, updateFileManagerSettings]);

  const pinFolder = useCallback((path: string) => {
    if (!activeConnectionId) return;
    const target = normalizeFilePath(path);
    if (!target) return;
    const current = (useAppStore.getState().settings.fileManager.bookmarksByConnection?.[activeConnectionId] ?? [])
      .map(normalizeFilePath);
    if (current.some((item) => isFilePathEqual(item, target))) return;
    writeBookmarks([...current, target]);
  }, [activeConnectionId, writeBookmarks]);

  const toggleBookmarkAt = useCallback((path: string) => {
    if (!activeConnectionId) return;
    const target = normalizeFilePath(path);
    if (!target) return;
    const current = (useAppStore.getState().settings.fileManager.bookmarksByConnection?.[activeConnectionId] ?? [])
      .map(normalizeFilePath);
    const next = current.some((item) => isFilePathEqual(item, target))
      ? current.filter((item) => !isFilePathEqual(item, target))
      : [...current, target];
    writeBookmarks(next);
  }, [activeConnectionId, writeBookmarks]);

  const toggleBookmark = useCallback(() => {
    if (!currentPath) return;
    toggleBookmarkAt(currentPath);
  }, [currentPath, toggleBookmarkAt]);

  const pinDroppedFolders = useCallback((payload: { connectionId?: string; paths: string[] }) => {
    if (payload.connectionId && activeConnectionId && payload.connectionId !== activeConnectionId) {
      return;
    }
    const folders = payload.paths.filter((path) => {
      const name = path.split(/[\\/]/).filter(Boolean).pop() || '';
      const entry = files.find((file) => file.name === name || isFilePathEqual(file.path, path));
      return entry?.type === 'd';
    });
    folders.forEach((path) => pinFolder(path));
  }, [activeConnectionId, files, pinFolder]);

  const handleCopyLocation = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(currentPath);
    } catch {
      showToast('error', 'Could not copy location');
    }
  }, [currentPath, showToast]);

  const navigateToPath = useCallback((path: string) => {
    if (!activeConnectionId) return;
    void loadFiles(activeConnectionId, path);
  }, [activeConnectionId, loadFiles]);

  const handleRefresh = useCallback(() => {
    if (!activeConnectionId) return;
    actionAccess.refresh();
    void refreshFiles(activeConnectionId);
  }, [activeConnectionId, refreshFiles, actionAccess.refresh]);

  const handleToggleSearch = useCallback((open: boolean) => {
    if (!open) {
      setSearchTerm('');
      setTypeFilter('all');
    }
    setIsSearchOpen(open);
  }, []);

  const handleTogglePlaces = useCallback(() => {
    if (isNarrow) { setPlacesOverlayOpen(open => !open); return; }
    void updateFileManagerSettings({ placesCollapsed: !placesCollapsed });
  }, [isNarrow, placesCollapsed, updateFileManagerSettings]);

  useEffect(() => {
    if (!isLocal) {
      setVolumes([]);
      return;
    }
    if (!showPlaces) return;
    let cancelled = false;
    void loadLocalFileVolumes().then((rows) => {
      if (!cancelled) setVolumes(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [isLocal, showPlaces]);

  const handleBack = useCallback(() => {
    if (activeConnectionId) navigateBack(activeConnectionId);
  }, [activeConnectionId, navigateBack]);

  const handleForward = useCallback(() => {
    if (activeConnectionId) navigateForward(activeConnectionId);
  }, [activeConnectionId, navigateForward]);

  const handleHistoryJump = useCallback((index: number) => {
    if (activeConnectionId) navigateHistoryTo(activeConnectionId, index);
  }, [activeConnectionId, navigateHistoryTo]);

  const handleToggleHidden = useCallback(() => {
    const hidden = useAppStore.getState().settings.fileManager.showHiddenFiles;
    void updateFileManagerSettings({ showHiddenFiles: !hidden });
  }, [updateFileManagerSettings]);

  const handleZoomIn = useCallback(() => {
    const fm = useAppStore.getState().settings.fileManager;
    if (viewMode === 'grid') void updateFileManagerSettings({ gridZoom: clampFileGridZoom((fm.gridZoom ?? 1) + 1) });
    else void updateFileManagerSettings({ listZoom: clampFileListZoom((fm.listZoom ?? 0) + 1) });
  }, [viewMode, updateFileManagerSettings]);

  const handleZoomOut = useCallback(() => {
    const fm = useAppStore.getState().settings.fileManager;
    if (viewMode === 'grid') void updateFileManagerSettings({ gridZoom: clampFileGridZoom((fm.gridZoom ?? 1) - 1) });
    else void updateFileManagerSettings({ listZoom: clampFileListZoom((fm.listZoom ?? 0) - 1) });
  }, [viewMode, updateFileManagerSettings]);

  const handleSelectAllFiles = useCallback(() => {
    handleSelectAll(paintedFiles.map((f) => f.name));
  }, [handleSelectAll, paintedFiles]);

  const handleOpenProperties = useCallback(() => {
    if (selectedFiles.length === 0 && focusedFile) setSelectedFiles([focusedFile]);
    setIsPropertiesOpen(true);
  }, [focusedFile, selectedFiles.length]);

  const handleOpenTerminalChrome = useCallback(() => {
    if (!activeConnectionId) return;
    void openTerminalHere(activeConnectionId, currentPath);
  }, [activeConnectionId, currentPath]);

  const handleNewFolder = useCallback(() => { if (!actionBlocked('createFolder')) setIsNewFolderModalOpen(true); }, [actionBlocked]);
  const handleNewFile = useCallback(() => { if (!actionBlocked('createFile')) setIsNewFileModalOpen(true); }, [actionBlocked]);

  const handleRemoveBookmark = useCallback((path: string) => {
    if (!activeConnectionId) return;
    const target = normalizeFilePath(path);
    const current = useAppStore.getState().settings.fileManager.bookmarksByConnection?.[activeConnectionId] ?? [];
    void updateFileManagerSettings({
      bookmarksByConnection: {
        ...(useAppStore.getState().settings.fileManager.bookmarksByConnection || {}),
        [activeConnectionId]: current.filter((item) => !isFilePathEqual(item, target)).map(normalizeFilePath),
      },
    });
  }, [activeConnectionId, updateFileManagerSettings]);

  const handleDownload = async () => {
    if (selectedFiles.length === 0 || !activeConnectionId) return;
    if (actionBlocked('read')) return;
    try {
      const preferredDownloadDir = settings.fileManager.defaultDownloadPath?.trim();
      const { filePaths, canceled } = await window.ipcRenderer.invoke('dialog:openDirectory', {
        defaultPath: preferredDownloadDir || undefined,
      });
      if (canceled || filePaths.length === 0) return;
      const targetDir = filePaths[0];
      if (targetDir && targetDir !== preferredDownloadDir) {
        try {
          await updateFileManagerSettings({ defaultDownloadPath: targetDir });
        } catch (error: unknown) {
          console.error('Failed to persist download directory', error);
          const message = error instanceof Error ? error.message : String(error);
          showToast('warning', `Download path was used, but could not be saved: ${message}`);
        }
      }

      // We process download locally in component for now as it involves local FS dialog
      setIsProcessing(true);

      void runFileTransferBatch([...selectedFiles], fileName => {
        const remotePath = currentPath === '/' ? `/${fileName}` : `${currentPath}/${fileName}`;
        const localPath = targetDir.includes('\\') ? `${targetDir}\\${fileName}` : `${targetDir}/${fileName}`;

        return transferFile({
          sourceConnectionId: activeConnectionId,
          sourcePath: remotePath,
          destinationConnectionId: 'local',
          destinationPath: localPath,
        });
      }).then(result => {
        const failure = fileTransferBatchFailure(result);
        if (failure) showToast('error', `Download failed: ${failure}`);
      });
      setIsProcessing(false);
    } catch (error: any) {
      setIsProcessing(false);
      if (handleConnectionError(activeConnectionId, error)) return;
      showToast('error', `Download failed: ${error.message || String(error)}`);
    }
  };

  const handleDownloadAsZip = async () => {
    if (selectedFiles.length === 0 || !activeConnectionId) return;
    if (actionBlocked('read')) return;
    if (isZipping) return; // Prevent double-click opening two dialogs
    if (activeConnectionId === 'local') {
      showToast('error', 'Download as Archive is only available for remote server connections');
      return;
    }

    setIsZipping(true);
    try {
      const date = new Date().toISOString().slice(0, 10);
      const defaultName = `zync_download_${date}.tar.gz`;
      const preferredDownloadDir = settings.fileManager.defaultDownloadPath?.trim();
      const defaultPath = preferredDownloadDir
        ? (preferredDownloadDir.includes('\\')
          ? `${preferredDownloadDir}\\${defaultName}`
          : `${preferredDownloadDir}/${defaultName}`)
        : defaultName;
      const { filePath, canceled } = await window.ipcRenderer.invoke('dialog:saveFile', {
        defaultPath,
        filters: [{ name: 'Tar Archive', extensions: ['tar.gz', 'tgz'] }],
      });
      if (canceled || !filePath) return;
      const slashIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
      let selectedDir = slashIndex >= 0
        ? (filePath.slice(0, slashIndex) || (slashIndex === 0 ? '/' : ''))
        : '';
      if (/^[A-Za-z]:$/.test(selectedDir)) {
        selectedDir = `${selectedDir}\\`;
      }
      if (selectedDir && selectedDir !== preferredDownloadDir) {
        try {
          await updateFileManagerSettings({ defaultDownloadPath: selectedDir });
        } catch (error: unknown) {
          console.error('Failed to persist archive download directory', error);
          const message = error instanceof Error ? error.message : String(error);
          showToast('warning', `Archive path was used, but could not be saved: ${message}`);
        }
      }

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
      let reservation: FileDestinationReservation;
      try {
        reservation = acquireFileDestination('local', filePath);
      } catch (error) {
        failTransfer(transferId, transferErrorMessage(error));
        throw error;
      }

      // The detached promise holds its destination through native finalization.
      void (async () => {
        try {
          await window.ipcRenderer.invoke('sftp:downloadAsZip', {
            id: activeConnectionId, remotePaths, localPath: filePath, transferId, waitForCompletion: true,
          });
          useAppStore.getState().completeTransfer(transferId);
        } catch (error: unknown) {
          if (isTransferCancellation(error)) useAppStore.getState().cancelTransfer(transferId);
          else failTransfer(transferId, transferErrorMessage(error));
        } finally {
          reservation.release();
        }
      })();
    } catch (error: any) {
      if (handleConnectionError(activeConnectionId, error)) return;
      showToast('error', `Archive download failed: ${error.message || String(error)}`);
    } finally {
      setIsZipping(false);
    }
  };

  const executeDelete = useCallback(async () => {
    if (selectedFiles.length === 0 || !activeConnectionId) return;
    if (actionBlocked('delete')) return;

    // Native listing paths are identities; rebuilding them mixes Windows separators.
    const selectedNames = new Set(selectedFiles);
    const paths = files.filter(file => selectedNames.has(file.name)).map(file => file.path);
    if (paths.length === 0) return;

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
  }, [activeConnectionId, files, deleteEntries, handleConnectionError, selectedFiles, showToast, actionBlocked]);

  const handleDelete = useCallback(() => {
    if (selectedFiles.length === 0 || !activeConnectionId) return;
    if (actionBlocked('delete')) return;

    if (settings.fileManager.confirmDelete) {
      setIsDeleteModalOpen(true);
    } else {
      void executeDelete();
    }
  }, [activeConnectionId, executeDelete, selectedFiles, settings.fileManager.confirmDelete, actionBlocked]);

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
  const contextMenuItems: ContextMenuItem[] = [];

  if (contextMenu) {
    if (contextMenu.file) {
      // File Context Menu
      contextMenuItems.push(
        {
          label: 'Download',
          icon: <Download size={14} />,
          action: handleDownload,
          disabled: actionBlocked('read'),
        },
        ...(contextMenu.file.type === '-' ? [{
          label: 'Open With…',
          icon: <FilePlus size={14} />,
          disabled: actionBlocked('read', contextMenu.file.path),
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
          disabled: actionBlocked('read'),
        },
        { separator: true },
        {
          label: 'Copy',
          icon: <Copy size={14} />,
          action: () => handleCopy(false),
          disabled: Boolean(copyUnavailable),
          disabledReason: copyUnavailable,
        },
        {
          label: 'Cut',
          icon: <Scissors size={14} />,
          action: () => handleCopy(true),
          disabled: Boolean(cutUnavailable),
          disabledReason: cutUnavailable,
        },
        {
          label: 'Copy to Server...',
          icon: <Server size={14} />,
          disabled: actionBlocked('read'),
          action: () => {
            if (!contextMenu?.file || !activeConnectionId) return;
            if (actionBlocked('read')) return;

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
        { separator: true },
        ...(activeConnectionId
          ? terminalHereMenuItems(
              activeConnectionId,
              currentPath,
              contextMenu.file,
              () => setContextMenu(null),
              instanceId,
            )
          : []),
        ...(contextMenu.file.type === 'd' ? [{
          separator: true as const,
        }, {
          label: bookmarks.some((path) => isFilePathEqual(path, contextMenu.file?.path || ''))
            ? 'Unpin'
            : 'Pin to Pins',
          icon: <Pin size={14} />,
          action: () => {
            const path = contextMenu.file?.path;
            if (path) toggleBookmarkAt(path);
          },
        }] : []),
        { separator: true },
        {
          label: 'Rename',
          icon: <FolderInput size={14} />,
          action: () => openRenameModal(contextMenu.file?.name as string),
          disabled: actionBlocked('rename', contextMenu.file.path),
        },
        {
          label: 'Delete',
          icon: <Trash2 size={14} />,
          variant: 'danger',
          action: handleDelete,
          disabled: actionBlocked('delete'),
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
        disabled: !clipboard || actionBlocked('receive'),
      });

      contextMenuItems.push(
        {
          label: 'Upload Files',
          icon: <Upload size={14} />,
          action: handleUpload,
          disabled: actionBlocked('createFile'),
        },
        { separator: true },
        ...(activeConnectionId
          ? terminalHereMenuItems(activeConnectionId, currentPath, undefined, () => setContextMenu(null), instanceId)
          : []),
        { separator: true },
        {
          label: isBookmarked ? 'Unpin this folder' : 'Pin this folder',
          icon: <Pin size={14} />,
          action: toggleBookmark,
        },
        { separator: true },
        {
          label: 'New...',
          icon: <Plus size={14} />,
          children: [
            {
              label: 'New File',
              icon: <FilePlus size={14} />,
              action: handleNewFile,
              disabled: actionBlocked('createFile'),
            },
            {
              label: 'New Folder',
              icon: <FolderInput size={14} />,
              action: handleNewFolder,
              disabled: actionBlocked('createFolder'),
            },
          ]
        },
        {
          label: 'Refresh',
          icon: <RotateCw size={14} />,
          action: handleRefresh,
        },
      );
    }
  }



  useFileKeyboard({
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
    setIsSearchOpen: handleToggleSearch,
    setSearchTerm,
    isPropertiesOpen,
    setIsPropertiesOpen,
    isNewFolderModalOpen,
    isNewFileModalOpen,
    isRenameModalOpen,
    isCopyModalOpen,
    editingFile,
    activeConnectionId: activeConnectionId ?? undefined,
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
  });


  // Focus when the files panel is shown (dispatched from TabContent — avoids isVisible prop churn).
  useEffect(() => {
    const handlePanelShow = () => {
      if (!filesFocusOwnerRef.current) return;
      if (isFileManagerPanelShown(containerRef.current)) {
        focusOnActivation();
      }
    };
    window.addEventListener('zync:files-panel-show', handlePanelShow);
    return () => window.removeEventListener('zync:files-panel-show', handlePanelShow);
  }, [isFilesSurfaceActive, focusOnActivation]);

  useEffect(() => {
    // Focus-only changes must not steal an explicitly clicked toolbar/input target.
    if (surface !== 'pane' || !isFilesSurfaceActive || !filesFocusOwnerRef.current) return;
    focusOnActivation();
  }, [surface, isFilesSurfaceActive, focusOnActivation]);

  useEffect(() => {
    if (!editingFile) return;
    markEditorOverlayOpen();
    return () => {
      clearEditorOverlayOpen();
    };
  }, [editingFile]);

  const propertiesEntries = useMemo(() => {
    const names = selectedFiles.length > 0 ? selectedFiles : (focusedFile ? [focusedFile] : []);
    return names
      .map((name) => files.find((file) => file.name === name))
      .filter((file): file is FileEntry => Boolean(file));
  }, [files, focusedFile, selectedFiles]);
  const inspectedFolder = propertiesEntries.length === 1 && propertiesEntries[0].type === 'd' ? propertiesEntries[0].path : undefined;
  const folderSizes = useFolderSizes(activeConnectionId ?? undefined, currentPath, files, connection,
    isPropertiesOpen && isFilesSurfaceActive && isConnected && !loading, inspectedFolder);
  const [heldPropertiesFiles, setHeldPropertiesFiles] = useState<FileEntry[]>([]);
  useEffect(() => {
    if (!isPropertiesOpen) return;
    setHeldPropertiesFiles(propertiesEntries);
  }, [isPropertiesOpen, propertiesEntries]);
  const inspectorFiles = isPropertiesOpen ? propertiesEntries : heldPropertiesFiles;
  const permissionTarget = activeConnectionId && propertiesEntries.length === 1
    ? { connectionId: activeConnectionId, path: propertiesEntries[0].path } : null;
  const permissionEditor = useFilePermissionEditor(permissionTarget,
    isPropertiesOpen && isFilesSurfaceActive && isConnected,
    useAppStore.getState().refreshConnectionFiles);
  // Preserve the existing sidebar memo boundary while unrelated size results arrive.
  const placesPlatform = typeof window !== 'undefined' ? window.electronUtils?.platform : undefined;
  const placesContent = useMemo(() => <FilePlacesSidebar
    homePath={homePath} currentPath={currentPath} recents={recentPaths} bookmarks={bookmarks}
    volumes={isLocal ? volumes : []} platform={placesPlatform}
    recentEnabled={settings.fileManager.placesRecentEnabled !== false} recentLimit={clampFileRecentLimit(settings.fileManager.placesRecentLimit)}
    onNavigate={path => { setPlacesOverlayOpen(false); navigateToPath(path); }}
    onAddBookmark={toggleBookmark} onRemoveBookmark={handleRemoveBookmark} onPinPaths={pinDroppedFolders}
    onRecentEnabledChange={enabled => { void updateFileManagerSettings({ placesRecentEnabled: enabled }); }}
    onRecentLimitChange={limit => { void updateFileManagerSettings({ placesRecentLimit: clampFileRecentLimit(limit) }); }}
    onClearRecent={() => { if (activeConnectionId) clearRecentPaths(activeConnectionId); }}
    showHeader={!isNarrow}
  />, [homePath, currentPath, recentPaths, bookmarks, isLocal, volumes, placesPlatform, settings.fileManager.placesRecentEnabled,
    settings.fileManager.placesRecentLimit, navigateToPath, toggleBookmark, handleRemoveBookmark, pinDroppedFolders,
    updateFileManagerSettings, activeConnectionId, clearRecentPaths, isNarrow]);

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className={`files-manager flex-1 min-h-0 min-w-0 flex flex-col h-full bg-app-bg relative outline-none focus-within:ring-0 ${isTauriDraggingOver ? 'ring-2 ring-app-accent ring-inset' : ''}`}
      data-files-quiet-focus={activationFocus.quiet || undefined}
      style={selectionColors}
      onFocusCapture={activationFocus.onFocusCapture}
      onKeyDownCapture={activationFocus.onKeyDownCapture}
      onPointerDownCapture={activationFocus.onPointerDownCapture}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onMouseDown={(e) => {
        if (e.button === 3) {
          e.preventDefault();
          if (activeConnectionId) navigateBack(activeConnectionId);
        }
        if (e.button === 4) {
          e.preventDefault();
          if (activeConnectionId) navigateForward(activeConnectionId);
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
        loadFolders={loadBreadcrumbFolders}
        currentPath={currentPath}
        homePath={homePath}
        osName={osName}
        onNavigate={navigateToPath}
        onUpload={handleUpload}
        onUploadFolder={handleUploadFolder}
        onNewFolder={handleNewFolder}
        onNewFile={handleNewFile}
        createFileDisabled={actionBlocked('createFile')}
        createFolderDisabled={actionBlocked('createFolder')}
        isEditingPath={isEditingPath}
        onTogglePathEdit={setIsEditingPath}
        disabled={!isConnected || isLoading || !currentPath}
        placesCollapsed={!showPlaces}
        onTogglePlaces={handleTogglePlaces}
        onBack={handleBack}
        onForward={handleForward}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        backEntries={backEntries}
        forwardEntries={forwardEntries}
        onHistoryJump={handleHistoryJump}
        connectionId={activeConnectionId}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <FileLayoutSurface>
        {!isNarrow && <FileSideDrawer open={!placesCollapsed} width={FILE_PLACES_WIDTH_PX} side="left">{placesContent}</FileSideDrawer>}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: interactive div */}
      <div className="files-content flex-1 min-h-0 min-w-0 overflow-hidden relative flex flex-col" onClick={() => setContextMenu(null)}>
        <FileContentsHeader
          folderName={filePathLeafLabel(currentPath, { homePath, osName })}
          visibleCount={paintedFiles.length}
          totalCount={folderFiles.length}
          selection={selectionSummary}
          loading={isLoading}
          searchTerm={searchTerm}
          onSearch={setSearchTerm}
          isSearchOpen={isSearchOpen}
          onToggleSearch={handleToggleSearch}
          typeFilter={typeFilter}
          onTypeFilter={setTypeFilter}
          isPropertiesOpen={isPropertiesOpen}
          onProperties={() => isPropertiesOpen ? setIsPropertiesOpen(false) : handleOpenProperties()}
          onRefresh={handleRefresh}
          onCopyLocation={handleCopyLocation}
          onBookmark={toggleBookmark}
          isBookmarked={isBookmarked}
          onOpenTerminal={activeConnectionId ? handleOpenTerminalChrome : undefined}
          onPaste={handlePaste}
          canPaste={Boolean(clipboard) && !actionBlocked('receive')}
          onSelectAll={handleSelectAllFiles}
          onClearSelection={() => { setSelectedFiles([]); listingFocusRef.current?.focus({ preventScroll: true }); }}
          disabled={!isConnected || isLoading || !currentPath}
          view={{ viewMode, onToggleView: setViewMode, showHidden: showHiddenFiles,
            onToggleHidden: handleToggleHidden, onZoomIn: handleZoomIn, onZoomOut: handleZoomOut,
            canZoomIn, canZoomOut, sortColumn, sortDirection, onSort: applySort,
            detailColumns, onToggleColumn: handleToggleColumn }}
        />
        {actionAccess.unavailable && <div className="flex shrink-0 items-center gap-3 border-b border-app-border/30 px-3 py-2">
          <p role="status" className="flex-1 text-xs text-app-muted">Unavailable for this account: {actionAccess.unavailable}. Check again if permissions have changed.</p>
          <Button type="button" size="sm" variant="secondary" onClick={handleRefresh}>Check access again</Button>
        </div>}
        {isConnected && currentError && currentError !== 'DISCONNECTED' && !isLoading && (
          <div className="flex shrink-0 items-center gap-3 border-b border-app-border/30 px-3 py-2">
            <StateMessage variant="error" className="flex-1 text-xs">{currentError}</StateMessage>
            <Button type="button" size="sm" variant="secondary" onClick={handleRefresh}>Retry</Button>
          </div>
        )}
        {(isReconnectPending || currentError === 'DISCONNECTED' || (!isConnected && !isLocal)) ? (
          <TerminalDisconnectedView
            connection={connection}
            isPendingRestore={isPendingRestore}
            activeConnectionId={activeConnectionId || ''}
            surface="files"
            isSurfaceActive={isFilesFocusOwner}
            onReconnect={() => { void handleReconnect(); }}
            onEditHost={
              connection
                ? () => openConnectionModal(connection.id)
                : undefined
            }
            onOpenTerminal={
              activeTabId
                ? () => setTabView(activeTabId, 'terminal')
                : undefined
            }
            onOpenVault={
              connection
                ? () => openVaultTab('local')
                : undefined
            }
          />
        ) : (
          <FileGrid
            focusRevealRequest={focusRevealRequest}
            focusRef={listingFocusRef} onFocusItem={setFocusedFile}
            label={`Files in ${filePathLeafLabel(currentPath, { homePath, osName }) || 'current folder'}`}
            detailColumns={detailColumns} onKeyboardContextMenu={handleKeyboardContextMenu}
            files={paintedFiles}
            selectedFiles={selectedFiles}
            focusedFile={focusedFile || undefined}
            onSelect={handleSelect}
            onSelectMany={handleSelectMany}
            onNavigate={handleNavigate}
            onContextMenu={handleContextMenu}
            viewMode={viewMode}
            isLoading={isLoading}
            connectionId={activeConnectionId || undefined}
            currentPath={currentPath}
            onMove={handleMoveFiles}
            sortColumn={sortColumn}
            sortDirection={sortDirection}
            onSort={handleSort}
            onGridColumnCount={setGridColumnCount}
            gridZoom={gridZoom}
            listZoom={listZoom}
            clickPolicy={settings.fileManager.clickPolicy || 'double'}
            dateTimeFormat={settings.fileManager.dateTimeFormat || 'simple'}
            emptyState={currentError ? { title: 'Folder unavailable', description: 'Use Retry above to reload this folder.' }
              : searchTerm || typeFilter !== 'all' ? { title: 'No matches in this folder', description: 'Try another name or clear the folder filter.',
                onReset: () => { setSearchTerm(''); setTypeFilter('all'); } }
              : files.length > 0 ? { title: 'No visible files', description: 'Hidden files are currently excluded. Use View to show them.' }
              : undefined}
          />
        )}
      </div>
        {propertiesInline && <FileSideDrawer open={isPropertiesOpen} width={FILE_PROPERTIES_WIDTH_PX} side="right">
          <PropertiesPanel
            files={inspectorFiles}
            permissionEditor={permissionEditor}
            folderSizes={folderSizes}
            onClose={() => setIsPropertiesOpen(false)}
            dateTimeFormat={settings.fileManager.dateTimeFormat || 'simple'}
          />
        </FileSideDrawer>}
      </FileLayoutSurface>

      <Modal isOpen={isFilesSurfaceActive && isNarrow && placesOverlayOpen} restoreFocus={isFilesSurfaceActive} onClose={() => setPlacesOverlayOpen(false)} title="Places" width="max-w-sm" contentClassName="p-0">
        <div className="h-[min(65vh,28rem)]">{placesContent}</div>
      </Modal>
      <Modal isOpen={isFilesSurfaceActive && !propertiesInline && isPropertiesOpen} restoreFocus={isFilesSurfaceActive} onClose={() => setIsPropertiesOpen(false)} title="Properties" width="max-w-sm" contentClassName="p-0">
        <PropertiesPanel files={inspectorFiles} onClose={() => setIsPropertiesOpen(false)} showHeader={false}
          folderSizes={folderSizes}
          permissionEditor={permissionEditor}
          dateTimeFormat={settings.fileManager.dateTimeFormat || 'simple'} />
      </Modal>
      </div>

      <FolderSizeDetails state={folderSizes.details} onClose={folderSizes.closeDetails} restoreFocus={isFilesSurfaceActive} />
      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          autoFocus={contextMenu.keyboard}
          onClose={() => {
            if (document.activeElement?.closest('[role="menu"]')) listingFocusRef.current?.focus({ preventScroll: true });
            setContextMenu(null);
          }}
        />
      )}

      {/* Modals */}
      <Modal isOpen={isNewFileModalOpen} onClose={() => setIsNewFileModalOpen(false)} title="New File">
        <div className="space-y-4">
          {actionBlocked('createFile') && <StateMessage variant="status">Creating files is unavailable for this account. Close and check access again if permissions have changed.</StateMessage>}
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
            <Button onClick={handleCreateFile} disabled={actionBlocked('createFile')}>Create</Button>
          </div>
        </div>
      </Modal>


      <Modal isOpen={isNewFolderModalOpen} onClose={() => setIsNewFolderModalOpen(false)} title="New Folder">
        <div className="space-y-4">
          {actionBlocked('createFolder') && <StateMessage variant="status">Creating folders is unavailable for this account. Close and check access again if permissions have changed.</StateMessage>}
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
            <Button onClick={handleCreateFolder} disabled={actionBlocked('createFolder')}>Create</Button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={isRenameModalOpen} onClose={() => setIsRenameModalOpen(false)} title="Rename">
        <div className="space-y-4">
          {actionBlocked('rename', files.find(file => file.name === renameOldName)?.path) && <StateMessage variant="status">Rename is unavailable for this account. Close and check access again if permissions have changed.</StateMessage>}
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
            <Button onClick={handleRename} disabled={actionBlocked('rename', files.find(file => file.name === renameOldName)?.path)}>Rename</Button>
          </div>
        </div>
      </Modal>

      {/* Copy to Server Modal */}
      <CopyToServerModal
        onCopy={(requests, directory) => executeFileOperations(requests.map(request => ({
          source: request.sourcePath, target: request.destinationPath, name: filePathLeafLabel(request.destinationPath),
          sourceConnectionId: request.sourceConnectionId, op: 'copy' as const,
        })), directory, requests[0]?.destinationConnectionId)}
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
      {editingFile && editingFileTarget && (
        <FileEditor
          key={`${editingFileTarget.connectionId}:${editingFileTarget.path}`}
          documentId={`${editingFileTarget.connectionId}:${editingFileTarget.path}`}
          permissionTarget={editingFileTarget}
          filename={editingFile.name}
          initialContent={editorContent}
          preferredProviderId={editorProviderOverride ?? undefined}
          onSave={handleSaveFile}
          onDirtyChange={setEditorDirty}
          onClose={() => {
            editorTargetRef.current = null;
            setEditingFile(null);
            setEditingFileTarget(null);
            setEditorDirty(false);
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
        message={actionBlocked('delete') ? 'Delete is unavailable for this account. Close and check access again if permissions have changed.'
          : `Are you sure you want to delete ${selectedFiles.length} item(s)? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        isLoading={isDeleting}
        confirmDisabled={actionBlocked('delete')}
      />

      {/* Conflict Resolution Modal */}
      <ConflictModal
        isOpen={!!currentConflict}
        onClose={() => {
          clearConflicts();
        }}
        onResolve={resolveConflict}
        fileName={currentConflict?.name || ''}
        destinationPath={currentConflict ? parentFilePath(currentConflict.target) ?? currentConflict.target : currentPath}
        isBatch={pendingConflicts.length > 1}
        isFolder={currentConflict?.sourceKind === 'Directory'}
        canCombine={currentConflict?.canCombine === true}
      />
    </div>
  );
});
