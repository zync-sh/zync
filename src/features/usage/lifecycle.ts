import { getCurrentWindow } from '@tauri-apps/api/window';
import { isUsageEnabled } from './enabled.js';
import { flushUsage, FLUSH_INTERVAL_MS } from './flush.js';
import { clearUsageSession, ensureUsageSession } from './session.js';

let started = false;
let intervalId: number | null = null;
let unlistenClose: (() => void) | null = null;
let closeGeneration = 0;
let onHidden: (() => void) | null = null;
let onPageHide: (() => void) | null = null;

export function startUsageLifecycle(): void {
  if (started) return;
  started = true;
  ensureUsageSession();
  void flushUsage(true);

  intervalId = window.setInterval(() => {
    if (!isUsageEnabled()) return;
    void flushUsage();
  }, FLUSH_INTERVAL_MS);

  onHidden = () => {
    if (document.visibilityState === 'hidden') void flushUsage(true);
  };
  onPageHide = () => {
    void flushUsage(true);
  };
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', onPageHide);

  const generation = ++closeGeneration;
  void getCurrentWindow().onCloseRequested(async (event) => {
    event.preventDefault();
    try {
      await Promise.race([flushUsage(true), new Promise((resolve) => setTimeout(resolve, 2000))]);
    } finally {
      await getCurrentWindow().destroy();
    }
  }).then((unlisten) => {
    if (generation !== closeGeneration) {
      unlisten();
      return;
    }
    unlistenClose = unlisten;
  }).catch(() => {
    // browser / tests
  });
}

export function stopUsageLifecycle(): void {
  closeGeneration += 1;
  if (intervalId != null) {
    window.clearInterval(intervalId);
    intervalId = null;
  }
  if (onHidden) {
    document.removeEventListener('visibilitychange', onHidden);
    onHidden = null;
  }
  if (onPageHide) {
    window.removeEventListener('pagehide', onPageHide);
    onPageHide = null;
  }
  unlistenClose?.();
  unlistenClose = null;
  clearUsageSession();
  started = false;
}
