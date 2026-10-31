import { AnimatePresence, motion } from 'framer-motion';
import { Folder } from 'lucide-react';
import type React from 'react';
import {
    type CSSProperties,
    forwardRef,
    memo,
    type RefObject,
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { List, type ListImperativeAPI, useListRef } from 'react-window';

import { setCurrentDragSource } from '../../lib/dragDrop';
import { cn, formatBytes } from '../../lib/utils';
import { useAppStore } from '../../store/useAppStore';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { buildDragData, startInternalDrag, validateAndBuildMoves } from './dragDropUtils';
import { FileEntryIcon } from './FileEntryIcon';
import { FileHoverTip, useFileHoverTip } from './FileHoverTip';
import { FileListHeading } from './FileListHeading';
import { FileName } from './FileName';
import { FileSelectionMark, isFileSelectionMark } from './FileSelectionMark';
import {
    clampFileGridZoom,
    clampFileListZoom,
    FILE_GRID_VIRTUALIZE_AFTER,
    FILE_GRID_ZOOM,
    FILE_LIST_ZOOM,
} from './fileChrome';
import {
    type FileSortColumn,
    type FileSortDirection,
    fileGridColumnPitch,
    fileGridInlineOffset,
    fileGridScrollTarget,
    fileIconGridTemplateColumns,
    formatFileIdentity,
    formatFileListDate,
    formatFileListType,
} from './fileGridLayout';
import {
    type FileDetailColumn,
    type FileListColumnWidths,
    fileListColumns,
    fileListTracks,
    fileListWidth,
    fileOptionId,
} from './fileListPresentation';
import {
    gridNamesInMarquee,
    listNamesInMarquee,
    MARQUEE_DRAG_THRESHOLD_PX,
    type MarqueeRect,
    mergeMarqueeSelection,
    namesBetween,
    namesInDomMarquee,
    normalizeClientRect,
} from './fileMarquee';
import type { FileEntry } from './types';
import { useFileGridViewport } from './useFileGridViewport';

const FileIcon = FileEntryIcon;

/** Native scrollbar gestures must not start a marquee or clear the current selection. */
function isScrollbarPointer(event: {
    target: EventTarget;
    clientX: number;
    clientY: number;
}): boolean {
    if (!(event.target instanceof HTMLElement)) {
        return false;
    }
    const target = event.target;
    const bounds = target.getBoundingClientRect();
    return (
        (target.offsetWidth > target.clientWidth &&
            event.clientX >= bounds.left + target.clientLeft + target.clientWidth) ||
        (target.offsetHeight > target.clientHeight &&
            event.clientY >= bounds.top + target.clientTop + target.clientHeight)
    );
}

// Memoized File Item Component
const FileGridItem = memo(
    forwardRef<
        HTMLDivElement,
        {
            optionId: string;
            optionIndex: number;
            optionCount: number;
            file: FileEntry;
            viewMode: 'grid' | 'list';
            compactMode: boolean;
            isSelected: boolean;
            isFocused: boolean;
            connectionId?: string;
            currentPath?: string;
            getSelectedFiles: () => string[];
            onSelect: (name: string, multi: boolean, range?: boolean) => void;
            onNavigate: (name: string) => void;
            onContextMenu: (e: React.MouseEvent, file?: FileEntry) => void;
            onMove?: (
                moves: { source: string; target: string; sourceConnectionId?: string }[],
            ) => void;
            iconSize?: number;
            clickPolicy?: 'single' | 'double';
            onHoverShow?: (file: FileEntry, el: HTMLElement) => void;
            onHoverHide?: () => void;
        }
    >(
        (
            {
                optionId,
                optionIndex,
                optionCount,
                file,
                viewMode,
                compactMode,
                isSelected,
                isFocused,
                connectionId,
                currentPath,
                getSelectedFiles,
                onSelect,
                onNavigate,
                onContextMenu,
                onMove,
                iconSize,
                clickPolicy = 'double',
                onHoverShow,
                onHoverHide,
            },
            ref,
        ) => {
            const isFolder = file.type === 'd';
            const renderedIconSize =
                iconSize ?? (viewMode === 'grid' ? (compactMode ? 40 : 56) : compactMode ? 16 : 22);

            return (
                <div
                    ref={ref}
                    id={optionId}
                    data-file-name={file.name}
                    role="option"
                    aria-label={`${file.name}, ${formatFileListType(file)}`}
                    aria-selected={isSelected}
                    aria-posinset={optionIndex + 1}
                    aria-setsize={optionCount}
                    data-focused={isFocused || undefined}
                    draggable={connectionId !== undefined}
                    onDragStart={(e: any) => {
                        if (!connectionId || !currentPath) {
                            return;
                        }
                        const selectedFiles = getSelectedFiles();
                        const dragData = buildDragData(
                            file,
                            isSelected,
                            selectedFiles,
                            connectionId,
                            currentPath,
                        );
                        const count =
                            isSelected && selectedFiles.length > 0 ? selectedFiles.length : 1;
                        startInternalDrag(e, dragData, isFolder, count);
                    }}
                    onDragEnd={(e: any) => {
                        setCurrentDragSource(null);
                        if (e.currentTarget instanceof HTMLElement) {
                            e.currentTarget.style.opacity = '1';
                        }
                    }}
                    onDragOver={(e: any) => {
                        if (!isFolder || !onMove) {
                            return;
                        }
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        if (e.currentTarget instanceof HTMLElement) {
                            e.currentTarget.style.outline = '2px dashed var(--color-app-accent)';
                            e.currentTarget.style.outlineOffset = '-2px';
                        }
                    }}
                    onDragLeave={(e: any) => {
                        if (!isFolder || !onMove) {
                            return;
                        }
                        if (e.currentTarget instanceof HTMLElement) {
                            e.currentTarget.style.outline = 'none';
                        }
                    }}
                    onDrop={(e: any) => {
                        if (!isFolder || !onMove || !currentPath) {
                            return;
                        }

                        // Only handle internal drops, let external drops bubble up
                        if (!e.dataTransfer.types.includes('application/json')) {
                            return;
                        }

                        e.preventDefault();
                        e.stopPropagation();
                        if (e.currentTarget instanceof HTMLElement) {
                            e.currentTarget.style.outline = 'none';
                        }

                        try {
                            const data = JSON.parse(e.dataTransfer.getData('application/json'));
                            if (data && onMove) {
                                const targetFolder =
                                    currentPath === '/'
                                        ? `/${file.name}`
                                        : `${currentPath}/${file.name}`;
                                const moves = validateAndBuildMoves(data, targetFolder);
                                if (moves.length > 0) {
                                    onMove(moves);
                                }
                            }
                        } catch (err) {
                            console.error('Failed to parse drag data', err);
                        }
                    }}
                    onClick={(e) => {
                        e.stopPropagation();
                        const toggle = e.ctrlKey || e.metaKey || isFileSelectionMark(e.target);
                        onSelect(file.name, toggle, e.shiftKey);
                        if (clickPolicy === 'single' && !toggle && !e.shiftKey) {
                            onNavigate(file.name);
                        }
                    }}
                    onDoubleClick={(e) => {
                        e.stopPropagation();
                        if (clickPolicy === 'double' && !isFileSelectionMark(e.target)) {
                            onNavigate(file.name);
                        }
                    }}
                    onContextMenu={(e) => {
                        e.stopPropagation();
                        if (!isSelected) {
                            onSelect(file.name, false);
                        }
                        onContextMenu(e, file);
                    }}
                    onPointerEnter={(e) => onHoverShow?.(file, e.currentTarget)}
                    onPointerLeave={() => onHoverHide?.()}
                    className={cn(
                        'files-option group relative cursor-pointer select-none',
                        viewMode === 'grid'
                            ? cn(
                                  'flex flex-col items-center w-full min-w-0 rounded-xl',
                                  'px-1 py-1 gap-0.5',
                              )
                            : cn(
                                  'flex items-center rounded-lg border border-transparent',
                                  compactMode ? 'p-1.5' : 'p-2',
                              ),
                    )}
                >
                    <FileSelectionMark
                        selected={isSelected}
                        className="absolute start-0.5 top-0.5 z-10"
                    />
                    <div
                        className={cn(
                            'flex items-center justify-center shrink-0',
                            viewMode === 'grid' ? 'files-grid-artwork' : 'w-10 mr-4',
                            isFolder ? 'drop-shadow-sm' : 'text-app-muted/80',
                        )}
                        style={
                            viewMode === 'grid'
                                ? ({
                                      '--files-grid-icon-size': `${renderedIconSize}px`,
                                  } as CSSProperties)
                                : undefined
                        }
                    >
                        <FileIcon
                            file={file}
                            size={renderedIconSize}
                        />
                    </div>

                    <div className="w-full text-center px-1 min-w-0">
                        <div
                            className={cn(
                                'select-text',
                                viewMode === 'grid'
                                    ? cn(
                                          (iconSize ?? 0) >= 168 ? 'line-clamp-3' : 'line-clamp-2',
                                          'break-words [overflow-wrap:anywhere] leading-snug text-sm',
                                      )
                                    : 'truncate text-sm leading-snug',
                                isSelected ? 'text-app-text' : 'text-app-text/85',
                            )}
                        >
                            {file.name}
                        </div>
                    </div>
                </div>
            );
        },
    ),
);

// Memoized File List Item Component — plain div (windowed rows must not replay motion enter).
const FileListItem = memo(
    forwardRef<
        HTMLDivElement,
        {
            optionId: string;
            optionIndex: number;
            optionCount: number;
            columns: readonly FileSortColumn[];
            file: FileEntry;
            isSelected: boolean;
            isFocused: boolean;
            connectionId?: string;
            currentPath?: string;
            getSelectedFiles: () => string[];
            onSelect: (name: string, multi: boolean, range?: boolean) => void;
            onNavigate: (name: string) => void;
            onContextMenu: (e: React.MouseEvent, file?: FileEntry) => void;
            onMove?: (
                moves: { source: string; target: string; sourceConnectionId?: string }[],
            ) => void;
            clickPolicy?: 'single' | 'double';
            iconSize?: number;
            dateTimeFormat?: 'simple' | 'detailed';
        }
    >(
        (
            {
                optionId,
                optionIndex,
                optionCount,
                columns,
                file,
                isSelected,
                isFocused,
                connectionId,
                currentPath,
                getSelectedFiles,
                onSelect,
                onNavigate,
                onContextMenu,
                onMove,
                clickPolicy = 'double',
                iconSize = 18,
                dateTimeFormat = 'simple',
            },
            ref,
        ) => {
            const isFolder = file.type === 'd';
            const kindLabel = formatFileListType(file);
            const identityLabel = formatFileIdentity(file.owner || '', file.group || '');
            const metadata: Record<Exclude<FileSortColumn, 'name'>, string> = {
                modified: formatFileListDate(file.lastModified, Date.now(), dateTimeFormat) || '—',
                size: isFolder ? '—' : formatBytes(file.size),
                type: kindLabel,
                owner: identityLabel || '—',
            };

            return (
                <div
                    ref={ref}
                    role="option"
                    id={optionId}
                    data-file-name={file.name}
                    aria-label={`${file.name}, ${kindLabel}`}
                    aria-selected={isSelected}
                    aria-posinset={optionIndex + 1}
                    aria-setsize={optionCount}
                    data-focused={isFocused || undefined}
                    draggable={connectionId !== undefined}
                    onDragStart={(e: any) => {
                        if (!connectionId || !currentPath) {
                            return;
                        }
                        const selectedFiles = getSelectedFiles();
                        const dragData = buildDragData(
                            file,
                            isSelected,
                            selectedFiles,
                            connectionId,
                            currentPath,
                        );
                        const count =
                            isSelected && selectedFiles.length > 0 ? selectedFiles.length : 1;
                        startInternalDrag(e, dragData, isFolder, count);
                    }}
                    onDragEnd={(e: any) => {
                        setCurrentDragSource(null);
                        if (e.currentTarget instanceof HTMLElement) {
                            e.currentTarget.style.opacity = '1';
                        }
                    }}
                    onDragOver={(e: any) => {
                        if (!isFolder || !onMove) {
                            return;
                        }
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        if (e.currentTarget instanceof HTMLElement) {
                            e.currentTarget.style.outline = '2px dashed var(--color-app-accent)';
                        }
                    }}
                    onDragLeave={(e: any) => {
                        if (e.currentTarget instanceof HTMLElement) {
                            e.currentTarget.style.outline = 'none';
                        }
                    }}
                    onDrop={(e: any) => {
                        if (!isFolder || !onMove || !currentPath) {
                            return;
                        }

                        // Only handle internal drops, let external drops bubble up
                        if (!e.dataTransfer.types.includes('application/json')) {
                            return;
                        }

                        e.preventDefault();
                        e.stopPropagation();
                        if (e.currentTarget instanceof HTMLElement) {
                            e.currentTarget.style.outline = 'none';
                        }

                        try {
                            const data = JSON.parse(e.dataTransfer.getData('application/json'));
                            if (data && onMove) {
                                const targetFolder =
                                    currentPath === '/'
                                        ? `/${file.name}`
                                        : `${currentPath}/${file.name}`;
                                const moves = validateAndBuildMoves(data, targetFolder);
                                if (moves.length > 0) {
                                    onMove(moves);
                                }
                            }
                        } catch (err) {
                            console.error('Failed to parse drag data', err);
                        }
                    }}
                    onClick={(e) => {
                        e.stopPropagation();
                        const toggle = e.ctrlKey || e.metaKey || isFileSelectionMark(e.target);
                        onSelect(file.name, toggle, e.shiftKey);
                        if (clickPolicy === 'single' && !toggle && !e.shiftKey) {
                            onNavigate(file.name);
                        }
                    }}
                    onDoubleClick={(e) => {
                        e.stopPropagation();
                        if (clickPolicy === 'double' && !isFileSelectionMark(e.target)) {
                            onNavigate(file.name);
                        }
                    }}
                    onContextMenu={(e) => {
                        e.stopPropagation();
                        if (!isSelected) {
                            onSelect(file.name, false);
                        }
                        onContextMenu(e, file);
                    }}
                    className={cn(
                        'files-option files-list-option h-full w-full min-w-0 cursor-pointer outline-none',
                        'grid items-center overflow-hidden',
                        'files-list-columns rounded-md',
                    )}
                >
                    <div className="py-1 px-2 min-w-0 overflow-hidden">
                        <div className="flex items-center gap-2 min-w-0">
                            <FileSelectionMark selected={isSelected} />
                            <span className="shrink-0">
                                <FileIcon
                                    file={file}
                                    size={iconSize}
                                />
                            </span>
                            <Tooltip
                                content={file.name}
                                position="top"
                                className="min-w-0 w-full justify-start"
                            >
                                <FileName name={file.name} />
                            </Tooltip>
                        </div>
                    </div>
                    {columns
                        .filter((column) => column !== 'name')
                        .map((column) => (
                            <Tooltip
                                key={column}
                                content={metadata[column]}
                                position="top"
                                className={cn(
                                    `files-list-column-${column}`,
                                    'min-w-0 py-1 px-2',
                                    column === 'size' && 'justify-end',
                                )}
                            >
                                <span
                                    className={cn(
                                        'block min-w-0 truncate text-xs text-app-muted',
                                        column === 'owner' ? 'font-mono' : 'tabular-nums',
                                        column === 'size' && 'text-right',
                                    )}
                                >
                                    {metadata[column]}
                                </span>
                            </Tooltip>
                        ))}
                </div>
            );
        },
    ),
);

FileGridItem.displayName = 'FileGridItem';
FileListItem.displayName = 'FileListItem';

interface FileGridProps {
    focusRef: RefObject<HTMLDivElement | null>;
    /** Incremented for explicit keyboard navigation, even when focus stays on the same file. */
    focusRevealRequest?: number;
    onFocusItem: (name: string) => void;
    label: string;
    detailColumns: readonly FileDetailColumn[];
    columnWidths: FileListColumnWidths;
    onColumnWidthChange: (column: FileSortColumn, width: number) => void;
    onKeyboardContextMenu: (position: { x: number; y: number }, file?: FileEntry) => void;
    files: FileEntry[];
    selectedFiles: string[];
    onSelect: (name: string, multi: boolean) => void;
    onSelectMany?: (names: string[], focusName?: string) => void;
    onNavigate: (name: string) => void;
    onContextMenu: (e: React.MouseEvent, file?: FileEntry) => void;
    viewMode: 'grid' | 'list';
    isLoading: boolean;
    connectionId?: string;
    currentPath?: string;
    focusedFile?: string | null;
    onMove?: (moves: { source: string; target: string; sourceConnectionId?: string }[]) => void;
    sortColumn: FileSortColumn;
    sortDirection: FileSortDirection;
    onSort: (column: FileSortColumn) => void;
    onGridColumnCount?: (columnCount: number) => void;
    gridZoom?: number;
    listZoom?: number;
    clickPolicy?: 'single' | 'double';
    dateTimeFormat?: 'simple' | 'detailed';
    /** The owner distinguishes filtered/failed listings from a truly empty folder. */
    emptyState?: { title: string; description: string; onReset?: () => void };
}

type FileListRowExtra = {
    scopeId: string;
    columns: readonly FileSortColumn[];
    files: FileEntry[];
    selectedSet: Set<string>;
    focusedFile?: string | null;
    connectionId?: string;
    currentPath?: string;
    getSelectedFiles: () => string[];
    onSelect: (name: string, multi: boolean) => void;
    onNavigate: (name: string) => void;
    onContextMenu: (e: React.MouseEvent, file?: FileEntry) => void;
    onMove?: (moves: { source: string; target: string; sourceConnectionId?: string }[]) => void;
    clickPolicy: 'single' | 'double';
    iconSize: number;
    dateTimeFormat: 'simple' | 'detailed';
};

/** Project one virtual row into the existing memoized, metadata-only file item. */
function FileListRow({
    index,
    style,
    scopeId,
    columns,
    files,
    selectedSet,
    focusedFile,
    connectionId,
    currentPath,
    getSelectedFiles,
    onSelect,
    onNavigate,
    onContextMenu,
    onMove,
    clickPolicy,
    iconSize,
    dateTimeFormat,
}: {
    index: number;
    style: CSSProperties;
    ariaAttributes: { 'aria-posinset': number; 'aria-setsize': number; role: 'listitem' };
} & FileListRowExtra) {
    const file = files[index];
    if (!file) {
        return null;
    }
    return (
        <div
            style={{ ...style, minWidth: 'var(--files-list-width)' }}
            role="presentation"
            className="overflow-hidden py-px"
        >
            <FileListItem
                optionId={fileOptionId(scopeId, index)}
                optionIndex={index}
                optionCount={files.length}
                columns={columns}
                file={file}
                isSelected={selectedSet.has(file.name)}
                isFocused={focusedFile === file.name}
                connectionId={connectionId}
                currentPath={currentPath}
                getSelectedFiles={getSelectedFiles}
                onSelect={onSelect}
                onNavigate={onNavigate}
                onContextMenu={onContextMenu}
                onMove={onMove}
                clickPolicy={clickPolicy}
                iconSize={iconSize}
                dateTimeFormat={dateTimeFormat}
            />
        </div>
    );
}

type FileGridRowExtra = FileListRowExtra & {
    columnCount: number;
    gap: number;
    minTrack: number;
    compactMode: boolean;
    iconSize: number;
    clickPolicy: 'single' | 'double';
    onHoverShow: (file: FileEntry, el: HTMLElement) => void;
    onHoverHide: () => void;
};

/** Virtualize visual rows, not semantics: every file remains an option in one listbox. */
function FileGridRow({
    index: rowIndex,
    style,
    scopeId,
    files,
    columnCount,
    gap,
    minTrack,
    compactMode,
    selectedSet,
    focusedFile,
    connectionId,
    currentPath,
    getSelectedFiles,
    onSelect,
    onNavigate,
    onContextMenu,
    onMove,
    iconSize,
    clickPolicy,
    onHoverShow,
    onHoverHide,
}: {
    index: number;
    style: CSSProperties;
    ariaAttributes: { 'aria-posinset': number; 'aria-setsize': number; role: 'listitem' };
} & FileGridRowExtra) {
    return (
        <div
            style={{
                ...style,
                display: 'grid',
                gridTemplateColumns: fileIconGridTemplateColumns(minTrack, columnCount),
                justifyContent: 'safe center',
                columnGap: gap,
                paddingBottom: gap,
                contain: 'layout',
            }}
            role="presentation"
        >
            {Array.from({ length: columnCount }, (_, columnIndex) => {
                const index = rowIndex * columnCount + columnIndex;
                const file = files[index];
                if (!file) {
                    return null;
                }
                return (
                    <div
                        key={file.path || file.name}
                        role="presentation"
                        className="min-w-0 flex items-start justify-center p-1"
                    >
                        <FileGridItem
                            optionId={fileOptionId(scopeId, index)}
                            optionIndex={index}
                            optionCount={files.length}
                            file={file}
                            viewMode="grid"
                            compactMode={compactMode}
                            isSelected={selectedSet.has(file.name)}
                            isFocused={focusedFile === file.name}
                            connectionId={connectionId}
                            currentPath={currentPath}
                            getSelectedFiles={getSelectedFiles}
                            onSelect={onSelect}
                            onNavigate={onNavigate}
                            onContextMenu={onContextMenu}
                            onMove={onMove}
                            iconSize={iconSize}
                            clickPolicy={clickPolicy}
                            onHoverShow={onHoverShow}
                            onHoverHide={onHoverHide}
                        />
                    </div>
                );
            })}
        </div>
    );
}

export const FileGrid = memo(function FileGrid({
    focusRef,
    focusRevealRequest = 0,
    onFocusItem,
    label,
    detailColumns,
    columnWidths,
    onColumnWidthChange,
    onKeyboardContextMenu,
    files,
    selectedFiles,
    onSelect,
    onSelectMany,
    onNavigate,
    onContextMenu,
    viewMode,
    isLoading,
    connectionId,
    currentPath,
    focusedFile,
    onMove,
    sortColumn,
    sortDirection,
    onSort,
    onGridColumnCount,
    gridZoom,
    listZoom,
    clickPolicy = 'double',
    dateTimeFormat = 'simple',
    emptyState,
}: FileGridProps) {
    const compactMode = useAppStore((state) => state.settings.compactMode);
    const gridZoomLevel =
        gridZoom === undefined ? (compactMode ? 0 : 2) : clampFileGridZoom(gridZoom);
    const listZoomLevel =
        listZoom === undefined ? (compactMode ? 0 : 1) : clampFileListZoom(listZoom);
    const gridIcon = FILE_GRID_ZOOM[gridZoomLevel].icon;
    const listIcon = FILE_LIST_ZOOM[listZoomLevel].icon;
    const listRowHeight = FILE_LIST_ZOOM[listZoomLevel].rowHeight;
    const listRef = useListRef(null);
    const gridRef = useListRef(null);
    const scopeId = useId();
    const columns = useMemo(() => fileListColumns(detailColumns), [detailColumns]);
    const [activeOption, setActiveOption] = useState<string | null>(null);
    const focusedIndex = focusedFile ? files.findIndex((file) => file.name === focusedFile) : -1;
    const expectedActiveOption = focusedIndex >= 0 ? fileOptionId(scopeId, focusedIndex) : null;
    const syncActiveOption = useCallback(() => {
        const node = expectedActiveOption ? document.getElementById(expectedActiveOption) : null;
        const next = node && focusRef.current?.contains(node) ? expectedActiveOption : null;
        setActiveOption((previous) => (previous === next ? previous : next));
    }, [expectedActiveOption, focusRef]);
    const lastReportedColumnCountRef = useRef<number | null>(null);
    const cssGridRef = useRef<HTMLDivElement>(null);
    const selectedFilesRef = useRef(selectedFiles);
    const getSelectedFiles = useCallback(() => selectedFilesRef.current, []);
    useLayoutEffect(() => {
        selectedFilesRef.current = selectedFiles;
    }, [selectedFiles]);
    const selectedSet = useMemo(() => new Set(selectedFiles), [selectedFiles]);
    const useVirtualIconGrid = files.length > FILE_GRID_VIRTUALIZE_AFTER;
    const listingRef = useRef<HTMLDivElement>(null);
    const listHeadingRef = useRef<HTMLDivElement>(null);
    const alignListHeading = useCallback(() => {
        const viewport = listRef.current?.element;
        const heading = listHeadingRef.current;
        if (viewport && heading) {
            // Match the live scrollbar gutter so both elements have the same scroll range.
            heading.style.marginRight = `${viewport.offsetWidth - viewport.clientWidth}px`;
            heading.scrollLeft = viewport.scrollLeft;
        }
    }, [listRef]);
    const zoomTrack = FILE_GRID_ZOOM[gridZoomLevel];
    const gridTileHeight = zoomTrack.rowHeight;
    const gridRowHeight = gridTileHeight + zoomTrack.gap;
    const {
        columnCount: gridColumnCount,
        ready: gridReady,
        captureAnchor,
        viewport: gridViewport,
        setViewport,
    } = useFileGridViewport({
        enabled: viewMode === 'grid',
        files,
        path: currentPath,
        zoom: gridZoomLevel,
        rowPitch: gridRowHeight,
    });
    const setVirtualGridRef = useCallback(
        (instance: ListImperativeAPI | null) => {
            gridRef.current = instance;
            setViewport(instance?.element ?? null);
        },
        [gridRef, setViewport],
    );
    const setCssGridRef = useCallback(
        (element: HTMLDivElement | null) => {
            cssGridRef.current = element;
            setViewport(element);
        },
        [setViewport],
    );
    const gridRowCount = Math.max(1, Math.ceil(files.length / gridColumnCount));
    const marqueeOriginRef = useRef<{
        x: number;
        y: number;
        additive: boolean;
        snapshot: string[];
    } | null>(null);
    const marqueeSkipClearRef = useRef(false);
    const [marqueeRect, setMarqueeRect] = useState<MarqueeRect | null>(null);
    const handleItemSelect = useCallback(
        (name: string, multi: boolean, range?: boolean) => {
            focusRef.current?.focus({ preventScroll: true });
            if (range && focusedFile && onSelectMany) {
                onSelectMany(namesBetween(files, focusedFile, name), name);
                return;
            }
            onSelect(name, multi);
        },
        [files, focusedFile, onSelect, onSelectMany, focusRef],
    );
    const {
        tip: hoverTip,
        show: showHoverTip,
        hide: hideHoverTip,
    } = useFileHoverTip(undefined, dateTimeFormat);
    useEffect(() => {
        hideHoverTip();
    }, [currentPath, viewMode, hideHoverTip]);
    useEffect(() => {
        if (viewMode === 'list') {
            alignListHeading();
            return;
        }
        const el = gridRef.current?.element;
        if (!el) {
            return;
        }
        const onScroll = () => hideHoverTip();
        el.addEventListener('scroll', onScroll, { passive: true });
        return () => el.removeEventListener('scroll', onScroll);
    }, [hideHoverTip, viewMode, files.length, listRowHeight, listRef, gridRef, alignListHeading]);

    const reportColumnCount = useCallback(
        (count: number) => {
            // Publish only a changed visual-row count, never every resize pixel. Keyboard
            // movement must use the committed geometry rather than a delayed old count.
            if (lastReportedColumnCountRef.current === count) {
                return;
            }
            lastReportedColumnCountRef.current = count;
            onGridColumnCount?.(count);
        },
        [onGridColumnCount],
    );

    const scrollFocusedListRow = useCallback(() => {
        if (viewMode !== 'list' || !focusedFile) {
            return;
        }
        const index = files.findIndex((f) => f.name === focusedFile);
        if (index < 0) {
            return;
        }
        listRef.current?.scrollToRow({ index, align: 'smart', behavior: 'auto' });
    }, [viewMode, focusedFile, files, listRef]);

    const scrollFocusedGridCell = useCallback(
        (columnCount: number) => {
            if (viewMode !== 'grid' || !focusedFile || columnCount < 1 || files.length === 0) {
                return;
            }
            const index = files.findIndex((f) => f.name === focusedFile);
            const rowCount = Math.max(1, Math.ceil(files.length / columnCount));
            const target = fileGridScrollTarget(index, columnCount, rowCount);
            if (!target) {
                return;
            }
            gridRef.current?.scrollToRow({
                index: target.rowIndex,
                align: 'smart',
                behavior: 'auto',
            });
        },
        [viewMode, focusedFile, files, gridRef],
    );

    useLayoutEffect(() => {
        const listEl = listRef.current?.element;
        if (listEl) {
            listEl.scrollTop = 0;
        }
        const gridEl = gridRef.current?.element;
        if (gridEl) {
            gridEl.scrollTop = 0;
            gridEl.scrollLeft = 0;
        }
        const cssEl = cssGridRef.current;
        if (cssEl) {
            cssEl.scrollTop = 0;
            cssEl.scrollLeft = 0;
        }
    }, [currentPath, listRef, gridRef]);

    const listRowProps = useMemo(
        () => ({
            scopeId,
            columns,
            files,
            selectedSet,
            focusedFile,
            connectionId,
            currentPath,
            getSelectedFiles,
            onSelect: handleItemSelect,
            onNavigate,
            onContextMenu,
            onMove,
            clickPolicy,
            iconSize: listIcon,
            dateTimeFormat,
        }),
        [
            scopeId,
            columns,
            files,
            selectedSet,
            focusedFile,
            connectionId,
            currentPath,
            getSelectedFiles,
            handleItemSelect,
            onNavigate,
            onContextMenu,
            onMove,
            clickPolicy,
            listIcon,
            dateTimeFormat,
        ],
    );

    const cssGridStyle = useMemo<CSSProperties>(
        () => ({
            display: 'grid',
            gridTemplateColumns: fileIconGridTemplateColumns(zoomTrack.minTrack, gridColumnCount),
            gridAutoRows: `${gridTileHeight}px`,
            gap: zoomTrack.gap,
            justifyContent: 'safe center',
            alignContent: 'start',
        }),
        [gridColumnCount, gridTileHeight, zoomTrack.gap, zoomTrack.minTrack],
    );

    const collectMarqueeNames = useCallback(
        (rect: MarqueeRect) => {
            if (viewMode === 'list') {
                const listEl = listRef.current?.element;
                if (!listEl) {
                    return listingRef.current ? namesInDomMarquee(listingRef.current, rect) : [];
                }
                const box = listEl.getBoundingClientRect();
                return listNamesInMarquee(
                    files,
                    listRowHeight,
                    box.top,
                    box.left,
                    box.width,
                    listEl.scrollTop,
                    rect,
                );
            }
            if (useVirtualIconGrid) {
                const gridEl = gridRef.current?.element;
                if (!gridEl) {
                    return [];
                }
                const box = gridEl.getBoundingClientRect();
                return gridNamesInMarquee(
                    files,
                    gridColumnCount,
                    fileGridColumnPitch(gridEl.clientWidth, zoomTrack.minTrack, zoomTrack.gap),
                    gridRowHeight,
                    box.left +
                        fileGridInlineOffset(
                            gridEl.clientWidth,
                            zoomTrack.minTrack,
                            zoomTrack.gap,
                            gridColumnCount,
                        ),
                    box.top,
                    gridEl.scrollTop,
                    rect,
                );
            }
            const root = cssGridRef.current ?? listingRef.current;
            return root ? namesInDomMarquee(root, rect) : [];
        },
        [
            files,
            gridColumnCount,
            gridRef,
            gridRowHeight,
            listRef,
            listRowHeight,
            useVirtualIconGrid,
            viewMode,
            zoomTrack.gap,
            zoomTrack.minTrack,
        ],
    );

    useEffect(() => {
        if (viewMode !== 'grid' || useVirtualIconGrid) {
            return;
        }
        const el = cssGridRef.current;
        if (!el) {
            return;
        }
        const onScroll = () => hideHoverTip();
        el.addEventListener('scroll', onScroll, { passive: true });
        return () => el.removeEventListener('scroll', onScroll);
    }, [viewMode, useVirtualIconGrid, hideHoverTip, files.length]);

    useEffect(() => {
        if (viewMode !== 'grid' || !gridReady) {
            return;
        }
        reportColumnCount(gridColumnCount);
    }, [viewMode, gridReady, gridColumnCount, reportColumnCount]);

    const pendingFocusReveal = useRef(false);
    // Geometry changes preserve the reading anchor. Only navigation/view intent
    // requests focus reveal, which waits for the chosen renderer to actually mount.
    useLayoutEffect(() => {
        pendingFocusReveal.current = true;
    }, [focusedFile, focusedIndex, currentPath, viewMode, focusRevealRequest]);
    useLayoutEffect(() => {
        if (!pendingFocusReveal.current) {
            return;
        }
        if (!focusedFile || focusedIndex < 0) {
            pendingFocusReveal.current = false;
            return;
        }
        if (viewMode === 'list') {
            if (!listRef.current?.element) {
                return;
            }
            scrollFocusedListRow();
            pendingFocusReveal.current = false;
            return;
        }
        if (!gridReady || !gridViewport?.isConnected) {
            return;
        }
        if (!useVirtualIconGrid) {
            const node = expectedActiveOption
                ? document.getElementById(expectedActiveOption)
                : null;
            if (!(node instanceof HTMLElement) || !gridViewport.contains(node)) {
                return;
            }
            node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } else {
            if (gridRef.current?.element !== gridViewport) {
                return;
            }
            scrollFocusedGridCell(gridColumnCount);
        }
        captureAnchor();
        pendingFocusReveal.current = false;
    });

    useLayoutEffect(syncActiveOption, [
        syncActiveOption,
        viewMode,
        files,
        useVirtualIconGrid,
        gridColumnCount,
        gridReady,
    ]);

    return (
        <div
            ref={listingRef}
            data-file-marquee-active={marqueeRect !== null || undefined}
            className={cn(
                'files-listing flex-1 min-h-0 min-w-0 overflow-hidden relative flex flex-col',
                viewMode === 'list' && 'files-listing-list',
                marqueeRect && 'select-none',
            )}
            style={
                {
                    '--files-list-columns': fileListTracks(columns, columnWidths),
                    '--files-list-width': fileListWidth(columns, columnWidths),
                    '--files-list-icon-width': `${listIcon}px`,
                } as CSSProperties
            }
            onClick={(event) => {
                if (isScrollbarPointer(event)) {
                    return;
                }
                if (marqueeSkipClearRef.current) {
                    marqueeSkipClearRef.current = false;
                    return;
                }
                onSelect('', false);
                focusRef.current?.focus({ preventScroll: true });
            }}
            onPointerDown={(e) => {
                if (e.button !== 0 || !onSelectMany) {
                    return;
                }
                const target = e.target as HTMLElement | null;
                if (target?.closest('[data-file-name]') || target?.closest('button')) {
                    return;
                }
                if (isScrollbarPointer(e)) {
                    return;
                }
                // This background gesture belongs to file selection, not the browser's text range.
                e.preventDefault();
                e.currentTarget.ownerDocument.getSelection()?.removeAllRanges();
                focusRef.current?.focus({ preventScroll: true });
                marqueeOriginRef.current = {
                    x: e.clientX,
                    y: e.clientY,
                    additive: e.ctrlKey || e.metaKey,
                    snapshot: e.ctrlKey || e.metaKey ? selectedFilesRef.current.slice() : [],
                };
                setMarqueeRect(null);
                e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
                const origin = marqueeOriginRef.current;
                if (!origin) {
                    return;
                }
                const dx = e.clientX - origin.x;
                const dy = e.clientY - origin.y;
                if (!marqueeRect && Math.hypot(dx, dy) < MARQUEE_DRAG_THRESHOLD_PX) {
                    return;
                }
                e.preventDefault();
                const rect = normalizeClientRect(origin.x, origin.y, e.clientX, e.clientY);
                setMarqueeRect(rect);
                hideHoverTip();
                const hits = collectMarqueeNames(rect);
                onSelectMany?.(
                    origin.additive ? mergeMarqueeSelection(origin.snapshot, hits) : hits,
                );
            }}
            onPointerUp={(e) => {
                if (marqueeOriginRef.current && marqueeRect) {
                    marqueeSkipClearRef.current = true;
                }
                marqueeOriginRef.current = null;
                setMarqueeRect(null);
                if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                    e.currentTarget.releasePointerCapture(e.pointerId);
                }
            }}
            onPointerCancel={(e) => {
                marqueeOriginRef.current = null;
                setMarqueeRect(null);
                if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                    e.currentTarget.releasePointerCapture(e.pointerId);
                }
            }}
            onLostPointerCapture={() => {
                marqueeOriginRef.current = null;
                setMarqueeRect(null);
            }}
            onContextMenu={(e) => {
                e.preventDefault();
                onContextMenu(e);
            }}
            onDragOver={(e) => {
                const types = Array.from(e.dataTransfer.types || []);
                const isInternal = types.includes('application/json');
                const isExternal = types.includes('Files') || types.includes('text/uri-list');

                if (isInternal || isExternal) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'copy';
                    e.currentTarget.style.backgroundColor =
                        'var(--color-app-accent-transparent, rgba(var(--color-app-accent-rgb), 0.05))';
                }
            }}
            onDragLeave={(e) => {
                e.currentTarget.style.backgroundColor = '';
            }}
            onDrop={(e) => {
                e.currentTarget.style.backgroundColor = '';
                // Always prevent default to stop WebView from navigating to dropped file URL
                e.preventDefault();

                const types = Array.from(e.dataTransfer.types || []);
                const isExternal = types.includes('Files') || types.includes('text/uri-list');
                if (isExternal) {
                    e.stopPropagation();
                    useAppStore
                        .getState()
                        .showToast(
                            'info',
                            'External drop here is currently disabled. We are working to bring this feature to Zync soon!',
                        );
                    return;
                }
            }}
        >
            {/* Smooth Native Progress Bar */}
            <AnimatePresence>
                {isLoading && (
                    <motion.div
                        initial={{ opacity: 0, scaleX: 0 }}
                        animate={{ opacity: 1, scaleX: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.3 }}
                        className="absolute top-0 left-0 right-0 h-0.5 bg-app-accent origin-left z-50 overflow-hidden shadow-[0_0_8px_rgba(var(--color-app-accent-rgb),0.5)]"
                    >
                        <motion.div
                            animate={{ x: ['-100%', '200%'] }}
                            transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}
                            className="h-full w-1/3 bg-white/30"
                        />
                    </motion.div>
                )}
            </AnimatePresence>

            {viewMode === 'list' && files.length > 0 && (
                <div
                    ref={listHeadingRef}
                    className="files-list-heading-viewport overflow-hidden shrink-0"
                    onScroll={(event) => {
                        const viewport = listRef.current?.element;
                        if (viewport && viewport.scrollLeft !== event.currentTarget.scrollLeft) {
                            viewport.scrollLeft = event.currentTarget.scrollLeft;
                        }
                    }}
                >
                    <FileListHeading
                        columns={columns}
                        widths={columnWidths}
                        onColumnWidthChange={onColumnWidthChange}
                        sortColumn={sortColumn}
                        sortDirection={sortDirection}
                        onSort={onSort}
                    />
                </div>
            )}
            <div
                ref={focusRef}
                role={files.length > 0 ? 'listbox' : 'region'}
                aria-label={label}
                aria-multiselectable={files.length > 0 ? true : undefined}
                aria-busy={isLoading}
                aria-activedescendant={
                    activeOption === expectedActiveOption ? (activeOption ?? undefined) : undefined
                }
                tabIndex={0}
                className={cn(
                    'files-selection outline-none',
                    'flex-1 min-h-0 w-full',
                    isLoading && 'pointer-events-none cursor-wait',
                )}
                onFocus={(event) => {
                    if (event.target === event.currentTarget && focusedIndex < 0 && files[0]) {
                        onFocusItem(files[0].name);
                    }
                }}
                onKeyDown={(event) => {
                    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) {
                        return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    const item = focusedIndex >= 0 ? files[focusedIndex] : undefined;
                    const node = expectedActiveOption
                        ? document.getElementById(expectedActiveOption)
                        : null;
                    const box = (node ?? event.currentTarget).getBoundingClientRect();
                    onKeyboardContextMenu(
                        { x: box.left + 12, y: box.top + Math.min(box.height, 36) },
                        item,
                    );
                }}
            >
                {files.length === 0 ? (
                    <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="flex flex-col items-center justify-center gap-2 px-6 text-center text-app-muted select-none h-full"
                        onContextMenu={(e) => onContextMenu(e)}
                    >
                        <Folder
                            size={36}
                            aria-hidden="true"
                            className="mb-2 stroke-1"
                        />
                        <p className="text-sm font-medium text-app-text">
                            {isLoading
                                ? 'Loading folder…'
                                : (emptyState?.title ?? 'This folder is empty')}
                        </p>
                        {!isLoading && (
                            <p className="max-w-xs text-xs leading-relaxed">
                                {emptyState?.description ??
                                    'Create a file or folder with New, or choose Upload to add files.'}
                            </p>
                        )}
                        {!isLoading && emptyState?.onReset && (
                            <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                onClick={(event) => {
                                    event.stopPropagation();
                                    emptyState.onReset?.();
                                    focusRef.current?.focus({ preventScroll: true });
                                }}
                            >
                                Clear filter
                            </Button>
                        )}
                    </motion.div>
                ) : viewMode === 'list' ? (
                    <div className="h-full min-h-0 min-w-0">
                        <List
                            key="files-list"
                            tabIndex={-1}
                            role="presentation"
                            data-file-list-viewport=""
                            listRef={listRef}
                            rowCount={files.length}
                            rowHeight={listRowHeight}
                            rowComponent={FileListRow}
                            rowProps={listRowProps}
                            overscanCount={4}
                            onScroll={(event) => {
                                hideHoverTip();
                                if (listHeadingRef.current) {
                                    listHeadingRef.current.scrollLeft =
                                        event.currentTarget.scrollLeft;
                                }
                            }}
                            onRowsRendered={syncActiveOption}
                            onResize={(size, previous) => {
                                alignListHeading();
                                // A newly mounted list needs its first measurement before revealing focus.
                                if (previous.height === 0 && size.height > 0) {
                                    scrollFocusedListRow();
                                }
                            }}
                            style={{ height: '100%', width: '100%', overflowX: 'auto' }}
                        />
                    </div>
                ) : (
                    <div className="h-full w-full min-h-0 min-w-0">
                        {useVirtualIconGrid ? (
                            <List
                                key="files-grid"
                                tabIndex={-1}
                                role="presentation"
                                listRef={setVirtualGridRef}
                                rowComponent={FileGridRow}
                                rowProps={{
                                    ...listRowProps,
                                    columnCount: gridColumnCount,
                                    gap: zoomTrack.gap,
                                    minTrack: zoomTrack.minTrack,
                                    compactMode,
                                    iconSize: gridIcon,
                                    clickPolicy,
                                    onHoverShow: showHoverTip,
                                    onHoverHide: hideHoverTip,
                                }}
                                rowCount={gridRowCount}
                                rowHeight={gridRowHeight}
                                overscanCount={2}
                                onRowsRendered={syncActiveOption}
                                style={{
                                    height: '100%',
                                    width: '100%',
                                    overflowX: 'hidden',
                                    overflowAnchor: 'none',
                                    scrollbarGutter: 'stable',
                                }}
                            />
                        ) : (
                            <div
                                ref={setCssGridRef}
                                tabIndex={-1}
                                role="presentation"
                                className="h-full w-full min-h-0 min-w-0 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable] [overflow-anchor:none] [contain:layout_paint]"
                                style={cssGridStyle}
                            >
                                {files.map((file, index) => (
                                    <div
                                        key={file.path || file.name}
                                        role="presentation"
                                        className="min-w-0 w-full flex items-start justify-center p-1 [contain:layout]"
                                    >
                                        <FileGridItem
                                            optionId={fileOptionId(scopeId, index)}
                                            optionIndex={index}
                                            optionCount={files.length}
                                            file={file}
                                            viewMode="grid"
                                            compactMode={compactMode}
                                            isSelected={selectedSet.has(file.name)}
                                            isFocused={focusedFile === file.name}
                                            connectionId={connectionId}
                                            currentPath={currentPath}
                                            getSelectedFiles={getSelectedFiles}
                                            onSelect={handleItemSelect}
                                            onNavigate={onNavigate}
                                            onContextMenu={onContextMenu}
                                            onMove={onMove}
                                            iconSize={gridIcon}
                                            clickPolicy={clickPolicy}
                                            onHoverShow={showHoverTip}
                                            onHoverHide={hideHoverTip}
                                        />
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
                {hoverTip && (
                    <FileHoverTip
                        text={hoverTip.text}
                        x={hoverTip.x}
                        y={hoverTip.y}
                    />
                )}
                {marqueeRect &&
                    listingRef.current &&
                    (() => {
                        const box = listingRef.current.getBoundingClientRect();
                        return (
                            <div
                                className="pointer-events-none absolute z-30 rounded-sm border border-app-accent bg-app-accent/15"
                                style={{
                                    left: marqueeRect.left - box.left,
                                    top: marqueeRect.top - box.top,
                                    width: marqueeRect.width,
                                    height: marqueeRect.height,
                                }}
                            />
                        );
                    })()}
            </div>
        </div>
    );
});
