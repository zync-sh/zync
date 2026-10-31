import type { FileSortColumn, FileSortDirection } from './fileGridLayout';

export type FileDetailColumn = 'type' | 'owner';

/** Per-pane presentation, like sorting: never migrates or rewrites saved settings. */
export const FILE_DETAIL_COLUMNS: readonly FileDetailColumn[] = ['type', 'owner'];
export const FILE_BASE_COLUMNS: readonly FileSortColumn[] = ['name', 'modified', 'size'];

export const FILE_LIST_COLUMN_WIDTHS: Record<FileSortColumn, number> = {
    name: 25,
    modified: 9,
    type: 6.5,
    owner: 8,
    size: 5,
};

export function fileListColumns(details: readonly FileDetailColumn[]): FileSortColumn[] {
    return [
        ...FILE_BASE_COLUMNS.filter((column) => column !== 'size'),
        ...FILE_DETAIL_COLUMNS.filter((column) => details.includes(column)),
        'size',
    ];
}

/** Fixed tracks keep column positions stable when a pane becomes horizontally scrollable. */
export function fileListTracks(
    columns: readonly FileSortColumn[],
    widths: FileListColumnWidths = FILE_LIST_COLUMN_WIDTHS,
): string {
    return columns.map((column) => `${widths[column]}rem`).join(' ');
}

/** The virtual row and heading share this minimum canvas width, including optional columns. */
export function fileListWidth(
    columns: readonly FileSortColumn[],
    widths: FileListColumnWidths = FILE_LIST_COLUMN_WIDTHS,
): string {
    return `${columns.reduce((width, column) => width + widths[column], 0)}rem`;
}

export type FileListColumnWidths = Record<FileSortColumn, number>;
export interface FileListPreferences {
    widths: FileListColumnWidths;
    details: FileDetailColumn[];
    sortColumn: FileSortColumn;
    sortDirection: FileSortDirection;
}

export const FILE_LIST_LAYOUT_STORAGE_KEY = 'zync.files.list-layout.v1';
export const FILE_LIST_LAYOUT_LIMIT = 64;
export const FILE_LIST_COLUMN_MIN: FileListColumnWidths = {
    name: 12,
    modified: 8,
    type: 6,
    owner: 6,
    size: 4,
};
export const FILE_LIST_COLUMN_MAX = 80;

/** Saved widths are rem values, bounded before they can become layout CSS. */
export function fileListColumnWidth(column: FileSortColumn, value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.round(
              Math.min(FILE_LIST_COLUMN_MAX, Math.max(FILE_LIST_COLUMN_MIN[column], value)) * 100,
          ) / 100
        : FILE_LIST_COLUMN_WIDTHS[column];
}

/** Ignore unknown saved fields and preserve explicit empty optional-column choices. */
export function normalizeFileListPreferences(value: unknown): FileListPreferences {
    const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const rawWidths =
        raw.widths && typeof raw.widths === 'object' ? (raw.widths as Record<string, unknown>) : {};
    const widths = Object.fromEntries(
        Object.keys(FILE_LIST_COLUMN_WIDTHS).map((key) => {
            const column = key as FileSortColumn;
            return [column, fileListColumnWidth(column, rawWidths[column])];
        }),
    ) as FileListColumnWidths;
    return {
        widths,
        details: Array.isArray(raw.details)
            ? FILE_DETAIL_COLUMNS.filter((column) => (raw.details as unknown[]).includes(column))
            : ['type'],
        sortColumn:
            typeof raw.sortColumn === 'string' &&
            Object.prototype.hasOwnProperty.call(FILE_LIST_COLUMN_WIDTHS, raw.sortColumn)
                ? (raw.sortColumn as FileSortColumn)
                : 'name',
        sortDirection: raw.sortDirection === 'desc' ? 'desc' : 'asc',
    };
}

type LayoutStorage = Pick<Storage, 'getItem' | 'setItem'>;
interface SavedFileListLayout {
    scope: string;
    preferences: FileListPreferences;
}

function localLayoutStorage(): LayoutStorage | undefined {
    try {
        return typeof window === 'undefined' ? undefined : window.localStorage;
    } catch {
        return undefined;
    }
}

function savedFileListLayouts(storage: LayoutStorage | undefined): SavedFileListLayout[] {
    try {
        const text = storage?.getItem(FILE_LIST_LAYOUT_STORAGE_KEY);
        if (!text || text.length > 65536) {
            return [];
        }
        const raw = JSON.parse(text);
        if (raw?.version !== 1 || !Array.isArray(raw.entries)) {
            return [];
        }
        return raw.entries
            .slice(-FILE_LIST_LAYOUT_LIMIT)
            .filter((entry: unknown) =>
                Boolean(
                    entry &&
                        typeof entry === 'object' &&
                        typeof (entry as SavedFileListLayout).scope === 'string',
                ),
            )
            .map((entry: SavedFileListLayout) => ({
                scope: entry.scope,
                preferences: normalizeFileListPreferences(entry.preferences),
            }));
    } catch {
        return [];
    }
}

/** This bounded local UI cache never stores paths or uses remote settings/sync APIs. */
export function loadFileListPreferences(
    scope: string,
    storage = localLayoutStorage(),
): FileListPreferences {
    return (
        savedFileListLayouts(storage).find((entry) => entry.scope === scope)?.preferences ??
        normalizeFileListPreferences(undefined)
    );
}

/** Persist only completed changes; unavailable storage leaves the current pane usable. */
export function saveFileListPreferences(
    scope: string,
    preferences: FileListPreferences,
    storage = localLayoutStorage(),
): boolean {
    if (!storage || !scope || scope.length > 256) {
        return false;
    }
    try {
        const entries = savedFileListLayouts(storage).filter((entry) => entry.scope !== scope);
        entries.push({ scope, preferences: normalizeFileListPreferences(preferences) });
        storage.setItem(
            FILE_LIST_LAYOUT_STORAGE_KEY,
            JSON.stringify({ version: 1, entries: entries.slice(-FILE_LIST_LAYOUT_LIMIT) }),
        );
        return true;
    } catch {
        return false;
    }
}

/** DOM identity is instance-scoped and independent of arbitrary filesystem names. */
export function fileOptionId(scope: string, index: number): string {
    return `file-item-${scope}-${index}`;
}

/** Retain a useful final extension while the base name ellipsizes; dotfiles stay literal. */
export function fileNameParts(name: string): { base: string; extension: string } {
    const compound = name.match(/\.(?:tar\.(?:gz|bz2|xz)|d\.ts)$/i)?.[0];
    if (compound && name.length > compound.length) {
        return { base: name.slice(0, -compound.length), extension: compound };
    }
    const dot = name.lastIndexOf('.');
    return dot > 0 && dot < name.length - 1 && name.length - dot <= 10
        ? { base: name.slice(0, dot), extension: name.slice(dot) }
        : { base: name, extension: '' };
}
