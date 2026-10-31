/** Places switches to a dialog when the measured Files pane cannot fit a useful sidebar. */
export const FILE_CHROME_NARROW_MAX = 682;

/** Recent folders kept per connection and shown in Places. */
export const FILE_RECENT_LIMIT = 5;
export const FILE_RECENT_LIMIT_MAX = 20;
export const FILE_RECENT_LIMIT_CHOICES = [3, 5, 10, 15] as const;

export function clampFileRecentLimit(value: number | undefined): number {
    if (!Number.isFinite(value)) {
        return FILE_RECENT_LIMIT;
    }
    const n = Math.floor(value as number);
    if (n < 1) {
        return 1;
    }
    if (n > FILE_RECENT_LIMIT_MAX) {
        return FILE_RECENT_LIMIT_MAX;
    }
    return n;
}

/** Readable inline Places width; narrow panes use the shared dialog. */
export const FILE_PLACES_WIDTH_PX = 184;

/** Inline inspector width; reserve a useful listing beside it before choosing this mode. */
export const FILE_PROPERTIES_WIDTH_PX = 320;
export const FILE_INSPECTOR_LISTING_MIN_WIDTH_PX = 400;

/** Icon view uses CSS auto-fill below this; react-window for larger folders. */
export const FILE_GRID_VIRTUALIZE_AFTER = 96;

export const FILE_GRID_ZOOM = [
    // Each track includes the tile and cell insets; rows also reserve the full caption.
    { minTrack: 100, gap: 6, rowHeight: 108, icon: 48 },
    { minTrack: 112, gap: 6, rowHeight: 124, icon: 64 },
    { minTrack: 128, gap: 8, rowHeight: 156, icon: 96 },
    { minTrack: 184, gap: 8, rowHeight: 248, icon: 168 },
    { minTrack: 272, gap: 10, rowHeight: 336, icon: 256 },
] as const;

export const FILE_LIST_ZOOM = [
    { icon: 20, rowHeight: 38 },
    { icon: 32, rowHeight: 44 },
    { icon: 64, rowHeight: 74 },
] as const;

/** Sidebar artwork stays subordinate to file entries, without becoming tiny at normal density. */
export const FILE_PLACE_ICON_PX = 18;

export type FileClickPolicy = 'single' | 'double';

export function clampFileGridZoom(level: number): number {
    if (!Number.isFinite(level)) {
        return 1;
    }
    if (level < 0) {
        return 0;
    }
    if (level > FILE_GRID_ZOOM.length - 1) {
        return FILE_GRID_ZOOM.length - 1;
    }
    return Math.floor(level);
}

export function clampFileListZoom(level: number): number {
    if (!Number.isFinite(level)) {
        return 1;
    }
    if (level < 0) {
        return 0;
    }
    if (level > FILE_LIST_ZOOM.length - 1) {
        return FILE_LIST_ZOOM.length - 1;
    }
    return Math.floor(level);
}
