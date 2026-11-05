import type { UnlistenFn } from '@tauri-apps/api/event';

/** Run native teardown immediately and consume both synchronous and async bridge failures. */
export function disposeTauriListener(
    unlisten: UnlistenFn,
    reportError: (error: unknown) => void,
): void {
    try {
        // The bridge implementation is async even where its declaration returns void.
        void Promise.resolve(unlisten()).catch(reportError);
    } catch (error) {
        reportError(error);
    }
}
