export type {
  TerminalRendererKind,
  TerminalRendererState,
} from './types.js';
export { createInitialRendererState } from './types.js';

export type {
  TerminalRendererPolicyContext,
  TerminalRendererPreferences,
} from './rendererPolicy.js';
export {
  resolveDesiredTerminalRenderer,
  rendererKindLabel,
} from './rendererPolicy.js';

export {
  isWebgl2Available,
  resetWebgl2AvailabilityCache,
} from './webglCapability.js';

export {
  clearTerminalRendererSession,
  ensureDomRendererForSession,
  getTerminalRendererState,
  hasTerminalRendererSession,
} from './rendererSession.js';

export type { SyncTerminalRendererOptions } from './rendererController.js';
export { reactivateTerminalWebgl, syncTerminalRenderer } from './rendererController.js';

export type {
  TerminalRendererDiagnostics,
  TerminalRendererDiagnosticsContext,
  TerminalRendererHealth,
} from './rendererDiagnostics.js';
export {
  describeTerminalRendererState,
  getTerminalRendererDiagnostics,
} from './rendererDiagnostics.js';
export {
  activateDomRenderer,
  disposeTerminalRenderer,
  ensureDomRenderer,
  refreshTerminalScreen,
} from './rendererLifecycle.js';

export type { TerminalCache } from './terminalCache.js';
export { clearTerminalPendingInput, terminalCache } from './terminalCache.js';

export { setTerminalLigatures, disposeTerminalLigatures } from './ligatures.js';

export type {
  TerminalRendererSetupSettings,
  TerminalResizeSync,
} from './rendererSetup.js';
export {
  applyTerminalRendererAndLigatures,
  buildEffectiveRendererSettings,
  buildRendererRefitCallback,
  getTerminalRendererPreferences,
  needsTerminalRendererSetup,
} from './rendererSetup.js';

export { destroyTerminalInstance, getTerminalRecentLines } from './instanceApi.js';
export { terminalService } from './terminalService.js';
export {
  buildXtermOptions,
  shouldUseWindowsLocalPtyOptions,
  TERMINAL_SCROLLBACK_ROWS,
} from './xtermOptions.js';
export type { BuildXtermOptionsParams, TerminalXtermSettings } from './xtermOptions.js';

export {
  cancelAllIdlePtySuspends,
  cancelIdlePtySuspend,
  DEFAULT_IDLE_HOST_PTY_SUSPEND_MINUTES,
  DEFAULT_IDLE_PTY_SUSPEND_MS,
  DEFAULT_SUSPEND_IDLE_HOST_PTYS,
  normalizeIdleHostPtySuspendMinutes,
  partitionBackgroundHostTabs,
  shouldIdleSuspendConnection,
  resolveIdleHostPtySuspendDelayMs,
  scheduleIdlePtySuspend,
} from './terminalIdlePty.js';
export { isTerminalSessionProcessBusy } from './terminalProcessActivity.js';
export { suspendAllTerminalsForConnection } from './suspendAllTerminals.js';

export {
  canSendTerminalInput,
  flushPendingInput,
  handleTerminalReady,
  queueTerminalInput,
} from './inputPipeline.js';

export {
  clearTerminalInputQueue,
  enqueueTerminalInputTask,
} from './inputQueue.js';

export type { SpawnTerminalSessionOptions, SuspendTerminalPtyOptions } from './ptyLifecycle.js';
export {
  isTerminalIdleSuspended,
  resetTerminalPtyForReconnect,
  spawnTerminalSession,
  suspendTerminalPty,
} from './ptyLifecycle.js';

export {
  isTerminalDomMeasurable,
  isTerminalFitReady,
  safeFitTerminal,
  createResizeScheduler,
} from './terminalFit.js';
export { restoreTerminalDisplay } from './terminalPanelRestore.js';
export type { ResizeScheduler, ResizeScheduleOptions } from './terminalFit.js';

export type { TerminalSpawnTabState } from './spawnContext.js';
export { resolveTerminalSpawnParams } from './spawnContext.js';

export { syncTerminalResize } from './terminalResizeSync.js';

export type { SpawnTerminalFromStoreOptions } from './terminalSpawn.js';
export { spawnTerminalFromStoreContext } from './terminalSpawn.js';

export type { LazyPtyVisibility, LazyPtyAction } from './terminalLazyPty.js';
export { resolveLazyPtyAction } from './terminalLazyPty.js';

export {
  TERMINAL_CONNECTION_WAKEUP_EVENT,
  dispatchTerminalConnectionWakeup,
} from './terminalConnectionWakeup.js';
export type { ConnectionWakeupContext } from './terminalConnectionWakeup.js';
export { tryWakeTerminalOnReconnect } from './terminalConnectionWakeup.js';

export { LOCAL_TERMINAL_CONNECTION_ID } from './connectionIds.js';
export type { TerminalLifecycleEvent } from './terminalLifecycleListeners.js';
export { attachTerminalLifecycleListeners } from './terminalLifecycleListeners.js';

export { writeIdleHostSuspendNotice } from './terminalIdleSuspendNotice.js';
export {
  decodeTerminalOutputData,
  type LegacyTerminalOutputData,
  type TerminalOutputData,
} from './terminalOutputPayload.js';
export {
  attachTerminalOutputChannel,
  decodeTerminalOutputChannelFrame,
  type TerminalOutputChannelFrame,
} from './terminalOutputStream.js';
export {
  disposeTerminalOutputChannel,
  registerTerminalReloadTeardown,
  revokeTerminalOutputChannel,
  silenceTerminalOutputChannel,
  teardownTerminalsBeforeWebviewReload,
} from './terminalReloadTeardown.js';