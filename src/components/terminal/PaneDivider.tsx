import {
    type CSSProperties,
    type KeyboardEvent as ReactKeyboardEvent,
    type PointerEvent as ReactPointerEvent,
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from 'react';

import {
    MIN_PANE_RATIO,
    type SplitDirection,
    splitSashStyle,
    wheelAxisDelta,
    wheelDeltaToRatio,
} from '../../lib/paneLayout';
import { beginPaneDividerDrag, endPaneDividerDrag } from '../../lib/terminal/terminalFit';
import { cn } from '../../lib/utils';

const KEY_STEP = 0.05;
const WHEEL_SETTLE_MS = 140;

/** Shared split/region sash. Ratios are coordinates within the addressed frame, not resource identities. */
export function PaneDivider({
    direction,
    firstRatio,
    onDragStart,
    onDrag,
    onDragEnd,
    onKeyCommit,
    onEqualize,
    onCancel,
    frameSelector = '[data-pane-split]',
    minRatio = MIN_PANE_RATIO,
    maxRatio = 1 - MIN_PANE_RATIO,
    label = 'Resize panes',
    title = 'Drag, scroll, or arrow keys to resize · double-click or Enter to even panes',
    valueText,
    style,
}: {
    direction: SplitDirection;
    firstRatio: number;
    onDragStart?: () => void;
    onDrag: (firstRatio: number) => void;
    /** Returning false rejects the draft and restores the next input's baseline. */
    onDragEnd: () => boolean | void;
    /** Arrow keys: commit after onDrag without the pointer/wheel immediate-flush path. */
    onKeyCommit?: () => boolean | void;
    onEqualize: () => void;
    /** Optional draft rollback; pointer cancellation otherwise retains legacy commit behavior. */
    onCancel?: () => void;
    frameSelector?: string;
    minRatio?: number;
    maxRatio?: number;
    label?: string;
    title?: string;
    valueText?: string;
    style?: CSSProperties;
}) {
    const dragging = useRef(false);
    const pointerCapture = useRef<{ node: HTMLDivElement; id: number } | null>(null);
    const dragHold = useRef<ReturnType<typeof beginPaneDividerDrag> | null>(null);
    const wheelHold = useRef<ReturnType<typeof beginPaneDividerDrag> | null>(null);
    const wheelHeld = useRef(false);
    const wheelTimer = useRef<ReturnType<Window['setTimeout']> | null>(null);
    const firstRatioRef = useRef(firstRatio);
    const previousRatio = useRef(firstRatio);
    const interactionOrigin = useRef(firstRatio);
    const onDragRef = useRef(onDrag);
    const onDragStartRef = useRef(onDragStart);
    const onDragEndRef = useRef(onDragEnd);
    const onCancelRef = useRef(onCancel);
    const boundsRef = useRef({ minRatio, maxRatio });

    useLayoutEffect(() => {
        // A held-state render can precede a coalesced parent preview. Do not lose
        // input accumulated since the last actual controlled-value update.
        if (previousRatio.current !== firstRatio) {
            firstRatioRef.current = firstRatio;
        }
        previousRatio.current = firstRatio;
        onDragRef.current = onDrag;
        onDragStartRef.current = onDragStart;
        onDragEndRef.current = onDragEnd;
        onCancelRef.current = onCancel;
        boundsRef.current = { minRatio, maxRatio };
    });
    const nodeRef = useRef<HTMLDivElement>(null);
    const [held, setHeld] = useState(false);
    const listeners = useRef<{
        move: (event: globalThis.PointerEvent) => void;
        up: (event: globalThis.PointerEvent) => void;
        cancel: (event: globalThis.PointerEvent) => void;
    } | null>(null);

    const stopDrag = useCallback((commit: boolean) => {
        if (!dragging.current) {
            return;
        }
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
            window.removeEventListener('pointercancel', listeners.current.cancel, true);
            listeners.current = null;
        }
        endPaneDividerDrag(dragHold.current);
        dragHold.current = null;
        if (commit) {
            if (onDragEndRef.current() === false) {
                firstRatioRef.current = interactionOrigin.current;
            }
        } else if (onCancelRef.current) {
            firstRatioRef.current = interactionOrigin.current;
            onCancelRef.current();
        }
        window.dispatchEvent(new Event('zync:pane-resize-end'));
    }, []);

    const finishWheel = useCallback((commit: boolean) => {
        if (wheelTimer.current != null) {
            window.clearTimeout(wheelTimer.current);
            wheelTimer.current = null;
        }
        if (!wheelHeld.current) {
            return;
        }
        wheelHeld.current = false;
        setHeld(false);
        endPaneDividerDrag(wheelHold.current);
        wheelHold.current = null;
        if (commit) {
            if (onDragEndRef.current() === false) {
                firstRatioRef.current = interactionOrigin.current;
            }
            window.dispatchEvent(new Event('zync:pane-resize-end'));
        } else if (onCancelRef.current) {
            firstRatioRef.current = interactionOrigin.current;
            onCancelRef.current();
        }
    }, []);

    useEffect(
        () => () => {
            stopDrag(false);
            finishWheel(false);
        },
        [stopDrag, finishWheel],
    );

    useEffect(() => {
        /** End active resizing on blur, rolling back when cancellation is available. */
        const onBlur = () => {
            stopDrag(!onCancelRef.current);
            finishWheel(!onCancelRef.current);
        };
        /** Cancel an eligible resize before Escape reaches another focused control. */
        const onEscape = (event: globalThis.KeyboardEvent) => {
            // Wheel resizing can leave another main-document control focused.
            // Only an active, rollback-capable sash owns Escape.
            if (
                event.key !== 'Escape' ||
                !onCancelRef.current ||
                (!dragging.current && !wheelHeld.current)
            ) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            stopDrag(false);
            finishWheel(false);
        };
        window.addEventListener('blur', onBlur);
        window.addEventListener('keydown', onEscape, true);
        return () => {
            window.removeEventListener('blur', onBlur);
            window.removeEventListener('keydown', onEscape, true);
        };
    }, [stopDrag, finishWheel]);

    const changeRatio = useCallback((ratio: number) => {
        if (!Number.isFinite(ratio)) {
            return;
        }
        const bounded = Math.max(
            boundsRef.current.minRatio,
            Math.min(boundsRef.current.maxRatio, ratio),
        );
        // Wheel/key events may arrive before the coalesced preview render.
        firstRatioRef.current = bounded;
        onDragRef.current(bounded);
    }, []);

    useEffect(() => {
        const node = nodeRef.current;
        if (!node) {
            return undefined;
        }

        /** Preview wheel-driven ratios and commit once the wheel burst settles. */
        const onWheel = (event: WheelEvent) => {
            if (event.ctrlKey || event.metaKey) {
                return;
            }
            if (dragging.current) {
                return;
            }
            const stacked = direction === 'vertical';
            const axis = wheelAxisDelta(event.deltaX, event.deltaY, stacked);
            const step = wheelDeltaToRatio(axis, event.deltaMode);
            if (step === 0) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            if (!wheelHeld.current) {
                interactionOrigin.current = firstRatioRef.current;
                wheelHeld.current = true;
                setHeld(true);
                onDragStartRef.current?.();
                wheelHold.current = beginPaneDividerDrag();
            }
            changeRatio(firstRatioRef.current + step);
            if (wheelTimer.current != null) {
                window.clearTimeout(wheelTimer.current);
            }
            wheelTimer.current = window.setTimeout(() => finishWheel(true), WHEEL_SETTLE_MS);
        };

        node.addEventListener('wheel', onWheel, { passive: false });
        return () => node.removeEventListener('wheel', onWheel);
    }, [direction, finishWheel, changeRatio]);

    const onPointerDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            if (event.button !== 0 || !event.isPrimary) {
                return;
            }
            event.preventDefault();
            if (event.detail >= 2) {
                finishWheel(false);
                stopDrag(false);
                onEqualize();
                return;
            }
            const frame = event.currentTarget.closest(frameSelector);
            if (!(frame instanceof HTMLElement)) {
                return;
            }
            // Keyboard events inside plugin iframes do not bubble to the host. Focus
            // an opted-in draft handle so Escape remains reachable during its drag.
            if (onCancelRef.current) {
                event.currentTarget.focus({ preventScroll: true });
            }
            finishWheel(false);
            stopDrag(false);
            interactionOrigin.current = firstRatioRef.current;
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

            /** Preview the owning pointer's ratio within the captured frame bounds. */
            const onMove = (move: globalThis.PointerEvent) => {
                if (!dragging.current || move.pointerId !== event.pointerId || startSize <= 0) {
                    return;
                }
                move.preventDefault();
                const pos = vertical ? move.clientY : move.clientX;
                const origin = vertical ? startRect.top : startRect.left;
                const ratio = (pos - origin) / startSize;
                changeRatio(ratio);
            };
            /** Commit the resize only when its owning pointer is released. */
            const onUp = (up: globalThis.PointerEvent) => {
                if (up.pointerId === event.pointerId) {
                    stopDrag(true);
                }
            };
            /** End a cancelled pointer gesture, rolling back when cancellation is available. */
            const onCancel = (cancel: globalThis.PointerEvent) => {
                if (cancel.pointerId === event.pointerId) {
                    stopDrag(!onCancelRef.current);
                }
            };
            listeners.current = { move: onMove, up: onUp, cancel: onCancel };
            window.addEventListener('pointermove', onMove, { capture: true });
            window.addEventListener('pointerup', onUp, { capture: true });
            window.addEventListener('pointercancel', onCancel, { capture: true });
        },
        [direction, finishWheel, onEqualize, stopDrag, frameSelector, changeRatio],
    );

    const onKeyDown = useCallback(
        (event: ReactKeyboardEvent<HTMLDivElement>) => {
            if (
                event.key === 'Escape' &&
                onCancelRef.current &&
                (dragging.current || wheelHeld.current)
            ) {
                event.preventDefault();
                event.stopPropagation();
                stopDrag(false);
                finishWheel(false);
                return;
            }
            if (event.key === 'Enter' || event.key === 'Home') {
                event.preventDefault();
                stopDrag(false);
                finishWheel(false);
                onEqualize();
                return;
            }
            const stacked = direction === 'vertical';
            const delta = stacked
                ? event.key === 'ArrowDown'
                    ? KEY_STEP
                    : event.key === 'ArrowUp'
                      ? -KEY_STEP
                      : 0
                : event.key === 'ArrowRight'
                  ? KEY_STEP
                  : event.key === 'ArrowLeft'
                    ? -KEY_STEP
                    : 0;
            if (delta === 0) {
                return;
            }
            event.preventDefault();
            const origin = firstRatioRef.current;
            changeRatio(firstRatioRef.current + delta);
            if ((onKeyCommit ?? onDragEnd)() === false) {
                firstRatioRef.current = origin;
            }
        },
        [direction, changeRatio, onDragEnd, onKeyCommit, onEqualize, stopDrag, finishWheel],
    );

    const stacked = direction === 'vertical';
    const valueNow = Math.round(firstRatio * 100);
    return (
        <div
            ref={nodeRef}
            role="separator"
            tabIndex={0}
            data-pane-sash=""
            aria-orientation={stacked ? 'horizontal' : 'vertical'}
            aria-valuemin={Math.round(minRatio * 100)}
            aria-valuemax={Math.round(maxRatio * 100)}
            aria-valuenow={valueNow}
            aria-valuetext={valueText}
            aria-label={label}
            title={title}
            onPointerDown={onPointerDown}
            onLostPointerCapture={() => stopDrag(!onCancelRef.current)}
            onKeyDown={onKeyDown}
            style={{ ...splitSashStyle(stacked, firstRatio), ...style }}
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
