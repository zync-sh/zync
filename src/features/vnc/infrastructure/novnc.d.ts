/** The subset of the pinned noVNC 1.7 public API used by the desktop pane. */
declare module '@novnc/novnc' {
    export default class RFB {
        constructor(
            target: HTMLElement,
            transport: string | WebSocket,
            options?: { shared?: boolean },
        );
        resizeSession: boolean;
        scaleViewport: boolean;
        /** Fixed local scale factor. Null restores normal noVNC scaling. */
        viewportScale: number | null;
        /** Zync's bundled source patch adds protocol-level framebuffer suspension. */
        updatesPaused: boolean;
        viewOnly: boolean;
        blur(): void;
        disconnect(): void;
        addEventListener(type: string, listener: (event: Event) => void): void;
        removeEventListener(type: string, listener: (event: Event) => void): void;
        /** Request a single-screen desktop size once the server advertises resize support. */
        requestDesktopSize(
            width: number,
            height: number,
        ): Promise<'applied' | 'rejected' | 'unavailable'>;
        sendCredentials(credentials: { password: string }): void;
    }
}
