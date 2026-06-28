import { terminalCache } from './terminalCache.js';

export const IDLE_HOST_SUSPEND_MESSAGE =
  '\r\n\x1b[33m[Shell suspended while host was idle. Press Enter to resume.]\x1b[0m\r\n';

/** Writes the idle-suspend banner once per suspend cycle (kill does not emit terminal-exit). */
export function writeIdleHostSuspendNotice(termId: string): void {
  const cached = terminalCache.get(termId);
  if (!cached || cached.idleSuspendNoticeShown) {
    return;
  }

  cached.term.write(IDLE_HOST_SUSPEND_MESSAGE);
  cached.idleSuspendNoticeShown = true;
}

export function clearIdleHostSuspendNotice(termId: string): void {
  const cached = terminalCache.get(termId);
  if (!cached) {
    return;
  }
  cached.idleSuspendNoticeShown = false;
}