export interface LazyPtyVisibility {
  isWorkspaceActive: boolean;
  isTerminalView: boolean;
  isActiveTab: boolean;
}

export type LazyPtyAction = 'none' | 'suspend_panel' | 'spawn';

/**
 * Lazy PTY policy: defer spawn until a shell tab is first selected; keep PTYs alive
 * when switching hosts, internal shell tabs, or Files/Dashboard overlays.
 *
 * Do not suspend on Files/Dashboard — killing the active PTY and respawning on return
 * blanked the renderer for that shell while scrollback stayed in memory.
 *
 * Background workspace hosts intentionally stay alive (no idle-timer suspend).
 */
export function resolveLazyPtyAction(
  visibility: LazyPtyVisibility,
  spawned: boolean,
): LazyPtyAction {
  if (!visibility.isWorkspaceActive) {
    return 'none';
  }

  if (!visibility.isTerminalView) {
    return 'none';
  }

  if (!visibility.isActiveTab) {
    return 'none';
  }

  return spawned ? 'none' : 'spawn';
}