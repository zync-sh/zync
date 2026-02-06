import { useEffect, RefObject } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * Hook to enable window dragging for frameless Tauri windows
 * This is a JavaScript-based workaround for Linux where data-tauri-drag-region may not work reliably
 * 
 * @param ref - Ref to the element that should enable window dragging
 * @param enabled - Whether dragging should be enabled (default: true)
 */
export function useWindowDrag(ref: RefObject<HTMLElement | null>, enabled = true) {
    useEffect(() => {
        // Skip if not in Tauri environment (e.g., browser dev mode)
        if (!(window as any).__TAURI__) return;
        if (!enabled || !ref.current) return;

        const element = ref.current;
        let appWindow: any;

        try {
            appWindow = getCurrentWindow();
        } catch {
            // getCurrentWindow() failed, not in Tauri context
            return;
        }

        const handleMouseDown = async (e: MouseEvent) => {
            // Only drag on left click
            if (e.button !== 0) return;

            // Don't drag if clicking on interactive elements
            const target = e.target as HTMLElement;
            if (
                target.tagName === 'BUTTON' ||
                target.tagName === 'INPUT' ||
                target.tagName === 'SELECT' ||
                target.tagName === 'TEXTAREA' ||
                target.closest('button') ||
                target.closest('input') ||
                target.closest('select') ||
                target.closest('textarea') ||
                target.closest('[data-no-drag]') ||
                target.hasAttribute('data-tauri-drag-region') === false ||
                target.classList.contains('drag-none')
            ) {
                return;
            }

            try {
                await appWindow.startDragging();
            } catch (error) {
                console.error('Failed to start window drag:', error);
            }
        };

        element.addEventListener('mousedown', handleMouseDown);

        return () => {
            element.removeEventListener('mousedown', handleMouseDown);
        };
    }, [ref, enabled]);
}
