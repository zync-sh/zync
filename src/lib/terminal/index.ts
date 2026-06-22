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
  ensureCanvasRendererForSession,
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
  activateCanvasRenderer,
  disposeTerminalRenderer,
  ensureCanvasRenderer,
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
} from './rendererSetup.js';

export { destroyTerminalInstance, getTerminalRecentLines } from './instanceApi.js';

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

export type {
  TerminalLifecycleEvent,
  TerminalOutputEvent,
} from './terminalLifecycleListeners.js';
export { attachTerminalLifecycleListeners } from './terminalLifecycleListeners.js';
export {
  decodeTerminalOutputData,
  type LegacyTerminalOutputData,
  type TerminalOutputData,
} from './terminalOutputPayload.js';