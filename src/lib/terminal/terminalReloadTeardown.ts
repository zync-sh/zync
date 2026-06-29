import type { Channel } from '@tauri-apps/api/core';
import { terminalCache } from './terminalCache.js';

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined'
    && Boolean((window as Window & { __TAURI_INTERNALS__?: { unregisterCallback?: (id: number) => void } }).__TAURI_INTERNALS__?.unregisterCallback);
}

/** Stops delivering PTY output to xterm while keeping the callback registered for Rust channel `end`. */
export function silenceTerminalOutputChannel(channel: Channel | undefined): void {
  if (!channel) {
    return;
  }
  channel.onmessage = () => {};
}

/** Force-unregister a channel callback (HMR / page unload only — not normal tab close). */
export function revokeTerminalOutputChannel(channel: Channel | undefined): void {
  if (!channel || !isTauriRuntime()) {
    return;
  }

  silenceTerminalOutputChannel(channel);
  const internals = (window as Window & { __TAURI_INTERNALS__?: { unregisterCallback?: (id: number) => void } }).__TAURI_INTERNALS__;
  internals?.unregisterCallback?.(channel.id);
}

/** @deprecated Prefer silenceTerminalOutputChannel for tab close; revoke only on webview reload. */
export function disposeTerminalOutputChannel(channel: Channel | undefined): void {
  silenceTerminalOutputChannel(channel);
}

/**
 * Kills live backend PTYs and unregisters output channels before a Vite HMR reload
 * or webview navigation. Prevents "Couldn't find callback id" console noise.
 */
export function teardownTerminalsBeforeWebviewReload(): void {
  if (typeof window === 'undefined' || !window.ipcRenderer) {
    return;
  }

  for (const [termId, cached] of terminalCache.entries()) {
    if (cached.spawned) {
      window.ipcRenderer.send('terminal:kill', { termId });
      cached.spawned = false;
      cached.starting = false;
    }
    revokeTerminalOutputChannel(cached.outputChannel);
    cached.outputChannel = undefined;
  }
}

/** Wire dev HMR and page-unload teardown once at app startup. */
export function registerTerminalReloadTeardown(): void {
  if (typeof window === 'undefined') {
    return;
  }

  const teardown = () => teardownTerminalsBeforeWebviewReload();
  window.addEventListener('beforeunload', teardown);

  const hot = (import.meta as ImportMeta & { hot?: { dispose: (cb: () => void) => void } }).hot;
  hot?.dispose(teardown);
}