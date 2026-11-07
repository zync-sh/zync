import { type EventCallback, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { disposeTauriListener } from '../lib/tauriListeners.js';

/** Own native registrations, releasing late listeners and partially installed groups. */
export function registerFileDropListeners(
    onDrop: (paths: string[]) => void,
    setDragging: (dragging: boolean) => void,
    register: typeof listen = listen,
): () => void {
    let alive = true;
    let duplicateTimer: ReturnType<typeof setTimeout> | undefined;
    const unlisteners: UnlistenFn[] = [];
    /** Deliver a drop once when primary and fallback native notifications overlap. */
    const drop = (paths: string[]) => {
        if (!alive || duplicateTimer !== undefined) {
            return;
        }
        duplicateTimer = setTimeout(() => {
            duplicateTimer = undefined;
        }, 500);
        setDragging(false);
        if (paths?.length) {
            onDrop(paths);
        }
    };
    /** Keep a registration only while its original effect owner is still mounted. */
    const add = async <T>(name: string, handler: EventCallback<T>): Promise<boolean> => {
        if (!alive) {
            return false;
        }
        const unlisten = await register<T>(name, handler);
        if (!alive) {
            await unlisten();
            return false;
        }
        unlisteners.push(unlisten);
        return true;
    };
    /** Release every acquired listener and the duplicate timer, including failed setup. */
    const dispose = () => {
        alive = false;
        clearTimeout(duplicateTimer);
        duplicateTimer = undefined;
        for (const unlisten of unlisteners.splice(0)) {
            disposeTauriListener(unlisten, (error) =>
                console.warn('[DnD] listener cleanup failed', error),
            );
        }
    };
    /** Stop after disposal and unwind already acquired listeners on any setup failure. */
    const setup = async () => {
        if (!(await add<string[]>('zync://file-drop', (event) => drop(event.payload)))) {
            return;
        }
        if (
            !(await add('zync://drag-enter', () => {
                if (alive) {
                    setDragging(true);
                }
            }))
        ) {
            return;
        }
        if (
            !(await add('zync://drag-leave', () => {
                if (alive) {
                    setDragging(false);
                }
            }))
        ) {
            return;
        }
        if (
            !(await add<{ paths: string[] }>('tauri://drop', (event) => drop(event.payload.paths)))
        ) {
            return;
        }
        if (
            !(await add<{ paths: string[] }>('tauri://drag-drop', (event) =>
                drop(event.payload.paths),
            ))
        ) {
            return;
        }
        if (
            !(await add('tauri://drag-enter', () => {
                if (alive) {
                    setDragging(true);
                }
            }))
        ) {
            return;
        }
        await add('tauri://drag-leave', () => {
            if (alive) {
                setDragging(false);
            }
        });
    };
    void setup().catch((error) => {
        if (alive) {
            setDragging(false);
        }
        dispose();
        console.warn('[DnD] listener setup failed', error);
    });
    return dispose;
}

/** Use the latest committed drop callback without rebuilding native listeners. */
export function useTauriFileDrop(onDrop: (paths: string[]) => void) {
    const [isDraggingOver, setIsDraggingOver] = useState(false);
    const onDropRef = useRef(onDrop);
    useLayoutEffect(() => {
        onDropRef.current = onDrop;
    }, [onDrop]);
    useEffect(
        () => registerFileDropListeners((paths) => onDropRef.current(paths), setIsDraggingOver),
        [],
    );
    return { isDraggingOver };
}
