import { useCallback, useEffect, useRef, useState } from 'react';

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
    const dragMoveRef = useRef<((event: MouseEvent) => void) | null>(null);
    const dragUpRef = useRef<(() => void) | null>(null);

    useEffect(() => () => {
        if (dragMoveRef.current) document.removeEventListener('mousemove', dragMoveRef.current);
        if (dragUpRef.current) document.removeEventListener('mouseup', dragUpRef.current);
    }, []);

    const handleMouseDown = useCallback((event: React.MouseEvent) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = width;
        let liveWidth = startWidth;

        const onMove = (moveEvent: MouseEvent) => {
            liveWidth = clampAiSidebarWidth(startWidth + (startX - moveEvent.clientX));
            if (sidebarOuterRef.current) sidebarOuterRef.current.style.width = `${liveWidth}px`;
            if (sidebarInnerRef.current) sidebarInnerRef.current.style.width = `${liveWidth}px`;
        };

        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            dragMoveRef.current = null;
            dragUpRef.current = null;
            setSkipAnimation(true);
            setWidth(liveWidth);
            localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(liveWidth));
            requestAnimationFrame(() => setSkipAnimation(false));
            window.dispatchEvent(new CustomEvent('zync:layout-transition-end'));
        };

        dragMoveRef.current = onMove;
        dragUpRef.current = onUp;
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }, [width]);

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
        handleMouseDown,
        handleAnimationStart,
        handleAnimationComplete,
    };
}
