import { clampFileGridZoom, FILE_GRID_ZOOM, FILE_LIST_ZOOM } from './fileChrome.js';
import { FILE_BASE_COLUMNS, fileListTracks } from './fileListPresentation';
import type { FileEntry } from './types';

export type FileSortColumn = 'name' | 'modified' | 'type' | 'size' | 'owner';
export type FileSortDirection = 'asc' | 'desc';

export const FILE_LIST_COLUMN_IDS: readonly FileSortColumn[] = [
    'name',
    'modified',
    'type',
    'size',
    'owner',
];

export const FILE_LIST_COLUMN_LABELS: Record<FileSortColumn, string> = {
    name: 'Name',
    modified: 'Date modified',
    type: 'Type',
    size: 'Size',
    owner: 'Owner:Group',
};

export const FILE_LIST_COLUMN_ALIGN: Record<FileSortColumn, 'left' | 'right'> = {
    name: 'left',
    modified: 'left',
    type: 'left',
    size: 'right',
    owner: 'left',
};

/** First click on a column uses this direction (size/date: newest/largest first). */
export const FILE_LIST_SORT_INITIAL: Record<FileSortColumn, FileSortDirection> = {
    name: 'asc',
    type: 'asc',
    owner: 'asc',
    size: 'desc',
    modified: 'desc',
};

export function fileListSortSense(column: FileSortColumn, direction: FileSortDirection): string {
    switch (column) {
        case 'name':
        case 'type':
        case 'owner':
            return direction === 'asc' ? 'A to Z' : 'Z to A';
        case 'size':
            return direction === 'asc' ? 'smallest first' : 'largest first';
        case 'modified':
            return direction === 'asc' ? 'oldest first' : 'newest first';
    }
}

export function fileListSortTooltip(
    column: FileSortColumn,
    activeColumn: FileSortColumn,
    direction: FileSortDirection,
): string {
    const label = FILE_LIST_COLUMN_LABELS[column];
    if (column === activeColumn) {
        const next = direction === 'asc' ? 'desc' : 'asc';
        return `${label} · ${fileListSortSense(column, direction)}. Click for ${fileListSortSense(column, next)}.`;
    }
    const initial = FILE_LIST_SORT_INITIAL[column];
    return `Sort by ${label}, ${fileListSortSense(column, initial)}`;
}

/** Default list row metrics are shared with zoom, selection and virtualization. */
export const FILE_LIST_ROW_HEIGHT = FILE_LIST_ZOOM[0].rowHeight;

/** Default tracks; explicit optional columns and narrow variants use the same presentation owner. */
export const FILE_LIST_COLUMNS = fileListTracks(FILE_BASE_COLUMNS);

/** Explorer-style type: `File folder`, `PNG File`. Long fake extensions become `File`. */
export function formatFileListType(file: FileEntry): string {
    if (file.type === 'd') {
        return 'File folder';
    }
    if (file.type === 'l') {
        return 'Link';
    }
    const name = file.name;
    let ext = '';
    if (name.startsWith('.') && !name.slice(1).includes('.')) {
        ext = name.slice(1).trim();
    } else {
        const dot = name.lastIndexOf('.');
        if (dot > 0 && dot < name.length - 1) {
            ext = name.slice(dot + 1);
        }
    }
    if (!ext || ext.length > 8) {
        return 'File';
    }
    return `${ext.toUpperCase()} File`;
}

/** Grid hover card: name, Folder/size, owner:group, date. */
export function fileHoverHint(
    file: FileEntry,
    dateTimeFormat: 'simple' | 'detailed' = 'simple',
): string {
    const identity = formatFileIdentity(file.owner || '', file.group || '');
    const modified = formatFileListDate(file.lastModified, Date.now(), dateTimeFormat);
    const kind = file.type === 'd' ? 'Folder' : formatBytesForHint(file.size);
    return [file.name, kind, identity, modified].filter(Boolean).join('\n');
}

function formatBytesForHint(size: number): string {
    if (!Number.isFinite(size) || size < 0) {
        return '';
    }
    if (size < 1024) {
        return `${size} B`;
    }
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = size / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    const digits = value >= 10 || unit === 0 ? 0 : 1;
    return `${value.toFixed(digits)} ${units[unit]}`;
}

/** `admin:staff`, or empty when both are missing. */
export function formatFileIdentity(owner: string, group: string): string {
    const user = (owner || '').trim();
    const grp = (group || '').trim();
    if (!user && !grp) {
        return '';
    }
    if (user && grp) {
        return `${user}:${grp}`;
    }
    return user || grp;
}

/** Compact list/grid dates: time today, `Sep 2` this year, else `Nov 20, 2025`. */
export function formatFileListDate(
    timestamp: number,
    nowMs: number = Date.now(),
    format: 'simple' | 'detailed' = 'simple',
): string {
    const ms = timestamp > 0 && timestamp < 1e10 ? timestamp * 1000 : timestamp;
    const date = new Date(ms);
    if (Number.isNaN(date.getTime()) || timestamp === 0) {
        return '';
    }
    if (format === 'detailed') {
        return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    }
    const now = new Date(nowMs);
    if (date.toDateString() === now.toDateString()) {
        return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }
    if (date.getFullYear() === now.getFullYear()) {
        return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** List-view dates: locale short date and time, like Explorer details. */
export function formatFileExplorerDate(timestamp: number): string {
    const ms = timestamp > 0 && timestamp < 1e10 ? timestamp * 1000 : timestamp;
    const date = new Date(ms);
    if (Number.isNaN(date.getTime()) || timestamp === 0) {
        return '';
    }
    return date.toLocaleString(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });
}

export interface FileGridMetrics {
    columnCount: number;
    /** Preferred tile track at this zoom; only panes narrower than one tile shrink it. */
    minTrack: number;
    /** react-window cell width when the viewport has not been measured yet (`minTrack + gap`). */
    columnWidth: number;
    rowHeight: number;
    gap: number;
}

/** Fixed track widths wrap directly; the grid container balances spare inline space. */
export function fileIconGridTemplateColumns(minTrack: number, columnCount?: number): string {
    const track = Math.max(1, minTrack);
    return `repeat(${columnCount === undefined ? 'auto-fill' : Math.max(1, columnCount)}, min(100%, ${track}px))`;
}

/** Match CSS track sizing, including the minimum while a resize measurement is pending. */
export function fileGridColumnPitch(width: number, minTrack: number, gap: number): number {
    return Math.min(Math.max(0, width), Math.max(1, minTrack)) + gap;
}

/** Balance spare inline space around fixed tracks, including a clipped single-track viewport. */
export function fileGridInlineOffset(
    width: number,
    minTrack: number,
    gap: number,
    columns: number,
): number {
    const count = Math.max(1, columns);
    const track = Math.min(Math.max(0, width), Math.max(1, minTrack));
    return Math.max(0, (width - count * track - (count - 1) * gap) / 2);
}

export function sortFileEntries(
    files: FileEntry[],
    column: FileSortColumn,
    direction: FileSortDirection,
    foldersFirst = true,
): FileEntry[] {
    return [...files].sort((a, b) => {
        if (foldersFirst) {
            if (a.type === 'd' && b.type !== 'd') {
                return -1;
            }
            if (a.type !== 'd' && b.type === 'd') {
                return 1;
            }
        }

        let comparison = 0;
        switch (column) {
            case 'name':
                comparison = a.name.localeCompare(b.name);
                break;
            case 'size':
                comparison = a.size - b.size;
                break;
            case 'owner': {
                const left = formatFileIdentity(a.owner || '', a.group || '');
                const right = formatFileIdentity(b.owner || '', b.group || '');
                comparison = left.localeCompare(right);
                break;
            }
            case 'modified':
                comparison = a.lastModified - b.lastModified;
                break;
            case 'type':
                comparison = formatFileListType(a).localeCompare(formatFileListType(b));
                break;
        }
        return direction === 'asc' ? comparison : -comparison;
    });
}

/** Cell coordinates for a file index, or null if they would miss the current grid. */
export function fileGridScrollTarget(
    fileIndex: number,
    columnCount: number,
    rowCount: number,
): { rowIndex: number; columnIndex: number } | null {
    if (rowCount <= 0) {
        return null;
    }
    const cols = Math.max(1, columnCount);
    const rows = rowCount;
    if (fileIndex < 0) {
        return null;
    }
    const rowIndex = Math.floor(fileIndex / cols);
    const columnIndex = fileIndex % cols;
    if (rowIndex >= rows || columnIndex >= cols) {
        return null;
    }
    return { rowIndex, columnIndex };
}

export function computeFileGridMetrics(
    containerWidth: number,
    compactMode: boolean,
    zoomLevel?: number,
): FileGridMetrics {
    if (zoomLevel === undefined) {
        const minTrack = compactMode ? 90 : 104;
        const gap = compactMode ? 6 : 8;
        const rowHeight = compactMode ? 100 : 120;
        const width = Math.max(0, containerWidth);
        const columnCount = Math.max(1, Math.floor((width + gap) / (minTrack + gap)));
        return { columnCount, minTrack, columnWidth: minTrack + gap, rowHeight, gap };
    }
    const zoom = FILE_GRID_ZOOM[clampFileGridZoom(zoomLevel)];
    const minTrack = zoom.minTrack;
    const gap = zoom.gap;
    const rowHeight = zoom.rowHeight;
    const width = Math.max(0, containerWidth);
    const columnCount = Math.max(1, Math.floor((width + gap) / (minTrack + gap)));
    return { columnCount, minTrack, columnWidth: minTrack + gap, rowHeight, gap };
}
