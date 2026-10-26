import {
  ArrowUp,
  FilePlus,
  FolderInput,
  FolderPlus,
  PanelLeft,
  Plus,
  Upload,
} from 'lucide-react';
import { memo, useCallback, useLayoutEffect, useRef } from 'react';
import { cn } from '../../lib/utils';
import { shortcutHint } from '../../features/shortcuts/labels';
import { Tooltip } from '../ui/Tooltip';
import { IconButton } from '../ui/IconButton';
import { useAppStore } from '../../store/useAppStore';
import { FileHistoryControls, type FileHistoryEntry } from './FileHistoryControls';
import { FilePathBar } from './FilePathBar';
import { FileActionMenu } from './FileActionMenu';
import type { FileFolderLoader } from './fileFolderOptions';
import { FilePathEditor, type FilePathRestoreFocus } from './FilePathEditor';
import { isAbsoluteFilePath, parentFilePath } from './filePathNav';

interface FileToolbarProps {
  currentPath: string;
  homePath?: string;
  osName?: string;
  onNavigate: (path: string) => void;
  onUpload: () => void;
  onUploadFolder: () => void;
  onNewFolder: () => void;
  onNewFile: () => void;
  isEditingPath: boolean;
  onTogglePathEdit: (editing: boolean) => void;
  disabled?: boolean;
  createFileDisabled?: boolean;
  createFolderDisabled?: boolean;
  placesCollapsed?: boolean;
  onTogglePlaces?: () => void;
  onBack: () => void;
  onForward: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  backEntries: FileHistoryEntry[];
  forwardEntries: FileHistoryEntry[];
  onHistoryJump: (index: number) => void;
  connectionId?: string | null;
  loadFolders: FileFolderLoader;
}

function FileToolbarInner({
  currentPath,
  homePath,
  osName,
  onNavigate,
  onUpload,
  onUploadFolder,
  onNewFolder,
  onNewFile,
  isEditingPath,
  onTogglePathEdit,
  disabled = false,
  createFileDisabled = false,
  createFolderDisabled = false,
  placesCollapsed = false,
  onTogglePlaces,
  onBack,
  onForward,
  canGoBack,
  canGoForward,
  backEntries,
  forwardEntries,
  onHistoryJump,
  connectionId,
  loadFolders,
}: FileToolbarProps) {
  const compactMode = useAppStore((state) => state.settings.compactMode);
  const upShortcut = useAppStore((state) => shortcutHint('fmUp', state.settings.keybindings ?? {}));
  const parentPath = isAbsoluteFilePath(currentPath) ? parentFilePath(currentPath) : null;
  const barRef = useRef<HTMLDivElement>(null);
  const restorePathFocusRef = useRef<FilePathRestoreFocus>(null);

  useLayoutEffect(() => {
    if (!isEditingPath && restorePathFocusRef.current) {
      const selector = restorePathFocusRef.current === 'edit' ? '[data-file-path-edit]' : '[data-file-path-current]';
      restorePathFocusRef.current = null;
      barRef.current?.querySelector<HTMLButtonElement>(selector)?.focus({ preventScroll: true });
    }
  }, [isEditingPath]);

  const closePathEdit = useCallback((focus: FilePathRestoreFocus) => {
    restorePathFocusRef.current = focus;
    onTogglePathEdit(false);
  }, [onTogglePathEdit]);

  return (
    <div
      ref={barRef}
      className={cn(
        'files-toolbar relative z-30 flex min-w-0 shrink-0 items-center gap-1 border-b border-app-border/40 bg-app-panel/55 px-2',
        compactMode ? 'h-9' : 'h-10',
      )}
    >
      <Tooltip content={placesCollapsed ? 'Show places' : 'Hide places'} position="bottom">
        <IconButton label={placesCollapsed ? 'Show places' : 'Hide places'} icon={<PanelLeft size={14} />}
          aria-expanded={!placesCollapsed} disabled={!onTogglePlaces} onClick={onTogglePlaces} />
      </Tooltip>

      <FileHistoryControls
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onBack={onBack}
        onForward={onForward}
        backEntries={backEntries}
        forwardEntries={forwardEntries}
        onJump={onHistoryJump}
      />

      <Tooltip content={upShortcut ? `Up one folder (${upShortcut})` : 'Up one folder'} position="bottom">
        <IconButton
          label="Up"
          icon={<ArrowUp size={14} />}
          disabled={disabled || !parentPath}
          onClick={() => { if (parentPath) onNavigate(parentPath); }}
        />
      </Tooltip>

      <div className="files-toolbar-path flex h-8 min-w-0 flex-1 items-center overflow-hidden">
        {isEditingPath ? (
          <FilePathEditor currentPath={currentPath} homePath={homePath} connectionId={connectionId}
            loadFolders={loadFolders} toolbarRef={barRef} onNavigate={onNavigate} onClose={closePathEdit} disabled={disabled} />
        ) : (
          <FilePathBar
            currentPath={currentPath}
            homePath={homePath}
            osName={osName}
            onNavigate={onNavigate}
            onEditLocation={() => onTogglePathEdit(true)}
            loadFolders={loadFolders}
            disabled={disabled}
          />
        )}
      </div>

      <FileActionMenu label="New" icon={<Plus size={14} />} disabled={disabled} items={[
        { label: 'New file', icon: <FilePlus size={14} />, action: onNewFile, disabled: createFileDisabled },
        { label: 'New folder', icon: <FolderPlus size={14} />, action: onNewFolder, disabled: createFolderDisabled },
      ]} />
      <FileActionMenu label="Upload" icon={<Upload size={14} />} disabled={disabled} items={[
        { label: 'Upload files', icon: <Upload size={14} />, action: onUpload, disabled: createFileDisabled },
        { label: 'Upload folder', icon: <FolderInput size={14} />, action: onUploadFolder, disabled: createFolderDisabled },
      ]} />
    </div>
  );
}

export const FileToolbar = memo(FileToolbarInner);
