import type { Terminal as XTerm } from '@xterm/xterm';
import { spawnTerminalSession } from './ptyLifecycle.js';
import { resolveTerminalSpawnParams, type TerminalSpawnTabState } from './spawnContext.js';

export interface SpawnTerminalFromStoreOptions {
  sessionId: string;
  connectionId: string;
  terminalKey: string;
  term: XTerm;
  clearBuffer: boolean;
  terminals: Record<string, TerminalSpawnTabState[] | undefined>;
  windowsShell?: string;
  /** When false, SSH spawns wait until the host connection is live. */
  remoteReady?: boolean;
}

/** Resolves CWD/shell from store tab state and starts a backend PTY. */
export function spawnTerminalFromStoreContext(options: SpawnTerminalFromStoreOptions): boolean {
  const {
    sessionId,
    connectionId,
    terminalKey,
    term,
    clearBuffer,
    terminals,
    windowsShell,
    remoteReady = true,
  } = options;
  const { cwd, shell } = resolveTerminalSpawnParams(
    terminalKey,
    sessionId,
    terminals,
    windowsShell,
  );
  return spawnTerminalSession({
    termId: sessionId,
    connectionId,
    term,
    clearBuffer,
    cwd,
    shell,
    remoteReady,
  });
}