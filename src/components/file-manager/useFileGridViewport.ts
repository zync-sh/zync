import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import { useLayoutMotion } from '../ui/LayoutMotion';
import { computeFileGridMetrics } from './fileGridLayout';
import {
    captureFileViewportAnchor,
    type FileViewportAnchor,
    fileViewportAnchorTop,
} from './fileViewportAnchor';

/** Own grid geometry and reading position for both DOM and virtualized rows. */
export function useFileGridViewport({
    enabled,
    files,
    path,
    zoom,
    rowPitch,
}: {
    enabled: boolean;
    files: readonly { name: string }[];
    path: string | undefined;
    zoom: number;
    rowPitch: number;
}) {
    const { moving } = useLayoutMotion();
    // The virtual renderer exposes its element after its own first commit. A
    // mounted-element signal also covers renderer swaps without polling a ref.
    const [viewport, setViewport] = useState<HTMLElement | null>(null);
    const [geometry, setGeometry] = useState({ columns: 1, ready: false });
    const anchor = useRef<FileViewportAnchor | null>(null);
    const expectedScroll = useRef<number | null>(null);
    const wasMoving = useRef(false);
    const live = useRef({ files, columns: geometry.columns, rowPitch });
    useLayoutEffect(() => {
        live.current = { files, columns: geometry.columns, rowPitch };
    });

    const captureAnchor = useCallback(() => {
        if (!viewport) {
            return;
        }
        const current = live.current;
        const bounds = viewport.getBoundingClientRect();
        // A row can be partially clipped or end in blank space below a short label.
        // Anchor the first visible file, rather than an invisible row above it.
        const visible = Array.from(viewport.querySelectorAll<HTMLElement>('[data-file-name]')).find(
            (node) => {
                const box = node.getBoundingClientRect();
                return box.bottom > bounds.top && box.top < bounds.bottom;
            },
        );
        const index = visible
            ? current.files.findIndex((file) => file.name === visible.dataset.fileName)
            : -1;
        anchor.current =
            index >= 0
                ? {
                      name: current.files[index].name,
                      offset:
                          viewport.scrollTop -
                          Math.floor(index / current.columns) * current.rowPitch,
                  }
                : captureFileViewportAnchor(
                      current.files,
                      current.columns,
                      current.rowPitch,
                      viewport.scrollTop,
                  );
    }, [viewport]);

    useLayoutEffect(() => {
        anchor.current = null;
        expectedScroll.current = null;
    }, [path, enabled]);

    useLayoutEffect(() => {
        // A new gesture anchors what is visible now; reversals keep the same anchor
        // until the outstanding drawer transitions have actually settled.
        const starting = moving && !wasMoving.current;
        wasMoving.current = moving;
        if (enabled && starting) {
            captureAnchor();
        }
    }, [enabled, moving, captureAnchor]);

    useLayoutEffect(() => {
        if (!enabled) {
            return;
        }
        if (!viewport) {
            return;
        }
        if (!anchor.current) {
            captureAnchor();
        }
        const measure = () => {
            // Fixed track widths stay unchanged between column boundaries. React only
            // publishes a new column count, without per-pixel state or tile animation.
            if (viewport.clientWidth <= 0) {
                return;
            }
            const columns = computeFileGridMetrics(viewport.clientWidth, false, zoom).columnCount;
            setGeometry((previous) =>
                previous.ready && previous.columns === columns
                    ? previous
                    : { columns, ready: true },
            );
        };
        const onScroll = () => {
            if (
                expectedScroll.current !== null &&
                Math.abs(viewport.scrollTop - expectedScroll.current) < 1
            ) {
                expectedScroll.current = null;
                return;
            }
            expectedScroll.current = null;
            captureAnchor();
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(viewport);
        viewport.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            observer.disconnect();
            viewport.removeEventListener('scroll', onScroll);
        };
    }, [enabled, viewport, files.length, zoom, moving, captureAnchor]);

    useLayoutEffect(() => {
        if (!enabled || !geometry.ready) {
            return;
        }
        if (!viewport) {
            return;
        }
        const target = fileViewportAnchorTop(anchor.current, files, geometry.columns, rowPitch);
        if (target === null) {
            captureAnchor();
            return;
        }
        const clamped = Math.min(
            target,
            Math.max(0, viewport.scrollHeight - viewport.clientHeight),
        );
        expectedScroll.current = clamped;
        viewport.scrollTop = clamped;
    }, [enabled, viewport, geometry, rowPitch, files, captureAnchor]);

    return {
        columnCount: geometry.columns,
        ready: geometry.ready,
        captureAnchor,
        viewport,
        setViewport,
    };
}
