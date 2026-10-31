import { ArrowDown, ArrowUp } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';

import { cn } from '../../lib/utils';
import { Tooltip } from '../ui/Tooltip';
import {
    FILE_LIST_COLUMN_ALIGN,
    FILE_LIST_COLUMN_LABELS,
    type FileSortColumn,
    type FileSortDirection,
    fileListSortTooltip,
} from './fileGridLayout';
import {
    FILE_LIST_COLUMN_MAX,
    FILE_LIST_COLUMN_MIN,
    FILE_LIST_COLUMN_WIDTHS,
    type FileListColumnWidths,
    fileListColumnWidth,
    fileListTracks,
    fileListWidth,
} from './fileListPresentation';

interface ColumnDrag {
    column: FileSortColumn;
    pointerId: number;
    startX: number;
    startWidth: number;
    width: number;
    rem: number;
    canvas: HTMLElement;
    handle: HTMLElement;
    columns: readonly FileSortColumn[];
    widths: FileListColumnWidths;
    tracks: string;
    canvasWidth: string;
}

/** Fixed virtual rows inherit one shared CSS preview; React and storage update on release. */
export function FileListHeading({
    columns,
    widths,
    sortColumn,
    sortDirection,
    onSort,
    onColumnWidthChange,
}: {
    columns: readonly FileSortColumn[];
    widths: FileListColumnWidths;
    sortColumn: FileSortColumn;
    sortDirection: FileSortDirection;
    onSort: (column: FileSortColumn) => void;
    onColumnWidthChange: (column: FileSortColumn, width: number) => void;
}) {
    const drag = useRef<ColumnDrag | null>(null);
    const frame = useRef<number | null>(null);
    const preview = useCallback(() => {
        frame.current = null;
        const current = drag.current;
        if (!current) {
            return;
        }
        const next = { ...current.widths, [current.column]: current.width };
        current.canvas.style.setProperty(
            '--files-list-columns',
            fileListTracks(current.columns, next),
        );
        current.canvas.style.setProperty(
            '--files-list-width',
            fileListWidth(current.columns, next),
        );
        current.handle.setAttribute('aria-valuenow', String(current.width));
    }, []);
    const cancel = useCallback((restore = true) => {
        if (frame.current !== null) {
            cancelAnimationFrame(frame.current);
        }
        frame.current = null;
        const current = drag.current;
        drag.current = null;
        if (!current) {
            return;
        }
        if (restore) {
            current.canvas.style.setProperty('--files-list-columns', current.tracks);
            current.canvas.style.setProperty('--files-list-width', current.canvasWidth);
            current.handle.setAttribute('aria-valuenow', String(current.startWidth));
        }
        if (current.handle.hasPointerCapture(current.pointerId)) {
            current.handle.releasePointerCapture(current.pointerId);
        }
    }, []);
    useEffect(() => () => cancel(false), [columns, widths, onColumnWidthChange, cancel]);
    useEffect(() => {
        const blur = () => cancel();
        window.addEventListener('blur', blur);
        return () => window.removeEventListener('blur', blur);
    }, [cancel]);

    return (
        <div
            className="files-list-columns grid shrink-0 items-center border-b border-app-border/30 text-xs text-app-muted"
            onClick={(event) => event.stopPropagation()}
        >
            {columns.map((column) => (
                <div
                    key={column}
                    className={cn(
                        `files-list-column-${column}`,
                        'relative min-w-0',
                        column === 'name' && 'files-name-heading',
                    )}
                >
                    <Tooltip
                        content={fileListSortTooltip(column, sortColumn, sortDirection)}
                        position="bottom"
                    >
                        <button
                            type="button"
                            aria-label={fileListSortTooltip(column, sortColumn, sortDirection)}
                            aria-pressed={column === sortColumn}
                            className={cn(
                                'h-8 w-full min-w-0 text-left hover:bg-app-surface/30 hover:text-app-text focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-control-focus',
                                column === 'name' ? 'pl-0 pr-3' : 'pl-2 pr-3',
                                column === sortColumn && 'text-app-text',
                            )}
                            onClick={() => onSort(column)}
                        >
                            <span
                                className={cn(
                                    'flex min-w-0 items-center gap-1',
                                    FILE_LIST_COLUMN_ALIGN[column] === 'right' && 'justify-end',
                                )}
                            >
                                <span className="truncate">{FILE_LIST_COLUMN_LABELS[column]}</span>
                                {column === sortColumn &&
                                    (sortDirection === 'asc' ? (
                                        <ArrowUp
                                            size={12}
                                            aria-hidden="true"
                                        />
                                    ) : (
                                        <ArrowDown
                                            size={12}
                                            aria-hidden="true"
                                        />
                                    ))}
                            </span>
                        </button>
                    </Tooltip>
                    <div
                        role="separator"
                        tabIndex={0}
                        aria-orientation="vertical"
                        aria-label={`Resize ${FILE_LIST_COLUMN_LABELS[column]} column`}
                        aria-valuemin={FILE_LIST_COLUMN_MIN[column]}
                        aria-valuemax={FILE_LIST_COLUMN_MAX}
                        aria-valuenow={widths[column]}
                        title="Drag to resize. Arrow keys adjust width; Home resets it."
                        className="files-column-resizer"
                        data-file-column-resizer={column}
                        onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                        }}
                        onDoubleClick={(event) => {
                            event.stopPropagation();
                            onColumnWidthChange(column, FILE_LIST_COLUMN_WIDTHS[column]);
                        }}
                        onPointerDown={(event) => {
                            if (event.button !== 0 || drag.current) {
                                return;
                            }
                            event.preventDefault();
                            event.stopPropagation();
                            const canvas =
                                event.currentTarget.closest<HTMLElement>('.files-listing')!;
                            drag.current = {
                                column,
                                pointerId: event.pointerId,
                                startX: event.clientX,
                                startWidth: widths[column],
                                width: widths[column],
                                rem:
                                    parseFloat(
                                        getComputedStyle(document.documentElement).fontSize,
                                    ) || 16,
                                canvas,
                                handle: event.currentTarget,
                                columns,
                                widths,
                                tracks: canvas.style.getPropertyValue('--files-list-columns'),
                                canvasWidth: canvas.style.getPropertyValue('--files-list-width'),
                            };
                            event.currentTarget.focus({ preventScroll: true });
                            event.currentTarget.setPointerCapture(event.pointerId);
                        }}
                        onPointerMove={(event) => {
                            const current = drag.current;
                            if (!current || current.pointerId !== event.pointerId) {
                                return;
                            }
                            current.width = fileListColumnWidth(
                                current.column,
                                current.startWidth + (event.clientX - current.startX) / current.rem,
                            );
                            if (frame.current === null) {
                                frame.current = requestAnimationFrame(preview);
                            }
                        }}
                        onPointerUp={(event) => {
                            const current = drag.current;
                            if (!current || current.pointerId !== event.pointerId) {
                                return;
                            }
                            current.width = fileListColumnWidth(
                                current.column,
                                current.startWidth + (event.clientX - current.startX) / current.rem,
                            );
                            if (frame.current !== null) {
                                cancelAnimationFrame(frame.current);
                            }
                            preview();
                            cancel(false);
                            if (current.width !== current.startWidth) {
                                onColumnWidthChange(current.column, current.width);
                            }
                        }}
                        onPointerCancel={() => cancel()}
                        onLostPointerCapture={() => cancel()}
                        onKeyDown={(event) => {
                            if (event.key === 'Escape' && drag.current) {
                                event.preventDefault();
                                event.stopPropagation();
                                cancel();
                                return;
                            }
                            if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) {
                                return;
                            }
                            event.preventDefault();
                            event.stopPropagation();
                            onColumnWidthChange(
                                column,
                                event.key === 'Home'
                                    ? FILE_LIST_COLUMN_WIDTHS[column]
                                    : fileListColumnWidth(
                                          column,
                                          widths[column] +
                                              (event.key === 'ArrowRight' ? 1 : -1) *
                                                  (event.shiftKey ? 4 : 1),
                                      ),
                            );
                        }}
                    />
                </div>
            ))}
        </div>
    );
}
