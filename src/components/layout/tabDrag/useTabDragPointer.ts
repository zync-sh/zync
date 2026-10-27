import { type PointerEvent, useCallback, useEffect, useRef } from 'react';

import { beginTabDrag } from './pointerSession';
import type { DragPoint, TabDragSession } from './types';

export type PrepareTabDrag<T> = (
    target: Element,
    payload: T,
    origin: DragPoint,
) => TabDragSession | null;

/** React lifetime adapter; pointer handling is shared by every draggable tab. */
export function useTabDragPointer<T>(prepare: PrepareTabDrag<T>) {
    const prepareRef = useRef(prepare);
    prepareRef.current = prepare;
    const cleanupRef = useRef<(() => void) | null>(null);
    const skipClick = useRef(false);
    const clearTimer = useRef<ReturnType<Window['setTimeout']> | null>(null);
    useEffect(
        () => () => {
            cleanupRef.current?.();
            if (clearTimer.current !== null) {
                window.clearTimeout(clearTimer.current);
            }
        },
        [],
    );
    const consumeClickIfDragged = useCallback(() => {
        const result = skipClick.current;
        skipClick.current = false;
        return result;
    }, []);
    const begin = useCallback((event: PointerEvent, payload: T) => {
        if (event.button !== 0 || !event.isPrimary) {
            return;
        }
        if (
            event.target instanceof Element &&
            event.target.closest(
                'button:not([data-workspace-tab-trigger]), a, input, textarea, select, [contenteditable="true"], [data-tab-drag-ignore]',
            )
        ) {
            return;
        }
        const session = prepareRef.current(event.currentTarget, payload, {
            x: event.clientX,
            y: event.clientY,
        });
        if (!session) {
            return;
        }
        cleanupRef.current?.();
        cleanupRef.current = beginTabDrag(event, session, () => {
            skipClick.current = true;
            if (clearTimer.current !== null) {
                window.clearTimeout(clearTimer.current);
            }
            clearTimer.current = window.setTimeout(() => {
                skipClick.current = false;
                clearTimer.current = null;
            }, 0);
        });
    }, []);
    return { begin, consumeClickIfDragged };
}
