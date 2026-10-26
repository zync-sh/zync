import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

export type FinishConnectionFocus = (connected: boolean) => void;
export type BeginConnectionFocus = (source: HTMLElement) => FinishConnectionFocus;

/** Hand focus from an explicit connect action to its live controls only while this surface still owns it. */
export function useConnectionFocus(connected: boolean, target: RefObject<HTMLElement | null>, connectionId: string, active = true): BeginConnectionFocus {
    const request = useRef<{ source: HTMLElement; connectionId: string; dispose(): void } | null>(null);
    const clear = useCallback(() => { request.current?.dispose(); request.current = null; }, []);
    useEffect(() => clear, [clear, connectionId]);

    useLayoutEffect(() => {
        if (!request.current) return;
        if (!active || request.current.connectionId !== connectionId) { clear(); return; }
        if (!connected) return;
        const { source } = request.current;
        const document = source.ownerDocument;
        const activeElement = document.activeElement;
        const destination = target.current;
        if ((!activeElement || activeElement === document.body || source.contains(activeElement)) && destination?.isConnected && destination.getClientRects().length) {
            destination.focus({ preventScroll: true });
        }
        clear();
    }, [connected, target, clear, connectionId, active]);

    return useCallback(source => {
        clear();
        const document = source.ownerDocument;
        if (!active || !source.contains(document.activeElement)) return () => {};
        // An intentional move to another control/pane relinquishes this one-shot focus request.
        const outside = (event: Event) => {
            if (event.target instanceof Node && !source.contains(event.target) && (event.type !== 'focusin' || event.target !== document.body)) clear();
        };
        const blur = () => clear();
        document.addEventListener('focusin', outside, true);
        document.addEventListener('pointerdown', outside, true);
        document.defaultView?.addEventListener('blur', blur);
        const current = { source, connectionId, dispose: () => {
            document.removeEventListener('focusin', outside, true);
            document.removeEventListener('pointerdown', outside, true);
            document.defaultView?.removeEventListener('blur', blur);
        } };
        request.current = current;
        // A successful attempt may settle before React commits its live controls; retain until that commit.
        return success => { if (!success && request.current === current) clear(); };
    }, [clear, connectionId, active]);
}
