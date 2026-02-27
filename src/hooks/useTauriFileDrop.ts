import { useEffect, useState, useRef } from 'react';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

export function useTauriFileDrop(onDrop: (paths: string[]) => void) {
    const [isDraggingOver, setIsDraggingOver] = useState(false);
    const onDropRef = useRef(onDrop);
    onDropRef.current = onDrop;

    useEffect(() => {
        let alive = true;
        let dropHandled = false; // Prevent duplicate uploads when both zync:// and tauri:// fire
        const unlisteners: UnlistenFn[] = [];

        const setup = async () => {
            // Primary: custom events emitted from Rust's on_window_event (reliable across platforms)
            const u1 = await listen<string[]>('zync://file-drop', (event) => {
                if (!alive || dropHandled) return;
                dropHandled = true;
                setTimeout(() => { dropHandled = false; }, 500);
                console.log('[DnD] zync://file-drop', event.payload);
                setIsDraggingOver(false);
                const paths = event.payload;
                if (paths && paths.length > 0) {
                    onDropRef.current(paths);
                }
            });
            if (alive) unlisteners.push(u1);

            const u2 = await listen<string[]>('zync://drag-enter', () => {
                if (!alive) return;
                setIsDraggingOver(true);
            });
            if (alive) unlisteners.push(u2);

            const u3 = await listen('zync://drag-leave', () => {
                if (!alive) return;
                setIsDraggingOver(false);
            });
            if (alive) unlisteners.push(u3);

            // Fallback: tauri:// built-in events (may not fire on all platforms)
            const u4 = await listen<{ paths: string[] }>('tauri://drop', (event) => {
                if (!alive || dropHandled) return;
                dropHandled = true;
                setTimeout(() => { dropHandled = false; }, 500);
                console.log('[DnD] tauri://drop (fallback)', event.payload);
                setIsDraggingOver(false);
                if (event.payload.paths && event.payload.paths.length > 0) {
                    onDropRef.current(event.payload.paths);
                }
            });
            if (alive) unlisteners.push(u4);

            const u5 = await listen('tauri://drag-enter', () => {
                if (!alive) return;
                setIsDraggingOver(true);
            });
            if (alive) unlisteners.push(u5);

            const u6 = await listen('tauri://drag-leave', () => {
                if (!alive) return;
                setIsDraggingOver(false);
            });
            if (alive) unlisteners.push(u6);
        };

        setup();

        return () => {
            alive = false;
            unlisteners.forEach(fn => fn());
        };
    }, []);

    return { isDraggingOver };
}
