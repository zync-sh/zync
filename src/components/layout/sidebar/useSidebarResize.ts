import { useCallback, useEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from 'react';

const clampWidth = (width: number) => Math.max(200, Math.min(Number.isFinite(width) ? width : 288, 600));

export function useSidebarResize(savedWidth: number, onCommit: (width: number) => void) {
    const [width, setWidth] = useState(clampWidth(savedWidth));
    const [isResizing, setIsResizing] = useState(false);
    const widthRef = useRef(width);
    const commitRef = useRef(onCommit);
    commitRef.current = onCommit;
    const drag = useRef<{ node: HTMLDivElement; pointerId: number; left: number; cursor: string } | null>(null);
    const frame = useRef(0);
    const finish = useCallback((commit: boolean) => {
        const current = drag.current;
        if (!current) return;
        drag.current = null;
        cancelAnimationFrame(frame.current);
        frame.current = 0;
        if (current.node.hasPointerCapture(current.pointerId)) current.node.releasePointerCapture(current.pointerId);
        document.body.style.cursor = current.cursor;
        setIsResizing(false);
        setWidth(widthRef.current);
        if (commit) commitRef.current(widthRef.current);
        window.dispatchEvent(new CustomEvent('zync:layout-transition-end'));
    }, []);
    useEffect(() => {
        if (drag.current) return;
        widthRef.current = clampWidth(savedWidth);
        setWidth(widthRef.current);
    }, [savedWidth]);
    useEffect(() => {
        const onBlur = () => finish(true);
        window.addEventListener('blur', onBlur);
        return () => { window.removeEventListener('blur', onBlur); finish(false); };
    }, [finish]);
    const handlers = {
        onPointerDown(event: PointerEvent<HTMLDivElement>) {
            if (drag.current || event.button !== 0 || !event.isPrimary) return;
            event.preventDefault();
            const node = event.currentTarget;
            node.setPointerCapture(event.pointerId);
            drag.current = { node, pointerId: event.pointerId, left: node.parentElement?.getBoundingClientRect().left ?? 0, cursor: document.body.style.cursor };
            document.body.style.cursor = 'col-resize';
            setIsResizing(true);
            window.dispatchEvent(new CustomEvent('zync:layout-transition-start'));
        },
        onPointerMove(event: PointerEvent<HTMLDivElement>) {
            if (!drag.current || drag.current.pointerId !== event.pointerId) return;
            widthRef.current = clampWidth(event.clientX - drag.current.left);
            if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; setWidth(widthRef.current); });
        },
        onPointerUp(event: PointerEvent<HTMLDivElement>) { if (drag.current?.pointerId === event.pointerId) finish(true); },
        onPointerCancel(event: PointerEvent<HTMLDivElement>) { if (drag.current?.pointerId === event.pointerId) finish(true); },
        onLostPointerCapture(event: PointerEvent<HTMLDivElement>) { if (drag.current?.pointerId === event.pointerId) finish(true); },
        onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
            const next = event.key === 'ArrowLeft' ? widthRef.current - 16 : event.key === 'ArrowRight' ? widthRef.current + 16 : event.key === 'Home' ? 200 : event.key === 'End' ? 600 : null;
            if (next === null) return;
            event.preventDefault();
            widthRef.current = clampWidth(next);
            setWidth(widthRef.current);
            commitRef.current(widthRef.current);
        },
    };
    return { width, isResizing, handlers };
}
