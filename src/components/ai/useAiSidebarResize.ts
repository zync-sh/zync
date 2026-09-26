import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';

const MIN_SIDEBAR_WIDTH = 250;
const MAX_SIDEBAR_WIDTH = 800;
const DEFAULT_SIDEBAR_WIDTH = 300;
const SIDEBAR_WIDTH_STORAGE_KEY = 'zync-ai-sidebar-width';

export function clampAiSidebarWidth(width: number): number {
    return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width));
}

export function useAiSidebarResize() {
    const [width, setWidth] = useState(() => {
        try {
            const stored = Number.parseInt(
                localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY) || `${DEFAULT_SIDEBAR_WIDTH}`,
                10,
            );
            const resolved = Number.isFinite(stored) ? stored : DEFAULT_SIDEBAR_WIDTH;
            return clampAiSidebarWidth(resolved);
        } catch {
            return clampAiSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
        }
    });
    const [isAnimating, setIsAnimating] = useState(false);
    const [skipAnimation, setSkipAnimation] = useState(false);
    const sidebarOuterRef = useRef<HTMLElement>(null);
    const sidebarInnerRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ node: HTMLDivElement; pointerId: number; startX: number; startWidth: number; liveWidth: number; cursor: string } | null>(null);
    const paintFrameRef = useRef(0);
    const animationFrameRef = useRef(0);

    const paintWidth = useCallback((nextWidth: number) => {
        if (sidebarOuterRef.current) sidebarOuterRef.current.style.width = `${nextWidth}px`;
        if (sidebarInnerRef.current) sidebarInnerRef.current.style.width = `${nextWidth}px`;
    }, []);

    const finishDrag = useCallback((commit: boolean) => {
        const drag = dragRef.current;
        if (!drag) return;
        dragRef.current = null;
        cancelAnimationFrame(paintFrameRef.current);
        paintFrameRef.current = 0;
        if (drag.node.hasPointerCapture(drag.pointerId)) drag.node.releasePointerCapture(drag.pointerId);
        document.body.style.cursor = drag.cursor;
        if (commit) {
            paintWidth(drag.liveWidth);
            setWidth(drag.liveWidth);
            try { localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(drag.liveWidth)); } catch { /* Resize still works when storage is unavailable. */ }
            cancelAnimationFrame(animationFrameRef.current);
            animationFrameRef.current = requestAnimationFrame(() => setSkipAnimation(false));
        }
        window.dispatchEvent(new CustomEvent('zync:layout-transition-end'));
    }, [paintWidth]);

    useEffect(() => {
        const onBlur = () => finishDrag(true);
        window.addEventListener('blur', onBlur);
        return () => {
            window.removeEventListener('blur', onBlur);
            finishDrag(false);
            cancelAnimationFrame(animationFrameRef.current);
        };
    }, [finishDrag]);

    const resizeHandlers = {
        onPointerDown(event: PointerEvent<HTMLDivElement>) {
            if (dragRef.current || event.button !== 0 || !event.isPrimary) return;
            event.preventDefault();
            const node = event.currentTarget;
            node.setPointerCapture(event.pointerId);
            dragRef.current = { node, pointerId: event.pointerId, startX: event.clientX, startWidth: width, liveWidth: width, cursor: document.body.style.cursor };
            cancelAnimationFrame(animationFrameRef.current);
            setSkipAnimation(true);
            document.body.style.cursor = 'col-resize';
            window.dispatchEvent(new CustomEvent('zync:layout-transition-start'));
        },
        onPointerMove(event: PointerEvent<HTMLDivElement>) {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            drag.liveWidth = clampAiSidebarWidth(drag.startWidth + drag.startX - event.clientX);
            if (!paintFrameRef.current) paintFrameRef.current = requestAnimationFrame(() => {
                paintFrameRef.current = 0;
                if (dragRef.current) paintWidth(dragRef.current.liveWidth);
            });
        },
        onPointerUp(event: PointerEvent<HTMLDivElement>) { if (dragRef.current?.pointerId === event.pointerId) finishDrag(true); },
        onPointerCancel(event: PointerEvent<HTMLDivElement>) { if (dragRef.current?.pointerId === event.pointerId) finishDrag(true); },
        onLostPointerCapture(event: PointerEvent<HTMLDivElement>) { if (dragRef.current?.pointerId === event.pointerId) finishDrag(true); },
    };

    const transition = skipAnimation
        ? { duration: 0 }
        : { type: 'spring' as const, stiffness: 400, damping: 40, mass: 0.7 };

    const handleAnimationStart = useCallback(() => {
        setIsAnimating(true);
        window.dispatchEvent(new CustomEvent('zync:layout-transition-start'));
    }, []);

    const handleAnimationComplete = useCallback(() => {
        setIsAnimating(false);
        window.dispatchEvent(new CustomEvent('zync:layout-transition-end'));
    }, []);

    return {
        width,
        isAnimating,
        transition,
        sidebarOuterRef,
        sidebarInnerRef,
        resizeHandlers,
        handleAnimationStart,
        handleAnimationComplete,
    };
}
