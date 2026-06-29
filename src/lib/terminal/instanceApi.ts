import { clearTerminalRendererSession } from './rendererSession.js';
import { disposeTerminalLigatures } from './ligatures.js';
import { clearTerminalPendingInput, terminalCache } from './terminalCache.js';
import { clearTerminalInputQueue } from './inputQueue.js';
import { silenceTerminalOutputChannel } from './terminalReloadTeardown.js';
export function getTerminalRecentLines(termId: string, lineCount = 20): string | null {
  if (!termId) {
    return null;
  }

  const cached = terminalCache.get(termId);
  if (!cached?.term?.buffer?.active) return null;
  const buf = cached.term.buffer.active;
  const lines: string[] = [];
  const start = Math.max(0, buf.length - lineCount);
  for (let i = start; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join('\n').trim() || null;
}

/** Cleanup hook for terminalSlice when a tab is explicitly closed. */
export function destroyTerminalInstance(termId: string): void {
  if (!termId) {
    return;
  }

  const cached = terminalCache.get(termId);
  if (!cached) return;

  clearTerminalPendingInput(termId);
  clearTerminalInputQueue(termId);
  cached.ghostTracker?.destroy();
  disposeTerminalLigatures(cached);
  cached.ligaturesEnabled = false;
  clearTerminalRendererSession(termId, cached.term);

  if (cached.unlisten && cached.unlisten.length > 0) {
    cached.unlisten.forEach((fn) => fn());
    cached.unlisten = [];
  }

  silenceTerminalOutputChannel(cached.outputChannel);
  cached.outputChannel = undefined;

  try {
    cached.term.dispose();
  } catch {
    // WebGL addon dispose can throw when xterm core is already torn down.
  }
  terminalCache.delete(termId);
}