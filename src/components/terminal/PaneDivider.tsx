import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { cn } from '../../lib/utils';
import { MIN_PANE_RATIO, splitSashStyle, type SplitDirection, wheelAxisDelta, wheelDeltaToRatio } from '../../lib/paneLayout';
import { beginPaneDividerDrag, endPaneDividerDrag } from '../../lib/terminal';

const KEY_STEP = 0.05;
const WHEEL_SETTLE_MS = 140;

export function PaneDivider({
    direction,
    firstRatio,
    onDragStart,
    onDrag,
    onDragEnd,
    onKeyCommit,
    onEqualize,
}: {
    direction: SplitDirection;
    firstRatio: number;
    onDragStart?: () => void;
    onDrag: (firstRatio: number) => void;
    onDragEnd: () => void;
    /** Arrow keys: commit after onDrag without the pointer/wheel immediate-flush path. */
    onKeyCommit?: () => void;
    onEqualize: () => void;
}) {
    const dragging = useRef(false);
    const pointerCapture = useRef<{ node: HTMLDivElement; id: number } | null>(null);
    const dragHold = useRef<ReturnType<typeof beginPaneDividerDrag> | null>(null);
    const wheelHold = useRef<ReturnType<typeof beginPaneDividerDrag> | null>(null);
    const wheelHeld = useRef(false);
    const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const firstRatioRef = useRef(firstRatio);
    const onDragRef = useRef(onDrag);
    const onDragStartRef = useRef(onDragStart);
    const onDragEndRef = useRef(onDragEnd);

    useLayoutEffect(() => {
        firstRatioRef.current = firstRatio;
        onDragRef.current = onDrag;
        onDragStartRef.current = onDragStart;
        onDragEndRef.current = onDragEnd;
    });
    const nodeRef = useRef<HTMLDivElement>(null);
    const [held, setHeld] = useState(false);
    const listeners = useRef<{
        move: (event: globalThis.PointerEvent) => void;
        up: () => void;
    } | null>(null);

    const stopDrag = useCallback((commit: boolean) => {
        if (!dragging.current) return;
        dragging.current = false;
        const capture = pointerCapture.current;
        pointerCapture.current = null;
        if (capture?.node.hasPointerCapture(capture.id)) {
            capture.node.releasePointerCapture(capture.id);
        }
        setHeld(false);
        if (listeners.current) {
            window.removeEventListener('pointermove', listeners.current.move, true);
            window.removeEventListener('pointerup', listeners.current.up, true);
            window.removeEventListener('pointercancel', listeners.current.up, true);
            listeners.current = null;
        }
        endPaneDividerDrag(dragHold.current);
        dragHold.current = null;
        if (commit) {
            onDragEndRef.current();
        }
        window.dispatchEvent(new Event('zync:pane-resize-end'));
    }, []);

    const finishWheel = useCallback((commit: boolean) => {
        if (wheelTimer.current != null) {
            window.clearTimeout(wheelTimer.current);
            wheelTimer.current = null;
        }
        if (!wheelHeld.current) return;
        wheelHeld.current = false;
        setHeld(false);
        endPaneDividerDrag(wheelHold.current);
        wheelHold.current = null;
        if (commit) {
            onDragEndRef.current();
            window.dispatchEvent(new Event('zync:pane-resize-end'));
        }
    }, []);

    useEffect(() => () => {
        stopDrag(false);
        finishWheel(false);
    }, [stopDrag, finishWheel]);

    useEffect(() => {
        const node = nodeRef.current;
        if (!node) return undefined;

        const onWheel = (event: WheelEvent) => {
            if (event.ctrlKey || event.metaKey) return;
            if (dragging.current) return;
            const stacked = direction === 'vertical';
            const axis = wheelAxisDelta(event.deltaX, event.deltaY, stacked);
            const step = wheelDeltaToRatio(axis, event.deltaMode);
            if (step === 0) return;
            event.preventDefault();
            event.stopPropagation();
            if (!wheelHeld.current) {
                wheelHeld.current = true;
                setHeld(true);
                onDragStartRef.current?.();
                wheelHold.current = beginPaneDividerDrag();
            }
            onDragRef.current(firstRatioRef.current + step);
            if (wheelTimer.current != null) window.clearTimeout(wheelTimer.current);
            wheelTimer.current = window.setTimeout(() => finishWheel(true), WHEEL_SETTLE_MS);
        };

        node.addEventListener('wheel', onWheel, { passive: false });
        return () => node.removeEventListener('wheel', onWheel);
    }, [direction, finishWheel]);

    const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        if (event.detail >= 2) {
            finishWheel(false);
            onEqualize();
            return;
        }
        const frame = event.currentTarget.closest('[data-pane-split]');
        if (!(frame instanceof HTMLElement)) return;
        finishWheel(false);
        stopDrag(false);
        onDragStartRef.current?.();
        dragging.current = true;
        // Keep receiving movement when the pointer crosses a plugin iframe.
        event.currentTarget.setPointerCapture(event.pointerId);
        pointerCapture.current = { node: event.currentTarget, id: event.pointerId };
        setHeld(true);
        dragHold.current = beginPaneDividerDrag();
        const vertical = direction === 'vertical';
        const startSize = vertical ? frame.clientHeight : frame.clientWidth;
        const startRect = frame.getBoundingClientRect();

        const onMove = (move: globalThis.PointerEvent) => {
            if (!dragging.current || startSize <= 0) return;
            move.preventDefault();
            const pos = vertical ? move.clientY : move.clientX;
            const origin = vertical ? startRect.top : startRect.left;
            const ratio = (pos - origin) / startSize;
            onDragRef.current(ratio);
        };
        const onUp = () => {
            stopDrag(true);
        };
        listeners.current = { move: onMove, up: onUp };
        window.addEventListener('pointermove', onMove, { capture: true });
        window.addEventListener('pointerup', onUp, { capture: true });
        window.addEventListener('pointercancel', onUp, { capture: true });
    }, [direction, finishWheel, onEqualize, stopDrag]);

    const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Enter' || event.key === 'Home') {
            event.preventDefault();
            onEqualize();
            return;
        }
        const stacked = direction === 'vertical';
        const delta =
            stacked
                ? event.key === 'ArrowDown' ? KEY_STEP : event.key === 'ArrowUp' ? -KEY_STEP : 0
                : event.key === 'ArrowRight' ? KEY_STEP : event.key === 'ArrowLeft' ? -KEY_STEP : 0;
        if (delta === 0) return;
        event.preventDefault();
        onDrag(firstRatio + delta);
        (onKeyCommit ?? onDragEnd)();
    }, [direction, firstRatio, onDrag, onDragEnd, onKeyCommit, onEqualize]);

    const stacked = direction === 'vertical';
    const valueNow = Math.round(firstRatio * 100);
    const valueMin = Math.round(MIN_PANE_RATIO * 100);
    return (
        <div
            ref={nodeRef}
            role="separator"
            tabIndex={0}
            data-pane-sash=""
            aria-orientation={stacked ? 'horizontal' : 'vertical'}
            aria-valuemin={valueMin}
            aria-valuemax={100 - valueMin}
            aria-valuenow={valueNow}
            aria-label="Resize panes"
            title="Drag, scroll, or arrow keys to resize · double-click or Enter to even panes"
            onPointerDown={onPointerDown}
            onLostPointerCapture={() => stopDrag(true)}
            onKeyDown={onKeyDown}
            style={splitSashStyle(stacked, firstRatio)}
            className={cn(
                'group absolute z-50 touch-none select-none overscroll-none pointer-events-auto',
                'outline-none focus-visible:ring-1 focus-visible:ring-app-accent',
                stacked ? 'cursor-row-resize' : 'cursor-col-resize',
            )}
        >
            <div
                className={cn(
                    'absolute transition-colors duration-150',
                    stacked
                        ? 'left-0 right-0 top-1/2 h-px -translate-y-1/2'
                        : 'top-0 bottom-0 left-1/2 w-px -translate-x-1/2',
                    held ? 'bg-app-accent' : 'bg-app-border/40 group-hover:bg-app-accent/55',
                )}
            />
        </div>
    );
}
